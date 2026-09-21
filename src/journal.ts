import { dedupeKey } from "./filter";
import { loadTickState, saveTickState } from "./state";
import type { Job, RejectedJob } from "./types";

/**
 * What the Worker has seen, kept so an agent can tune the filters against it.
 *
 * A filter can only be tuned in both directions if the drops are visible as
 * well as the alerts: the alerts show what to tighten, the drops show what the
 * rules are wrongly discarding.
 *
 * The activity log is written only by the cron, so it rides in the cron's own
 * tick-state key (see state.ts). The change log and applications are written
 * by edits and the agent, so they get keys of their own: KV is
 * last-write-wins, and a key shared across writers lets one clobber another.
 *
 * Every write here is conditional on something actually happening. The free
 * tier allows 1,000 KV writes a day, and the cron alone fires 720 times.
 */
const CHANGES_KEY = "state:changes:v1";
const APPLICATIONS_KEY = "state:applications:v1";

/**
 * Sent jobs double as the agent's application queue, so this is sized to hold
 * several days of alerts even if the agent falls behind.
 */
const MAX_SENT = 400;
const MAX_REJECTED = 200;
const MAX_CHANGES = 100;
const MAX_APPLICATIONS = 1000;

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
  return (await loadTickState(kv)).activity;
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

/** Outside the cron — which saves its whole tick state at once — only tests need this. */
export async function saveActivity(kv: KVNamespace, activity: Activity): Promise<void> {
  await saveTickState(kv, { ...(await loadTickState(kv)), activity });
}

export async function loadChanges(kv: KVNamespace): Promise<Change[]> {
  return (await kv.get<Change[]>(CHANGES_KEY, "json")) ?? [];
}

export async function logChange(kv: KVNamespace, change: Change): Promise<void> {
  const changes = await loadChanges(kv);
  await kv.put(CHANGES_KEY, JSON.stringify([change, ...changes].slice(0, MAX_CHANGES)));
}

/* ------------------------------------------------------------------ */
/* Applications — the agent's progress through the sent jobs           */
/* ------------------------------------------------------------------ */

export const APPLICATION_STATUSES = [
  "in_progress",
  "needs_review",
  "submitted",
  "skipped",
  "failed",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export interface Application {
  status: ApplicationStatus;
  /** Epoch seconds of the last update. */
  ts: number;
  note?: string;
  /** Snapshot, since the job may roll out of the activity log. */
  job: Pick<Job, "company" | "title" | "url">;
}

/**
 * A claim that hasn't been updated in this long is treated as abandoned — the
 * agent crashed or lost the thread mid-form — and the job is offered again.
 */
export const STALE_CLAIM_SECONDS = 6 * 3600;

export async function loadApplications(kv: KVNamespace): Promise<Record<string, Application>> {
  return (await kv.get<Record<string, Application>>(APPLICATIONS_KEY, "json")) ?? {};
}

export async function saveApplications(
  kv: KVNamespace,
  updates: Record<string, Application>,
): Promise<void> {
  const all = { ...(await loadApplications(kv)), ...updates };
  const kept = Object.entries(all)
    .sort((a, b) => b[1].ts - a[1].ts)
    .slice(0, MAX_APPLICATIONS);
  await kv.put(APPLICATIONS_KEY, JSON.stringify(Object.fromEntries(kept)));
}

/** Sent jobs the agent hasn't handled yet, oldest first. Pure. */
export function pendingJobs(
  sent: LoggedJob[],
  applications: Record<string, Application>,
  now: number,
): LoggedJob[] {
  return sent
    .filter((j) => {
      const app = applications[j.id];
      return !app || (app.status === "in_progress" && now - app.ts > STALE_CLAIM_SECONDS);
    })
    .reverse();
}

