import { EnvelopeBuilder, DayBundle, TRAILING_PROMPT } from './envelope.builder';

const bundle: DayBundle = {
  date: '2026-07-01',
  anthropicFileId: 'file_1',
  tpTranscript: 'TP TEXT',
  recapTranscript: 'RECAP TEXT',
};

describe('EnvelopeBuilder', () => {
  const builder = new EnvelopeBuilder();

  it('dayBundleContext is TWO user tiers (general, day) with NO system breakpoint', () => {
    const ctx = builder.dayBundleContext('GENERAL DOCS', bundle);
    // M4: the whole cached prefix lives in messages so output_config.format on
    // the batch does not invalidate it, and warm (max_tokens:0, no format) aligns.
    expect(ctx.system).toBeUndefined();
    expect(ctx.userTiers).toHaveLength(2);
    expect((ctx.userTiers![0].blocks[0] as any).text).toContain('GENERAL DOCS');
    const day = ctx.userTiers![1].blocks;
    expect(day[0]).toMatchObject({ type: 'document', source: { type: 'file', file_id: 'file_1' } });
    expect(day.some((b: any) => b.type === 'text' && b.text.includes('TP TEXT'))).toBe(true);
    expect(day.some((b: any) => b.type === 'text' && b.text.includes('RECAP TEXT'))).toBe(true);
  });

  it('base envelope has 3 tiers (general, day, persona), NO system, NO feature tier', () => {
    const env = builder.fullEnvelope('GENERAL', bundle, 'PERSONA', { variant: 'base' });
    expect(env.system).toBeUndefined();
    expect(env.userTiers).toHaveLength(3);
    expect((env.userTiers![0].blocks[0] as any).text).toContain('GENERAL');
    expect(env.userTiers![2].blocks.some((b: any) => b.text.includes('PERSONA'))).toBe(true);
  });

  it('seven-keys-method envelope adds a 4th feature tier with the methods doc', () => {
    const env = builder.fullEnvelope('GENERAL', bundle, 'PERSONA', {
      variant: 'seven-keys-method',
      featureBlock: 'Read the methodology.',
      methodsDoc: 'METHODS BODY',
    });
    expect(env.userTiers).toHaveLength(4); // general, day, persona, feature (still <= 4)
    const feat = env.userTiers![3].blocks;
    expect(feat.some((b: any) => b.text.includes('METHODS BODY'))).toBe(true);
    expect(feat.some((b: any) => b.text.includes('Read the methodology.'))).toBe(true);
  });

  it('exposes the constant trailing prompt', () => {
    expect(TRAILING_PROMPT).toMatch(/single setup/i);
  });
});
