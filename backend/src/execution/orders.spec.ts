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
