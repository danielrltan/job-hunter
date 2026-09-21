import { handleCommand } from "./commands";
import { HEARTBEAT_DAYS, MAX_NOTIFY_PER_TICK, SOURCES } from "./config";
import { dedupeKey, filterJobs } from "./filter";
import { diffSince } from "./github";
import { loadActivity, recordTick, saveActivity, saveFeedback } from "./journal";
import { handleMcp, mcpToken } from "./mcp";
import { parseAdded } from "./parsers";
import { loadSettings } from "./settings";
import { loadMeta, loadSeen, loadShas, saveMeta, saveSeen, saveShas } from "./state";
import {
  answerCallback,
  editKeyboard,
  markChoice,
  notify,
  parseFeedbackData,
  sendMessage,
  type Keyboard,
} from "./telegram";
import type { Job, RejectedJob } from "./types";

interface TickReport {
  changed: string[];
  bootstrapped: string[];
  parsed: number;
  matched: number;
  duplicates: number;
  notified: number;
  capped: number;
  truncated: string[];
  errors: string[];
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}

const REQUIRED_SECRETS = ["GITHUB_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"] as const;

/**
 * A secret that was never given a value arrives as an empty string, not
 * undefined — `wrangler secret put` in a non-interactive shell will happily
 * upload nothing and report success.
 *
 * That failure mode is invisible without this check: an empty GITHUB_TOKEN
 * merely downgrades to unauthenticated requests, which work fine for a handful
 * of calls and then die at GitHub's 60/hour anonymous limit; an empty bot token
 * produces a bare 404 from Telegram. Fail loudly and name the culprit instead.
 */
function missingSecrets(env: Env): string[] {
  return REQUIRED_SECRETS.filter((name) => !env[name]);
}

/**
 * One polling pass over every source.
 *
 * Nothing is persisted until notifications have actually gone out, so a
 * Telegram outage means the next tick re-diffs the same commits and retries
 * rather than dropping listings on the floor.
 */
export async function runOnce(env: Env): Promise<TickReport> {
  const report: TickReport = {
    changed: [],
    bootstrapped: [],
    parsed: 0,
    matched: 0,
    duplicates: 0,
    notified: 0,
    capped: 0,
    truncated: [],
    errors: [],
  };

  const missing = missingSecrets(env);
  if (missing.length) {
    throw new Error(
      `missing secrets: ${missing.join(", ")} — set each with \`npx wrangler secret put <NAME>\` ` +
        `in an interactive terminal, and confirm you see the masked value prompt`,
    );
  }

  const settings = await loadSettings(env.STATE);
  if (settings.paused) {
    // Deliberately leave commit state untouched, so /resume replays the gap
    // rather than skipping over everything posted while paused.
    log("paused");
    return report;
  }

  const now = Math.floor(Date.now() / 1000);
  const shas = await loadShas(env.STATE);
  const nextShas: Record<string, string> = { ...shas };
  const candidates: Job[] = [];
  const rejected: RejectedJob[] = [];
  let sent: Job[] = [];

  for (const src of SOURCES) {
    try {
      const diff = await diffSince(src, shas[src.id], env.GITHUB_TOKEN);

      if (diff.headSha !== shas[src.id]) {
        nextShas[src.id] = diff.headSha;
        if (!diff.bootstrapped) report.changed.push(src.id);
      }
      if (diff.bootstrapped) {
        report.bootstrapped.push(src.id);
        continue;
      }
      for (const path of diff.truncatedPaths) {
        report.truncated.push(`${src.id}:${path}`);
      }

      for (const [, hunks] of diff.hunksByPath) {
        const jobs = parseAdded(src, hunks);
        report.parsed += jobs.length;
        const result = filterJobs(jobs, src, settings);
        candidates.push(...result.matched);
        rejected.push(...result.rejected);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report.errors.push(`${src.id}: ${message}`);
      log("source_error", { source: src.id, message });
    }
  }

  report.matched = candidates.length;

  if (candidates.length) {
    const seen = await loadSeen(env.STATE);
    const fresh: Job[] = [];

    // Also collapses the same posting arriving from two repos in one tick.
    for (const job of candidates) {
      const key = dedupeKey(job);
      if (seen[key]) {
        report.duplicates++;
        continue;
      }
      seen[key] = now;
      fresh.push(job);
    }

    if (fresh.length) {
      const announce = fresh.slice(0, MAX_NOTIFY_PER_TICK);
      report.capped = fresh.length - announce.length;

      await notify(announce, env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID);
      if (report.capped > 0) {
        await sendMessage(
          `…and ${report.capped} more matched this tick but were withheld by the per-tick cap.`,
          env.TELEGRAM_BOT_TOKEN,
          env.TELEGRAM_CHAT_ID,
        );
      }
      report.notified = announce.length;
      sent = announce;
      await saveSeen(env.STATE, seen);
    }
  }

  // Kept for the MCP tuning tools. Only ticks that parsed listings write it, so
  // it costs nothing on the idle ticks that make up most of the day.
  if (report.parsed) {
    await saveActivity(env.STATE, recordTick(await loadActivity(env.STATE), sent, rejected, now));
  }

  // Idle ticks leave every sha where it was; skipping the write keeps the
  // cron's baseline well under the 1,000 writes/day free-tier limit.
  if (SOURCES.some((s) => nextShas[s.id] !== shas[s.id])) {
    await saveShas(env.STATE, nextShas);
  }
  await runHeartbeat(env, now, report);

  if (
    report.changed.length ||
    report.notified ||
    report.errors.length ||
    report.bootstrapped.length
  ) {
    log("tick", { ...report });
  }
  return report;
}

/**
 * Send a liveness message when the feed has been quiet for too long.
 *
 * Without this, a broken parser and a genuinely quiet week look exactly the
 * same from the outside. A heartbeat that stops arriving is a signal; silence
 * on its own is not.
 */
async function runHeartbeat(env: Env, now: number, report: TickReport): Promise<void> {
  const meta = await loadMeta(env.STATE);
  let dirty = false;

  if (report.notified) {
    meta.lastNotifyTs = now;
    dirty = true;
  }

  const lastSignal = Math.max(meta.lastNotifyTs ?? 0, meta.lastHeartbeatTs ?? 0);

  if (!lastSignal) {
    // First tick after deploy — start the clock rather than firing immediately.
    meta.lastHeartbeatTs = now;
    dirty = true;
  } else if (now - lastSignal >= HEARTBEAT_DAYS * 86400) {
    const days = Math.floor((now - lastSignal) / 86400);
    await sendMessage(
      `💤 <b>job-hunter checkup</b>\n\nStill running — no matching internships in ${days} days. ` +
        `All ${SOURCES.length} sources are being polled normally.\n\n` +
        `<i>If this keeps arriving during peak season, a source's format may have changed ` +
        `and its parser may need attention.</i>`,
      env.TELEGRAM_BOT_TOKEN,
      env.TELEGRAM_CHAT_ID,
    );
    meta.lastHeartbeatTs = now;
    dirty = true;
    log("heartbeat", { quietDays: days });
  }

  if (dirty) await saveMeta(env.STATE, meta);
}

/* ------------------------------------------------------------------ */
/* HTTP surface — health check plus a few key-protected admin routes    */
/* ------------------------------------------------------------------ */

function safeEqual(provided: string, expected: string): boolean {
  if (!expected) return false;
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(expected);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

function authorized(request: Request, env: Env): boolean {
  return safeEqual(new URL(request.url).searchParams.get("key") ?? "", env.ADMIN_KEY ?? "");
}

/**
 * Shared secret Telegram echoes back on every webhook call, derived from
 * ADMIN_KEY so there's no extra secret to set. Telegram restricts this token
 * to A-Z a-z 0-9 _ -, which a hex digest satisfies and an arbitrary
 * user-chosen ADMIN_KEY might not.
 */
async function webhookSecret(env: Env): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.ADMIN_KEY));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface TelegramUpdate {
  message?: { text?: string; chat?: { id?: number | string } };
  callback_query?: {
    id: string;
    data?: string;
    message?: {
      message_id: number;
      chat?: { id?: number | string };
      reply_markup?: { inline_keyboard?: Keyboard };
    };
  };
}

/**
 * Telegram webhook. Two independent checks: the secret header proves the
 * request came from Telegram, and the chat id proves it came from the owner —
 * without the second, anyone who finds the bot could rewrite the filters.
 */
async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const provided = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!safeEqual(provided, await webhookSecret(env))) {
    return json({ error: "unauthorized" }, 401);
  }

  const update = (await request.json()) as TelegramUpdate;
  if (update.callback_query) {
    await handleFeedbackTap(update.callback_query, env);
    return json({ ok: true });
  }

  const text = update.message?.text ?? "";
  const chatId = String(update.message?.chat?.id ?? "");

  // Always 200 to strangers: Telegram retries non-2xx, and replying would
  // confirm the bot is live to whoever is probing it.
  if (chatId !== env.TELEGRAM_CHAT_ID) {
    log("webhook_foreign_chat", { chatId });
    return json({ ok: true });
  }

  const reply = await handleCommand(text, env);
  if (reply) await sendMessage(reply, env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID);
  return json({ ok: true });
}

/**
 * A 👍/👎 tap on a listing. Stored as feedback for the MCP tuning tools, then
 * the tapped button gets a check mark so it's clear the tap registered.
 */
async function handleFeedbackTap(
  query: NonNullable<TelegramUpdate["callback_query"]>,
  env: Env,
): Promise<void> {
  const chatId = String(query.message?.chat?.id ?? "");
  const parsed = parseFeedbackData(query.data ?? "");

  if (chatId !== env.TELEGRAM_CHAT_ID || !parsed) {
    await answerCallback(env.TELEGRAM_BOT_TOKEN, query.id);
    return;
  }

  const activity = await loadActivity(env.STATE);
  const job = activity.sent.find((j) => j.id === parsed.id);
  await saveFeedback(env.STATE, parsed.id, {
    verdict: parsed.verdict,
    ts: Math.floor(Date.now() / 1000),
    by: "telegram",
    ...(job
      ? { job: { company: job.company, title: job.title, url: job.url, sourceId: job.sourceId } }
      : {}),
  });

  const label = job ? ` — ${job.company}` : "";
  await answerCallback(
    env.TELEGRAM_BOT_TOKEN,
    query.id,
    `${parsed.verdict === "up" ? "👍" : "👎"} Noted${label}`,
  );

  const keyboard = query.message?.reply_markup?.inline_keyboard;
  if (keyboard && query.message) {
    await editKeyboard(
      env.TELEGRAM_BOT_TOKEN,
      env.TELEGRAM_CHAT_ID,
      query.message.message_id,
      markChoice(keyboard, query.data!),
    );
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    await runOnce(env);
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;

    if (path === "/" || path === "/health") {
      // `ready` reports only whether each secret is non-empty, never its value,
      // so misconfiguration is diagnosable without exposing anything.
      return json({
        ok: true,
        ready: missingSecrets(env).length === 0,
        sources: SOURCES.map((s) => s.id),
      });
    }

    if (path === "/telegram" && request.method === "POST") {
      return await handleWebhook(request, env);
    }

    if (path === "/mcp") {
      return await handleMcp(request, env, safeEqual);
    }

    if (!authorized(request, env)) {
      return json({ error: "unauthorized" }, 401);
    }

    try {
      switch (path) {
        case "/run":
          return json(await runOnce(env));

        case "/state": {
          const [shas, seen] = await Promise.all([loadShas(env.STATE), loadSeen(env.STATE)]);
          return json({
            shas,
            seenCount: Object.keys(seen).length,
            secretsConfigured: Object.fromEntries(
              REQUIRED_SECRETS.map((name) => [name, Boolean(env[name])]),
            ),
          });
        }

        case "/test":
          await sendMessage(
            "✅ job-hunter is wired up correctly.",
            env.TELEGRAM_BOT_TOKEN,
            env.TELEGRAM_CHAT_ID,
          );
          return json({ ok: true });

        case "/setup-webhook": {
          const webhookUrl = `${new URL(request.url).origin}/telegram`;
          const api = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;

          const hook = await fetch(`${api}/setWebhook`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url: webhookUrl,
              secret_token: await webhookSecret(env),
              // callback_query carries the 👍/👎 taps on listings.
              allowed_updates: ["message", "callback_query"],
            }),
          });

          // Populates the "/" menu in the Telegram client.
          const menu = await fetch(`${api}/setMyCommands`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              commands: [
                { command: "status", description: "What's being watched" },
                { command: "filters", description: "Filters currently in force" },
                { command: "include", description: "Also alert on this phrase" },
                { command: "exclude", description: "Never alert on this phrase" },
                { command: "unset", description: "Undo an include or exclude" },
                { command: "term", description: "Set which terms to accept" },
                { command: "pause", description: "Stop notifications" },
                { command: "resume", description: "Start notifications again" },
                { command: "reset", description: "Back to defaults" },
                { command: "help", description: "Show all commands" },
              ],
            }),
          });

          return json({
            webhook: webhookUrl,
            setWebhook: await hook.json(),
            setMyCommands: await menu.json(),
          });
        }

        case "/mcp-token":
          // What to paste into Muse's custom connector setup.
          return json({
            url: `${new URL(request.url).origin}/mcp`,
            header: `Authorization: Bearer ${await mcpToken(env)}`,
          });

        case "/reset-seen":
          await saveSeen(env.STATE, {});
          return json({ ok: true, cleared: true });

        default:
          return json({ error: "not found" }, 404);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("request_error", { path, message });
      return json({ error: message }, 500);
    }
  },
};
