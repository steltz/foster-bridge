import { fakeFirestore } from '../../test/fake-firestore';
import { MoonshotBatchStore } from './moonshot.batch-store';

const batch = (over: any = {}) => ({
  batchId: 'b1', model: 'kimi-k3', opts: { schema: {}, maxTokens: 100, effort: 'high' },
  status: 'in_progress', total: 2, createdAt: '2026-07-28T00:00:00.000Z', expiresAt: '2999-01-01T00:00:00.000Z', ...over,
});

describe('MoonshotBatchStore', () => {
  it('creates a batch with items, lists unfinished, updates, and completes', async () => {
    const store = new MoonshotBatchStore(fakeFirestore());
    await store.createBatch(batch(), [
      { customId: 'c1', prompt: 'p1', status: 'pending' },
      { customId: 'c2', prompt: 'p2', status: 'pending' },
    ]);
    expect((await store.listUnfinishedItems('b1')).map((i) => i.customId).sort()).toEqual(['c1', 'c2']);

    await store.updateItem('b1', 'c1', { status: 'succeeded', text: '{}' });
    expect((await store.listUnfinishedItems('b1')).map((i) => i.customId)).toEqual(['c2']);

    await store.setBatchStatus('b1', 'ended', '2026-07-28T00:05:00.000Z');
    expect((await store.getBatch('b1'))!.status).toBe('ended');
    expect((await store.listInProgressBatches()).length).toBe(0);
    expect((await store.listItems('b1')).find((i) => i.customId === 'c1')!.text).toBe('{}');
  });

  it('listUnfinishedItems returns pending and running only', async () => {
    const store = new MoonshotBatchStore(fakeFirestore());
    await store.createBatch(batch({ total: 3 }), [
      { customId: 'p', prompt: '', status: 'pending' },
      { customId: 'r', prompt: '', status: 'running' },
      { customId: 'd', prompt: '', status: 'succeeded' },
    ]);
    expect((await store.listUnfinishedItems('b1')).map((i) => i.customId).sort()).toEqual(['p', 'r']);
  });

  it('claims a pending item once, then refuses a second claim (D5)', async () => {
    const store = new MoonshotBatchStore(fakeFirestore());
    await store.createBatch(batch({ total: 1 }), [{ customId: 'c1', prompt: 'p', status: 'pending' }]);
    expect(await store.claimItem('b1', 'c1', 600_000)).toBe(true);
    expect(await store.claimItem('b1', 'c1', 600_000)).toBe(false); // now running with a fresh lease
    const item = (await store.listItems('b1'))[0];
    expect(item.status).toBe('running');
    expect(item.attempts).toBe(1);
  });

  it('reclaims a running item whose lease has expired (D5)', async () => {
    const store = new MoonshotBatchStore(fakeFirestore());
    await store.createBatch(batch({ total: 1 }), [
      { customId: 'c1', prompt: 'p', status: 'running', leaseUntil: '2000-01-01T00:00:00.000Z', attempts: 1 },
    ]);
    expect(await store.claimItem('b1', 'c1', 600_000)).toBe(true); // stale lease → reclaimable
    expect((await store.listItems('b1'))[0].attempts).toBe(2);
  });

  it('GC lists terminal batches by endedAt, not createdAt', async () => {
    const store = new MoonshotBatchStore(fakeFirestore());
    await store.createBatch(batch({ batchId: 'old', status: 'ended', endedAt: '2020-01-01T00:00:00.000Z' }), []);
    await store.createBatch(batch({ batchId: 'new', status: 'ended', endedAt: '2999-01-01T00:00:00.000Z' }), []);
    expect(await store.listTerminalBatchesOlderThan('2026-01-01T00:00:00.000Z')).toEqual(['old']);
  });
});
