import type { Hunk, Job, Source } from "./types";

/**
 * Parsers take a diff's *hunks* rather than a whole file. That keeps CPU flat
 * regardless of how large the underlying feed grows, and means "what's new"
 * falls out of the diff instead of a full-file comparison.
 *
 * Only added lines become jobs; context lines are read for the company a '↳'
 * row belongs to, and never emitted.
 */
export function parseAdded(src: Source, hunks: Hunk[]): Job[] {
  switch (src.parser) {
    case "listings-json":
      // A JSON object is self-describing, so neighbouring lines add nothing.
      return parseListingsJson(
        src,
        hunks.flat().filter((l) => l.added).map((l) => l.text),
      );
    case "speedyapply":
      return parseSpeedyApply(src, hunks);
    case "jobright":
      return parseJobright(src, hunks);
  }
}

/* ------------------------------------------------------------------ */
/* Structured JSON feeds (Simplify, Vansh)                             */
/* ------------------------------------------------------------------ */

interface RawListing {
  company_name?: string;
  title?: string;
  url?: string;
  locations?: string[];
  sponsorship?: string;
  terms?: string[];
  season?: string;
  date_posted?: number;
  active?: boolean;
  is_visible?: boolean;
}

function parseListingsJson(src: Source, lines: string[]): Job[] {
  const jobs: Job[] = [];
  for (const raw of extractJsonObjects(lines.join("\n"))) {
    const r = raw as RawListing;
    if (!r.company_name || !r.title || !r.url) continue;
    // These feeds keep history in-file; only announce live, visible rows.
    if (r.active === false || r.is_visible === false) continue;

    jobs.push({
      sourceId: src.id,
      sourceLabel: src.label,
      company: r.company_name,
      title: r.title,
      url: r.url,
      locations: r.locations ?? [],
      sponsorship: r.sponsorship,
      term: r.terms?.[0] ?? r.season,
      datePosted: r.date_posted,
    });
  }
  return jobs;
}

/**
 * Scan text for balanced `{...}` regions and JSON.parse each one.
 *
 * Diff hunks are not valid JSON on their own — they contain object fragments,
 * trailing commas and gaps where unchanged lines were elided. Anything that
 * fails to parse is simply skipped.
 */
export function extractJsonObjects(text: string): unknown[] {
  const found: unknown[] = [];
  let i = 0;

  while (i < text.length) {
    if (text[i] !== "{") {
      i++;
      continue;
    }
    const end = findMatchingBrace(text, i);
    if (end === -1) break;

    try {
      found.push(JSON.parse(text.slice(i, end + 1)));
      i = end + 1;
    } catch {
      // Fragment, not a whole object — step past this brace and keep looking.
      i++;
    }
  }
  return found;
}

/** Index of the `}` closing the `{` at `start`, ignoring braces inside strings. */
function findMatchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/* ------------------------------------------------------------------ */
/* Markdown table feeds                                                */
/* ------------------------------------------------------------------ */

/** Split a markdown table row into trimmed cells, or null if it isn't one. */
export function tableCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;

  const cells = trimmed.split("|").slice(1, -1).map((c) => c.trim());
  if (!cells.length) return null;
  // Separator row: |---|---|
  if (cells.every((c) => /^:?-{2,}:?$/.test(c))) return null;
  return cells;
}

const HTML_TAG = /<[^>]*>/g;
const MD_LINK = /\[([^\]]*)\]\(([^)]+)\)/;

function stripTags(s: string): string {
  return s.replace(HTML_TAG, "").replace(/\*\*/g, "").trim();
}

/** These feeds use ↳ to mean "same company as the row above". */
function isContinuation(cell: string): boolean {
  return stripTags(cell) === "↳";
}

/**
 * SpeedyApply: | Company | Position | Location | Salary | Posting | Age |
 * Company and the apply link are HTML anchors.
 */
function parseSpeedyApply(src: Source, hunks: Hunk[]): Job[] {
  const jobs: Job[] = [];

  for (const hunk of hunks) {
    // Reset per hunk: rows in different hunks are not neighbours in the file,
    // so a company must never carry across the gap between them.
    let lastCompany = "";

    for (const line of hunk) {
      const cells = tableCells(line.text);
      if (!cells || cells.length < 4) continue;
      if (/^company$/i.test(stripTags(cells[0]!))) continue;

      const company = isContinuation(cells[0]!)
        ? lastCompany
        : stripTags(cells[0]!.match(/<strong>([\s\S]*?)<\/strong>/)?.[1] ?? cells[0]!);
      if (!company) continue;
      lastCompany = company;

      // Context lines exist only to resolve the company above.
      if (!line.added) continue;

      const title = stripTags(cells[1]!);

      // The Salary column exists in some of these tables and not others, and a
      // diff hunk almost never includes the header row to disambiguate. So find
      // the apply link by scanning back from the end rather than by index —
      // cell 0 is excluded because it holds the company's own homepage.
      let url: string | undefined;
      for (let i = cells.length - 1; i >= 2; i--) {
        const href = cells[i]!.match(/href="([^"]+)"/)?.[1];
        if (href) {
          url = href;
          break;
        }
      }
      if (!title || !url) continue;

      const location = stripTags(cells[2]!);
      const salary = cells.slice(3).map(stripTags).find((c) => /\$\s?\d/.test(c));

      jobs.push({
        sourceId: src.id,
        sourceLabel: src.label,
        company,
        title,
        url,
        locations: location ? [location] : [],
        salary,
      });
    }
  }
  return jobs;
}

/**
 * Jobright: | Company | Job Title | Location | Work Model | Date Posted |
 * Company and title are bolded markdown links.
 */
function parseJobright(src: Source, hunks: Hunk[]): Job[] {
  const jobs: Job[] = [];

  for (const hunk of hunks) {
    // Reset per hunk: rows in different hunks are not neighbours in the file,
    // so a company must never carry across the gap between them.
    let lastCompany = "";

    for (const line of hunk) {
      const cells = tableCells(line.text);
      if (!cells || cells.length < 3) continue;
      if (/^company$/i.test(stripTags(cells[0]!))) continue;

      const company = isContinuation(cells[0]!)
        ? lastCompany
        : stripTags(cells[0]!.match(MD_LINK)?.[1] ?? cells[0]!);
      if (!company) continue;
      lastCompany = company;

      // Context lines exist only to resolve the company above.
      if (!line.added) continue;

      const titleLink = cells[1]!.match(MD_LINK);
      const title = stripTags(titleLink?.[1] ?? cells[1]!);
      const url = titleLink?.[2];
      if (!title || !url) continue;

      jobs.push({
        sourceId: src.id,
        sourceLabel: src.label,
        company,
        title,
        url,
        locations: cells[2] ? [stripTags(cells[2])] : [],
        workModel: cells
          .slice(3)
          .map(stripTags)
          .find((c) => /^(on[- ]?site|remote|hybrid)$/i.test(c)),
      });
    }
  }
  return jobs;
}
