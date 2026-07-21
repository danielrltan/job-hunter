import { describe, expect, it } from "vitest";

import { companyKeys, companyRank, matchTiers } from "../src/companies";
import { buildMessages } from "../src/telegram";
import type { Job } from "../src/types";

const ids = (company: string) => matchTiers(company).map((t) => t.id);

const job = (company: string, title = "Software Engineer Intern"): Job => ({
  sourceId: "t",
  sourceLabel: "Test",
  company,
  title,
  url: "https://example.com/job",
  locations: ["Toronto, ON"],
});

describe("company tiers", () => {
  it("tags the obvious ones", () => {
    expect(ids("Google")).toEqual(["big-tech"]);
    expect(ids("NVIDIA")).toEqual(["big-tech"]);
    expect(ids("Anthropic")).toEqual(["big-tech"]);
    expect(ids("Stripe")).toEqual(["top-tech"]);
    expect(ids("Jane Street")).toEqual(["quant"]);
    expect(ids("Wealthsimple")).toEqual(["canada"]);
  });

  it("reports every tier a company belongs to", () => {
    expect(ids("Shopify")).toEqual(["top-tech", "canada"]);
    expect(ids("Cohere")).toEqual(["top-tech", "canada"]);
    expect(ids("Wealthsimple")).toEqual(["canada"]);
  });

  it("ignores legal suffixes and punctuation", () => {
    expect(ids("NVIDIA Corporation")).toEqual(["big-tech"]);
    expect(ids("Stripe, Inc.")).toEqual(["top-tech"]);
    expect(ids("Databricks Inc")).toEqual(["top-tech"]);
  });

  it("matches on leading words, so joint ventures still resolve", () => {
    expect(ids("Rivian and Volkswagen Group Technologies")).toEqual(["top-tech"]);
    expect(ids("Citadel Securities")).toEqual(["quant"]);
  });

  // The failure mode a naive substring match would produce.
  it("does not tag companies that merely start with the same letters", () => {
    expect(ids("Snapdocs")).toEqual([]);
    expect(ids("Applebee's")).toEqual([]);
    expect(ids("Metabase")).toEqual([]);
    expect(ids("Amazonia Labs")).toEqual([]);
  });

  /**
   * Regression: sharing a first word does not make two businesses related.
   * Every name here was pulled from the live feeds while wearing the wrong
   * marker — Meta Downhole is an oilfield services company that jobright
   * publishes simply as "Meta".
   */
  it("does not tag a different business that leads with a known brand", () => {
    expect(ids("Meta Downhole")).toEqual([]);
    expect(ids("Snap Finance")).toEqual([]);
    expect(ids("Snap-on")).toEqual([]);
    expect(ids("Cohere Health")).toEqual([]);
    expect(ids("Sierra Nevada Corporation")).toEqual([]);
    expect(ids("Sierra Space")).toEqual([]);
    expect(ids("SAP Fioneer")).toEqual([]);
    expect(ids("Bloomberg Philanthropies")).toEqual([]);
    expect(ids("Lightspeed Systems")).toEqual([]);
  });

  it("still tags real subsidiaries and corporate-suffixed names", () => {
    expect(ids("Meta Platforms")).toEqual(["big-tech"]);
    expect(ids("Amazon Web Services (AWS)")).toEqual(["big-tech"]);
    expect(ids("Palantir Technologies")).toEqual(["top-tech"]);
    expect(ids("Virtu Financial")).toEqual(["quant"]);
    expect(ids("Tower Research Capital")).toEqual(["quant"]);
    expect(ids("AQR Capital Management")).toEqual(["quant"]);
    expect(ids("Susquehanna International Group (SIG)")).toEqual(["quant"]);
    expect(ids("Mistral AI")).toEqual(["top-tech"]);
    expect(ids("Lightspeed Commerce")).toEqual(["canada"]);
  });

  it("leaves unknown companies untagged", () => {
    expect(ids("Some Startup")).toEqual([]);
    expect(companyRank("Some Startup")).toBeGreaterThan(companyRank("Google"));
  });

  it("builds sensible lookup keys", () => {
    expect(companyKeys("Jane Street Capital")).toContain("janestreet");
    expect(companyKeys("Google")).toContain("google");
  });
});

describe("notification formatting", () => {
  it("uppercases and marks top-tier companies", () => {
    const [message] = buildMessages([job("Google")]);
    expect(message).toContain("⭐ <b>GOOGLE</b>");
    expect(message).toContain("Big Tech");
  });

  it("marks lower tiers without shouting", () => {
    const [message] = buildMessages([job("Stripe")]);
    expect(message).toContain("🔥 <b>Stripe</b>");
    expect(message).not.toContain("STRIPE");
  });

  it("shows both markers for a multi-tier company", () => {
    const [message] = buildMessages([job("Shopify")]);
    expect(message).toContain("🔥🍁 <b>Shopify</b>");
    expect(message).toContain("Top Tech · Canadian");
  });

  it("leaves unknown companies on the plain format", () => {
    const [message] = buildMessages([job("Some Startup")]);
    expect(message).toContain("🎯 <b>Some Startup</b>");
  });

  it("sorts notable companies to the top of a batch", () => {
    const [message] = buildMessages([
      job("Some Startup"),
      job("Jane Street"),
      job("Google"),
      job("Stripe"),
    ]);
    const order = ["GOOGLE", "Stripe", "Jane Street", "Some Startup"].map((n) =>
      message!.indexOf(n),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("still escapes HTML in company names", () => {
    const [message] = buildMessages([job("A<b> & Co")]);
    expect(message).toContain("A&lt;b&gt; &amp; Co");
  });

  /**
   * Telegram offers no cards or colours — a blockquote's vertical rule is the
   * only way to show where one listing ends and the next begins.
   */
  it("wraps each listing in its own blockquote", () => {
    const [message] = buildMessages([job("Google"), job("Stripe")]);
    expect(message!.match(/<blockquote>/g)).toHaveLength(2);
    expect(message!.match(/<\/blockquote>/g)).toHaveLength(2);
  });

  it("never nests blockquotes, which Telegram rejects", () => {
    const [message] = buildMessages([job("Google"), job("Stripe"), job("Shopify")]);
    expect(message).not.toMatch(/<blockquote>(?:(?!<\/blockquote>)[\s\S])*<blockquote>/);
  });

  it("bolds the role, so it reads before the company", () => {
    const [message] = buildMessages([job("Google", "ML Engineer Intern")]);
    expect(message).toContain("<b>ML Engineer Intern</b></a>");
  });

  it("heads the batch without an emoji", () => {
    const [one] = buildMessages([job("Google")]);
    const [many] = buildMessages([job("Google"), job("Stripe")]);
    expect(one).toMatch(/^<b>New internship<\/b>/);
    expect(many).toMatch(/^<b>2 new internships<\/b>/);
    expect(many).not.toContain("🆕");
  });
});
