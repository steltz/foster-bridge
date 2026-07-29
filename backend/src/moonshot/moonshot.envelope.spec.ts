import { MoonshotEnvelopeBuilder } from './moonshot.envelope';
import { PromptEnvelope } from '../llm/llm.types';

const fakeExtractStore = (map: Record<string, string>) => ({
  async getById(id: string) { return map[id] ?? null; },
}) as any;

describe('MoonshotEnvelopeBuilder.buildRequest', () => {
  it('renders tiers as leading system messages, file blocks as extracted text, prompt as final user', async () => {
    const b = new MoonshotEnvelopeBuilder(fakeExtractStore({ 'moonshot-extract:h1': 'PDF TEXT' }));
    const env: PromptEnvelope = {
      tiers: [
        { blocks: [{ type: 'text', text: 'GENERAL' }] },
        { blocks: [{ type: 'file', fileId: 'moonshot-extract:h1' }, { type: 'text', text: 'TRANSCRIPT' }] },
      ],
    };
    const { messages, promptCacheKey } = await b.buildRequest(env, 'DO IT');
    expect(messages).toEqual([
      { role: 'system', content: 'GENERAL' },
      { role: 'system', content: 'PDF TEXT\nTRANSCRIPT' },
      { role: 'user', content: 'DO IT' },
    ]);
    expect(promptCacheKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a stable cache key for the same prefix regardless of the trailing prompt', async () => {
    const b = new MoonshotEnvelopeBuilder(fakeExtractStore({}));
    const env: PromptEnvelope = { tiers: [{ blocks: [{ type: 'text', text: 'STABLE' }] }] };
    const a = await b.buildRequest(env, 'q1');
    const c = await b.buildRequest(env, 'q2');
    expect(a.promptCacheKey).toBe(c.promptCacheKey);
  });

  it('throws when a file block references an unknown extract id', async () => {
    const b = new MoonshotEnvelopeBuilder(fakeExtractStore({}));
    const env: PromptEnvelope = { tiers: [{ blocks: [{ type: 'file', fileId: 'moonshot-extract:missing' }] }] };
    await expect(b.buildRequest(env, 'x')).rejects.toThrow(/extract/i);
  });
});
