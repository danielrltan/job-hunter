import { LINKEDIN_SEARCHES, LINKEDIN_WINDOW_SECONDS } from "./config";
import type { Job, Source } from "./types";

/**
 * LinkedIn's logged-out job search: the HTML fragment its public /jobs page
 * fetches as you scroll. No account, cookie or token is involved, so there is
 * no session for LinkedIn to revoke. `f_TPR=r<seconds>` limits results to
 * postings that recent, and each page holds at most 10 cards.
 *
 * The per-posting detail endpoint is rate-limited far harder (it answered 429
 * on the second request when probed), so only card fields are used.
 */
const ENDPOINT = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";
const PAGE_SIZE = 10;
const MAX_PAGES = 3;
/** LinkedIn rate-limits bursts; a gap between requests costs wall time only. Tests zero it. */
export const pacing = { gapMs: 1500 };

/** Enough of a Source for the filter: LinkedIn titles must name the internship themselves. */
export const LINKEDIN_SOURCE: Pick<Source, "id" | "label" | "assumeInternship"> = {
  id: "linkedin",
  label: "LinkedIn",
  assumeInternship: false,
};

export interface LinkedInSearch {
  keywords: string;
  location: string;
}

/** A refusal rather than an answer, so it must never read as "no new jobs". */
export class LinkedInBlocked extends Error {}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(s: string): string {
  return s
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function textOf(card: string, re: RegExp): string {
  const m = card.match(re);
  return m ? decode(m[1]!.replace(/<[^>]*>/g, " ")) : "";
}

/** Cards from one search page. Throws LinkedInBlocked when the page isn't a results fragment. */
export function parseLinkedInCards(html: string): Job[] {
  const parts = html.split(/data-entity-urn="urn:li:jobPosting:/).slice(1);
  if (!parts.length) {
    // A search with no results is an empty fragment; the rate-limit and
    // sign-in walls are whole HTML documents.
    if (/<html|<script/i.test(html)) throw new LinkedInBlocked("served a wall instead of results");
    return [];
  }

  const jobs: Job[] = [];
  for (const part of parts) {
    const id = part.match(/^(\d+)"/)?.[1];
    const title = textOf(part, /class="base-search-card__title"[^>]*>([\s\S]*?)<\/h3>/);
    const company = textOf(part, /class="base-search-card__subtitle"[^>]*>([\s\S]*?)<\/h4>/);
    const location = textOf(part, /class="job-search-card__location"[^>]*>([\s\S]*?)<\/span>/);
    const date = part.match(/<time[^>]*datetime="(\d{4}-\d{2}-\d{2})"/)?.[1];
    if (!id || !title || !company) continue;

    jobs.push({
      sourceId: LINKEDIN_SOURCE.id,
      sourceLabel: LINKEDIN_SOURCE.label,
      company,
      title,
      url: `https://www.linkedin.com/jobs/view/${id}/`,
      locations: location ? [location] : [],
      datePosted: date ? Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000) : undefined,
    });
  }
  if (!jobs.length) throw new LinkedInBlocked("result cards changed shape: none could be read");
  return jobs;
}

export function searchUrl(search: LinkedInSearch, start: number): string {
  const q = new URLSearchParams({
    keywords: search.keywords,
    location: search.location,
    f_TPR: `r${LINKEDIN_WINDOW_SECONDS}`,
    sortBy: "DD",
    start: String(start),
  });
  return `${ENDPOINT}?${q}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every recent posting for one search, paging until a short page. */
export async function searchLinkedIn(search: LinkedInSearch): Promise<Job[]> {
  const jobs: Job[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    if (page) await sleep(pacing.gapMs);
    const res = await fetch(searchUrl(search, page * PAGE_SIZE), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
        Accept: "text/html",
      },
    });
    // 999 is LinkedIn's own "go away" status.
    if (!res.ok) throw new LinkedInBlocked(`HTTP ${res.status}`);
    const cards = parseLinkedInCards(await res.text());
    jobs.push(...cards);
    if (cards.length < PAGE_SIZE) break;
  }
  return jobs;
}

/** All configured searches. One blocked search doesn't discard the others' results. */
export async function pollLinkedIn(
  searches: LinkedInSearch[] = LINKEDIN_SEARCHES,
): Promise<{ jobs: Job[]; errors: string[] }> {
  const jobs: Job[] = [];
  const errors: string[] = [];
  for (const [i, search] of searches.entries()) {
    if (i) await sleep(pacing.gapMs);
    try {
      jobs.push(...(await searchLinkedIn(search)));
    } catch (err) {
      errors.push(`${search.keywords} @ ${search.location}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { jobs, errors };
}
