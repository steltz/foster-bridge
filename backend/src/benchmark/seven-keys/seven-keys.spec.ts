import { CURRENT_SCHEMA, LOOKBACK_SCHEMA, SYNTH_SCHEMA, VERIFY_SCHEMA } from './schemas';
import { currentDayPrompt, lookbackPrompt, synthesizePrompt, verifyPrompt } from './prompts';

describe('seven-keys schemas', () => {
  it('CURRENT_SCHEMA requires bias/environment/zones and grades zones on keys 3-7', () => {
    expect(CURRENT_SCHEMA.required).toEqual(['bias', 'environment', 'zones']);
    const zone = (CURRENT_SCHEMA.properties as any).zones.items;
    expect(zone.required).toEqual(['prices', 'side', 'key3', 'key4', 'key5', 'key6', 'key7', 'grade']);
    expect(zone.properties.grade.enum).toEqual(['automatic-fade', 'strong', 'moderate', 'weak']);
    expect(zone.properties.side.enum).toEqual(['support', 'resistance']);
  });

  it('drops structured-output-illegal constraints (maxLength / minItems)', () => {
    const zone = (CURRENT_SCHEMA.properties as any).zones;
    expect(zone.minItems).toBeUndefined();
    expect(zone.items.properties.prices.maxLength).toBeUndefined();
    expect((CURRENT_SCHEMA.properties as any).bias.maxLength).toBeUndefined();
  });

  it('LOOKBACK/SYNTH/VERIFY required fields', () => {
    expect(LOOKBACK_SCHEMA.required).toEqual(['calibration', 'continuity']);
    expect(SYNTH_SCHEMA.required).toEqual(['artifact']);
    expect(VERIFY_SCHEMA.required).toEqual(['pass', 'mismatches']);
  });
});

describe('seven-keys prompts', () => {
  it('currentDayPrompt inlines methods + transcripts and carries the grade-discrimination rule', () => {
    const p = currentDayPrompt({
      date: '2026-07-01',
      generalDocs: 'GEN',
      methodsDoc: 'METHODS',
      tpTranscript: 'TP',
      recapTranscript: 'RECAP',
    });
    expect(p).toContain('METHODS');
    expect(p).toContain('TP');
    expect(p).toContain('RECAP');
    expect(p).toContain('Copy each zone');
    expect(p).toContain('no more than about a third');
    expect(p).toContain('attached PDF');
  });

  it('currentDayPrompt omits the general-docs block when generalDocs is empty', () => {
    const p = currentDayPrompt({
      date: '2026-07-01',
      generalDocs: '',
      methodsDoc: 'METHODS',
      tpTranscript: 'TP',
      recapTranscript: 'RECAP',
    });
    expect(p).not.toContain('First Read ALL of these general');
    expect(p).toContain('attached PDF');
  });

  it('lookbackPrompt lists days oldest-first and marks missing recaps', () => {
    const p = lookbackPrompt('2026-07-08', [
      { day: '07012026', keysContent: 'K1', outcomeRecap: 'O1' },
      { day: '07022026', keysContent: 'K2', outcomeRecap: null },
    ]);
    expect(p.indexOf('07012026')).toBeLessThan(p.indexOf('07022026'));
    expect(p).toContain('K1');
    expect(p).toContain('no outcome recap available');
  });

  it('synthesizePrompt embeds both inputs and the authoritative weighting rule', () => {
    const p = synthesizePrompt('2026-07-01', { bias: 'b' }, { calibration: [] }, '07012026_ES_KEYS.md');
    expect(p).toContain('"bias": "b"');
    expect(p).toContain('authoritative');
    expect(p).toContain('07012026_ES_KEYS.md');
    const boot = synthesizePrompt('2026-07-01', { bias: 'b' }, null, 'none — bootstrap');
    expect(boot).toContain('none — bootstrap');
  });

  it('verifyPrompt embeds the artifact and demands price+side fidelity only', () => {
    const p = verifyPrompt('2026-07-01', 'TP', '# ARTIFACT BODY');
    expect(p).toContain('# ARTIFACT BODY');
    expect(p).toContain('fidelity');
    expect(p).toContain('attached PDF');
  });
});
