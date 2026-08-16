import { fromStored, toStored } from './candle';

describe('candle stored-shape round-trip', () => {
  it('carries volume through toStored/fromStored as v', () => {
    const stored = toStored({ time: 60, open: 1, high: 2, low: 0.5, close: 1.5, volume: 955 });
    expect(stored).toEqual({ t: 60, o: 1, h: 2, l: 0.5, c: 1.5, v: 955 });
    expect(fromStored(stored)).toEqual({ time: 60, open: 1, high: 2, low: 0.5, close: 1.5, volume: 955 });
  });

  it('omits the field entirely when volume is absent (CSV-sourced candles; Firestore rejects undefined)', () => {
    const stored = toStored({ time: 60, open: 1, high: 2, low: 0.5, close: 1.5 });
    expect(stored).toEqual({ t: 60, o: 1, h: 2, l: 0.5, c: 1.5 });
    expect('v' in stored).toBe(false);
    const back = fromStored(stored);
    expect(back).toEqual({ time: 60, open: 1, high: 2, low: 0.5, close: 1.5 });
    expect('volume' in back).toBe(false);
  });

  it('preserves volume 0 (falsy but real)', () => {
    expect(toStored({ time: 60, open: 1, high: 1, low: 1, close: 1, volume: 0 }).v).toBe(0);
    expect(fromStored({ t: 60, o: 1, h: 1, l: 1, c: 1, v: 0 }).volume).toBe(0);
  });
});
