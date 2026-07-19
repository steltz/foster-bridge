---
name: trader-panel
description: Run the daily trader-persona panel backtest for an ES session — fan out one subagent per traders/*.md persona over the shared general strategy docs (knowledge-base/general/), the Seven-Keys methodology doc (knowledge-base/methods/seven-keys.md), plus the day's knowledge-base docs (trade plan PDF, plan transcript, recap transcript) and the shared seven-keys assessment (auto-generated when missing), run each persona's single setup through the backtest CLI, and write a scored panel report into the day folder. Use when the user asks to run the trader panel, optionally with a day argument (/trader-panel MMDDYYYY) and/or force to overwrite an existing report.
---

# Trader Panel — daily persona backtest

Orchestrate a panel of trading-persona subagents against one ES session.
Personas think; this skill only plumbs: discover inputs, fan out, run the
backtest CLI, report. The CLI is the SOLE judge of every setup — perform no
validation of setups yourself.

**Arguments:** optional `MMDDYYYY` (day folder name) and optional `force`.

## Phase 1 — Preflight (no panel agents — step 7 may run the seven-keys sub-flow; abort early with ONE specific message)

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
6. **Discover general strategy docs:** every file under
   `knowledge-base/general/` (recursively), e.g.
   `find knowledge-base/general -type f | sort`. These are session-agnostic
   instructions EVERY persona reads in addition to the day docs. An empty or
   missing directory is not fatal — proceed with no general docs.
7. **Locate the day's keys file:** the `*_ES_KEYS.md` in the day folder.
   If missing, run the seven-keys skill flow first, invoking it with this
   day's `MMDDYYYY` argument (its Phases 1–3, including its own commit),
   then continue with the file it wrote. If that generation aborts, abort
   the panel run with its message.
8. **Resolve the Seven-Keys methodology doc:** the fixed shared file
   `knowledge-base/methods/seven-keys.md` — the framework the keys file's
   scorecard grades zones against. It used to live under
   `knowledge-base/general/` and reach every persona through step 6's glob;
   it now lives outside that directory (deliberately, so the benchmark can
   isolate it), so it must be injected explicitly here to keep this panel's
   output unchanged. Resolve it to an absolute path. Missing → abort naming
   it.

## Phase 2 — Persona fan-out (ONE Workflow invocation)

Launch the Workflow tool with the script below. INLINE the resolved values
directly into the script's `DATE`/`DOCS`/`KEYS`/`METHOD_DOC`/`GENERAL`/`PERSONAS`
constants — do NOT pass them through the Workflow `args` parameter (live
verification showed args can arrive undefined; inlining is deterministic):

Workflow script (fill in the six constants, pass the rest verbatim):

```js
export const meta = {
  name: 'trader-panel',
  description: 'One setup per trading persona for the session',
  phases: [{ title: 'Setups', detail: 'one agent per persona' }],
}
const DATE = '<YYYY-MM-DD>'
const DOCS = {
  pdf: '<absolute path to *_ES_TP.pdf>',
  plan: '<absolute path to *_ES_TP.md>',
  recap: '<absolute path to *_ES_RECAP.md>',
}
const KEYS = '<absolute path to the day *_ES_KEYS.md>'
const METHOD_DOC = '<absolute path to knowledge-base/methods/seven-keys.md>'
// Absolute paths to every file under knowledge-base/general/ (step 6).
// Empty array if the directory holds no docs.
const GENERAL = [
  '<absolute path to knowledge-base/general/<doc>>',
]
const PERSONAS = [
  { name: '<persona name>', file: '<absolute path to traders/<persona>.md>' },
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
    GENERAL.map((g, i) => `- ${g}`).join('\n') + `\n\n`
  : ''
const results = await parallel(PERSONAS.map((p) => () =>
  agent(
    `You are a futures trading persona on a daily panel. First Read the persona file at ${p.file} and fully adopt that trading identity — its bias, entry style, stop and target logic.\n\n` +
    generalBlock +
    `Read the Seven-Keys zone-grading methodology at ${METHOD_DOC} — the framework the shared assessment scores zones against.

` +
    `Read the shared Seven-Keys assessment at ${KEYS} — the panel-wide scorecard of the day's zones. Adopt its per-zone key scores rather than re-deriving them; apply your persona's style to choose among the zones it grades.

` +
    `Then Read the three documents for the ${DATE} ES (E-mini S&P 500) session:\n` +
    `1. Trade plan worksheet (PDF, support/resistance zones): ${DOCS.pdf}\n` +
    `2. Trade plan video transcript: ${DOCS.plan}\n` +
    `3. Prior-session recap transcript: ${DOCS.recap}\n\n` +
    `As this persona, commit to exactly ONE trade for the session: long or short. ` +
    `Anchor your entry, stop loss, and take profit to the support/resistance zones in the trade plan. ` +
    `Prices are ES index points in quarter-point increments (e.g. 7530.25). ` +
    `A long requires stopLoss < entry < takeProfit; a short requires takeProfit < entry < stopLoss. ` +
    `Include a rationale of at most 50 words citing which plan level(s) you are using.`,
    { label: p.name, schema: SETUP_SCHEMA }
  ).then((setup) => ({ persona: p.name, setup }))
))
log(`${results.filter(Boolean).length}/${PERSONAS.length} personas returned setups`)
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
