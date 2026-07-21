import {
  ALLOWED_LOCATIONS,
  BLOCKED_LOCATIONS,
  BLOCKED_SPONSORSHIP,
  BLOCKED_TEXT,
  GRADUATE_ONLY,
  INTERNSHIP_MARKERS,
  SEASON_ORDER,
  UNDERGRAD_WELCOME,
} from "./config";
import { defaultSettings, type Settings } from "./settings";
import type { Job, RejectedJob, Source } from "./types";

export type Verdict = { ok: true } | { ok: false; reason: string };

const NOT_AN_INTERNSHIP =
  /\b(new\s*grad(uate)?|full[- ]?time|entry[- ]?level|graduate\s*program)\b/i;

/** Chronological rank so terms can be compared across years. */
function termRank(season: string, year: number): number {
  const order = SEASON_ORDER[season.toLowerCase()];
  return year * 4 + (order ?? 0);
}


const TERM_RE = /(winter|spring|summer|fall|autumn)\s*'?(\d{4}|\d{2})\b/gi;
/** ByteDance and others write "2026 Summer" rather than "Summer 2026". */
const TERM_RE_REVERSED = /\b(\d{4})\s+(winter|spring|summer|fall|autumn)\b/gi;

/** Every season+year pair mentioned in a job's term field or title. */
export function extractTerms(job: Job): Array<{ season: string; year: number }> {
  const haystack = `${job.term ?? ""} ${job.title}`;
  const terms: Array<{ season: string; year: number }> = [];

  for (const m of haystack.matchAll(TERM_RE)) {
    const raw = Number(m[2]);
    terms.push({ season: m[1]!.toLowerCase(), year: raw < 100 ? 2000 + raw : raw });
  }
  for (const m of haystack.matchAll(TERM_RE_REVERSED)) {
    terms.push({ season: m[2]!.toLowerCase(), year: Number(m[1]) });
  }
  return terms;
}

function matchesAny(patterns: RegExp[], text: string): boolean {
  return patterns.some((re) => re.test(text));
}

/**
 * Decide whether a single listing is worth a notification.
 *
 * Order matters: the cheapest and most decisive checks run first so that
 * rejection reasons in the preview tool point at the real disqualifier.
 */
export function evaluate(job: Job, src: Source, settings: Settings = defaultSettings()): Verdict {
  const title = job.title;
  const locationText = job.locations.join(" | ");
  const fullText = `${title} ${locationText}`;

  // --- Is it actually an internship? ---
  const looksLikeIntern = matchesAny(INTERNSHIP_MARKERS, title);
  if (NOT_AN_INTERNSHIP.test(title) && !looksLikeIntern) {
    return { ok: false, reason: "not an internship" };
  }
  if (!looksLikeIntern && !src.assumeInternship) {
    return { ok: false, reason: "no internship marker in title" };
  }

  // --- Right field of work? ---
  if (matchesAny(settings.roleHardExclude, title)) {
    return { ok: false, reason: "unrelated discipline" };
  }
  const relevant = matchesAny(settings.roleInclude, title);
  if (!relevant) {
    if (matchesAny(settings.roleSoftExclude, title)) {
      return { ok: false, reason: "non-technical function" };
    }
    return { ok: false, reason: "no matching role keyword" };
  }

  // --- Postgraduate-only? ---
  if (GRADUATE_ONLY.test(title) && !UNDERGRAD_WELCOME.test(title)) {
    return { ok: false, reason: "graduate/PhD only" };
  }

  // --- Is it the term being targeted? ---
  // An unlabelled listing passes; a listing labelled with a different term does not.
  if (settings.targetTerms !== "any") {
    const wanted = new Set(settings.targetTerms.map((t) => termRank(t.season, t.year)));
    const terms = extractTerms(job);
    if (terms.length && !terms.some((t) => wanted.has(termRank(t.season, t.year)))) {
      const t = terms[0]!;
      return { ok: false, reason: `wrong term (${t.season} ${t.year})` };
    }
  }

  // --- Work authorization ---
  if (job.sponsorship && BLOCKED_SPONSORSHIP.includes(job.sponsorship.trim().toLowerCase())) {
    return { ok: false, reason: `sponsorship: ${job.sponsorship}` };
  }
  if (matchesAny(BLOCKED_TEXT, fullText)) {
    return { ok: false, reason: "requires citizenship/clearance" };
  }

  // --- Somewhere reachable ---
  if (locationText && !matchesAny(ALLOWED_LOCATIONS, locationText)) {
    if (matchesAny(BLOCKED_LOCATIONS, locationText)) {
      return { ok: false, reason: `location: ${locationText}` };
    }
  }

  return { ok: true };
}

export function filterJobs(
  jobs: Job[],
  src: Source,
  settings: Settings = defaultSettings(),
): { matched: Job[]; rejected: RejectedJob[] } {
  const matched: Job[] = [];
  const rejected: RejectedJob[] = [];

  for (const job of jobs) {
    const verdict = evaluate(job, src, settings);
    if (verdict.ok) matched.push(job);
    else rejected.push({ job, reason: verdict.reason });
  }
  return { matched, rejected };
}

/* ------------------------------------------------------------------ */
/* Cross-source dedupe                                                 */
/* ------------------------------------------------------------------ */

const STRIP_FROM_TITLE =
  /\b(winter|spring|summer|fall|autumn)\s*'?\d{2,4}\b|\b20\d{2}\b|\bintern(ship)?s?\b|\bco[- ]?op\b/gi;

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The same posting shows up in several of these repos with slightly different
 * wording, so dedupe on company + role rather than URL. Season and the word
 * "intern" are stripped because feeds disagree on both.
 */
export function dedupeKey(job: Job): string {
  return `${normalize(job.company)}::${normalize(job.title.replace(STRIP_FROM_TITLE, " "))}`;
}
