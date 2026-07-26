import { analyzeCoverage } from './coverage';
import { Candle } from './candle';

// Build a full RTH 5-min day (78 bars, 09:30..15:55 ET) for 2026-07-14.
const OPEN = Math.floor(Date.UTC(2026, 6, 14, 13, 30, 0) / 1000); // 09:30 ET
const STEP = 300;
const WINDOW = { openMin: 570, closeMin: 960, intervalSec: 300, tz: 'America/New_York' };

function bar(time: number): Candle {
  return { time, open: 1, high: 2, low: 0, close: 1 };
}
function fullDay(): Candle[] {
  return Array.from({ length: 78 }, (_, i) => bar(OPEN + i * STEP));
}

describe('analyzeCoverage', () => {
  it('a full RTH day is complete', () => {
    const r = analyzeCoverage(fullDay(), WINDOW);
    expect(r.complete).toBe(true);
    expect(r.expectedCount).toBe(78);
    expect(r.presentCount).toBe(78);
    expect(r.hasOpen).toBe(true);
    expect(r.hasClose).toBe(true);
    expect(r.gaps).toEqual([]);
  });

  it('a missing interior bar is an incomplete day with a gap', () => {
    const candles = fullDay().filter((_, i) => i !== 40); // drop one mid-session bar
    const r = analyzeCoverage(candles, WINDOW);
    expect(r.complete).toBe(false);
    expect(r.presentCount).toBe(77);
    expect(r.gaps).toEqual([{ afterTime: OPEN + 39 * STEP, missing: 1 }]);
  });

  it('a late start (no open bar) is incomplete', () => {
    const r = analyzeCoverage(fullDay().slice(1), WINDOW);
    expect(r.complete).toBe(false);
    expect(r.hasOpen).toBe(false);
  });

  it('an early end (no close bar) is incomplete', () => {
    const r = analyzeCoverage(fullDay().slice(0, -1), WINDOW);
    expect(r.complete).toBe(false);
    expect(r.hasClose).toBe(false);
  });

  it('ignores candles outside the RTH window', () => {
    const withPremarket = [bar(OPEN - STEP), ...fullDay()];
    const r = analyzeCoverage(withPremarket, WINDOW);
    expect(r.complete).toBe(true);
    expect(r.presentCount).toBe(78);
  });

  it('throws when the window is not divisible by the interval', () => {
    // 390-min RTH with a 3600s (60-min) interval => 6.5 bars, incoherent.
    expect(() => analyzeCoverage(fullDay(), { ...WINDOW, intervalSec: 3600 })).toThrow(/divisible/i);
  });

  it('a duplicate timestamp that masks a drop is still incomplete', () => {
    // full day minus bar #40, plus a duplicate of bar #10 => presentCount back to 78
    const candles = [...fullDay().filter((_, i) => i !== 40), fullDay()[10]];
    const r = analyzeCoverage(candles, WINDOW);
    expect(r.complete).toBe(false);
    // gaps must never carry a bogus negative/fractional `missing`
    expect(r.gaps.every((g) => Number.isInteger(g.missing) && g.missing > 0)).toBe(true);
  });

  it('an off-grid bar (not on the interval) is incomplete', () => {
    // insert a bar 2 minutes after the open (09:32) — off the 5-min grid
    const candles = [...fullDay(), bar(OPEN + 120)];
    const r = analyzeCoverage(candles, WINDOW);
    expect(r.complete).toBe(false);
  });

  it('plain duplicate of a present bar is incomplete', () => {
    const candles = [...fullDay(), fullDay()[10]];
    const r = analyzeCoverage(candles, WINDOW);
    expect(r.complete).toBe(false);
  });
});
