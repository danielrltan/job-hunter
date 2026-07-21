import { COMPANY_TIERS, type CompanyTier } from "./config";

/**
 * Words that describe corporate structure rather than identity, so a name
 * ending in them still refers to the same company: "Palantir Technologies" is
 * Palantir, "Virtu Financial" is Virtu, "AQR Capital Management" is AQR.
 *
 * Deliberately narrow. A word only belongs here if appending it to a brand
 * cannot produce a *different* business — which is why finance, health, space
 * and industry are absent. Snap Finance, Cohere Health, Sierra Space and
 * Bloomberg Industry Group are unrelated to the brands they lead with.
 */
const QUALIFIERS = new Set(
  ("inc llc ltd limited corp corporation company co plc gmbh ag sa nv holdings group " +
    "international technologies technology labs laboratories systems solutions services " +
    "usa us na global capital trading research financial digital investment management " +
    "fund partners ventures securities platforms university ai")
    .split(" "),
);

function normalize(text: string): string {
  return text
    .toLowerCase()
    // Parenthetical suffixes carry a ticker or short form in these feeds —
    // "Susquehanna International Group (SIG)", "Amazon Web Services (AWS)".
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Keys a company could be known by: its full name, plus any leading portion
 * whose trailing words are all corporate qualifiers.
 *
 * The trailing-words rule is the whole point. Plain prefix matching — "does
 * this name start with a known brand?" — tags Snap-on as Snap, Cohere Health
 * as Cohere and Meta Downhole as Meta, because a shared first word says
 * nothing about whether two businesses are related. Requiring the remainder to
 * be structural ("Securities", "Technologies", "Capital") keeps the genuine
 * subsidiaries without inventing relationships that don't exist.
 */
export function companyKeys(company: string): string[] {
  const keys = new Set<string>();

  const add = (words: string[]) => {
    for (let n = words.length; n >= 1; n--) {
      if (words.slice(n).every((w) => QUALIFIERS.has(w))) keys.add(words.slice(0, n).join(""));
    }
  };

  const words = normalize(company).split(" ").filter(Boolean);
  if (!words.length) return [];
  add(words);

  // Joint ventures name both parents: "Rivian and Volkswagen Group Technologies".
  const conjunction = words.indexOf("and");
  if (conjunction > 0) add(words.slice(0, conjunction));

  return [...keys];
}

/**
 * Configured brands are indexed by their exact normalized form only. Expanding
 * these the way incoming names are expanded would let a short configured brand
 * swallow longer unrelated ones from the other direction.
 */
const INDEX = new Map<string, CompanyTier[]>();
for (const tier of COMPANY_TIERS) {
  for (const name of tier.companies) {
    const key = normalize(name).replace(/ /g, "");
    INDEX.set(key, [...(INDEX.get(key) ?? []), tier]);
  }
}

/** Every tier a company belongs to, in the order tiers are configured. */
export function matchTiers(company: string): CompanyTier[] {
  const hits = new Set<string>();
  for (const key of companyKeys(company)) {
    for (const tier of INDEX.get(key) ?? []) hits.add(tier.id);
  }
  return hits.size ? COMPANY_TIERS.filter((t) => hits.has(t.id)) : [];
}

/** Sort weight — lower is more notable. Unlisted companies sort last. */
export function companyRank(company: string): number {
  const tiers = matchTiers(company);
  return tiers.length ? COMPANY_TIERS.indexOf(tiers[0]!) : COMPANY_TIERS.length;
}
