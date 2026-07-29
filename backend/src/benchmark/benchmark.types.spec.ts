import { cellKey, parseCellKey, SETUP_SCHEMA, CORE_VARIANTS, ALL_VARIANTS, SCORECARD_VARIANT, resolveModel, MODEL_ALIASES } from './benchmark.types';

describe('cellKey', () => {
  it('round-trips a cell key', () => {
    const parts = { trader: 'context-trader', modelAlias: 'fable', day: '07012026', variant: 'base', runIndex: 3 };
    const key = cellKey(parts);
    expect(key).toBe('context-trader__fable__07012026__base__run3');
    expect(parseCellKey(key)).toEqual(parts);
  });

  it('round-trips the seven-keys-method variant', () => {
    const parts = { trader: 'context-structured', modelAlias: 'fable', day: '07162026', variant: 'seven-keys-method', runIndex: 12 };
    expect(parseCellKey(cellKey(parts))).toEqual(parts);
  });

  it('is safe for model ids that contain no "__" (aliases)', () => {
    // We key on the ALIAS (fable/opus/…), never the raw id, so no field carries "__".
    for (const alias of Object.keys(resolveModel.ALIASES)) {
      const parts = { trader: 'a', modelAlias: alias, day: '07012026', variant: 'base', runIndex: 1 };
      expect(parseCellKey(cellKey(parts))).toEqual(parts);
    }
  });

  it('throws on the wrong segment count', () => {
    expect(() => parseCellKey('a__b__c')).toThrow('Malformed cell key: a__b__c');
  });

  it('throws on a non-numeric run suffix', () => {
    const key = 'a__fable__07012026__base__runX';
    expect(() => parseCellKey(key)).toThrow(`Malformed cell key: ${key}`);
  });

  it('throws on a missing run number', () => {
    const key = 'a__fable__07012026__base__run';
    expect(() => parseCellKey(key)).toThrow(`Malformed cell key: ${key}`);
  });
});

describe('resolveModel', () => {
  it('resolves a known alias to { alias, id }', () => {
    expect(resolveModel('fable')).toEqual({ alias: 'fable', id: 'claude-fable-5' });
  });
  it('resolves a known id back to its alias', () => {
    expect(resolveModel('claude-fable-5')).toEqual({ alias: 'fable', id: 'claude-fable-5' });
  });
  it('falls back to using an unknown value as both alias and id', () => {
    expect(resolveModel('claude-mystery-9')).toEqual({ alias: 'claude-mystery-9', id: 'claude-mystery-9' });
  });
});

describe('resolveModel – kimi aliases', () => {
  it('resolves the kimi aliases to ids', () => {
    expect(MODEL_ALIASES.k3).toBe('kimi-k3');
    expect(resolveModel('k3')).toEqual({ alias: 'k3', id: 'kimi-k3' });
    expect(resolveModel('k26')).toEqual({ alias: 'k26', id: 'kimi-k2.6' });
    expect(resolveModel('k27-code')).toEqual({ alias: 'k27-code', id: 'kimi-k2.7-code' });
  });

  it('maps a raw kimi id back to its alias', () => {
    expect(resolveModel('kimi-k3')).toEqual({ alias: 'k3', id: 'kimi-k3' });
  });
});

describe('SETUP_SCHEMA / CORE_VARIANTS', () => {
  it('requires the seven setup fields and forbids extras', () => {
    expect(SETUP_SCHEMA.required).toEqual(['side', 'entry', 'stopLoss', 'takeProfit', 'rationale', 'primaryZone', 'confidence']);
    expect(SETUP_SCHEMA.additionalProperties).toBe(false);
  });
  it('omits structured-output-illegal constraints (maxLength / minimum / maximum)', () => {
    const props = SETUP_SCHEMA.properties as Record<string, Record<string, unknown>>;
    expect(props.rationale.maxLength).toBeUndefined();
    expect(props.primaryZone.maxLength).toBeUndefined();
    expect(props.confidence.minimum).toBeUndefined();
    expect(props.confidence.maximum).toBeUndefined();
  });
  it('scopes core variants to base + seven-keys-method', () => {
    expect(CORE_VARIANTS).toEqual(['base', 'seven-keys-method']);
  });
  it('keeps CORE_VARIANTS intact and adds scorecard only to ALL_VARIANTS', () => {
    expect(CORE_VARIANTS).toEqual(['base', 'seven-keys-method']);
    expect(SCORECARD_VARIANT).toBe('seven-keys-scorecard');
    expect(ALL_VARIANTS).toEqual(['base', 'seven-keys-method', 'seven-keys-scorecard']);
    // CORE_VARIANTS must NOT contain the scorecard variant (base/method-only callers rely on this).
    expect(CORE_VARIANTS).not.toContain('seven-keys-scorecard');
  });
});
