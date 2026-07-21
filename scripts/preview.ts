/**
 * Tuning tool. Runs the real parsers and the real filter against the *current
 * full contents* of every source, then prints what would have been notified
 * and why everything else was dropped.
 *
 *   npm run preview                      summary + rejection histogram
 *   npm run preview -- --show            also list every matching role
 *   npm run preview -- --rejects=role    list titles dropped for a given reason
 *
 * Use it after editing src/config.ts, before deploying. The --rejects mode is
 * the one that catches over-aggressive filters: skim it for roles you would
 * actually have wanted to hear about.
 */
import { SOURCES } from "../src/config";
import { dedupeKey, filterJobs } from "../src/filter";
import { wholeFile } from "../src/github";
import { parseAdded } from "../src/parsers";
import type { Job, RejectedJob, Source } from "../src/types";

const show = process.argv.includes("--show");
const rejectFilter = process.argv.find((a) => a.startsWith("--rejects="))?.split("=")[1];
const allRejected: RejectedJob[] = [];

const rawUrl = (src: Source, path: string) =>
  `https://raw.githubusercontent.com/${src.owner}/${src.repo}/${src.branch}/${path}`;

const reasons = new Map<string, number>();
const kept: Job[] = [];
let totalParsed = 0;

for (const src of SOURCES) {
  for (const path of src.paths) {
    const res = await fetch(rawUrl(src, path));
    if (!res.ok) {
      console.log(`  ✗ ${src.id}/${path} — HTTP ${res.status} (renamed repo? check config.ts)`);
      continue;
    }

    const jobs = parseAdded(src, wholeFile(await res.text()));
    const { matched, rejected } = filterJobs(jobs, src);
    totalParsed += jobs.length;
    kept.push(...matched);

    allRejected.push(...rejected);
    for (const r of rejected) {
      // Collapse "location: Berlin, Germany" and friends into one bucket.
      const bucket = r.reason.split(":")[0]!;
      reasons.set(bucket, (reasons.get(bucket) ?? 0) + 1);
    }
    console.log(
      `  ${src.id}/${path}: parsed ${String(jobs.length).padStart(5)} → matched ${matched.length}`,
    );
  }
}

// Same collapse the Worker applies across repos.
const unique = new Map<string, Job>();
for (const job of kept) if (!unique.has(dedupeKey(job))) unique.set(dedupeKey(job), job);

console.log("\nWhy listings were dropped");
for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(5)}  ${reason}`);
}

console.log(
  `\nparsed ${totalParsed} · matched ${kept.length} · after cross-source dedupe ${unique.size}`,
);

if (rejectFilter) {
  const hits = allRejected.filter((r) => r.reason.includes(rejectFilter));
  console.log(`\nDropped for "${rejectFilter}" (${hits.length} total, showing 40)`);
  for (const { job, reason } of hits.slice(0, 40)) {
    console.log(`  [${reason}] ${job.company} — ${job.title}`);
  }
}

if (show) {
  console.log("\nMatches");
  for (const job of unique.values()) {
    const where = job.locations[0] ?? "—";
    console.log(`  ${job.company} — ${job.title}  [${where}]  (${job.sourceLabel})`);
  }
} else {
  console.log("re-run with `-- --show` to list them");
}
