import { Candle } from './candle';
import { minutesOfDayForTimestamp } from '../common/session-time';

export interface CoverageWindow {
  openMin: number; // RTH open, minutes since local midnight (e.g. 570)
  closeMin: number; // RTH close, minutes since local midnight (e.g. 960)
  intervalSec: number;
  tz: string;
}

export interface CoverageGap {
  afterTime: number; // epoch seconds of the candle the gap follows
  missing: number; // number of absent bars in the gap
}

export interface CoverageResult {
  complete: boolean;
  expectedCount: number;
  presentCount: number;
  hasOpen: boolean;
  hasClose: boolean;
  gaps: CoverageGap[];
}

// Judges whether `candles` fully cover the [openMin, closeMin) RTH grid at
// `intervalSec` spacing. DST-safe: local minutes are read off real timestamps,
// and DST transitions never fall inside RTH.
export function analyzeCoverage(candles: Candle[], window: CoverageWindow): CoverageResult {
  const { openMin, closeMin, intervalSec, tz } = window;
  if (intervalSec % 60 !== 0) {
    throw new Error(`intervalSec must be a whole number of minutes (got ${intervalSec})`);
  }
  const intervalMin = intervalSec / 60;
  if ((closeMin - openMin) % intervalMin !== 0) {
    throw new Error(
      `RTH window (${closeMin - openMin} min) is not divisible by interval (${intervalMin} min)`,
    );
  }
  const expectedCount = (closeMin - openMin) / intervalMin;

  const inWindow = candles
    .filter((c) => {
      const m = minutesOfDayForTimestamp(c.time, tz);
      return m >= openMin && m < closeMin;
    })
    .sort((a, b) => a.time - b.time);

  const presentCount = inWindow.length;
  const hasOpen = presentCount > 0 && minutesOfDayForTimestamp(inWindow[0].time, tz) === openMin;
  const hasClose =
    presentCount > 0 && minutesOfDayForTimestamp(inWindow[presentCount - 1].time, tz) === closeMin - intervalMin;

  // Diagnostic gaps hold ONLY genuine drops (a positive whole-bar multiple of
  // the interval). Any other non-grid spacing (duplicate timestamp, off-grid
  // bar) trips `contiguous` instead, so the completeness verdict never depends
  // on gap bookkeeping — a future change to `gaps` cannot resurrect a false
  // positive.
  const gaps: CoverageGap[] = [];
  let contiguous = true;
  for (let i = 1; i < inWindow.length; i++) {
    const delta = inWindow[i].time - inWindow[i - 1].time;
    if (delta === intervalSec) continue;
    contiguous = false;
    if (delta > intervalSec && delta % intervalSec === 0) {
      gaps.push({ afterTime: inWindow[i - 1].time, missing: delta / intervalSec - 1 });
    }
  }

  const complete = hasOpen && hasClose && contiguous && presentCount === expectedCount;
  return { complete, expectedCount, presentCount, hasOpen, hasClose, gaps };
}
