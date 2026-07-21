# Ambiguous-Candle Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `src/engine.js`'s fixed "SL always wins on an ambiguous candle" tie-break with a candle-shape-based rule that never correlates with an order's stop distance, per `docs/superpowers/specs/2026-07-20-ambiguous-candle-resolution-design.md`.

**Architecture:** A new pure helper, `slHitsFirst(candle, side)`, infers an assumed intrabar path from the candle's own `close >= open` direction and returns which of SL/TP was reached first. The existing exit-check block in `simulateOrder` computes both `slHit` and `tpHit` up front (instead of returning on `slHit` immediately) and only consults the helper when both are true. Entry arming/fill logic is untouched.

**Tech Stack:** Node 20+ built-ins only, `node:test` for tests — matches the existing `src/engine.js` / `test/engine.test.js` pair, zero new dependencies.

---

## Task 1: Candle-shape tie-break in the simulation engine

**Files:**
- Modify: `src/engine.js:1-67` (header comment + `simulateOrder`)
- Test: `test/engine.test.js:38-44`

- [ ] **Step 1: Replace the existing ambiguous-candle test and add the three truth-table cases it was missing**

In `test/engine.test.js`, replace the test currently at lines 38-44:

```js
test('candle spanning both SL and TP resolves to SL (worst case)', () => {
  const candles = [
    c(1, 101, 102, 100, 101),
    c(2, 101, 111, 94, 108),   // spans both 95 and 110
  ];
  assert.equal(simulateOrder(longOrder, candles).status, 'SL');
});
```

with these four tests (same assertion for the first — its candle is bullish,
so the answer doesn't change — plus the three new truth-table cases):

```js
test('long: ambiguous candle resolves to SL when the candle is bullish (dip before rally)', () => {
  const candles = [
    c(1, 101, 102, 100, 101),
    c(2, 101, 111, 94, 108),   // bullish (close 108 >= open 101); spans both 95 and 110
  ];
  assert.equal(simulateOrder(longOrder, candles).status, 'SL');
});

test('long: ambiguous candle resolves to TP when the candle is bearish (rally before selloff)', () => {
  const candles = [
    c(1, 101, 102, 100, 101),
    c(2, 111, 111, 94, 95),    // bearish (close 95 < open 111); spans both 95 and 110
  ];
  assert.equal(simulateOrder(longOrder, candles).status, 'TP');
});

test('short: ambiguous candle resolves to TP when the candle is bullish', () => {
  const candles = [
    c(1, 99, 101, 98, 99),
    c(2, 89, 106, 88, 95),     // bullish (close 95 >= open 89); spans both 105 and 90
  ];
  assert.equal(simulateOrder(shortOrder, candles).status, 'TP');
});

test('short: ambiguous candle resolves to SL when the candle is bearish', () => {
  const candles = [
    c(1, 99, 101, 98, 99),
    c(2, 106, 106, 88, 89),    // bearish (close 89 < open 106); spans both 105 and 90
  ];
  assert.equal(simulateOrder(shortOrder, candles).status, 'SL');
});
```

- [ ] **Step 2: Run the suite and verify the expected two failures**

Run: `node --test test/engine.test.js`

Expected: exactly 2 failing, all other tests (the pre-existing suite plus 2
of the 4 new tests) passing:

```
not ok - long: ambiguous candle resolves to TP when the candle is bearish (rally before selloff)
  actual: 'SL', expected: 'TP'
not ok - short: ambiguous candle resolves to TP when the candle is bullish
  actual: 'SL', expected: 'TP'
```

Only these two fail because only these two assert an outcome that *differs*
from today's blanket "SL always wins" rule. The other two new tests —
`'long: ambiguous candle resolves to SL when the candle is bullish (dip
before rally)'` and `'short: ambiguous candle resolves to SL when the candle
is bearish'` — already pass under the current code, since "SL wins" happens
to agree with the new rule's answer for those two specific candle shapes.
That's expected, not a mistake: they exist for full truth-table coverage, not
as red/green pairs. If you see different tests failing than the two named
above, stop and re-check the candle values before proceeding to Step 3.

- [ ] **Step 3: Implement the candle-shape helper and rewire the exit check**

In `src/engine.js`, replace the header comment (current lines 6-8):

```js
// Rules (see spec): touch = fill at entry price; the fill candle itself is
// checked for exits; SL is checked before TP so an ambiguous candle that
// spans both resolves to the worst case; still-open positions close at the
// final candle's close (EOD).
```

with:

```js
// Rules (see spec): touch = fill at entry price; the fill candle itself is
// checked for exits; an ambiguous candle (one whose range spans both SL and
// TP) resolves via slHitsFirst's candle-shape heuristic below, not a blanket
// "SL always wins" rule — see
// docs/superpowers/specs/2026-07-20-ambiguous-candle-resolution-design.md;
// still-open positions close at the final candle's close (EOD).
```

Then, immediately before `export function simulateOrder(order, candles, options = {}) {`, add:

```js
// A bullish candle (close >= open) is assumed to have dipped to its low
// before rallying to its high (Open -> Low -> High -> Close); a bearish
// candle is assumed to have rallied to its high before dropping to its low
// (Open -> High -> Low -> Close). This is a property of the candle alone —
// never of the order's stop distance — so an ambiguous candle resolves the
// same way regardless of how tight a trader's stop is. A flat candle
// (close === open) is treated as bullish.
function slHitsFirst(candle, side) {
  const bullish = candle.close >= candle.open;
  // long: SL sits on the low side, TP on the high side. short: mirrored.
  return side === 'long' ? bullish : !bullish;
}

```

Finally, replace the exit-check block inside the `for (const candle of candles)` loop:

```js
    const slHit = side === 'long' ? candle.low <= stopLoss : candle.high >= stopLoss;
    if (slHit) return { status: 'SL', fillTime, exitTime: candle.time, exitPrice: stopLoss };

    const tpHit = side === 'long' ? candle.high >= takeProfit : candle.low <= takeProfit;
    if (tpHit) return { status: 'TP', fillTime, exitTime: candle.time, exitPrice: takeProfit };
```

with:

```js
    const slHit = side === 'long' ? candle.low <= stopLoss : candle.high >= stopLoss;
    const tpHit = side === 'long' ? candle.high >= takeProfit : candle.low <= takeProfit;
    if (slHit && tpHit) {
      return slHitsFirst(candle, side)
        ? { status: 'SL', fillTime, exitTime: candle.time, exitPrice: stopLoss }
        : { status: 'TP', fillTime, exitTime: candle.time, exitPrice: takeProfit };
    }
    if (slHit) return { status: 'SL', fillTime, exitTime: candle.time, exitPrice: stopLoss };
    if (tpHit) return { status: 'TP', fillTime, exitTime: candle.time, exitPrice: takeProfit };
```

- [ ] **Step 4: Run the suite and verify everything passes**

Run: `node --test test/engine.test.js`

Expected: all tests pass, 0 failures.

- [ ] **Step 5: Run the full project test suite to check nothing else regressed**

Run: `node --test`

Expected: all tests pass (this touches only `engine.js`, but `run-command.js`
and `scoreboard.js` both consume its output shape, so confirm no other suite
broke).

- [ ] **Step 6: Commit**

```bash
git add src/engine.js test/engine.test.js
git commit -m "$(cat <<'EOF'
fix(engine): resolve ambiguous SL/TP candles by shape, not a blanket SL-wins rule

The prior rule always picked SL when a single candle's range spanned both
levels, which correlated with how tight a trader's stop was (a tight stop
is more likely to sit inside the same candle as the fill) — biasing the
trader-bench comparison against tight-stop personas. The new rule infers
an intrabar path from the candle's own bullish/bearish direction and never
references the order's stop distance.

See docs/superpowers/specs/2026-07-20-ambiguous-candle-resolution-design.md
EOF
)"
```

---

## Task 2: Update existing docs that describe the old rule

**Files:**
- Modify: `docs/superpowers/specs/2026-07-17-backtest-cli-design.md:79-85,146`
- Modify: `docs/backtest-scenarios.md:39-54`

- [ ] **Step 1: Update the backtest-cli design spec's simulation semantics**

In `docs/superpowers/specs/2026-07-17-backtest-cli-design.md`, replace (lines 79-85):

```markdown
2. **Exit:** once filled, each candle — including the candle that produced the
   fill — is checked for exit:
   - long: SL hit if `low <= stopLoss` (exit at `stopLoss`); TP hit if
     `high >= takeProfit` (exit at `takeProfit`)
   - short: SL hit if `high >= stopLoss`; TP hit if `low <= takeProfit`
   - If a single candle satisfies both, **the stop loss wins** (worst-case
     convention so results never overstate performance).
```

with:

```markdown
2. **Exit:** once filled, each candle — including the candle that produced the
   fill — is checked for exit:
   - long: SL hit if `low <= stopLoss` (exit at `stopLoss`); TP hit if
     `high >= takeProfit` (exit at `takeProfit`)
   - short: SL hit if `high >= stopLoss`; TP hit if `low <= takeProfit`
   - If a single candle satisfies both, the candle's own shape resolves the
     tie: a bullish candle (`close >= open`) is assumed to have dipped to its
     low before rallying to its high, a bearish candle the reverse — whichever
     of SL/TP sits on the earlier-visited extreme wins. This never depends on
     the order's stop distance — see
     `docs/superpowers/specs/2026-07-20-ambiguous-candle-resolution-design.md`.
```

Then replace (line 146):

```markdown
- ambiguous candle spanning both SL and TP → SL wins
```

with:

```markdown
- ambiguous candle spanning both SL and TP → resolved by candle shape, not a
  blanket SL-wins rule (see
  `docs/superpowers/specs/2026-07-20-ambiguous-candle-resolution-design.md`)
```

- [ ] **Step 2: Rewrite the ambiguous-candle scenario walkthrough**

In `docs/backtest-scenarios.md`, replace the whole scenario 3 section (lines 39-54):

```markdown
### 3. Ambiguous-candle rule (SL wins worst case) — 2026-07-14

The 08:30 news candle spans 57.25 pts (O 7559.25 / H 7613.75 / L 7556.5 / C 7596)
— the widest candle in the file. Two identical longs at 7580 with TP 7595,
differing only in stop placement:

| Order | Stop | Result |
|---|---|---|
| tight-stop | 7570 (inside the candle's range) | SL on the fill candle itself, −10 pts |
| wide-stop | 7550 (below the candle's low) | TP on the fill candle itself, +15 pts |

Both filled and exited on the same 08:30 candle. The tight stop triggers the
worst-case rule even though the candle closed up at 7596 and likely hit the
target first in reality. **Takeaway: on 5-minute data, stops tighter than one
candle's range systematically backtest worse than reality.** Finer-grained
data (1-minute) shrinks this distortion.
```

with:

```markdown
### 3. Ambiguous-candle rule (candle-shape tie-break) — 2026-07-14, updated 2026-07-20

The 08:30 news candle spans 57.25 pts (O 7559.25 / H 7613.75 / L 7556.5 / C 7596)
— the widest candle in the file. Two identical longs at 7580 with TP 7595,
differing only in stop placement:

| Order | Stop | Result |
|---|---|---|
| tight-stop | 7570 (inside the candle's range) | SL on the fill candle itself, −10 pts |
| wide-stop | 7550 (below the candle's low) | TP on the fill candle itself, +15 pts |

Both filled and exited on the same 08:30 candle. This candle is bullish
(close 7596 >= open 7559.25), so under the shape-based tie-break it still
resolves the tight-stop order to SL — not from a blanket worst-case rule, but
because the assumed intrabar path (a small early dip below 7570, then the
rally to new highs) plausibly stops the trade out before the later rally
reaches the target.

The rule genuinely varies by candle shape, though. A hypothetical bearish
mirror of the same candle — same range, but opening near the high and
closing near the low (e.g. O 7610 / H 7613.75 / L 7556.5 / C 7560) — would
resolve the same tight-stop long to **TP** instead: the assumed path rallies
to the high first, then sells off, so the target is reached before the stop.
**Takeaway: on 5-minute data, an ambiguous candle's resolution now depends on
that candle's own bullish/bearish shape, not on how tight the trader's stop
is** — see
`docs/superpowers/specs/2026-07-20-ambiguous-candle-resolution-design.md`.
Finer-grained data (1-minute) would still shrink how often this ambiguity
arises at all.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-07-17-backtest-cli-design.md docs/backtest-scenarios.md
git commit -m "docs: describe the candle-shape ambiguous-candle tie-break in existing specs"
```

---

## Task 3: Wipe existing benchmark cells (clean break, per the design's data-migration decision)

**Files:**
- Delete: `runs/<trader>/<model-alias>/<MMDDYYYY>/<variant>/run-*.json` (every existing cell)
- Modify: `runs/SCOREBOARD.md` (regenerated empty)

This is a destructive, repo-wide deletion. It is its own isolated commit so
it can be reviewed and reverted independently of the code/doc changes above.

- [ ] **Step 1: Confirm the current cell count is in the expected ballpark before deleting anything**

Run: `find runs -name 'run-*.json' | wc -l`

Expected: a number close to 630 (the count recorded in the design spec as of
2026-07-20). If this number is wildly different (e.g. an order of magnitude
larger, suggesting a benchmark run happened since the spec was written that
the user may not expect to lose), STOP and confirm with the user before
proceeding — do not delete silently.

- [ ] **Step 2: Delete every existing cell and the stale scoreboard**

```bash
git rm -r runs
```

Expected: output listing every deleted `run-*.json` path plus `runs/SCOREBOARD.md`.

- [ ] **Step 3: Regenerate an empty scoreboard**

```bash
node src/cli.js scoreboard
```

Expected output: `Wrote runs/SCOREBOARD.md (0 cells)`

- [ ] **Step 4: Verify the regenerated file**

Run: `cat runs/SCOREBOARD.md`

Expected:
```
# Trader Scoreboard

No benchmark cells found. Run /trader-bench to populate runs/.
```

- [ ] **Step 5: Commit**

```bash
git add -A runs/
git commit -m "$(cat <<'EOF'
chore(bench): wipe runs/ ahead of the ambiguous-candle rule change

Ambiguous-candle resolution changed (see the fix in this branch and
docs/superpowers/specs/2026-07-20-ambiguous-candle-resolution-design.md).
Existing cells were simulated under the old "SL always wins" rule and must
not be silently blended with cells produced under the new one. Re-run
/trader-bench to repopulate the matrix from scratch.
EOF
)"
```

---

## Self-review notes

- **Spec coverage:** resolution rule + truth table → Task 1. Scope boundary
  (entry-arming untouched) → Task 1 touches only the exit-check block, not
  the arming loop above it. Data migration → Task 3. Testing → Task 1.
  Documentation updates → Task 2 (the two "current-behavior" docs) and the
  historical plan file is explicitly left untouched (no task for it, per the
  spec).
- **Type/signature consistency:** `slHitsFirst(candle, side)` is defined once
  in Task 1 Step 3 and called once in the same step with the same two
  arguments in the same order everywhere it appears.
