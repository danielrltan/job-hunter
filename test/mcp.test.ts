import { timingSafeEqual } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { loadActivity, loadChanges, recordTick, saveActivity } from "../src/journal";
import { mcpToken } from "../src/mcp";
import { loadOverrides } from "../src/settings";
import type { Job } from "../src/types";

/** Just enough of KVNamespace for the Worker's json get/put. */
function memoryKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key: string, type?: string) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  } as unknown as KVNamespace;
}

// Workers-only extension to SubtleCrypto; Node keeps it on node:crypto.
(crypto.subtle as unknown as Record<string, unknown>).timingSafeEqual ??= (
  a: Uint8Array,
  b: Uint8Array,
) => timingSafeEqual(a, b);

const job = (over: Partial<Job> = {}): Job => ({
  sourceId: "jobright-swe",
  sourceLabel: "Jobright SWE",
  company: "Acme",
  title: "Software Engineer Intern",
  url: "https://example.com/job",
  locations: ["Toronto, ON"],
  ...over,
});

let env: Env;
let telegram: Array<{ method: string; body: Record<string, unknown> }>;

beforeEach(() => {
  env = {
    STATE: memoryKV(),
    GITHUB_TOKEN: "gh",
    TELEGRAM_BOT_TOKEN: "bot",
    TELEGRAM_CHAT_ID: "42",
    ADMIN_KEY: "admin",
  } as Env;
  telegram = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    telegram.push({ method: url.split("/").pop()!, body: JSON.parse(String(init.body)) });
    return Promise.resolve(new Response('{"ok":true}'));
  });
});

afterEach(() => vi.unstubAllGlobals());

const ctx = {} as ExecutionContext;

async function rpc(body: unknown, token?: string) {
  const res = await worker.fetch(
    new Request("https://w.dev/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token ?? (await mcpToken(env))}`,
      },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  return { status: res.status, body: res.status === 202 ? null : ((await res.json()) as any) };
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const { body } = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return body.result as { isError?: boolean; structuredContent?: any; content: Array<{ text: string }> };
}

/** Seed the activity log as if a tick had sent `sent` and dropped `dropped`. */
async function seed(sent: Job[], dropped: Array<[Job, string]>) {
  const activity = recordTick(
    await loadActivity(env.STATE),
    sent,
    dropped.map(([j, reason]) => ({ job: j, reason })),
    1_800_000_000,
  );
  await saveActivity(env.STATE, activity);
}

describe("MCP transport", () => {
  it("rejects a missing or wrong bearer token", async () => {
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, "nope")).status).toBe(401);
  });

  it("completes the initialize handshake and lists tools", async () => {
    const init = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    });
    expect(init.body.result.protocolVersion).toBe("2025-06-18");
    expect(init.body.result.capabilities.tools).toBeDefined();

    const note = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(note.status).toBe(202);

    const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = list.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["recent_jobs", "recent_rejections", "preview_filters", "add_exclude"]));
  });

  it("falls back to its newest version when the client asks for an unknown one", async () => {
    const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    expect(init.body.result.protocolVersion).toBe("2025-06-18");
  });

  it("returns tool failures as results the model can read", async () => {
    const result = await call("add_include", { phrase: "robotics" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("reason");
  });
});

describe("MCP tuning tools", () => {
  it("shows drops with their reasons", async () => {
    await seed([job()], [[job({ title: "Mechanical Engineering Intern" }), "unrelated discipline"]]);
    const result = await call("recent_rejections");
    expect(result.structuredContent.countsByReason).toEqual({ "unrelated discipline": 1 });
    expect(result.structuredContent.jobs[0].title).toBe("Mechanical Engineering Intern");
  });

  it("previews an edit without applying it", async () => {
    const dropped = job({ title: "Robotics Intern" });
    await seed([job()], [[dropped, "no matching role keyword"]]);

    const result = await call("preview_filters", { add_include: ["robotics"] });
    expect(result.structuredContent.newlyMatched.map((j: Job) => j.title)).toEqual(["Robotics Intern"]);
    expect(await loadOverrides(env.STATE)).toEqual({});
  });

  it("applies an edit, logs it, and announces it in Telegram", async () => {
    const result = await call("add_include", { phrase: "robotics", reason: "owner liked two robotics roles" });
    expect(result.isError).toBeUndefined();
    expect((await loadOverrides(env.STATE)).include).toEqual(["robotics"]);
    expect((await loadChanges(env.STATE))[0]).toMatchObject({ by: "muse", action: "include", detail: "robotics" });

    const notice = telegram.find((t) => t.method === "sendMessage")!;
    expect(notice.body.text).toContain("Muse");
    expect(notice.body.text).toContain("robotics");
  });

  it("previews what an exclude would newly drop", async () => {
    await seed([job({ title: "Quantum Software Intern" }), job()], []);
    const result = await call("preview_filters", { add_exclude: ["quantum"] });
    expect(result.structuredContent.newlyDropped.map((j: Job) => j.title)).toEqual(["Quantum Software Intern"]);
  });

  it("reports a failed Telegram notice instead of hiding the applied edit", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("busy", { status: 429 })));
    const result = await call("add_include", { phrase: "robotics", reason: "r" });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ changed: true, announced: false });
    expect(result.structuredContent.warning).toContain("Tell the owner");
    expect((await loadOverrides(env.STATE)).include).toEqual(["robotics"]);
  });

  it("does not announce a no-op", async () => {
    await call("add_include", { phrase: "robotics", reason: "r" });
    telegram = [];
    const again = await call("add_include", { phrase: "Robotics", reason: "r" });
    expect(again.structuredContent.changed).toBe(false);
    expect(telegram).toHaveLength(0);
  });
});
