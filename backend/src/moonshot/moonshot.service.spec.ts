import { MoonshotLlmProvider } from './moonshot.service';
import { MoonshotEnvelopeBuilder } from './moonshot.envelope';

const fakeExtracts = () => {
  const map = new Map<string, string>();
  return {
    store: map,
    async put(hash: string, text: string) { map.set(hash, text); },
    async getById(id: string) { return map.get(id.replace('moonshot-extract:', '')) ?? null; },
    async getByHash(h: string) { return map.get(h) ?? null; },
  } as any;
};

function make(chatHandler: (body: any) => any, fileHandlers: any = {}, configValues: Record<string, unknown> = {}) {
  const extracts = fakeExtracts();
  const envelopes = new MoonshotEnvelopeBuilder(extracts);
  const events: any = { emitted: [] as any[], emit(name: string, p: any) { this.emitted.push({ name, p }); return true; } };
  const creates: any[] = [];
  const dels: string[] = [];
  const client = {
    chat: { completions: { create: async (b: any) => chatHandler(b) } },
    files: {
      create: async (a: any) => { creates.push(a); return { id: fileHandlers.id ?? 'ms-file-1' }; },
      content: async (_id: string) => ({ text: async () => fileHandlers.text ?? 'EXTRACTED' }),
      del: async (id: string) => { dels.push(id); return {}; },
    },
  };
  const clientFactory = { get: () => client } as any;
  // Mirrors ConfigService: an unset key reads back undefined, so a test names only
  // the keys it cares about.
  const values: Record<string, unknown> = { 'moonshot.model': 'kimi-k3', 'moonshot.completionWindow': '1d', ...configValues };
  const config = { get: (k: string) => values[k] } as any;
  const batchStore: any = {};
  const worker: any = { kick() {} };
  const svc = new MoonshotLlmProvider(clientFactory, config, events, envelopes, extracts, batchStore, worker);
  return { svc, events, extracts, creates, dels, client };
}

/** Runs `fn`, returning the HTTP status and `error` string of the exception it throws. */
async function statusOf(fn: () => Promise<unknown>): Promise<{ status: number; error?: string }> {
  try {
    await fn();
    return { status: 0 };
  } catch (e: any) {
    return { status: e.getStatus?.() ?? e.status, error: e.getResponse?.()?.error };
  }
}

describe('MoonshotLlmProvider – sync + upload', () => {
  it('messageStructured builds json_schema, parses content, emits sync usage', async () => {
    const { svc, events } = make((body) => {
      expect(body.model).toBe('kimi-k3');
      expect(body.response_format.type).toBe('json_schema');
      expect(body.temperature).toBeUndefined();
      return { choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, cached_tokens: 3, completion_tokens: 2 } };
    });
    const out = await svc.messageStructured({ prompt: 'go', schema: { type: 'object' }, effort: 'high', maxTokens: 100 }, { operation: 'keys-generation' });
    expect(out).toEqual({ a: 1 });
    expect(events.emitted[0].name).toBe('llm.usage');
    expect(events.emitted[0].p.serviceTier).toBe('standard');
    expect(events.emitted[0].p.tokens).toEqual({ input: 5, cacheRead: 3, cacheCreate5m: 0, cacheCreate1h: 0, output: 2 });
  });

  it("messageStructured with effort 'none' sends thinking-disabled instead of reasoning_effort", async () => {
    // reasoning_effort (any level) degenerates kimi strict-schema decoding
    // into a whitespace loop — see effortParams in moonshot.chat.ts.
    const { svc } = make((body) => {
      expect(body.thinking).toEqual({ type: 'disabled' });
      expect(body.reasoning_effort).toBeUndefined();
      return { choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2 } };
    });
    await expect(
      svc.messageStructured({ prompt: 'go', schema: { type: 'object' }, effort: 'none', maxTokens: 100 }, { operation: 'other' }),
    ).resolves.toEqual({ a: 1 });
  });

  it('messageStructured retries a degenerate strict-schema response through the json_object fallback', async () => {
    // kimi strict-json_schema decoding can loop whitespace before the final
    // enum until finish_reason=length (observed 2/6 on kimi-k2.6). One retry
    // in schema-instructed json_object mode recovers it.
    const bodies: any[] = [];
    const { svc, events } = make((body) => {
      bodies.push(body);
      if (body.response_format?.type === 'json_schema') {
        return { choices: [{ message: { content: '{"a": \r \r \r' }, finish_reason: 'length' }], usage: { prompt_tokens: 8, completion_tokens: 300 } };
      }
      return { choices: [{ message: { content: '"a":1}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 5 } };
    });
    const out = await svc.messageStructured({ prompt: 'go', schema: { type: 'object' }, effort: 'none', maxTokens: 300 }, { operation: 'other' });
    expect(out).toEqual({ a: 1 });
    expect(bodies).toHaveLength(2);
    expect(bodies[1].response_format).toEqual({ type: 'json_object' });
    // both attempts are billed
    expect(events.emitted.filter((e: any) => e.name === 'llm.usage')).toHaveLength(2);
  });

  it('messageStructured still 502s when the json_object retry is also truncated', async () => {
    const { svc } = make((body) =>
      body.response_format?.type === 'json_schema'
        ? { choices: [{ message: { content: '{"a": \r' }, finish_reason: 'length' }], usage: {} }
        : { choices: [{ message: { content: '"a": \r' }, finish_reason: 'length' }], usage: {} },
    );
    const res = await statusOf(() =>
      svc.messageStructured({ prompt: 'go', schema: { type: 'object' }, maxTokens: 300 }, { operation: 'other' }),
    );
    expect(res.status).toBe(502);
    expect(res.error).toContain('finish_reason=length');
  });

  it('uploadFile extracts, caches by hash, deletes remote, returns synthetic id', async () => {
    const { svc, extracts, dels } = make(() => ({}), { text: 'PDF CONTENT' });
    const id = await svc.uploadFile(Buffer.from('bytes'), 'f.pdf', 'application/pdf');
    expect(id.startsWith('moonshot-extract:')).toBe(true);
    expect(await extracts.getById(id)).toBe('PDF CONTENT');
    // The remote copy must not survive the call — Moonshot caps an account at 1,000 files.
    expect(dels).toEqual(['ms-file-1']);
  });

  it('uploadFile short-circuits on a cache hit without re-uploading', async () => {
    const { svc, creates, dels } = make(() => ({}), { text: 'PDF CONTENT' });
    const first = await svc.uploadFile(Buffer.from('bytes'), 'f.pdf', 'application/pdf');
    const second = await svc.uploadFile(Buffer.from('bytes'), 'f.pdf', 'application/pdf');
    expect(second).toBe(first);
    expect(creates).toHaveLength(1);
    expect(dels).toEqual(['ms-file-1']);
  });

  it('messageStructured falls back to the configured max tokens, guarding a NaN config', async () => {
    const bodies: any[] = [];
    const respond = (body: any) => { bodies.push(body); return { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }], usage: {} }; };
    const configured = make(respond, {}, { 'moonshot.maxTokens': 12345 });
    await configured.svc.messageStructured({ prompt: 'go' }, { operation: 'demo' });
    expect(bodies[0].max_completion_tokens).toBe(12345);
    // A blank MOONSHOT_MAX_TOKENS reaches config as parseInt('') === NaN, which would
    // otherwise serialize into the request body as `max_completion_tokens: null`.
    const broken = make(respond, {}, { 'moonshot.maxTokens': NaN });
    await broken.svc.messageStructured({ prompt: 'go' }, { operation: 'demo' });
    expect(bodies[1].max_completion_tokens).toBe(32000);
    // An explicit caller value still wins over both.
    await configured.svc.messageStructured({ prompt: 'go', maxTokens: 50 }, { operation: 'demo' });
    expect(bodies[2].max_completion_tokens).toBe(50);
  });

  it('uploadFile still deletes the remote file when the content read throws', async () => {
    const { svc, dels, client } = make(() => ({}));
    client.files.content = async () => { throw new Error('extract unavailable'); };
    // The finally-delete covers this arm too: nothing was extracted, but the remote
    // file exists and files.del here is the only thing that ever removes it.
    await expect(svc.uploadFile(Buffer.from('bytes'), 'f.pdf', 'application/pdf')).rejects.toThrow('extract unavailable');
    expect(dels).toEqual(['ms-file-1']);
  });

  it('uploadFile still deletes the remote file when the extract store throws', async () => {
    const { svc, dels, extracts } = make(() => ({}), { text: 'PDF CONTENT' });
    extracts.put = async () => { throw new Error('firestore unavailable'); };
    // A store failure after the upload must not leak the remote file: it is the
    // only files.del caller, so a leaked file is leaked for good.
    await expect(svc.uploadFile(Buffer.from('bytes'), 'f.pdf', 'application/pdf')).rejects.toThrow('firestore unavailable');
    expect(dels).toEqual(['ms-file-1']);
  });

  it('throws 422 on content_filter refusal', async () => {
    const { svc } = make(() => { throw Object.assign(new Error('filtered'), { status: 400, error: { type: 'content_filter' } }); });
    const { status } = await statusOf(() => svc.messageStructured({ prompt: 'go' }, { operation: 'demo' }));
    expect(status).toBe(422);
  });

  // Moonshot can also refuse with a 200 + finish_reason 'content_filter' and empty
  // content (rather than a thrown 400) — that must map to the same 422, not fall
  // through to the generic 502 "not valid JSON", and usage must still be captured.
  it('throws 422 when finish_reason is content_filter on a 200 response', async () => {
    const { svc, events } = make(() => ({
      choices: [{ message: { content: '' }, finish_reason: 'content_filter' }],
      usage: { prompt_tokens: 9, cached_tokens: 4, completion_tokens: 0 },
    }));
    const { status, error } = await statusOf(() => svc.messageStructured({ prompt: 'go', schema: { type: 'object' } }, { operation: 'demo' }));
    expect(status).toBe(422);
    expect(error).toBe('Structured message refused (content_filter)');
    expect(events.emitted).toHaveLength(1);
    expect(events.emitted[0].p.tokens).toEqual({ input: 5, cacheRead: 4, cacheCreate5m: 0, cacheCreate1h: 0, output: 0 });
  });

  it('throws 502 on a truncated response (finish_reason=length), after emitting usage', async () => {
    const { svc, events } = make(() => ({
      choices: [{ message: { content: '{"a":' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 7, cached_tokens: 0, completion_tokens: 100 },
    }));
    const { status, error } = await statusOf(() => svc.messageStructured({ prompt: 'go' }, { operation: 'demo' }));
    expect(status).toBe(502);
    // Distinct from the parse failure below: truncation must not be reported as bad JSON.
    expect(error).toBe('Structured output truncated (finish_reason=length)');
    expect(events.emitted).toHaveLength(1);
    expect(events.emitted[0].p.tokens.output).toBe(100);
  });

  it('throws 502 when the content is not valid JSON, after emitting usage', async () => {
    const { svc, events } = make(() => ({
      choices: [{ message: { content: 'I cannot help with that.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, cached_tokens: 0, completion_tokens: 6 },
    }));
    const { status, error } = await statusOf(() => svc.messageStructured({ prompt: 'go' }, { operation: 'demo' }));
    expect(status).toBe(502);
    expect(error).toBe('Structured output was not valid JSON');
    expect(events.emitted).toHaveLength(1);
  });
});
