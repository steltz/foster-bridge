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

  it('shares the cache key across envelopes that differ only after the second tier', async () => {
    const b = new MoonshotEnvelopeBuilder(fakeExtractStore({}));
    const shared = [
      { blocks: [{ type: 'text' as const, text: 'GENERAL' }] },
      { blocks: [{ type: 'text' as const, text: 'DAY BUNDLE' }] },
    ];
    const a = await b.buildRequest({ tiers: [...shared, { blocks: [{ type: 'text', text: 'PERSONA A' }] }] }, 'q');
    const c = await b.buildRequest({ tiers: [...shared, { blocks: [{ type: 'text', text: 'PERSONA B' }] }] }, 'q');
    // prompt_cache_key is a ROUTING hint, not the match criterion (matching is
    // byte-prefix-based) — keying at the shared day-bundle level routes every
    // persona/feature variant of a day into one cache bucket, so cross-variant
    // prefix hits on the shared tiers become possible.
    expect(a.promptCacheKey).toBe(c.promptCacheKey);
  });

  it('produces different cache keys when the second (day) tier differs', async () => {
    const b = new MoonshotEnvelopeBuilder(fakeExtractStore({}));
    const general = { blocks: [{ type: 'text' as const, text: 'GENERAL' }] };
    const a = await b.buildRequest({ tiers: [general, { blocks: [{ type: 'text', text: 'DAY 1' }] }] }, 'q');
    const c = await b.buildRequest({ tiers: [general, { blocks: [{ type: 'text', text: 'DAY 2' }] }] }, 'q');
    expect(a.promptCacheKey).not.toBe(c.promptCacheKey);
  });

  it('throws when a file block references an unknown extract id', async () => {
    const b = new MoonshotEnvelopeBuilder(fakeExtractStore({}));
    const env: PromptEnvelope = { tiers: [{ blocks: [{ type: 'file', fileId: 'moonshot-extract:missing' }] }] };
    await expect(b.buildRequest(env, 'x')).rejects.toThrow(/extract/i);
  });

  it('returns promptCacheKey undefined when there is no stable prefix (no system, no tiers)', async () => {
    const b = new MoonshotEnvelopeBuilder(fakeExtractStore({}));
    const env: PromptEnvelope = {};
    const { messages, promptCacheKey } = await b.buildRequest(env, 'hello');
    expect(promptCacheKey).toBeUndefined();
    expect(messages).toEqual([{ role: 'user', content: 'hello' }]);
  });
});
