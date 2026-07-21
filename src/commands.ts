import { HEARTBEAT_DAYS, SOURCES, TARGET_TERMS } from "./config";
import {
  formatTerms,
  loadOverrides,
  parseTerms,
  saveOverrides,
  type Overrides,
} from "./settings";
import { loadSeen, loadShas } from "./state";

const HELP = `<b>job-hunter commands</b>

/status — what's being watched and when it last fired
/filters — the filters currently in force

/include &lt;phrase&gt; — also alert on roles containing this
/exclude &lt;phrase&gt; — never alert on roles containing this
/unset &lt;phrase&gt; — undo an include or exclude you added

/term &lt;summer 2027&gt; — which terms to accept ("any" for all)
/pause — stop notifications
/resume — start them again
/reset — discard every change, back to defaults

/test — send a test message
/help — this message

Phrases are matched literally and case-insensitively against the job title, so <code>/exclude quantum</code> does what it looks like.`;

/** Reply text for a command, or null if the message isn't one. */
export async function handleCommand(text: string, env: Env): Promise<string | null> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  // Telegram appends @botname when commands are used in groups.
  const [rawCommand = "", ...rest] = trimmed.split(/\s+/);
  const command = rawCommand.split("@")[0]!.toLowerCase();
  const argument = rest.join(" ").trim();

  const overrides = await loadOverrides(env.STATE);

  switch (command) {
    case "/start":
    case "/help":
      return HELP;

    case "/status":
      return await status(env, overrides);

    case "/filters":
      return filters(overrides);

    case "/include":
      return await addPhrase(env, overrides, "include", argument);

    case "/exclude":
      return await addPhrase(env, overrides, "exclude", argument);

    case "/unset":
      return await removePhrase(env, overrides, argument);

    case "/term":
      return await setTerms(env, overrides, argument);

    case "/pause":
      await saveOverrides(env.STATE, { ...overrides, paused: true });
      return "⏸ Paused. No notifications until /resume.";

    case "/resume":
      await saveOverrides(env.STATE, { ...overrides, paused: false });
      return "▶️ Resumed. Postings made while paused will come through on the next check.";

    case "/reset":
      await saveOverrides(env.STATE, {});
      return "♻️ All changes discarded — back to the built-in defaults.\n\nUse /filters to confirm.";

    default:
      return `Unknown command <code>${escapeHtml(command)}</code>.\n\n${HELP}`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function status(env: Env, overrides: Overrides): Promise<string> {
  const [shas, seen] = await Promise.all([loadShas(env.STATE), loadSeen(env.STATE)]);
  const tracked = SOURCES.filter((s) => shas[s.id]).length;

  return [
    `<b>Status</b>`,
    ``,
    overrides.paused ? "⏸ <b>Paused</b>" : "✅ Running — checking every 2 minutes",
    `📚 ${tracked}/${SOURCES.length} sources tracked`,
    `🧠 ${Object.keys(seen).length} jobs remembered (won't repeat)`,
    `💤 Heartbeat if quiet for ${HEARTBEAT_DAYS} days`,
    ``,
    `<i>Filters: /filters · Commands: /help</i>`,
  ].join("\n");
}

function filters(overrides: Overrides): string {
  const lines = [`<b>Filters in force</b>`, ``];

  lines.push(`🗓 Terms: <b>${formatTerms(overrides.terms ?? TARGET_TERMS)}</b>`);
  if (!overrides.terms) lines.push(`   <i>(the default)</i>`);

  lines.push(
    ``,
    `Built-in rules always applied:`,
    `• technical roles only (SWE / AI / ML / data / product)`,
    `• internships only, no new-grad or full-time`,
    `• no graduate or PhD-only postings <i>(by title)</i>`,
    `• US, Canada and remote only`,
    `• drops roles requiring citizenship or clearance`,
  );

  if (overrides.include?.length) {
    lines.push(``, `➕ Also alerting on:`, ...overrides.include.map((p) => `• ${escapeHtml(p)}`));
  }
  if (overrides.exclude?.length) {
    lines.push(``, `➖ Never alerting on:`, ...overrides.exclude.map((p) => `• ${escapeHtml(p)}`));
  }
  if (!overrides.include?.length && !overrides.exclude?.length) {
    lines.push(``, `<i>No custom phrases yet — add with /include or /exclude.</i>`);
  }

  return lines.join("\n");
}

async function addPhrase(
  env: Env,
  overrides: Overrides,
  field: "include" | "exclude",
  phrase: string,
): Promise<string> {
  if (!phrase) {
    return `Give me a phrase, e.g. <code>/${field} ${field === "include" ? "robotics" : "quantum"}</code>`;
  }
  if (phrase.length > 60) return "That phrase is too long — keep it under 60 characters.";

  const current = overrides[field] ?? [];
  if (current.some((p) => p.toLowerCase() === phrase.toLowerCase())) {
    return `Already in the ${field} list.`;
  }

  const next = { ...overrides, [field]: [...current, phrase] };
  await saveOverrides(env.STATE, next);

  return field === "include"
    ? `➕ Now also alerting on roles containing <b>${escapeHtml(phrase)}</b>.`
    : `➖ Now ignoring roles containing <b>${escapeHtml(phrase)}</b>.`;
}

async function removePhrase(
  env: Env,
  overrides: Overrides,
  phrase: string,
): Promise<string> {
  if (!phrase) return "Give me the phrase to remove, e.g. <code>/unset robotics</code>";

  const next: Overrides = { ...overrides };
  let removed = false;

  for (const field of ["include", "exclude"] as const) {
    const current = next[field];
    if (!current) continue;
    const filtered = current.filter((p) => p.toLowerCase() !== phrase.toLowerCase());
    if (filtered.length !== current.length) {
      next[field] = filtered;
      removed = true;
    }
  }

  if (!removed) return `Couldn't find <b>${escapeHtml(phrase)}</b>. Check /filters.`;
  await saveOverrides(env.STATE, next);
  return `🗑 Removed <b>${escapeHtml(phrase)}</b>.`;
}

async function setTerms(env: Env, overrides: Overrides, argument: string): Promise<string> {
  if (!argument) {
    return `Which terms? e.g. <code>/term summer 2027</code>, <code>/term summer 2027, winter 2028</code>, or <code>/term any</code>`;
  }

  const parsed = parseTerms(argument);
  if (!parsed) {
    return `Couldn't read "${escapeHtml(argument)}". Use a season and year, like <code>/term summer 2027</code>.`;
  }

  await saveOverrides(env.STATE, { ...overrides, terms: parsed });
  return parsed === "any"
    ? `🗓 Accepting <b>any term</b> now.`
    : `🗓 Only alerting on <b>${formatTerms(parsed)}</b>.\n\n<i>Listings that don't state a term still come through.</i>`;
}
