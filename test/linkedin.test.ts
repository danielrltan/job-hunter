import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SOURCES } from "../src/config";
import { filterJobs } from "../src/filter";
import { runOnce } from "../src/index";
import {
  LINKEDIN_SOURCE,
  LinkedInBlocked,
  pacing,
  parseLinkedInCards,
  pollLinkedIn,
  searchUrl,
} from "../src/linkedin";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
/** Captured 2026-10-12: "software engineer intern 2027", United States, last 24h, internships. */
const SEARCH = fixture("linkedin-search.html");
/** What a rate-limited request gets instead: a whole page with a redirect script. */
const WALL = fixture("linkedin-429.html");

pacing.gapMs = 0;
afterEach(() => vi.unstubAllGlobals());

describe("parseLinkedInCards", () => {
  const jobs = parseLinkedInCards(SEARCH);

  it("reads every card on the page", () => {
    expect(jobs).toHaveLength(10);
    expect(jobs[0]).toMatchObject({
      sourceId: "linkedin",
      company: "Innovative Defense Technologies (IDT)",
      title: "Software Engineer Intern",
      url: "https://www.linkedin.com/jobs/view/4478589104/",
      locations: ["Mount Laurel, NJ"],
    });
    expect(jobs[0]!.datePosted).toBe(Date.parse("2026-10-12T00:00:00Z") / 1000);
  });

  it("finds the Summer 2027 postings the filter should keep", () => {
    const titles = filterJobs(jobs, LINKEDIN_SOURCE).matched.map((j) => `${j.company}: ${j.title}`);
    expect(titles).toContain("Google: Forward Deployed Engineering Intern, BS/MS, Summer 2027");
    expect(titles).toContain("Raytheon: Software Engineering Intern (Summer 2027)");
    // Spring 2027 isn't a target term.
    expect(titles.some((t) => t.startsWith("Amtrak"))).toBe(false);
  });

  it("treats an empty fragment as no results", () => {
    expect(parseLinkedInCards("")).toEqual([]);
  });

  it("refuses a wall rather than reading it as no results", () => {
    expect(() => parseLinkedInCards(WALL)).toThrow(LinkedInBlocked);
  });

  it("refuses cards it can no longer read", () => {
    expect(() => parseLinkedInCards('<li><div data-entity-urn="urn:li:jobPosting:1">?</div></li>')).toThrow(
      LinkedInBlocked,
    );
  });
});

describe("searchUrl", () => {
  it("asks for recent postings, newest first", () => {
    const url = new URL(searchUrl({ keywords: "software intern", location: "Canada" }, 10));
    expect(url.pathname).toBe("/jobs-guest/jobs/api/seeMoreJobPostings/search");
    expect(url.searchParams.get("keywords")).toBe("software intern");
    expect(url.searchParams.get("f_TPR")).toMatch(/^r\d+$/);
    expect(url.searchParams.get("start")).toBe("10");
  });
});

describe("pollLinkedIn", () => {
  it("pages until a short page and keeps other searches when one is refused", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      calls.push(url);
      if (url.includes("location=Canada")) return Promise.resolve(new Response(WALL, { status: 429 }));
      const start = new URL(url).searchParams.get("start");
      return Promise.resolve(new Response(start === "0" ? SEARCH : ""));
    });

    const { jobs, errors } = await pollLinkedIn(
      [
        { keywords: "software engineer intern", location: "United States" },
        { keywords: "software intern", location: "Canada" },
      ],
    );

    expect(jobs).toHaveLength(10);
    expect(calls).toHaveLength(3);
    expect(errors).toEqual(["software intern @ Canada: HTTP 429"]);
  });
});

/* ------------------------------------------------------------------ */

function memoryKV(initial: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  const kv = {
    async get(key: string, type?: string) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  } as unknown as KVNamespace;
  return { kv, read: (key: string) => JSON.parse(store.get(key) ?? "null") };
}

const base = Object.fromEntries(SOURCES.map((s) => [s.id, "base"]));
const envWith = (kv: KVNamespace) =>
  ({ STATE: kv, GITHUB_TOKEN: "gh", TELEGRAM_BOT_TOKEN: "bot", TELEGRAM_CHAT_ID: "1", ADMIN_KEY: "k" }) as Env;

/** GitHub idle, LinkedIn answering with `linkedin`, Telegram recording what it was sent. */
function mockWorld(linkedin: (url: string) => Response) {
  const telegram: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url.includes("api.github.com")) return Response.json({ status: "identical", commits: [], files: [] });
    if (url.includes("api.telegram.org")) {
      telegram.push(JSON.parse(String(init?.body)).text);
      return Response.json({ ok: true, result: {} });
    }
    return linkedin(url);
  });
  return telegram;
}

const usOnly = (url: string) =>
  new Response(url.includes("start=0") && url.includes("United+States") && url.includes("software+engineer") ? SEARCH : "");

describe("runOnce with LinkedIn", () => {
  it("primes dedupe on the first poll instead of announcing the backlog", async () => {
    const now = Math.floor(Date.now() / 1000);
    const store = memoryKV({
      "state:tick:v1": { shas: base, meta: { lastHeartbeatTs: now, lastNotifyTs: now }, activity: { sent: [], rejected: [], rejectCounts: {} } },
    });
    const telegram = mockWorld(usOnly);

    const report = await runOnce(envWith(store.kv), { linkedin: true });

    expect(report.linkedin).toBe(10);
    expect(report.notified).toBe(0);
    expect(telegram).toEqual([]);
    expect(Object.keys(store.read("state:seen:v1")).length).toBeGreaterThan(0);
    expect(store.read("state:tick:v1").meta.linkedinOkTs).toBeGreaterThan(0);

    // Later polls announce only what's new.
    const again = await runOnce(envWith(store.kv), { linkedin: true });
    expect(again.notified).toBe(0);
  });

  it("announces new LinkedIn matches once it has answered before", async () => {
    const now = Math.floor(Date.now() / 1000);
    const store = memoryKV({
      "state:tick:v1": {
        shas: base,
        meta: { lastHeartbeatTs: now, lastNotifyTs: now, linkedinOkTs: now - 7200 },
        activity: { sent: [], rejected: [], rejectCounts: {} },
      },
    });
    const telegram = mockWorld(usOnly);

    const report = await runOnce(envWith(store.kv), { linkedin: true });

    expect(report.notified).toBeGreaterThan(0);
    expect(telegram.join("\n")).toContain("Forward Deployed Engineering Intern");
  });

  it("warns once when LinkedIn has refused for too long", async () => {
    const now = Math.floor(Date.now() / 1000);
    const store = memoryKV({
      "state:tick:v1": {
        shas: base,
        meta: { lastHeartbeatTs: now, lastNotifyTs: now, linkedinOkTs: now - 13 * 3600 },
        activity: { sent: [], rejected: [], rejectCounts: {} },
      },
    });
    const telegram = mockWorld(() => new Response(WALL, { status: 429 }));

    await runOnce(envWith(store.kv), { linkedin: true });
    await runOnce(envWith(store.kv), { linkedin: true });

    expect(telegram).toHaveLength(1);
    expect(telegram[0]).toContain("LinkedIn isn't answering");
  });
});
