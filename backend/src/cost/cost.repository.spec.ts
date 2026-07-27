import { CostRepository } from './cost.repository';
import { CostRecord } from './cost.types';

// Minimal in-spec Firestore fake (write-once create + collection scan), mirroring
// the app's create()/get() usage. Matches test/fake-firestore.ts semantics.
function fakeDb() {
  const docs = new Map<string, any>();
  return {
    docs,
    collection: (base: string) => ({
      doc: (id: string) => ({
        create: (data: any) =>
          docs.has(`${base}/${id}`)
            ? Promise.reject(Object.assign(new Error('ALREADY_EXISTS'), { code: 6 }))
            : Promise.resolve(void docs.set(`${base}/${id}`, data)),
      }),
      get: () =>
        Promise.resolve({
          docs: [...docs.entries()]
            .filter(([k]) => k.startsWith(base + '/'))
            .map(([, v]) => ({ data: () => v })),
        }),
    }),
  } as any;
}

const rec = (id: string): CostRecord => ({
  id,
  timestamp: '2026-07-27T13:00:00.000Z',
  model: { alias: 'fable', id: 'claude-fable-5' },
  serviceTier: 'standard',
  operation: 'warm',
  tokens: { input: 20, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 100, output: 5 },
  cost: { input: 0, cacheRead: 0, cacheCreate: 0, output: 0, total: 0.001, uncachedInputEquiv: 0.0012 },
  pricingVersion: 'fable-2026-07',
  source: 'sync',
});

describe('CostRepository', () => {
  it('saves a record and reads it back', async () => {
    const db = fakeDb();
    const repo = new CostRepository(db);
    await repo.save(rec('a'));
    const all = await repo.list();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('a');
  });

  it('is idempotent — a duplicate id is swallowed (batch write-once)', async () => {
    const db = fakeDb();
    const repo = new CostRepository(db);
    await repo.save(rec('dup'));
    await expect(repo.save(rec('dup'))).resolves.toBeUndefined();
    expect(await repo.list()).toHaveLength(1);
  });

  it('filters by model on read', async () => {
    const db = fakeDb();
    const repo = new CostRepository(db);
    await repo.save(rec('a'));
    await repo.save({ ...rec('b'), model: { alias: 'opus', id: 'claude-opus-4-8' } });
    const fable = await repo.list({ model: 'fable' });
    expect(fable.map((r) => r.id)).toEqual(['a']);
  });
});
