import { companyRank, matchTiers } from "./companies";
import type { Job } from "./types";

const MAX_CHARS = 3500; // Telegram's hard limit is 4096
const MAX_JOBS_PER_MESSAGE = 8;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatJob(job: Job): string {
  const tiers = matchTiers(job.company);

  // Uppercase is reserved for the top tier — if everything shouts, nothing does.
  const isTopTier = tiers.length > 0 && companyRank(job.company) === 0;
  const name = isTopTier ? job.company.toUpperCase() : job.company;

  const heading = tiers.length
    ? `${tiers.map((t) => t.emoji).join("")} <b>${escapeHtml(name)}</b> · <i>${tiers
        .map((t) => t.label)
        .join(" · ")}</i>`
    : `🎯 <b>${escapeHtml(name)}</b>`;

  // The role is what decides whether to click, so it carries the weight.
  const lines = [
    heading,
    `<a href="${escapeHtml(job.url)}"><b>${escapeHtml(job.title)}</b></a>`,
  ];

  if (job.locations.length) {
    lines.push(`📍 ${escapeHtml(job.locations.slice(0, 3).join(" · "))}`);
  }

  const meta = [job.term, job.workModel, job.salary].filter(Boolean) as string[];
  if (meta.length) lines.push(`🗓 ${escapeHtml(meta.join(" · "))}`);

  if (job.sponsorship === "Offers Sponsorship") lines.push("✅ Offers sponsorship");
  lines.push(`<i>via ${escapeHtml(job.sourceLabel)}</i>`);

  // A blockquote draws a vertical rule down the left of the whole block, which
  // is what separates one listing from the next when several arrive together.
  // It is the only container Telegram offers — there are no cards or colours —
  // and blockquotes cannot nest, so this must stay the outermost tag.
  return `<blockquote>${lines.join("\n")}</blockquote>`;
}

/** Group jobs into messages that respect Telegram's length limit. */
export function buildMessages(unsorted: Job[]): string[] {
  // Notable companies first, so a long batch leads with what matters.
  // Stable within a tier, preserving the order sources were polled in.
  const jobs = [...unsorted].sort((a, b) => companyRank(a.company) - companyRank(b.company));

  const messages: string[] = [];
  let batch: string[] = [];
  let length = 0;

  const flush = () => {
    if (batch.length) messages.push(batch.join("\n\n"));
    batch = [];
    length = 0;
  };

  for (const job of jobs) {
    const block = formatJob(job);
    if (batch.length >= MAX_JOBS_PER_MESSAGE || length + block.length > MAX_CHARS) flush();
    batch.push(block);
    length += block.length + 2;
  }
  flush();

  const header = jobs.length === 1 ? "New internship" : `${jobs.length} new internships`;
  return messages.map((m, i) => (i === 0 ? `<b>${header}</b>\n\n${m}` : m));
}

/** Last-resort rendering of a message Telegram refused to parse. */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function post(text: string, botToken: string, chatId: string, formatted: boolean): Promise<Response> {
  return fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      ...(formatted ? { parse_mode: "HTML" } : {}),
      disable_web_page_preview: true,
      link_preview_options: { is_disabled: true },
    }),
  });
}

export async function sendMessage(text: string, botToken: string, chatId: string): Promise<void> {
  const res = await post(text, botToken, chatId, true);
  if (res.ok) return;

  const detail = await res.text();

  /**
   * A 400 is Telegram rejecting the message itself — nearly always the
   * formatting — and it will reject the identical retry just as surely.
   *
   * That matters more than it looks. Commit state is saved only after a send
   * succeeds, so a permanently unsendable message doesn't fail once: it wedges
   * the next tick, and every tick after it, on the same listing. One unlucky
   * character in a job title would silently end all notifications. Falling back
   * to unformatted text keeps the listing deliverable and the queue moving.
   */
  if (res.status === 400) {
    const plain = await post(stripHtml(text), botToken, chatId, false);
    if (plain.ok) return;
    throw new Error(
      `telegram rejected both formatted and plain text: ${res.status} ${detail}`,
    );
  }

  // Anything else (429, 5xx) is worth retrying with the same message next tick.
  throw new Error(`telegram sendMessage failed: ${res.status} ${detail}`);
}

export async function notify(jobs: Job[], botToken: string, chatId: string): Promise<number> {
  const messages = buildMessages(jobs);
  for (const message of messages) {
    await sendMessage(message, botToken, chatId);
  }
  return messages.length;
}
