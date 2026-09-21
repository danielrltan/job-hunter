import {
  HEARTBEAT_DAYS,
  ROLE_HARD_EXCLUDE,
  ROLE_INCLUDE,
  ROLE_SOFT_EXCLUDE,
  SOURCES,
  TARGET_TERMS,
} from "./config";
import { evaluate } from "./filter";
import {
  loadActivity,
  loadChanges,
  loadFeedback,
  logChange,
  reasonBucket,
  saveFeedback,
  type Feedback,
  type LoggedJob,
} from "./journal";
import {
  addPhrase,
  buildSettings,
  formatTerms,
  loadOverrides,
  MAX_PHRASES,
  removePhrase,
  saveOverrides,
  setTerms,
  type Edit,
  type Overrides,
} from "./settings";
import { loadMeta, loadSeen, loadShas } from "./state";
import { sendMessage } from "./telegram";

/**
 * A Model Context Protocol server, so an agent (Meta's Muse) can read what the
 * Worker has been alerting on and dropping, and tune the filters from that.
 *
 * Streamable HTTP, stateless: every request is a single POST of JSON-RPC and
 * every response is plain JSON. The spec allows a server to answer with JSON
 * instead of an SSE stream when it has nothing to stream, and nothing here
 * does. Hand-rolled because the Worker has no runtime dependencies and the
 * protocol surface needed is three methods.
 *
 * Every write lands in the change log and is announced in Telegram. An agent
 * that quietly over-excludes would silence alerts in a way that looks exactly
 * like a slow hiring week, so its edits must never be invisible.
 */

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `job-hunter watches GitHub internship repos and sends matching listings to its owner's Telegram.
The owner is a student based in Canada who needs US sponsorship, looking for SWE / AI / ML / data / product internships.

Tuning loop:
1. Read list_feedback (👍/👎 taps from Telegram) and get_change_log (the owner's own hand edits are the strongest signal — don't undo them).
2. Read recent_jobs for false positives and recent_rejections for false negatives (good roles dropped by the rules).
3. Before any edit, run preview_filters with the proposed change and check what it would newly match or drop.
4. Make small, specific edits with a reason. Every edit is announced to the owner in Telegram.
Phrases are literal, case-insensitive substrings of the job title — not regexes.`;

interface Ctx {
  env: Env;
}

type Json = Record<string, unknown>;

interface Tool {
  name: string;
  description: string;
  inputSchema: Json;
  annotations?: Json;
  run: (args: Json, ctx: Ctx) => Promise<unknown>;
}

const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const str = (description: string) => ({ type: "string", description });
const int = (description: string, max: number) => ({ type: "integer", minimum: 1, maximum: max, description });
const reasonProp = str("Why — shown to the owner in Telegram and kept in the change log.");

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function iso(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

function brief(job: LoggedJob, feedback?: Feedback) {
  return {
    id: job.id,
    at: iso(job.ts),
    company: job.company,
    title: job.title,
    locations: job.locations,
    term: job.term,
    sponsorship: job.sponsorship,
    source: job.sourceId,
    url: job.url,
    ...(job.reason ? { reason: job.reason } : {}),
    ...(feedback ? { feedback: feedback.verdict, feedbackNote: feedback.note } : {}),
  };
}

function requireString(args: Json, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new ToolError(`"${key}" is required`);
  return v.trim();
}

class ToolError extends Error {}

/** Re-run the real filter over the logged jobs with proposed overrides. */
async function simulate(env: Env, proposed: Overrides) {
  const [activity, feedback, current] = await Promise.all([
    loadActivity(env.STATE),
    loadFeedback(env.STATE),
    loadOverrides(env.STATE),
  ]);
  const before = buildSettings(current);
  const after = buildSettings(proposed);

  const newlyMatched = [];
  const newlyDropped = [];
  let kept = 0;

  for (const job of [...activity.sent, ...activity.rejected]) {
    const src = SOURCES.find((s) => s.id === job.sourceId);
    if (!src) continue;
    const was = evaluate(job, src, before);
    const will = evaluate(job, src, after);
    if (will.ok) kept++;
    if (!was.ok && will.ok) newlyMatched.push(brief(job, feedback[job.id]));
    if (was.ok && !will.ok) newlyDropped.push({ ...brief(job, feedback[job.id]), reason: will.reason });
  }

  return {
    evaluatedJobs: activity.sent.length + activity.rejected.length,
    wouldMatch: kept,
    newlyMatched,
    newlyDropped,
    likedJobsLost: newlyDropped.filter((j) => j.feedback === "up").length,
  };
}

async function commit(
  ctx: Ctx,
  edit: Edit,
  action: string,
  detail: string,
  reason: string,
  announce: string,
) {
  if (!edit.ok) throw new ToolError(edit.error);
  if (!edit.changed) return { ok: true, changed: false, note: "already in that state — nothing to do" };

  // Saved before announcing: an announcement for an edit that then failed to
  // persist would be worse than the reverse.
  await saveOverrides(ctx.env.STATE, edit.next);
  await logChange(ctx.env.STATE, { ts: now(), by: "muse", action, detail, reason });
  try {
    await sendMessage(
      `🤖 <b>Muse</b> ${announce}\n<i>${escapeHtml(reason)}</i>`,
      ctx.env.TELEGRAM_BOT_TOKEN,
      ctx.env.TELEGRAM_CHAT_ID,
    );
  } catch (err) {
    // The edit is in force, so a failed notice must not read as a failed edit —
    // a retry would find "nothing to do" and the owner would never hear of it.
    return {
      ok: true,
      changed: true,
      overrides: edit.next,
      announced: false,
      warning:
        `Applied, but the Telegram notice failed (${err instanceof Error ? err.message : String(err)}). ` +
        `Tell the owner about this change directly.`,
    };
  }
  return { ok: true, changed: true, overrides: edit.next, announced: true };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const TOOLS: Tool[] = [
  {
    name: "get_status",
    description: "Whether alerts are running or paused, how many sources are tracked, and when the last alert went out.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ,
    async run(_args, { env }) {
      const [overrides, shas, seen, meta, activity] = await Promise.all([
        loadOverrides(env.STATE),
        loadShas(env.STATE),
        loadSeen(env.STATE),
        loadMeta(env.STATE),
        loadActivity(env.STATE),
      ]);
      return {
        paused: overrides.paused ?? false,
        pollEveryMinutes: 2,
        sourcesTracked: SOURCES.filter((s) => shas[s.id]).length,
        sources: SOURCES.map((s) => ({ id: s.id, label: s.label, repo: `${s.owner}/${s.repo}` })),
        jobsRemembered: Object.keys(seen).length,
        lastAlertAt: meta.lastNotifyTs ? iso(meta.lastNotifyTs) : null,
        heartbeatAfterQuietDays: HEARTBEAT_DAYS,
        loggedSent: activity.sent.length,
        loggedRejected: activity.rejected.length,
      };
    },
  },
  {
    name: "get_filters",
    description:
      "The complete filter: the built-in rules (as regex sources), the owner's phrase overrides, and the term setting. Read this before proposing edits.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ,
    async run(_args, { env }) {
      const overrides = await loadOverrides(env.STATE);
      return {
        order: [
          "must be an internship",
          "role: a hard-exclude match drops it; otherwise it must match an include; a soft-exclude only drops it when no include matched",
          "graduate/PhD-only titles are dropped unless they also welcome undergrads",
          "term: listings naming a term outside the targets are dropped; listings naming no term are kept",
          "drops 'no sponsorship', citizenship and clearance requirements",
          "drops clearly non-North-American locations",
        ],
        builtIn: {
          roleInclude: ROLE_INCLUDE.map((r) => r.source),
          roleHardExclude: ROLE_HARD_EXCLUDE.map((r) => r.source),
          roleSoftExclude: ROLE_SOFT_EXCLUDE.map((r) => r.source),
          defaultTerms: formatTerms(TARGET_TERMS),
        },
        overrides: {
          include: overrides.include ?? [],
          exclude: overrides.exclude ?? [],
          terms: formatTerms(overrides.terms ?? TARGET_TERMS),
          paused: overrides.paused ?? false,
        },
        limits: { maxPhrasesPerList: MAX_PHRASES, maxPhraseLength: 60 },
      };
    },
  },
  {
    name: "recent_jobs",
    description: "Listings that were sent to the owner, newest first, with any 👍/👎 they gave.",
    inputSchema: {
      type: "object",
      properties: {
        limit: int("Default 30.", 150),
        since_hours: int("Only jobs sent in the last N hours.", 24 * 120),
        feedback: { type: "string", enum: ["up", "down", "none", "any"], description: "Default any." },
      },
    },
    annotations: READ,
    async run(args, { env }) {
      const [activity, feedback] = await Promise.all([loadActivity(env.STATE), loadFeedback(env.STATE)]);
      const cutoff = typeof args.since_hours === "number" ? now() - args.since_hours * 3600 : 0;
      const want = (args.feedback as string) ?? "any";
      const jobs = activity.sent
        .filter((j) => j.ts >= cutoff)
        .filter((j) => {
          const f = feedback[j.id]?.verdict;
          return want === "any" || (want === "none" ? !f : f === want);
        })
        .slice(0, Number(args.limit ?? 30));
      return { count: jobs.length, jobs: jobs.map((j) => brief(j, feedback[j.id])) };
    },
  },
  {
    name: "recent_rejections",
    description:
      "Listings the filter dropped, newest first, with the reason, plus lifetime counts per reason. Use this to find good roles the rules are wrongly discarding — 'no matching role keyword' and 'non-technical function' are where false negatives usually hide.",
    inputSchema: {
      type: "object",
      properties: {
        limit: int("Default 50.", 200),
        reason_contains: str("Only drops whose reason contains this, e.g. 'role keyword' or 'location'."),
      },
    },
    annotations: READ,
    async run(args, { env }) {
      const activity = await loadActivity(env.STATE);
      const needle = typeof args.reason_contains === "string" ? args.reason_contains.toLowerCase() : "";
      const jobs = activity.rejected
        .filter((j) => !needle || (j.reason ?? "").toLowerCase().includes(needle))
        .slice(0, Number(args.limit ?? 50));
      const sample: Record<string, number> = {};
      for (const j of activity.rejected) {
        const b = reasonBucket(j.reason ?? "");
        sample[b] = (sample[b] ?? 0) + 1;
      }
      return {
        countsByReason: activity.rejectCounts,
        countingSince: activity.since ? iso(activity.since) : null,
        sampleSize: activity.rejected.length,
        sampleCountsByReason: sample,
        jobs: jobs.map((j) => brief(j)),
      };
    },
  },
  {
    name: "list_feedback",
    description: "Every 👍/👎 the owner has given, newest first — from Telegram buttons or recorded by you.",
    inputSchema: { type: "object", properties: { limit: int("Default 100.", 500) } },
    annotations: READ,
    async run(args, { env }) {
      const all = Object.entries(await loadFeedback(env.STATE))
        .sort((a, b) => b[1].ts - a[1].ts)
        .slice(0, Number(args.limit ?? 100));
      return {
        count: all.length,
        feedback: all.map(([id, f]) => ({ id, at: iso(f.ts), ...f, ts: undefined })),
      };
    },
  },
  {
    name: "get_change_log",
    description: "Filter edits, newest first — the owner's own (by 'telegram') and yours (by 'muse').",
    inputSchema: { type: "object", properties: { limit: int("Default 30.", 100) } },
    annotations: READ,
    async run(args, { env }) {
      const changes = (await loadChanges(env.STATE)).slice(0, Number(args.limit ?? 30));
      return { changes: changes.map((c) => ({ ...c, at: iso(c.ts), ts: undefined })) };
    },
  },
  {
    name: "preview_filters",
    description:
      "Dry run. Re-evaluates every logged listing (sent and dropped) under a proposed change and reports what would newly match and newly drop. Changes nothing. Run this before every edit.",
    inputSchema: {
      type: "object",
      properties: {
        add_include: { type: "array", items: { type: "string" } },
        add_exclude: { type: "array", items: { type: "string" } },
        remove: { type: "array", items: { type: "string" }, description: "Phrases to remove from either list." },
        terms: str('e.g. "summer 2027, fall 2027" or "any".'),
      },
    },
    annotations: READ,
    async run(args, { env }) {
      let proposed = await loadOverrides(env.STATE);
      const apply = (edit: Edit) => {
        if (!edit.ok) throw new ToolError(edit.error);
        proposed = edit.next;
      };
      for (const p of (args.add_include as string[]) ?? []) apply(addPhrase(proposed, "include", p));
      for (const p of (args.add_exclude as string[]) ?? []) apply(addPhrase(proposed, "exclude", p));
      for (const p of (args.remove as string[]) ?? []) apply(removePhrase(proposed, p));
      if (typeof args.terms === "string") apply(setTerms(proposed, args.terms));
      return simulate(env, proposed);
    },
  },
  {
    name: "add_include",
    description: "Also alert on titles containing this phrase (literal, case-insensitive). Announced in Telegram.",
    inputSchema: {
      type: "object",
      properties: { phrase: str("Literal phrase."), reason: reasonProp },
      required: ["phrase", "reason"],
    },
    annotations: WRITE,
    async run(args, ctx) {
      const phrase = requireString(args, "phrase");
      const reason = requireString(args, "reason");
      const edit = addPhrase(await loadOverrides(ctx.env.STATE), "include", phrase);
      return commit(ctx, edit, "include", phrase, reason, `now also alerts on <b>${escapeHtml(phrase)}</b>`);
    },
  },
  {
    name: "add_exclude",
    description:
      "Never alert on titles containing this phrase (literal, case-insensitive). Refused if it would drop a listing the owner gave 👍, unless force is true. Announced in Telegram.",
    inputSchema: {
      type: "object",
      properties: {
        phrase: str("Literal phrase."),
        reason: reasonProp,
        force: { type: "boolean", description: "Apply even though it drops liked listings. Only with the owner's say-so." },
      },
      required: ["phrase", "reason"],
    },
    annotations: WRITE,
    async run(args, ctx) {
      const phrase = requireString(args, "phrase");
      const reason = requireString(args, "reason");
      const edit = addPhrase(await loadOverrides(ctx.env.STATE), "exclude", phrase);
      if (edit.ok && edit.changed && args.force !== true) {
        const sim = await simulate(ctx.env, edit.next);
        const liked = sim.newlyDropped.filter((j) => j.feedback === "up");
        if (liked.length) {
          throw new ToolError(
            `refused: this would drop ${liked.length} listing(s) the owner liked — ` +
              liked.map((j) => `${j.company}: ${j.title}`).join("; ") +
              ". Ask the owner, then retry with force: true.",
          );
        }
      }
      return commit(ctx, edit, "exclude", phrase, reason, `now ignores <b>${escapeHtml(phrase)}</b>\nUndo: /unset ${escapeHtml(phrase)}`);
    },
  },
  {
    name: "remove_phrase",
    description: "Remove a phrase from the include or exclude list. Announced in Telegram.",
    inputSchema: {
      type: "object",
      properties: { phrase: str("Phrase to remove."), reason: reasonProp },
      required: ["phrase", "reason"],
    },
    annotations: WRITE,
    async run(args, ctx) {
      const phrase = requireString(args, "phrase");
      const reason = requireString(args, "reason");
      const edit = removePhrase(await loadOverrides(ctx.env.STATE), phrase);
      if (edit.ok && !edit.changed) throw new ToolError(`"${phrase}" isn't in either list — see get_filters`);
      return commit(ctx, edit, "unset", phrase, reason, `removed <b>${escapeHtml(phrase)}</b>`);
    },
  },
  {
    name: "set_terms",
    description: 'Which terms to accept, e.g. "summer 2027" or "summer 2027, fall 2027", or "any". Announced in Telegram.',
    inputSchema: {
      type: "object",
      properties: { terms: str("Season and year list, or 'any'."), reason: reasonProp },
      required: ["terms", "reason"],
    },
    annotations: WRITE,
    async run(args, ctx) {
      const terms = requireString(args, "terms");
      const reason = requireString(args, "reason");
      const edit = setTerms(await loadOverrides(ctx.env.STATE), terms);
      const label = edit.ok ? formatTerms(edit.next.terms!) : terms;
      return commit(ctx, edit, "term", label, reason, `set terms to <b>${escapeHtml(label)}</b>`);
    },
  },
  {
    name: "set_paused",
    description: "Pause or resume alerts. Postings made while paused are delivered on resume. Announced in Telegram.",
    inputSchema: {
      type: "object",
      properties: { paused: { type: "boolean" }, reason: reasonProp },
      required: ["paused", "reason"],
    },
    annotations: WRITE,
    async run(args, ctx) {
      if (typeof args.paused !== "boolean") throw new ToolError(`"paused" must be true or false`);
      const reason = requireString(args, "reason");
      const overrides = await loadOverrides(ctx.env.STATE);
      const edit: Edit = {
        ok: true,
        next: { ...overrides, paused: args.paused },
        changed: (overrides.paused ?? false) !== args.paused,
      };
      return commit(ctx, edit, args.paused ? "pause" : "resume", "", reason, args.paused ? "paused alerts" : "resumed alerts");
    },
  },
  {
    name: "record_feedback",
    description:
      "Record the owner's opinion of a listing when they tell you in conversation (e.g. 'I applied to that one', 'not interested in quant'). Use a job id from recent_jobs or recent_rejections.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: str("8-character id."),
        verdict: { type: "string", enum: ["up", "down"] },
        note: str("What the owner said, briefly."),
      },
      required: ["job_id", "verdict"],
    },
    annotations: WRITE,
    async run(args, { env }) {
      const id = requireString(args, "job_id");
      const verdict = args.verdict;
      if (verdict !== "up" && verdict !== "down") throw new ToolError(`"verdict" must be "up" or "down"`);
      const activity = await loadActivity(env.STATE);
      const job = [...activity.sent, ...activity.rejected].find((j) => j.id === id);
      if (!job) throw new ToolError(`no logged job with id ${id}`);
      await saveFeedback(env.STATE, id, {
        verdict,
        ts: now(),
        by: "muse",
        ...(typeof args.note === "string" ? { note: args.note.slice(0, 200) } : {}),
        job: { company: job.company, title: job.title, url: job.url, sourceId: job.sourceId },
      });
      return { ok: true };
    },
  },
];

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Json;
}

const rpcResult = (id: RpcRequest["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: RpcRequest["id"], code: number, message: string) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

async function dispatch(msg: RpcRequest, ctx: Ctx): Promise<unknown | null> {
  // Notifications (no id) get no response.
  if (msg.id === undefined) return null;

  switch (msg.method) {
    case "initialize": {
      const requested = String(msg.params?.protocolVersion ?? "");
      return rpcResult(msg.id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "job-hunter", version: "1.1.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, {
        tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({
          name,
          description,
          inputSchema,
          annotations,
        })),
      });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return rpcError(msg.id, -32602, `unknown tool: ${name}`);
      try {
        const result = await tool.run((msg.params?.arguments as Json) ?? {}, ctx);
        return rpcResult(msg.id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        });
      } catch (err) {
        // Tool failures go back as results, not protocol errors, so the model
        // sees the message and can correct itself.
        const message = err instanceof Error ? err.message : String(err);
        return rpcResult(msg.id, { content: [{ type: "text", text: message }], isError: true });
      }
    }
    default:
      return rpcError(msg.id, -32601, `method not found: ${msg.method}`);
  }
}

/** Bearer token for the MCP endpoint, derived from ADMIN_KEY so there's no extra secret to set. */
export async function mcpToken(env: Env): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`job-hunter-mcp:${env.ADMIN_KEY}`),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handleMcp(
  request: Request,
  env: Env,
  safeEqual: (a: string, b: string) => boolean,
): Promise<Response> {
  const header = request.headers.get("Authorization") ?? "";
  const provided = header.replace(/^Bearer\s+/i, "");
  if (!env.ADMIN_KEY || !safeEqual(provided, await mcpToken(env))) {
    return Response.json(rpcError(null, -32001, "unauthorized"), {
      status: 401,
      headers: { "WWW-Authenticate": "Bearer" },
    });
  }

  // Stateless server: no SSE stream to open and no session to delete.
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(rpcError(null, -32700, "parse error"), { status: 400 });
  }

  const ctx = { env };
  const batch = Array.isArray(body);
  const messages = (batch ? body : [body]) as RpcRequest[];
  const responses = (await Promise.all(messages.map((m) => dispatch(m, ctx)))).filter(
    (r) => r !== null,
  );

  if (!responses.length) return new Response(null, { status: 202 });
  return Response.json(batch ? responses : responses[0]);
}
