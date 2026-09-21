import type { Source } from "./types";

/**
 * Repos to watch.
 *
 * GitHub's API follows renames, so when a maintainer rolls e.g. 2026 -> 2027
 * these entries keep working; the old name 301s to the new one. Update the
 * names anyway when you notice, since it keeps logs readable.
 */
export const SOURCES: Source[] = [
  {
    id: "vansh",
    label: "Vansh & Ouckah",
    owner: "vanshb03",
    repo: "Summer2027-Internships",
    branch: "dev",
    paths: [".github/scripts/listings.json"],
    parser: "listings-json",
  },
  {
    id: "simplify",
    label: "Simplify",
    owner: "SimplifyJobs",
    // Renamed from Summer2026-Internships; the id stays "simplify" so KV state carries over.
    repo: "Summer2027-Internships",
    branch: "dev",
    paths: [".github/scripts/listings.json"],
    parser: "listings-json",
  },
  {
    id: "speedyapply-swe",
    label: "SpeedyApply SWE",
    owner: "speedyapply",
    repo: "2027-SWE-College-Jobs",
    branch: "main",
    // README.md is the US internship table; INTERN_INTL.md covers everywhere else
    // (this is where Canadian postings show up).
    paths: ["README.md", "INTERN_INTL.md"],
    parser: "speedyapply",
    assumeInternship: true,
  },
  {
    id: "speedyapply-ai",
    label: "SpeedyApply AI",
    owner: "speedyapply",
    repo: "2027-AI-College-Jobs",
    branch: "main",
    paths: ["README.md", "INTERN_INTL.md"],
    parser: "speedyapply",
    assumeInternship: true,
  },
  {
    id: "jobright-swe",
    label: "Jobright SWE",
    owner: "jobright-ai",
    repo: "2026-Software-Engineer-Internship",
    branch: "master",
    paths: ["README.md"],
    parser: "jobright",
    assumeInternship: true,
  },
  {
    id: "jobright-eng",
    label: "Jobright Engineering",
    owner: "jobright-ai",
    repo: "2026-Engineer-Internship",
    branch: "master",
    paths: ["README.md"],
    parser: "jobright",
    assumeInternship: true,
  },
  {
    id: "jobright-pm",
    label: "Jobright Product",
    owner: "jobright-ai",
    repo: "2026-Product-Management-Internship",
    branch: "master",
    paths: ["README.md"],
    parser: "jobright",
    assumeInternship: true,
  },
  {
    id: "jobright-data",
    label: "Jobright Data",
    owner: "jobright-ai",
    repo: "2026-Data-Analysis-Internship",
    branch: "master",
    paths: ["README.md"],
    parser: "jobright",
    assumeInternship: true,
  },
  // Zapply's lists are auto-scraped and mostly don't overlap Simplify. They
  // rebuild every ~10 minutes, all three in the same commit window, so together
  // they cost about the same KV writes as one.
  {
    id: "zapply-ml",
    label: "Zapply AI/ML",
    owner: "zapplyjobs",
    repo: "awesome-ml-internships-2027",
    branch: "main",
    paths: ["README.md"],
    parser: "zapply",
    assumeInternship: true,
  },
  {
    id: "zapply-canada",
    label: "Zapply Canada",
    owner: "zapplyjobs",
    repo: "Canada-Internships-2027",
    branch: "main",
    paths: ["README.md"],
    parser: "zapply",
    assumeInternship: true,
  },
  {
    id: "zapply",
    label: "Zapply",
    owner: "zapplyjobs",
    repo: "Internships-2027",
    branch: "main",
    paths: ["README.md"],
    parser: "zapply",
    assumeInternship: true,
    // Its README is large enough that GitHub omits the diff for many commits;
    // those show up as `truncated` in the tick report and their rows are missed.
  },
];

/**
 * ---------------------------------------------------------------------------
 * TUNING
 * ---------------------------------------------------------------------------
 * This block is the whole filter. Edit, run `npm run preview` to see what it
 * would have alerted on against live data, then `npm run deploy`.
 */

/** Seasons ordered chronologically within a year. */
export const SEASON_ORDER: Record<string, number> = {
  winter: 0,
  spring: 1,
  summer: 2,
  fall: 3,
  autumn: 3,
};

/**
 * The only terms wanted.
 *
 * A listing naming a *different* term is dropped. A listing naming no term at
 * all is KEPT — most postings omit the season entirely, and during the 2027
 * cycle an unlabelled internship is overwhelmingly likely to be Summer 2027.
 * Requiring an explicit "Summer 2027" would discard most real opportunities.
 */
export const TARGET_TERMS = [{ season: "summer", year: 2027 }];

/** A title must match one of these to be considered relevant. */
export const ROLE_INCLUDE: RegExp[] = [
  // Software. Deliberately broad: "Software Development Engineer Intern" is
  // Amazon's title for the most common SWE internship in existence, and a
  // pattern like /software (engineer|developer)/ silently misses it.
  /\bsoftware\b/i,
  /\bswe\b/i,
  /\bdevelop(er|ment)\b|\bprogrammer\b/i,
  /\b(backend|back[- ]end|frontend|front[- ]end|full[- ]?stack)\b/i,
  /computer\s*science/i,
  /\bfirmware\b|\bembedded\b/i,
  /\b(ios|android|mobile)\s*(developer|engineer)/i,
  /\bforward\s*deployed\b|\btechnical\s*staff\b/i,

  // AI / ML
  /machine\s*learning|\bml\b|\bmlops\b/i,
  /\bai\b|artificial\s*intelligence|deep\s*learning|neural|\bllm\b|generative/i,
  /\bnlp\b|natural\s*language|computer\s*vision/i,
  /research\s*(engineer|scientist)|applied\s*scien/i,
  /\bresearch\s*intern\b|\bresearcher\b/i,
  /\balgorithm/i,

  // Data
  /\bdata\b/i,
  /\banalytics\b|business\s*intelligence|business\s*analyst/i,

  // Product
  /product\s*(manage|management|owner)/i,
  /\bapm\b|associate\s*product/i,
  /\bproduct\s*analyst\b/i,
  /deployment\s*strategist/i,

  // Platform / systems
  /\b(platform|infrastructure|cloud|systems|security|performance)\s*engineer/i,
  /\binfrastructure\b|\bsupercomputing\b|\bdistributed\s*systems\b|\bcompiler\b/i,
  /\bdevops\b|site\s*reliability|\bsre\b/i,
  /\btechnolog(y|ies)\b/i,
  /quantitative\s*(developer|research)/i,
  /\bengineering\s*intern\b/i,
  /\btechnical\s*intern\b/i,
  /\bcomputer\s*engineer/i,
];

/**
 * Postgraduate-only postings. Rejected unless the title also welcomes
 * undergrads — "(BS/MS/PhD)" is open to you, "PhD Research Intern" is not.
 */
export const GRADUATE_ONLY = /\bph\.?\s?d\.?\b|\bdoctoral\b|\bpost[- ]?doc|\bmba\b/i;
export const UNDERGRAD_WELCOME =
  /\bb\.?\s?s\.?\b|\bb\.?\s?a\.?\b|\bb\.?eng\b|bachelor|undergrad|sophomore|junior|freshman/i;

/**
 * Always reject — a different discipline entirely, no matter what other words
 * appear in the title.
 */
export const ROLE_HARD_EXCLUDE: RegExp[] = [
  /\b(mechanical|civil|chemical|biomedical|aerospace|structural|materials|petroleum|nuclear|environmental|industrial)\s*engineer/i,
  /\belectrical\s*engineer/i,
  /\b(manufacturing|process|field|maintenance|quality)\s*engineer/i,
  /\b(nursing|nurse|clinical|pharmac|medical|physician|dental|veterinar)/i,
  /\b(accounting|accountant|audit|taxation|actuarial|underwrit)/i,
  /\b(paralegal|attorney|law\s*clerk)/i,
  /\b(teacher|tutor|camp\s*counselor|barista|cashier|retail\s*associate)/i,
  /\b(construction|welding|hvac|plumbing|warehouse|driver)/i,
  /\b(biolog|chemist|geolog|agronom)/i,
  /\bdata\s*entry\b/i, // matches the broad /\bdata\b/ include, but isn't the job
];

/**
 * Reject only when nothing in ROLE_INCLUDE also matched. Keeps "Marketing
 * Analytics Intern" out while letting "Data Analyst, Sales Ops" through.
 */
export const ROLE_SOFT_EXCLUDE: RegExp[] = [
  /\b(sales|marketing|advertis|brand)\b/i,
  /\bmarket\s*research/i,
  /\b(human\s*resources|\bhr\b|recruit|talent\s*acquisition)/i,
  /\b(communications|public\s*relations|social\s*media|content\s*writer)/i,
  /\b(supply\s*chain|logistics|procurement|merchandis)/i,
  /\b(finance|investment\s*banking|wealth\s*management|trading\s*floor)/i,
  /\b(graphic|ux\s*writer|interior)\s*design/i,
  /\bbusiness\s*development\b/i,
  /\b(it\s*support|help\s*desk|desktop\s*support)\b/i,
];

/** Sponsorship values from the structured feeds that disqualify a listing. */
export const BLOCKED_SPONSORSHIP = [
  "u.s. citizenship is required",
  "does not offer sponsorship",
];

/** Free-text markers that mean "not open to someone needing sponsorship". */
export const BLOCKED_TEXT: RegExp[] = [
  /u\.?s\.?\s*citizen/i,
  /security\s*clearance/i,
  /\bts\/sci\b|top\s*secret|polygraph/i,
  /must\s*be\s*(a\s*)?(u\.?s\.?|united\s*states)/i,
  /without\s*sponsorship/i,
  /no\s*sponsorship/i,
  /green\s*card/i,
  /export\s*control/i,
];

/** Locations that are clearly outside North America. */
export const BLOCKED_LOCATIONS: RegExp[] = [
  /\b(india|bangalore|bengaluru|hyderabad|pune|chennai|gurgaon|noida|mumbai|delhi)\b/i,
  /\b(china|beijing|shanghai|shenzhen|hangzhou|taiwan|taipei|hong\s*kong)\b/i,
  /\b(singapore|japan|tokyo|korea|seoul|malaysia|thailand|vietnam|philippines|indonesia)\b/i,
  /\b(united\s*kingdom|england|london|cambridge,\s*uk|manchester|edinburgh|scotland|ireland|dublin)\b/i,
  /\b(germany|berlin|munich|france|paris|spain|madrid|barcelona|italy|milan|rome)\b/i,
  /\b(netherlands|amsterdam|belgium|brussels|switzerland|zurich|geneva|austria|vienna)\b/i,
  /\b(sweden|stockholm|norway|oslo|denmark|copenhagen|finland|helsinki|poland|warsaw|krakow)\b/i,
  /\b(israel|tel\s*aviv|uae|dubai|abu\s*dhabi|saudi|qatar|turkey|istanbul|egypt)\b/i,
  /\b(australia|sydney|melbourne|new\s*zealand|auckland)\b/i,
  /\b(brazil|sao\s*paulo|mexico|mexico\s*city|argentina|chile|colombia|costa\s*rica)\b/i,
  /\b(south\s*africa|nigeria|kenya|romania|bucharest|czech|prague|hungary|budapest|portugal|lisbon|greece|athens)\b/i,
];

/** Location markers that keep a listing regardless of BLOCKED_LOCATIONS. */
export const ALLOWED_LOCATIONS: RegExp[] = [
  /\bremote\b/i,
  /\b(canada|canadian)\b/i,
  /\b(toronto|vancouver|montreal|montréal|waterloo|ottawa|calgary|edmonton|winnipeg|halifax|kitchener|mississauga|burnaby|victoria|quebec|québec)\b/i,
  /,\s*(on|bc|qc|ab|mb|sk|ns|nb|nl|pe)\b/i,
  /\b(united\s*states|usa|u\.s\.a?\.?)\b/i,
  // "City, XX" with a US state abbreviation
  /,\s*(al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy|dc)\b/i,
];

/** Words that identify a posting as an internship / co-op. */
export const INTERNSHIP_MARKERS: RegExp[] = [
  /\bintern(ship)?s?\b/i,
  /\bco[- ]?op\b/i,
  /\bplacement\b/i,
  /\bapprentice/i,
  /\bsummer\s*analyst\b/i,
  /\bfellowship\b|\bresidency\b/i, // early-career programs that aren't titled "intern"
];

/**
 * Companies worth spotting at a glance.
 *
 * A job can match several tiers — Shopify is both top tech and Canadian — and
 * all matching markers are shown. The first matching tier decides sort order,
 * so these are listed most-notable first.
 *
 * Matching is on the company's leading words, not a substring: "Rivian and
 * Volkswagen Group" matches Rivian, while "Snapdocs" does not match Snap.
 */
export interface CompanyTier {
  id: string;
  label: string;
  emoji: string;
  companies: string[];
}

export const COMPANY_TIERS: CompanyTier[] = [
  {
    id: "big-tech",
    label: "Big Tech",
    emoji: "⭐",
    companies: [
      "google", "alphabet", "youtube", "deepmind", "google deepmind",
      "meta", "facebook", "instagram", "whatsapp",
      "apple", "amazon", "aws", "amazon web services", "netflix",
      "microsoft", "linkedin", "github", "nvidia",
      "openai", "anthropic",
    ],
  },
  {
    id: "top-tech",
    label: "Top Tech",
    emoji: "🔥",
    companies: [
      "stripe", "databricks", "snowflake", "palantir", "figma", "notion", "canva",
      "shopify", "cohere",
      "uber", "lyft", "airbnb", "doordash", "instacart", "pinterest", "snap",
      "reddit", "discord", "roblox", "twitch", "spotify", "tiktok", "bytedance",
      "atlassian", "salesforce", "adobe", "oracle", "ibm", "sap", "servicenow",
      "intel", "amd", "qualcomm", "broadcom", "arm", "cisco", "vmware", "dell",
      "workday", "intuit", "paypal", "block", "coinbase", "robinhood", "plaid",
      "brex", "ramp", "dropbox", "slack", "zoom", "twilio", "cloudflare",
      "datadog", "mongodb", "confluent", "hashicorp", "gitlab", "elastic",
      "splunk", "okta", "crowdstrike", "samsara", "scale ai", "perplexity",
      "mistral", "sierra", "cursor", "anysphere", "figma",
      "tesla", "spacex", "rivian", "waymo", "cruise", "zoox", "aurora",
      "anduril", "applied intuition", "bloomberg", "visa", "mastercard",
      "ebay", "expedia", "booking", "zillow", "etsy", "capital one",
    ],
  },
  {
    id: "quant",
    label: "Quant",
    emoji: "💰",
    companies: [
      "jane street", "citadel", "citadel securities", "two sigma",
      "hudson river trading", "jump trading", "de shaw", "d e shaw",
      "optiver", "imc", "imc trading", "susquehanna", "point72", "millennium",
      "akuna", "akuna capital", "drw", "tower research", "virtu", "five rings",
      "radix trading", "old mission", "headlands", "quantlab", "xtx markets",
      "squarepoint", "balyasny", "verition", "aqr", "man group",
    ],
  },
  {
    id: "canada",
    label: "Canadian",
    emoji: "🍁",
    companies: [
      "shopify", "cohere", "wealthsimple", "1password", "clio", "coveo",
      // "lightspeed commerce", not "lightspeed": Lightspeed Systems is an
      // unrelated US ed-tech company, and Systems is a corporate qualifier.
      "faire", "ada", "vidyard", "jobber", "thinkific", "lightspeed commerce", "nuvei",
      "kinaxis", "docebo", "benevity", "blackberry", "opentext",
      "constellation software", "telus", "rbc", "royal bank of canada",
      "td bank", "bmo", "scotiabank", "cibc", "cgi", "magna",
    ],
  },
];

/** How long a seen job stays deduped, in days. */
export const SEEN_TTL_DAYS = 120;

/** Cap on how many jobs a single cron tick will announce, as a spam fuse. */
export const MAX_NOTIFY_PER_TICK = 40;

/**
 * If nothing has been sent for this many days, send a heartbeat instead.
 *
 * These are volunteer-maintained repos. If one restructures its README, the
 * parser returns zero rows with no error — and prolonged silence is
 * indistinguishable from "nothing was posted". The heartbeat makes a working
 * system prove it is working, so silence becomes evidence of a fault.
 */
export const HEARTBEAT_DAYS = 7;

/**
 * Sender for the queue-nudge email (see src/email.ts). Must be an address on a
 * domain with Cloudflare Email Routing enabled.
 */
export const AGENT_EMAIL_FROM = "jobs@danielrltan.com";

/** Must match the send_email binding's destination_address in wrangler.jsonc. */
export const AGENT_EMAIL_TO = "danielrltan@gmail.com";

/** Subject prefix an agent's email trigger can match on. Keep it stable. */
export const AGENT_EMAIL_SUBJECT = "[job-hunter]";

/**
 * At most one nudge per this many minutes; each covers everything queued since
 * the last. The agent drains the whole queue per run, so more would only wake
 * it to find nothing left.
 */
export const AGENT_EMAIL_MIN_MINUTES = 10;
