---
name: trader-bench
description: Top up the trader benchmark matrix — run every traders/*.md persona N independent times against every complete knowledge-base day for one model, auto-generating and committing any missing seven-keys assessments, writing one immutable JSON cell per (trader, model, day, run-index) under runs/, then regenerate runs/SCOREBOARD.md. Use when the user asks to benchmark the traders, run the bench, or catch a new trader up, optionally with a run count (/trader-bench 5) and/or model alias (/trader-bench 5 sonnet).
---

# Trader Bench — idempotent benchmark matrix top-up

One primitive: bring every trader to N runs on every complete
knowledge-base day, for one model, running ONLY missing cells. Personas
think; this skill plumbs. The backtest CLI is the SOLE judge of every
setup — perform no validation of setups yourself. Existing cells are
write-once and NEVER rerun, overwritten, or deleted.

**Arguments:** optional integer `N` (target runs per cell, default 5) and
optional model alias (default `fable`). Valid aliases and recorded ids:

| alias | model.id |
|---|---|
| fable | claude-fable-5 |
| opus | claude-opus-4-8 |
| sonnet | claude-sonnet-5 |
| haiku | claude-haiku-4-5-20251001 |

Any other alias → abort listing the valid aliases.

## Phase 1 — Preflight (no bench agents — step 6 may run seven-keys sub-flows; abort early with ONE specific message)

1. **Discover personas:** every `traders/*.md`; persona name = the `name:`
   frontmatter value (fall back to filename without `.md`). None → abort
   pointing at `traders/`.
2. **Immutability guard:** compute each persona file's hash with
   `shasum -a 256 traders/<file>.md`. Read `personaSha256` from every
   existing `runs/<trader>/*/*/run-*.json` for that trader (any model, any
   day). If any existing cell's hash differs from the current file's hash,
   abort naming the trader, both hashes, and the remedy: trader files are
   immutable once benchmarked — create a NEW trader file instead of
   editing this one.
3. **Discover complete days:** every `knowledge-base/es/<MMDDYYYY>/` folder
   containing all three docs by suffix: `*_ES_TP.pdf`, `*_ES_TP.md`,
   `*_ES_RECAP.md`. Folders missing any doc are SKIPPED (list them in the
   plan report with the missing suffix), not fatal. Derive each day's CLI
   date from the 8-digit `MMDDYYYY` prefix of the two TP doc FILENAMES —
   never the folder name, whose year is unreliable. The two prefixes must
   agree; a conflict skips the day with both names listed. The recap is
   named for the prior session, so its prefix is exempt. Convert to
   `YYYY-MM-DD` (e.g. `07162026` → `2026-07-16`). The day's cell directory
   key is the TP docs' 8-digit prefix.
4. **Verify candle coverage** per candidate day:
   `CSV=$(ls ticker-data/MES/min-5/*.csv | head -1)`, then

   ```bash
   node -e "Promise.all([import('./src/parse-csv.js'), import('./src/session.js')]).then(async ([p, s]) => {
     const { readFileSync } = await import('node:fs');
     const candles = p.parseCsv(readFileSync(process.argv[1], 'utf8'));
     console.log(s.filterDay(candles, process.argv[2], 'America/New_York').length);
   })" "$CSV" "$DATE"
   ```

   `0` → skip the day, list it. No candidate days at all → abort.
5. **Discover general docs:** every file under `knowledge-base/general/`
   (recursive). Empty or missing directory → proceed with none.
6. **Keys files (generate missing, oldest first):** every candidate day
   needs a `*_ES_KEYS.md` in its folder. For days missing one, run the
   seven-keys skill flow (its Phases 1–3, committing each artifact;
   invoke it with that day's `MMDDYYYY` argument) sequentially in
   chronological order, oldest first, so each day's lookback sees its
   predecessors. A day whose generation aborts is SKIPPED with the
   reason listed. Then compute each remaining candidate day's keys hash:
   `shasum -a 256 <day folder>/<prefix>_ES_KEYS.md`.
7. **Keys immutability guard:** read `keysSha256` from every existing
   `runs/*/*/<day>/run-*.json` (for each remaining candidate day from
   step 6). Any existing cell whose `keysSha256` differs from that day's
   current hash → abort naming the day, both hashes, and the remedy:
   keys files are immutable once benchmarked — start a new benchmark era
   instead of editing them. Cells without the field (pre-keys era) are
   valid and exempt.
8. **Compute the missing set:** for every (trader, day), existing runs are
   `runs/<trader>/<alias>/<day>/run-*.json`; missing indices are `1..N`
   minus the indices present. Existing cells beyond N are left alone.
9. **Report the plan, then proceed:** traders × days × model alias, cells
   already present, cells to run, skipped days with reasons. Example:
   "2 traders × 10 days × fable, target N=5: 62 cells exist, 38 to run."
   If nothing is missing, say so and jump to Phase 4.

## Phase 2 — Fan-out (ONE Workflow invocation)

Launch the Workflow tool with the script below. INLINE the resolved values
into the constants — do NOT pass them via Workflow `args` (they can arrive
undefined; inlining is deterministic). Every agent gets the same envelope
regardless of run index — repeat runs are identical independent trials, and
agents must never see other runs, days, traders, or prior results.

```js
export const meta = {
  name: 'trader-bench',
  description: 'Independent persona setups for missing benchmark cells',
  phases: [{ title: 'Setups', detail: 'one agent per missing cell' }],
}
const MODEL = '<alias>'
const GENERAL = [
  '<absolute path to each file under knowledge-base/general/, or empty array>',
]
const DOCS_BY_DAY = {
  '<MMDDYYYY>': {
    date: '<YYYY-MM-DD>',
    pdf: '<absolute path to *_ES_TP.pdf>',
    plan: '<absolute path to *_ES_TP.md>',
    recap: '<absolute path to *_ES_RECAP.md>',
    keys: '<absolute path to *_ES_KEYS.md>',
  },
}
const PERSONAS = {
  '<persona name>': '<absolute path to traders/<persona>.md>',
}
const CELLS = [
  { trader: '<persona name>', day: '<MMDDYYYY>', runIndex: 1 },
]
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
const generalBlock = GENERAL.length
  ? `Next Read ALL of these general trading-strategy documents — session-agnostic guidance that applies to every trade and constrains how this persona operates:\n` +
    GENERAL.map((g) => `- ${g}`).join('\n') + `\n\n`
  : ''
const results = await parallel(CELLS.map((cell) => () => {
  const docs = DOCS_BY_DAY[cell.day]
  return agent(
    `You are a futures trading persona on an independent benchmark run. First Read the persona file at ${PERSONAS[cell.trader]} and fully adopt that trading identity — its bias, entry style, stop and target logic.\n\n` +
    generalBlock +
    `Read the shared Seven-Keys assessment at ${docs.keys} — the shared scorecard of the day's zones. Adopt its per-zone key scores rather than re-deriving them; apply your persona's style to choose among the zones it grades.

` +
    `Then Read the three documents for the ${docs.date} ES (E-mini S&P 500) session:\n` +
    `1. Trade plan worksheet (PDF, support/resistance zones): ${docs.pdf}\n` +
    `2. Trade plan video transcript: ${docs.plan}\n` +
    `3. Prior-session recap transcript: ${docs.recap}\n\n` +
    `As this persona, commit to exactly ONE trade for the session: long or short. ` +
    `Anchor your entry, stop loss, and take profit to the support/resistance zones in the trade plan. ` +
    `Prices are ES index points in quarter-point increments (e.g. 7530.25). ` +
    `A long requires stopLoss < entry < takeProfit; a short requires takeProfit < entry < stopLoss. ` +
    `Include a rationale of at most 50 words citing which plan level(s) you are using.`,
    { label: `${cell.trader}/${cell.day}#${cell.runIndex}`, schema: SETUP_SCHEMA, model: MODEL }
  ).then((setup) => ({ ...cell, setup }))
}))
log(`${results.filter(Boolean).length}/${CELLS.length} cells returned setups`)
return results.filter(Boolean)
```

If the Workflow invocation itself fails or returns no results array at all, abort WITHOUT writing any cells — the matrix stays untouched and a rerun tops up cleanly. When the Workflow succeeds, any individual cell absent from the returned array (its agent died) gets a cell file in Phase 3 with status `NO_SETUP` and no `setup` key; the bench continues.

## Phase 3 — Judge and persist (no validation of your own)

For each returned setup, in the session scratchpad write `bench-<trader>-<day>-<runIndex>.json` (NO_SETUP cells skip the CLI and go straight to the cell-file write):

```json
[{ "id": "<trader>", "side": "<side>", "entry": <entry>, "stopLoss": <stopLoss>, "takeProfit": <takeProfit> }]
```

Then run (capturing stdout AND stderr separately):

```bash
node src/cli.js run --data "$CSV" --orders <scratchpad>/bench-<trader>-<day>-<runIndex>.json --date "<YYYY-MM-DD>" --json
```

Interpret strictly by the CLI's verdict:

- exit 0 → parse the JSON; `orders[0]` gives `status` (TP | SL | EOD |
  NOT_FILLED), `points`, `dollars`, `fillTime`, `exitTime`. A far-off entry
  is simply `NOT_FILLED` — that IS the answer.
- exit 1 and stderr matches the CLI's order-validation wording (`requires
  stopLoss < entry < takeProfit` / `requires takeProfit < entry <
  stopLoss` / `must be a number`) → status `INVALID`, `note` = that stderr
  line.
- exit 1 otherwise → status `CLI_ERROR`, `note` = the stderr line.

Never fix, clamp, or re-request a persona's prices.

Write each cell to `runs/<trader>/<alias>/<day>/run-<runIndex>.json`
(create directories as needed). If the file already exists, do NOT
overwrite it — record the anomaly for the final summary and move on. Cell
format:

```json
{
  "trader": "<persona name>",
  "model": { "alias": "<alias>", "id": "<model.id from the table>" },
  "day": "<MMDDYYYY>",
  "date": "<YYYY-MM-DD>",
  "runIndex": <k>,
  "timestamp": "<current ISO-8601 UTC time>",
  "personaSha256": "<hash from Phase 1>",
  "keysSha256": "<the day's keys file hash from Phase 1>",
  "setup": { "side": "...", "entry": 0, "stopLoss": 0, "takeProfit": 0, "rationale": "..." },
  "result": { "status": "...", "points": 0, "dollars": 0, "fillTime": "<from CLI JSON, verbatim>", "exitTime": "<from CLI JSON, verbatim>" },
  "note": "<only for INVALID / CLI_ERROR>"
}
```

Omit `setup` for NO_SETUP cells; `result` is then `{ "status": "NO_SETUP" }`.
For NOT_FILLED, keep the CLI's null points/dollars/fillTime/exitTime as
null. Statuses INVALID and CLI_ERROR keep the submitted `setup` and use
`result` = `{ "status": "INVALID" }` / `{ "status": "CLI_ERROR" }` plus the
top-level `note`. Every cell — including NO_SETUP — records the day's
keysSha256.

## Phase 4 — Scoreboard and commit

```bash
node src/cli.js scoreboard
git add runs/
git commit -m "bench(<alias>): add <count> cells across <T> traders / <D> days"
```

If Phase 1 found nothing missing, still regenerate the scoreboard; commit
only if `git status` shows changes (message
`bench(<alias>): regenerate scoreboard`).

Finally, show the user the scoreboard's Ranking table inline, plus the
skipped-day list and any write-anomalies.
