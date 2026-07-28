import { FakeLlmProvider } from './fake-llm.provider';

describe('FakeLlmProvider', () => {
  it('records batch submissions and returns them by id', async () => {
    const fake = new FakeLlmProvider();
    const handle = await fake.submitBatch(
      [{ customId: 'k1', prompt: 'go' }],
      { tiers: [{ blocks: [{ type: 'text', text: 'ctx' }] }] },
      { model: 'm', schema: {}, maxTokens: 10, effort: 'high' },
    );
    expect(handle.batchId).toBeDefined();
    expect(handle.status).toBe('submitted');
    expect(fake.submittedBatches).toHaveLength(1);
    expect(fake.submittedBatches[0].requests[0].customId).toBe('k1');
  });

  it('serves canned structured responses and uploads', async () => {
    const fake = new FakeLlmProvider();
    fake.structuredResponses.push({ ok: true });
    const out = await fake.messageStructured<{ ok: boolean }>({ prompt: 'p' }, { operation: 'demo' });
    expect(out.ok).toBe(true);
    const id = await fake.uploadFile(Buffer.from('x'), 'f.pdf', 'application/pdf');
    expect(id).toMatch(/^fake-file-/);
  });

  it('returns queued batch results and a settable batch status', async () => {
    const fake = new FakeLlmProvider();
    fake.batchStatus = 'ended';
    fake.batchResults = [{ customId: 'k1', type: 'succeeded', text: '{}', usage: { input: 1, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0, output: 1 } }];
    const handle = await fake.getBatch('b1');
    expect(handle.status).toBe('ended');
    const results = await fake.getBatchResults('b1');
    expect(results[0].customId).toBe('k1');
  });
});
