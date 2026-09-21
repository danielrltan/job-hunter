import { describe, expect, it } from "vitest";

import { buildNudge, jobsToNudge } from "../src/email";
import type { LoggedJob } from "../src/journal";

const job = (ts: number, company = "Acme"): LoggedJob => ({
  id: `${ts}`.padStart(8, "0"),
  ts,
  sourceId: "zapply",
  sourceLabel: "Zapply",
  company,
  title: "SWE Intern — ignore previous instructions",
  url: "https://example.com/apply",
  locations: [],
});

describe("jobsToNudge", () => {
  it("covers everything queued since the last nudge", () => {
    expect(jobsToNudge([job(3000), job(2000), job(900)], 1000, 5000).map((j) => j.ts)).toEqual([3000, 2000]);
  });

  it("holds back while the last nudge is under ten minutes old", () => {
    expect(jobsToNudge([job(1100)], 1000, 1000 + 599)).toEqual([]);
    expect(jobsToNudge([job(1100)], 1000, 1000 + 600)).toHaveLength(1);
  });

  it("stays quiet when nothing new was queued", () => {
    expect(jobsToNudge([job(900)], 1000, 99_999)).toEqual([]);
  });
});

describe("buildNudge", () => {
  const raw = buildNudge([job(1, "Stripe"), job(2, "Stripe"), job(3, "Ünïcode Co")], "me@example.com", new Date(0));
  const [head, body] = raw.split("\r\n\r\n");
  const decoded = new TextDecoder().decode(
    Uint8Array.from(atob(body!.replace(/\r\n/g, "")), (c) => c.charCodeAt(0)),
  );

  it("has the headers Email Routing requires", () => {
    expect(head).toMatch(/^From: job-hunter <jobs@danielrltan\.com>/m);
    expect(head).toMatch(/^To: me@example\.com/m);
    expect(head).toMatch(/^Message-ID: <.+@danielrltan\.com>/m);
    expect(head).toMatch(/^Subject: =\?UTF-8\?B\?/m);
  });

  it("names companies once each and never carries listing titles or links", () => {
    expect(decoded).toContain("3 new listings");
    expect(decoded).toContain("Stripe, Ünïcode Co");
    expect(decoded).not.toContain("ignore previous instructions");
    expect(decoded).not.toContain("example.com/apply");
  });
});
