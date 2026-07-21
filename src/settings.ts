import { ROLE_HARD_EXCLUDE, ROLE_INCLUDE, ROLE_SOFT_EXCLUDE, TARGET_TERMS } from "./config";

const OVERRIDES_KEY = "state:overrides:v1";

export interface Term {
  season: string;
  year: number;
}

/** Everything editable from Telegram. Persisted as-is. */
export interface Overrides {
  /** Extra phrases that make a role relevant. */
  include?: string[];
  /** Extra phrases that disqualify a role outright. */
  exclude?: string[];
  /** Replaces TARGET_TERMS; "any" disables term filtering entirely. */
  terms?: Term[] | "any";
  paused?: boolean;
}

/** Code defaults merged with the user's stored overrides. */
export interface Settings {
  roleInclude: RegExp[];
  roleHardExclude: RegExp[];
  roleSoftExclude: RegExp[];
  targetTerms: Term[] | "any";
  paused: boolean;
  overrides: Overrides;
}

/**
 * User-supplied phrases are matched literally, not as regexes.
 *
 * `/include c++` should mean what it says, and accepting raw regex from a chat
 * message would let a stray `(a+)+` pattern burn the Worker's CPU budget on
 * catastrophic backtracking. Escaping removes that entire class of problem.
 */
export function phraseToRegExp(phrase: string): RegExp {
  return new RegExp(phrase.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

export function buildSettings(overrides: Overrides): Settings {
  const extra = (list: string[] | undefined) => (list ?? []).map(phraseToRegExp);

  return {
    roleInclude: [...ROLE_INCLUDE, ...extra(overrides.include)],
    roleHardExclude: [...ROLE_HARD_EXCLUDE, ...extra(overrides.exclude)],
    roleSoftExclude: ROLE_SOFT_EXCLUDE,
    targetTerms: overrides.terms ?? TARGET_TERMS,
    paused: overrides.paused ?? false,
    overrides,
  };
}

/** Settings with nothing overridden — the compiled-in defaults. */
export function defaultSettings(): Settings {
  return buildSettings({});
}

export async function loadOverrides(kv: KVNamespace): Promise<Overrides> {
  return (await kv.get<Overrides>(OVERRIDES_KEY, "json")) ?? {};
}

export async function saveOverrides(kv: KVNamespace, overrides: Overrides): Promise<void> {
  await kv.put(OVERRIDES_KEY, JSON.stringify(overrides));
}

export async function loadSettings(kv: KVNamespace): Promise<Settings> {
  return buildSettings(await loadOverrides(kv));
}

const SEASONS = ["winter", "spring", "summer", "fall", "autumn"];

/** Parse "summer 2027, winter 2028" or "any" from a chat message. */
export function parseTerms(input: string): Term[] | "any" | null {
  const text = input.trim().toLowerCase();
  if (text === "any" || text === "all") return "any";

  const terms: Term[] = [];
  for (const part of text.split(/[,;]+/)) {
    const m = part.trim().match(/^(\w+)\s+'?(\d{2}|\d{4})$/);
    if (!m || !SEASONS.includes(m[1]!)) return null;
    const year = Number(m[2]);
    terms.push({ season: m[1]!, year: year < 100 ? 2000 + year : year });
  }
  return terms.length ? terms : null;
}

export function formatTerms(terms: Term[] | "any"): string {
  return terms === "any" ? "any term" : terms.map((t) => `${t.season} ${t.year}`).join(", ");
}
