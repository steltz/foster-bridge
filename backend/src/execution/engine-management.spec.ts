import { simulateOrder, simulate } from './engine';
import { Candle } from '../market-data/candle';
import { NormalizedOrder } from './orders';

// Candle shorthand: c(time, open, high, low, close)
const c = (time: number, open: number, high: number, low: number, close: number): Candle => ({
  time,
  open,
  high,
  low,
  close,
});

// risk = 5; trigger 1.5R -> 107.5; breakeven stop -> 100
const managedLong: NormalizedOrder = {
  id: 'ml',
  side: 'long',
  entry: 100,
  stopLoss: 95,
  takeProfit: 120,
  qty: 1,
  management: [{ triggerR: 1.5, takeFraction: 0.5, moveStopToR: 0, triggerPrice: 107.5, newStop: 100 }],
};

const fillCandle = c(1, 101, 102, 100, 101); // touches entry 100 -> fill

describe('engine: managed orders', () => {
  it('canonical play: trigger fires (scale half, stop to BE), runner scratches -> BE at +0.75R', () => {
    const candles = [
      fillCandle,
      c(2, 101, 108, 101, 107), // bullish; high 108 >= 107.5 -> trigger fires
      c(3, 107, 107, 99, 100), // low 99 <= newStop 100 -> runner exits BE
    ];
    const r = simulateOrder(managedLong, candles);
    expect(r.status).toBe('BE');
    expect(r.exitTime).toBe(3);
    expect(r.exitPrice).toBe(100);
    expect(r.scaleExit).toEqual({ time: 2, price: 107.5, fraction: 0.5 });
    expect(r.rMultiple).toBeCloseTo(0.75); // 0.5*1.5 + 0.5*0
  });

  it('runner reaches the full target -> TP with blended rMultiple', () => {
    const candles = [
      fillCandle,
      c(2, 101, 108, 101, 107), // trigger fires
      c(3, 107, 121, 106, 120), // high >= 120 -> runner TP
    ];
    const r = simulateOrder(managedLong, candles);
    expect(r.status).toBe('TP');
    expect(r.scaleExit).toEqual({ time: 2, price: 107.5, fraction: 0.5 });
    expect(r.rMultiple).toBeCloseTo(2.75); // 0.5*1.5 + 0.5*4
  });

  it('trigger never fires -> plain SL at -1R, no scale exit', () => {
    const candles = [fillCandle, c(2, 101, 105, 94, 95)]; // never reaches 107.5; low <= 95
    const r = simulateOrder(managedLong, candles);
    expect(r.status).toBe('SL');
    expect(r.scaleExit).toBeUndefined();
    expect(r.rMultiple).toBe(-1);
  });

  it('pure breakeven rule (no takeFraction): trigger then stop-hit -> BE at 0R, no scale exit', () => {
    const order: NormalizedOrder = {
      ...managedLong,
      management: [{ triggerR: 1.5, takeFraction: null, moveStopToR: 0, triggerPrice: 107.5, newStop: 100 }],
    };
    const candles = [fillCandle, c(2, 101, 108, 101, 107), c(3, 107, 107, 99, 100)];
    const r = simulateOrder(order, candles);
    expect(r.status).toBe('BE');
    expect(r.scaleExit).toBeUndefined();
    expect(r.rMultiple).toBeCloseTo(0);
  });

  it('pure partial (no stop move): scale then original SL -> status SL with positive blended R', () => {
    const order: NormalizedOrder = {
      ...managedLong,
      management: [{ triggerR: 1.5, takeFraction: 0.5, moveStopToR: null, triggerPrice: 107.5, newStop: null }],
    };
    const candles = [fillCandle, c(2, 101, 108, 101, 107), c(3, 107, 107, 94, 95)];
    const r = simulateOrder(order, candles);
    expect(r.status).toBe('SL');
    expect(r.scaleExit).toEqual({ time: 2, price: 107.5, fraction: 0.5 });
    expect(r.rMultiple).toBeCloseTo(0.25); // 0.5*1.5 + 0.5*(-1)
  });

  it('bearish candle spanning trigger and new stop: trigger fires on the high leg, runner BE on the low leg', () => {
    const candles = [fillCandle, c(2, 108, 108, 99.5, 100)]; // bearish: O->H->L->C
    const r = simulateOrder(managedLong, candles);
    expect(r.status).toBe('BE');
    expect(r.exitTime).toBe(2);
    expect(r.scaleExit).toEqual({ time: 2, price: 107.5, fraction: 0.5 });
    expect(r.rMultiple).toBeCloseTo(0.75);
  });

  it('bullish candle spanning old stop and trigger: low leg first -> SL, trigger never fires', () => {
    const candles = [fillCandle, c(2, 101, 108, 94, 107)]; // bullish: O->L->H->C
    const r = simulateOrder(managedLong, candles);
    expect(r.status).toBe('SL');
    expect(r.scaleExit).toBeUndefined();
    expect(r.rMultiple).toBe(-1);
  });

  it('trigger and TP in one candle: partial exits en route, runner exits TP same candle', () => {
    const candles = [fillCandle, c(2, 101, 121, 101, 120)];
    const r = simulateOrder(managedLong, candles);
    expect(r.status).toBe('TP');
    expect(r.exitTime).toBe(2);
    expect(r.scaleExit).toEqual({ time: 2, price: 107.5, fraction: 0.5 });
    expect(r.rMultiple).toBeCloseTo(2.75);
  });

  it('EOD after trigger: runner closes at last close with blended R, scale exit preserved', () => {
    const candles = [fillCandle, c(2, 101, 108, 101, 107), c(3, 107, 107, 102, 103)];
    const r = simulateOrder(managedLong, candles);
    expect(r.status).toBe('EOD');
    expect(r.exitPrice).toBe(103);
    expect(r.scaleExit).toEqual({ time: 2, price: 107.5, fraction: 0.5 });
    expect(r.rMultiple).toBeCloseTo(1.05); // 0.5*1.5 + 0.5*0.6
  });

  it('short mirror: trigger on the low leg, runner BE when price rallies back to entry', () => {
    const order: NormalizedOrder = {
      id: 'ms',
      side: 'short',
      entry: 100,
      stopLoss: 105,
      takeProfit: 85,
      qty: 1,
      management: [{ triggerR: 1.5, takeFraction: 0.5, moveStopToR: 0, triggerPrice: 92.5, newStop: 100 }],
    };
    const candles = [
      c(1, 99, 101, 98, 99), // touches entry 100 -> fill
      c(2, 99, 99, 92, 93), // low 92 <= 92.5 -> trigger fires
      c(3, 93, 100.5, 93, 100), // high >= newStop 100 -> runner BE
    ];
    const r = simulateOrder(order, candles);
    expect(r.status).toBe('BE');
    expect(r.exitPrice).toBe(100);
    expect(r.scaleExit).toEqual({ time: 2, price: 92.5, fraction: 0.5 });
    expect(r.rMultiple).toBeCloseTo(0.75);
  });

  it('an unmanaged order still reports no scaleExit field', () => {
    const plain: NormalizedOrder = { id: 'p', side: 'long', entry: 100, stopLoss: 95, takeProfit: 110, qty: 1 };
    const candles = [fillCandle, c(2, 101, 111, 101, 110)];
    const r = simulateOrder(plain, candles);
    expect(r.status).toBe('TP');
    expect(r.scaleExit).toBeUndefined();
  });
});

describe('engine: activeFrom', () => {
  const order: NormalizedOrder = {
    id: 'af',
    side: 'long',
    entry: 100,
    stopLoss: 95,
    takeProfit: 110,
    qty: 1,
    activeFromMinutes: 630, // 10:30
  };

  it('does not fill before the order-level activeFrom', () => {
    const early = Date.UTC(2026, 5, 30, 10, 0) / 1000; // 10:00 -> blocked
    const candles = [c(early, 108, 111, 100, 110)];
    expect(simulateOrder(order, candles, { tz: 'UTC' }).status).toBe('NOT_FILLED');
  });

  it('fills at or after activeFrom', () => {
    const at = Date.UTC(2026, 5, 30, 10, 30) / 1000;
    const candles = [c(at, 108, 111, 100, 110)];
    expect(simulateOrder(order, candles, { tz: 'UTC' }).status).toBe('TP');
  });

  it('activeFrom tightens (never loosens) the session open window', () => {
    const between = Date.UTC(2026, 5, 30, 10, 15) / 1000; // after session open 10:00, before activeFrom
    const after = Date.UTC(2026, 5, 30, 11, 0) / 1000;
    const candles = [c(between, 105, 106, 100, 101), c(after, 101, 111, 100, 110)];
    const r = simulateOrder(order, candles, { openMinutes: 600, tz: 'UTC' });
    expect(r.status).toBe('TP');
    expect(r.fillTime).toBe(after);
  });

  it('pre-activeFrom candles do not arm the order', () => {
    // Price rallies above entry before activeFrom, then touches entry from
    // above after it — the arming must come from in-window candles only.
    const early = Date.UTC(2026, 5, 30, 10, 0) / 1000; // above entry, pre-window
    const later = Date.UTC(2026, 5, 30, 11, 0) / 1000; // floats up through entry from below
    const candles = [c(early, 104, 106, 103, 105), c(later, 98, 105, 97, 104)];
    expect(simulateOrder(order, candles, { tz: 'UTC' }).status).toBe('NOT_FILLED');
  });
});

describe('simulate: managed accounting', () => {
  it('blends points/dollars across the scale and runner legs and counts scratches', () => {
    const order: NormalizedOrder = { ...managedLong, qty: 2 };
    const candles = [
      fillCandle,
      c(2, 101, 108, 101, 107), // trigger
      c(3, 107, 107, 99, 100), // runner BE
    ];
    const { results, summary } = simulate(candles, [order], 5);
    // per unit: 0.5*(107.5-100) + 0.5*0 = 3.75; qty 2 -> 7.5 pts -> $37.50
    expect(results[0].status).toBe('BE');
    expect(results[0].points).toBeCloseTo(7.5);
    expect(results[0].dollars).toBeCloseTo(37.5);
    expect(summary.scratches).toBe(1);
    expect(summary.wins).toBe(1); // positive blended points count as a win
    expect(summary.losses).toBe(0);
    expect(summary.netPoints).toBeCloseTo(7.5);
  });

  it('unmanaged summaries report zero scratches', () => {
    const plain: NormalizedOrder = { id: 'p', side: 'long', entry: 100, stopLoss: 95, takeProfit: 110, qty: 1 };
    const candles = [fillCandle, c(2, 101, 111, 101, 110)];
    const { summary } = simulate(candles, [plain], 5);
    expect(summary.scratches).toBe(0);
  });
});
