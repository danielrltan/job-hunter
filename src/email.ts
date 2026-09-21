import { AGENT_EMAIL_FROM, AGENT_EMAIL_MIN_MINUTES, AGENT_EMAIL_SUBJECT } from "./config";
import type { LoggedJob } from "./journal";

/**
 * The nudge that makes the agent proactive.
 *
 * An MCP server can't call an agent — the agent has to call it. Muse can be
 * woken by a new email, though, so when listings enter its queue the Worker
 * emails the owner, and a Muse trigger on that email runs the queue.
 *
 * The body carries counts and company names only, never titles or links.
 * Listing text comes from public scraped repos; an agent that fills in forms on
 * the owner's behalf should meet it as tool data it asked for, not as the email
 * that wakes it up.
 */
/** Jobs queued since the last nudge, or none if one went out too recently. Pure. */
export function jobsToNudge(sent: LoggedJob[], lastEmailTs: number | undefined, now: number): LoggedJob[] {
  const since = lastEmailTs ?? 0;
  if (now - since < AGENT_EMAIL_MIN_MINUTES * 60) return [];
  return sent.filter((j) => j.ts > since);
}

export function buildNudge(jobs: LoggedJob[], to: string, now: Date): string {
  const n = jobs.length;
  const companies = [...new Set(jobs.map((j) => j.company.slice(0, 40)))];
  const shown = companies.slice(0, 8).join(", ") + (companies.length > 8 ? ", …" : "");
  const subject = `${AGENT_EMAIL_SUBJECT} ${n} new internship${n === 1 ? "" : "s"} queued`;
  const body = [
    `${n} new listing${n === 1 ? " is" : "s are"} waiting in the job-hunter application queue.`,
    ``,
    `Companies: ${shown}`,
    ``,
    `To process them, call the job-hunter MCP tool get_new_jobs.`,
  ].join("\r\n");

  return [
    `From: job-hunter <${AGENT_EMAIL_FROM}>`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${base64(subject)}?=`,
    `Message-ID: <${crypto.randomUUID()}@${AGENT_EMAIL_FROM.split("@")[1]}>`,
    `Date: ${now.toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    base64(body).replace(/.{76}/g, "$&\r\n"),
  ].join("\r\n");
}

function base64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function sendNudge(binding: SendEmail, to: string, raw: string): Promise<void> {
  // Imported lazily: the module exists only in the Workers runtime, and tests
  // never reach here without a binding.
  const { EmailMessage } = await import("cloudflare:email");
  await binding.send(new EmailMessage(AGENT_EMAIL_FROM, to, raw));
}
