import { Test } from '@nestjs/testing';
import { BenchmarkRepository } from './benchmark.repository';
import { FIRESTORE } from '../firebase/firebase.constants';
import { fakeFirestore } from '../../test/fake-firestore';
import { BenchmarkCell, cellKey } from './benchmark.types';

function cell(overrides: Partial<BenchmarkCell> = {}): BenchmarkCell {
  return {
    trader: 'context-trader',
    model: { alias: 'fable', id: 'claude-fable-5' },
    modelAlias: 'fable',
    day: '07012026',
    date: '2026-07-01',
    variant: 'base',
    runIndex: 1,
    personaSha256: 'p',
    generalSha256: 'g',
    result: { status: 'TP', points: 10, dollars: 50 },
    createdAt: '2026-07-26T00:00:00.000Z',
    ...overrides,
  };
}

async function build() {
  const db = fakeFirestore();
  const moduleRef = await Test.createTestingModule({
    providers: [BenchmarkRepository, { provide: FIRESTORE, useValue: db }],
  }).compile();
  return { repo: moduleRef.get(BenchmarkRepository), db };
}

describe('BenchmarkRepository', () => {
  it('createCell is write-once and swallows AlreadyExists', async () => {
    const { repo } = await build();
    await repo.createCell(cell());
    await expect(repo.createCell(cell({ result: { status: 'SL' } }))).resolves.toBeUndefined();
    const cells = await repo.listCells('fable');
    expect(cells).toHaveLength(1);
    expect(cells[0].result.status).toBe('TP'); // first write wins
  });

  it('existingRunIndices returns the present indices for a (trader, model, day, variant)', async () => {
    const { repo } = await build();
    await repo.createCell(cell({ runIndex: 1 }));
    await repo.createCell(cell({ runIndex: 3 }));
    await repo.createCell(cell({ trader: 'other', runIndex: 2 }));
    await repo.createCell(cell({ variant: 'seven-keys-method', runIndex: 5 }));
    const idx = await repo.existingRunIndices('context-trader', 'fable', '07012026', 'base');
    expect(idx.sort()).toEqual([1, 3]);
  });

  it('listCells filters by model alias', async () => {
    const { repo } = await build();
    await repo.createCell(cell());
    await repo.createCell(cell({ model: { alias: 'opus', id: 'claude-opus-4-8' }, modelAlias: 'opus', runIndex: 2 }));
    expect(await repo.listCells('fable')).toHaveLength(1);
    expect(await repo.listCells('opus')).toHaveLength(1);
  });

  it('saveBatch / nonTerminalBatches / updateBatch drive the lifecycle', async () => {
    const { repo } = await build();
    await repo.saveBatch({
      batchId: 'batch_1', day: '07012026', date: '2026-07-01', pdfPrefix: '07012026',
      model: { alias: 'fable', id: 'claude-fable-5' }, status: 'submitted',
      customIdToCell: {
        [cellKey({ trader: 'context-trader', modelAlias: 'fable', day: '07012026', variant: 'base', runIndex: 1 })]:
          { date: '2026-07-01', personaSha256: 'p', generalSha256: 'g' },
      },
      submittedAt: '2026-07-26T00:00:00.000Z',
    });
    await repo.saveBatch({
      batchId: 'batch_done', day: '07012026', date: '2026-07-01', pdfPrefix: '07012026',
      model: { alias: 'fable', id: 'claude-fable-5' }, status: 'reconciled',
      customIdToCell: {}, submittedAt: '2026-07-26T00:00:00.000Z',
    });
    const open = await repo.nonTerminalBatches();
    expect(open.map((b) => b.batchId)).toEqual(['batch_1']);
    await repo.updateBatch('batch_1', { status: 'reconciled', endedAt: '2026-07-26T01:00:00.000Z' });
    expect(await repo.nonTerminalBatches()).toHaveLength(0);
  });

  it('updateBatch rejects when the batch does not exist', async () => {
    const { repo } = await build();
    await expect(repo.updateBatch('does-not-exist', { status: 'reconciled' })).rejects.toMatchObject({ code: 5 });
  });

  it('createCell re-throws errors that are not ALREADY_EXISTS (code 6)', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        BenchmarkRepository,
        {
          provide: FIRESTORE,
          useValue: {
            collection: () => ({
              doc: () => ({
                create: () => Promise.reject(Object.assign(new Error('boom'), { code: 5 })),
              }),
            }),
          },
        },
      ],
    }).compile();
    const repo = moduleRef.get(BenchmarkRepository);
    await expect(repo.createCell(cell())).rejects.toMatchObject({ code: 5 });
  });

  it('day artifacts and scoreboard round-trip', async () => {
    const { repo } = await build();
    expect(await repo.getDayArtifact('07012026', 'pdfFile')).toBeNull();
    await repo.saveDayArtifact('07012026', 'pdfFile', { contentHash: 'h', gcsPath: 'gs://x', anthropicFileId: 'file_1', uploadedAt: 't' });
    expect((await repo.getDayArtifact('07012026', 'pdfFile'))?.anthropicFileId).toBe('file_1');

    expect(await repo.getScoreboard('fable')).toBeNull();
    await repo.saveScoreboard('fable', { json: { groups: [] }, markdown: '# x', generatedAt: 't' });
    expect((await repo.getScoreboard('fable'))?.markdown).toBe('# x');
  });

  it('round-trips a keys DayArtifactDoc with inline content + provenance', async () => {
    const { repo } = await build();
    await repo.saveDayArtifact('07012026', 'keys', {
      contentHash: 'kh',
      gcsPath: 'benchmark/es/07012026/07012026_ES_KEYS.md',
      content: '---\nverified: true\n---\n\n# Seven Keys',
      uploadedAt: 't',
      generatedBy: 'claude-fable-5',
      generatedAt: 't',
      lookbackSources: ['06302026_ES_KEYS.md'],
      verified: true,
    });
    const got = await repo.getDayArtifact('07012026', 'keys');
    expect(got?.content).toContain('# Seven Keys');
    expect(got?.generatedBy).toBe('claude-fable-5');
    expect(got?.lookbackSources).toEqual(['06302026_ES_KEYS.md']);
    expect(got?.verified).toBe(true);
  });

  it('pinnedKeysHashes collects artifactSha256 from the day\'s scorecard cells only', async () => {
    const { repo } = await build();
    expect((await repo.pinnedKeysHashes('07012026')).size).toBe(0);
    await repo.createCell({
      trader: 'context-trader', modelAlias: 'fable', day: '07012026',
      variant: 'seven-keys-scorecard', runIndex: 1, result: { status: 'SL' }, artifactSha256: 'kh-fable',
    } as any);
    await repo.createCell({
      trader: 'context-trader', modelAlias: 'k3', day: '07012026',
      variant: 'seven-keys-scorecard', runIndex: 1, result: { status: 'TP' }, artifactSha256: 'kh-k3',
    } as any);
    // base cells carry no artifactSha256 and other days must not leak in
    await repo.createCell({
      trader: 'context-trader', modelAlias: 'fable', day: '07012026',
      variant: 'base', runIndex: 1, result: { status: 'TP' },
    } as any);
    await repo.createCell({
      trader: 'context-trader', modelAlias: 'fable', day: '07022026',
      variant: 'seven-keys-scorecard', runIndex: 1, result: { status: 'TP' }, artifactSha256: 'kh-other-day',
    } as any);
    const pinned = await repo.pinnedKeysHashes('07012026');
    expect([...pinned].sort()).toEqual(['kh-fable', 'kh-k3']);
  });

  describe('keys lineages (per-flagship artifacts)', () => {
    const doc = (o: Record<string, unknown> = {}) => ({
      contentHash: 'kh', gcsPath: 'p', content: '# k', uploadedAt: 't', verified: true, ...o,
    }) as any;

    it('round-trips a scoped keys artifact and isolates lineages', async () => {
      const { repo } = await build();
      expect(await repo.getKeysArtifact('07012026', 'k3')).toBeNull();
      await repo.saveKeysArtifact('07012026', 'k3', doc({ generatedBy: 'kimi-k3' }));
      expect((await repo.getKeysArtifact('07012026', 'k3'))?.generatedBy).toBe('kimi-k3');
      // another lineage on the same day sees nothing
      expect(await repo.getKeysArtifact('07012026', 'fable')).toBeNull();
    });

    it('falls back to the legacy unscoped doc only when generatedBy resolves to the same alias', async () => {
      const { repo } = await build();
      await repo.saveDayArtifact('07012026', 'keys', doc({ generatedBy: 'claude-fable-5' }));
      expect((await repo.getKeysArtifact('07012026', 'fable'))?.generatedBy).toBe('claude-fable-5');
      expect(await repo.getKeysArtifact('07012026', 'k3')).toBeNull(); // foreign lineage ignores it
    });

    it('treats a legacy doc with no generatedBy as Anthropic-era Fable', async () => {
      const { repo } = await build();
      await repo.saveDayArtifact('07012026', 'keys', doc());
      expect(await repo.getKeysArtifact('07012026', 'fable')).not.toBeNull();
      expect(await repo.getKeysArtifact('07012026', 'k3')).toBeNull();
    });

    it('prefers the scoped doc over the legacy doc for the same alias', async () => {
      const { repo } = await build();
      await repo.saveDayArtifact('07012026', 'keys', doc({ content: '# legacy', generatedBy: 'claude-fable-5' }));
      await repo.saveKeysArtifact('07012026', 'fable', doc({ content: '# scoped', generatedBy: 'claude-fable-5' }));
      expect((await repo.getKeysArtifact('07012026', 'fable'))?.content).toBe('# scoped');
    });
  });
});
