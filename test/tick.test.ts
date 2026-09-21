import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SOURCES } from "../src/config";
import { runOnce } from "../src/index";

/** KV that counts writes, since the free tier's 1,000 writes/day is the binding limit. */
function countingKV(initial: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  const writes: string[] = [];
  const kv = {
    async get(key: string, type?: string) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) {
      writes.push(key);
      store.set(key, value);
    },
  } as unknown as KVNamespace;
  return { kv, writes, read: (key: string) => JSON.parse(store.get(key) ?? "null") };
}

const base = Object.fromEntries(SOURCES.map((s) => [s.id, "base"]));
const meta = { lastHeartbeatTs: Math.floor(Date.now() / 1000), lastNotifyTs: 1 };

/** GitHub compare, answering every source with the given new commits and no watched-file changes. */
function mockGitHub(newCommits: string[]) {
  vi.stubGlobal("fetch", () =>
    Promise.resolve(Response.json({ status: "ahead", commits: newCommits.map((sha) => ({ sha })), files: [] })),
  );
}

let env: Env;
const envWith = (kv: KVNamespace) =>
  ({ STATE: kv, GITHUB_TOKEN: "gh", TELEGRAM_BOT_TOKEN: "bot", TELEGRAM_CHAT_ID: "1", ADMIN_KEY: "k" }) as Env;

afterEach(() => vi.unstubAllGlobals());

describe("KV writes per tick", () => {
  let store: ReturnType<typeof countingKV>;

  beforeEach(() => {
    store = countingKV({ "state:tick:v1": { shas: base, meta, activity: { sent: [], rejected: [], rejectCounts: {} } } });
    env = envWith(store.kv);
  });

  it("makes none on an idle tick", async () => {
    mockGitHub([]);
    await runOnce(env);
    expect(store.writes).toEqual([]);
  });

  it("makes exactly one when sources moved", async () => {
    mockGitHub(["new"]);
    await runOnce(env);
    expect(store.writes).toEqual(["state:tick:v1"]);
    expect(store.read("state:tick:v1").shas.simplify).toBe("new");
  });
});

describe("switching from the separate keys", () => {
  it("picks up the old shas and heartbeat clock instead of re-bootstrapping", async () => {
    const store = countingKV({ "state:sources:v1": base, "state:meta:v1": meta });
    mockGitHub(["new"]);

    const report = await runOnce(envWith(store.kv));

    expect(report.bootstrapped).toEqual([]);
    expect(store.writes).toEqual(["state:tick:v1"]);
    expect(store.read("state:tick:v1").meta).toEqual(meta);
  });
});
