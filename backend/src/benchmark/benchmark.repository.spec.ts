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
});
