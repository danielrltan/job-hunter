import { describe, expect, it } from "vitest";

import { dedupeKey, evaluate, extractTerms } from "../src/filter";
import { prune } from "../src/state";
import { buildMessages } from "../src/telegram";
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
  locations: ["Toronto, ON, Canada"],
  ...over,
});

const accepted = (over: Partial<Job> = {}) => evaluate(job(over), src).ok;
const reason = (over: Partial<Job> = {}) => {
  const v = evaluate(job(over), src);
  return v.ok ? null : v.reason;
};

describe("role relevance", () => {
  it("accepts the target disciplines", () => {
    for (const title of [
      "Software Engineer Intern - Summer 2027",
      "Machine Learning Intern, Summer 2027",
      "Data Scientist Internship 2027",
      "Product Management Intern - Summer 2027",
      "Data Analyst Co-op (Summer 2027)",
      "AI Research Engineer Intern Summer 2027",
      "Full-Stack Developer Intern Summer 2027",
    ]) {
      expect(accepted({ title }), title).toBe(true);
    }
  });

  // Every one of these was silently dropped by the first version of the
  // keyword list, found by running scripts/preview.ts against live data.
  it("catches phrasings a naive keyword list misses", () => {
    for (const title of [
      "Software Development Engineer Intern - Summer 2027", // Amazon's standard title
      "Software Development Intern",
      "Software Intern - Summer 2027",
      "Software Integration Engineer Intern",
      "Engineering and Data Intern",
      "Forward Deployed Engineer Intern",
      "Member of Technical Staff Intern",
      "Performance Engineer Intern, Systems Software",
      "Infrastructure Intern",
      "Firmware Intern",
      "Technology Intern",
      "Application Development Intern",
      "Anthropic AI Security Fellowship",
      "Research Intern/Co-op",
      "Product Analyst Intern",
      "Multimodal Algorithm Researcher Intern",
    ]) {
      expect(accepted({ title }), title).toBe(true);
    }
  });

  it("does not let the broad data keyword pull in data entry work", () => {
    expect(reason({ title: "Data Entry Intern Summer 2027" })).toBe("unrelated discipline");
  });

  it("rejects other engineering disciplines outright", () => {
    expect(reason({ title: "Mechanical Engineer Intern Summer 2027" })).toBe(
      "unrelated discipline",
    );
    expect(reason({ title: "Electrical Engineering Intern Summer 2027" })).toBe(
      "unrelated discipline",
    );
  });

  it("rejects business functions that have no technical keyword", () => {
    expect(reason({ title: "Marketing Intern Summer 2027" })).toBe("non-technical function");
  });

  it("keeps technical roles that merely sit in a business org", () => {
    expect(accepted({ title: "Data Analyst Intern, Sales Operations - Summer 2027" })).toBe(true);
  });

  it("rejects new grad and full-time postings", () => {
    expect(reason({ title: "Software Engineer, New Grad 2027" })).toBe("not an internship");
  });
});

describe("term cutoff", () => {
  it("parses seasons and two-digit years", () => {
    expect(extractTerms(job({ title: "SWE Intern Summer '27" }))).toEqual([
      { season: "summer", year: 2027 },
    ]);
  });

  it("keeps Summer 2027, the only term being targeted", () => {
    expect(accepted({ title: "Software Engineer Intern - Summer 2027" })).toBe(true);
    expect(accepted({ title: "Software Engineer Intern - Summer '27" })).toBe(true);
    expect(accepted({ title: "Software Engineer Intern - 2027 Summer" })).toBe(true);
  });

  it("drops every other term, past or future", () => {
    expect(reason({ title: "Software Engineer Intern - Summer 2026" })).toBe(
      "wrong term (summer 2026)",
    );
    expect(reason({ title: "Software Developer Co-op - Winter 2027" })).toBe(
      "wrong term (winter 2027)",
    );
    expect(reason({ title: "Software Developer Co-op - Fall 2026" })).toBe(
      "wrong term (fall 2026)",
    );
    expect(reason({ title: "Software Engineer Intern - Summer 2028" })).toBe(
      "wrong term (summer 2028)",
    );
  });

  // Caught by scripts/smoke.ts: ByteDance writes the year first, which a
  // season-then-year pattern reads as "no term at all" and lets through.
  it("understands year-first phrasing", () => {
    expect(extractTerms(job({ title: "SWE Intern - 2026 Summer (BS/MS)" }))).toEqual([
      { season: "summer", year: 2026 },
    ]);
    expect(reason({ title: "Software Engineer Intern (Infra) - 2026 Summer (BS/MS)" })).toBe(
      "wrong term (summer 2026)",
    );
  });

  // The important escape hatch: most postings never name a season, and
  // requiring one would throw away the bulk of real opportunities.
  it("allows listings with no term at all", () => {
    expect(accepted({ title: "Software Engineer Intern" })).toBe(true);
    expect(accepted({ title: "Data Scientist Internship" })).toBe(true);
  });
});

describe("graduate and PhD roles", () => {
  it("rejects postgraduate-only postings", () => {
    expect(reason({ title: "PhD Research Intern - Summer 2027" })).toBe("graduate/PhD only");
    expect(reason({ title: "Ph.D. Software Engineering Intern" })).toBe("graduate/PhD only");
    expect(reason({ title: "MBA Product Management Intern" })).toBe("graduate/PhD only");
    expect(reason({ title: "Postdoctoral Research Intern" })).toBe("graduate/PhD only");
  });

  it("keeps postings that welcome undergrads alongside grad students", () => {
    expect(accepted({ title: "Software Engineer Intern (BS/MS/PhD) - Summer 2027" })).toBe(true);
    expect(accepted({ title: "ML Intern - Bachelor's or PhD - Summer 2027" })).toBe(true);
  });
});

describe("work authorization (Canada-based, needs sponsorship)", () => {
  it("drops listings the structured feeds mark as closed", () => {
    expect(reason({ sponsorship: "U.S. Citizenship is Required" })).toMatch(/^sponsorship:/);
    expect(reason({ sponsorship: "Does Not Offer Sponsorship" })).toMatch(/^sponsorship:/);
  });

  it("keeps sponsoring and unknown listings", () => {
    expect(accepted({ sponsorship: "Offers Sponsorship" })).toBe(true);
    expect(accepted({ sponsorship: "Other" })).toBe(true);
  });

  it("catches citizenship and clearance wording in free text", () => {
    expect(reason({ title: "Software Engineer Intern (U.S. Citizens Only) Summer 2027" })).toBe(
      "requires citizenship/clearance",
    );
    expect(
      reason({ title: "Software Engineer Intern - Active Security Clearance Summer 2027" }),
    ).toBe("requires citizenship/clearance");
  });
});

describe("location", () => {
  it("keeps US, Canadian and remote roles", () => {
    for (const loc of ["Palo Alto, CA, US", "Toronto, ON", "Remote", "Waterloo, Canada"]) {
      expect(accepted({ locations: [loc] }), loc).toBe(true);
    }
  });

  it("drops roles outside North America", () => {
    expect(reason({ locations: ["Bengaluru, India"] })).toMatch(/^location:/);
    expect(reason({ locations: ["London, United Kingdom"] })).toMatch(/^location:/);
  });

  it("keeps a multi-site role if any site is reachable", () => {
    expect(accepted({ locations: ["Bengaluru, India", "Toronto, ON"] })).toBe(true);
  });
});

describe("dedupe", () => {
  it("collapses the same posting phrased differently across repos", () => {
    const a = job({ company: "Rivian", title: "Software Engineering Intern - Summer 2027" });
    const b = job({ company: "Rivian", title: "Software Engineering Internship (Summer 2027)" });
    expect(dedupeKey(a)).toBe(dedupeKey(b));
  });

  it("keeps genuinely different roles apart", () => {
    const a = job({ company: "Rivian", title: "Software Engineering Intern" });
    const b = job({ company: "Rivian", title: "Data Science Intern" });
    expect(dedupeKey(a)).not.toBe(dedupeKey(b));
  });
});

describe("seen-state pruning", () => {
  it("expires entries past the TTL", () => {
    const now = 1_800_000_000;
    const pruned = prune({ fresh: now - 86400, stale: now - 200 * 86400 }, now);
    expect(Object.keys(pruned)).toEqual(["fresh"]);
  });
});

describe("telegram batching", () => {
  it("splits long runs into multiple messages under the length limit", () => {
    const jobs = Array.from({ length: 25 }, (_, i) => job({ title: `SWE Intern ${i}` }));
    const messages = buildMessages(jobs);
    expect(messages.length).toBeGreaterThan(1);
    for (const m of messages) expect(m.length).toBeLessThan(4096);
    expect(messages[0]).toContain("25 new internships");
  });

  it("escapes HTML so a stray angle bracket cannot break parse_mode", () => {
    const [message] = buildMessages([job({ company: "A<b>Z & Co" })]);
    expect(message).toContain("A&lt;b&gt;Z &amp; Co");
  });
});
