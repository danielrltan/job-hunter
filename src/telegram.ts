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

  const lines = [heading, `<a href="${escapeHtml(job.url)}">${escapeHtml(job.title)}</a>`];

  if (job.locations.length) {
    lines.push(`📍 ${escapeHtml(job.locations.slice(0, 3).join(" · "))}`);
  }

  const meta = [job.term, job.workModel, job.salary].filter(Boolean) as string[];
  if (meta.length) lines.push(`🗓 ${escapeHtml(meta.join(" · "))}`);

  if (job.sponsorship === "Offers Sponsorship") lines.push("✅ Offers sponsorship");
  lines.push(`<i>via ${escapeHtml(job.sourceLabel)}</i>`);

  return lines.join("\n");
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

  const header = jobs.length === 1 ? "🆕 New internship" : `🆕 ${jobs.length} new internships`;
  return messages.map((m, i) => (i === 0 ? `${header}\n\n${m}` : m));
}

export async function sendMessage(text: string, botToken: string, chatId: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      link_preview_options: { is_disabled: true },
    }),
  });

  if (!res.ok) {
    throw new Error(`telegram sendMessage failed: ${res.status} ${await res.text()}`);
  }
}

export async function notify(jobs: Job[], botToken: string, chatId: string): Promise<number> {
  const messages = buildMessages(jobs);
  for (const message of messages) {
    await sendMessage(message, botToken, chatId);
  }
  return messages.length;
}
