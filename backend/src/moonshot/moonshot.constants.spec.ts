import { BATCHABLE_MODELS, isBatchable } from './moonshot.constants';
import { priceUsage } from '../cost/pricing';

describe('moonshot batchable-model invariants', () => {
  it('locks kimi-k3 as never batchable — the routing decision the hybrid design hangs on', () => {
    expect(isBatchable('kimi-k3')).toBe(false);
  });

  it('every batchable model is priced right now (batchable ⊆ priced)', () => {
    const tokens = { input: 1_000_000, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0, output: 0 };
    const now = new Date().toISOString();
    const unpriced = [...BATCHABLE_MODELS].filter((m) => priceUsage(tokens, m, 'batch', now) === null);
    expect(BATCHABLE_MODELS.size).toBeGreaterThan(0); // an empty set must not pass vacuously
    expect(unpriced).toEqual([]);
  });
});
