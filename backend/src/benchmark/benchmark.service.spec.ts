import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
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
import { SevenKeysService } from './seven-keys/seven-keys.service';
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
      { id: 'seven-keys-method', name: 'm', file: 'seven-keys-method.md', block: 'Read ${DOC}.', sha256: 'fsha', staticDoc: 'knowledge-base/methods/seven-keys.md', staticDocContent: 'METHODS', staticDocSha256: 'dsha', artifactSuffix: null },
      { id: 'seven-keys-scorecard', name: 's', file: 'seven-keys-scorecard.md', block: 'Read ${DOC} then ${ARTIFACT}.', sha256: 'scsha', staticDoc: 'knowledge-base/methods/seven-keys.md', staticDocContent: 'METHODS', staticDocSha256: 'dsha', artifactSuffix: '_ES_KEYS.md' },
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
  // No warmCache mock: the pre-batch sync-tier warm was removed (cross-tier
  // cache sharing does not hold — a batch never reads a standard-tier cache
  // entry, so warming before submitting the real batch was pure wasted spend).
  const anthropic = {
    createBatch: jest.fn().mockResolvedValue({ batchId: 'batch_1', processingStatus: 'in_progress' }),
  };
  const marketData = {
    getDay: jest.fn(async (_s: string, _i: string, date: string) => (date === '2026-07-01' ? [{ time: 1 }] : null)),
  };
  const contracts = { get: jest.fn(() => ({ rth: { open: '09:30', close: '16:00' }, timezone: 'America/New_York', pointValue: 5 })) };
  const sevenKeys = {
    ensureKeys: jest.fn().mockResolvedValue({ content: 'KEYS BODY', contentHash: 'ksha' }),
  };
  return { repo, inputs, dayArtifacts, anthropic, marketData, contracts, sevenKeys };
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
      { provide: SevenKeysService, useValue: deps.sevenKeys },
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

  it('runs base + method + scorecard for a candle-backed day and generates KEYS once', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    await svc.run({ runCount: 1, variants: ['base', 'seven-keys-method', 'seven-keys-scorecard'] });
    // KEYS generated once for the only candle-backed day (07012026).
    expect(deps.sevenKeys.ensureKeys).toHaveBeenCalledTimes(1);
    expect(deps.sevenKeys.ensureKeys.mock.calls[0][0].day).toBe('07012026');
    const custIds = deps.anthropic.createBatch.mock.calls[0][0].map((r: any) => r.customId);
    expect(custIds).toEqual(
      expect.arrayContaining([
        'context-trader__fable__07012026__base__run1',
        'context-trader__fable__07012026__seven-keys-method__run1',
        'context-trader__fable__07012026__seven-keys-scorecard__run1',
      ]),
    );
  });

  it('generates KEYS oldest-first and threads artifactSha256 onto the scorecard cell', async () => {
    const deps = makeDeps();
    // Both days have candles + complete coverage so both do scorecard work.
    deps.marketData.getDay = jest.fn().mockResolvedValue([{ time: 1 }]);
    const svc = await build(deps);
    await svc.run({ runCount: 1, variants: ['seven-keys-scorecard'] });
    // collectDays is chronological asc, so ensureKeys is called 07012026 before 07022026.
    expect(deps.sevenKeys.ensureKeys.mock.calls.map((c) => c[0].day)).toEqual(['07012026', '07022026']);
    const saved = deps.repo.saveBatch.mock.calls[0][0];
    const meta = saved.customIdToCell['context-trader__fable__07012026__seven-keys-scorecard__run1'];
    expect(meta.artifactSha256).toBe('ksha');
    expect(meta.featureSha256).toBe('scsha');
  });

  it('skips ONLY the scorecard variant for a day when KEYS generation fails; base still runs', async () => {
    const deps = makeDeps();
    deps.sevenKeys.ensureKeys.mockResolvedValue(null); // verifier/generation failure
    const svc = await build(deps);
    const summary = await svc.run({ runCount: 1, variants: ['base', 'seven-keys-scorecard'] });
    const custIds = deps.anthropic.createBatch.mock.calls[0][0].map((r: any) => r.customId);
    expect(custIds).toContain('context-trader__fable__07012026__base__run1');
    expect(custIds).not.toContain('context-trader__fable__07012026__seven-keys-scorecard__run1');
    expect(summary.daysSkipped).toContainEqual({ day: '07012026', reason: 'keys generation failed' });
  });

  it('skips ONLY the scorecard variant when ensureKeys throws (infra error); base still runs', async () => {
    const deps = makeDeps();
    deps.sevenKeys.ensureKeys.mockRejectedValue(new Error('firestore blip')); // infra throw, not a null return
    const svc = await build(deps);
    const summary = await svc.run({ runCount: 1, variants: ['base', 'seven-keys-scorecard'] });
    const custIds = deps.anthropic.createBatch.mock.calls[0][0].map((r: any) => r.customId);
    expect(custIds).toContain('context-trader__fable__07012026__base__run1');
    expect(custIds).not.toContain('context-trader__fable__07012026__seven-keys-scorecard__run1');
    expect(summary.daysSkipped).toContainEqual({ day: '07012026', reason: 'keys generation failed' });
  });

  it('does NOT call ensureKeys when the scorecard variant is not requested', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    await svc.run({ runCount: 1, variants: ['base'] });
    expect(deps.sevenKeys.ensureKeys).not.toHaveBeenCalled();
  });

  it('forwards regenerateKeys as { force: true } to ensureKeys', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    await svc.run({ runCount: 1, variants: ['seven-keys-scorecard'], regenerateKeys: true });
    expect(deps.sevenKeys.ensureKeys).toHaveBeenCalledWith(expect.objectContaining({ day: '07012026' }), { force: true, pinned: false });
  });

  it('pins the day (pinned:true) when an in-flight scorecard cell exists, even under regenerateKeys + raised runCount', async () => {
    const deps = makeDeps();
    // An in-flight (submitted-but-unreconciled) scorecard batch pinned run1 for the
    // day; a second run with regenerateKeys + a higher runCount makes run2 missing.
    deps.repo.nonTerminalBatches.mockResolvedValue([
      {
        batchId: 'inflight',
        customIdToCell: {
          'context-trader__fable__07012026__seven-keys-scorecard__run1': { date: '2026-07-01', personaSha256: 'p', generalSha256: 'g', artifactSha256: 'ksha' },
        },
      },
    ]);
    const svc = await build(deps);
    await svc.run({ runCount: 2, variants: ['seven-keys-scorecard'], regenerateKeys: true });
    // The day has in-flight scorecard cells -> must be frozen as pinned so force
    // cannot overwrite the KEYS hash those cells already recorded.
    expect(deps.sevenKeys.ensureKeys).toHaveBeenCalledWith(
      expect.objectContaining({ day: '07012026' }),
      expect.objectContaining({ force: true, pinned: true }),
    );
  });

  it('skips all assembly/upload/batch for a fully-complete day (FIX 1)', async () => {
    const deps = makeDeps();
    deps.repo.existingRunIndices.mockResolvedValue([1, 2]);
    const svc = await build(deps);
    const summary = await svc.run({ runCount: 2, variants: ['base'] });
    // No missing cells on any day => no IO, no upload, no batch.
    expect(deps.dayArtifacts.ensurePdf).not.toHaveBeenCalled();
    expect(deps.anthropic.createBatch).not.toHaveBeenCalled();
    expect(summary.cellsQueued).toBe(0);
  });

  it('skips an incomplete-RTH day before assembleDay/ensurePdf (FIX 6 + FIX 1)', async () => {
    const deps = makeDeps();
    (analyzeCoverage as jest.Mock).mockReturnValue({ complete: false });
    const svc = await build(deps);
    const summary = await svc.run({ runCount: 2, variants: ['base'] });
    expect(deps.dayArtifacts.ensurePdf).not.toHaveBeenCalled();
    expect(deps.anthropic.createBatch).not.toHaveBeenCalled();
    expect(summary.daysSkipped).toContainEqual({ day: '07012026', reason: 'incomplete session' });
  });

  it('isolates a per-day error and still processes later days (FIX 2)', async () => {
    const deps = makeDeps();
    // Both days have candles + complete coverage so both have work.
    deps.marketData.getDay = jest.fn().mockResolvedValue([{ time: 1 }]);
    deps.anthropic.createBatch
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ batchId: 'batch_2', processingStatus: 'in_progress' });
    const svc = await build(deps);
    const summary = await svc.run({ runCount: 1, variants: ['base'] });
    // First day's createBatch throws; the second day is still processed.
    expect(deps.anthropic.createBatch).toHaveBeenCalledTimes(2);
    expect(summary.daysSkipped).toContainEqual({ day: '07012026', reason: 'error: boom' });
    expect(summary.batchesSubmitted).toBe(1);
  });

  it('logs an orphaned batch when saveBatch fails after createBatch (FIX 2)', async () => {
    const deps = makeDeps();
    deps.repo.saveBatch.mockRejectedValue(new Error('firestore down'));
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const svc = await build(deps);
    const summary = await svc.run({ runCount: 1, variants: ['base'] });
    // The batch was created at Anthropic but not persisted — must be loud.
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Orphaned batch batch_1'));
    expect(summary.daysSkipped).toContainEqual({ day: '07012026', reason: 'error: firestore down' });
    expect(summary.batchesSubmitted).toBe(0);
    errorSpy.mockRestore();
  });
});
