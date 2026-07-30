import { MoonshotLlmProvider } from './moonshot.service';
import { MoonshotEnvelopeBuilder } from './moonshot.envelope';

const extracts = () => ({ async getById() { return null; }, async getByHash() { return null; }, async put() {} }) as any;

/** Runs `fn`, returning the HTTP status and `error` string of the exception it throws. */
async function statusOf(fn: () => Promise<unknown>): Promise<{ status: number; error?: string }> {
  try {
    await fn();
    return { status: 0 };
  } catch (e: any) {
    return { status: e.getStatus?.() ?? e.status, error: e.getResponse?.()?.error };
  }
}

// The config fake mirrors ConfigService: an unset key reads back `undefined`, so
// each test supplies only the keys it cares about.
function makeEmulated(configValues: Record<string, unknown> = {}) {
  const created: any[] = [];
  const batchStore: any = {
    async createBatch(doc: any, items: any[]) { created.push({ doc, items }); },
    async getBatch(id: string) { return created.find((c) => c.doc.batchId === id)?.doc ?? null; },
    async listItems(id: string) { return created.find((c) => c.doc.batchId === id)?.items ?? []; },
  };
  const worker: any = { kicked: [] as string[], kick(id: string) { this.kicked.push(id); } };
  const values: Record<string, unknown> = { 'moonshot.model': 'kimi-k3', 'moonshot.completionWindow': '1d', ...configValues };
  const config = { get: (k: string) => values[k] } as any;
  const svc = new MoonshotLlmProvider({ get: () => ({}) } as any, config, { emit: () => true } as any, new MoonshotEnvelopeBuilder(extracts()), extracts(), batchStore, worker);
  return { svc, batchStore, worker, created };
}

describe('MoonshotLlmProvider – batch (kimi-k3 → emulated)', () => {
  it('persists an emulated batch, kicks the worker, and reports in_progress then results', async () => {
    const { svc, worker, created } = makeEmulated();
    const handle = await svc.submitBatch(
      [{ customId: 'c1', prompt: 'p1', envelope: { tiers: [{ blocks: [{ type: 'text', text: 'S' }] }] } }],
      undefined,
      { model: 'kimi-k3', schema: { type: 'object' }, maxTokens: 100, effort: 'high' },
    );
    expect(handle.status).toBe('submitted');
    expect(worker.kicked).toEqual([handle.batchId]);
    expect(created[0].doc.model).toBe('kimi-k3');
    expect(created[0].items[0]).toMatchObject({ customId: 'c1', prompt: 'p1', status: 'pending' });

    // getBatch maps in_progress
    expect((await svc.getBatch(handle.batchId)).status).toBe('in_progress');

    // Simulate the worker completing an item, then read results.
    created[0].doc.status = 'ended';
    created[0].items[0] = { customId: 'c1', status: 'succeeded', text: '{"x":1}', usage: { input: 1, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0, output: 1 }, cacheReadTokens: 0 };
    expect((await svc.getBatch(handle.batchId)).status).toBe('ended');
    const results = await svc.getBatchResults(handle.batchId);
    expect(results).toEqual([{ customId: 'c1', type: 'succeeded', text: '{"x":1}', usage: { input: 1, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0, output: 1 }, cacheReadTokens: 0 }]);
  });

  it('getBatch kicks the worker while in_progress, but not once the batch is terminal', async () => {
    const { svc, worker, created } = makeEmulated();
    const handle = await svc.submitBatch([{ customId: 'c1', prompt: 'p1' }], undefined, { model: 'kimi-k3' });
    worker.kicked.length = 0; // ignore submitBatch's own kick
    // Two racing drainers can each see the other's last item still 'running' and
    // both return without ending the batch; the reconciler's per-minute getBatch
    // poll is what converges it, so this kick is load-bearing.
    await svc.getBatch(handle.batchId);
    expect(worker.kicked).toEqual([handle.batchId]);
    for (const terminal of ['ended', 'errored']) {
      created[0].doc.status = terminal;
      await svc.getBatch(handle.batchId);
      expect(worker.kicked).toEqual([handle.batchId]); // unchanged: nothing left to drain
    }
  });

  it('getBatchResults skips items that are still pending or running', async () => {
    const { svc, created } = makeEmulated();
    const handle = await svc.submitBatch(
      [{ customId: 'c1', prompt: 'p1' }, { customId: 'c2', prompt: 'p2' }, { customId: 'c3', prompt: 'p3' }],
      undefined,
      { model: 'kimi-k3' },
    );
    created[0].items = [
      { customId: 'c1', status: 'succeeded', text: '{}' },
      { customId: 'c2', status: 'running' },
      { customId: 'c3', status: 'refusal' },
    ];
    const results = await svc.getBatchResults(handle.batchId);
    expect(results).toEqual([{ customId: 'c1', type: 'succeeded', text: '{}' }, { customId: 'c3', type: 'refusal' }]);
  });

  it('getBatch throws 404 for an unknown emulated batch id', async () => {
    const { svc } = makeEmulated();
    const { status } = await statusOf(() => svc.getBatch('msb_missing'));
    expect(status).toBe(404);
  });

  it('resolves maxTokens from config into the persisted opts and defaults customIds', async () => {
    const { svc, created } = makeEmulated({ 'moonshot.maxTokens': 7777 });
    await svc.submitBatch([{ prompt: 'p1' }], undefined, { effort: 'high' });
    // Resolved at SUBMIT time so the worker drains with the configured ceiling even
    // though this caller passed no maxTokens.
    expect(created[0].doc.opts).toMatchObject({ maxTokens: 7777, effort: 'high' });
    expect(created[0].doc.model).toBe('kimi-k3'); // from moonshot.model
    expect(created[0].items[0].customId).toBe('request-0');
  });

  it('rejects a batch with duplicate customIds before persisting anything', async () => {
    const { svc, created } = makeEmulated();
    // Item docs are keyed by customId, so a duplicate would collapse two requests
    // into one doc while `total` still counted both.
    const { status, error } = await statusOf(() => svc.submitBatch([{ customId: 'c1', prompt: 'p1' }, { customId: 'c1', prompt: 'p2' }], undefined, {}));
    expect(status).toBe(400);
    expect(error).toContain('c1');
    expect(created).toEqual([]);
  });

  it('rejects an empty batch', async () => {
    const { svc, created, worker } = makeEmulated();
    const { status } = await statusOf(() => svc.submitBatch([], undefined, {}));
    expect(status).toBe(400);
    expect(created).toEqual([]);
    expect(worker.kicked).toEqual([]);
  });

  it('falls back to the 3h expiry when moonshot.batchMaxAgeMs is not a finite number', async () => {
    // parseInt('') === NaN reaches config for an env var that is set but empty;
    // `new Date(now + NaN).toISOString()` throws, which would break every submit.
    const { svc, created } = makeEmulated({ 'moonshot.batchMaxAgeMs': NaN });
    await svc.submitBatch([{ prompt: 'p1' }], undefined, {});
    const doc = created[0].doc;
    expect(Date.parse(doc.expiresAt) - Date.parse(doc.createdAt)).toBe(10_800_000);
  });
});

describe('MoonshotLlmProvider – batch (batchable model → native /v1/batches)', () => {
  function makeNative(
    retrieve: any,
    outputText: string,
    extra: { errorText?: string; config?: Record<string, unknown> } = {},
  ) {
    const uploads: any[] = [];
    const dels: string[] = [];
    const client = {
      files: {
        create: async (a: any) => { uploads.push(a); return { id: 'file-in' }; },
        content: async (id: string) => ({ text: async () => (id === retrieve?.error_file_id ? extra.errorText ?? '' : outputText) }),
        del: async (id: string) => { dels.push(id); return { deleted: true }; },
      },
      batches: {
        create: async (b: any) => { (client as any)._created = b; return { id: 'bat-1', status: 'validating' }; },
        retrieve: async (_id: string) => retrieve,
      },
    };
    const values: Record<string, unknown> = { 'moonshot.completionWindow': '1d', ...extra.config };
    const config = { get: (k: string) => values[k] } as any;
    const svc = new MoonshotLlmProvider({ get: () => client } as any, config, { emit: () => true } as any, new MoonshotEnvelopeBuilder(extracts()), extracts(), {} as any, { kick() {} } as any);
    return { svc, client, uploads, dels };
  }

  const okLine = (customId: string, content: string) =>
    JSON.stringify({ custom_id: customId, response: { status_code: 200, body: { choices: [{ message: { content } }], usage: { prompt_tokens: 6, cached_tokens: 2, completion_tokens: 1 } } }, error: null });

  it('uploads JSONL (no temperature), creates a batch, maps status, and parses output', async () => {
    const output = JSON.stringify({ custom_id: 'c1', response: { status_code: 200, body: { choices: [{ message: { content: '{"y":2}' } }], usage: { prompt_tokens: 6, cached_tokens: 2, completion_tokens: 1 } } }, error: null });
    const { svc, client } = makeNative({ id: 'bat-1', status: 'completed', output_file_id: 'file-out', request_counts: { total: 1 } }, output);
    const handle = await svc.submitBatch(
      [{ customId: 'c1', prompt: 'p1', envelope: { tiers: [{ blocks: [{ type: 'text', text: 'S' }] }] } }],
      undefined,
      { model: 'kimi-k2.6', schema: { type: 'object' }, maxTokens: 100, effort: 'high' },
    );
    expect(handle.batchId).toBe('bat-1');
    const body = (client.batches as any).create ? (client as any)._created : null;
    expect(body.endpoint).toBe('/v1/chat/completions');
    expect(body.completion_window).toBe('1d');
    expect((await svc.getBatch('bat-1')).status).toBe('ended');
    const results = await svc.getBatchResults('bat-1');
    expect(results[0]).toMatchObject({ customId: 'c1', type: 'succeeded', text: '{"y":2}' });
    expect(results[0].usage).toEqual({ input: 4, cacheRead: 2, cacheCreate5m: 0, cacheCreate1h: 0, output: 1 });
  });

  it('writes one JSONL line per item with the request body Moonshot batch accepts', async () => {
    const { svc, uploads, client } = makeNative({ id: 'bat-1', status: 'validating' }, '');
    await svc.submitBatch(
      [
        { customId: 'c1', prompt: 'p1' }, // no envelope anywhere → no cache key
        { prompt: 'p2', envelope: { system: 'SYS' } }, // per-item envelope → cache key
      ],
      undefined,
      { model: 'kimi-k2.6', schema: { type: 'object' }, maxTokens: 100, effort: 'max' },
    );
    expect(uploads[0].purpose).toBe('batch');
    const lines = (await uploads[0].file.text()).split('\n').map((l: string) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ custom_id: 'c1', method: 'POST', url: '/v1/chat/completions' });
    expect(lines[0].body).toMatchObject({
      model: 'kimi-k2.6',
      messages: [{ role: 'user', content: 'p1' }],
      max_completion_tokens: 100,
      reasoning_effort: 'max',
    });
    expect(lines[0].body.response_format.type).toBe('json_schema');
    // Moonshot fixes sampling params and rejects batches that set them.
    expect(lines[0].body.temperature).toBeUndefined();
    expect(lines[0].body.top_p).toBeUndefined();
    // No stable prefix → no prompt_cache_key key at all (conditional spread).
    expect('prompt_cache_key' in lines[0].body).toBe(false);
    expect(lines[1].custom_id).toBe('request-1'); // customId defaulted by index
    expect(lines[1].body.messages[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(typeof lines[1].body.prompt_cache_key).toBe('string');
    expect((client as any)._created.input_file_id).toBe('file-in');
  });

  it('reads max_completion_tokens from config when the caller passes none', async () => {
    const { svc, uploads } = makeNative({ id: 'bat-1', status: 'validating' }, '', { config: { 'moonshot.maxTokens': 4321 } });
    await svc.submitBatch([{ customId: 'c1', prompt: 'p1' }], undefined, { model: 'kimi-k2.6' });
    const line = JSON.parse(await uploads[0].file.text());
    expect(line.body.max_completion_tokens).toBe(4321);
  });

  it('maps every native batch status onto the neutral lifecycle', async () => {
    const cases: Array<[string, string]> = [
      ['completed', 'ended'],
      ['failed', 'errored'],
      ['expired', 'expired'],
      ['cancelling', 'canceled'],
      ['cancelled', 'canceled'],
      ['validating', 'in_progress'],
      ['in_progress', 'in_progress'],
      ['finalizing', 'in_progress'],
      ['something_new', 'submitted'],
    ];
    for (const [native, neutral] of cases) {
      const { svc } = makeNative({ id: 'bat-1', status: native, request_counts: { total: 3 } }, '');
      const handle = await svc.getBatch('bat-1');
      expect([native, handle.status]).toEqual([native, neutral]);
      expect(handle.requestCounts).toEqual({ total: 3 });
    }
  });

  it('keeps the parseable rows when one output line is corrupt', async () => {
    const output = [okLine('c1', '{"y":1}'), '{not json', okLine('c2', '{"y":2}')].join('\n');
    const { svc } = makeNative({ id: 'bat-1', status: 'completed', output_file_id: 'file-out' }, output);
    const results = await svc.getBatchResults('bat-1');
    // One truncated line must not cost us the other paid results.
    expect(results.map((r) => r.customId)).toEqual(['c1', 'c2']);
  });

  it('maps refusals, non-200 rows, and the error file to item results', async () => {
    const output = [
      // Carries usage: a refusal reported as an error object is still billed, so the
      // usage must reach the reconciler rather than being replaced with zeros.
      JSON.stringify({ custom_id: 'refused', response: { status_code: 400, body: { error: { type: 'content_filter' }, usage: { prompt_tokens: 5, cached_tokens: 1, completion_tokens: 0 } } } }),
      JSON.stringify({ custom_id: 'boom', response: { status_code: 500, body: {} } }),
      okLine('ok', '{}'),
    ].join('\n');
    const errorFile = JSON.stringify({ custom_id: 'bad-req', error: { message: 'invalid body' } });
    const { svc } = makeNative(
      { id: 'bat-1', status: 'completed', output_file_id: 'file-out', error_file_id: 'file-err' },
      output,
      { errorText: errorFile },
    );
    const results = await svc.getBatchResults('bat-1');
    expect(results).toEqual([
      { customId: 'refused', type: 'refusal', usage: { input: 4, cacheRead: 1, cacheCreate5m: 0, cacheCreate1h: 0, output: 0 }, cacheReadTokens: 1 },
      { customId: 'boom', type: 'errored', error: 'status 500' },
      { customId: 'ok', type: 'succeeded', text: '{}', usage: { input: 4, cacheRead: 2, cacheCreate5m: 0, cacheCreate1h: 0, output: 1 }, cacheReadTokens: 2 },
      { customId: 'bad-req', type: 'errored', error: JSON.stringify({ message: 'invalid body' }) },
    ]);
  });

  // A 200 row can still carry an in-band failure. Recording one as 'succeeded' makes
  // the reconciler write a permanent INVALID cell — cells are write-once, so no
  // top-up ever re-runs that slot.
  it('maps an in-band content_filter finish_reason on a 200 row to a billed refusal', async () => {
    const output = JSON.stringify({ custom_id: 'c1', response: { status_code: 200, body: { choices: [{ message: { content: '' }, finish_reason: 'content_filter' }], usage: { prompt_tokens: 6, cached_tokens: 2, completion_tokens: 0 } } } });
    const { svc } = makeNative({ id: 'bat-1', status: 'completed', output_file_id: 'file-out' }, output);
    // A refusal is billed and the reconciler emits usage for refusal items, so the
    // usage must survive the mapping.
    expect(await svc.getBatchResults('bat-1')).toEqual([
      { customId: 'c1', type: 'refusal', usage: { input: 4, cacheRead: 2, cacheCreate5m: 0, cacheCreate1h: 0, output: 0 }, cacheReadTokens: 2 },
    ]);
  });

  it('maps a truncated 200 row (finish_reason=length) to a retryable errored item', async () => {
    const output = JSON.stringify({ custom_id: 'c1', response: { status_code: 200, body: { choices: [{ message: { content: '{"y":' }, finish_reason: 'length' }], usage: { prompt_tokens: 6, cached_tokens: 0, completion_tokens: 9 } } } });
    const { svc } = makeNative({ id: 'bat-1', status: 'completed', output_file_id: 'file-out' }, output);
    expect(await svc.getBatchResults('bat-1')).toEqual([{ customId: 'c1', type: 'errored', error: 'output truncated (finish_reason=length)' }]);
  });

  it('treats an in-band error on a 200 row as errored rather than an empty success', async () => {
    const output = JSON.stringify({ custom_id: 'c1', response: { status_code: 200, body: { error: { type: 'server_error', message: 'oops' }, choices: [] } } });
    const { svc } = makeNative({ id: 'bat-1', status: 'completed', output_file_id: 'file-out' }, output);
    expect(await svc.getBatchResults('bat-1')).toEqual([{ customId: 'c1', type: 'errored', error: JSON.stringify({ type: 'server_error', message: 'oops' }) }]);
  });

  it('deletes the orphaned input file when batches.create fails', async () => {
    const { svc, client, dels } = makeNative({ id: 'bat-1', status: 'validating' }, '');
    (client.batches as any).create = async () => { throw Object.assign(new Error('quota exceeded'), { status: 429 }); };
    const { status, error } = await statusOf(() => svc.submitBatch([{ customId: 'c1', prompt: 'p1' }], undefined, { model: 'kimi-k2.6' }));
    expect(status).toBe(429); // the original failure still reaches the caller
    expect(error).toBe('quota exceeded');
    expect(dels).toEqual(['file-in']); // an input file with no batch is pure leak against the 1,000-file cap
  });

  it('deletes the input file after reading a terminal batch, but not while it is in flight', async () => {
    const done = makeNative({ id: 'bat-1', status: 'completed', input_file_id: 'file-in', output_file_id: 'file-out' }, okLine('c1', '{}'));
    await done.svc.getBatchResults('bat-1');
    expect(done.dels).toEqual(['file-in']);
    const running = makeNative({ id: 'bat-1', status: 'in_progress', input_file_id: 'file-in', output_file_id: 'file-out' }, okLine('c1', '{}'));
    await running.svc.getBatchResults('bat-1');
    expect(running.dels).toEqual([]); // Moonshot still needs it
  });

  it('never fails a results read because the input-file delete failed', async () => {
    const { svc, client } = makeNative({ id: 'bat-1', status: 'completed', input_file_id: 'file-in', output_file_id: 'file-out' }, okLine('c1', '{}'));
    (client.files as any).del = async () => { throw new Error('file already gone'); };
    expect((await svc.getBatchResults('bat-1')).map((r) => r.customId)).toEqual(['c1']);
  });

  it('rejects an empty batch before uploading anything', async () => {
    const { svc, uploads } = makeNative({ id: 'bat-1', status: 'validating' }, '');
    // A 0-byte JSONL file would come back as an opaque upstream 400.
    const { status } = await statusOf(() => svc.submitBatch([], undefined, { model: 'kimi-k2.6' }));
    expect(status).toBe(400);
    expect(uploads).toEqual([]);
  });

  it('maps an SDK error from the native path through rethrow', async () => {
    const { svc, client } = makeNative({ id: 'bat-1', status: 'completed' }, '');
    (client.batches as any).retrieve = async () => { throw Object.assign(new Error('nope'), { status: 404 }); };
    const { status, error } = await statusOf(() => svc.getBatch('bat-1'));
    expect(status).toBe(404);
    expect(error).toBe('nope');
  });
});
