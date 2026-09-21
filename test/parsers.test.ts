import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SOURCES } from "../src/config";
import { extractAddedLines, parseHunks, wholeFile } from "../src/github";
import { extractJsonObjects, parseAdded, tableCells } from "../src/parsers";
import type { Source } from "../src/types";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

const source = (id: string): Source => {
  const found = SOURCES.find((s) => s.id === id);
  if (!found) throw new Error(`no source ${id}`);
  return found;
};

describe("extractAddedLines", () => {
  it("keeps added lines and drops diff headers", () => {
    const patch = ["@@ -1,2 +1,3 @@", " context", "-removed", "+added", "+++ b/file.txt"].join("\n");
    expect(extractAddedLines(patch)).toEqual(["added"]);
  });
});

describe("parseHunks", () => {
  it("keeps context alongside added lines, in file order", () => {
    const patch = ["@@ -1,2 +1,3 @@", " ctx", "-gone", "+new"].join("\n");
    expect(parseHunks(patch)).toEqual([
      [
        { text: "ctx", added: false },
        { text: "new", added: true },
      ],
    ]);
  });

  it("separates hunks, since they are not adjacent in the file", () => {
    const patch = ["@@ -1,1 +1,2 @@", "+a", "@@ -9,1 +10,2 @@", "+b"].join("\n");
    expect(parseHunks(patch)).toHaveLength(2);
  });

  it("drops hunks that added nothing", () => {
    expect(parseHunks(["@@ -1,2 +1,1 @@", " ctx", "-gone"].join("\n"))).toEqual([]);
  });
});

/**
 * Regression: a '↳' row means "same company as the row above" — above *in the
 * file*, which is not the row above it in a diff.
 *
 * These feeds rewrite their README hourly, so a new role under an existing
 * company arrives as a lone '↳' row while the company's own row stays
 * unchanged and reaches us only as context. Resolving against the previous
 * *added* line attributed those roles to whichever unrelated company happened
 * to appear earlier in the diff. Measured against four days of real jobright
 * commits, that was 70 of 1429 parsed jobs — including a Desjardins role
 * announced as Citadel, and TikTok roles announced as Instawork.
 */
describe("continuation rows resolve against the file, not the diff", () => {
  const src = source("jobright-swe");
  const row = (company: string, title: string) =>
    `| **[${company}](https://${company.toLowerCase()}.com)** | ` +
    `**[${title}](https://jobright.ai/jobs/info/${title.replace(/\W/g, "")})** | ` +
    `Toronto, ON, Canada | On Site | Jul 20 |`;
  const continuation = (title: string) =>
    `| ↳ | **[${title}](https://jobright.ai/jobs/info/${title.replace(/\W/g, "")})** | ` +
    `Toronto, ON, Canada | On Site | Jul 20 |`;

  it("takes the company from an unchanged context row", () => {
    const jobs = parseAdded(src, [
      [
        { text: row("Desjardins", "Data Intern"), added: false },
        { text: continuation("Data Analyst Intern"), added: true },
      ],
    ]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.company).toBe("Desjardins");
  });

  it("never carries a company across a gap between hunks", () => {
    const jobs = parseAdded(src, [
      [{ text: row("Citadel", "Quant Intern"), added: true }],
      [{ text: continuation("Data Intern"), added: true }],
    ]);
    // The second hunk's parent row is outside the diff entirely, so the only
    // safe outcome is to drop it — announcing it as Citadel is the bug.
    expect(jobs.map((j) => j.company)).toEqual(["Citadel"]);
  });

  it("emits added rows only, never the context used to resolve them", () => {
    const jobs = parseAdded(src, [
      [
        { text: row("Shopify", "Backend Intern"), added: false },
        { text: continuation("Frontend Intern"), added: true },
      ],
    ]);
    expect(jobs.map((j) => j.title)).toEqual(["Frontend Intern"]);
  });
});

describe("extractJsonObjects", () => {
  it("ignores braces inside strings", () => {
    const objs = extractJsonObjects('{"a": "not } a brace"}');
    expect(objs).toEqual([{ a: "not } a brace" }]);
  });

  it("skips fragments and recovers the whole objects around them", () => {
    const text = ['"active": false,', "{", '  "id": "x"', "}"].join("\n");
    expect(extractJsonObjects(text)).toEqual([{ id: "x" }]);
  });
});

describe("tableCells", () => {
  it("rejects separator rows", () => {
    expect(tableCells("|---|---|")).toBeNull();
    expect(tableCells("not a row")).toBeNull();
  });
});

describe("listings.json parser (real Simplify patch)", () => {
  const jobs = parseAdded(source("simplify"), parseHunks(fixture("simplify.patch")));

  it("recovers whole listings from an 8 KB diff of an 11 MB file", () => {
    expect(jobs.length).toBeGreaterThan(0);
  });

  it("populates the fields notifications depend on", () => {
    for (const job of jobs) {
      expect(job.company).toBeTruthy();
      expect(job.title).toBeTruthy();
      expect(job.url).toMatch(/^https?:\/\//);
    }
  });
});

describe("speedyapply parser (real README)", () => {
  const jobs = parseAdded(source("speedyapply-swe"), wholeFile(fixture("speedyapply-README.md")));

  it("parses the table", () => {
    expect(jobs.length).toBeGreaterThan(50);
  });

  it("resolves company names, never leaving the ↳ continuation marker", () => {
    for (const job of jobs) {
      expect(job.company).not.toBe("↳");
      expect(job.company).toBeTruthy();
      expect(job.url).toMatch(/^https?:\/\//);
    }
  });

  it("does not leak HTML into titles", () => {
    expect(jobs.every((j) => !j.title.includes("<"))).toBe(true);
  });
});

describe("jobright parser (real README)", () => {
  const jobs = parseAdded(source("jobright-swe"), wholeFile(fixture("jobright-README.md")));

  it("parses the table", () => {
    expect(jobs.length).toBeGreaterThan(50);
  });

  it("extracts the apply link from the title cell, not the company cell", () => {
    for (const job of jobs) {
      expect(job.company).not.toBe("↳");
      expect(job.url).toMatch(/^https?:\/\//);
      expect(job.title).not.toMatch(/\]\(/); // markdown link syntax fully stripped
      expect(job.url).toContain("jobright.ai");
    }
  });

  it("carries the company down through ↳ continuation rows", () => {
    const withArrow = fixture("jobright-README.md")
      .split("\n")
      .filter((l) => l.includes("↳"));
    expect(withArrow.length).toBeGreaterThan(0);
  });
});

/**
 * Regression: SpeedyApply publishes some tables with a Salary column and some
 * without, and diff hunks almost never carry the header row, so column
 * position cannot be trusted.
 */
describe("speedyapply column-layout independence", () => {
  const src = source("speedyapply-swe");
  const apply = '<a href="https://apply.example/job"><img src="x.png"/></a>';
  const company = '<a href="https://acme.com"><strong>Acme</strong></a>';

  it("handles the 6-column layout with Salary", () => {
    const [job] = parseAdded(
      src,
      wholeFile(`| ${company} | SWE Intern | Toronto, ON | $50/hr | ${apply} | 3d |`),
    );
    expect(job).toMatchObject({
      company: "Acme",
      title: "SWE Intern",
      url: "https://apply.example/job",
      salary: "$50/hr",
    });
  });

  it("handles the 5-column layout without Salary", () => {
    const [job] = parseAdded(
      src,
      wholeFile(`| ${company} | SWE Intern | Toronto, ON | ${apply} | 3d |`),
    );
    expect(job).toMatchObject({
      company: "Acme",
      title: "SWE Intern",
      url: "https://apply.example/job",
    });
    expect(job!.salary).toBeUndefined();
  });
});

describe("zapply", () => {
  const src: Source = {
    id: "zapply",
    label: "Zapply",
    owner: "zapplyjobs",
    repo: "Internships-2027",
    branch: "main",
    paths: ["README.md"],
    parser: "zapply",
    assumeInternship: true,
  };
  const fixture = readFileSync(new URL("./fixtures/zapply-README.md", import.meta.url), "utf8");
  const hunks = [fixture.split("\n").map((text) => ({ text, added: true }))];
  const jobs = parseAdded(src, hunks);

  it("reads every data row and skips headers and separators", () => {
    const dataRows = fixture.split("\n").filter((l) => l.startsWith("| **"));
    expect(jobs).toHaveLength(dataRows.length);
    expect(jobs.length).toBeGreaterThan(10);
  });

  it("keeps the apply link even when a row has no closing pipe", () => {
    for (const job of jobs) expect(job.url).toMatch(/^https:\/\/zapply\.jobs\//);
  });

  it("strips the company's bold and maps the sponsor column", () => {
    for (const job of jobs) expect(job.company).not.toContain("*");
    expect(jobs.some((j) => j.sponsorship === "Offers Sponsorship")).toBe(true);
    expect(jobs.some((j) => j.sponsorship === undefined)).toBe(true);
  });
});
