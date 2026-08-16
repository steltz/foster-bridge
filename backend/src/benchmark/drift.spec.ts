import { detectDrift, DriftInputs, hasDrift, renderDrift } from './drift';
import { BenchmarkCell } from './benchmark.types';

function cell(o: Partial<BenchmarkCell>): BenchmarkCell {
  return {
    trader: 'context-trader',
    model: { alias: 'fable', id: 'claude-fable-5' },
    modelAlias: 'fable',
    day: '07012026',
    date: '2026-07-01',
    variant: 'base',
    runIndex: 1,
    personaSha256: 'persona-a',
    generalSha256: 'general-a',
    result: { status: 'TP' },
    createdAt: '2026-07-01T00:00:00.000Z',
    ...o,
  } as BenchmarkCell;
}

function inputs(o: Partial<DriftInputs> = {}): DriftInputs {
  return {
    traders: [{ name: 'context-trader', sha256: 'persona-a' }],
    general: { sha256: 'general-a' },
    features: [],
    ...o,
  };
}

describe('detectDrift', () => {
  it('reports nothing when every cell matches the current files', () => {
    const report = detectDrift(inputs(), [cell({ runIndex: 1 }), cell({ runIndex: 2 })]);
    expect(report.findings).toEqual([]);
    expect(hasDrift(report)).toBe(false);
  });

  it('reports nothing when there are no cells at all', () => {
    expect(detectDrift(inputs(), []).findings).toEqual([]);
  });

  describe('persona', () => {
    it('flags file-drift when the trader file changed after cells were written', () => {
      const report = detectDrift(inputs({ traders: [{ name: 'context-trader', sha256: 'persona-EDITED' }] }), [
        cell({}),
      ]);
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0]).toMatchObject({
        kind: 'file-drift',
        family: 'persona',
        identity: 'context-trader',
        source: 'firestore',
        currentSha256: 'persona-EDITED',
        recorded: [{ sha256: 'persona-a', cellCount: 1 }],
      });
    });

    it('flags internal-drift when existing cells disagree with each other', () => {
      const report = detectDrift(inputs(), [
        cell({ runIndex: 1, personaSha256: 'persona-a' }),
        cell({ runIndex: 2, personaSha256: 'persona-b' }),
      ]);
      const finding = report.findings.find((f) => f.family === 'persona');
      expect(finding).toMatchObject({ kind: 'internal-drift', identity: 'context-trader' });
      expect(finding!.recorded.map((r) => r.sha256).sort()).toEqual(['persona-a', 'persona-b']);
    });

    it('scopes the comparison per trader — one trader drifting does not implicate another', () => {
      const report = detectDrift(
        inputs({
          traders: [
            { name: 'context-trader', sha256: 'persona-a' },
            { name: 'context-structured', sha256: 'persona-EDITED' },
          ],
        }),
        [cell({ trader: 'context-trader' }), cell({ trader: 'context-structured', personaSha256: 'persona-z' })],
      );
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0].identity).toBe('context-structured');
    });

    it('compares across every model, day and variant', () => {
      const report = detectDrift(inputs(), [
        cell({ modelAlias: 'fable', day: '07012026', variant: 'base', personaSha256: 'persona-a' }),
        cell({ modelAlias: 'sonnet', day: '07022026', variant: 'seven-keys-method', personaSha256: 'persona-b' }),
      ]);
      expect(report.findings.some((f) => f.family === 'persona' && f.kind === 'internal-drift')).toBe(true);
    });

    it('ignores cells for traders no longer on disk', () => {
      expect(detectDrift(inputs(), [cell({ trader: 'deleted-trader', personaSha256: 'whatever' })]).findings).toEqual(
        [],
      );
    });
  });

  describe('general docs', () => {
    it('flags file-drift against every cell regardless of trader or variant', () => {
      const report = detectDrift(inputs({ general: { sha256: 'general-EDITED' } }), [
        cell({ trader: 'context-trader', variant: 'base' }),
        cell({ trader: 'context-structured', variant: 'seven-keys-method', featureSha256: 'f-a' }),
      ]);
      const finding = report.findings.find((f) => f.family === 'general');
      expect(finding).toMatchObject({ kind: 'file-drift', identity: 'knowledge-base/general', source: 'bucket' });
      expect(finding!.recorded[0].cellCount).toBe(2);
    });

    it('flags internal-drift when cells disagree with each other', () => {
      const report = detectDrift(inputs(), [
        cell({ runIndex: 1, generalSha256: 'general-a' }),
        cell({ runIndex: 2, generalSha256: 'general-b' }),
      ]);
      expect(report.findings.find((f) => f.family === 'general')).toMatchObject({ kind: 'internal-drift' });
    });
  });

  describe('feature and staticDoc', () => {
    const withFeature = inputs({
      features: [{ id: 'seven-keys-method', sha256: 'f-a', staticDocSha256: 's-a' }],
    });

    it('flags feature file-drift scoped to that variant', () => {
      const report = detectDrift(
        inputs({ features: [{ id: 'seven-keys-method', sha256: 'f-EDITED', staticDocSha256: null }] }),
        [cell({ variant: 'seven-keys-method', featureSha256: 'f-a' }), cell({ variant: 'base' })],
      );
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0]).toMatchObject({
        family: 'feature',
        identity: 'seven-keys-method',
        source: 'firestore',
        currentSha256: 'f-EDITED',
      });
    });

    it('flags staticDoc drift independently of the feature body', () => {
      const report = detectDrift(
        inputs({ features: [{ id: 'seven-keys-method', sha256: 'f-a', staticDocSha256: 's-EDITED' }] }),
        [cell({ variant: 'seven-keys-method', featureSha256: 'f-a', staticDocSha256: 's-a' })],
      );
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0]).toMatchObject({ family: 'staticDoc', identity: 'seven-keys-method', source: 'firestore' });
    });

    it('ignores base cells, which carry no featureSha256', () => {
      const report = detectDrift(withFeature, [cell({ variant: 'base' })]);
      expect(report.findings.filter((f) => f.family === 'feature' || f.family === 'staticDoc')).toEqual([]);
    });

    it('ignores a feature whose cells predate the staticDoc field', () => {
      const report = detectDrift(withFeature, [cell({ variant: 'seven-keys-method', featureSha256: 'f-a' })]);
      expect(report.findings.filter((f) => f.family === 'staticDoc')).toEqual([]);
    });

    it('ignores cells for variants no longer declared', () => {
      expect(detectDrift(inputs(), [cell({ variant: 'retired-feature', featureSha256: 'f-x' })]).findings).toEqual([]);
    });
  });

  it('reports every mismatch at once rather than stopping at the first', () => {
    const report = detectDrift(
      inputs({
        traders: [{ name: 'context-trader', sha256: 'persona-EDITED' }],
        general: { sha256: 'general-EDITED' },
        features: [{ id: 'seven-keys-method', sha256: 'f-EDITED', staticDocSha256: null }],
      }),
      [cell({ variant: 'seven-keys-method', featureSha256: 'f-a' })],
    );
    expect(report.findings.map((f) => f.family).sort()).toEqual(['feature', 'general', 'persona']);
    expect(hasDrift(report)).toBe(true);
  });

  it('counts affected cells and lists a bounded sample of coordinates', () => {
    const cells = Array.from({ length: 5 }, (_, i) => cell({ runIndex: i + 1, personaSha256: 'persona-old' }));
    const report = detectDrift(inputs(), cells);
    const recorded = report.findings[0].recorded[0];
    expect(recorded.cellCount).toBe(5);
    expect(recorded.sampleCells.length).toBeLessThanOrEqual(3);
    expect(recorded.sampleCells[0]).toBe('context-trader__fable__07012026__base__run1');
  });
});

describe('renderDrift', () => {
  it('names the identity, both hashes and the remedy', () => {
    const report = detectDrift(inputs({ traders: [{ name: 'context-trader', sha256: 'persona-EDITED' }] }), [cell({})]);
    const text = renderDrift(report);
    expect(text).toContain('context-trader');
    expect(text).toContain('persona-EDITED');
    expect(text).toContain('persona-a');
    expect(text).toContain('[firestore]');
    expect(text).toMatch(/create a NEW trader file/i);
  });
});
