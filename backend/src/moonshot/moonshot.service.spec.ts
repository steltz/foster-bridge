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

function make(chatHandler: (body: any) => any, fileHandlers: any = {}) {
  const extracts = fakeExtracts();
  const envelopes = new MoonshotEnvelopeBuilder(extracts);
  const events: any = { emitted: [] as any[], emit(name: string, p: any) { this.emitted.push({ name, p }); return true; } };
  const client = {
    chat: { completions: { create: async (b: any) => chatHandler(b) } },
    files: {
      create: async (_a: any) => ({ id: fileHandlers.id ?? 'ms-file-1' }),
      content: async (_id: string) => ({ text: async () => fileHandlers.text ?? 'EXTRACTED' }),
      del: async (_id: string) => ({}),
    },
  };
  const clientFactory = { get: () => client } as any;
  const config = { get: (k: string) => (k === 'moonshot.model' ? 'kimi-k3' : k === 'moonshot.completionWindow' ? '1d' : undefined) } as any;
  const batchStore: any = {};
  const worker: any = { kick() {} };
  const svc = new MoonshotLlmProvider(clientFactory, config, events, envelopes, extracts, batchStore, worker);
  return { svc, events, extracts };
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

  it('uploadFile extracts, caches by hash, deletes remote, returns synthetic id', async () => {
    const { svc, extracts } = make(() => ({}), { text: 'PDF CONTENT' });
    const id = await svc.uploadFile(Buffer.from('bytes'), 'f.pdf', 'application/pdf');
    expect(id.startsWith('moonshot-extract:')).toBe(true);
    expect(await extracts.getById(id)).toBe('PDF CONTENT');
  });

  it('throws 422 on content_filter refusal', async () => {
    const { svc } = make(() => { throw Object.assign(new Error('filtered'), { status: 400, error: { type: 'content_filter' } }); });
    let status = 0;
    try {
      await svc.messageStructured({ prompt: 'go' }, { operation: 'demo' });
    } catch (e: any) {
      status = e.getStatus?.() ?? e.status;
    }
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
    let status = 0;
    try {
      await svc.messageStructured({ prompt: 'go', schema: { type: 'object' } }, { operation: 'demo' });
    } catch (e: any) {
      status = e.getStatus?.() ?? e.status;
    }
    expect(status).toBe(422);
    expect(events.emitted).toHaveLength(1);
    expect(events.emitted[0].p.tokens).toEqual({ input: 5, cacheRead: 4, cacheCreate5m: 0, cacheCreate1h: 0, output: 0 });
  });
});
