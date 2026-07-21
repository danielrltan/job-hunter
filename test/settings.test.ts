import { describe, expect, it } from "vitest";

import { evaluate } from "../src/filter";
import { buildSettings, defaultSettings, formatTerms, parseTerms, phraseToRegExp } from "../src/settings";
import type { Job, Source } from "../src/types";

const src: Source = {
  id: "t",
  label: "Test",
  owner: "o",
  repo: "r",
  branch: "main",
  paths: [],
  parser: "jobright",
};

const job = (over: Partial<Job> = {}): Job => ({
  sourceId: "t",
  sourceLabel: "Test",
  company: "Acme",
  title: "Software Engineer Intern - Summer 2027",
  url: "https://example.com/job",
  locations: ["Toronto, ON"],
  ...over,
});

describe("user phrases are literals, not regexes", () => {
  it("escapes regex metacharacters so they match themselves", () => {
    expect(phraseToRegExp("c++").test("C++ Developer Intern")).toBe(true);
    expect(phraseToRegExp("node.js").test("Node.js Intern")).toBe(true);
    // Would match everything if treated as a regex.
    expect(phraseToRegExp(".*").test("Software Engineer Intern")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(phraseToRegExp("Robotics").test("robotics intern")).toBe(true);
  });
});

describe("overrides change filtering", () => {
  it("/include widens what counts as relevant", () => {
    const title = "Bioinformatics Pipeline Intern - Summer 2027";
    expect(evaluate(job({ title }), src, defaultSettings()).ok).toBe(false);
    expect(evaluate(job({ title }), src, buildSettings({ include: ["bioinformatics"] })).ok).toBe(
      true,
    );
  });

  it("/exclude overrides an otherwise matching role", () => {
    const title = "Software Engineer Intern, Quantum Computing - Summer 2027";
    expect(evaluate(job({ title }), src, defaultSettings()).ok).toBe(true);

    const verdict = evaluate(job({ title }), src, buildSettings({ exclude: ["quantum"] }));
    expect(verdict).toEqual({ ok: false, reason: "unrelated discipline" });
  });

  it("/term any disables term filtering", () => {
    const title = "Software Engineer Intern - Winter 2028";
    expect(evaluate(job({ title }), src, defaultSettings()).ok).toBe(false);
    expect(evaluate(job({ title }), src, buildSettings({ terms: "any" })).ok).toBe(true);
  });

  it("/term accepts a custom set", () => {
    const settings = buildSettings({ terms: [{ season: "winter", year: 2028 }] });
    expect(evaluate(job({ title: "SWE Intern - Winter 2028" }), src, settings).ok).toBe(true);
    expect(evaluate(job({ title: "SWE Intern - Summer 2027" }), src, settings).ok).toBe(false);
  });
});

describe("parseTerms", () => {
  it("reads seasons, years and lists", () => {
    expect(parseTerms("summer 2027")).toEqual([{ season: "summer", year: 2027 }]);
    expect(parseTerms("Summer '27")).toEqual([{ season: "summer", year: 2027 }]);
    expect(parseTerms("summer 2027, winter 2028")).toEqual([
      { season: "summer", year: 2027 },
      { season: "winter", year: 2028 },
    ]);
    expect(parseTerms("any")).toBe("any");
  });

  it("rejects nonsense rather than silently accepting it", () => {
    expect(parseTerms("banana 2027")).toBeNull();
    expect(parseTerms("summer")).toBeNull();
    expect(parseTerms("")).toBeNull();
  });

  it("round-trips through formatTerms", () => {
    expect(formatTerms(parseTerms("summer 2027") as never)).toBe("summer 2027");
    expect(formatTerms("any")).toBe("any term");
  });
});
