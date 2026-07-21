# job-hunter

Watches eight GitHub internship-listing repos and pushes a Telegram message
within ~2 minutes of a relevant new posting appearing.

Filtered for SWE / AI / ML / data / product internships, for someone based in
Canada who needs US sponsorship. Runs on a Cloudflare Worker, so it keeps
watching whether or not your PC is on. Free tier, no card required.

## How it works

A cron trigger fires every 2 minutes. For each source the Worker asks GitHub
`compare/{lastSeenSha}...{branch}` and reads only the **added lines** of the
watched files.

This is the design decision everything else rests on. Simplify's
`listings.json` is **11 MB** — parsing it every 2 minutes would blow the free
tier's 10 ms CPU budget many times over. A three-hour diff of that same file
is **~8 KB**. Diffing also means "what's new" falls straight out of the data
instead of being reconstructed by comparing snapshots.

```
cron ─▶ compare(lastSha…HEAD) ─▶ added lines ─▶ parse ─▶ filter ─▶ dedupe ─▶ Telegram
                                                                     │
                                                              KV: shas + seen
```

Nothing is persisted until Telegram accepts the message, so an outage causes
the next tick to retry the same commits rather than silently dropping jobs.

### Sources

| Source | Format | Notes |
|---|---|---|
| `vanshb03/Summer2027-Internships` | `listings.json` | structured, has a `sponsorship` field |
| `SimplifyJobs/Summer2026-Internships` | `listings.json` | 11 MB, diff-only |
| `speedyapply/2027-SWE-College-Jobs` | markdown | `README.md` (US) + `INTERN_INTL.md` (Canada et al.) |
| `speedyapply/2027-AI-College-Jobs` | markdown | same two files |
| `jobright-ai/2026-Software-Engineer-Internship` | markdown | branch `master` |
| `jobright-ai/2026-Engineer-Internship` | markdown | |
| `jobright-ai/2026-Product-Management-Internship` | markdown | |
| `jobright-ai/2026-Data-Analysis-Internship` | markdown | |

These repos roll over each year (`2026-` → `2027-`). GitHub's API follows the
rename automatically, so nothing breaks; update `src/config.ts` when convenient
to keep logs readable.

## Setup

**1. Cloudflare**

```bash
npx wrangler login
npx wrangler kv namespace create STATE
```

Copy the printed `id` into the `kv_namespaces` block of `wrangler.jsonc`,
replacing `PLACEHOLDER_RUN_SETUP`.

**2. Telegram bot**

- Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
- Send your new bot any message (it can't message you until you do).
- Open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `result[0].message.chat.id`.

**3. GitHub token**

Create a [fine-grained PAT](https://github.com/settings/personal-access-tokens/new)
with **no** account permissions — public repo read access is all it needs.
This lifts the API limit from 60/hour to 5,000/hour (the cron uses ~240/hour).

**4. Secrets and deploy**

```bash
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put ADMIN_KEY      # any random string, e.g. `openssl rand -hex 16`

npm run deploy
```

> **Run these one at a time, in a real interactive terminal.** Each must show a
> masked `Enter a secret value:` prompt. In a non-interactive shell — a CI job,
> an agent, or several commands pasted at once — wrangler cannot prompt, so it
> uploads an **empty** value and still prints `✨ Success!`.
>
> Empty secrets fail confusingly rather than obviously: an empty bot token makes
> the Telegram URL `api.telegram.org/bot/sendMessage`, which returns a bare
> `404 Not Found`, and an empty `GITHUB_TOKEN` silently downgrades to
> unauthenticated polling that works briefly then dies at 60 requests/hour.
>
> `GET /health` reports `ready: false` when any secret is empty, and the cron
> now throws immediately naming the offenders. Check `/health` after setup.

**5. Verify**

Deployed at **https://job-hunter.searchcn.workers.dev**

```bash
curl "https://job-hunter.searchcn.workers.dev/health"                       # expect ready: true
curl "https://job-hunter.searchcn.workers.dev/test?key=$ADMIN_KEY"          # expect a Telegram message
curl "https://job-hunter.searchcn.workers.dev/run?key=$ADMIN_KEY"           # force a tick
```

On Windows use `curl.exe`, not `curl` — PowerShell aliases the latter to
`Invoke-WebRequest`, which throws a .NET exception on any non-200 response
instead of printing the JSON body you need to read.

The first tick per source **bootstraps**: it records the current commit and
stays silent, so deploying doesn't fire hundreds of alerts for listings that
were already there. Real notifications begin with the next new posting.

## Tuning the filter

Everything lives in the `TUNING` block of `src/config.ts`. After editing:

```bash
npm run preview                    # what would match, and why the rest was dropped
npm run preview -- --show          # list every match
npm run preview -- --rejects=role  # list titles dropped for a given reason
```

`--rejects` is the one that matters. It is how the first version was caught
dropping *"Amazon — Software Development Engineer Intern"*, because
`/software (engineer|developer)/` does not match "Software Development
Engineer". Skim it for roles you'd actually have wanted.

Current behaviour:

- **Role** — must match `ROLE_INCLUDE`. `ROLE_HARD_EXCLUDE` (mechanical, civil,
  nursing…) always wins; `ROLE_SOFT_EXCLUDE` (sales, marketing…) only rejects
  when no technical keyword matched, so "Data Analyst, Sales Ops" survives.
- **Term** — only `TARGET_TERMS` (default Summer 2027). A listing naming any
  other term is dropped; a listing naming **no** term is kept, since most
  postings omit the season and requiring one would discard the majority of real
  opportunities. Handles "Summer 2027", "Summer '27" and "2027 Summer".
- **Level** — postgraduate-only roles are dropped, unless the title also
  welcomes undergrads: "PhD Research Intern" goes, "SWE Intern (BS/MS/PhD)"
  stays.
- **Authorization** — drops `U.S. Citizenship is Required`, `Does Not Offer
  Sponsorship`, and free-text clearance/citizenship wording. Unknown
  sponsorship is kept.
- **Location** — US, Canada and remote are kept; clearly non-North-American
  listings are dropped.
- **Dedupe** — on normalized company + role, with season and the word "intern"
  stripped, so the same job across four repos alerts once.

## Company highlighting

Notable companies are marked and sorted to the top of each batch, so a long run
of alerts leads with what matters:

| Marker | Tier | Treatment |
|---|---|---|
| ⭐ | Big Tech — FAANG/MAANG plus frontier AI labs | name in caps |
| 🔥 | Top Tech | bold |
| 💰 | Quant | bold |
| 🍁 | Canadian | bold |

A company can hold several markers — Shopify shows `🔥🍁`. Caps are reserved
for the top tier: if everything shouts, nothing does.

Matching uses a company's **leading words**, not substrings, so
"Rivian and Volkswagen Group Technologies" resolves to Rivian while "Snapdocs"
is not mistaken for Snap. Legal suffixes (`Inc`, `Ltd`, `Technologies`) are
ignored. Edit `COMPANY_TIERS` in `src/config.ts` to add your own.

## The heartbeat

If nothing matches for `HEARTBEAT_DAYS` (default 7), the Worker sends a
liveness message instead of staying silent.

This exists because the failure mode that matters here is silent. These repos
are volunteer-maintained; if one restructures its README, the parser returns
zero rows and raises no error. Prolonged quiet would look exactly like a quiet
hiring week. A heartbeat that stops arriving is a signal — silence on its own
is not.

## Operations

| Route | Purpose |
|---|---|
| `/health` | public liveness check |
| `/run?key=…` | force a tick, returns a JSON report |
| `/state?key=…` | current per-source commits and seen-count |
| `/test?key=…` | send a test Telegram message |
| `/reset-seen?key=…` | clear dedupe memory |

```bash
npm test        # 37 tests over real captured fixtures
npm run smoke   # full live path, prints the exact Telegram message
npm run tail    # stream production logs
```

### Free-tier headroom

- **Worker requests** — ~720/day of 100,000.
- **KV writes** — the binding constraint at 1,000/day. State is two keys, not
  one per job: a small `shas` key read every tick, and a `seen` key touched
  only on ticks that actually found something. Typical usage is a few hundred
  writes/day.
- **GitHub API** — ~240 calls/hour against 5,000.

CPU per tick stays in single-digit milliseconds because only diffs are parsed.
If you ever add a source that needs whole-file parsing, expect to need the $5/mo
Workers Paid plan for its 30 s CPU limit.
