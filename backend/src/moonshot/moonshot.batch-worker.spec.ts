import { MoonshotBatchWorker } from './moonshot.batch-worker';
import { MoonshotBatchStore, isUnfinished } from './moonshot.batch-store';

// In-memory batch store double (only what the worker calls), including the D5
// claim — atomic in-memory: no `await` before the mutation, so two concurrent
// claims of the same item cannot both win.
class MemBatchStore {
  batches = new Map<string, any>();
  items = new Map<string, any[]>();
  async getBatch(id: string) { return this.batches.get(id) ?? null; }
  async listItems(id: string) { return this.items.get(id) ?? []; }
  async listUnfinishedItems(id: string) { return (this.items.get(id) ?? []).filter(isUnfinished); }
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

// claimItem REJECTS (rather than returning false) for one item — an aborted transaction.
class ClaimThrowStore extends MemBatchStore {
  constructor(private badId: string) { super(); }
  async claimItem(id: string, cid: string, leaseMs: number) {
    if (cid === this.badId) throw new Error('transaction aborted');
    return super.claimItem(id, cid, leaseMs);
  }
}

const fakeEnvelopes = { async buildRequest() { return { messages: [{ role: 'user', content: 'x' }], promptCacheKey: 'k' }; } } as any;
const echoEnvelopes = { async buildRequest(_e: any, prompt: string) { return { messages: [{ role: 'user', content: prompt }], promptCacheKey: 'k' }; } } as any;
const cfg = (over: Record<string, unknown> = {}) =>
  ({ get: (k: string) => ({ 'moonshot.batchConcurrency': 2, ...over } as Record<string, unknown>)[k] }) as any;
const fakeConfig = cfg();
// Provider + scheduler both on — what a dedicated Moonshot worker instance sees.
const scheduledConfig = cfg({ 'llm.provider': 'moonshot', 'benchmark.schedulerEnabled': true });
const future = '2999-01-01T00:00:00.000Z';

function clientFactory(handler: (body: any) => any) {
  return { get: () => ({ chat: { completions: { create: async (body: any) => handler(body) } } }) } as any;
}
const okResp = (content: string) => ({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, cached_tokens: 4, completion_tokens: 2 } });
// A 200 carrying an IN-BAND failure: Moonshot signals a refusal as finish_reason
// 'content_filter' (empty content) and a truncation as 'length', not as a throw.
const inBandResp = (finish_reason: string, content = '') => ({
  choices: [{ message: { content }, finish_reason }],
  usage: { prompt_tokens: 10, cached_tokens: 4, completion_tokens: 2 },
});

// Worker with backoff removed so retry loops run instantly.
function makeWorker(client: any, envelopes: any, store: MemBatchStore, config: any = fakeConfig) {
  const worker = new MoonshotBatchWorker(client, envelopes, store as unknown as MoonshotBatchStore, config);
  (worker as any).sleep = async () => {};
  return worker;
}

const flush = async (ticks = 5) => { for (let i = 0; i < ticks; i++) await new Promise((r) => setImmediate(r)); };
const waitFor = async (pred: () => boolean, ticks = 50) => { for (let i = 0; i < ticks && !pred(); i++) await new Promise((r) => setImmediate(r)); };

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
    const worker = makeWorker(client, echoEnvelopes, store);
    await worker.drainBatch('b1');
    const items = await store.listItems('b1');
    expect(items.find((i) => i.customId === 'refuse')!.status).toBe('refusal');
    expect(items.find((i) => i.customId === 'boom')!.status).toBe('errored');
    expect(store.batches.get('b1').status).toBe('ended');
  });

  it('maps an in-band 200 + finish_reason content_filter to refusal, keeping the billed usage', async () => {
    const store = new MemBatchStore();
    store.batches.set('b1', { batchId: 'b1', model: 'kimi-k3', opts: {}, status: 'in_progress', total: 1, expiresAt: future });
    store.items.set('b1', [{ customId: 'c1', prompt: 'p', status: 'pending' }]);
    let calls = 0;
    await makeWorker(clientFactory(() => { calls++; return inBandResp('content_filter'); }), fakeEnvelopes, store).drainBatch('b1');
    const item = (await store.listItems('b1'))[0];
    // A refusal is permanent — recorded, never retried against the API.
    expect(calls).toBe(1);
    expect(item.status).toBe('refusal');
    // Billed: the reconciler treats a refusal as a real result (NO_SETUP) and emits
    // its usage, so dropping it here would under-report spend we actually paid.
    expect(item.usage).toEqual({ input: 6, cacheRead: 4, cacheCreate5m: 0, cacheCreate1h: 0, output: 2 });
    expect(item.cacheReadTokens).toBe(4);
    expect(store.batches.get('b1').status).toBe('ended'); // terminal item → batch still ends
  });

  it('maps an in-band 200 + finish_reason length to errored so the cell stays retryable', async () => {
    const store = new MemBatchStore();
    store.batches.set('b1', { batchId: 'b1', model: 'kimi-k3', opts: {}, status: 'in_progress', total: 1, expiresAt: future });
    store.items.set('b1', [{ customId: 'c1', prompt: 'p', status: 'pending' }]);
    let calls = 0;
    await makeWorker(clientFactory(() => { calls++; return inBandResp('length', '{"side":"lo'); }), fakeEnvelopes, store).drainBatch('b1');
    const item = (await store.listItems('b1'))[0];
    expect(calls).toBe(1); // in-band, not a thrown transient — no retry loop
    // NOT 'succeeded': truncated JSON would reconcile into a permanent, write-once
    // INVALID cell that no top-up can ever re-run.
    expect(item.status).toBe('errored');
    expect(item.error).toBe('output truncated (finish_reason=length)');
    expect(item.text).toBeUndefined(); // the partial output is not persisted as a result
    expect(store.batches.get('b1').status).toBe('ended'); // errored is terminal → batch ends
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
    await makeWorker(client, echoEnvelopes, store).drainBatch('b1');
    expect(order.length).toBe(4);
    expect(order.slice(0, 2).sort()).toEqual(['a1', 'b1']); // one prime per group first
    expect(order.slice(2).sort()).toEqual(['a2', 'b2']); // siblings only after both primes
    expect(store.batches.get('b1').status).toBe('ended');
  });

  it('runs ONE global prime to completion before any other group head hits the API (phase 0)', async () => {
    const store = new MemBatchStore();
    store.batches.set('b1', { batchId: 'b1', model: 'kimi-k3', opts: {}, status: 'in_progress', total: 4, expiresAt: future });
    store.items.set('b1', [
      { customId: 'a1', prompt: 'a1', envelope: { system: 'A' }, status: 'pending' },
      { customId: 'a2', prompt: 'a2', envelope: { system: 'A' }, status: 'pending' },
      { customId: 'b1', prompt: 'b1', envelope: { system: 'B' }, status: 'pending' },
      { customId: 'b2', prompt: 'b2', envelope: { system: 'B' }, status: 'pending' },
    ]);
    // Distinct groups still share the bulk of their rendered prefix in real
    // benchmark batches (general docs + day bundle), so heads run concurrently
    // would EACH pay a full miss on that shared portion. Exactly one item must
    // complete before the other group's head is allowed to start.
    const arrivals: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const client = clientFactory((body: any) => {
      arrivals.push(body.messages[body.messages.length - 1].content);
      if (arrivals.length === 1) {
        return new Promise((resolve) => { releaseFirst = () => resolve(okResp('{}')); });
      }
      return okResp('{}');
    });
    const drain = makeWorker(client, echoEnvelopes, store).drainBatch('b1');
    await flush(20);
    expect(arrivals).toHaveLength(1); // only the global prime is in flight
    releaseFirst!();
    await drain;
    expect(arrivals).toHaveLength(4);
    expect(arrivals.slice(0, 2).sort()).toEqual(['a1', 'b1']); // heads before any sibling
    expect(store.batches.get('b1').status).toBe('ended');
  });

  it('runs `batchConcurrency` items genuinely in flight at once', async () => {
    const store = new MemBatchStore();
    store.batches.set('b1', { batchId: 'b1', model: 'kimi-k3', opts: {}, status: 'in_progress', total: 4, expiresAt: future });
    // One prefix group → phase 1 primes 1 item, phase 2 fans out 3 with limit 2.
    store.items.set('b1', ['c1', 'c2', 'c3', 'c4'].map((customId) => ({ customId, prompt: customId, status: 'pending' })));
    let inFlight = 0;
    let maxInFlight = 0;
    const releases: Array<() => void> = [];
    const client = clientFactory(() => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve) => releases.push(() => { inFlight--; resolve(okResp('{}')); }));
    });
    let done = false;
    const drain = makeWorker(client, fakeEnvelopes, store).drainBatch('b1').then(() => { done = true; });
    for (let i = 0; i < 40 && !done; i++) {
      await new Promise((r) => setImmediate(r)); // let every runner reach its create() call
      while (releases.length) releases.shift()!();
    }
    await drain;
    // 2, not 1: a runPool that silently degraded to sequential passes every other test.
    expect(maxInFlight).toBe(2);
    expect((await store.listItems('b1')).every((i) => i.status === 'succeeded')).toBe(true);
  });

  it('falls back to the default concurrency when batchConcurrency is not a usable number', async () => {
    const store = new MemBatchStore();
    store.batches.set('b1', { batchId: 'b1', model: 'kimi-k3', opts: {}, status: 'in_progress', total: 3, expiresAt: future });
    store.items.set('b1', ['c1', 'c2', 'c3'].map((customId) => ({ customId, prompt: customId, status: 'pending' })));
    // parseInt('') → NaN: Math.min(NaN, n) runners would be ZERO, silently draining nothing.
    await makeWorker(clientFactory(() => okResp('{}')), fakeEnvelopes, store, cfg({ 'moonshot.batchConcurrency': NaN })).drainBatch('b1');
    expect((await store.listItems('b1')).every((i) => i.status === 'succeeded')).toBe(true);
    expect(store.batches.get('b1').status).toBe('ended');
  });

  it('records a request-build failure as that item errored, without wedging its siblings', async () => {
    const store = new MemBatchStore();
    store.batches.set('b1', { batchId: 'b1', model: 'kimi-k3', opts: {}, status: 'in_progress', total: 2, expiresAt: future });
    store.items.set('b1', [
      { customId: 'bad', prompt: 'bad', status: 'pending' },
      { customId: 'good', prompt: 'good', status: 'pending' },
    ]);
    const throwingEnvelopes = {
      async buildRequest(_e: any, prompt: string) {
        if (prompt === 'bad') throw new Error('Moonshot: no extracted text for file id f1');
        return { messages: [{ role: 'user', content: prompt }], promptCacheKey: 'k' };
      },
    } as any;
    await makeWorker(clientFactory(() => okResp('{}')), throwingEnvelopes, store).drainBatch('b1');
    const items = await store.listItems('b1');
    const bad = items.find((i) => i.customId === 'bad')!;
    expect(bad.status).toBe('errored');
    expect(bad.error).toContain('no extracted text for file id f1');
    expect(items.find((i) => i.customId === 'good')!.status).toBe('succeeded');
    expect(store.batches.get('b1').status).toBe('ended');
  });

  it('isolates a rejected claimItem so the rest of the pool still drains', async () => {
    const store = new ClaimThrowStore('c1');
    store.batches.set('b1', { batchId: 'b1', model: 'kimi-k3', opts: {}, status: 'in_progress', total: 2, expiresAt: future });
    store.items.set('b1', [
      { customId: 'c1', prompt: 'p1', status: 'pending' },
      { customId: 'c2', prompt: 'p2', status: 'pending' },
    ]);
    let calls = 0;
    await expect(makeWorker(clientFactory(() => { calls++; return okResp('{}'); }), fakeEnvelopes, store).drainBatch('b1')).resolves.toBeUndefined();
    expect(calls).toBe(1);
    const items = await store.listItems('b1');
    expect(items.find((i) => i.customId === 'c2')!.status).toBe('succeeded');
    expect(items.find((i) => i.customId === 'c1')!.status).toBe('pending'); // retried on a later pass
    expect(store.batches.get('b1').status).toBe('in_progress');
  });

  it('marks a fully-drained batch errored when the item count is short of `total` (torn createBatch)', async () => {
    const store = new MemBatchStore();
    const items = () => [
      { customId: 'c1', prompt: 'p1', status: 'pending' },
      { customId: 'c2', prompt: 'p2', status: 'pending' },
    ];
    store.batches.set('old', { batchId: 'old', model: 'kimi-k3', opts: {}, status: 'in_progress', total: 3, createdAt: '2026-07-01T00:00:00.000Z', expiresAt: future });
    store.items.set('old', items());
    store.batches.set('malformed', { batchId: 'malformed', model: 'kimi-k3', opts: {}, status: 'in_progress', total: 3, expiresAt: future }); // no createdAt
    store.items.set('malformed', items());
    const worker = makeWorker(clientFactory(() => okResp('{}')), fakeEnvelopes, store);
    await worker.drainBatch('old');
    await worker.drainBatch('malformed');
    expect(store.batches.get('old').status).toBe('errored'); // 2 item docs !== total 3
    expect(store.batches.get('malformed').status).toBe('errored'); // unparseable createdAt → enforce
    expect((await store.listItems('old')).every((i) => i.status === 'succeeded')).toBe(true); // results still kept
  });

  it('leaves a just-created short batch alone (its item docs may still be landing)', async () => {
    const store = new MemBatchStore();
    store.batches.set('b1', { batchId: 'b1', model: 'kimi-k3', opts: {}, status: 'in_progress', total: 3, createdAt: new Date().toISOString(), expiresAt: future });
    store.items.set('b1', [{ customId: 'c1', prompt: 'p1', status: 'pending' }]);
    await makeWorker(clientFactory(() => okResp('{}')), fakeEnvelopes, store).drainBatch('b1');
    // Inside the grace window a mismatch is a race with createBatch, not a torn
    // write — don't kill an in-flight batch; the next pass re-evaluates.
    expect(store.batches.get('b1').status).toBe('in_progress');
    expect(store.batches.get('b1').endedAt).toBeUndefined();
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

  it('gc core deletes terminal batches older than the TTL and keeps live ones', async () => {
    const store = new MemBatchStore();
    store.batches.set('old', { batchId: 'old', status: 'ended', endedAt: '2000-01-01T00:00:00.000Z' });
    store.batches.set('live', { batchId: 'live', status: 'in_progress', expiresAt: future });
    await makeWorker(clientFactory(() => okResp('{}')), fakeEnvelopes, store).gc();
    expect(store.batches.has('old')).toBe(false);
    expect(store.batches.has('live')).toBe(true);
  });

  it('gc falls back to the default TTL when the configured TTL is not a usable number', async () => {
    const store = new MemBatchStore();
    store.batches.set('old', { batchId: 'old', status: 'ended', endedAt: '2000-01-01T00:00:00.000Z' });
    const worker = makeWorker(clientFactory(() => okResp('{}')), fakeEnvelopes, store, cfg({ 'moonshot.batchGcTtlMs': NaN }));
    // Date.now() - NaN → new Date(NaN).toISOString() throws RangeError, which would
    // otherwise break every GC pass, forever.
    await expect(worker.gc()).resolves.toBeUndefined();
    expect(store.batches.has('old')).toBe(false);
  });

  it('gc keeps going after one batch fails to delete', async () => {
    const store = new MemBatchStore();
    store.batches.set('bad', { batchId: 'bad', status: 'ended', endedAt: '2000-01-01T00:00:00.000Z' });
    store.batches.set('good', { batchId: 'good', status: 'errored', endedAt: '2000-01-01T00:00:00.000Z' });
    const orig = store.deleteBatch.bind(store);
    store.deleteBatch = async (id: string) => {
      if (id === 'bad') throw new Error('permission denied');
      return orig(id);
    };
    await expect(makeWorker(clientFactory(() => okResp('{}')), fakeEnvelopes, store).gc()).resolves.toBeUndefined();
    expect(store.batches.has('bad')).toBe(true);
    expect(store.batches.has('good')).toBe(false);
  });

  it('the scheduled tick re-drains a stalled batch and GCs, only when provider + scheduler are on', async () => {
    const seed = () => {
      const store = new MemBatchStore();
      store.batches.set('b1', { batchId: 'b1', model: 'kimi-k3', opts: {}, status: 'in_progress', total: 1, expiresAt: future });
      store.items.set('b1', [{ customId: 'c1', prompt: 'p', status: 'pending' }]);
      store.batches.set('old', { batchId: 'old', status: 'ended', endedAt: '2000-01-01T00:00:00.000Z' });
      return store;
    };

    // Provider on, scheduler off (jest / a non-worker instance) → nothing happens.
    const offStore = seed();
    makeWorker(clientFactory(() => okResp('{}')), fakeEnvelopes, offStore, cfg({ 'llm.provider': 'moonshot' })).scheduledMaintenance();
    await flush();
    expect(offStore.batches.get('b1').status).toBe('in_progress');
    expect(offStore.batches.has('old')).toBe(true);

    // Scheduler on, but Anthropic is the provider → nothing happens.
    const anthropicStore = seed();
    makeWorker(clientFactory(() => okResp('{}')), fakeEnvelopes, anthropicStore, cfg({ 'benchmark.schedulerEnabled': true })).scheduledMaintenance();
    await flush();
    expect(anthropicStore.batches.get('b1').status).toBe('in_progress');
    expect(anthropicStore.batches.has('old')).toBe(true);

    // Both on → the stalled batch drains (no kick was ever issued) and GC runs.
    const onStore = seed();
    makeWorker(clientFactory(() => okResp('{}')), fakeEnvelopes, onStore, scheduledConfig).scheduledMaintenance();
    await waitFor(() => onStore.batches.get('b1')?.status === 'ended' && !onStore.batches.has('old'));
    expect(onStore.batches.get('b1').status).toBe('ended');
    expect(onStore.batches.has('old')).toBe(false);
  });

  it('onApplicationBootstrap resumes in-progress batches only when provider + scheduler are on', async () => {
    const seed = () => {
      const store = new MemBatchStore();
      store.batches.set('b1', { batchId: 'b1', model: 'kimi-k3', opts: {}, status: 'in_progress', total: 1, expiresAt: future });
      store.items.set('b1', [{ customId: 'c1', prompt: 'p', status: 'pending' }]);
      return store;
    };

    const offStore = seed();
    makeWorker(clientFactory(() => okResp('{}')), fakeEnvelopes, offStore, cfg()).onApplicationBootstrap();
    await flush();
    expect(offStore.batches.get('b1').status).toBe('in_progress'); // never touched Firestore at boot

    const onStore = seed();
    makeWorker(clientFactory(() => okResp('{}')), fakeEnvelopes, onStore, scheduledConfig).onApplicationBootstrap();
    await waitFor(() => onStore.batches.get('b1')?.status === 'ended');
    expect(onStore.batches.get('b1').status).toBe('ended');
  });
});
