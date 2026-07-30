import { MoonshotBatchWorker } from './moonshot.batch-worker';
import { MoonshotBatchStore } from './moonshot.batch-store';

// In-memory batch store double (only what the worker calls), including the D5
// claim — atomic in-memory: no `await` before the mutation, so two concurrent
// claims of the same item cannot both win.
class MemBatchStore {
  batches = new Map<string, any>();
  items = new Map<string, any[]>();
  async getBatch(id: string) { return this.batches.get(id) ?? null; }
  async listItems(id: string) { return this.items.get(id) ?? []; }
  async listUnfinishedItems(id: string) { return (this.items.get(id) ?? []).filter((i) => i.status === 'pending' || i.status === 'running'); }
  async claimItem(id: string, cid: string, leaseMs: number) {
    const it = (this.items.get(id) ?? []).find((i) => i.customId === cid);
    if (!it) return false;
    const nowIso = new Date().toISOString();
    const claimable = it.status === 'pending' || (it.status === 'running' && (it.leaseUntil ?? '') < nowIso);
    if (!claimable) return false;
    it.status = 'running';
    it.leaseUntil = new Date(Date.now() + leaseMs).toISOString();
    it.attempts = (it.attempts ?? 0) + 1;
    return true;
  }
  async updateItem(id: string, cid: string, patch: any) {
    Object.assign((this.items.get(id) ?? []).find((i) => i.customId === cid), patch);
  }
  async setBatchStatus(id: string, status: string, endedAt?: string) { Object.assign(this.batches.get(id), { status, endedAt }); }
  async listInProgressBatches() { return [...this.batches.values()].filter((b) => b.status === 'in_progress'); }
  async listTerminalBatchesOlderThan(cutoffIso: string) {
    return [...this.batches.values()]
      .filter((b) => (b.status === 'ended' || b.status === 'errored') && (b.endedAt ?? b.createdAt ?? '') < cutoffIso)
      .map((b) => b.batchId);
  }
  async deleteBatch(id: string) { this.batches.delete(id); this.items.delete(id); }
}

// updateItem rejects its first `failures` calls, then behaves normally — the
// transient-Firestore-throw-after-a-paid-API-call case.
class FlakyUpdateStore extends MemBatchStore {
  updateCalls = 0;
  constructor(private failures: number) { super(); }
  async updateItem(id: string, cid: string, patch: any) {
    this.updateCalls++;
    if (this.failures > 0) {
      this.failures--;
      throw new Error('firestore unavailable');
    }
    return super.updateItem(id, cid, patch);
  }
}

const fakeEnvelopes = { async buildRequest() { return { messages: [{ role: 'user', content: 'x' }], promptCacheKey: 'k' }; } } as any;
const cfg = (over: Record<string, unknown> = {}) =>
  ({ get: (k: string) => ({ 'moonshot.batchConcurrency': 2, ...over } as Record<string, unknown>)[k] }) as any;
const fakeConfig = cfg();
const future = '2999-01-01T00:00:00.000Z';

function clientFactory(handler: (body: any) => any) {
  return { get: () => ({ chat: { completions: { create: async (body: any) => handler(body) } } }) } as any;
}
const okResp = (content: string) => ({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, cached_tokens: 4, completion_tokens: 2 } });

// Worker with backoff removed so retry loops run instantly.
function makeWorker(client: any, envelopes: any, store: MemBatchStore, config: any = fakeConfig) {
  const worker = new MoonshotBatchWorker(client, envelopes, store as unknown as MoonshotBatchStore, config);
  (worker as any).sleep = async () => {};
  return worker;
}

describe('MoonshotBatchWorker', () => {
  it('drains all unfinished items to succeeded and ends the batch', async () => {
    const store = new MemBatchStore();
    store.batches.set('b1', { batchId: 'b1', model: 'kimi-k3', opts: { effort: 'high', maxTokens: 100 }, status: 'in_progress', total: 2, expiresAt: future });
    store.items.set('b1', [
      { customId: 'c1', prompt: 'p1', status: 'pending' },
      { customId: 'c2', prompt: 'p2', status: 'pending' },
    ]);
    const worker = makeWorker(clientFactory(() => okResp('{"ok":1}')), fakeEnvelopes, store);
    await worker.drainBatch('b1');
    const items = await store.listItems('b1');
    expect(items.every((i) => i.status === 'succeeded' && i.text === '{"ok":1}')).toBe(true);
    expect(items[0].usage).toEqual({ input: 6, cacheRead: 4, cacheCreate5m: 0, cacheCreate1h: 0, output: 2 });
    expect(items[0].cacheReadTokens).toBe(4);
    expect(store.batches.get('b1').status).toBe('ended');
  });

  it('classifies content_filter as refusal (kept) and persistent 5xx as errored (re-queued)', async () => {
    const store = new MemBatchStore();
    store.batches.set('b1', { batchId: 'b1', model: 'kimi-k3', opts: { effort: 'high', maxTokens: 100 }, status: 'in_progress', total: 2, expiresAt: future });
    store.items.set('b1', [
      { customId: 'refuse', prompt: 'REFUSE', status: 'pending' },
      { customId: 'boom', prompt: 'BOOM', status: 'pending' },
    ]);
    const client = clientFactory((body: any) => {
      if (JSON.stringify(body.messages).includes('REFUSE')) throw Object.assign(new Error('filtered'), { status: 400, error: { type: 'content_filter' } });
      throw Object.assign(new Error('server'), { status: 500 });
    });
    const echoEnvelopes = { async buildRequest(_e: any, prompt: string) { return { messages: [{ role: 'user', content: prompt }], promptCacheKey: 'k' }; } } as any;
    const worker = makeWorker(client, echoEnvelopes, store);
    await worker.drainBatch('b1');
    const items = await store.listItems('b1');
    expect(items.find((i) => i.customId === 'refuse')!.status).toBe('refusal');
    expect(items.find((i) => i.customId === 'boom')!.status).toBe('errored');
    expect(store.batches.get('b1').status).toBe('ended');
  });

  it('marks a batch past expiresAt as errored, leaving items untouched (D6)', async () => {
    const store = new MemBatchStore();
    store.batches.set('b1', { batchId: 'b1', model: 'kimi-k3', opts: {}, status: 'in_progress', total: 1, expiresAt: '2000-01-01T00:00:00.000Z' });
    store.items.set('b1', [{ customId: 'c1', prompt: 'p', status: 'pending' }]);
    let called = 0;
    const worker = makeWorker(clientFactory(() => { called++; return okResp('{}'); }), fakeEnvelopes, store);
    await worker.drainBatch('b1');
    expect(called).toBe(0);
    expect(store.batches.get('b1').status).toBe('errored');
    expect((await store.listItems('b1'))[0].status).toBe('pending'); // untouched → reconciler re-queues
  });

  it('ends (does not error) an expired batch whose items are all already terminal', async () => {
    const store = new MemBatchStore();
    store.batches.set('b1', { batchId: 'b1', model: 'kimi-k3', opts: {}, status: 'in_progress', total: 1, expiresAt: '2000-01-01T00:00:00.000Z' });
    store.items.set('b1', [{ customId: 'c1', prompt: 'p', status: 'succeeded', text: '{}' }]);
    let called = 0;
    await makeWorker(clientFactory(() => { called++; return okResp('{}'); }), fakeEnvelopes, store).drainBatch('b1');
    expect(called).toBe(0);
    // D6 force-termination applies to UNDRAINED work; results already paid for and
    // complete must not be thrown away as 'errored' (which re-queues + re-pays).
    expect(store.batches.get('b1').status).toBe('ended');
  });

  it('two workers sharing a store run each item exactly once (D5 claim gate)', async () => {
    const store = new MemBatchStore();
    store.batches.set('b1', { batchId: 'b1', model: 'kimi-k3', opts: {}, status: 'in_progress', total: 2, expiresAt: future });
    store.items.set('b1', [
      { customId: 'c1', prompt: 'p1', status: 'pending' },
      { customId: 'c2', prompt: 'p2', status: 'pending' },
    ]);
    let calls = 0;
    const mk = () => makeWorker(clientFactory(() => { calls++; return okResp('{}'); }), fakeEnvelopes, store);
    await Promise.all([mk().drainBatch('b1'), mk().drainBatch('b1')]);
    expect(calls).toBe(2); // each item claimed + run exactly once across the two workers
    expect((await store.listItems('b1')).every((i) => i.status === 'succeeded')).toBe(true);
  });

  it('primes one item per prefix group before fanning out the siblings (D7)', async () => {
    const store = new MemBatchStore();
    store.batches.set('b1', { batchId: 'b1', model: 'kimi-k3', opts: {}, status: 'in_progress', total: 4, expiresAt: future });
    store.items.set('b1', [
      { customId: 'a1', prompt: 'a1', envelope: { system: 'A' }, status: 'pending' },
      { customId: 'a2', prompt: 'a2', envelope: { system: 'A' }, status: 'pending' },
      { customId: 'b1', prompt: 'b1', envelope: { system: 'B' }, status: 'pending' },
      { customId: 'b2', prompt: 'b2', envelope: { system: 'B' }, status: 'pending' },
    ]);
    const order: string[] = [];
    const client = clientFactory((body: any) => {
      order.push(body.messages[body.messages.length - 1].content);
      return okResp('{}');
    });
    const echoEnvelopes = { async buildRequest(env: any, prompt: string) { return { messages: [{ role: 'user', content: prompt }], promptCacheKey: env?.system }; } } as any;
    await makeWorker(client, echoEnvelopes, store).drainBatch('b1');
    expect(order.length).toBe(4);
    expect(order.slice(0, 2).sort()).toEqual(['a1', 'b1']); // one prime per group first
    expect(order.slice(2).sort()).toEqual(['a2', 'b2']); // siblings only after both primes
    expect(store.batches.get('b1').status).toBe('ended');
  });

  it('marks a fully-drained batch errored when the item count is short of `total` (torn createBatch)', async () => {
    const store = new MemBatchStore();
    store.batches.set('b1', { batchId: 'b1', model: 'kimi-k3', opts: {}, status: 'in_progress', total: 3, expiresAt: future });
    store.items.set('b1', [
      { customId: 'c1', prompt: 'p1', status: 'pending' },
      { customId: 'c2', prompt: 'p2', status: 'pending' },
    ]);
    await makeWorker(clientFactory(() => okResp('{}')), fakeEnvelopes, store).drainBatch('b1');
    expect(store.batches.get('b1').status).toBe('errored'); // 2 item docs !== total 3
    expect((await store.listItems('b1')).every((i) => i.status === 'succeeded')).toBe(true); // results still kept
  });

  it('retries a transient updateItem failure so a paid result is not discarded', async () => {
    const store = new FlakyUpdateStore(1);
    store.batches.set('b1', { batchId: 'b1', model: 'kimi-k3', opts: {}, status: 'in_progress', total: 1, expiresAt: future });
    store.items.set('b1', [{ customId: 'c1', prompt: 'p', status: 'pending' }]);
    let calls = 0;
    await makeWorker(clientFactory(() => { calls++; return okResp('{"ok":1}'); }), fakeEnvelopes, store).drainBatch('b1');
    expect(calls).toBe(1); // the model was NOT called again — only the write retried
    expect(store.updateCalls).toBe(2);
    const item = (await store.listItems('b1'))[0];
    expect(item.status).toBe('succeeded');
    expect(item.text).toBe('{"ok":1}');
    expect(store.batches.get('b1').status).toBe('ended');
  });

  it('leaves the item running (lease reclaim) when updateItem keeps failing, without aborting the drain', async () => {
    const store = new FlakyUpdateStore(99);
    store.batches.set('b1', { batchId: 'b1', model: 'kimi-k3', opts: {}, status: 'in_progress', total: 2, expiresAt: future });
    store.items.set('b1', [
      { customId: 'c1', prompt: 'p1', status: 'pending' },
      { customId: 'c2', prompt: 'p2', status: 'pending' },
    ]);
    let calls = 0;
    await expect(makeWorker(clientFactory(() => { calls++; return okResp('{}'); }), fakeEnvelopes, store).drainBatch('b1')).resolves.toBeUndefined();
    expect(calls).toBe(2); // both items still ran — one bad write does not abort the pool
    expect(store.updateCalls).toBe(6); // 3 attempts per item
    expect((await store.listItems('b1')).every((i) => i.status === 'running')).toBe(true);
    expect(store.batches.get('b1').status).toBe('in_progress'); // not ended — reclaimed after the lease expires
  });

  it('gc deletes terminal batches older than the TTL, and no-ops when Moonshot is not the provider', async () => {
    const store = new MemBatchStore();
    store.batches.set('old', { batchId: 'old', status: 'ended', endedAt: '2000-01-01T00:00:00.000Z' });
    store.batches.set('live', { batchId: 'live', status: 'in_progress', expiresAt: future });

    const offWorker = makeWorker(clientFactory(() => okResp('{}')), fakeEnvelopes, store, cfg()); // provider unset → anthropic
    await offWorker.gc();
    expect(store.batches.has('old')).toBe(true);

    const onWorker = makeWorker(clientFactory(() => okResp('{}')), fakeEnvelopes, store, cfg({ 'llm.provider': 'moonshot' }));
    await onWorker.gc();
    expect(store.batches.has('old')).toBe(false);
    expect(store.batches.has('live')).toBe(true);
  });

  it('onApplicationBootstrap resumes in-progress batches only when Moonshot is the provider', async () => {
    const store = new MemBatchStore();
    store.batches.set('b1', { batchId: 'b1', model: 'kimi-k3', opts: {}, status: 'in_progress', total: 1, expiresAt: future });
    store.items.set('b1', [{ customId: 'c1', prompt: 'p', status: 'pending' }]);

    const off = makeWorker(clientFactory(() => okResp('{}')), fakeEnvelopes, store, cfg());
    off.onApplicationBootstrap();
    await new Promise((r) => setImmediate(r));
    expect(store.batches.get('b1').status).toBe('in_progress'); // never touched Firestore

    const on = makeWorker(clientFactory(() => okResp('{}')), fakeEnvelopes, store, cfg({ 'llm.provider': 'moonshot' }));
    on.onApplicationBootstrap();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(store.batches.get('b1').status).toBe('ended');
  });
});
