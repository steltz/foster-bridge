# Benchmark Feature-Toggle Matrix — Design Spec

**Date:** 2026-07-18
**Status:** Approved design, pending implementation plan
**Supersedes-in-part:** `2026-07-18-trader-bench-design.md`, `2026-07-18-seven-keys-design.md`
(storage layout, guard mechanics, and scoreboard grouping below replace those
docs' corresponding sections; the seven-keys generation workflow itself is
unchanged)

## Purpose

Today `/trader-bench` benchmarks a three-dimensional matrix — **(trader,
model, day)**, N runs each — and the shared Seven-Keys zone assessment is
unconditionally baked into every persona's prompt. There's no way to ask
"does giving personas the Seven-Keys assessment actually help?", and no
general mechanism for testing any other future addition to what a persona
is told before it commits to a trade.

This spec adds a fourth matrix dimension, **variant**, and a `features/`
directory (mirroring `traders/`) so any future prompt-content idea can be
benchmarked head-to-head against a no-feature baseline without bespoke code
per feature. Seven-Keys becomes the first feature, migrating out of
`trader-bench`'s hardcoded logic into `features/seven-keys.md`.

Motivating use case: **feature validation.** A feature is a hypothesis
("giving personas the shared zone scorecard improves outcomes"). The matrix
should let that hypothesis be checked the same way trader quality is
checked today — same days, same model, same run count, base vs. feature —
and the result should show up in the scoreboard as a delta, not just a
feeling.

## Non-goals

- Combinatorial testing of multiple simultaneous features. This spec adopts
  **baseline + one-feature-at-a-time**: N runs of `base` (no features) plus
  N runs of each declared feature, individually. Feature *interactions*
  (feature A + B together) are out of scope; if that's ever needed, it's a
  separate future spec, not a variant explosion here.
- Changing `/trader-panel`. It stays exactly as it is today: unconditional
  Seven-Keys, one setup per persona, `*_ES_PANEL.md` output. It is the
  "best known configuration" daily production report; the bench is where
  experiments happen.
- Features that alter anything other than prompt content (backtest CLI
  flags, engine behavior, persona text itself). A feature is purely an
  extra block of context/instructions appended to the persona's prompt,
  optionally backed by a generated per-day artifact — the same shape
  Seven-Keys already has.
- Preserving existing `runs/` data. This is a clean break: `runs/` and
  `runs/SCOREBOARD.md` are wiped and regenerated from scratch under the new
  schema. No archival, no migration of old cells.
- Cross-variant, cross-trader, or cross-model P&L aggregation, anywhere,
  ever (unchanged invariant from the original bench design).

## `features/*.md` — feature definitions

One file per feature, in a new top-level `features/` directory, in the same
spirit as `traders/*.md`: adding a feature to the benchmark is authoring one
new markdown file, nothing else.

```markdown
---
id: seven-keys
name: Seven Keys zone assessment
artifactSuffix: _ES_KEYS.md
generatorSkill: seven-keys
---
Read the shared Seven-Keys assessment at ${ARTIFACT} — the shared scorecard
of the day's zones. Adopt its per-zone key scores rather than re-deriving
them; apply your persona's style to choose among the zones it grades.
```

Frontmatter fields:

- `id` (required) — kebab-case slug. Used as the variant name and directory
  segment. Falls back to the filename (without `.md`) if absent, matching
  the trader `name:` fallback convention.
- `name` (optional) — human-readable label used in scoreboard tables and
  section headers. Defaults to `id`.
- `artifactSuffix` (optional) — a day-folder filename suffix (e.g.
  `_ES_KEYS.md`), following the same `*_ES_TP.pdf`-style suffix convention
  the rest of the repo uses to find per-day docs. Present only if this
  feature needs a generated artifact.
- `generatorSkill` (optional, required if `artifactSuffix` is present) —
  the name of a skill that, given a `MMDDYYYY` argument, generates and
  commits `<prefix><artifactSuffix>` into that day's folder, aborting
  cleanly without writing anything on failure. `seven-keys` already
  satisfies this contract unchanged; any future artifact-backed feature
  must implement the same contract.

Body (everything after the closing `---`) is the literal prompt-block
text injected for this feature's variant. If the feature is artifact-backed,
the body must contain the literal placeholder `${ARTIFACT}`, replaced at
prompt-construction time with that day's resolved absolute artifact path.
A feature with no `artifactSuffix` has no placeholder — its body is
injected verbatim (a future example: a static instruction like "end every
rationale with a one-sentence risk note").

Feature definitions are validated at discovery time (Guard #0, below): an
id must be a kebab-case slug, since it becomes a directory segment;
`base` is reserved and may not be used as an id; two files may not resolve
to the same id (whether via `id:` frontmatter or the filename fallback);
the body may not be empty;
`artifactSuffix` requires `generatorSkill`; an artifact-backed body must
contain the literal `${ARTIFACT}` placeholder, and a non-artifact body must
not contain it. Any violation aborts naming the offending file(s).

Feature files are immutable once benchmarked (see Guards, below) — the
remedy for changing one is a new feature file with a new `id`, exactly like
trader files.

## Variants and the matrix dimension

`trader-bench` discovers `features/*.md` the same way it discovers
`traders/*.md` (auto-discovery, no CLI change — dropping in a new feature
file is enough for the next `/trader-bench` run to notice it's missing that
variant's cells). The variant set for a bench run is:

```
VARIANTS = ['base', ...featureIds]
```

`base` is a reserved variant name meaning no feature block is injected —
the raw persona + general docs + day docs envelope trader-panel already
uses today, minus Seven-Keys.

The matrix is now **(trader, model, day, variant)**, N runs each. Cost
scales as `N × days × traders × (1 + features.length)` per model — adding
a feature roughly doubles bench cost per top-up (with one feature); this is
the accepted cost of the baseline + one-at-a-time design.

## Storage layout

```
runs/
  <trader>/
    <model-alias>/
      <MMDDYYYY>/
        base/                     — no feature block
          run-1.json … run-N.json
        <feature-id>/             — one feature's block only
          run-1.json … run-N.json
runs/SCOREBOARD.md
```

One new path segment (`<variant>/`) between day and run file, otherwise
unchanged from the original layout.

### Cell schema (`run-<k>.json`)

```json
{
  "trader": "context-trader",
  "model": { "alias": "fable", "id": "claude-fable-5" },
  "day": "07152026",
  "date": "2026-07-15",
  "variant": "seven-keys",
  "runIndex": 3,
  "timestamp": "<ISO-8601, recorded at write time>",
  "personaSha256": "<hash of traders/<trader>.md at run time>",
  "featureSha256": "<hash of features/<variant>.md at run time — absent for variant=base>",
  "artifactSha256": "<hash of that day's <prefix><artifactSuffix> at run time — absent if the variant has no artifact>",
  "setup": {
    "side": "long",
    "entry": 7574,
    "stopLoss": 7563.25,
    "takeProfit": 7606.25,
    "rationale": "<persona's ≤400-char rationale>"
  },
  "result": {
    "status": "TP",
    "points": 32.25,
    "dollars": 161.25,
    "fillTime": "<from CLI JSON, when present>",
    "exitTime": "<from CLI JSON, when present>"
  },
  "note": "<stderr line for INVALID / CLI_ERROR; absent otherwise>"
}
```

`variant` and `personaSha256` are present on every cell, including
`base`. `featureSha256` and `artifactSha256` are present only when
applicable (never for `base`; `artifactSha256` only for artifact-backed
features). Conversely, an artifact-backed variant cell *without*
`artifactSha256` is invalid by construction: cells are never written for a
(day, feature) combination whose artifact is absent — those combinations
are excluded from the missing set in preflight (Phase 1 step 10, below).
Everything else is unchanged from the original cell schema —
`result.status`, the CLI-is-sole-judge rule, `NO_SETUP`/`INVALID`/
`CLI_ERROR` handling, write-once immutability.

## Guards (all file-shape, path-existence, or hash-compare checks — no LLM)

0. **Feature definition validation** (shape checks on `features/*.md` at
   discovery time): an id that is not a kebab-case slug
   (`^[a-z0-9]+(-[a-z0-9]+)*$`); reserved id `base`; duplicate ids across
   files (frontmatter `id:` colliding with another file's `id:` or
   filename fallback); `artifactSuffix` without `generatorSkill`; an
   artifact-backed body missing `${ARTIFACT}`; `${ARTIFACT}` in a
   non-artifact body; or an empty body → abort naming the offending
   file(s). Enforced in `src/features.js` (`collectFeatures` throws), so
   the scoreboard CLI and the bench preflight reject invalid definitions
   identically.

   The slug rule is load-bearing, not cosmetic: `id` becomes a directory
   segment in `runs/.../<variant>/` and a scoreboard label. Without it, a
   quoted `id: "seven-keys"` creates a directory with literal quote
   characters, `id: sub/dir` escapes the intended path, and — worst —
   `id: Base` passes the exact-match reserved check while resolving to
   the *same directory* as `base` on a case-insensitive filesystem
   (macOS APFS default), silently merging a feature's cells into the
   baseline. That is precisely the corruption the reserved-id rule
   exists to prevent, so both rules are required and compose. An empty
   body is rejected for the same reason: a feature contributing no
   prompt text is behaviorally identical to `base` but consumes a full
   variant's worth of bench runs.
1. **Persona immutability** (unchanged in spirit, widened glob): compute
   each `traders/<t>.md`'s SHA-256; compare against `personaSha256` in
   every existing `runs/<t>/*/*/*/run-*.json` (model/day/variant wildcards).
   Mismatch → abort naming the trader and both hashes; remedy is a new
   trader file.
2. **Feature immutability** (new, same shape as #1): compute each
   `features/<id>.md`'s SHA-256; compare against `featureSha256` in every
   existing `runs/*/*/*/<id>/run-*.json`. Mismatch → abort naming the
   feature and both hashes; remedy is a new feature file with a new `id`.
3. **Artifact immutability** (generalizes the original Seven-Keys-specific
   guard): for each candidate day and each artifact-backed feature, if
   `runs/*/*/<day>/<feature-id>/run-*.json` exists at all, that
   (day, feature) artifact is frozen. Compare the current
   `<prefix><artifactSuffix>` hash against any existing cell's
   `artifactSha256` for that combination; mismatch → abort naming the day,
   feature, and both hashes; remedy is a new benchmark era, not an edit.
   This replaces the seven-keys skill's own repo-wide
   `grep -l keysSha256` guard with a simple existence check scoped to that
   feature's variant folder — see the seven-keys skill change below.

Guard #3 is a meaningful improvement over today: because the artifact
check is now scoped to *that day's that-feature* folder specifically
(rather than "any cell anywhere for this day"), a failed or skipped
artifact generation for one feature never blocks or gets confused with
another feature's or base's cells for the same day.

## `/trader-bench` changes

### Phase 1 — Preflight (updated)

Steps 1–5 (discover traders, persona guard, discover complete days, verify
candle coverage, discover general docs) are unchanged. Then:

6. **Discover features:** every `features/*.md`; feature id from `id:`
   frontmatter (fallback to filename). `VARIANTS = ['base', ...featureIds]`.
   No features declared → matrix degenerates to `base` only (equivalent to
   today's behavior). Definitions are validated here (Guard #0); any
   violation aborts naming the offending file(s).
7. **Feature immutability guard:** as above (Guard #2).
8. **Generate missing artifacts, per feature, oldest day first:** first,
   for each (day, feature) whose artifact is missing, check whether
   `runs/*/*/<day>/<feature-id>/run-*.json` exists — a hit means the
   artifact is frozen and was deleted, so abort *before* generating
   anything. Leaving this to Guard #3's hash compare would abort only
   after a fresh artifact had already been generated and committed,
   contradicting the frozen cells. Then, for each remaining candidate day
   missing `<prefix><artifactSuffix>`, invoke that feature's `generatorSkill` with
   the day argument (chronological, oldest first, so each feature's own
   lookback — if any — sees its own predecessors independently of other
   features). A generation failure skips that (day, feature) combination
   only — listed with reason — leaving `base` and every other feature's
   cells for that day unaffected. This replaces the old "keys generation
   failure skips the whole day" behavior.
9. **Artifact immutability guard:** as above (Guard #3), for every
   (day, feature) combination that now has an artifact.
10. **Compute the missing set:** for every (trader, day, variant),
    existing cells are `runs/<trader>/<alias>/<day>/<variant>/run-*.json`;
    missing indices are `1..N` minus existing. For an artifact-backed
    feature, every (trader, day, feature) combination whose (day, feature)
    artifact is still missing after step 8 (generation failed or was
    skipped) is EXCLUDED from the missing set entirely — a feature cell
    must never be run or written without its artifact; step 11 reports
    these as skipped, never as cells to run.
11. **Report the plan:** traders × days × variants × model, cells present,
    cells to run, skipped (day, feature) artifact failures, skipped days
    (doc/candle gaps, applies to all variants). Example: "2 traders × 10
    days × 2 variants (base, seven-keys) × fable, target N=5: 84 cells
    exist, 116 to run."

### Phase 2 — Fan-out (updated prompt construction only)

Each cell now carries a `variant`. The prompt-construction change is
localized to the block that used to unconditionally read:

```
Read the shared Seven-Keys assessment at ${docs.keys} — ...
```

This becomes a per-variant `featureBlock`, computed the same way
`generalBlock` is already conditionally built:

```js
const featureBlock = (() => {
  if (cell.variant === 'base') return ''
  const feature = FEATURES[cell.variant]
  if (!feature.artifact) return feature.block
  const artifactPath = ARTIFACTS_BY_DAY[cell.day]?.[cell.variant]
  if (!artifactPath) throw new Error('missing artifact for ' + cell.day + '/' + cell.variant)
  return feature.block.replaceAll('${ARTIFACT}', artifactPath)
})()
```

`FEATURES` (inlined constant, `{ '<id>': { block: '<raw markdown body>',
artifact: <boolean> } }` — `artifact` a bare boolean, never a quoted
string, since `'false'` is truthy and would route a feature with no
artifact down the artifact path) and `ARTIFACTS_BY_DAY` (inlined constant,
`{ '<day>': { '<feature-id>': '<absolute artifact path>' } }`) are resolved
in Phase 1 and inlined into the Workflow script exactly as
`DOCS_BY_DAY`/`PERSONAS` are today — never passed through `args`.

Inlining `block` needs care: a feature body is multi-line prose that
routinely contains apostrophes, so it fits in neither a single-quoted
literal (the apostrophe terminates it, and raw newlines are a syntax
error) nor a backtick literal (which would interpolate `${ARTIFACT}` into
a `ReferenceError`). Inline each line as its own double-quoted string and
join them with `String.fromCharCode(10)` — a construction that needs no
backslash escapes at all. Reading the feature file at script runtime is
not an option; Workflow scripts have no filesystem access. The
`throw` is a should-never-happen backstop, not a control path: Phase 1
step 10 already excluded every artifact-less (day, feature) cell, so an
artifact-backed cell reaching Phase 2 without a resolved path is a
preflight bug. It must surface as that cell dropping to `null` (reported
as an anomaly, never written) — never as a silently degraded prompt built
around an empty artifact path. Everything else about the envelope (persona
adoption, general docs, the three day docs, the single-trade commitment
instructions, `SETUP_SCHEMA`) is unchanged.

### Phase 3 — Judge and persist (updated cell path/fields only)

Cell write path becomes `runs/<trader>/<alias>/<day>/<variant>/run-<k>.json`.
Cell JSON gains `variant` (always), `featureSha256` (variant ≠ base),
`artifactSha256` (artifact-backed variant only). CLI invocation and
status interpretation (TP/SL/EOD/NOT_FILLED/INVALID/CLI_ERROR/NO_SETUP)
are unchanged.

### Phase 4 — Scoreboard and commit (unchanged mechanically)

`node src/cli.js scoreboard`, commit message becomes
`bench(<alias>): add <count> cells across <T> traders / <D> days / <V> variants`.

## `seven-keys` skill change

Only its Phase 1 guard step changes. Today:

```bash
find runs -path "*/<day>/run-*.json" -exec grep -l keysSha256 {} + 2>/dev/null
```

Becomes:

```bash
ls runs/*/*/<day>/seven-keys/run-*.json 2>/dev/null
```

Any hit → abort, same message as today (immutable once benchmarked; new
benchmark era to regenerate). The rest of the skill (4-agent workflow,
lookback, verifier, artifact write/commit) is completely unchanged — it's
still invoked with just a `MMDDYYYY` argument, standalone or from
`trader-bench`'s Phase 1 step 8 above, exactly as `trader-panel` invokes it
today.

## Scoreboard changes (`src/scoreboard.js`, `src/scoreboard-command.js`)

- `collectCells` gains a fourth directory level: `runs/<trader>/<model>/
  <day>/<variant>/run-*.json`. Because the walk is purely navigational —
  every grouping field is read from the cell payload, never from the path —
  it also cross-checks the two, throwing a named-path error when a cell's
  `trader`/`model.alias`/`day`/`variant` contradicts the directory it sits
  in, so a misfiled cell is a loud failure rather than silent
  misattribution. A stray `run-*.json` left at the old three-level day
  position is warned about on stderr rather than silently skipped, since
  skipping it would under-count the board with no signal.
- Grouping key becomes `[trader, model.alias, variant]` (was
  `[trader, model.alias]`). Every existing per-group metric (mean/std/min/
  max $, win rate, fill rate, stability, errors) is computed identically,
  just now scoped to one variant instead of pooling all cells regardless
  of variant.
- The Ranking table's `Keys Nk/M` column is removed (no longer meaningful
  — a group is now single-variant by construction) and replaced with a
  `Variant` column.
- **New `## Feature Impact` section**, placed after Ranking: for every
  non-base variant present, for every `(trader, model)` pair that has both
  a `base` group and that feature's group, a row showing
  `Trader | Model | Days | Runs | Base $/run | <Feature> $/run | Δ`. Because mean
  $/run is a per-run *sum across days*, comparing raw group means with
  unequal day coverage would present missing-day P&L as a feature effect —
  so both sides are recomputed over the **intersection** of the two
  groups' day sets before differencing. A day covered by only one side
  (e.g. a day the feature's artifact generation failed on, or a day
  benched under `base` before the feature existed) is excluded from both
  sides, never allowed to bias Δ; `Days` is the shared-day count the
  comparison actually ran on. Below each feature's table, one aggregate
  line: the mean of that feature's deltas across all comparable
  `(trader, model)` pairs, plus the pair count (e.g. "Overall Δ for
  seven-keys across 4 trader/model pairs: +12.40"). `(trader, model)`
  pairs missing one side of the comparison entirely (e.g. a variant added
  after that pair already had cells), whose day sets do not intersect, or
  where either side has **no filled trades** over the shared days, are
  omitted from the table, not shown as zero. That last exclusion is not
  cosmetic: a feature whose runs all came back `NO_SETUP` would otherwise
  render as losing exactly base's P&L, presenting a pipeline failure as a
  feature effect — and a pair where neither side filled would render a
  `0.00` delta indistinguishable from "the feature changed nothing."
  `Runs` reports the two sides' run counts over the shared days
  (e.g. `5v5`, or `3v1` when a feature was added mid-run); a lopsided pair
  is a weakly sampled verdict, and the column exists so the reader can see
  that rather than trusting a Δ backed by a single sample. The overall
  rollup is an unweighted mean across pairs — one pair is one trader/model
  verdict on the feature, with per-row `Days` and `Runs` exposing uneven
  sampling.

  The `(trader, model)` pairing key must be injective (e.g. `JSON.stringify`
  of the pair, matching the group key), not naive string concatenation:
  with a `::` separator, trader `a::fable` + model `x` collides with trader
  `a` + model `fable::x`, which would compare a feature group against a
  *different trader's* base group — violating the never-merge invariant
  this document opens with.
- **Lineage** (`renderLineage`, the `## <trader> @ <model>` origin-delta
  line) now matches origin/descendant groups on **model AND variant**, not
  model alone, so a descendant's `Δ vs origin` never compares across
  variants. Per-group section headers become
  `## <trader> @ <model> [<variant>]` to disambiguate.
- **Coverage** table gains a `Variant` column; the "under-tested vs max
  cells" comparison is unchanged in spirit (max across all groups
  regardless of variant remains the bar).

## Migration

1. Delete `runs/` and `runs/SCOREBOARD.md` entirely (no archive — this is
   an explicit clean break, confirmed with the user).
2. Add `features/seven-keys.md` (content above), migrating the hardcoded
   Seven-Keys prompt sentence out of `trader-bench`'s Phase 2 script.
3. Update `.claude/skills/trader-bench/SKILL.md` per the Phase 1–3 changes
   above.
4. Update `.claude/skills/seven-keys/SKILL.md`'s Phase 1 guard step.
5. Update `src/scoreboard.js` and `src/scoreboard-command.js` per the
   Scoreboard changes above; feature discovery and Guard #0 validation
   live in a new `src/features.js` shared by the CLI and the bench.
6. `trader-panel` and `trader-spawn` are untouched — no code or skill
   changes to either.
7. First post-migration `/trader-bench` run regenerates everything from
   scratch under the new schema (base + seven-keys variants, all
   traders × all complete days), which is also the first real test of the
   Feature Impact section once cells exist for both variants.

## Testing

- **Scoreboard (pure logic):** extend the existing fixture-based unit
  tests to cover the new grouping key (variant), the Feature Impact
  computation (base/feature pairs present, one side missing, multiple
  trader/model pairs averaged correctly, day-set intersection — a base
  group with extra days is compared only over the shared days, a pair
  with disjoint day sets is omitted, a pair with no filled trades on
  either side is omitted rather than scored zero, a hostile
  trader/model name pair never cross-matches, and run counts are
  reported per side), and lineage delta matching by
  variant (a fixture with an origin and descendant each having both `base`
  and a feature variant must never cross-compare them).
- **Feature definition validation (Guard #0):** fixtures for each
  rejection — reserved id `base`, duplicate ids (frontmatter vs. filename
  fallback), `artifactSuffix` without `generatorSkill`, artifact-backed
  body missing `${ARTIFACT}`, `${ARTIFACT}` in a non-artifact body — each
  aborting with the offending file named.
- **Preflight missing-set logic:** fixture `runs/` trees exercising the
  four-dimensional missing-cell computation (trader × day × variant),
  including a feature added after some days were already fully benched
  under `base`, and a (day, feature) combination with no artifact whose
  cells are excluded from the missing set rather than run artifact-less.
- **Guard logic:** fixture trees verifying persona/feature/artifact hash
  mismatches abort with the right message, and that a feature-file edit
  after benchmarking is caught the same way a trader-file edit is today.
- **End-to-end:** a small live bench (N=1, one model, one feature) against
  the existing knowledge base, verifying `base` and `seven-keys` cells both
  appear under separate variant folders, guards hold, and the Feature
  Impact section renders a real delta.
