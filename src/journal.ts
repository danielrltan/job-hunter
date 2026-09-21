import { dedupeKey } from "./filter";
import type { Job, RejectedJob } from "./types";

/**
 * What the Worker has seen, kept so an agent can tune the filters against it.
 *
 * A filter can only be tuned in both directions if the drops are visible as
 * well as the alerts: the alerts show what to tighten, the drops show what the
 * rules are wrongly discarding. Two keys rather than one because they have
 * different writers — only the cron writes activity, only edits write the
 * change log — and KV is last-write-wins, so a shared key would let one writer
 * clobber the other.
 *
 * Every write here is conditional on something actually happening. The free
 * tier allows 1,000 KV writes a day, and the cron alone fires 720 times.
 */
const ACTIVITY_KEY = "state:activity:v1";
const CHANGES_KEY = "state:changes:v1";

const MAX_SENT = 150;
const MAX_REJECTED = 200;
const MAX_CHANGES = 100;

export interface LoggedJob extends Job {
  /** Short stable id, derived from the dedupe key. */
  id: string;
  /** Epoch seconds it was processed. */
  ts: number;
  /** Why it was dropped. Absent for jobs that were sent. */
  reason?: string;
}

export interface Activity {
  sent: LoggedJob[];
  /** A rolling sample of drops, newest first. */
  rejected: LoggedJob[];
  /** Every drop ever counted, by reason bucket ("location: Berlin" → "location"). */
  rejectCounts: Record<string, number>;
  /** When counting started. */
  since?: number;
}

export interface Change {
  ts: number;
  by: "telegram" | "muse";
  action: string;
  detail: string;
  reason?: string;
}

/** FNV-1a — a short stable id, so the agent can refer to a listing. */
export function jobId(job: Job): string {
  let h = 0x811c9dc5;
  for (const ch of dedupeKey(job)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function reasonBucket(reason: string): string {
  return reason.split(/[:(]/)[0]!.trim();
}

export async function loadActivity(kv: KVNamespace): Promise<Activity> {
  return (
    (await kv.get<Activity>(ACTIVITY_KEY, "json")) ?? { sent: [], rejected: [], rejectCounts: {} }
  );
}

/** Fold one tick's outcome into the log. Pure, so it can be tested without KV. */
export function recordTick(
  activity: Activity,
  sent: Job[],
  rejected: RejectedJob[],
  now: number,
): Activity {
  const counts = { ...activity.rejectCounts };
  for (const r of rejected) {
    const bucket = reasonBucket(r.reason);
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  // Only what the filter reads plus what a reader needs; salary and the like
  // would just inflate a value that's parsed on every busy tick.
  const log = ({ salary: _s, workModel: _w, datePosted: _d, ...job }: Job, reason?: string): LoggedJob => ({
    ...job,
    id: jobId(job as Job),
    ts: now,
    ...(reason ? { reason } : {}),
  });

  return {
    sent: [...sent.map((j) => log(j)), ...activity.sent].slice(0, MAX_SENT),
    rejected: [...rejected.map((r) => log(r.job, r.reason)), ...activity.rejected].slice(
      0,
      MAX_REJECTED,
    ),
    rejectCounts: counts,
    since: activity.since ?? now,
  };
}

export async function saveActivity(kv: KVNamespace, activity: Activity): Promise<void> {
  await kv.put(ACTIVITY_KEY, JSON.stringify(activity));
}

export async function loadChanges(kv: KVNamespace): Promise<Change[]> {
  return (await kv.get<Change[]>(CHANGES_KEY, "json")) ?? [];
}

export async function logChange(kv: KVNamespace, change: Change): Promise<void> {
  const changes = await loadChanges(kv);
  await kv.put(CHANGES_KEY, JSON.stringify([change, ...changes].slice(0, MAX_CHANGES)));
}
