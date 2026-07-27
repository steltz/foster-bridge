import { fakeFirestore } from './fake-firestore';

describe('fakeFirestore extensions', () => {
  it('create() writes once and rejects a second create with code 6', async () => {
    const db = fakeFirestore();
    const ref = db.collection('benchmarkRuns').doc('a__fable__07012026__base__run1');
    await ref.create({ trader: 'a', runIndex: 1 });
    await expect(ref.create({ trader: 'a', runIndex: 1 })).rejects.toMatchObject({ code: 6 });
    const snap = await ref.get();
    expect(snap.exists).toBe(true);
    expect(snap.data()).toEqual({ trader: 'a', runIndex: 1 });
  });

  it('set() writes and overwrites outside a transaction', async () => {
    const db = fakeFirestore();
    const ref = db.collection('benchmarkBatches').doc('batch_1');
    await ref.set({ status: 'submitted' });
    await ref.set({ status: 'reconciled' });
    expect((await ref.get()).data()).toEqual({ status: 'reconciled' });
  });

  it('where() filters with == and is chainable', async () => {
    const db = fakeFirestore();
    await db.collection('benchmarkRuns').doc('d1').set({ trader: 'a', modelAlias: 'fable', variant: 'base', runIndex: 1 });
    await db.collection('benchmarkRuns').doc('d2').set({ trader: 'a', modelAlias: 'fable', variant: 'base', runIndex: 2 });
    await db.collection('benchmarkRuns').doc('d3').set({ trader: 'b', modelAlias: 'fable', variant: 'base', runIndex: 1 });
    const snap = await db
      .collection('benchmarkRuns')
      .where('trader', '==', 'a')
      .where('variant', '==', 'base')
      .get();
    expect(snap.docs.map((d: any) => d.data().runIndex).sort()).toEqual([1, 2]);
  });

  it('update() merges fields on an existing doc without clobbering untouched fields', async () => {
    const db = fakeFirestore();
    const ref = db.collection('benchmarkBatches').doc('batch_1');
    await ref.set({ status: 'submitted', batchId: 'batch_1', day: '07012026' });
    await ref.update({ status: 'reconciled', endedAt: '2026-07-26T01:00:00.000Z' });
    expect((await ref.get()).data()).toEqual({
      status: 'reconciled',
      batchId: 'batch_1',
      day: '07012026',
      endedAt: '2026-07-26T01:00:00.000Z',
    });
  });

  it('update() on a missing doc rejects with code 5 (NOT_FOUND)', async () => {
    const db = fakeFirestore();
    const ref = db.collection('benchmarkBatches').doc('does-not-exist');
    await expect(ref.update({ status: 'reconciled' })).rejects.toMatchObject({ code: 5 });
  });

  it('where() supports the in operator', async () => {
    const db = fakeFirestore();
    await db.collection('benchmarkBatches').doc('b1').set({ status: 'submitted' });
    await db.collection('benchmarkBatches').doc('b2').set({ status: 'reconciled' });
    await db.collection('benchmarkBatches').doc('b3').set({ status: 'ended' });
    const snap = await db
      .collection('benchmarkBatches')
      .where('status', 'in', ['submitted', 'in_progress', 'ended'])
      .get();
    expect(snap.docs.map((d: any) => d.id).sort()).toEqual(['b1', 'b3']);
  });
});
