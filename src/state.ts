import { SEEN_TTL_DAYS } from "./config";
import type { Activity } from "./journal";

/**
 * The cron's state lives in two KV keys, because the free tier allows only
 * 1,000 writes/day and each key a tick touches costs one.
 *
 * - `TICK_KEY` holds everything a tick that saw a change needs to save — the
 *   per-source commits, the heartbeat clock and the activity log — so such a
 *   tick costs one write rather than three. Reading it every tick costs well
 *   under a millisecond of CPU even with the log full.
 * - `SEEN_KEY` is larger and only touched on ticks that actually sent jobs.
 */
const TICK_KEY = "state:tick:v1";
const SEEN_KEY = "state:seen:v1";

/** The separate keys `TICK_KEY` replaced, read once as a fallback so the switch loses nothing. */
const LEGACY_SOURCES_KEY = "state:sources:v1";
const LEGACY_META_KEY = "state:meta:v1";
const LEGACY_ACTIVITY_KEY = "state:activity:v1";

/** Cap on remembered jobs, to bound both KV value size and parse cost. */
const MAX_SEEN = 6000;

/** source id -> last processed commit sha */
export type SourceShas = Record<string, string>;

/** dedupe key -> epoch seconds first seen */
export type SeenMap = Record<string, number>;


/** Timestamps backing the "am I still alive?" heartbeat. */
export interface Meta {
  lastNotifyTs?: number;
  lastHeartbeatTs?: number;
}

export interface TickState {
  shas: SourceShas;
  meta: Meta;
  activity: Activity;
}

export async function loadTickState(kv: KVNamespace): Promise<TickState> {
  const state = await kv.get<TickState>(TICK_KEY, "json");
  if (state) return state;

  const [shas, meta, activity] = await Promise.all([
    kv.get<SourceShas>(LEGACY_SOURCES_KEY, "json"),
    kv.get<Meta>(LEGACY_META_KEY, "json"),
    kv.get<Activity>(LEGACY_ACTIVITY_KEY, "json"),
  ]);
  return {
    shas: shas ?? {},
    meta: meta ?? {},
    activity: activity ?? { sent: [], rejected: [], rejectCounts: {} },
  };
}

export async function saveTickState(kv: KVNamespace, state: TickState): Promise<void> {
  await kv.put(TICK_KEY, JSON.stringify(state));
}

export async function loadShas(kv: KVNamespace): Promise<SourceShas> {
  return (await loadTickState(kv)).shas;
}

export async function loadMeta(kv: KVNamespace): Promise<Meta> {
  return (await loadTickState(kv)).meta;
}

export async function loadSeen(kv: KVNamespace): Promise<SeenMap> {
  return (await kv.get<SeenMap>(SEEN_KEY, "json")) ?? {};
}

export async function saveSeen(kv: KVNamespace, seen: SeenMap): Promise<void> {
  await kv.put(SEEN_KEY, JSON.stringify(prune(seen)));
}

/** Drop expired entries, then the oldest ones if still over the cap. */
export function prune(seen: SeenMap, now = Math.floor(Date.now() / 1000)): SeenMap {
  const cutoff = now - SEEN_TTL_DAYS * 86400;
  let entries = Object.entries(seen).filter(([, ts]) => ts >= cutoff);

  if (entries.length > MAX_SEEN) {
    entries.sort((a, b) => b[1] - a[1]);
    entries = entries.slice(0, MAX_SEEN);
  }
  return Object.fromEntries(entries);
}
