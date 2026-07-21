import { SEEN_TTL_DAYS } from "./config";

/**
 * State lives in two KV keys rather than one per source or one per job,
 * because the free tier allows only 1,000 writes/day.
 *
 * - `SOURCES_KEY` is tiny and read every tick.
 * - `SEEN_KEY` is larger but only touched on ticks that actually found jobs,
 *   which is a small minority of them.
 */
const SOURCES_KEY = "state:sources:v1";
const SEEN_KEY = "state:seen:v1";
const META_KEY = "state:meta:v1";

/** Cap on remembered jobs, to bound both KV value size and parse cost. */
const MAX_SEEN = 6000;

/** source id -> last processed commit sha */
export type SourceShas = Record<string, string>;

/** dedupe key -> epoch seconds first seen */
export type SeenMap = Record<string, number>;

export async function loadShas(kv: KVNamespace): Promise<SourceShas> {
  return (await kv.get<SourceShas>(SOURCES_KEY, "json")) ?? {};
}

export async function saveShas(kv: KVNamespace, shas: SourceShas): Promise<void> {
  await kv.put(SOURCES_KEY, JSON.stringify(shas));
}

/** Timestamps backing the "am I still alive?" heartbeat. */
export interface Meta {
  lastNotifyTs?: number;
  lastHeartbeatTs?: number;
}

export async function loadMeta(kv: KVNamespace): Promise<Meta> {
  return (await kv.get<Meta>(META_KEY, "json")) ?? {};
}

export async function saveMeta(kv: KVNamespace, meta: Meta): Promise<void> {
  await kv.put(META_KEY, JSON.stringify(meta));
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
