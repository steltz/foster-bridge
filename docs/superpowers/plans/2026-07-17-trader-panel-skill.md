# Trader Panel Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/trader-panel` project skill that fans out one subagent per `traders/*.md` persona over a day's knowledge-base docs, runs each persona's single setup through the backtest CLI, and writes a scored panel report into the day folder.

**Architecture:** Pure markdown deliverables — three starter persona files plus one SKILL.md holding the whole hybrid procedure (inline preflight → one dynamic Workflow fan-out with a schema-forced setup shape → inline per-persona CLI runs → one report write + commit). No `src/` changes; the CLI is the sole judge of every setup.

**Tech Stack:** Claude Code project skill (`.claude/skills/`), Workflow tool (dynamic workflows), existing backtest CLI (`node src/cli.js run`), existing repo modules for the candle-coverage check.

**Spec:** `docs/superpowers/specs/2026-07-17-trader-panel-skill-design.md`

**Note on task granularity:** the deliverables are documents, not code, so there are no unit tests. Task-level verification is inspection; Task 3 is the spec's end-to-end live run, which MUST be executed by the main session (the controller), not a subagent — launching a Workflow requires the main session's tools.

---

### Task 1: Starter persona files

**Files:**
- Create: `traders/support-buyer.md`
- Create: `traders/breakout-trader.md`
- Create: `traders/fade-the-move.md`

- [ ] **Step 1: Create `traders/support-buyer.md`**

```markdown
---
name: support-buyer
style: Patient dip-buyer at the plan's primary support zone
---

You are a patient, mean-reversion futures trader. You believe the day's best
risk/reward is buying a pullback into significant support identified in the
morning trade plan.

How you trade:

- You ONLY go long. You are the panel's long specialist — even when the
  plan's bias is bearish, you find the support level where responsive buyers
  are most likely to defend and place your best long there.
- Entry: at or just inside the trade plan's primary/initial support zone —
  the one the plan treats as first meaningful downside reference.
- Stop loss: a few points beyond the FAR edge of that support zone (if the
  zone truly fails, you want out quickly).
- Take profit: the nearest meaningful resistance or upside objective the
  plan names above your entry.
- You respect what the recap said about how the prior session treated these
  levels: support that was already broken and retested from below is weaker;
  fresh untested support is stronger.
```

- [ ] **Step 2: Create `traders/breakout-trader.md`**

```markdown
---
name: breakout-trader
style: Trades range expansion through the plan's key level
---

You are a momentum futures trader. You believe the day's best opportunity is
the moment price breaks a level everyone is watching and range expansion
kicks in.

How you trade:

- Direction comes from the trade plan's stated bias alone: bearish or
  neutral-to-bearish bias → you look to SHORT a break of initial support;
  bullish bias → you look to go LONG a break of initial resistance. If the
  plan is truly neutral, take the side of the level the plan discusses in
  the most detail.
- Entry: just beyond the broken edge of the zone (you want confirmation the
  level actually gave way, not a limit inside it).
- Stop loss: back inside the broken zone — if price re-enters the zone, the
  breakout failed and you are wrong.
- Take profit: the next zone the plan names in your direction (the range
  expansion target).
- The recap matters to you: a level that already produced a failed breakout
  yesterday is suspect; a fresh break of a multi-day level is your favorite.
```

- [ ] **Step 3: Create `traders/fade-the-move.md`**

```markdown
---
name: fade-the-move
style: Fades extensions into the plan's outer zones
---

You are a contrarian futures trader. You believe extended moves into the
day's outer support/resistance zones exhaust themselves and snap back toward
value.

How you trade:

- You fade: SHORT an extension up into the plan's upper/aggressive
  resistance zone, or LONG a flush down into the plan's lower/aggressive
  support zone. Pick whichever extreme the plan and recap suggest is more
  likely to be reached and rejected today.
- Entry: at the near edge of that outer zone (you are providing liquidity
  where the plan says responsive traders act).
- Stop loss: beyond the FAR edge of the zone — if the zone fully breaks,
  the move is real and you are wrong.
- Take profit: back toward the middle of the day's expected range (the
  plan's equilibrium/value area, or the first opposing level it names).
- The recap tells you the crowd's recent pain: zones that rejected price
  hard yesterday are your best fade locations.
```

- [ ] **Step 4: Verify frontmatter parses visually**

Run: `head -5 traders/*.md`
Expected: each file shows `---`, `name: <slug>`, `style: ...` lines.

- [ ] **Step 5: Commit**

```bash
git add traders/
git commit -m "feat: add starter trading personas for trader panel"
```

---

### Task 2: The trader-panel SKILL.md

**Files:**
- Create: `.claude/skills/trader-panel/SKILL.md`

- [ ] **Step 1: Create `.claude/skills/trader-panel/SKILL.md`** with exactly this content:

````markdown
---
name: trader-panel
description: Run the daily trader-persona panel backtest for an ES session — fan out one subagent per traders/*.md persona over the day's knowledge-base docs (trade plan PDF, plan transcript, recap transcript), run each persona's single setup through the backtest CLI, and write a scored panel report into the day folder. Use when the user asks to run the trader panel, optionally with a day argument (/trader-panel MMDDYYYY) and/or force to overwrite an existing report.
---

# Trader Panel — daily persona backtest

Orchestrate a panel of trading-persona subagents against one ES session.
Personas think; this skill only plumbs: discover inputs, fan out, run the
backtest CLI, report. The CLI is the SOLE judge of every setup — perform no
validation of setups yourself.

**Arguments:** optional `MMDDYYYY` (day folder name) and optional `force`.

## Phase 1 — Preflight (no agents; abort early with ONE specific message)

1. **Resolve the day folder.** With an `MMDDYYYY` argument use
   `knowledge-base/es/<MMDDYYYY>/`. Without one, consider every folder under
   `knowledge-base/es/` that contains all three docs (step 2), order them
   chronologically by the date prefix of their `*_ES_TP.md` re-keyed as
   `YYYYMMDD` (never by folder name — lexicographic `MMDDYYYY` ordering
   breaks across year boundaries), and pick the latest without a
   `*_ES_PANEL.md`. If `force` was given without a day argument, do not skip
   folders with reports: pick the latest complete folder and overwrite its
   report. If a chosen folder already has a `*_ES_PANEL.md` and `force` was
   not given, abort: name the existing report and tell the user to pass
   `force` to overwrite.
2. **Locate the three docs** inside the folder by suffix:
   - `*_ES_TP.pdf` (trade plan worksheet)
   - `*_ES_TP.md` (plan video transcript)
   - `*_ES_RECAP.md` (prior-session recap transcript)
   Any missing → abort naming exactly which suffix is absent.
3. **Derive the CLI date** from the 8-digit `MMDDYYYY` prefix of the two
   trade-plan doc FILENAMES (`*_ES_TP.pdf` and `*_ES_TP.md`) — never the
   folder name, whose year is unreliable. Those two prefixes must agree; if
   they conflict, abort showing both names. The recap is named for the PRIOR
   session it recaps, so its prefix is expected to differ and is exempt from
   this check. Convert to `YYYY-MM-DD` (e.g. `07162026` → `2026-07-16`).
4. **Verify candle coverage.** `CSV=$(ls ticker-data/MES/min-5/*.csv | head -1)`,
   then count that day's candles using the repo's own modules:

   ```bash
   node -e "Promise.all([import('./src/parse-csv.js'), import('./src/session.js')]).then(async ([p, s]) => {
     const { readFileSync } = await import('node:fs');
     const candles = p.parseCsv(readFileSync(process.argv[1], 'utf8'));
     console.log(s.filterDay(candles, process.argv[2], 'America/New_York').length);
   })" "$CSV" "$DATE"
   ```

   `0` → abort: no candles for `$DATE` in `$CSV`.
5. **Discover personas:** every `traders/*.md` file; persona name = the
   `name:` frontmatter value (fall back to the filename without `.md`).
   None → abort pointing at `traders/`.

## Phase 2 — Persona fan-out (ONE Workflow invocation)

Launch the Workflow tool with the script below, passing as `args` (real JSON,
not a string):

```json
{
  "date": "<YYYY-MM-DD>",
  "docs": {
    "pdf": "<absolute path to *_ES_TP.pdf>",
    "plan": "<absolute path to *_ES_TP.md>",
    "recap": "<absolute path to *_ES_RECAP.md>"
  },
  "personas": [{ "name": "<persona name>", "file": "<absolute path>" }]
}
```

Workflow script (pass verbatim):

```js
export const meta = {
  name: 'trader-panel',
  description: 'One setup per trading persona for the session',
  phases: [{ title: 'Setups', detail: 'one agent per persona' }],
}
const SETUP_SCHEMA = {
  type: 'object',
  required: ['side', 'entry', 'stopLoss', 'takeProfit', 'rationale'],
  properties: {
    side: { enum: ['long', 'short'] },
    entry: { type: 'number' },
    stopLoss: { type: 'number' },
    takeProfit: { type: 'number' },
    rationale: { type: 'string', maxLength: 400 },
  },
  additionalProperties: false,
}
phase('Setups')
const results = await parallel(args.personas.map((p) => () =>
  agent(
    `You are a futures trading persona on a daily panel. First Read the persona file at ${p.file} and fully adopt that trading identity — its bias, entry style, stop and target logic.\n\n` +
    `Then Read the three documents for the ${args.date} ES (E-mini S&P 500) session:\n` +
    `1. Trade plan worksheet (PDF, support/resistance zones): ${args.docs.pdf}\n` +
    `2. Trade plan video transcript: ${args.docs.plan}\n` +
    `3. Prior-session recap transcript: ${args.docs.recap}\n\n` +
    `As this persona, commit to exactly ONE trade for the session: long or short. ` +
    `Anchor your entry, stop loss, and take profit to the support/resistance zones in the trade plan. ` +
    `Prices are ES index points in quarter-point increments (e.g. 7530.25). ` +
    `A long requires stopLoss < entry < takeProfit; a short requires takeProfit < entry < stopLoss. ` +
    `Include a rationale of at most 50 words citing which plan level(s) you are using.`,
    { label: p.name, schema: SETUP_SCHEMA }
  ).then((setup) => ({ persona: p.name, setup }))
))
log(`${results.filter(Boolean).length}/${args.personas.length} personas returned setups`)
return results.filter(Boolean)
```

Any discovered persona absent from the returned array gets report status
`NO_SETUP` (its agent died); the panel continues.

## Phase 3 — Execute each setup through the CLI (no validation of your own)

For each `{ persona, setup }`, in the session scratchpad write
`panel-<persona>.json`:

```json
[{ "id": "<persona>", "side": "<side>", "entry": <entry>, "stopLoss": <stopLoss>, "takeProfit": <takeProfit> }]
```

Then run (one persona at a time, capturing stdout AND stderr separately):

```bash
node src/cli.js run --data "$CSV" --orders <scratchpad>/panel-<persona>.json --date "$DATE" --json
```

Interpret strictly by the CLI's verdict:

- exit 0 → parse the JSON; the persona's result is `orders[0]`
  (`status` TP | SL | EOD | NOT_FILLED, plus fill/exit times, `points`,
  `dollars`). A far-off entry is simply `NOT_FILLED` — that IS the answer.
- exit 1 and stderr matches the CLI's order-validation wording
  (`requires stopLoss < entry < takeProfit` / `requires takeProfit < entry <
  stopLoss` / `must be a number`) → status `INVALID`, note = that stderr line.
- exit 1 otherwise → status `CLI_ERROR`, note = the stderr line.

Never fix, clamp, or re-request a persona's prices.

## Phase 4 — Report and commit (write ONCE, at the end)

Write `<docPrefix>_ES_PANEL.md` into the day folder, where `<docPrefix>` is
the same 8-digit prefix the trade-plan docs use (e.g. `07162026`). Format:

```markdown
# Trader Panel — ES <YYYY-MM-DD>

| Persona | Side | Entry | Stop | Target | Result | Pts | USD |
|---|---|---|---|---|---|---|---|
| <name> | <side> | <entry> | <stopLoss> | <takeProfit> | <status> | <points or -> | <dollars or -> |

**Panel:** <N> personas · <filled> filled · <wins> wins · net <pts> pts / $<usd>

## Rationales

- **<name>:** "<rationale>"

## Notes

- <one line per INVALID / NO_SETUP / CLI_ERROR persona with its reason, or "All personas executed cleanly.">
```

Rules: every discovered persona appears in the table exactly once (INVALID /
NO_SETUP / CLI_ERROR rows use `-` for the columns they lack; INVALID rows DO
show the persona's submitted prices). Panel summary counts: filled = CLI
statuses TP/SL/EOD; wins = points > 0; net sums only filled personas.
Times in the table are unnecessary in MVP — result, points, dollars suffice.

Then commit exactly the report:

```bash
git add "<day folder>/<docPrefix>_ES_PANEL.md"
git commit -m "docs: add ES trader panel report for <YYYY-MM-DD>"
```

Finally, show the user the report table and summary inline.
````

- [ ] **Step 2: Verify the skill is discoverable**

Run: `head -4 .claude/skills/trader-panel/SKILL.md`
Expected: frontmatter with `name: trader-panel` and the one-paragraph description.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/trader-panel/SKILL.md
git commit -m "feat: add trader-panel orchestration skill"
```

---

### Task 3: End-to-end live verification (MAIN SESSION ONLY)

**Files:**
- Creates (via the skill): `knowledge-base/es/07162027/07162026_ES_PANEL.md`

This task is performed by the controller in the main session — a subagent
cannot launch the Workflow tool. Follow the committed SKILL.md exactly as
written (this is also a usability test of the skill's own instructions).

- [ ] **Step 1: Run the panel for 07/16**

Invoke the skill procedure with argument `07162027`. Expected preflight
resolution: docs `07152026_ES_RECAP.md` + `07162026_ES_TP.md` present —
**note:** this folder has NO `*_ES_TP.pdf`. Preflight must therefore ABORT
naming the missing PDF. That abort IS the first verification (error handling
works). Record the message.

- [ ] **Step 2: Add the missing worksheet or fall back to 07172027**

If the user can supply `07162026_ES_TP.pdf`, add it and rerun. Otherwise run
the panel against `knowledge-base/es/07172027/` (which has all three docs:
`07172027_ES_TP.pdf`... verify actual prefixes on disk — if its doc prefixes
conflict, per the Date rule the skill must abort and that conflict must be
reported to the user rather than worked around).

- [ ] **Step 3: Verify the successful run end-to-end**

Success criteria, all required:
1. Workflow ran with one agent per `traders/*.md` (3 starters) and each
   returned a schema-valid setup.
2. Three CLI runs executed; every persona has a row with a CLI-derived
   result (TP/SL/EOD/NOT_FILLED) or an orchestrator status with reason.
3. `*_ES_PANEL.md` exists in the day folder, matches the template, summary
   math consistent with the rows (filled = TP/SL/EOD count; net sums filled
   only).
4. The report was committed with the semantic message and nothing else
   staged with it.

- [ ] **Step 4: Verify the rerun guard**

Invoke the skill again for the same day WITHOUT `force`.
Expected: abort naming the existing `*_ES_PANEL.md` and suggesting `force`.
No workflow launched, no files changed.

- [ ] **Step 5: Report results to the user**

Show the panel table inline plus anything learned about the starter
personas' behavior (e.g. all three picked the same level — a signal the
envelope prompt may need more persona differentiation later, which is
persona work, not skill work).
