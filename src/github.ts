import type { Hunk, Source } from "./types";

const API = "https://api.github.com";

function ghHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "job-hunter-worker",
  };
  // Anonymous requests work but are capped at 60/hour — fine for local smoke
  // tests, nowhere near enough for a 2-minute cron across 8 repos.
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export interface SourceDiff {
  /** Commit the source is now at. Persist this as the next base. */
  headSha: string;
  /** Watched path -> the diff's hunks, each in file order. */
  hunksByPath: Map<string, Hunk[]>;
  /** True when there was no prior state, so nothing should be notified. */
  bootstrapped: boolean;
  /** Watched paths GitHub refused to diff (too large). Jobs there are missed. */
  truncatedPaths: string[];
}

/** Resolve the current tip of a source's branch. Follows repo renames. */
export async function fetchHeadSha(src: Source, token: string): Promise<string> {
  const url = `${API}/repos/${src.owner}/${src.repo}/commits?sha=${encodeURIComponent(src.branch)}&per_page=1`;
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (!res.ok) {
    throw new Error(`[${src.id}] head lookup failed: ${res.status} ${await res.text()}`);
  }
  const commits = (await res.json()) as Array<{ sha: string }>;
  if (!commits.length) throw new Error(`[${src.id}] branch ${src.branch} has no commits`);
  return commits[0]!.sha;
}

/**
 * Diff a source from `baseSha` to the tip of its branch and return only the
 * added lines of the watched files.
 *
 * This is the whole reason the Worker stays inside the free CPU budget:
 * Simplify's listings.json is ~11 MB, but a three-hour diff of it is ~8 KB.
 */
export async function diffSince(
  src: Source,
  baseSha: string | undefined,
  token: string,
): Promise<SourceDiff> {
  const empty = () => new Map<string, Hunk[]>();

  // No prior state: record where we are and stay quiet, so first deploy
  // doesn't fire hundreds of notifications for listings that already exist.
  if (!baseSha) {
    return {
      headSha: await fetchHeadSha(src, token),
      hunksByPath: empty(),
      bootstrapped: true,
      truncatedPaths: [],
    };
  }

  const url = `${API}/repos/${src.owner}/${src.repo}/compare/${baseSha}...${encodeURIComponent(src.branch)}`;
  const res = await fetch(url, { headers: ghHeaders(token) });

  // A base commit GitHub can no longer reach (force-push, history rewrite).
  // Re-anchor to the current tip rather than getting stuck forever.
  if (res.status === 404 || res.status === 422) {
    return {
      headSha: await fetchHeadSha(src, token),
      hunksByPath: empty(),
      bootstrapped: true,
      truncatedPaths: [],
    };
  }
  if (!res.ok) {
    throw new Error(`[${src.id}] compare failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    status: string;
    commits?: Array<{ sha: string }>;
    files?: Array<{ filename: string; patch?: string }>;
  };

  const commits = data.commits ?? [];
  // The compare endpoint pages commits at 250. If we ever fall further behind
  // than that we advance partway here and catch up on the next tick.
  const headSha = commits.length ? commits[commits.length - 1]!.sha : baseSha;

  const hunksByPath = empty();
  const truncatedPaths: string[] = [];

  for (const file of data.files ?? []) {
    if (!src.paths.includes(file.filename)) continue;
    if (!file.patch) {
      truncatedPaths.push(file.filename);
      continue;
    }
    hunksByPath.set(file.filename, parseHunks(file.patch));
  }

  return { headSha, hunksByPath, bootstrapped: false, truncatedPaths };
}

/**
 * Split a unified diff into hunks, keeping added *and* context lines in file
 * order.
 *
 * Context matters because these feeds group several roles under one company
 * and mark the extra rows with '↳'. When a new role is added under an existing
 * company, the company's own row is unchanged and reaches us only as context.
 * Discarding context left those rows to inherit whatever company happened to
 * appear earlier in the diff — a different one entirely, several rows away in
 * the file.
 */
export function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;

  for (const line of patch.split("\n")) {
    // Hunks are non-adjacent regions, so each starts a fresh run of lines.
    if (line.startsWith("@@")) {
      current = [];
      hunks.push(current);
      continue;
    }
    if (!current) continue; // preamble before the first hunk header
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"

    if (line.startsWith("+")) current.push({ text: line.slice(1), added: true });
    else if (line.startsWith("-")) continue; // removed: not in the new file at all
    else current.push({ text: line.startsWith(" ") ? line.slice(1) : line, added: false });
  }

  return hunks.filter((h) => h.some((l) => l.added));
}

/** Just the added lines, for feeds where surrounding context is meaningless. */
export function extractAddedLines(patch: string): string[] {
  return parseHunks(patch)
    .flat()
    .filter((l) => l.added)
    .map((l) => l.text);
}

/**
 * Treat a whole file as a single hunk of entirely new lines — what the preview
 * tool and the parser tests want, since they work from full files rather than
 * diffs.
 */
export function wholeFile(text: string): Hunk[] {
  return [text.split("\n").map((line) => ({ text: line, added: true }))];
}
