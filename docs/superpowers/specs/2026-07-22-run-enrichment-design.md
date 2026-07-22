# Run Enrichment — Design Spec

**Date:** 2026-07-22
**Status:** Approved design, pending implementation plan
**Amends:** `docs/superpowers/specs/2026-07-17-backtest-cli-design.md` (orders
JSON output shape) and the `trader-bench` skill's `SETUP_SCHEMA` / cell
format (`.claude/skills/trader-bench/SKILL.md`).

## Problem

Every benchmark run cell (`runs/<trader>/<model>/<day>/<variant>/run-*.json`)
currently records only what a persona decided (`side`/`entry`/`stopLoss`/
`takeProfit`/free-text `rationale`) and the backtest's bottom-line verdict
(`status`/`points`/`dollars`/`fillTime`/`exitTime`). There is no future
mechanism proposed here to *act* on this data (a separate analysis skill is
explicitly out of scope), but the cells themselves currently under-record two
things a future analysis skill would need:

1. **How the trade actually unfolded**, not just how it ended. A `SL` loss
   that dipped 2 points into drawdown before working is a different failure
   than one that ran 40 points against the position first. A `NOT_FILLED`
   cell — the majority outcome (111 of 165 in the most recent fable run) —
   currently carries zero information about whether the persona's zone was
   nearly right or wildly off.
2. **Why the persona chose what it chose**, beyond prose. `rationale` is
   free text; nothing lets a future skill group or aggregate decisions by
   the specific zone used, how confident the persona was, or what it
   considered and rejected.

Both gaps are addressed by adding fields, not by storing raw candle data
per cell — every cell already carries `day`/`date`, so a day's candles are
always independently reloadable from `ticker-data/MES/min-5/*.csv`;
duplicating them into 1000+ cells would be pure redundancy.

## Goals

1. Extend the backtest engine (`src/engine.js`) to compute outcome-quality
   metrics from an order's own entry/stop/TP and the day's candles, and
   surface them through the CLI's `--json` output — preserving "the CLI is
   the sole judge of every setup" (`trader-bench` persists whatever the CLI
   says, no separate math of its own).
2. Extend `trader-bench`'s `SETUP_SCHEMA` (and the prompt each persona
   receives) so personas expose structured decision data, not just prose.
3. Keep both additions purely additive: existing cells (1155 as of
   2026-07-22) are untouched; only cells generated after this change carry
   the new keys. No engine-version guard, no backfill, no schema-version
   field — consistent with how variant-specific keys (`featureSha256`,
   `artifactSha256`) are already optional per cell.

## Alternatives considered

- **Compute the new engine-derived metrics inside `trader-bench` itself**,
  re-parsing the CSV independently of the CLI. Rejected: this duplicates
  candle-walking logic (including the ambiguous-candle shape heuristic,
  see `2026-07-20-ambiguous-candle-resolution-design.md`) outside the
  engine, risking drift between two implementations of the same fill/exit
  rules. The engine is the one place that already knows how a position's
  path was resolved candle-by-candle.
- **Compute metrics lazily, on demand, by a future analysis skill**, never
  persisting them in the cell. Rejected for this round: the user wants
  these values available in the permanent record so a later analysis pass
  over hundreds of cells doesn't re-simulate every order against its CSV;
  precomputing once at generation time is cheap and keeps the record
  self-contained per cell, matching the project's existing "immutable,
  write-once cell" philosophy.
- **Store the day's candle data (or a rendered chart) directly in each
  cell.** Rejected: every cell already has `day`/`date`; the candles are
  already independently reloadable, so embedding them would be pure
  duplication across the 5-15 runs sharing a single day, with no new
  information gained.

## Part 1 — Engine-derived metrics (`src/engine.js` → CLI `--json` → run cell)

New fields on each order's result object, alongside the existing
`status`/`points`/`dollars`/`fillTime`/`exitTime`/`exitPrice`:

| Field | Type | Applies to | Meaning |
|---|---|---|---|
| `maxAdverseExcursion` | number, points, ≥0 | filled orders (TP/SL/EOD) | Worst unrealized move against the position between fill and exit. |
| `maxFavorableExcursion` | number, points, ≥0 | filled orders (TP/SL/EOD) | Best unrealized move in the position's favor between fill and exit. On a loss, a high MFE means "it was working, then reversed" — a different failure mode than "wrong from the start." |
| `rMultiple` | number, signed | filled orders (TP/SL/EOD) | `points / \|entry - stopLoss\|`. Normalizes outcomes across setups with different stop distances. |
| `closestApproach` | number, points, ≥0 | `NOT_FILLED` only | Smallest distance price reached from `entry` during the session — distinguishes "almost filled" from "never remotely close." |

`maxAdverseExcursion`/`maxFavorableExcursion` are computed by walking the
same candle sequence `simulateOrder` already walks between the fill candle
and the exit candle (inclusive), tracking the running worst/best unrealized
price relative to `entry`, converted to points via the existing
side-aware sign convention. `closestApproach` walks the full in-window
session (the same candles `simulateOrder` already scans for a touch) and
tracks the minimum `|candle price - entry|` seen on the relevant side.

These fields are always `null` when they don't apply (mirroring the
existing `null`-for-`NOT_FILLED` convention on `points`/`dollars`).

### CLI / table output

`formatTable` (`src/report.js`) gains `MAE`, `MFE`, `R` columns for the
plain-text table (blank/`-` for `NOT_FILLED` rows, which instead show
`closestApproach` in a `CLOSEST` column). This keeps a manual
`node src/cli.js run` (without `--json`) equally informative; `--json`
gains the same fields on each order object.

### `trader-bench` Phase 3 changes

The cell-write step already copies the CLI's JSON verdict fields into
`result` (`status`, `points`, `dollars`, `fillTime`, `exitTime`). It now
also copies `maxAdverseExcursion`/`maxFavorableExcursion`/`rMultiple` (when
present) or `closestApproach` (for `NOT_FILLED`) the same way — still "no
validation of your own," just recording more of what the CLI already
computed.

## Part 2 — Model-elicited structured fields (`SETUP_SCHEMA` + prompt)

New keys in `SETUP_SCHEMA` (and the persisted `setup` object), alongside
`side`/`entry`/`stopLoss`/`takeProfit`/`rationale`:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `primaryZone` | string | yes | The specific price zone the persona anchored to (e.g. `"7481.75-7495.75"`), pulled out of prose so a future skill can group/aggregate by zone without parsing `rationale`. |
| `confidence` | integer 1-5 | yes | How strongly the persona favored this setup over alternatives it considered. |
| `rejectedAlternative` | string, ≤200 chars | no | The next-best zone/side considered and why it was passed on — a counterfactual useful for spawning future persona tweaks. Omitted when there was no real second candidate. |

The prompt block sent to each persona agent gains an instruction to
populate these three fields alongside the existing rationale requirement.
`rejectedAlternative`'s optionality is expressed the same way JSON Schema
already expresses it elsewhere in this skill: absent from `required`,
present in `properties`.

## Compatibility and versioning

- No schema-version marker is added. Presence or absence of the new keys
  already signals which schema generation a cell belongs to, exactly as
  `featureSha256`/`artifactSha256`/`staticDocSha256` already do today for
  variant-specific data.
- Existing cells are never rewritten or backfilled.
- No hash-guard changes: these are output/response fields, not
  persona/feature/doc content subject to the existing immutability guards.

## Testing

- `test/engine.test.js`: new cases per outcome —
  - TP and SL cases asserting correct `maxAdverseExcursion`/
    `maxFavorableExcursion`/`rMultiple` against a hand-computed candle
    sequence (both long and short).
  - An EOD case confirming the same three fields are still computed
    through to the final candle's close.
  - A `NOT_FILLED` case asserting `closestApproach` against a known
    minimum-distance candle.
- `test/report.test.js` (or equivalent): new-column assertions for the
  plain-text table, including the `NOT_FILLED` → `CLOSEST` column swap.
- No test changes needed in the `trader-bench` skill itself (it has no
  automated test suite); manual verification is a small real run.

## Documentation updates

- `docs/superpowers/specs/2026-07-17-backtest-cli-design.md`: the "Orders
  JSON" / JSON-output section gets a cross-reference to this spec's new
  fields rather than duplicating them.
- `.claude/skills/trader-bench/SKILL.md`: `SETUP_SCHEMA`, the persona
  prompt block, and the Phase 3 cell-format section all need the new
  fields documented in place, matching the level of detail already used
  for existing fields there.
