import { CostService } from './cost.service';
import { CostRecord, UsageEvent } from './cost.types';

class FakeRepo {
  saved: CostRecord[] = [];
  async save(r: CostRecord) {
    this.saved.push(r);
  }
  async list() {
    return this.saved;
  }
}

const event = (over: Partial<UsageEvent> = {}): UsageEvent => ({
  id: 'evt-1',
  timestamp: '2026-07-27T13:00:00.000Z',
  modelId: 'claude-fable-5',
  serviceTier: 'batch',
  attribution: { operation: 'setup', benchmark: { modelAlias: 'fable', day: '07222026', trader: 'context-trader', variant: 'base', runIndex: 1 } },
  tokens: { input: 20, cacheRead: 3227, cacheCreate5m: 0, cacheCreate1h: 16434, output: 2157 },
  source: 'batch',
  batchId: 'msgbatch_x',
  ...over,
});

describe('CostService.onUsage', () => {
  it('prices the event and persists a record with model alias, tier, operation, benchmark', async () => {
    const repo = new FakeRepo();
    const svc = new CostService(repo as any);
    await svc.onUsage(event());
    expect(repo.saved).toHaveLength(1);
    const r = repo.saved[0];
    expect(r.model).toEqual({ alias: 'fable', id: 'claude-fable-5' });
    expect(r.serviceTier).toBe('batch');
    expect(r.operation).toBe('setup');
    expect(r.benchmark?.trader).toBe('context-trader');
    expect(r.cost!.total).toBeGreaterThan(0);
    expect(r.pricingVersion).toBe('fable-2026-07');
  });

  it('records cost:null + a note for an unknown model, still persists', async () => {
    const repo = new FakeRepo();
    const svc = new CostService(repo as any);
    await svc.onUsage(event({ modelId: 'claude-unknown-9', attribution: { operation: 'demo' } }));
    const r = repo.saved[0];
    expect(r.cost).toBeNull();
    expect(r.pricingVersion).toBeNull();
    expect(r.note).toMatch(/unpriced/i);
    expect(r.model.alias).toBe('claude-unknown-9'); // no benchmark alias -> id
  });

  it('never throws out of onUsage even if the repo fails', async () => {
    const svc = new CostService({ save: () => Promise.reject(new Error('firestore down')), list: async () => [] } as any);
    await expect(svc.onUsage(event())).resolves.toBeUndefined();
  });

  it('summarize groups totals by the requested dimension', async () => {
    const repo = new FakeRepo();
    const svc = new CostService(repo as any);
    await svc.onUsage(event({ id: 'a', serviceTier: 'batch' }));
    await svc.onUsage(event({ id: 'b', serviceTier: 'standard', tokens: { input: 1_000_000, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0, output: 0 } }));
    const summary = await svc.summarize({ groupBy: 'tier' });
    const tiers = summary.groups.map((g) => g.key).sort();
    expect(tiers).toEqual(['batch', 'standard']);
    expect(summary.totalUsd).toBeCloseTo(summary.groups.reduce((s, g) => s + g.usd, 0), 6);
  });

  it('reports gross read discount and net cache benefit', async () => {
    const repo = new FakeRepo();
    const svc = new CostService(repo as any);
    // Event 'a' has cacheRead tokens (a read discount) AND 1h cacheCreate (write premium).
    await svc.onUsage(event({ id: 'a' }));
    const s = await svc.summarize({ groupBy: 'tier' });
    expect(s.grossCacheReadDiscountUsd).toBeGreaterThan(0); // read tokens exist
    // Net = uncachedInputEquiv - (input+cacheRead+cacheCreate) paid; heavy 1h writes can push it negative.
    expect(typeof s.netCacheBenefitUsd).toBe('number');
  });

  it('groups by calendar date (request timestamp), distinct from benchmark day', async () => {
    const repo = new FakeRepo();
    const svc = new CostService(repo as any);
    await svc.onUsage(event({ id: 'a', timestamp: '2026-07-22T10:00:00.000Z' }));
    await svc.onUsage(event({ id: 'b', timestamp: '2026-07-23T10:00:00.000Z' }));
    const s = await svc.summarize({ groupBy: 'date' });
    expect(s.groups.map((g) => g.key).sort()).toEqual(['2026-07-22', '2026-07-23']);
  });
});
