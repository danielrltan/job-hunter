import { companyRank, matchTiers } from "./companies";
import { jobId } from "./journal";
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

  // The title is a link, and a link is already coloured. Bolding it too made it
  // out-compete the company above it, which is the line you actually scan for.
  // Bold stays on the company alone so it wins its block outright.
  const lines = [heading, `<a href="${escapeHtml(job.url)}">${escapeHtml(job.title)}</a>`];

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

export interface InlineButton {
  text: string;
  callback_data: string;
}
export type Keyboard = InlineButton[][];

export interface Batch {
  text: string;
  jobs: Job[];
}

/** Callback data for a rating button: `fb:<u|d>:<job id>`, well under Telegram's 64 bytes. */
export function feedbackData(verdict: "up" | "down", id: string): string {
  return `fb:${verdict === "up" ? "u" : "d"}:${id}`;
}

export function parseFeedbackData(data: string): { verdict: "up" | "down"; id: string } | null {
  const m = data.match(/^fb:([ud]):([0-9a-f]{8})$/);
  return m ? { verdict: m[1] === "u" ? "up" : "down", id: m[2]! } : null;
}

/**
 * One 👍/👎 row per listing, labelled by company so it's clear which block a
 * button belongs to. These taps are the preference signal the MCP tuning loop
 * learns from — without them an agent would be tuning against nothing.
 */
export function feedbackKeyboard(jobs: Job[]): Keyboard {
  const used = new Map<string, number>();
  return jobs.map((job) => {
    let label = job.company.length > 18 ? `${job.company.slice(0, 17)}…` : job.company;
    const n = (used.get(label) ?? 0) + 1;
    used.set(label, n);
    if (n > 1) label = `${label} #${n}`;
    const id = jobId(job);
    return [
      { text: `👍 ${label}`, callback_data: feedbackData("up", id) },
      { text: `👎 ${label}`, callback_data: feedbackData("down", id) },
    ];
  });
}

/** Mark the tapped button, clearing any earlier mark in the same row. */
export function markChoice(keyboard: Keyboard, data: string): Keyboard {
  const strip = (t: string) => t.replace(/^✓ /, "");
  const row = keyboard.find((r) => r.some((b) => b.callback_data === data));
  return keyboard.map((r) =>
    r === row
      ? r.map((b) => ({ ...b, text: b.callback_data === data ? `✓ ${strip(b.text)}` : strip(b.text) }))
      : r,
  );
}

/** Group jobs into messages that respect Telegram's length limit. */
export function buildMessages(unsorted: Job[]): string[] {
  return buildBatches(unsorted).map((b) => b.text);
}

export function buildBatches(unsorted: Job[]): Batch[] {
  // Notable companies first, so a long batch leads with what matters.
  // Stable within a tier, preserving the order sources were polled in.
  const jobs = [...unsorted].sort((a, b) => companyRank(a.company) - companyRank(b.company));

  const messages: Batch[] = [];
  let batch: string[] = [];
  let batchJobs: Job[] = [];
  let length = 0;

  const flush = () => {
    if (batch.length) messages.push({ text: batch.join("\n\n"), jobs: batchJobs });
    batch = [];
    batchJobs = [];
    length = 0;
  };

  for (const job of jobs) {
    const block = formatJob(job);
    if (batch.length >= MAX_JOBS_PER_MESSAGE || length + block.length > MAX_CHARS) flush();
    batch.push(block);
    batchJobs.push(job);
    length += block.length + 2;
  }
  flush();

  // The batch is sorted most-notable-first, so the lead job carries the best
  // tier in the drop. Mirroring its emoji onto the header advertises a Big Tech
  // (⭐) — or otherwise notable — listing from the header alone, before you
  // scroll into the blockquotes. Most drops are unknown companies and stay bare.
  const topTier = matchTiers(jobs[0]?.company ?? "")[0];
  const noun = jobs.length === 1 ? "New internship" : `${jobs.length} new internships`;
  const header = topTier ? `${topTier.emoji} <b>${noun}</b>` : `<b>${noun}</b>`;
  return messages.map((m, i) => (i === 0 ? { ...m, text: `${header}\n\n${m.text}` } : m));
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

function post(
  text: string,
  botToken: string,
  chatId: string,
  formatted: boolean,
  keyboard?: Keyboard,
): Promise<Response> {
  return fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      ...(formatted ? { parse_mode: "HTML" } : {}),
      disable_web_page_preview: true,
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    }),
  });
}

export async function sendMessage(
  text: string,
  botToken: string,
  chatId: string,
  keyboard?: Keyboard,
): Promise<void> {
  const res = await post(text, botToken, chatId, true, keyboard);
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
    // No keyboard either: the fallback must differ from the rejected message
    // in everything that could have caused the 400, or it wedges just the same.
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
  const batches = buildBatches(jobs);
  for (const batch of batches) {
    await sendMessage(batch.text, botToken, chatId, feedbackKeyboard(batch.jobs));
  }
  return batches.length;
}

/**
 * Acknowledge a button tap. Telegram shows a spinner on the button until this
 * is called, so it runs even when the tap is otherwise ignored.
 */
export async function answerCallback(botToken: string, callbackId: string, text?: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId, ...(text ? { text } : {}) }),
  });
}

export async function editKeyboard(
  botToken: string,
  chatId: string,
  messageId: number,
  keyboard: Keyboard,
): Promise<void> {
  await fetch(`https://api.telegram.org/bot${botToken}/editMessageReplyMarkup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: keyboard },
    }),
  });
}
