// Canonical candle used by the engine and returned by MarketDataService.
export interface Candle {
  time: number; // Unix epoch seconds
  open: number;
  high: number;
  low: number;
  close: number;
}

// Compact on-disk projection stored inside a day-doc's `candles` array.
export interface StoredCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export function toStored(c: Candle): StoredCandle {
  return { t: c.time, o: c.open, h: c.high, l: c.low, c: c.close };
}

export function fromStored(s: StoredCandle): Candle {
  return { time: s.t, open: s.o, high: s.h, low: s.l, close: s.c };
}

// Only intervals that evenly divide the 390-minute RTH window are supported, so
// completeness is always a whole number of bars. min-60 is excluded on purpose:
// 09:30-16:00 is 6.5 hours, so hourly bars can never fully cover RTH.
export type Interval = 'min-1' | 'min-5' | 'min-15';

const INTERVAL_SECONDS: Record<Interval, number> = {
  'min-1': 60,
  'min-5': 300,
  'min-15': 900,
};

export function isInterval(value: string): value is Interval {
  return Object.prototype.hasOwnProperty.call(INTERVAL_SECONDS, value);
}

export function intervalToSeconds(interval: Interval): number {
  return INTERVAL_SECONDS[interval];
}
