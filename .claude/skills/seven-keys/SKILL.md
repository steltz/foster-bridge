---
name: seven-keys
description: Generate the shared Seven-Keys daily zone assessment for an ES session — a four-agent workflow (current-day analyst over the general docs plus the day's three docs, outcome-aware lookback analyst over up to three prior days' keys files paired with their outcome recaps, a synthesizer that weights the current day heavily, and a verifier that checks every scorecard row against the trade plan) writing a committed <prefix>_ES_KEYS.md into the day folder. Use when the user asks to generate the seven keys or keys assessment for a day (/seven-keys MMDDYYYY, optional force), or when another skill needs a day's missing keys file.
---

# Seven Keys — shared daily zone assessment

Produce ONE per-day scorecard of the trade plan's support/resistance zones
against Keys 3–7 of the methodology doc, so every trading persona receives
the same zone evaluation instead of re-deriving its own. Keys 1–2
(expectancy; no price confirmation) are trader behaviors, not zone
properties — they stay with the personas. An artifact is written ONLY after
the verifier passes it; never write an unverified artifact.

**Arguments:** optional `MMDDYYYY` (day folder name) and optional `force`.

## Phase 1 — Preflight (no agents; abort early with ONE specific message)

1. **Resolve the day folder** under `knowledge-base/es/`. A folder is
   "complete" when it contains all three docs of step 2. With `MMDDYYYY`
   use that folder. Without one, order complete folders chronologically by
   the date prefix of their `*_ES_TP.md` re-keyed as `YYYYMMDD` (never by
   folder name) and pick the latest without a `*_ES_KEYS.md`. If `force`
   was given without a day argument, pick the latest complete folder and
   overwrite its keys file. If every complete folder already has a
   `*_ES_KEYS.md` and neither a day argument nor `force` was given →
   abort naming the most recent keys file and telling the user to pass a
   day argument (with `force`) to regenerate a specific day.
2. **Locate the three docs** by suffix: `*_ES_TP.pdf`, `*_ES_TP.md`,
   `*_ES_RECAP.md`. Any missing → abort naming exactly which suffix is
   absent.
3. **Derive the date** from the 8-digit `MMDDYYYY` prefix of the two TP doc
   FILENAMES (they must agree; a conflict aborts showing both names; the
   recap is named for the prior session and is exempt). Convert to
   `YYYY-MM-DD`. `<prefix>` = that 8-digit prefix.
4. **Discover general docs:** every file under `knowledge-base/general/`
   (recursive); empty or missing → proceed with none.
4b. **Locate the methodology doc:** `knowledge-base/methods/seven-keys.md`,
   resolved to an absolute path. This is where the Seven Keys themselves are
   defined — it deliberately lives OUTSIDE `knowledge-base/general/`, because
   everything in `general/` is injected into every benchmark variant and
   would defeat the bench's keys-free `base` baseline. Missing → abort; this
   skill cannot grade zones against a methodology it cannot read.
5. **Discover the lookback set:** the up-to-three most recent complete day
   folders strictly BEFORE the target date (chronological by TP-doc
   prefix) that already contain a `*_ES_KEYS.md`. For each lookback day P,
   also resolve its **outcome recap**: the `*_ES_RECAP.md` of the next
   complete day folder chronologically after P — recaps describe the prior
   session, so P's outcome lives in the following day's recap (for the
   most recent lookback day this is usually the target day's own recap).
   No such recap → pair P with no outcome. Zero lookback days → bootstrap:
   the lookback agent is skipped entirely.
6. **Guards:**
   - **Benchmark immutability (always, `force` or not):** any existing
     benchmark cell under ANY variant that consumes this day's keys file
     means the file is immutable — regeneration is forbidden even if the
     file was deleted. Derive the consuming variant ids by running
     `node -e "import('./src/features.js').then((m) => console.log(m.consumingVariants(m.collectFeatures('features'), 'seven-keys').join(' ')))"`
     — the tested helper returns every feature this skill generates for,
     plus every combo whose `combines` includes one of those. For each
     consuming id `<v>`, check
     `ls runs/*/*/<day>/<v>/run-*.json 2>/dev/null`; any hit → abort naming
     the variant that froze it: the remedy is a new benchmark era, not an
     edit. (Derived, not hardcoded, so a renamed scorecard feature or a new
     combo consuming the artifact is protected automatically — the failure
     the old literal `seven-keys-scorecard` segment could not catch.)
   - **Overwrite:** if the target day already has a `*_ES_KEYS.md` and
     `force` was not given → abort naming the file and telling the user to
     pass `force`.

## Phase 2 — ONE Workflow invocation (four agents)

Inline the resolved values into `DATE` / `DOCS` / `GENERAL` / `LOOKBACK` —
do NOT pass them through Workflow `args`. `LOOKBACK` entries are ordered
oldest first; `outcome` is `null` when no outcome recap exists.

```js
export const meta = {
  name: 'seven-keys',
  description: 'Assess the day zones on Keys 3-7 with lookback and verification',
  phases: [
    { title: 'Analyze', detail: 'current-day + lookback analysts' },
    { title: 'Synthesize', detail: 'weighted merge into the artifact' },
    { title: 'Verify', detail: 'scorecard checked against the trade plan' },
  ],
}
const DATE = '<YYYY-MM-DD>'
const DOCS = {
  pdf: '<absolute path to *_ES_TP.pdf>',
  plan: '<absolute path to *_ES_TP.md>',
  recap: '<absolute path to *_ES_RECAP.md>',
}
const GENERAL = [
  '<absolute path to each file under knowledge-base/general/, or empty array>',
]
const METHOD_DOC = '<absolute path to knowledge-base/methods/seven-keys.md>'
const LOOKBACK = [
  { day: '<MMDDYYYY>', keys: '<absolute path to that day *_ES_KEYS.md>', outcome: '<absolute path to its outcome recap, or null>' },
]
const NL = String.fromCharCode(10)
const CURRENT_SCHEMA = {
  type: 'object',
  required: ['bias', 'environment', 'zones'],
  properties: {
    bias: { type: 'string', maxLength: 300 },
    environment: { type: 'string', maxLength: 400 },
    zones: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['prices', 'side', 'key3', 'key4', 'key5', 'key6', 'key7', 'grade'],
        properties: {
          prices: { type: 'string', maxLength: 40 },
          side: { enum: ['support', 'resistance'] },
          key3: { type: 'string', maxLength: 200 },
          key4: { type: 'string', maxLength: 200 },
          key5: { type: 'string', maxLength: 200 },
          key6: { type: 'string', maxLength: 200 },
          key7: { type: 'string', maxLength: 200 },
          grade: { enum: ['automatic-fade', 'strong', 'moderate', 'weak'] },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
}
const LOOKBACK_SCHEMA = {
  type: 'object',
  required: ['calibration', 'continuity'],
  properties: {
    calibration: {
      type: 'array',
      items: {
        type: 'object',
        required: ['day', 'verdict'],
        properties: {
          day: { type: 'string', maxLength: 8 },
          verdict: { type: 'string', maxLength: 300 },
        },
        additionalProperties: false,
      },
    },
    continuity: { type: 'array', items: { type: 'string', maxLength: 300 } },
  },
  additionalProperties: false,
}
const SYNTH_SCHEMA = {
  type: 'object',
  required: ['artifact'],
  properties: { artifact: { type: 'string' } },
  additionalProperties: false,
}
const VERIFY_SCHEMA = {
  type: 'object',
  required: ['pass', 'mismatches'],
  properties: {
    pass: { type: 'boolean' },
    mismatches: { type: 'array', items: { type: 'string', maxLength: 300 } },
  },
  additionalProperties: false,
}

phase('Analyze')
const generalBlock = GENERAL.length
  ? `First Read ALL of these general trading-strategy documents — session-agnostic context for how zones are built and traded:
${GENERAL.map((g) => `- ${g}`).join(NL)}

`
  : ''
const [current, lookback] = await parallel([
  () =>
    agent(
      `You are the current-day Seven-Keys zone analyst for the ${DATE} ES (E-mini S&P 500) session.

${generalBlock}Read the three documents for the session:
1. Trade plan worksheet (PDF, support/resistance zones): ${DOCS.pdf}
2. Trade plan video transcript: ${DOCS.plan}
3. Prior-session recap transcript: ${DOCS.recap}

Read the Seven-Keys methodology at ${METHOD_DOC} — that document defines the keys you are grading against. Keys 1-2 (expectancy; no price confirmation) are trader behaviors and are NOT your job. Assess EVERY support/resistance zone in the trade plan against Keys 3-7:
- key3: the likely approach into the zone (exhaustion, first test vs retest)
- key4: the zone's timeframe significance
- key5: whether a significant prior move launched from it
- key6: alignment with the larger-timeframe bias
- key7: confluence — how many keys stack here

Copy each zone's prices EXACTLY as the trade plan states them (e.g. "7495.25-7502.75") — never round, invent, or merge zones. Grade each zone automatic-fade | strong | moderate | weak, where automatic-fade means several keys stack so strongly that intraday price action gets no weight. The grade is a same-day filter, not an abstract quality ranking: factor in whether the zone can realistically be tested this session — a zone with excellent larger-timeframe pedigree that sits beyond any plausible single-session move grades moderate at best, with the pedigree recorded in its key4/key5 cells rather than the grade. Grades must discriminate at the top: strong and automatic-fade together should mark only the few zones a trader should prioritize today — no more than about a third of the sheet — and moderate is a deliberate middle call, not a default bucket; it is fine for many distant zones to collapse into weak. Also state the day's larger-timeframe bias and any environment/volatility notes (scheduled reports, range vs directional).`,
      { label: 'current-day', phase: 'Analyze', schema: CURRENT_SCHEMA, model: 'claude-fable-5' }
    ),
  ...(LOOKBACK.length
    ? [
        () =>
          agent(
            `You are the lookback calibration analyst for the ${DATE} ES session. Read each prior day's Seven-Keys assessment together with the recap that describes how that day's session ACTUALLY traded:

${LOOKBACK.map((l) => `- Day ${l.day}: assessment ${l.keys}${l.outcome ? ` and outcome recap ${l.outcome}` : ' (no outcome recap available)'}`).join(NL)}

For each prior day, judge from its outcome recap whether the highly graded zones actually held — flag grades that proved wrong, do not smooth them over (one calibration entry per prior day). Then note continuity: zones recurring across days, bias evolution, and anything that should sharpen today's assessment. You are advisory: today's analyst outranks you.`,
            { label: 'lookback', phase: 'Analyze', schema: LOOKBACK_SCHEMA }
          ),
      ]
    : []),
])
if (!current) throw new Error('current-day analyst returned no assessment')
if (LOOKBACK.length && !lookback) log('lookback analyst returned nothing — proceeding without lookback')

phase('Synthesize')
const sources = lookback
  ? LOOKBACK.map((l) => `${l.keys.split('/').pop()}${l.outcome ? ` (outcome: ${l.outcome.split('/').pop()})` : ''}`).join(' · ')
  : 'none — bootstrap'
const synth = await agent(
  `You are the synthesizer producing the ${DATE} ES Seven-Keys artifact. Do not read any files. Your two inputs:

CURRENT-DAY ANALYSIS (authoritative):
${JSON.stringify(current, null, 2)}

LOOKBACK NOTES (advisory):
${lookback ? JSON.stringify(lookback, null, 2) : 'none — bootstrap'}

Weighting rule: the current-day analysis is authoritative. The lookback may sharpen wording, add calibration history, or annotate — it must NEVER change a zone's prices, add or drop zones, or override a current-day grade unless the current-day evidence itself is ambiguous. Keep every zone's prices EXACTLY as given.

Return the artifact as markdown in exactly this shape (no frontmatter — it is added later):

# Seven Keys — ES ${DATE}

**Larger-timeframe bias:** <one or two sentences>
**Environment notes:** <one or two sentences>

Keys 1–2 (expectancy; no price confirmation) are trader-behavior keys and remain the responsibility of each persona. Zones below are scored on Keys 3–7.

## Zone scorecard (Keys 3–7)

| Zone (prices) | Side | Key 3 approach | Key 4 timeframe | Key 5 prior launch | Key 6 bias align | Key 7 confluence | Grade |
|---|---|---|---|---|---|---|---|
<one row per zone, cells terse, side values lowercase (support/resistance)>

## Automatic-fade candidates

<bullet list of zones graded automatic-fade, or "- None today.">

## Lookback

Sources: ${sources}

<calibration-aware bullets, including any prior grades that proved wrong, or "- none — bootstrap">`,
  { label: 'synthesize', schema: SYNTH_SCHEMA }
)
if (!synth) throw new Error('synthesizer returned no artifact')

phase('Verify')
const verdict = await agent(
  `You are a fidelity verifier. Read these two trade-plan documents for the ${DATE} ES session:
1. ${DOCS.pdf}
2. ${DOCS.plan}

Below is a synthesized Seven-Keys scorecard. Check EVERY row of its zone table against those documents: the zone's prices and side (support/resistance) must match a zone actually present in the trade plan — no invented zones, no dropped-then-substituted zones, no transposed or rounded prices. Do NOT judge grades, bias, or wording — fidelity to the source zones only. Return pass=true only if every row checks out; otherwise pass=false with one mismatch string per problem row.

ARTIFACT:
${synth.artifact}`,
  { label: 'verify', schema: VERIFY_SCHEMA }
)
if (!verdict) return { verified: false, mismatches: ['verifier agent returned nothing'], artifact: synth.artifact, lookbackUsed: false }
return { verified: verdict.pass, mismatches: verdict.mismatches, artifact: synth.artifact, lookbackUsed: Boolean(lookback) }
```

If the Workflow invocation fails or returns no result object, abort without
writing anything; a rerun regenerates cleanly.

## Phase 3 — Write and commit (only when verified)

1. If `verified` is `false` → abort WITHOUT writing the keys file. Show the
   user every mismatch string. Never write an unverified artifact.
2. Compose the file: YAML frontmatter, blank line, then `artifact` verbatim.

   ```markdown
   ---
   generatedBy: claude-fable-5
   generatedAt: <output of: date -u +%Y-%m-%dT%H:%M:%SZ>
   lookbackSources: [<the lookback keys filenames oldest first when the workflow returned lookbackUsed: true — otherwise []>]
   verified: true
   ---
   ```

   `generatedBy` is always `claude-fable-5` — the current-day analyst that
   produces the zone grades is pinned to that model in the workflow script
   regardless of which model this session runs as (a 2026-07-24 blind
   comparison found it more methodology-faithful and better-calibrated than
   Sonnet for this specific grading task). The synthesizer and verifier are
   lighter-weight formatting/fidelity passes and inherit the session model.

3. Write it to `<day folder>/<prefix>_ES_KEYS.md`, then commit exactly that
   file:

   ```bash
   git add "<day folder>/<prefix>_ES_KEYS.md"
   git commit -m "docs: add ES seven-keys assessment for <YYYY-MM-DD>"
   ```

4. Show the user the zone scorecard table and the lookback section inline.
