import { EnvelopeBuilder, DayBundle, TRAILING_PROMPT } from './envelope.builder';

const bundle: DayBundle = {
  date: '2026-07-01',
  fileId: 'file_1',
  tpTranscript: 'TP TEXT',
  recapTranscript: 'RECAP TEXT',
};

describe('EnvelopeBuilder', () => {
  const builder = new EnvelopeBuilder();

  it('emits neutral content blocks with a file block for the day PDF', () => {
    const env = builder.fullEnvelope(
      'GENERAL',
      { date: '2026-07-01', fileId: 'file_7', tpTranscript: 'tp', recapTranscript: 're' },
      'PERSONA',
      { variant: 'base' },
    );
    expect(env.tiers).toHaveLength(3);
    const dayBlocks = env.tiers![1].blocks;
    expect(dayBlocks[0]).toEqual({ type: 'file', fileId: 'file_7' });
    expect(dayBlocks[1]).toMatchObject({ type: 'text' });
  });

  it('dayBundleContext is TWO user tiers (general, day) with NO system breakpoint', () => {
    const ctx = builder.dayBundleContext('GENERAL DOCS', bundle);
    // M4: the whole cached prefix lives in messages so output_config.format on
    // the batch does not invalidate it, and warm (max_tokens:0, no format) aligns.
    expect(ctx.system).toBeUndefined();
    expect(ctx.tiers).toHaveLength(2);
    expect((ctx.tiers![0].blocks[0] as any).text).toContain('GENERAL DOCS');
    const day = ctx.tiers![1].blocks;
    expect(day[0]).toEqual({ type: 'file', fileId: 'file_1' });
    expect(day.some((b: any) => b.type === 'text' && b.text.includes('TP TEXT'))).toBe(true);
    expect(day.some((b: any) => b.type === 'text' && b.text.includes('RECAP TEXT'))).toBe(true);
  });

  it('base envelope has 3 tiers (general, day, persona), NO system, NO feature tier', () => {
    const env = builder.fullEnvelope('GENERAL', bundle, 'PERSONA', { variant: 'base' });
    expect(env.system).toBeUndefined();
    expect(env.tiers).toHaveLength(3);
    expect((env.tiers![0].blocks[0] as any).text).toContain('GENERAL');
    expect(env.tiers![2].blocks.some((b: any) => b.text.includes('PERSONA'))).toBe(true);
  });

  it('seven-keys-method envelope adds a 4th feature tier with the methods doc', () => {
    const env = builder.fullEnvelope('GENERAL', bundle, 'PERSONA', {
      variant: 'seven-keys-method',
      featureBlock: 'Read the methodology.',
      methodsDoc: 'METHODS BODY',
    });
    expect(env.tiers).toHaveLength(4); // general, day, persona, feature (still <= 4)
    const feat = env.tiers![3].blocks;
    expect(feat.some((b: any) => b.text.includes('METHODS BODY'))).toBe(true);
    expect(feat.some((b: any) => b.text.includes('Read the methodology.'))).toBe(true);
  });

  it('exposes the constant trailing prompt', () => {
    expect(TRAILING_PROMPT).toMatch(/single setup/i);
  });

  it('fullEnvelope leading tiers are byte-identical to dayBundleContext (base)', () => {
    const dayBundle = builder.dayBundleContext('GENERAL', bundle);
    const full = builder.fullEnvelope('GENERAL', bundle, 'PERSONA', { variant: 'base' });
    expect(full.tiers!.slice(0, 2)).toEqual(dayBundle.tiers);
  });

  it('fullEnvelope leading tiers are byte-identical to dayBundleContext (non-base)', () => {
    const dayBundle = builder.dayBundleContext('GENERAL', bundle);
    const full = builder.fullEnvelope('GENERAL', bundle, 'PERSONA', {
      variant: 'seven-keys-method',
      featureBlock: 'Read the methodology.',
      methodsDoc: 'METHODS BODY',
    });
    expect(full.tiers!.slice(0, 2)).toEqual(dayBundle.tiers);
  });

  it('throws when a non-base variant has no feature block and no methods doc', () => {
    expect(() =>
      builder.fullEnvelope('GENERAL', bundle, 'PERSONA', { variant: 'seven-keys-method' }),
    ).toThrow(/seven-keys-method.*feature block or methods doc/i);
  });

  it('scorecard envelope substitutes ${DOC} + ${ARTIFACT} into the feature tier (still 4 tiers)', () => {
    const env = builder.fullEnvelope('GENERAL', bundle, 'PERSONA', {
      variant: 'seven-keys-scorecard',
      featureBlock: 'Read ${DOC} then adopt ${ARTIFACT}.',
      methodsDoc: 'METHODS BODY',
      artifact: 'KEYS BODY',
    });
    expect(env.tiers).toHaveLength(4);
    const feat = (env.tiers![3].blocks[0] as any).text;
    expect(feat).toContain('METHODS BODY');
    expect(feat).toContain('KEYS BODY');
    expect(feat).not.toContain('${DOC}');
    expect(feat).not.toContain('${ARTIFACT}');
  });

  it('scorecard leading tiers stay byte-identical to dayBundleContext (prefix identity)', () => {
    const dayBundle = builder.dayBundleContext('GENERAL', bundle);
    const full = builder.fullEnvelope('GENERAL', bundle, 'PERSONA', {
      variant: 'seven-keys-scorecard',
      featureBlock: 'Read ${DOC} then ${ARTIFACT}.',
      methodsDoc: 'M',
      artifact: 'K',
    });
    expect(full.tiers!.slice(0, 2)).toEqual(dayBundle.tiers);
  });

  it('throws when the scorecard variant has no artifact (empty feature-tier guard)', () => {
    expect(() =>
      builder.fullEnvelope('GENERAL', bundle, 'PERSONA', {
        variant: 'seven-keys-scorecard',
        featureBlock: 'Read ${DOC} then ${ARTIFACT}.',
        methodsDoc: 'M',
      }),
    ).toThrow(/seven-keys-scorecard.*artifact/i);
  });

  it('does not clobber a literal ${ARTIFACT} token inside methodsDoc (one-pass substitution)', () => {
    const env = builder.fullEnvelope('GENERAL', bundle, 'PERSONA', {
      variant: 'seven-keys-scorecard',
      featureBlock: 'Read ${DOC} then adopt ${ARTIFACT}.',
      methodsDoc: 'METHODS with a literal ${ARTIFACT} token',
      artifact: 'KEYS BODY',
    });
    const feat = (env.tiers![3].blocks[0] as any).text;
    expect(feat).toContain('literal ${ARTIFACT} token');
    expect(feat.endsWith('adopt KEYS BODY.')).toBe(true);
  });

  it('passes $-content through literally (function-replacer $-safety)', () => {
    const env = builder.fullEnvelope('GENERAL', bundle, 'PERSONA', {
      variant: 'seven-keys-scorecard',
      featureBlock: 'Read ${DOC} then adopt ${ARTIFACT}.',
      methodsDoc: 'M',
      artifact: 'entry at $4,500 (use $& and $1 literally)',
    });
    const feat = (env.tiers![3].blocks[0] as any).text;
    expect(feat).toContain('entry at $4,500 (use $& and $1 literally)');
  });

  it('throws when the scorecard variant has no methods doc (symmetric guard)', () => {
    expect(() =>
      builder.fullEnvelope('GENERAL', bundle, 'PERSONA', {
        variant: 'seven-keys-scorecard',
        featureBlock: 'Read ${DOC} then ${ARTIFACT}.',
        artifact: 'KEYS BODY',
      }),
    ).toThrow(/seven-keys-scorecard.*(methods|DOC)/i);
  });
});
