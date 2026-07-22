---
name: trader-bench
description: Top up the trader benchmark matrix — run every traders/*.md persona N independent times against every complete knowledge-base day, for one model, across a base variant plus every features/*.md variant (auto-generating and committing any missing feature artifacts, e.g. seven-keys-scorecard), writing one immutable JSON cell per (trader, model, day, variant, run-index) under runs/, then regenerate runs/SCOREBOARD.md. Use when the user asks to benchmark the traders, run the bench, or catch a new trader or feature up, optionally with a run count (/trader-bench 5) and/or model alias (/trader-bench 5 sonnet).
---

# Trader Bench — idempotent benchmark matrix top-up

One primitive: bring every trader to N runs on every complete
knowledge-base day, for one model, across every declared variant (`base`
plus every `features/*.md` feature, one at a time, plus any declared
`combines:` combos — components never combine implicitly)
— running ONLY missing cells. Personas think; this skill plumbs. The
backtest CLI is the SOLE judge of every setup — perform no validation of
setups yourself. Existing cells are write-once and NEVER rerun,
overwritten, or deleted.

**Arguments:** optional integer `N` (target runs per cell, default 5) and
optional model alias (default `fable`). Valid aliases and recorded ids:

| alias | model.id |
|---|---|
| fable | claude-fable-5 |
| opus | claude-opus-4-8 |
| sonnet | claude-sonnet-5 |
| haiku | claude-haiku-4-5-20251001 |

Any other alias → abort listing the valid aliases.

## Phase 1 — Preflight (no bench agents — step 10 may run feature-generator sub-flows; abort early with ONE specific message)

1. **Discover personas:** every `traders/*.md`; persona name = the `name:`
   frontmatter value (fall back to filename without `.md`). None → abort
   pointing at `traders/`.
2. **Immutability guard:** compute each persona file's hash with
   `shasum -a 256 traders/<file>.md`. Read `personaSha256` from every
   existing `runs/<trader>/*/*/*/run-*.json` for that trader (any model,
   any day, any variant). If any existing cell's hash differs from the
   current file's hash, abort naming the trader, both hashes, and the
   remedy: trader files are immutable once benchmarked — create a NEW
   trader file instead of editing this one.
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
6. **General docs guard:** compute `generalSha256` by hashing the
   concatenation of every file from step 5, in sorted path order. Missing
   or empty directory → use the fixed value
   `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (the
   SHA-256 of zero bytes) WITHOUT running the command below — `cat` with no
   file arguments blocks reading stdin instead of exiting. Otherwise run
   exactly:

   ```bash
   find knowledge-base/general -type f | sort | xargs cat | shasum -a 256
   ```

   and take the hash field (before the two spaces). Read `generalSha256`
   from every existing `runs/*/*/*/*/run-*.json` (every trader, model, day,
   and variant — general docs are injected into every variant including
   `base`, so every existing cell carries this field). If any existing
   cell's hash differs from the freshly computed hash, abort naming both
   hashes and the remedy: general docs are frozen once benchmarked — revert
   the edit, or start a new benchmark era.
7. **Discover and validate features:** run
   `node -e "import('./src/features.js').then((m) => console.log(JSON.stringify(m.collectFeatures('features'))))"`.
   A nonzero exit means a definition violates validation (an id that is not
   a kebab-case slug, the reserved id `base`, duplicate ids, an empty body,
   `artifactSuffix` without `generatorSkill`, a `${ARTIFACT}` placeholder
   mismatch, a `${DOC}` placeholder mismatch, or a `staticDoc` pointing at a
   missing file) — abort relaying its error message verbatim; the remedy is
   fixing the named feature file, and no cells have been touched. Otherwise
   the printed array gives each feature's `id`, `name`, `artifactSuffix`,
   `generatorSkill`, `staticDoc`, and prompt `block`. Entries may also
   carry `combines` (an ordered component-id list): such a feature is a
   COMBO — its `block` arrives pre-resolved with namespaced
   `${DOC:<component-id>}` / `${ARTIFACT:<component-id>}` placeholders
   (built by auto-concat, or authored as an override body), and its own
   `artifactSuffix`/`generatorSkill`/`staticDoc` are always null; every
   resource belongs to a component, found by id in this same array. Combo
   validation failures (unknown/nested component ids, own resource keys,
   bare or mismatched placeholders, an override body that skips an
   artifact-backed component, duplicate auto-concat twins, a component
   file removed while a combo still references it) surface as the same
   nonzero exit relayed verbatim; for a removed component the remedy is
   removing or retiring the referencing combo(s) in the same change. For
   every feature whose `staticDoc` is non-null, resolve it to an absolute
   path (repo root joined with `staticDoc`) — `collectFeatures` already
   confirmed the file exists, so this is a plain join, the same way
   `GENERAL`/`PERSONAS`/`DOCS_BY_DAY` are resolved to absolute paths
   elsewhere in this phase. `VARIANTS = ['base', ...featureIds]` (`base`
   always first); combo ids enter `VARIANTS` like any other feature id.
   No feature files at all → `VARIANTS = ['base']` only.
8. **Feature immutability guard:** compute each feature's hash from its OWN
   `file` field returned by step 7 (e.g. `seven-keys-method.md`) — run
   `shasum -a 256 features/<that file field>`, NOT `features/<id>.md`;
   `id` can come from frontmatter and differ from the filename, so hashing
   `features/<id>.md` can target a file that doesn't exist. Read
   `featureSha256` from every existing `runs/*/*/*/<id>/run-*.json`. If any
   existing cell's hash differs from the current file's hash, abort naming
   the feature, both hashes, and the remedy: feature files are immutable
   once benchmarked — create a NEW feature file (new `id`) instead of
   editing this one. For a COMBO, additionally hash every component's `file`
   field the same way and read `componentSha256s` from every existing
   `runs/*/*/*/<combo-id>/run-*.json`; any component hash mismatch aborts
   naming the combo, the component, and both hashes — same remedy: component
   files are frozen by the combos benchmarked on them.
9. **Static doc guard:** for every feature whose `staticDoc` is non-null,
   compute `staticDocSha256` with `shasum -a 256 <staticDoc>` using the
   repo-relative path `collectFeatures` returned (e.g.
   `shasum -a 256 knowledge-base/methods/seven-keys.md`) — NOT the resolved
   absolute path, matching how step 8 hashes the feature's own `file` field
   rather than its resolved form. Read `staticDocSha256` from every existing
   `runs/*/*/*/<id>/run-*.json` for that feature's id (same glob as step 8).
   If any existing cell's hash differs from the current file's hash, abort
   naming the feature, the doc's path, both hashes, and the remedy: static
   docs are immutable once benchmarked — point a NEW feature file (new `id`)
   at a new doc, or start a new benchmark era. For a COMBO, the guard covers
   each component's `staticDoc` (when declared) via the map key
   `staticDocSha256s.<component-id>` read from
   `runs/*/*/*/<combo-id>/run-*.json`, compared against the same freshly
   computed per-doc hashes.
10. **Feature artifacts (generate missing, per feature, oldest day first):**
    for every feature with both `artifactSuffix` and `generatorSkill`, every
    candidate day needs a `<prefix><artifactSuffix>` in its folder. BEFORE
    generating anything, for each (day, feature) whose artifact is missing,
    check `runs/*/*/<day>/<v>/run-*.json` for EVERY consuming variant
    `<v>` — the feature's own id plus every combo whose `combines`
    includes it: a hit means that combination is already benchmarked, so
    its artifact is frozen and was deleted — abort naming the day and
    feature, remedy: restore the artifact from git or start a new
    benchmark era. Generating first and letting step
    11's hash compare catch it would abort only AFTER committing a fresh
    artifact that contradicts the frozen cells. For the remaining days
    missing one, run that feature's `generatorSkill` flow (its own phases,
    committing each artifact; invoke it with that day's `MMDDYYYY` argument)
    sequentially in chronological order, oldest first — independently per
    feature, so each feature's own lookback (if it has one) sees only its
    own predecessors. A day whose generation aborts for a given feature is
    SKIPPED for that (day, feature) combination only — listed with the
    reason — leaving `base` and every other feature's cells for that day
    unaffected. Then compute each remaining (day, feature) artifact's hash:
    `shasum -a 256 <day folder>/<prefix><artifactSuffix>`.
11. **Artifact immutability guard:** for each (day, feature) combination
    from step 10, check `runs/*/*/<day>/<feature-id>/run-*.json`. Any match
    means that combination already has benchmark cells — compare the
    current artifact hash against those cells' `artifactSha256`; a mismatch
    aborts naming the day, feature, and both hashes, remedy: artifacts are
    immutable once benchmarked — start a new benchmark era instead of
    editing them. No matching cells → nothing to guard, proceed. Combo cells
    freeze the same artifacts through their `artifactSha256s` map: for each
    (day, feature) also check every `runs/*/*/<day>/<combo-id>/run-*.json` of
    combos containing that feature and compare `artifactSha256s.<feature-id>`
    the same way.
12. **Compute the missing set:** for every (trader, day, variant) where
    variant ranges over `VARIANTS`, existing runs are
    `runs/<trader>/<alias>/<day>/<variant>/run-*.json`; missing indices
    are `1..N` minus the indices present. Existing cells beyond N are left
    alone. For an artifact-backed feature, every (trader, day, feature-id)
    combination whose (day, feature) artifact is still missing after step 10
    (generation failed or was skipped) is EXCLUDED from the missing set
    entirely — a feature cell must never be run or written without its
    artifact; step 13 reports these as skipped, never as cells to run. A
    COMBO cell needs every artifact-backed component's (day, artifact) to be
    present: any component artifact still missing after step 10 excludes the
    combo's (trader, day, combo-id) combinations exactly like the component's
    own — reported separately per variant, never run.
13. **Report the plan, then proceed:** traders × days × variants × model
    alias, cells already present, cells to run, skipped days with reasons,
    skipped (day, feature) artifact failures. Example: "2 traders × 10
    days × 4 variants (base, seven-keys-method, seven-keys-scorecard,
    seven-keys-both) × fable, target N=5: 112 cells exist, 288 to run."
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
  },
}
const PERSONAS = {
  '<persona name>': '<absolute path to traders/<persona>.md>',
}
// A feature body is multi-line prose and routinely contains apostrophes, so
// it CANNOT go in a single-quoted literal — and a backtick literal would
// interpolate ${ARTIFACT}/${DOC} into a ReferenceError. Inline each line as
// its own DOUBLE-quoted string and join them, which needs no backslash
// escapes at all: double quotes tolerate apostrophes, and
// String.fromCharCode(10) supplies the newline without a \n escape
// sequence. (Use single quotes for any individual line that itself contains
// a double quote.) Leave both ${ARTIFACT} and ${DOC} intact here — they are
// substituted below, not at construction time. Do NOT try to read the
// feature file here — Workflow scripts have no filesystem access.
const NL = String.fromCharCode(10)
const FEATURES = {
  '<plain feature id>': {
    block: [
      "<lines of the body, ${ARTIFACT} and ${DOC} left intact, one double-quoted string per line per the comment above>",
    ].join(NL),
    // Both BARE booleans, never quoted — the string 'false' is truthy, which
    // would send a feature with no artifact (or no static doc) down that
    // substitution path and kill every one of its cells on the matching
    // missing-path throw below.
    artifact: <true if the feature has artifactSuffix, else false>,
    hasDoc: <true if the feature has staticDoc, else false>,
    docPath: <absolute path string if hasDoc, else null>,
    combines: null,
  },
  '<combo id>': {
    block: [
      "<lines of the RESOLVED combo block from step 7, namespaced ${DOC:id}/${ARTIFACT:id} left intact>",
    ].join(NL),
    // Combos never use the scalar keys above.
    artifact: false,
    hasDoc: false,
    docPath: null,
    combines: ['<component id>', '<component id>'],
    // Absolute per-component staticDoc paths — ONLY components that declare
    // one appear here; possibly empty, but the key itself is always present.
    docPaths: { '<component id>': '<absolute staticDoc path>' },
    // Component ids that declare artifactSuffix, possibly empty.
    artifactComponents: ['<component id>'],
  },
}
// Keyed by artifact-OWNING feature/component ids.
const ARTIFACTS_BY_DAY = {
  '<MMDDYYYY>': {
    '<feature id>': '<absolute path to that day\'s <prefix><artifactSuffix> — only present for features with an artifact>',
  },
}
const CELLS = [
  { trader: '<persona name>', day: '<MMDDYYYY>', variant: '<"base" or a feature id>', runIndex: 1 },
]
const SETUP_SCHEMA = {
  type: 'object',
  required: ['side', 'entry', 'stopLoss', 'takeProfit', 'rationale', 'primaryZone', 'confidence'],
  properties: {
    side: { enum: ['long', 'short'] },
    entry: { type: 'number' },
    stopLoss: { type: 'number' },
    takeProfit: { type: 'number' },
    rationale: { type: 'string', maxLength: 400 },
    primaryZone: { type: 'string', maxLength: 100 },
    confidence: { type: 'integer', minimum: 1, maximum: 5 },
    rejectedAlternative: { type: 'string', maxLength: 200 },
  },
  additionalProperties: false,
}
phase('Setups')
const generalBlock = GENERAL.length
  ? `Next Read ALL of these general trading-strategy documents — session-agnostic guidance that applies to every trade and constrains how this persona operates:` + NL +
    GENERAL.map((g) => `- ${g}`).join(NL) + NL + NL
  : ''
const results = await parallel(CELLS.map((cell) => () => {
  const docs = DOCS_BY_DAY[cell.day]
  // docPath is inlined once per feature (step 7), not looked up per (day,
  // feature) the way artifactPath is below — a static doc doesn't vary by
  // day, and collectFeatures already confirmed the file exists before this
  // script was ever assembled. So a missing docPath here is NOT a
  // legitimate per-cell runtime state the way a missing artifact can be
  // (artifact generation genuinely can fail for one specific day) — it can
  // only mean the FEATURES constant was built wrong. The throw stays
  // anyway, for the same containment reason as the artifact one below:
  // parallel() resolves a thunk that throws to null in the results array
  // and never rejects, so an authoring slip loses only that feature's
  // cells (reported as an anomaly) instead of silently sending every one of
  // its prompts out with a literal "${DOC}" still in the text.
  //
  // Preflight step 12 excluded every artifact-less (day, feature) cell, so a
  // missing path here IS a legitimate signal of a preflight bug: fail the
  // cell loudly rather than silently prompting with an empty artifact path.
  // Throwing is contained, not fatal to the run — same mechanism as above —
  // so this cell alone is lost and gets reported as an anomaly. For
  // combos, ARTIFACTS_BY_DAY is keyed by the artifact-owning COMPONENT id
  // (unchanged — component ids are feature ids), and docPaths is inlined
  // per component the same way docPath is for plain features.
  const featureBlock = (() => {
    if (cell.variant === 'base') return ''
    const feature = FEATURES[cell.variant]
    let block = feature.block
    if (feature.combines) {
      for (const compId of Object.keys(feature.docPaths)) {
        block = block.replaceAll('${DOC:' + compId + '}', feature.docPaths[compId])
      }
      for (const compId of feature.artifactComponents) {
        const artifactPath = ARTIFACTS_BY_DAY[cell.day]?.[compId]
        if (!artifactPath) throw new Error('missing artifact for ' + cell.day + '/' + compId)
        block = block.replaceAll('${ARTIFACT:' + compId + '}', artifactPath)
      }
      // Any placeholder that survives substitution can only mean the FEATURES
      // constant was authored wrong — fail this cell loudly (contained by
      // parallel(), reported as an anomaly) rather than prompting with a
      // literal placeholder.
      if (block.indexOf('${DOC:') !== -1 || block.indexOf('${ARTIFACT:') !== -1) {
        throw new Error('unresolved placeholder in ' + cell.variant)
      }
      return block + NL + NL
    }
    if (feature.hasDoc) {
      if (!feature.docPath) throw new Error('missing static doc for ' + cell.variant)
      block = block.replaceAll('${DOC}', feature.docPath)
    }
    if (!feature.artifact) return block + NL + NL
    const artifactPath = ARTIFACTS_BY_DAY[cell.day]?.[cell.variant]
    if (!artifactPath) throw new Error('missing artifact for ' + cell.day + '/' + cell.variant)
    return block.replaceAll('${ARTIFACT}', artifactPath) + NL + NL
  })()
  return agent(
    `You are a futures trading persona on an independent benchmark run. First Read the persona file at ${PERSONAS[cell.trader]} and fully adopt that trading identity — its bias, entry style, stop and target logic.` + NL + NL +
    generalBlock +
    featureBlock +
    `Then Read the three documents for the ${docs.date} ES (E-mini S&P 500) session:` + NL +
    `1. Trade plan worksheet (PDF, support/resistance zones): ${docs.pdf}` + NL +
    `2. Trade plan video transcript: ${docs.plan}` + NL +
    `3. Prior-session recap transcript: ${docs.recap}` + NL + NL +
    `As this persona, commit to exactly ONE trade for the session: long or short. ` +
    `Anchor your entry, stop loss, and take profit to the support/resistance zones in the trade plan. ` +
    `Prices are ES index points in quarter-point increments (e.g. 7530.25). ` +
    `A long requires stopLoss < entry < takeProfit; a short requires takeProfit < entry < stopLoss. ` +
    `Include a rationale of at most 50 words citing which plan level(s) you are using. ` +
    `Also report primaryZone (the specific price zone you anchored to, e.g. "7481.75-7495.75"), ` +
    `confidence (an integer 1-5 for how strongly you favored this setup over any alternative), ` +
    `and, only if you seriously weighed a different zone or side, rejectedAlternative ` +
    `(at most 30 words: what it was and why you passed on it).`,
    { label: `${cell.trader}/${cell.day}/${cell.variant}#${cell.runIndex}`, schema: SETUP_SCHEMA, model: MODEL }
  ).then((setup) => ({ ...cell, setup }))
}))
log(`${results.filter(Boolean).length}/${CELLS.length} cells returned setups`)
return results.filter(Boolean)
```

If the Workflow invocation itself fails or returns no results array at all, abort WITHOUT writing any cells — the matrix stays untouched and a rerun tops up cleanly. When the Workflow succeeds, any individual cell absent from the returned array (its agent died) gets a cell file in Phase 3 with status `NO_SETUP` and no `setup` key; the bench continues — with the exceptions Phase 3 names, where a dropped cell missing any Phase 1 hash its schema requires (scalar or map form) gets no file at all.

## Phase 3 — Judge and persist (no validation of your own)

For each returned setup, in the session scratchpad write
`bench-<trader>-<day>-<variant>-<runIndex>.json` (NO_SETUP cells skip the
CLI and go straight to the cell-file write):

```json
[{ "id": "<trader>", "side": "<side>", "entry": <entry>, "stopLoss": <stopLoss>, "takeProfit": <takeProfit> }]
```

Then run (capturing stdout AND stderr separately):

```bash
node src/cli.js run --data "$CSV" --orders <scratchpad>/bench-<trader>-<day>-<variant>-<runIndex>.json --date "<YYYY-MM-DD>" --json
```

Interpret strictly by the CLI's verdict:

- exit 0 → parse the JSON; `orders[0]` gives `status` (TP | SL | EOD |
  NOT_FILLED), `points`, `dollars`, `fillTime`, `exitTime`, and now also
  `maxAdverseExcursion`, `maxFavorableExcursion`, `rMultiple` (all `null`
  for `NOT_FILLED`, populated for every other status) and `closestApproach`
  (populated only for `NOT_FILLED`, `null` otherwise). A far-off entry is
  simply `NOT_FILLED` — that IS the answer.
- exit 1 and stderr matches the CLI's order-validation wording (`requires
  stopLoss < entry < takeProfit` / `requires takeProfit < entry <
  stopLoss` / `must be a number`) → status `INVALID`, `note` = that stderr
  line.
- exit 1 otherwise → status `CLI_ERROR`, `note` = the stderr line.

Never fix, clamp, or re-request a persona's prices.

Write each cell to
`runs/<trader>/<alias>/<day>/<variant>/run-<runIndex>.json` (create
directories as needed). If the file already exists, do NOT overwrite it —
record the anomaly for the final summary and move on. Cell format:

```json
{
  "trader": "<persona name>",
  "model": { "alias": "<alias>", "id": "<model.id from the table>" },
  "day": "<MMDDYYYY>",
  "date": "<YYYY-MM-DD>",
  "variant": "<\"base\" or a feature id>",
  "runIndex": <k>,
  "timestamp": "<current ISO-8601 UTC time>",
  "personaSha256": "<hash from Phase 1>",
  "generalSha256": "<hash from Phase 1 step 6 — present on EVERY cell, including base and NO_SETUP>",
  "featureSha256": "<hash of features/<variant>.md from Phase 1 — OMIT this key entirely when variant is \"base\">",
  "staticDocSha256": "<hash of the variant's staticDoc from Phase 1 step 9 — OMIT this key entirely when the variant has no staticDoc>",
  "artifactSha256": "<the day's artifact hash for this variant from Phase 1 — OMIT this key entirely when the variant has no artifactSuffix>",
  "combines": ["<component ids — ONLY on combo cells, verbatim from the feature>"],
  "componentSha256s": { "<component id>": "<that component FILE's hash from Phase 1 — ONLY on combo cells>" },
  "staticDocSha256s": { "<component id>": "<its staticDoc hash — ONLY on combo cells; keys only for components declaring one; omit the whole map when none do>" },
  "artifactSha256s": { "<component id>": "<the day's artifact hash — ONLY on combo cells; keys only for artifact-backed components; omit the whole map when none are>" },
  "setup": { "side": "...", "entry": 0, "stopLoss": 0, "takeProfit": 0, "rationale": "...", "primaryZone": "...", "confidence": 0, "rejectedAlternative": "..." },
  "result": { "status": "...", "points": 0, "dollars": 0, "fillTime": "<from CLI JSON, verbatim>", "exitTime": "<from CLI JSON, verbatim>", "maxAdverseExcursion": 0, "maxFavorableExcursion": 0, "rMultiple": 0, "closestApproach": null },
  "note": "<only for INVALID / CLI_ERROR>"
}
```

Omit `setup` for NO_SETUP cells; `result` is then `{ "status": "NO_SETUP" }`.
For NOT_FILLED, keep the CLI's null points/dollars/fillTime/exitTime as
null. Statuses INVALID and CLI_ERROR keep the submitted `setup` and use
`result` = `{ "status": "INVALID" }` / `{ "status": "CLI_ERROR" }` plus the
top-level `note` — no CLI order object was ever produced for these, so
`result` carries no `maxAdverseExcursion`/`maxFavorableExcursion`/
`rMultiple`/`closestApproach` keys at all, exactly like today's `points`/
`dollars`/`fillTime`/`exitTime` are already absent from those two statuses.
For every other status, copy `maxAdverseExcursion`/`maxFavorableExcursion`/
`rMultiple`/`closestApproach` into `result` verbatim from the CLI's JSON —
no validation of your own, same as every other CLI-reported field. In
`setup`, omit `rejectedAlternative` entirely when the persona didn't return
it (`SETUP_SCHEMA` doesn't require it); `primaryZone` and `confidence` are
always present, same as `side`/`entry`/`stopLoss`/`takeProfit`/`rationale`.
Every cell — including NO_SETUP — records `variant`,
`personaSha256`, and `generalSha256`. Plain feature cells use the scalar
`featureSha256` / `staticDocSha256` / `artifactSha256` rules above and NEVER
the map forms; combo cells always record `combines`, `featureSha256` (the
combo file itself), and `componentSha256s`, plus the map-form
`staticDocSha256s` / `artifactSha256s` per their omission rules, and NEVER
the scalar doc/artifact keys — all regardless of cell status. A dropped
(null) cell for a combo missing ANY Phase 1 hash its schema requires
(component, static doc, or that day's artifact) gets NO cell file — record
it as an anomaly, exactly like the existing artifact/doc-backed exception.

An artifact-backed variant cell without an `artifactSha256`, or a
doc-backed variant cell without a `staticDocSha256`, is invalid by
construction — Phase 1 step 12 excluded every (day, feature) combination
lacking its artifact, and every feature's `staticDoc` (when declared) was
already resolved and hashed in step 9, so no such cell should ever reach
this phase. If a dropped (null) cell for an artifact-backed variant has no
Phase 1 artifact hash, or for a doc-backed variant has no Phase 1
staticDocSha256 (either Phase 2 missing-path backstop fired), write NO cell
file for it — record it as an anomaly in the final summary instead.

## Phase 4 — Scoreboard and commit

```bash
node src/cli.js scoreboard
git add runs/
git commit -m "bench(<alias>): add <count> cells across <T> traders / <D> days / <V> variants"
```

If Phase 1 found nothing missing, still regenerate the scoreboard; commit
only if `git status` shows changes (message
`bench(<alias>): regenerate scoreboard`).

Finally, show the user the scoreboard's Ranking table inline, plus the
Feature Impact section (if any non-base variant has cells), the
skipped-day list, any skipped (day, feature) artifact failures, and any
write-anomalies.
