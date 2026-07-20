# Ambiguous-Candle Resolution — Design Spec

**Date:** 2026-07-20
**Status:** Approved design, pending implementation plan
**Amends:** `docs/superpowers/specs/2026-07-17-backtest-cli-design.md` §Simulation
semantics, step 2 ("If a single candle satisfies both, the stop loss wins").

## Problem

When a single 5-minute candle's range spans both an order's stop loss and its
take profit, `src/engine.js` always resolves the tie to the stop loss
("worst-case" convention). A deep audit of the `trader-bench` benchmark
(2026-07-20) found this is not style-neutral: a persona with a stop close to
entry is more likely to have its fill candle also span its own stop (the stop
sits inside the same 5-minute bar the entry filled in), while a persona with a
wide stop rarely does. Since the whole point of the bench is comparing
persona *styles* against each other, a rule whose outcome correlates with how
tight a trader's stop is corrupts that comparison — it is not raw pessimism,
it is a bias against one specific trading style.

This exact ambiguity is already a documented, accepted limitation
(`docs/backtest-scenarios.md` scenario 3, dated 2026-07-14) but was described
there only as a data-granularity artifact ("stops tighter than one candle's
range systematically backtest worse than reality"), not as a benchmark-fairness
bug. This spec supersedes that framing.

## Goal

Replace the fixed "SL always wins" tie-break with a rule that:

1. Is fully deterministic (no randomness) — the bench's cells are immutable
   and write-once, so reproducibility must be preserved.
2. Depends only on the ambiguous candle's own OHLC values, never on the
   order's entry/stopLoss/takeProfit distances — so it cannot reproduce a
   bias correlated with stop width.
3. Applies uniformly wherever the ambiguity occurs — the fill candle and any
   later candle — rather than having two different tie-break rules live in
   the same function.

## Alternatives considered

- **Proximity-to-open** (whichever of SL/TP is numerically closer to the
  candle's open wins): simpler to state, but rejected — a tight stop is, by
  definition, closer to entry (and entry is near the candle's open on the
  fill candle), so this would still systematically favor SL for tight-stop
  orders. It relocates the bias rather than removing it.
- **New `AMBIGUOUS` status** (don't guess; exclude from win/loss stats like
  `NOT_FILLED`): the only zero-assumption option, but rejected for now — it
  requires schema changes across `engine.js`, the cell JSON format,
  `scoreboard.js`'s `SCORED`/`FILLED` sets, and the `trader-bench` skill's
  Phase 3 status table, and it shrinks the effectively-scored sample size.
  Revisit if the shape heuristic below turns out to disagree with reality
  often enough to matter.

## Resolution rule

For an ambiguous candle (both SL and TP conditions true), infer an assumed
intrabar path from the candle's own direction:

- **Bullish** (`candle.close >= candle.open`): assume `Open → Low → High →
  Close` (a dip, then a rally).
- **Bearish** (`candle.close < candle.open`): assume `Open → High → Low →
  Close` (a rally, then a selloff).

Whichever of SL/TP sits on the extreme visited earlier in that assumed path
wins. For a long, SL lives on the low side and TP on the high side; for a
short it's the mirror image. Worked out as a truth table:

| Side | Candle shape | Extreme visited first | Winner |
|---|---|---|---|
| long | bullish | low (SL side) | SL |
| long | bearish | high (TP side) | TP |
| short | bullish | low (TP side) | TP |
| short | bearish | high (SL side) | SL |

A flat candle (`close === open`) is treated as bullish — an arbitrary but
deterministic tie-break for a case that's effectively unreachable at ES
5-minute granularity.

The decisive property is that this table never references `entry`,
`stopLoss`, `takeProfit`, or the distances between them — only the candle's
own open/close direction. It cannot reproduce a bias correlated with stop
width.

### Worked example against the documented scenario

`docs/backtest-scenarios.md` scenario 3: candle O 7559.25 / H 7613.75 / L
7556.5 / C 7596, long entry 7580, TP 7595, tight-stop 7570. This candle is
bullish (7596 >= 7559.25), so under the new rule it still resolves to **SL** —
not because of a blanket worst-case fallback, but because the assumed path
(small early dip below 7570, then the rally to new highs) means the position
plausibly stopped out before the later rally could reach the target. The new
rule does not claim every ambiguous candle "should" resolve one way or the
other from human intuition about a single example — it claims that averaged
across many days, the outcome no longer correlates with how tight the trader's
stop was, because a candle's bullish/bearish shape is independent of any
individual order's parameters. A bearish ambiguous candle for the same long
order would resolve to TP instead, which is the case that actually differs
from today's rule.

## Scope boundary

Only the SL-vs-TP tie-break changes. Entry arming/fill logic (the `armed`
flag, the "touch from the correct side" rule in `simulateOrder`) is
unchanged — it already resolves cleanly today and was not implicated in the
audit finding.

## Data migration

The bench's cell architecture treats `runs/*/run-*.json` as immutable and
write-once, with sha256 guards on personas/features/docs, but has no version
guard on the engine itself. Changing the engine's resolution rule would mean
existing cells (simulated under the old rule) and future cells (simulated
under the new rule) get silently blended into the same scoreboard groups.

Decision: no engine-version guard. Instead, delete every cell under `runs/`
and regenerate an empty `SCOREBOARD.md`; a future `/trader-bench` invocation
repopulates the matrix from scratch under the corrected engine. This is a
destructive, repo-wide deletion (630 files as of 2026-07-20) and must be its
own explicit, confirmed step in the implementation plan — not bundled
invisibly into the code change.

## Testing (`test/engine.test.js`)

- The existing test at line 38 (`'candle spanning both SL and TP resolves to
  SL (worst case)'`) uses a bullish candle (`c(2, 101, 111, 94, 108)`, close
  108 >= open 101) and still asserts `SL` — but the test name/comment must
  change to explain *why* (shape-driven, not blanket worst-case).
- Add a bearish-long case (an ambiguous candle with `close < open`) asserting
  **TP** — the regression guard that actually proves the rule varies by
  shape.
- Add the two short-side equivalents (bullish → TP, bearish → SL) for full
  truth-table coverage.

## Documentation updates

- `src/engine.js` header comment (lines 6-8): rewrite to describe the
  shape-based rule instead of "SL checked before TP."
- `docs/superpowers/specs/2026-07-17-backtest-cli-design.md` (lines 84, 146):
  update from "the stop loss wins" to the new rule, cross-referencing this
  spec.
- `docs/backtest-scenarios.md` scenario 3 (lines 39-54): rewrite to show the
  tight-stop example still resolving to SL (bullish candle, shape-consistent
  reasoning) *and* add a second, bearish-candle example that now resolves to
  TP, so the doc demonstrates the rule actually varies by candle shape.
- `docs/superpowers/plans/2026-07-17-backtest-cli.md` is a historical plan
  record of what was originally built — left as-is, not retroactively edited.
