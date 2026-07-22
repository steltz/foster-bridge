import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateOrder, simulate } from '../src/engine.js';

// Candle shorthand: c(time, open, high, low, close)
const c = (time, open, high, low, close) => ({ time, open, high, low, close });

const longOrder = { id: 'l', side: 'long', entry: 100, stopLoss: 95, takeProfit: 110, qty: 1 };
const shortOrder = { id: 's', side: 'short', entry: 100, stopLoss: 105, takeProfit: 90, qty: 1 };

test('order never touched is NOT_FILLED', () => {
  const candles = [c(1, 120, 125, 115, 120)];
  assert.deepEqual(simulateOrder(longOrder, candles), {
    status: 'NOT_FILLED', fillTime: null, exitTime: null, exitPrice: null,
    maxAdverseExcursion: null, maxFavorableExcursion: null, rMultiple: null,
    closestApproach: 15,
  });
});

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

test('fill and exit can happen on the same candle', () => {
  const candles = [c(1, 108, 111, 100, 110)]; // touches entry 100 AND high >= 110
  assert.deepEqual(simulateOrder(longOrder, candles), {
    status: 'TP', fillTime: 1, exitTime: 1, exitPrice: 110,
    maxAdverseExcursion: 0, maxFavorableExcursion: 11, rMultiple: 2,
    closestApproach: null,
  });
});

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

test('no cutoff (default) fills regardless of time of day', () => {
  const late = Date.UTC(2026, 5, 30, 22, 0) / 1000;
  const candles = [c(late, 108, 111, 100, 110)]; // touches entry and TP
  assert.equal(simulateOrder(longOrder, candles).status, 'TP');
});

test('long does NOT fill when price floats up through the entry from below', () => {
  // Price is below the entry, then rises up through it — a buy limit should
  // not fill on a wrong-side (upward) crossing.
  const candles = [
    c(1, 96, 98, 95, 97),    // entirely below entry 100
    c(2, 98, 105, 97, 104),  // rises up through 100 (open 98 < 100)
  ];
  assert.equal(simulateOrder(longOrder, candles).status, 'NOT_FILLED');
});

test('long fills on a genuine pullback after price rallies above the entry', () => {
  const candles = [
    c(1, 96, 98, 95, 97),      // below entry
    c(2, 98, 112, 97, 110),    // rallies above 100 -> now on the correct side
    c(3, 103, 105, 100, 104),  // pulls back down to 100 -> fill
  ];
  const r = simulateOrder(longOrder, candles);
  assert.notEqual(r.status, 'NOT_FILLED');
  assert.equal(r.fillTime, 3);
});

test('long that opens below and stays below never fills', () => {
  const candles = [c(1, 96, 99, 95, 98), c(2, 97, 99, 94, 96)];
  assert.equal(simulateOrder(longOrder, candles).status, 'NOT_FILLED');
});

test('long still fills on a normal downward touch from above', () => {
  const candles = [c(1, 105, 106, 100, 101), c(2, 101, 111, 101, 110)];
  const r = simulateOrder(longOrder, candles);
  assert.equal(r.status, 'TP');
  assert.equal(r.fillTime, 1);
});

test('short does NOT fill when price drops down through the entry from above', () => {
  const candles = [
    c(1, 104, 105, 102, 103),  // above entry 100
    c(2, 102, 103, 95, 96),    // drops down through 100 (open 102 > 100)
  ];
  assert.equal(simulateOrder(shortOrder, candles).status, 'NOT_FILLED');
});

test('does not fill an entry before the open time', () => {
  const early = Date.UTC(2026, 5, 30, 9, 45) / 1000; // 09:45 UTC == 585 minutes
  const candles = [c(early, 108, 111, 100, 110)];     // would touch entry and TP
  assert.deepEqual(simulateOrder(longOrder, candles, { openMinutes: 600, tz: 'UTC' }), {
    status: 'NOT_FILLED', fillTime: null, exitTime: null, exitPrice: null,
    maxAdverseExcursion: null, maxFavorableExcursion: null, rMultiple: null,
    closestApproach: null,
  });
});

test('fills an entry at or after the open time', () => {
  const atOpen = Date.UTC(2026, 5, 30, 10, 0) / 1000; // 10:00 UTC == 600 minutes
  const candles = [c(atOpen, 108, 111, 100, 110)];
  assert.equal(simulateOrder(longOrder, candles, { openMinutes: 600, tz: 'UTC' }).status, 'TP');
});

test('open and cutoff together bound the entry window', () => {
  const early = Date.UTC(2026, 5, 30, 9, 45) / 1000;  // before open -> blocked
  const inWindow = Date.UTC(2026, 5, 30, 11, 0) / 1000;
  const candles = [c(early, 108, 111, 100, 101), c(inWindow, 101, 111, 100, 110)];
  const r = simulateOrder(longOrder, candles, { openMinutes: 600, cutoffMinutes: 840, tz: 'UTC' });
  assert.equal(r.status, 'TP');
  assert.equal(r.fillTime, inWindow);
});

test('simulate threads the cutoff option through to every order', () => {
  const atCutoff = Date.UTC(2026, 5, 30, 14, 0) / 1000;
  const candles = [c(atCutoff, 108, 111, 100, 110)];
  const { results, summary } = simulate(candles, [longOrder], 5, { cutoffMinutes: 840, tz: 'UTC' });
  assert.equal(results[0].status, 'NOT_FILLED');
  assert.equal(summary.filled, 0);
});

test('simulate computes P/L and summary', () => {
  const candles = [
    c(1, 101, 102, 100, 101),
    c(2, 101, 111, 101, 110),  // long TP at 110
  ];
  const orders = [
    longOrder,                                                             // +10 pts
    { id: 'q2', side: 'long', entry: 100, stopLoss: 95, takeProfit: 110, qty: 2 }, // +20 pts
    { id: 'miss', side: 'long', entry: 50, stopLoss: 45, takeProfit: 60, qty: 1 }, // not filled
  ];
  const { results, summary } = simulate(candles, orders, 5);
  assert.equal(results[0].points, 10);
  assert.equal(results[0].dollars, 50);
  assert.equal(results[1].points, 20);
  assert.equal(results[1].dollars, 100);
  assert.equal(results[2].status, 'NOT_FILLED');
  assert.equal(results[2].points, null);
  assert.deepEqual(summary, {
    orders: 3, filled: 2, wins: 2, losses: 0, netPoints: 30, netDollars: 150,
  });
});

test('a losing short counts as a loss in the summary', () => {
  const candles = [
    c(1, 99, 101, 98, 99),
    c(2, 99, 106, 99, 105),    // short SL at 105 -> -5 pts
  ];
  const { results, summary } = simulate(candles, [shortOrder], 5);
  assert.equal(results[0].points, -5);
  assert.equal(results[0].dollars, -25);
  assert.deepEqual(summary, {
    orders: 1, filled: 1, wins: 0, losses: 1, netPoints: -5, netDollars: -25,
  });
});

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

test('rMultiple is null (not Infinity/NaN) when entry equals stopLoss', () => {
  const zeroRiskOrder = { id: 'zero-risk', side: 'long', entry: 100, stopLoss: 100, takeProfit: 110, qty: 1 };
  // A single bearish candle: touches entry 100 to fill, and since stopLoss
  // also sits at 100, the same candle immediately satisfies both SL and TP
  // (94 <= 100 and 111 >= 110) -- ambiguous-candle resolution picks TP
  // because the candle is bearish (close 95 < open 111).
  const candles = [c(1, 111, 111, 94, 95)];
  const r = simulateOrder(zeroRiskOrder, candles);
  assert.equal(r.status, 'TP');
  assert.equal(r.rMultiple, null);
});
