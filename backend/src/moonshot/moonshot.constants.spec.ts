import { BATCHABLE_MODELS, isBatchable } from './moonshot.constants';
import { priceUsage } from '../cost/pricing';

describe('moonshot batchable-model invariants', () => {
  it('locks kimi-k3 as never batchable — the routing decision the hybrid design hangs on', () => {
    expect(isBatchable('kimi-k3')).toBe(false);
  });

  it('every batchable model is priced (batchable ⊆ priced)', () => {
    for (const model of BATCHABLE_MODELS) {
      const result = priceUsage(
        { input: 1_000_000, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0, output: 0 },
        model,
        'batch',
        '2026-07-28T00:00:00.000Z',
      );
      expect(result).not.toBeNull();
    }
  });
});
