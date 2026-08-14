import { normalizeOrders } from './orders';

describe('normalizeOrders', () => {
  it('normalizes a valid long and short with defaults', () => {
    const orders = normalizeOrders([
      { side: 'long', entry: 7530, stopLoss: 7520, takeProfit: 7550 },
      { id: 'fade', side: 'short', entry: 7560, stopLoss: 7570, takeProfit: 7540, qty: 2 },
    ]);
    expect(orders).toEqual([
      { id: 'long-1', side: 'long', entry: 7530, stopLoss: 7520, takeProfit: 7550, qty: 1 },
      { id: 'fade', side: 'short', entry: 7560, stopLoss: 7570, takeProfit: 7540, qty: 2 },
    ]);
  });

  it('rejects non-array input', () => {
    expect(() => normalizeOrders({})).toThrow(/must be a JSON array/);
  });

  it('rejects an invalid side', () => {
    expect(() =>
      normalizeOrders([{ side: 'buy', entry: 1, stopLoss: 0, takeProfit: 2 }]),
    ).toThrow(/Order 1: side must be "long" or "short"/);
  });

  it('rejects a non-numeric field', () => {
    expect(() =>
      normalizeOrders([{ side: 'long', entry: '7530', stopLoss: 7520, takeProfit: 7550 }]),
    ).toThrow(/Order 1: entry must be a number/);
  });

  it('rejects a long with SL/TP on the wrong side of entry', () => {
    expect(() =>
      normalizeOrders([{ side: 'long', entry: 7530, stopLoss: 7540, takeProfit: 7550 }]),
    ).toThrow(/long requires stopLoss < entry < takeProfit/);
  });

  it('rejects a short with SL/TP on the wrong side of entry', () => {
    expect(() =>
      normalizeOrders([{ side: 'short', entry: 7530, stopLoss: 7520, takeProfit: 7510 }]),
    ).toThrow(/short requires takeProfit < entry < stopLoss/);
  });

  it('rejects a bad qty', () => {
    expect(() =>
      normalizeOrders([{ side: 'long', entry: 1, stopLoss: 0, takeProfit: 2, qty: 0 }]),
    ).toThrow(/qty must be a positive integer/);
  });

  it('rejects duplicate ids', () => {
    expect(() =>
      normalizeOrders([
        { id: 'a', side: 'long', entry: 1, stopLoss: 0, takeProfit: 2 },
        { id: 'a', side: 'long', entry: 1, stopLoss: 0, takeProfit: 2 },
      ]),
    ).toThrow(/Duplicate order id: "a"/);
  });
});

describe('normalizeOrders: management', () => {
  // risk = |100 - 95| = 5
  const base = { side: 'long', entry: 100, stopLoss: 95, takeProfit: 120 };

  it('normalizes the canonical rule (scale half + breakeven at 1.5R) to absolute prices', () => {
    const [o] = normalizeOrders([
      { ...base, management: [{ triggerR: 1.5, takeFraction: 0.5, moveStopToR: 0 }] },
    ]);
    expect(o.management).toEqual([
      { triggerR: 1.5, takeFraction: 0.5, moveStopToR: 0, triggerPrice: 107.5, newStop: 100 },
    ]);
  });

  it('normalizes a short rule with mirrored prices', () => {
    const [o] = normalizeOrders([
      {
        side: 'short', entry: 100, stopLoss: 105, takeProfit: 85,
        management: [{ triggerR: 1.5, takeFraction: 0.5, moveStopToR: 0 }],
      },
    ]);
    expect(o.management).toEqual([
      { triggerR: 1.5, takeFraction: 0.5, moveStopToR: 0, triggerPrice: 92.5, newStop: 100 },
    ]);
  });

  it('normalizes a pure-breakeven rule (no takeFraction)', () => {
    const [o] = normalizeOrders([{ ...base, management: [{ triggerR: 1, moveStopToR: 0 }] }]);
    expect(o.management).toEqual([
      { triggerR: 1, takeFraction: null, moveStopToR: 0, triggerPrice: 105, newStop: 100 },
    ]);
  });

  it('normalizes a pure-partial rule (no moveStopToR)', () => {
    const [o] = normalizeOrders([{ ...base, management: [{ triggerR: 1, takeFraction: 0.5 }] }]);
    expect(o.management).toEqual([
      { triggerR: 1, takeFraction: 0.5, moveStopToR: null, triggerPrice: 105, newStop: null },
    ]);
  });

  it('a positive moveStopToR locks in profit above breakeven', () => {
    const [o] = normalizeOrders([
      { ...base, management: [{ triggerR: 2, takeFraction: 0.5, moveStopToR: 0.5 }] },
    ]);
    expect(o.management![0].newStop).toBe(102.5); // entry + 0.5R
  });

  it('omits management entirely when the raw order has none', () => {
    const [o] = normalizeOrders([base]);
    expect(o.management).toBeUndefined();
  });

  it('rejects more than one management rule', () => {
    expect(() =>
      normalizeOrders([
        {
          ...base,
          management: [
            { triggerR: 1, moveStopToR: 0 },
            { triggerR: 2, moveStopToR: 0 },
          ],
        },
      ]),
    ).toThrow(/Order 1: at most one management rule/);
  });

  it('rejects a non-array management field', () => {
    expect(() => normalizeOrders([{ ...base, management: { triggerR: 1 } }])).toThrow(
      /Order 1: management must be an array/,
    );
  });

  it('rejects a rule with neither takeFraction nor moveStopToR', () => {
    expect(() => normalizeOrders([{ ...base, management: [{ triggerR: 1 }] }])).toThrow(
      /Order 1: management rule must set takeFraction or moveStopToR/,
    );
  });

  it('rejects a non-positive triggerR', () => {
    expect(() =>
      normalizeOrders([{ ...base, management: [{ triggerR: 0, moveStopToR: 0 }] }]),
    ).toThrow(/Order 1: triggerR must be a number > 0/);
  });

  it('rejects a takeFraction outside (0, 1)', () => {
    expect(() =>
      normalizeOrders([{ ...base, management: [{ triggerR: 1, takeFraction: 1 }] }]),
    ).toThrow(/Order 1: takeFraction must be strictly between 0 and 1/);
    expect(() =>
      normalizeOrders([{ ...base, management: [{ triggerR: 1, takeFraction: 0 }] }]),
    ).toThrow(/Order 1: takeFraction must be strictly between 0 and 1/);
  });

  it('rejects moveStopToR outside [0, triggerR)', () => {
    expect(() =>
      normalizeOrders([{ ...base, management: [{ triggerR: 1, moveStopToR: -0.5 }] }]),
    ).toThrow(/Order 1: moveStopToR must be >= 0 and < triggerR/);
    expect(() =>
      normalizeOrders([{ ...base, management: [{ triggerR: 1, moveStopToR: 1 }] }]),
    ).toThrow(/Order 1: moveStopToR must be >= 0 and < triggerR/);
  });

  it('rejects a trigger at or beyond takeProfit', () => {
    // risk 5, triggerR 4 -> triggerPrice 120 == takeProfit
    expect(() =>
      normalizeOrders([{ ...base, management: [{ triggerR: 4, moveStopToR: 0 }] }]),
    ).toThrow(/Order 1: management trigger \(120\) must be strictly before takeProfit \(120\)/);
  });
});

describe('normalizeOrders: activeFrom', () => {
  const base = { side: 'long', entry: 100, stopLoss: 95, takeProfit: 120 };

  it('parses activeFrom HH:MM into minutes of day', () => {
    const [o] = normalizeOrders([{ ...base, activeFrom: '10:30' }]);
    expect(o.activeFromMinutes).toBe(630);
  });

  it('omits activeFromMinutes when the raw order has none', () => {
    const [o] = normalizeOrders([base]);
    expect(o.activeFromMinutes).toBeUndefined();
  });

  it('rejects a malformed activeFrom', () => {
    expect(() => normalizeOrders([{ ...base, activeFrom: '25:00' }])).toThrow(
      /Order 1: activeFrom must be a 24-hour HH:MM time/,
    );
    expect(() => normalizeOrders([{ ...base, activeFrom: '930' }])).toThrow(
      /Order 1: activeFrom must be a 24-hour HH:MM time/,
    );
  });
});
