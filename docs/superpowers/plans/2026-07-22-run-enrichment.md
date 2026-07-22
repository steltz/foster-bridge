# Run Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich every backtest order result with outcome-quality metrics (max adverse/favorable excursion, R-multiple, closest-approach-when-unfilled) computed by the engine, and enrich every future `trader-bench` run cell with structured persona decision fields (primary zone, confidence, rejected alternative) — laying the groundwork for a future analysis skill without building that skill now.

**Architecture:** `src/engine.js`'s `simulateOrder` already walks candles chronologically to determine fill/exit; it gains four new tracked values computed in the same single pass (no second CSV read, no new dependency). These flow untouched through `simulate()`, `src/report.js`'s table, and the CLI's `--json` output — the CLI stays "the sole judge," now just reporting more about the trade's path. Separately, `trader-bench`'s `SETUP_SCHEMA` and persona prompt gain three new required/optional fields personas must supply directly; Phase 3 copies both sets of new fields into run cells exactly like it already copies today's fields, with no new validation.

**Tech Stack:** Node 20+ built-ins only (`node:test`, `node:assert/strict`) — no new dependencies.

---

## Task 1: Engine — max adverse/favorable excursion, R-multiple, closest approach

**Files:**
- Modify: `src/engine.js`
- Test: `test/engine.test.js`

- [ ] **Step 1: Update the existing full-shape assertions in `test/engine.test.js` to expect the new fields**

Ten existing tests assert the complete `simulateOrder` return object via `assert.deepEqual`. Since `deepStrictEqual` (which `assert/strict`'s `deepEqual` aliases to) fails on any extra key, every one of these must be updated in the same step or they'll fail for the wrong reason once the new keys appear. Apply these exact replacements in `test/engine.test.js`:

Replace (lines 11-16):
```js
test('order never touched is NOT_FILLED', () => {
  const candles = [c(1, 120, 125, 115, 120)];
  assert.deepEqual(simulateOrder(longOrder, candles), {
    status: 'NOT_FILLED', fillTime: null, exitTime: null, exitPrice: null,
  });
});
```
with:
```js
test('order never touched is NOT_FILLED', () => {
  const candles = [c(1, 120, 125, 115, 120)];
  assert.deepEqual(simulateOrder(longOrder, candles), {
    status: 'NOT_FILLED', fillTime: null, exitTime: null, exitPrice: null,
    maxAdverseExcursion: null, maxFavorableExcursion: null, rMultiple: null,
    closestApproach: 15,
  });
});
```

Replace (lines 18-26):
```js
test('long fills on touch then exits at take profit', () => {
  const candles = [
    c(1, 101, 102, 100, 101),  // low touches entry 100 -> fill
    c(2, 101, 111, 101, 110),  // high >= 110 -> TP
  ];
  assert.deepEqual(simulateOrder(longOrder, candles), {
    status: 'TP', fillTime: 1, exitTime: 2, exitPrice: 110,
  });
});
```
with:
```js
test('long fills on touch then exits at take profit', () => {
  const candles = [
    c(1, 101, 102, 100, 101),  // low touches entry 100 -> fill
    c(2, 101, 111, 101, 110),  // high >= 110 -> TP
  ];
  assert.deepEqual(simulateOrder(longOrder, candles), {
    status: 'TP', fillTime: 1, exitTime: 2, exitPrice: 110,
    maxAdverseExcursion: 0, maxFavorableExcursion: 11, rMultiple: 2,
    closestApproach: null,
  });
});
```

Replace (lines 28-36):
```js
test('long exits at stop loss', () => {
  const candles = [
    c(1, 101, 102, 100, 101),
    c(2, 101, 102, 94, 95),    // low <= 95 -> SL
  ];
  assert.deepEqual(simulateOrder(longOrder, candles), {
    status: 'SL', fillTime: 1, exitTime: 2, exitPrice: 95,
  });
});
```
with:
```js
test('long exits at stop loss', () => {
  const candles = [
    c(1, 101, 102, 100, 101),
    c(2, 101, 102, 94, 95),    // low <= 95 -> SL
  ];
  assert.deepEqual(simulateOrder(longOrder, candles), {
    status: 'SL', fillTime: 1, exitTime: 2, exitPrice: 95,
    maxAdverseExcursion: 6, maxFavorableExcursion: 2, rMultiple: -1,
    closestApproach: null,
  });
});
```

Replace (lines 70-75):
```js
test('fill and exit can happen on the same candle', () => {
  const candles = [c(1, 108, 111, 100, 110)]; // touches entry 100 AND high >= 110
  assert.deepEqual(simulateOrder(longOrder, candles), {
    status: 'TP', fillTime: 1, exitTime: 1, exitPrice: 110,
  });
});
```
with:
```js
test('fill and exit can happen on the same candle', () => {
  const candles = [c(1, 108, 111, 100, 110)]; // touches entry 100 AND high >= 110
  assert.deepEqual(simulateOrder(longOrder, candles), {
    status: 'TP', fillTime: 1, exitTime: 1, exitPrice: 110,
    maxAdverseExcursion: 0, maxFavorableExcursion: 11, rMultiple: 2,
    closestApproach: null,
  });
});
```

Replace (lines 77-85):
```js
test('position open at end of day closes at last close as EOD', () => {
  const candles = [
    c(1, 101, 102, 100, 101),
    c(2, 101, 104, 99, 103),
  ];
  assert.deepEqual(simulateOrder(longOrder, candles), {
    status: 'EOD', fillTime: 1, exitTime: 2, exitPrice: 103,
  });
});
```
with:
```js
test('position open at end of day closes at last close as EOD', () => {
  const candles = [
    c(1, 101, 102, 100, 101),
    c(2, 101, 104, 99, 103),
  ];
  assert.deepEqual(simulateOrder(longOrder, candles), {
    status: 'EOD', fillTime: 1, exitTime: 2, exitPrice: 103,
    maxAdverseExcursion: 1, maxFavorableExcursion: 4, rMultiple: 0.6,
    closestApproach: null,
  });
});
```

Replace (lines 87-95):
```js
test('short exits at take profit when price falls', () => {
  const candles = [
    c(1, 99, 101, 98, 99),     // touches entry 100 -> fill
    c(2, 99, 99, 89, 90),      // low <= 90 -> TP
  ];
  assert.deepEqual(simulateOrder(shortOrder, candles), {
    status: 'TP', fillTime: 1, exitTime: 2, exitPrice: 90,
  });
});
```
with:
```js
test('short exits at take profit when price falls', () => {
  const candles = [
    c(1, 99, 101, 98, 99),     // touches entry 100 -> fill
    c(2, 99, 99, 89, 90),      // low <= 90 -> TP
  ];
  assert.deepEqual(simulateOrder(shortOrder, candles), {
    status: 'TP', fillTime: 1, exitTime: 2, exitPrice: 90,
    maxAdverseExcursion: 1, maxFavorableExcursion: 11, rMultiple: 2,
    closestApproach: null,
  });
});
```

Replace (lines 97-105):
```js
test('short exits at stop loss when price rises', () => {
  const candles = [
    c(1, 99, 101, 98, 99),
    c(2, 99, 106, 99, 105),    // high >= 105 -> SL
  ];
  assert.deepEqual(simulateOrder(shortOrder, candles), {
    status: 'SL', fillTime: 1, exitTime: 2, exitPrice: 105,
  });
});
```
with:
```js
test('short exits at stop loss when price rises', () => {
  const candles = [
    c(1, 99, 101, 98, 99),
    c(2, 99, 106, 99, 105),    // high >= 105 -> SL
  ];
  assert.deepEqual(simulateOrder(shortOrder, candles), {
    status: 'SL', fillTime: 1, exitTime: 2, exitPrice: 105,
    maxAdverseExcursion: 6, maxFavorableExcursion: 2, rMultiple: -1,
    closestApproach: null,
  });
});
```

Replace (lines 107-113):
```js
test('does not fill an entry on or after the cutoff time', () => {
  const atCutoff = Date.UTC(2026, 5, 30, 14, 0) / 1000; // 14:00 UTC == 840 minutes
  const candles = [c(atCutoff, 101, 102, 100, 101)];    // would touch entry 100
  assert.deepEqual(simulateOrder(longOrder, candles, { cutoffMinutes: 840, tz: 'UTC' }), {
    status: 'NOT_FILLED', fillTime: null, exitTime: null, exitPrice: null,
  });
});
```
with:
```js
test('does not fill an entry on or after the cutoff time', () => {
  const atCutoff = Date.UTC(2026, 5, 30, 14, 0) / 1000; // 14:00 UTC == 840 minutes
  const candles = [c(atCutoff, 101, 102, 100, 101)];    // would touch entry 100
  assert.deepEqual(simulateOrder(longOrder, candles, { cutoffMinutes: 840, tz: 'UTC' }), {
    status: 'NOT_FILLED', fillTime: null, exitTime: null, exitPrice: null,
    // The only candle is at-or-after the cutoff, so it's never scanned for
    // closest-approach either — an order that was never entry-eligible has
    // no meaningful "how close did it get" answer.
    maxAdverseExcursion: null, maxFavorableExcursion: null, rMultiple: null,
    closestApproach: null,
  });
});
```

Replace (lines 115-125):
```js
test('fills before the cutoff and still manages the exit after it', () => {
  const before = Date.UTC(2026, 5, 30, 13, 55) / 1000; // fills
  const after = Date.UTC(2026, 5, 30, 15, 0) / 1000;   // TP after cutoff — allowed
  const candles = [
    c(before, 101, 102, 100, 101),
    c(after, 101, 111, 101, 110),
  ];
  assert.deepEqual(simulateOrder(longOrder, candles, { cutoffMinutes: 840, tz: 'UTC' }), {
    status: 'TP', fillTime: before, exitTime: after, exitPrice: 110,
  });
});
```
with:
```js
test('fills before the cutoff and still manages the exit after it', () => {
  const before = Date.UTC(2026, 5, 30, 13, 55) / 1000; // fills
  const after = Date.UTC(2026, 5, 30, 15, 0) / 1000;   // TP after cutoff — allowed
  const candles = [
    c(before, 101, 102, 100, 101),
    c(after, 101, 111, 101, 110),
  ];
  assert.deepEqual(simulateOrder(longOrder, candles, { cutoffMinutes: 840, tz: 'UTC' }), {
    status: 'TP', fillTime: before, exitTime: after, exitPrice: 110,
    maxAdverseExcursion: 0, maxFavorableExcursion: 11, rMultiple: 2,
    closestApproach: null,
  });
});
```

Replace (lines 174-180):
```js
test('does not fill an entry before the open time', () => {
  const early = Date.UTC(2026, 5, 30, 9, 45) / 1000; // 09:45 UTC == 585 minutes
  const candles = [c(early, 108, 111, 100, 110)];     // would touch entry and TP
  assert.deepEqual(simulateOrder(longOrder, candles, { openMinutes: 600, tz: 'UTC' }), {
    status: 'NOT_FILLED', fillTime: null, exitTime: null, exitPrice: null,
  });
});
```
with:
```js
test('does not fill an entry before the open time', () => {
  const early = Date.UTC(2026, 5, 30, 9, 45) / 1000; // 09:45 UTC == 585 minutes
  const candles = [c(early, 108, 111, 100, 110)];     // would touch entry and TP
  assert.deepEqual(simulateOrder(longOrder, candles, { openMinutes: 600, tz: 'UTC' }), {
    status: 'NOT_FILLED', fillTime: null, exitTime: null, exitPrice: null,
    maxAdverseExcursion: null, maxFavorableExcursion: null, rMultiple: null,
    closestApproach: null,
  });
});
```

- [ ] **Step 2: Add two new tests proving the metrics vary meaningfully, appended to the end of `test/engine.test.js`**

```js
test('a losing long that first ran in its favor shows high MFE alongside the loss', () => {
  const candles = [
    c(1, 101, 102, 100, 101),  // fill (touches entry 100)
    c(2, 101, 108, 101, 107),  // rallies to 108 (favorable) before pulling back
    c(3, 107, 107, 94, 96),    // reverses hard, low <= 95 -> SL
  ];
  const r = simulateOrder(longOrder, candles);
  assert.equal(r.status, 'SL');
  assert.equal(r.maxFavorableExcursion, 8);   // 108 - 100
  assert.equal(r.maxAdverseExcursion, 6);     // 100 - 94
  assert.equal(r.rMultiple, -1);              // (95 - 100) / 5
});

test('closestApproach reports the tightest miss for a short order that never fills', () => {
  const candles = [c(1, 90, 95, 88, 92), c(2, 90, 96, 89, 93)];
  const r = simulateOrder(shortOrder, candles); // shortOrder entry 100
  assert.equal(r.status, 'NOT_FILLED');
  assert.equal(r.closestApproach, 4); // |96 - 100|, the closer of the two highs
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/engine.test.js`
Expected: the 10 modified tests and 2 new tests FAIL (actual object is missing the new keys, or `closestApproach`/`maxFavorableExcursion`/etc. are `undefined`). Other engine tests in the file still PASS.

- [ ] **Step 4: Implement the metrics in `src/engine.js`**

Replace the full contents of `src/engine.js` with:

```js
import { minutesOfDayForTimestamp } from './session.js';

// Replays candles chronologically for a single order.
// Rules (see spec): touch = fill at entry price; the fill candle itself is
// checked for exits; an ambiguous candle (one whose range spans both SL and
// TP) resolves via slHitsFirst's candle-shape heuristic below, not a blanket
// "SL always wins" rule — see
// docs/superpowers/specs/2026-07-20-ambiguous-candle-resolution-design.md;
// still-open positions close at the final candle's close (EOD).
//
// options.openMinutes and options.cutoffMinutes (with options.tz) bound the
// local time-of-day window in which NEW entries may fill: no entry before
// openMinutes and none at or after cutoffMinutes. An order that could only
// fill outside that window is NOT_FILLED. Exits on an already-filled position
// are never blocked. A null bound disables that side of the window.
//
// Entries are resting LIMIT orders and fill only on a touch from the correct
// side: a long fills when price trades DOWN to the entry (a pullback into
// support), a short when price trades UP to the entry (a rally into
// resistance). Price already past the entry on the wrong side when it becomes
// active does not fill; it only becomes eligible again after returning to the
// correct side ("armed"). Only in-window candles arm or fill an order.
// A bullish candle (close >= open) is assumed to have dipped to its low
// before rallying to its high (Open -> Low -> High -> Close); a bearish
// candle is assumed to have rallied to its high before dropping to its low
// (Open -> High -> Low -> Close). This is a property of the candle alone —
// never of the order's stop distance — so an ambiguous candle resolves the
// same way regardless of how tight a trader's stop is. A flat candle
// (close === open) is treated as bullish.
//
// Alongside fill/exit, two outcome-quality metrics are tracked in the same
// pass — see docs/superpowers/specs/2026-07-22-run-enrichment-design.md:
// - closestApproach: while still pending and in-window, the smallest
//   distance from entry the touch-side price (low for a long, high for a
//   short) reached. Only meaningful for NOT_FILLED (null otherwise); an
//   order that was never entry-eligible in any in-window candle gets null
//   here too, since "how close" has no answer without a candle to measure.
// - maxAdverseExcursion / maxFavorableExcursion: once filled, the worst/best
//   unrealized move (in points, using each candle's full high/low — the
//   same granularity the fill/exit rules already use) seen from the fill
//   candle through the exit candle inclusive. Both are null until filled.
function slHitsFirst(candle, side) {
  const bullish = candle.close >= candle.open;
  // long: SL sits on the low side, TP on the high side. short: mirrored.
  return side === 'long' ? bullish : !bullish;
}

export function simulateOrder(order, candles, options = {}) {
  const { side, entry, stopLoss, takeProfit } = order;
  const { openMinutes = null, cutoffMinutes = null, tz = 'UTC' } = options;
  const direction = side === 'long' ? 1 : -1;
  const riskDistance = Math.abs(entry - stopLoss);
  let fillTime = null;
  let armed = false; // has price been on the entry's correct side, in-window?
  let closestApproach = null;
  let maxAdverseExcursion = 0;
  let maxFavorableExcursion = 0;

  // rMultiple is deliberately qty-independent (a per-unit ratio), so it's
  // comparable across orders regardless of position size.
  const finish = (status, exitTime, exitPrice) => ({
    status,
    fillTime,
    exitTime,
    exitPrice,
    maxAdverseExcursion,
    maxFavorableExcursion,
    rMultiple: ((exitPrice - entry) * direction) / riskDistance,
    closestApproach: null,
  });

  for (const candle of candles) {
    if (fillTime === null) {
      const localMinutes =
        openMinutes === null && cutoffMinutes === null
          ? null
          : minutesOfDayForTimestamp(candle.time, tz);
      const afterOpen = openMinutes === null || localMinutes >= openMinutes;
      const beforeCutoff = cutoffMinutes === null || localMinutes < cutoffMinutes;
      if (!afterOpen || !beforeCutoff) continue; // not active for entry

      const touchSidePrice = side === 'long' ? candle.low : candle.high;
      const distance = Math.abs(touchSidePrice - entry);
      if (closestApproach === null || distance < closestApproach) closestApproach = distance;

      if (side === 'long') {
        const touch = candle.low <= entry;
        if (touch && (armed || candle.open >= entry)) {
          fillTime = candle.time;
        } else {
          if (candle.high >= entry) armed = true; // price reached the correct side
          continue;
        }
      } else {
        const touch = candle.high >= entry;
        if (touch && (armed || candle.open <= entry)) {
          fillTime = candle.time;
        } else {
          if (candle.low <= entry) armed = true;
          continue;
        }
      }
    }

    const adverse = side === 'long' ? entry - candle.low : candle.high - entry;
    const favorable = side === 'long' ? candle.high - entry : entry - candle.low;
    if (adverse > maxAdverseExcursion) maxAdverseExcursion = adverse;
    if (favorable > maxFavorableExcursion) maxFavorableExcursion = favorable;

    const slHit = side === 'long' ? candle.low <= stopLoss : candle.high >= stopLoss;
    const tpHit = side === 'long' ? candle.high >= takeProfit : candle.low <= takeProfit;
    if (slHit && tpHit) {
      return slHitsFirst(candle, side)
        ? finish('SL', candle.time, stopLoss)
        : finish('TP', candle.time, takeProfit);
    }
    if (slHit) return finish('SL', candle.time, stopLoss);
    if (tpHit) return finish('TP', candle.time, takeProfit);
  }

  if (fillTime === null) {
    return {
      status: 'NOT_FILLED', fillTime: null, exitTime: null, exitPrice: null,
      maxAdverseExcursion: null, maxFavorableExcursion: null, rMultiple: null,
      closestApproach,
    };
  }
  const last = candles[candles.length - 1];
  return finish('EOD', last.time, last.close);
}

export function simulate(candles, orders, multiplier, options = {}) {
  const results = orders.map((order) => {
    const outcome = simulateOrder(order, candles, options);
    let points = null;
    let dollars = null;
    if (outcome.status !== 'NOT_FILLED') {
      const direction = order.side === 'long' ? 1 : -1;
      points = (outcome.exitPrice - order.entry) * direction * order.qty;
      dollars = points * multiplier;
    }
    return { ...order, ...outcome, points, dollars };
  });

  const filled = results.filter((r) => r.status !== 'NOT_FILLED');
  const summary = {
    orders: results.length,
    filled: filled.length,
    wins: filled.filter((r) => r.points > 0).length,
    losses: filled.filter((r) => r.points < 0).length,
    netPoints: filled.reduce((sum, r) => sum + r.points, 0),
    netDollars: filled.reduce((sum, r) => sum + r.dollars, 0),
  };
  return { results, summary };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/engine.test.js`
Expected: all tests PASS (0 failing).

- [ ] **Step 6: Run the full test suite to check for regressions**

Run: `npm test`
Expected: all suites PASS — `test/cli.test.js`, `test/scoreboard.test.js`, etc. only assert specific fields (never the full result-object shape), so they're unaffected by the new keys.

- [ ] **Step 7: Commit**

```bash
git add src/engine.js test/engine.test.js
git commit -m "feat(engine): compute max adverse/favorable excursion, R-multiple, and closest-approach per order"
```

---

## Task 2: Report table — surface the new metrics

**Files:**
- Modify: `src/report.js`
- Test: `test/report.test.js`

- [ ] **Step 1: Update `test/report.test.js` to expect the new columns**

Replace the full contents of `test/report.test.js` with:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTable } from '../src/report.js';

const payload = {
  session: '2026-06-30',
  results: [
    {
      id: 'long-1', side: 'long', status: 'TP', qty: 1,
      entry: 100, stopLoss: 95, takeProfit: 110,
      fillTime: 1782876900, exitTime: 1782877200, exitPrice: 110,
      points: 10, dollars: 50,
      maxAdverseExcursion: 0, maxFavorableExcursion: 11, rMultiple: 2,
      closestApproach: null,
    },
    {
      id: 'miss', side: 'short', status: 'NOT_FILLED', qty: 1,
      entry: 200, stopLoss: 210, takeProfit: 190,
      fillTime: null, exitTime: null, exitPrice: null,
      points: null, dollars: null,
      maxAdverseExcursion: null, maxFavorableExcursion: null, rMultiple: null,
      closestApproach: 12.5,
    },
  ],
  summary: { orders: 2, filled: 1, wins: 1, losses: 0, netPoints: 10, netDollars: 50 },
};

test('formats a session header, order rows, and summary', () => {
  const out = formatTable(payload, 'America/New_York');
  assert.match(out, /Session: 2026-06-30/);
  assert.match(out, /ID\s+SIDE\s+STATUS\s+FILL\s+EXIT\s+EXIT PX\s+PTS\s+USD\s+MAE\s+MFE\s+R\s+CLOSEST/);
  // 1782876900 = 23:35 New York, 1782877200 = 23:40
  assert.match(out, /long-1\s+long\s+TP\s+23:35\s+23:40\s+110\s+10\.00\s+50\.00\s+0\.00\s+11\.00\s+2\.00\s+-/);
  assert.match(out, /miss\s+short\s+NOT_FILLED\s+-\s+-\s+-\s+-\s+-\s+-\s+-\s+-\s+12\.50/);
  assert.match(out, /Orders: 2 {2}Filled: 1 {2}Wins: 1 {2}Losses: 0/);
  assert.match(out, /Net: 10\.00 pts {2}\$50\.00/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/report.test.js`
Expected: FAIL — the header/row regexes don't match today's 8-column table.

- [ ] **Step 3: Implement the new columns in `src/report.js`**

Replace the `formatTable` function in `src/report.js` (keep `formatTime` and its `timeFormatters` map unchanged above it) with:

```js
export function formatTable({ session, results, summary }, tz) {
  const headers = [
    'ID', 'SIDE', 'STATUS', 'FILL', 'EXIT', 'EXIT PX', 'PTS', 'USD',
    'MAE', 'MFE', 'R', 'CLOSEST',
  ];
  const rows = results.map((r) => [
    r.id,
    r.side,
    r.status,
    formatTime(r.fillTime, tz),
    formatTime(r.exitTime, tz),
    r.exitPrice === null ? '-' : String(r.exitPrice),
    r.points === null ? '-' : r.points.toFixed(2),
    r.dollars === null ? '-' : r.dollars.toFixed(2),
    r.maxAdverseExcursion === null ? '-' : r.maxAdverseExcursion.toFixed(2),
    r.maxFavorableExcursion === null ? '-' : r.maxFavorableExcursion.toFixed(2),
    r.rMultiple === null ? '-' : r.rMultiple.toFixed(2),
    r.closestApproach === null ? '-' : r.closestApproach.toFixed(2),
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();

  return [
    `Session: ${session}`,
    '',
    line(headers),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.map(line),
    '',
    `Orders: ${summary.orders}  Filled: ${summary.filled}  Wins: ${summary.wins}  Losses: ${summary.losses}`,
    `Net: ${summary.netPoints.toFixed(2)} pts  $${summary.netDollars.toFixed(2)}`,
  ].join('\n');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/report.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full test suite to check for regressions**

Run: `npm test`
Expected: all suites PASS.

- [ ] **Step 6: Commit**

```bash
git add src/report.js test/report.test.js
git commit -m "feat(report): add MAE/MFE/R/closest-approach columns to the table output"
```

---

## Task 3: `trader-bench` skill — structured persona fields + persisted engine metrics

**Files:**
- Modify: `.claude/skills/trader-bench/SKILL.md`

This skill has no automated test suite (it's an agent-driven markdown workflow, not code); verification is a careful text diff against the file's current content plus the manual smoke check in Step 4.

- [ ] **Step 1: Extend `SETUP_SCHEMA` in the Phase 2 Workflow script (lines 273-284)**

Replace:
```js
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
```
with:
```js
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
```

- [ ] **Step 2: Extend the persona prompt block (the `agent(...)` call in Phase 2)**

Replace this line:
```js
    `As this persona, commit to exactly ONE trade for the session: long or short. ` +
    `Anchor your entry, stop loss, and take profit to the support/resistance zones in the trade plan. ` +
    `Prices are ES index points in quarter-point increments (e.g. 7530.25). ` +
    `A long requires stopLoss < entry < takeProfit; a short requires takeProfit < entry < stopLoss. ` +
    `Include a rationale of at most 50 words citing which plan level(s) you are using.`,
```
with:
```js
    `As this persona, commit to exactly ONE trade for the session: long or short. ` +
    `Anchor your entry, stop loss, and take profit to the support/resistance zones in the trade plan. ` +
    `Prices are ES index points in quarter-point increments (e.g. 7530.25). ` +
    `A long requires stopLoss < entry < takeProfit; a short requires takeProfit < entry < stopLoss. ` +
    `Include a rationale of at most 50 words citing which plan level(s) you are using. ` +
    `Also report primaryZone (the specific price zone you anchored to, e.g. "7481.75-7495.75"), ` +
    `confidence (an integer 1-5 for how strongly you favored this setup over any alternative), ` +
    `and, only if you seriously weighed a different zone or side, rejectedAlternative ` +
    `(at most 30 words: what it was and why you passed on it).`,
```

- [ ] **Step 3: Update the Phase 3 CLI-verdict interpretation (lines 382-391)**

Replace:
```markdown
Interpret strictly by the CLI's verdict:

- exit 0 → parse the JSON; `orders[0]` gives `status` (TP | SL | EOD |
  NOT_FILLED), `points`, `dollars`, `fillTime`, `exitTime`. A far-off entry
  is simply `NOT_FILLED` — that IS the answer.
- exit 1 and stderr matches the CLI's order-validation wording (`requires
  stopLoss < entry < takeProfit` / `requires takeProfit < entry <
  stopLoss` / `must be a number`) → status `INVALID`, `note` = that stderr
  line.
- exit 1 otherwise → status `CLI_ERROR`, `note` = the stderr line.
```
with:
```markdown
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
```

- [ ] **Step 4: Update the Phase 3 cell format JSON and surrounding prose (lines 400-447)**

Replace the cell-format code block:
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
  "setup": { "side": "...", "entry": 0, "stopLoss": 0, "takeProfit": 0, "rationale": "..." },
  "result": { "status": "...", "points": 0, "dollars": 0, "fillTime": "<from CLI JSON, verbatim>", "exitTime": "<from CLI JSON, verbatim>" },
  "note": "<only for INVALID / CLI_ERROR>"
}
```
with:
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

Then, immediately after that JSON block, replace this paragraph:
```markdown
Omit `setup` for NO_SETUP cells; `result` is then `{ "status": "NO_SETUP" }`.
For NOT_FILLED, keep the CLI's null points/dollars/fillTime/exitTime as
null. Statuses INVALID and CLI_ERROR keep the submitted `setup` and use
`result` = `{ "status": "INVALID" }` / `{ "status": "CLI_ERROR" }` plus the
top-level `note`. Every cell — including NO_SETUP — records `variant`,
`personaSha256`, and `generalSha256`. Plain feature cells use the scalar
`featureSha256` / `staticDocSha256` / `artifactSha256` rules above and NEVER
the map forms; combo cells always record `combines`, `featureSha256` (the
combo file itself), and `componentSha256s`, plus the map-form
`staticDocSha256s` / `artifactSha256s` per their omission rules, and NEVER
the scalar doc/artifact keys — all regardless of cell status. A dropped
(null) cell for a combo missing ANY Phase 1 hash its schema requires
(component, static doc, or that day's artifact) gets NO cell file — record
it as an anomaly, exactly like the existing artifact/doc-backed exception.
```
with:
```markdown
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
Every cell — including NO_SETUP — records `variant`, `personaSha256`, and
`generalSha256`. Plain feature cells use the scalar `featureSha256` /
`staticDocSha256` / `artifactSha256` rules above and NEVER the map forms;
combo cells always record `combines`, `featureSha256` (the combo file
itself), and `componentSha256s`, plus the map-form `staticDocSha256s` /
`artifactSha256s` per their omission rules, and NEVER the scalar doc/
artifact keys — all regardless of cell status. A dropped (null) cell for a
combo missing ANY Phase 1 hash its schema requires (component, static doc,
or that day's artifact) gets NO cell file — record it as an anomaly,
exactly like the existing artifact/doc-backed exception.
```

- [ ] **Step 5: Manual smoke check**

This skill has no automated tests, so confirm the edit is internally consistent by hand:

1. Re-open `.claude/skills/trader-bench/SKILL.md` and confirm `SETUP_SCHEMA`'s `required` array and `properties` object list the same three new keys (`primaryZone`, `confidence`, and — in `properties` only, not `required` — `rejectedAlternative`).
2. Confirm the persona prompt block's new sentences reference exactly those three field names (typos here would mean the prompt asks for a field the schema doesn't accept, or vice versa).
3. Confirm the Phase 3 cell-format JSON's `setup` object lists `primaryZone`/`confidence`/`rejectedAlternative` and `result` lists `maxAdverseExcursion`/`maxFavorableExcursion`/`rMultiple`/`closestApproach` — matching Task 1's engine field names exactly (a mismatched name here would silently drop the metric when a future `trader-bench` run copies "the CLI's JSON verbatim").

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/trader-bench/SKILL.md
git commit -m "feat(trader-bench): capture primaryZone/confidence/rejectedAlternative and persist engine metrics"
```

**Note for whoever runs this plan:** the strongest real verification of this task is running `/trader-bench 1 fable` (or any alias) against one trader afterward and inspecting the resulting cell for `setup.primaryZone`/`confidence` and `result.maxAdverseExcursion`/etc. That invocation spends real agent budget, so it's a recommendation for the user to run themselves when ready — not a scripted step in this plan.

---

## Task 4: Cross-reference the new metrics from the original CLI design spec

**Files:**
- Modify: `docs/superpowers/specs/2026-07-17-backtest-cli-design.md`

- [ ] **Step 1: Add a cross-reference to the "P/L per order" list**

Replace:
```markdown
P/L per order:

- points = `(exitPrice - entry) * qty` for longs, `(entry - exitPrice) * qty`
  for shorts
- dollars = `points * multiplier`
- `NOT_FILLED` orders have no P/L and are excluded from win/loss counts.
```
with:
```markdown
P/L per order:

- points = `(exitPrice - entry) * qty` for longs, `(entry - exitPrice) * qty`
  for shorts
- dollars = `points * multiplier`
- `NOT_FILLED` orders have no P/L and are excluded from win/loss counts.
- Outcome-quality metrics (`maxAdverseExcursion`, `maxFavorableExcursion`,
  `rMultiple` for filled orders; `closestApproach` for `NOT_FILLED`) are
  also computed per order — see
  `docs/superpowers/specs/2026-07-22-run-enrichment-design.md`.
```

- [ ] **Step 2: Add a cross-reference to the "Output" section**

Replace:
```markdown
## Output

Default: a human-readable table on stdout, one row per order —
`id, side, status (TP|SL|EOD|NOT_FILLED), fill time, exit time, exit price,
P/L points, P/L dollars` — followed by a summary: orders placed, filled, wins,
losses, net points, net dollars. Times are formatted in `--tz`.

`--json`: the same data as a JSON object `{ session, orders: [...],
summary: {...} }` for downstream tooling.
```
with:
```markdown
## Output

Default: a human-readable table on stdout, one row per order —
`id, side, status (TP|SL|EOD|NOT_FILLED), fill time, exit time, exit price,
P/L points, P/L dollars` — followed by a summary: orders placed, filled, wins,
losses, net points, net dollars. Times are formatted in `--tz`. The table also
carries `MAE`/`MFE`/`R`/`CLOSEST` columns for the outcome-quality metrics
above.

`--json`: the same data as a JSON object `{ session, orders: [...],
summary: {...} }` for downstream tooling.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-07-17-backtest-cli-design.md
git commit -m "docs: cross-reference run-enrichment metrics from the backtest CLI spec"
```
