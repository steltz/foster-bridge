import { simulateOrder, simulate } from './engine';
import { Candle } from '../market-data/candle';

// Candle shorthand: c(time, open, high, low, close)
const c = (time: number, open: number, high: number, low: number, close: number): Candle => ({
  time,
  open,
  high,
  low,
  close,
});

const longOrder = { id: 'l', side: 'long' as const, entry: 100, stopLoss: 95, takeProfit: 110, qty: 1 };
const shortOrder = { id: 's', side: 'short' as const, entry: 100, stopLoss: 105, takeProfit: 90, qty: 1 };

describe('engine', () => {
  it('order never touched is NOT_FILLED', () => {
    const candles = [c(1, 120, 125, 115, 120)];
    expect(simulateOrder(longOrder, candles)).toEqual({
      status: 'NOT_FILLED',
      fillTime: null,
      exitTime: null,
      exitPrice: null,
      maxAdverseExcursion: null,
      maxFavorableExcursion: null,
      rMultiple: null,
      closestApproach: 15,
    });
  });

  it('long fills on touch then exits at take profit', () => {
    const candles = [
      c(1, 101, 102, 100, 101), // low touches entry 100 -> fill
      c(2, 101, 111, 101, 110), // high >= 110 -> TP
    ];
    expect(simulateOrder(longOrder, candles)).toEqual({
      status: 'TP',
      fillTime: 1,
      exitTime: 2,
      exitPrice: 110,
      maxAdverseExcursion: 0,
      maxFavorableExcursion: 11,
      rMultiple: 2,
      closestApproach: null,
    });
  });

  it('long exits at stop loss', () => {
    const candles = [
      c(1, 101, 102, 100, 101),
      c(2, 101, 102, 94, 95), // low <= 95 -> SL
    ];
    expect(simulateOrder(longOrder, candles)).toEqual({
      status: 'SL',
      fillTime: 1,
      exitTime: 2,
      exitPrice: 95,
      maxAdverseExcursion: 6,
      maxFavorableExcursion: 2,
      rMultiple: -1,
      closestApproach: null,
    });
  });

  it('long: ambiguous candle resolves to SL when the candle is bullish (dip before rally)', () => {
    const candles = [
      c(1, 101, 102, 100, 101),
      c(2, 101, 111, 94, 108), // bullish (close 108 >= open 101); spans both 95 and 110
    ];
    expect(simulateOrder(longOrder, candles).status).toBe('SL');
  });

  it('long: ambiguous candle resolves to TP when the candle is bearish (rally before selloff)', () => {
    const candles = [
      c(1, 101, 102, 100, 101),
      c(2, 111, 111, 94, 95), // bearish (close 95 < open 111); spans both 95 and 110
    ];
    expect(simulateOrder(longOrder, candles).status).toBe('TP');
  });

  it('short: ambiguous candle resolves to TP when the candle is bullish', () => {
    const candles = [
      c(1, 99, 101, 98, 99),
      c(2, 89, 106, 88, 95), // bullish (close 95 >= open 89); spans both 105 and 90
    ];
    expect(simulateOrder(shortOrder, candles).status).toBe('TP');
  });

  it('short: ambiguous candle resolves to SL when the candle is bearish', () => {
    const candles = [
      c(1, 99, 101, 98, 99),
      c(2, 106, 106, 88, 89), // bearish (close 89 < open 106); spans both 105 and 90
    ];
    expect(simulateOrder(shortOrder, candles).status).toBe('SL');
  });

  it('fill and exit can happen on the same candle', () => {
    const candles = [c(1, 108, 111, 100, 110)]; // touches entry 100 AND high >= 110
    expect(simulateOrder(longOrder, candles)).toEqual({
      status: 'TP',
      fillTime: 1,
      exitTime: 1,
      exitPrice: 110,
      maxAdverseExcursion: 0,
      maxFavorableExcursion: 11,
      rMultiple: 2,
      closestApproach: null,
    });
  });

  it('position open at end of day closes at last close as EOD', () => {
    const candles = [c(1, 101, 102, 100, 101), c(2, 101, 104, 99, 103)];
    expect(simulateOrder(longOrder, candles)).toEqual({
      status: 'EOD',
      fillTime: 1,
      exitTime: 2,
      exitPrice: 103,
      maxAdverseExcursion: 1,
      maxFavorableExcursion: 4,
      rMultiple: 0.6,
      closestApproach: null,
    });
  });

  it('short exits at take profit when price falls', () => {
    const candles = [
      c(1, 99, 101, 98, 99), // touches entry 100 -> fill
      c(2, 99, 99, 89, 90), // low <= 90 -> TP
    ];
    expect(simulateOrder(shortOrder, candles)).toEqual({
      status: 'TP',
      fillTime: 1,
      exitTime: 2,
      exitPrice: 90,
      maxAdverseExcursion: 1,
      maxFavorableExcursion: 11,
      rMultiple: 2,
      closestApproach: null,
    });
  });

  it('short exits at stop loss when price rises', () => {
    const candles = [
      c(1, 99, 101, 98, 99),
      c(2, 99, 106, 99, 105), // high >= 105 -> SL
    ];
    expect(simulateOrder(shortOrder, candles)).toEqual({
      status: 'SL',
      fillTime: 1,
      exitTime: 2,
      exitPrice: 105,
      maxAdverseExcursion: 6,
      maxFavorableExcursion: 2,
      rMultiple: -1,
      closestApproach: null,
    });
  });

  it('does not fill an entry on or after the cutoff time', () => {
    const atCutoff = Date.UTC(2026, 5, 30, 14, 0) / 1000; // 14:00 UTC == 840 minutes
    const candles = [c(atCutoff, 101, 102, 100, 101)]; // would touch entry 100
    expect(simulateOrder(longOrder, candles, { cutoffMinutes: 840, tz: 'UTC' })).toEqual({
      status: 'NOT_FILLED',
      fillTime: null,
      exitTime: null,
      exitPrice: null,
      // The only candle is at-or-after the cutoff, so it's never scanned for
      // closest-approach either — an order that was never entry-eligible has
      // no meaningful "how close did it get" answer.
      maxAdverseExcursion: null,
      maxFavorableExcursion: null,
      rMultiple: null,
      closestApproach: null,
    });
  });

  it('fills before the cutoff and still manages the exit after it', () => {
    const before = Date.UTC(2026, 5, 30, 13, 55) / 1000; // fills
    const after = Date.UTC(2026, 5, 30, 15, 0) / 1000; // TP after cutoff — allowed
    const candles = [c(before, 101, 102, 100, 101), c(after, 101, 111, 101, 110)];
    expect(simulateOrder(longOrder, candles, { cutoffMinutes: 840, tz: 'UTC' })).toEqual({
      status: 'TP',
      fillTime: before,
      exitTime: after,
      exitPrice: 110,
      maxAdverseExcursion: 0,
      maxFavorableExcursion: 11,
      rMultiple: 2,
      closestApproach: null,
    });
  });

  it('no cutoff (default) fills regardless of time of day', () => {
    const late = Date.UTC(2026, 5, 30, 22, 0) / 1000;
    const candles = [c(late, 108, 111, 100, 110)]; // touches entry and TP
    expect(simulateOrder(longOrder, candles).status).toBe('TP');
  });

  it('long does NOT fill when price floats up through the entry from below', () => {
    // Price is below the entry, then rises up through it — a buy limit should
    // not fill on a wrong-side (upward) crossing.
    const candles = [
      c(1, 96, 98, 95, 97), // entirely below entry 100
      c(2, 98, 105, 97, 104), // rises up through 100 (open 98 < 100)
    ];
    expect(simulateOrder(longOrder, candles).status).toBe('NOT_FILLED');
  });

  it('long fills on a genuine pullback after price rallies above the entry', () => {
    const candles = [
      c(1, 96, 98, 95, 97), // below entry
      c(2, 98, 112, 97, 110), // rallies above 100 -> now on the correct side
      c(3, 103, 105, 100, 104), // pulls back down to 100 -> fill
    ];
    const r = simulateOrder(longOrder, candles);
    expect(r.status).not.toBe('NOT_FILLED');
    expect(r.fillTime).toBe(3);
  });

  it('long that opens below and stays below never fills', () => {
    const candles = [c(1, 96, 99, 95, 98), c(2, 97, 99, 94, 96)];
    expect(simulateOrder(longOrder, candles).status).toBe('NOT_FILLED');
  });

  it('long still fills on a normal downward touch from above', () => {
    const candles = [c(1, 105, 106, 100, 101), c(2, 101, 111, 101, 110)];
    const r = simulateOrder(longOrder, candles);
    expect(r.status).toBe('TP');
    expect(r.fillTime).toBe(1);
  });

  it('short does NOT fill when price drops down through the entry from above', () => {
    const candles = [
      c(1, 104, 105, 102, 103), // above entry 100
      c(2, 102, 103, 95, 96), // drops down through 100 (open 102 > 100)
    ];
    expect(simulateOrder(shortOrder, candles).status).toBe('NOT_FILLED');
  });

  it('does not fill an entry before the open time', () => {
    const early = Date.UTC(2026, 5, 30, 9, 45) / 1000; // 09:45 UTC == 585 minutes
    const candles = [c(early, 108, 111, 100, 110)]; // would touch entry and TP
    expect(simulateOrder(longOrder, candles, { openMinutes: 600, tz: 'UTC' })).toEqual({
      status: 'NOT_FILLED',
      fillTime: null,
      exitTime: null,
      exitPrice: null,
      maxAdverseExcursion: null,
      maxFavorableExcursion: null,
      rMultiple: null,
      closestApproach: null,
    });
  });

  it('fills an entry at or after the open time', () => {
    const atOpen = Date.UTC(2026, 5, 30, 10, 0) / 1000; // 10:00 UTC == 600 minutes
    const candles = [c(atOpen, 108, 111, 100, 110)];
    expect(simulateOrder(longOrder, candles, { openMinutes: 600, tz: 'UTC' }).status).toBe('TP');
  });

  it('open and cutoff together bound the entry window', () => {
    const early = Date.UTC(2026, 5, 30, 9, 45) / 1000; // before open -> blocked
    const inWindow = Date.UTC(2026, 5, 30, 11, 0) / 1000;
    const candles = [c(early, 108, 111, 100, 101), c(inWindow, 101, 111, 100, 110)];
    const r = simulateOrder(longOrder, candles, { openMinutes: 600, cutoffMinutes: 840, tz: 'UTC' });
    expect(r.status).toBe('TP');
    expect(r.fillTime).toBe(inWindow);
  });

  it('simulate threads the cutoff option through to every order', () => {
    const atCutoff = Date.UTC(2026, 5, 30, 14, 0) / 1000;
    const candles = [c(atCutoff, 108, 111, 100, 110)];
    const { results, summary } = simulate(candles, [longOrder], 5, { cutoffMinutes: 840, tz: 'UTC' });
    expect(results[0].status).toBe('NOT_FILLED');
    expect(summary.filled).toBe(0);
  });

  it('simulate computes P/L and summary', () => {
    const candles = [
      c(1, 101, 102, 100, 101),
      c(2, 101, 111, 101, 110), // long TP at 110
    ];
    const orders = [
      longOrder, // +10 pts
      { id: 'q2', side: 'long' as const, entry: 100, stopLoss: 95, takeProfit: 110, qty: 2 }, // +20 pts
      { id: 'miss', side: 'long' as const, entry: 50, stopLoss: 45, takeProfit: 60, qty: 1 }, // not filled
    ];
    const { results, summary } = simulate(candles, orders, 5);
    expect(results[0].points).toBe(10);
    expect(results[0].dollars).toBe(50);
    expect(results[1].points).toBe(20);
    expect(results[1].dollars).toBe(100);
    expect(results[2].status).toBe('NOT_FILLED');
    expect(results[2].points).toBeNull();
    expect(summary).toEqual({
      orders: 3,
      filled: 2,
      wins: 2,
      losses: 0,
      scratches: 0,
      netPoints: 30,
      netDollars: 150,
    });
  });

  it('a losing short counts as a loss in the summary', () => {
    const candles = [
      c(1, 99, 101, 98, 99),
      c(2, 99, 106, 99, 105), // short SL at 105 -> -5 pts
    ];
    const { results, summary } = simulate(candles, [shortOrder], 5);
    expect(results[0].points).toBe(-5);
    expect(results[0].dollars).toBe(-25);
    expect(summary).toEqual({
      orders: 1,
      filled: 1,
      wins: 0,
      losses: 1,
      scratches: 0,
      netPoints: -5,
      netDollars: -25,
    });
  });

  it('a losing long that first ran in its favor shows high MFE alongside the loss', () => {
    const candles = [
      c(1, 101, 102, 100, 101), // fill (touches entry 100)
      c(2, 101, 108, 101, 107), // rallies to 108 (favorable) before pulling back
      c(3, 107, 107, 94, 96), // reverses hard, low <= 95 -> SL
    ];
    const r = simulateOrder(longOrder, candles);
    expect(r.status).toBe('SL');
    expect(r.maxFavorableExcursion).toBe(8); // 108 - 100
    expect(r.maxAdverseExcursion).toBe(6); // 100 - 94
    expect(r.rMultiple).toBe(-1); // (95 - 100) / 5
  });

  it('closestApproach reports the tightest miss for a short order that never fills', () => {
    const candles = [c(1, 90, 95, 88, 92), c(2, 90, 96, 89, 93)];
    const r = simulateOrder(shortOrder, candles); // shortOrder entry 100
    expect(r.status).toBe('NOT_FILLED');
    expect(r.closestApproach).toBe(4); // |96 - 100|, the closer of the two highs
  });

  it('rMultiple is null (not Infinity/NaN) when entry equals stopLoss', () => {
    const zeroRiskOrder = { id: 'zero-risk', side: 'long' as const, entry: 100, stopLoss: 100, takeProfit: 110, qty: 1 };
    // A single bearish candle: touches entry 100 to fill, and since stopLoss
    // also sits at 100, the same candle immediately satisfies both SL and TP
    // (94 <= 100 and 111 >= 110) -- ambiguous-candle resolution picks TP
    // because the candle is bearish (close 95 < open 111).
    const candles = [c(1, 111, 111, 94, 95)];
    const r = simulateOrder(zeroRiskOrder, candles);
    expect(r.status).toBe('TP');
    expect(r.rMultiple).toBeNull();
  });
});
