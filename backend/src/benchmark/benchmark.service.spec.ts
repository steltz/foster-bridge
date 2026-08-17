import { Test } from '@nestjs/testing';
import { BadRequestException, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BenchmarkService } from './benchmark.service';
import { BenchmarkRepository } from './benchmark.repository';
import { CloudInputsService, DayListing, InputsSnapshot } from './cloud-inputs.service';
import { DayArtifactsService } from './day-artifacts.service';
import { EnvelopeBuilder } from './envelope.builder';
import { FakeLlmProvider } from '../llm/fake-llm.provider';
import { LLM_PROVIDER } from '../llm/llm.constants';
import { SETUP_SCHEMA } from './benchmark.types';
import { BenchmarkDriftError } from './benchmark.errors';
import { MarketDataService } from '../market-data/market-data.service';
import { ContractsService } from '../contracts/contracts.service';
import { SevenKeysService } from './seven-keys/seven-keys.service';
import { analyzeCoverage } from '../market-data/coverage';
import { BenchmarkRunLock } from './run-lock';

// Coverage is a pure import, not a provider — mock it so day-completeness is
// controlled per test without hand-building 78-bar candle fixtures.
jest.mock('../market-data/coverage', () => ({ analyzeCoverage: jest.fn() }));

function makeDeps() {
  const repo = {
    existingRunIndices: jest.fn().mockResolvedValue([]),
    nonTerminalBatches: jest.fn().mockResolvedValue([]),
    saveBatch: jest.fn().mockResolvedValue(undefined),
    // No prior cells => nothing for the drift guard to disagree with; the
    // guard's own behavior is covered in drift.spec.ts and below.
    listCellsForDrift: jest.fn().mockResolvedValue([]),
    getSample: jest.fn().mockResolvedValue(null),
  };
  // Snapshot-shaped inputs fake: run() takes ONE snapshot at start and threads
  // it everywhere; per-day bytes come from loadDay(listing).
  const listings: DayListing[] = [
    { day: '07012026', date: '2026-07-01', prefix: '07012026', recapDate: '06302026', fileSha256: { tradePlanMd: 'x1', tradePlanPdf: 'y1', recap: 'z1' } },
    { day: '07022026', date: '2026-07-02', prefix: '07022026', recapDate: '07012026', fileSha256: { tradePlanMd: 'x2', tradePlanPdf: 'y2', recap: 'z2' } },
  ];
  const snapValue: InputsSnapshot = {
    traders: [{ name: 'context-trader', origin: null, mutation: null, content: 'P', sha256: 'psha' }],
    features: [
      { id: 'seven-keys-method', name: 'm', block: 'Read ${DOC}.', sha256: 'fsha', staticDocContent: 'METHODS', staticDocSha256: 'dsha', artifactSuffix: null },
      { id: 'seven-keys-scorecard', name: 's', block: 'Read ${DOC} then ${ARTIFACT}.', sha256: 'scsha', staticDocContent: 'METHODS', staticDocSha256: 'dsha', artifactSuffix: '_ES_KEYS.md' },
    ],
    general: { files: [], concatenated: 'GEN', sha256: 'gsha' },
    methodsDoc: 'METHODS',
    days: listings,
    issues: [],
  };
  const inputs = {
    snapshot: jest.fn(async (): Promise<InputsSnapshot> => snapValue),
    loadDay: jest.fn(async (l: DayListing) => ({
      ...l, pdf: Buffer.from('PDF'), tpTranscript: 'PLAN', recapTranscript: 'RECAP', recapFileName: `${l.recapDate}_ES_RECAP.md`,
    })),
    priorCompleteDays: jest.fn(() => []),
    outcomeRecapForDay: jest.fn(async () => null),
  };
  const ensurePdf = jest.fn().mockResolvedValue({ gcsPath: 'gs', providerFileId: 'file_1', contentHash: 'h' });
  const ensureTranscript = jest.fn().mockResolvedValue(undefined);
  const dayArtifacts = {
    ensurePdf,
    ensureTranscript,
    // Delegates like the real ensureDayRecorded, so `ensurePdf not called` still
    // proves assembleDay never ran for a skipped day.
    ensureDayRecorded: jest.fn(async (day: { day: string; prefix: string; pdf: Buffer; tpTranscript: string; recapTranscript: string; recapFileName: string }) => {
      const pdf = await ensurePdf(day.day, day.prefix, day.pdf);
      await ensureTranscript(day.day, 'tpTranscript', `${day.prefix}_ES_TP.md`, day.tpTranscript);
      await ensureTranscript(day.day, 'recapTranscript', day.recapFileName, day.recapTranscript);
      return pdf;
    }),
  };
  // Provider-neutral fake: proves the benchmark is provider-agnostic — no
  // Anthropic SDK involved. Read back what was submitted via fake.submittedBatches.
  const fake = new FakeLlmProvider();
  const marketData = {
    getDay: jest.fn(async (_s: string, _i: string, date: string) => (date === '2026-07-01' ? [{ time: 1 }] : null)),
  };
  const contracts = { get: jest.fn(() => ({ rth: { open: '09:30', close: '16:00' }, timezone: 'America/New_York', pointValue: 5 })) };
  const sevenKeys = {
    ensureKeys: jest.fn().mockResolvedValue({ content: 'KEYS BODY', contentHash: 'ksha' }),
  };
  return { repo, inputs, snapValue, dayArtifacts, fake, marketData, contracts, sevenKeys };
}

async function build(deps: ReturnType<typeof makeDeps>) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      BenchmarkService,
      EnvelopeBuilder,
      BenchmarkRunLock,
      { provide: BenchmarkRepository, useValue: deps.repo },
      { provide: CloudInputsService, useValue: deps.inputs },
      { provide: DayArtifactsService, useValue: deps.dayArtifacts },
      { provide: LLM_PROVIDER, useValue: deps.fake },
      { provide: MarketDataService, useValue: deps.marketData },
      { provide: ContractsService, useValue: deps.contracts },
      { provide: SevenKeysService, useValue: deps.sevenKeys },
      { provide: ConfigService, useValue: { get: (k: string) => ({ 'benchmark.model': 'claude-fable-5', 'benchmark.defaultRunCount': 5, 'benchmark.maxTokens': 32000, 'benchmark.effort': 'high', 'benchmark.defaultVariants': ['seven-keys-scorecard'] }[k]) } },
    ],
  }).compile();
  return moduleRef.get(BenchmarkService);
}

describe('BenchmarkService.run', () => {
  beforeEach(() => {
    (analyzeCoverage as jest.Mock).mockReturnValue({ complete: true });
  });

  it('submits one batch for the day with candles, skips the day without candles', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    const summary = await svc.run({ runCount: 2, variants: ['base'] });
    expect(deps.fake.submittedBatches).toHaveLength(1);
    const submitted = deps.fake.submittedBatches[0];
    // 1 trader x 1 variant x 2 runs on the one candle-backed day.
    expect(submitted.requests).toHaveLength(2);
    expect(submitted.opts.schema).toBe(SETUP_SCHEMA);
    expect(submitted.opts.model).toBe('claude-fable-5');
    // Fable batch contract: budget + effort routed through the neutral port.
    expect(submitted.opts.maxTokens).toBe(32000);
    expect(submitted.opts.effort).toBe('high');
    expect(summary.batchesSubmitted).toBe(1);
    expect(summary.cellsQueued).toBe(2);
    expect(summary.daysSkipped).toEqual([{ day: '07022026', reason: 'no candles' }]);
    expect(deps.repo.saveBatch).toHaveBeenCalledTimes(1);
    // Provenance is threaded into the batch: base cells carry date + persona/general
    // hashes and OMIT feature/staticDoc hashes.
    const saved = deps.repo.saveBatch.mock.calls[0][0];
    const meta = saved.customIdToCell['context-trader__fable__07012026__base__run1'];
    expect(meta).toEqual({ date: '2026-07-01', personaSha256: 'psha', generalSha256: 'gsha' });
    // pdf.providerFileId propagates through assembleDay's bundle.fileId into the
    // day tier's file block of every submitted request's envelope.
    const blocks = submitted.requests.flatMap((r) => r.envelope?.tiers?.flatMap((t) => t.blocks) ?? []);
    expect(blocks).toContainEqual({ type: 'file', fileId: 'file_1' });
  });

  it('defaults to configured variants (seven-keys-scorecard) when variants are omitted', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    const summary = await svc.run({ runCount: 1 });
    expect(summary.cellsQueued).toBe(1);
    const saved = deps.repo.saveBatch.mock.calls[0][0];
    const keys = Object.keys(saved.customIdToCell);
    expect(keys).toEqual(['context-trader__fable__07012026__seven-keys-scorecard__run1']);
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
    expect(deps.fake.submittedBatches).toHaveLength(0);
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
    const custIds = deps.fake.submittedBatches[0].requests.map((r) => r.customId);
    expect(custIds).toEqual(['context-trader__fable__07012026__base__run1']); // run2 not re-submitted
    expect(summary.cellsQueued).toBe(1);
  });

  it('skips an incomplete-RTH day before batching (FIX 6)', async () => {
    const deps = makeDeps();
    (analyzeCoverage as jest.Mock).mockReturnValue({ complete: false });
    const svc = await build(deps);
    const summary = await svc.run({ runCount: 2, variants: ['base'] });
    expect(deps.fake.submittedBatches).toHaveLength(0);
    expect(summary.daysSkipped).toContainEqual({ day: '07012026', reason: 'incomplete session' });
  });

  it('reports dropped day-folders missing docs (FIX 7)', async () => {
    const deps = makeDeps();
    deps.inputs.snapshot.mockResolvedValueOnce({ ...deps.snapValue, issues: [{ day: '07032026', missing: ['*_ES_RECAP.md'] }] });
    const svc = await build(deps);
    const summary = await svc.run({ runCount: 1, variants: ['base'] });
    expect(summary.daysSkipped).toContainEqual({ day: '07032026', reason: 'missing docs: *_ES_RECAP.md' });
  });

  it('runs base + method + scorecard for a candle-backed day and generates KEYS once', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    await svc.run({ runCount: 1, variants: ['base', 'seven-keys-method', 'seven-keys-scorecard'] });
    // KEYS generated once for the only candle-backed day (07012026), fed the
    // loaded DayInput plus the run's single snapshot (no re-fetch mid-run).
    expect(deps.sevenKeys.ensureKeys).toHaveBeenCalledTimes(1);
    expect(deps.sevenKeys.ensureKeys.mock.calls[0][0].day).toBe('07012026');
    expect(deps.sevenKeys.ensureKeys.mock.calls[0][1]).toBe(deps.snapValue);
    expect(deps.inputs.snapshot).toHaveBeenCalledTimes(1);
    const custIds = deps.fake.submittedBatches[0].requests.map((r) => r.customId);
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
    const custIds = deps.fake.submittedBatches[0].requests.map((r) => r.customId);
    expect(custIds).toContain('context-trader__fable__07012026__base__run1');
    expect(custIds).not.toContain('context-trader__fable__07012026__seven-keys-scorecard__run1');
    expect(summary.daysSkipped).toContainEqual({ day: '07012026', reason: 'keys generation failed' });
  });

  it('skips ONLY the scorecard variant when ensureKeys throws (infra error); base still runs', async () => {
    const deps = makeDeps();
    deps.sevenKeys.ensureKeys.mockRejectedValue(new Error('firestore blip')); // infra throw, not a null return
    const svc = await build(deps);
    const summary = await svc.run({ runCount: 1, variants: ['base', 'seven-keys-scorecard'] });
    const custIds = deps.fake.submittedBatches[0].requests.map((r) => r.customId);
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
    expect(deps.sevenKeys.ensureKeys).toHaveBeenCalledWith(expect.objectContaining({ day: '07012026' }), deps.snapValue, { force: true, pinned: false });
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
      deps.snapValue,
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
    expect(deps.fake.submittedBatches).toHaveLength(0);
    expect(summary.cellsQueued).toBe(0);
  });

  it('skips an incomplete-RTH day before assembleDay/ensurePdf (FIX 6 + FIX 1)', async () => {
    const deps = makeDeps();
    (analyzeCoverage as jest.Mock).mockReturnValue({ complete: false });
    const svc = await build(deps);
    const summary = await svc.run({ runCount: 2, variants: ['base'] });
    expect(deps.dayArtifacts.ensurePdf).not.toHaveBeenCalled();
    expect(deps.fake.submittedBatches).toHaveLength(0);
    expect(summary.daysSkipped).toContainEqual({ day: '07012026', reason: 'incomplete session' });
  });

  it('isolates a per-day error and still processes later days (FIX 2)', async () => {
    const deps = makeDeps();
    // Both days have candles + complete coverage so both have work.
    deps.marketData.getDay = jest.fn().mockResolvedValue([{ time: 1 }]);
    const submitSpy = jest
      .spyOn(deps.fake, 'submitBatch')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ batchId: 'batch_2', status: 'submitted' });
    const svc = await build(deps);
    const summary = await svc.run({ runCount: 1, variants: ['base'] });
    // First day's submitBatch throws; the second day is still processed.
    expect(submitSpy).toHaveBeenCalledTimes(2);
    expect(summary.daysSkipped).toContainEqual({ day: '07012026', reason: 'error: boom' });
    expect(summary.batchesSubmitted).toBe(1);
  });

  it('logs an orphaned batch when saveBatch fails after submitBatch (FIX 2)', async () => {
    const deps = makeDeps();
    deps.repo.saveBatch.mockRejectedValue(new Error('firestore down'));
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const svc = await build(deps);
    const summary = await svc.run({ runCount: 1, variants: ['base'] });
    // The batch was created at the provider but not persisted — must be loud.
    // FakeLlmProvider mints the first batch id as `fake-batch-1`.
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Orphaned batch fake-batch-1'));
    expect(summary.daysSkipped).toContainEqual({ day: '07012026', reason: 'error: firestore down' });
    expect(summary.batchesSubmitted).toBe(0);
    errorSpy.mockRestore();
  });

  it('throws a clear error when the provider lacks a required capability', async () => {
    const deps = makeDeps();
    deps.fake.capabilities = { batch: false, fileUpload: true, promptCaching: true, structuredOutput: true };
    const svc = await build(deps);
    await expect(svc.run({})).rejects.toThrow(/lacks required capabilities: batch/);
  });

  it('refuses to run with zero traders', async () => {
    const deps = makeDeps();
    deps.inputs.snapshot.mockResolvedValueOnce({ ...deps.snapValue, traders: [] });
    const svc = await build(deps);
    await expect(svc.run({})).rejects.toThrow(/no traders/i);
    expect(deps.fake.submittedBatches).toHaveLength(0);
  });

  it('refuses to run with zero features', async () => {
    const deps = makeDeps();
    deps.inputs.snapshot.mockResolvedValueOnce({ ...deps.snapValue, features: [] });
    const svc = await build(deps);
    await expect(svc.run({})).rejects.toThrow(/no features/i);
    expect(deps.fake.submittedBatches).toHaveLength(0);
  });

  it('a second concurrent run gets 409', async () => {
    const deps = makeDeps();
    let release!: () => void;
    deps.inputs.snapshot.mockImplementationOnce(
      () => new Promise((r) => { release = () => r(deps.snapValue); }),
    );
    const svc = await build(deps);
    const first = svc.run({});
    await expect(svc.run({})).rejects.toThrow(/already in progress/i);
    release();
    await first;
    // The flag clears in finally — a fresh run is admitted again.
    await expect(svc.run({ runCount: 1, variants: ['base'] })).resolves.toBeDefined();
  });

  it('run({ sample }) restricts days to the persisted sample and reports snapshot-missing days', async () => {
    const deps = makeDeps();
    // 07012026 exists in the snapshot; 12252099 does not.
    deps.repo.getSample.mockResolvedValue({ name: 's1', days: ['07012026', '12252099'], requestedCount: 2, poolSize: 2, from: null, to: null, createdAt: 't' });
    const svc = await build(deps);
    const summary = await svc.run({ runCount: 1, sample: 's1' });
    expect(deps.repo.getSample).toHaveBeenCalledWith('s1');
    expect(summary.cellsQueued).toBe(1);
    const saved = deps.repo.saveBatch.mock.calls[0][0];
    expect(Object.keys(saved.customIdToCell)).toEqual(['context-trader__fable__07012026__seven-keys-scorecard__run1']);
    // The missing sampled day is surfaced, and the other listing day (07022026)
    // is NOT reported skipped-for-candles — the sample filtered it out.
    expect(summary.daysSkipped).toEqual([{ day: '12252099', reason: 'sample day not in snapshot' }]);
  });

  it('run rejects sample together with days, before taking the lock or reading inputs', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    await expect(svc.run({ sample: 's1', days: ['07012026'] })).rejects.toBeInstanceOf(BadRequestException);
    expect(deps.inputs.snapshot).not.toHaveBeenCalled();
    // The failed request must not have latched the single-flight lock.
    deps.repo.getSample.mockResolvedValue({ name: 's1', days: ['07012026'], requestedCount: 1, poolSize: 1, from: null, to: null, createdAt: 't' });
    await expect(svc.run({ runCount: 1, sample: 's1' })).resolves.toBeDefined();
  });

  it('run 404s on an unknown sample without reading inputs', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    await expect(svc.run({ sample: 'nope' })).rejects.toBeInstanceOf(NotFoundException);
    expect(deps.inputs.snapshot).not.toHaveBeenCalled();
  });

  it('run 400s an invalid sample name before it can reach a Firestore doc id', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    await expect(svc.run({ sample: 'a/b' })).rejects.toBeInstanceOf(BadRequestException);
    expect(deps.repo.getSample).not.toHaveBeenCalled();
  });

  it('run 422s on a sample whose days are empty instead of falling through to a full run', async () => {
    const deps = makeDeps();
    deps.repo.getSample.mockResolvedValue({ name: 's1', days: [], requestedCount: 0, poolSize: 0, from: null, to: null, createdAt: 't' });
    const svc = await build(deps);
    await expect(svc.run({ sample: 's1' })).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(deps.fake.submittedBatches).toHaveLength(0);
  });

  describe('content-drift guard', () => {
    // makeDeps' trader hashes to 'psha'; a cell recording anything else means
    // the persona file was edited after that cell was benchmarked.
    const editedPersonaCell = {
      trader: 'context-trader', modelAlias: 'fable', day: '07012026', variant: 'base', runIndex: 1,
      personaSha256: 'psha-BEFORE-EDIT', generalSha256: 'gsha',
    };

    it('aborts the run when a benchmarked persona file has changed', async () => {
      const deps = makeDeps();
      deps.repo.listCellsForDrift.mockResolvedValue([editedPersonaCell]);
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const svc = await build(deps);
      await expect(svc.run({ runCount: 1, variants: ['base'] })).rejects.toBeInstanceOf(BenchmarkDriftError);
      jest.restoreAllMocks();
    });

    it('submits nothing and uploads nothing when it aborts', async () => {
      const deps = makeDeps();
      deps.repo.listCellsForDrift.mockResolvedValue([editedPersonaCell]);
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const svc = await build(deps);
      await expect(svc.run({ runCount: 1, variants: ['base'] })).rejects.toThrow();
      // The whole point of guarding before the day loop: nothing was touched.
      expect(deps.fake.submittedBatches).toHaveLength(0);
      expect(deps.repo.saveBatch).not.toHaveBeenCalled();
      expect(deps.dayArtifacts.ensurePdf).not.toHaveBeenCalled();
      jest.restoreAllMocks();
    });

    it('names the trader, both hashes and the remedy in the error', async () => {
      const deps = makeDeps();
      deps.repo.listCellsForDrift.mockResolvedValue([editedPersonaCell]);
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const svc = await build(deps);
      const err: BenchmarkDriftError = await svc
        .run({ runCount: 1, variants: ['base'] })
        .then(() => { throw new Error('expected the drift guard to abort the run'); })
        .catch((e) => e);
      expect(err.message).toContain('context-trader');
      expect(err.message).toContain('psha-BEFORE-EDIT');
      expect(err.message).toContain('psha');
      expect(err.report.findings[0]).toMatchObject({ family: 'persona', kind: 'file-drift' });
      jest.restoreAllMocks();
    });

    it('proceeds normally when existing cells agree with the current files', async () => {
      const deps = makeDeps();
      deps.repo.listCellsForDrift.mockResolvedValue([{ ...editedPersonaCell, personaSha256: 'psha', generalSha256: 'gsha' }]);
      const svc = await build(deps);
      const summary = await svc.run({ runCount: 1, variants: ['base'] });
      expect(summary.batchesSubmitted).toBeGreaterThan(0);
    });
  });

  describe('checkDrift', () => {
    it('reports drift without submitting anything', async () => {
      const deps = makeDeps();
      deps.repo.listCellsForDrift.mockResolvedValue([
        { trader: 'context-trader', modelAlias: 'fable', day: '07012026', variant: 'base', runIndex: 1,
          personaSha256: 'psha-BEFORE-EDIT', generalSha256: 'gsha' },
      ]);
      const svc = await build(deps);
      const report = await svc.checkDrift();
      expect(report.findings).toHaveLength(1);
      expect(report.cellsExamined).toBe(1);
      expect(deps.fake.submittedBatches).toHaveLength(0);
    });

    it('returns an empty report for a clean tree', async () => {
      const deps = makeDeps();
      const svc = await build(deps);
      expect((await svc.checkDrift()).findings).toEqual([]);
    });
  });
});
