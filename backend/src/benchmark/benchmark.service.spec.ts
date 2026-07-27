import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { BenchmarkService } from './benchmark.service';
import { BenchmarkRepository } from './benchmark.repository';
import { RepoInputsService } from './repo-inputs.service';
import { DayArtifactsService } from './day-artifacts.service';
import { EnvelopeBuilder } from './envelope.builder';
import { AnthropicService } from '../anthropic/anthropic.service';
import { MarketDataService } from '../market-data/market-data.service';
import { ContractsService } from '../contracts/contracts.service';
import { analyzeCoverage } from '../market-data/coverage';

jest.mock('node:fs', () => ({ ...jest.requireActual('node:fs'), readFileSync: jest.fn() }));
// Coverage is a pure import, not a provider — mock it so day-completeness is
// controlled per test without hand-building 78-bar candle fixtures.
jest.mock('../market-data/coverage', () => ({ analyzeCoverage: jest.fn() }));

function makeDeps() {
  const repo = {
    existingRunIndices: jest.fn().mockResolvedValue([]),
    nonTerminalBatches: jest.fn().mockResolvedValue([]),
    saveBatch: jest.fn().mockResolvedValue(undefined),
  };
  const inputs = {
    collectTraders: jest.fn().mockReturnValue([{ name: 'context-trader', origin: null, mutation: null, file: 'context-trader.md', content: 'P', sha256: 'psha' }]),
    collectFeatures: jest.fn().mockReturnValue([
      { id: 'seven-keys-method', name: 'm', file: 'seven-keys-method.md', block: 'Read ${DOC}.', sha256: 'fsha', staticDoc: 'knowledge-base/methods/seven-keys.md', staticDocContent: 'METHODS', staticDocSha256: 'dsha' },
    ]),
    collectGeneralDocs: jest.fn().mockReturnValue({ files: [], concatenated: 'GEN', sha256: 'gsha' }),
    collectDays: jest.fn().mockReturnValue([
      { day: '07012026', date: '2026-07-01', prefix: '07012026', pdfPath: '/x/07012026_ES_TP.pdf', planPath: '/x/07012026_ES_TP.md', recapPath: '/x/06302026_ES_RECAP.md' },
      { day: '07022026', date: '2026-07-02', prefix: '07022026', pdfPath: '/y/07022026_ES_TP.pdf', planPath: '/y/07022026_ES_TP.md', recapPath: '/y/07012026_ES_RECAP.md' },
    ]),
    collectDayIssues: jest.fn().mockReturnValue([]),
  };
  const dayArtifacts = {
    ensurePdf: jest.fn().mockResolvedValue({ gcsPath: 'gs', anthropicFileId: 'file_1', contentHash: 'h' }),
    ensureTranscript: jest.fn().mockResolvedValue(undefined),
  };
  const anthropic = {
    warmCache: jest.fn().mockResolvedValue({ cached: true }),
    createBatch: jest.fn().mockResolvedValue({ batchId: 'batch_1', processingStatus: 'in_progress' }),
  };
  const marketData = {
    getDay: jest.fn(async (_s: string, _i: string, date: string) => (date === '2026-07-01' ? [{ time: 1 }] : null)),
  };
  const contracts = { get: jest.fn(() => ({ rth: { open: '09:30', close: '16:00' }, timezone: 'America/New_York', pointValue: 5 })) };
  return { repo, inputs, dayArtifacts, anthropic, marketData, contracts };
}

async function build(deps: ReturnType<typeof makeDeps>) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      BenchmarkService,
      EnvelopeBuilder,
      { provide: BenchmarkRepository, useValue: deps.repo },
      { provide: RepoInputsService, useValue: deps.inputs },
      { provide: DayArtifactsService, useValue: deps.dayArtifacts },
      { provide: AnthropicService, useValue: deps.anthropic },
      { provide: MarketDataService, useValue: deps.marketData },
      { provide: ContractsService, useValue: deps.contracts },
      { provide: ConfigService, useValue: { get: (k: string) => ({ 'benchmark.model': 'claude-fable-5', 'benchmark.defaultRunCount': 5, 'benchmark.maxTokens': 32000, 'benchmark.effort': 'high' }[k]) } },
    ],
  }).compile();
  return moduleRef.get(BenchmarkService);
}

describe('BenchmarkService.run', () => {
  beforeEach(() => {
    (readFileSync as jest.Mock).mockReturnValue(Buffer.from('BYTES'));
    (analyzeCoverage as jest.Mock).mockReturnValue({ complete: true });
  });

  it('submits one batch for the day with candles, skips the day without candles', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    const summary = await svc.run({ runCount: 2, variants: ['base'] });
    expect(deps.anthropic.createBatch).toHaveBeenCalledTimes(1);
    // 1 trader x 1 variant x 2 runs on the one candle-backed day.
    const call = deps.anthropic.createBatch.mock.calls[0];
    expect(call[0]).toHaveLength(2);
    expect(call[2].outputSchema).toBeDefined();
    expect(call[2].model).toBe('claude-fable-5');
    // Fable batch contract: budget, effort, and beta (files) path.
    expect(call[2].maxTokens).toBe(32000);
    expect(call[2].effort).toBe('high');
    expect(call[2].files).toBe(true);
    // Warms run on the beta/files path with matching effort.
    expect(deps.anthropic.warmCache.mock.calls[0][1]).toEqual({ model: 'claude-fable-5', files: true, effort: 'high' });
    expect(summary.batchesSubmitted).toBe(1);
    expect(summary.cellsQueued).toBe(2);
    expect(summary.daysSkipped).toEqual([{ day: '07022026', reason: 'no candles' }]);
    expect(deps.repo.saveBatch).toHaveBeenCalledTimes(1);
    // Provenance is threaded into the batch: base cells carry date + persona/general
    // hashes and OMIT feature/staticDoc hashes.
    const saved = deps.repo.saveBatch.mock.calls[0][0];
    const meta = saved.customIdToCell['context-trader__fable__07012026__base__run1'];
    expect(meta).toEqual({ date: '2026-07-01', personaSha256: 'psha', generalSha256: 'gsha' });
  });

  it('threads feature + staticDoc hashes for the seven-keys-method variant', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    await svc.run({ runCount: 1, variants: ['seven-keys-method'] });
    const saved = deps.repo.saveBatch.mock.calls[0][0];
    const meta = saved.customIdToCell['context-trader__fable__07012026__seven-keys-method__run1'];
    expect(meta).toEqual({ date: '2026-07-01', personaSha256: 'psha', generalSha256: 'gsha', featureSha256: 'fsha', staticDocSha256: 'dsha' });
  });

  it('honours the top-up diff: no missing indices -> no batch', async () => {
    const deps = makeDeps();
    deps.repo.existingRunIndices.mockResolvedValue([1, 2]);
    const svc = await build(deps);
    const summary = await svc.run({ runCount: 2, variants: ['base'] });
    expect(deps.anthropic.createBatch).not.toHaveBeenCalled();
    expect(summary.cellsQueued).toBe(0);
  });

  it('excludes run-indices already queued in an in-flight batch (FIX 4)', async () => {
    const deps = makeDeps();
    // run2 for (context-trader, fable, 07012026, base) is queued but not yet a cell.
    deps.repo.nonTerminalBatches.mockResolvedValue([
      { batchId: 'inflight', customIdToCell: { 'context-trader__fable__07012026__base__run2': { date: '2026-07-01', personaSha256: 'p', generalSha256: 'g' } } },
    ]);
    const svc = await build(deps);
    const summary = await svc.run({ runCount: 2, variants: ['base'] });
    const custIds = deps.anthropic.createBatch.mock.calls[0][0].map((r: any) => r.customId);
    expect(custIds).toEqual(['context-trader__fable__07012026__base__run1']); // run2 not re-submitted
    expect(summary.cellsQueued).toBe(1);
  });

  it('skips an incomplete-RTH day before batching (FIX 6)', async () => {
    const deps = makeDeps();
    (analyzeCoverage as jest.Mock).mockReturnValue({ complete: false });
    const svc = await build(deps);
    const summary = await svc.run({ runCount: 2, variants: ['base'] });
    expect(deps.anthropic.createBatch).not.toHaveBeenCalled();
    expect(summary.daysSkipped).toContainEqual({ day: '07012026', reason: 'incomplete session' });
  });

  it('reports dropped day-folders missing docs (FIX 7)', async () => {
    const deps = makeDeps();
    deps.inputs.collectDayIssues.mockReturnValue([{ day: '07032026', missing: ['*_ES_RECAP.md'] }]);
    const svc = await build(deps);
    const summary = await svc.run({ runCount: 1, variants: ['base'] });
    expect(summary.daysSkipped).toContainEqual({ day: '07032026', reason: 'missing docs: *_ES_RECAP.md' });
  });

  it('restricts variants to the core set and warms both day-bundle and per-envelope', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    await svc.run({ runCount: 1, variants: ['base', 'seven-keys-method', 'seven-keys-scorecard'] });
    // per (trader,variant): base + seven-keys-method = 2 full-envelope warms + 1 day-bundle warm.
    expect(deps.anthropic.warmCache).toHaveBeenCalledTimes(3);
    const custIds = deps.anthropic.createBatch.mock.calls[0][0].map((r: any) => r.customId);
    expect(custIds).toEqual(
      expect.arrayContaining([
        'context-trader__fable__07012026__base__run1',
        'context-trader__fable__07012026__seven-keys-method__run1',
      ]),
    );
  });
});
