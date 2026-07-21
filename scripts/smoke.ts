/**
 * End-to-end smoke test of the production code path, minus Cloudflare.
 *
 * Runs the real GitHub compare call, the real diff extraction, the real
 * parser, the real filter and the real message builder — then prints the
 * exact Telegram message that would have been delivered.
 *
 *   npm run smoke                      diff Simplify over its last few commits
 *   npm run smoke -- simplify <sha>    any source, any base commit
 *
 * Works without a token (GitHub allows 60 anonymous requests/hour).
 */
import { SOURCES } from "../src/config";
import { dedupeKey, filterJobs } from "../src/filter";
import { diffSince } from "../src/github";
import { parseAdded } from "../src/parsers";
import { buildMessages } from "../src/telegram";
import type { Job } from "../src/types";

const [sourceId = "simplify", baseSha = "f01a85e58a"] = process.argv.slice(2);
const src = SOURCES.find((s) => s.id === sourceId);
if (!src) throw new Error(`unknown source "${sourceId}"`);

console.log(`Diffing ${src.owner}/${src.repo}@${src.branch} from ${baseSha}\n`);

const diff = await diffSince(src, baseSha, process.env.GITHUB_TOKEN ?? "");
console.log(`head:         ${diff.headSha}`);
console.log(`bootstrapped: ${diff.bootstrapped}`);
if (diff.truncatedPaths.length) console.log(`truncated:    ${diff.truncatedPaths.join(", ")}`);

const seen = new Set<string>();
const fresh: Job[] = [];

for (const [path, hunks] of diff.hunksByPath) {
  const jobs = parseAdded(src, hunks);
  const { matched, rejected } = filterJobs(jobs, src);

  console.log(`\n${path}`);
  console.log(`  hunks:       ${hunks.length}`);
  console.log(`  added lines: ${hunks.flat().filter((l) => l.added).length}`);
  console.log(`  parsed:      ${jobs.length}`);
  console.log(`  matched:     ${matched.length}`);

  for (const job of matched) {
    const key = dedupeKey(job);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(job);
  }
  if (rejected.length) {
    console.log("  sample rejections:");
    for (const r of rejected.slice(0, 5)) console.log(`    [${r.reason}] ${r.job.title}`);
  }
}

if (!fresh.length) {
  console.log("\nNothing would have been sent for this commit range.");
} else {
  console.log(`\n${"=".repeat(60)}\nTelegram would receive:\n${"=".repeat(60)}`);
  for (const message of buildMessages(fresh)) console.log(`\n${message}`);
}
