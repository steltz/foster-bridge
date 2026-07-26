import { ExecutionEngine } from './execution-engine';

describe('ExecutionEngine', () => {
  it('delegates simulate() to the pure engine', () => {
    const engine = new ExecutionEngine();
    const candles = [{ time: 1, open: 100, high: 100, low: 95, close: 96 }];
    const orders = [{ id: 'long-1', side: 'long' as const, entry: 100, stopLoss: 95, takeProfit: 110, qty: 1 }];
    const { summary } = engine.simulate(candles, orders, 5);
    expect(summary.orders).toBe(1);
  });
});
