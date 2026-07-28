import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BatchReconciler } from './batch-reconciler';
import { BenchmarkRepository } from './benchmark.repository';
import { LLM_PROVIDER } from '../llm/llm.constants';
import { FakeLlmProvider } from '../llm/fake-llm.provider';
import { BacktestService } from '../execution/backtest.service';
import { ScoreboardService } from './scoreboard.service';
import { cellKey } from './benchmark.types';

const KEY = cellKey({ trader: 'context-trader', modelAlias: 'fable', day: '07012026', variant: 'base', runIndex: 1 });
const REFUSAL_KEY = cellKey({ trader: 'context-trader', modelAlias: 'fable', day: '07012026', variant: 'base', runIndex: 2 });
const META = { date: '2026-07-01', personaSha256: 'psha', generalSha256: 'gsha' };

function baseBatch(overrides = {}) {
  return {
    batchId: 'batch_1', day: '07012026', date: '2026-07-01', pdfPrefix: '07012026',
    model: { alias: 'fable', id: 'claude-fable-5' }, status: 'submitted',
    customIdToCell: { [KEY]: META, [REFUSAL_KEY]: META }, submittedAt: 't',
    ...overrides,
  };
}

function makeDeps() {
  const created: any[] = [];
  const repo = {
    nonTerminalBatches: jest.fn().mockResolvedValue([baseBatch()]),
    updateBatch: jest.fn().mockResolvedValue(undefined),
    createCell: jest.fn(async (c: any) => {
      created.push(c);
    }),
  };
  const llm = new FakeLlmProvider();
  llm.batchStatus = 'ended';
  llm.batchResults = [
    { customId: KEY, type: 'succeeded', text: JSON.stringify({ side: 'long', entry: 100, stopLoss: 95, takeProfit: 110, rationale: 'r', primaryZone: 'z', confidence: 3 }) },
    { customId: REFUSAL_KEY, type: 'refusal' },
  ];
  const backtest = {
    run: jest.fn().mockResolvedValue({
      results: [{ status: 'TP', points: 10, dollars: 50, fillTime: 1, exitTime: 2, maxAdverseExcursion: 1, maxFavorableExcursion: 2, rMultiple: 2, closestApproach: null }],
    }),
  };
  const scoreboard = { generate: jest.fn().mockResolvedValue({ markdown: '#', json: {}, generatedAt: 't' }) };
  return { repo, llm, backtest, scoreboard, created };
}

async function build(deps: ReturnType<typeof makeDeps>, schedulerEnabled = true) {
  const config = { get: (k: string) => (k === 'benchmark.schedulerEnabled' ? schedulerEnabled : undefined) };
  const moduleRef = await Test.createTestingModule({
    providers: [
      BatchReconciler,
      { provide: BenchmarkRepository, useValue: deps.repo },
      { provide: LLM_PROVIDER, useValue: deps.llm },
      { provide: BacktestService, useValue: deps.backtest },
      { provide: ScoreboardService, useValue: deps.scoreboard },
      { provide: ConfigService, useValue: config },
      { provide: EventEmitter2, useValue: { emit: jest.fn() } as any },
    ],
  }).compile();
  return moduleRef.get(BatchReconciler);
}

describe('BatchReconciler.reconcile', () => {
  it('backtests a succeeded setup and writes a scored cell; reads the batch through the neutral port', async () => {
    const deps = makeDeps();
    const getBatchSpy = jest.spyOn(deps.llm, 'getBatch');
    const getBatchResultsSpy = jest.spyOn(deps.llm, 'getBatchResults');
    const rec = await build(deps);
    await rec.reconcile();
    const cell = deps.created.find((c) => c.runIndex === 1);
    expect(cell.result.status).toBe('TP');
    expect(cell.result.dollars).toBe(50);
    expect(cell.setup.side).toBe('long');
    // Provenance threaded from the batch CellMeta (design §4): real hashes + date.
    expect(cell.personaSha256).toBe('psha');
    expect(cell.generalSha256).toBe('gsha');
    expect(cell.date).toBe('2026-07-01');
    // Reads go through the neutral LlmProvider port, not a legacy method.
    expect(getBatchSpy).toHaveBeenCalledWith('batch_1');
    expect(getBatchResultsSpy).toHaveBeenCalledWith('batch_1');
    expect(deps.backtest.run).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'MES', interval: 'min-5', date: '2026-07-01', session: 'rth', allowIncomplete: false,
      orders: [{ side: 'long', entry: 100, stopLoss: 95, takeProfit: 110 }],
    }));
  });

  it('maps a refusal to a NO_SETUP cell (no fallback)', async () => {
    const deps = makeDeps();
    const rec = await build(deps);
    await rec.reconcile();
    const cell = deps.created.find((c) => c.runIndex === 2);
    expect(cell.result.status).toBe('NO_SETUP');
    expect(cell.setup).toBeUndefined();
  });

  it('marks the batch reconciled and regenerates the scoreboard for the model alias (FIX 3)', async () => {
    const deps = makeDeps();
    const rec = await build(deps);
    await rec.reconcile();
    expect(deps.repo.updateBatch).toHaveBeenCalledWith('batch_1', expect.objectContaining({ status: 'reconciled' }));
    expect(deps.scoreboard.generate).toHaveBeenCalledWith('fable');
  });

  it('maps order-geometry BadRequest to INVALID (FIX 5)', async () => {
    const deps = makeDeps();
    deps.backtest.run.mockRejectedValue(new BadRequestException('long requires stopLoss < entry < takeProfit'));
    const rec = await build(deps);
    await expect(rec.reconcile()).resolves.toBeUndefined();
    const cell = deps.created.find((c) => c.runIndex === 1);
    expect(cell.result.status).toBe('INVALID');
    expect(cell.note).toContain('requires stopLoss');
  });

  it('maps a 404 (no candles) / 422 (incomplete) to CLI_ERROR (FIX 5)', async () => {
    const deps = makeDeps();
    deps.backtest.run.mockRejectedValue(new NotFoundException('no candles'));
    const rec = await build(deps);
    await rec.reconcile();
    const cell = deps.created.find((c) => c.runIndex === 1);
    expect(cell.result.status).toBe('CLI_ERROR');
    expect(cell.note).toContain('no candles');
  });

  it('rejects an out-of-range confidence as INVALID (FIX 5 validation)', async () => {
    const deps = makeDeps();
    deps.llm.batchResults = [
      { customId: KEY, type: 'succeeded', text: JSON.stringify({ side: 'long', entry: 100, stopLoss: 95, takeProfit: 110, rationale: 'r', primaryZone: 'z', confidence: 9 }) },
    ];
    const rec = await build(deps);
    await rec.reconcile();
    const cell = deps.created.find((c) => c.runIndex === 1);
    expect(cell.result.status).toBe('INVALID');
    expect(deps.backtest.run).not.toHaveBeenCalled(); // never reached the judge
  });

  it('is idempotent: createCell swallowing AlreadyExists lets reconcile re-run', async () => {
    const deps = makeDeps();
    deps.repo.createCell.mockResolvedValue(undefined); // repo swallows dup internally
    const rec = await build(deps);
    await rec.reconcile();
    await rec.reconcile();
    expect(deps.repo.updateBatch).toHaveBeenCalled();
  });

  it('does not reconcile a batch that is still in_progress', async () => {
    const deps = makeDeps();
    deps.llm.batchStatus = 'in_progress';
    const getBatchResultsSpy = jest.spyOn(deps.llm, 'getBatchResults');
    const rec = await build(deps);
    await rec.reconcile();
    expect(getBatchResultsSpy).not.toHaveBeenCalled();
    expect(deps.repo.updateBatch).toHaveBeenCalledWith('batch_1', { status: 'in_progress' });
    expect(deps.scoreboard.generate).not.toHaveBeenCalled();
  });

  it('marks a canceled/expired/errored batch terminal without reconciling results', async () => {
    const deps = makeDeps();
    deps.llm.batchStatus = 'expired';
    const getBatchResultsSpy = jest.spyOn(deps.llm, 'getBatchResults');
    const rec = await build(deps);
    await rec.reconcile();
    expect(getBatchResultsSpy).not.toHaveBeenCalled();
    expect(deps.repo.updateBatch).toHaveBeenCalledWith('batch_1', { status: 'expired' });
  });

  it('isolates a malformed customId and still reconciles the rest of the batch (FIX 1)', async () => {
    const deps = makeDeps();
    deps.llm.batchResults = [
      { customId: 'not-a-valid-key', type: 'succeeded', text: '{}' },
      { customId: KEY, type: 'succeeded', text: JSON.stringify({ side: 'long', entry: 100, stopLoss: 95, takeProfit: 110, rationale: 'r', primaryZone: 'z', confidence: 3 }) },
    ];
    const rec = await build(deps);
    await expect(rec.reconcile()).resolves.toBeUndefined();
    const cell = deps.created.find((c) => c.runIndex === 1);
    expect(cell.result.status).toBe('TP'); // the good item still processed
    // The batch is still marked reconciled despite the bad item.
    expect(deps.repo.updateBatch).toHaveBeenCalledWith('batch_1', expect.objectContaining({ status: 'reconciled' }));
  });

  it('does NOT write a cell for a retryable errored item — stays MISSING for re-submit (FIX 3)', async () => {
    const deps = makeDeps();
    deps.llm.batchResults = [
      { customId: KEY, type: 'errored', error: 'overloaded' },
    ];
    const rec = await build(deps);
    await rec.reconcile();
    expect(deps.repo.createCell).not.toHaveBeenCalled();
    // Batch still moves to reconciled; the missing run-index is re-submitted on the next top-up.
    expect(deps.repo.updateBatch).toHaveBeenCalledWith('batch_1', expect.objectContaining({ status: 'reconciled' }));
  });

  it('DOES write a NO_SETUP cell for a refusal item (FIX 3)', async () => {
    const deps = makeDeps();
    deps.llm.batchResults = [
      { customId: KEY, type: 'refusal' },
    ];
    const rec = await build(deps);
    await rec.reconcile();
    expect(deps.repo.createCell).toHaveBeenCalled();
    const cell = deps.created.find((c) => c.runIndex === 1);
    expect(cell.result.status).toBe('NO_SETUP');
    expect(cell.setup).toBeUndefined();
  });

  it('regenerates the scoreboard once, after the batch loop, and tolerates its failure (FIX 2)', async () => {
    const deps = makeDeps();
    deps.scoreboard.generate.mockRejectedValue(new Error('scoreboard boom'));
    const rec = await build(deps);
    await expect(rec.reconcile()).resolves.toBeUndefined();
    // Batch reconciliation is unaffected by a scoreboard failure.
    expect(deps.repo.updateBatch).toHaveBeenCalledWith('batch_1', expect.objectContaining({ status: 'reconciled' }));
    expect(deps.scoreboard.generate).toHaveBeenCalledWith('fable');
    expect(deps.scoreboard.generate).toHaveBeenCalledTimes(1);
  });

  it('onApplicationBootstrap triggers reconcile (fire-and-forget) when scheduler enabled (FIX 4)', async () => {
    const deps = makeDeps();
    const rec = await build(deps, true);
    const spy = jest.spyOn(rec, 'reconcile').mockResolvedValue(undefined);
    rec.onApplicationBootstrap();
    expect(spy).toHaveBeenCalled();
  });

  it('onApplicationBootstrap swallows a reconcile failure without throwing (FIX 4)', async () => {
    const deps = makeDeps();
    const rec = await build(deps, true);
    jest.spyOn(rec, 'reconcile').mockRejectedValue(new Error('boot boom'));
    expect(() => rec.onApplicationBootstrap()).not.toThrow();
    await new Promise((r) => setImmediate(r)); // let the rejected promise settle
  });

  it('persists artifactSha256 from CellMeta onto a scorecard cell', async () => {
    const deps = makeDeps();
    const SC_KEY = cellKey({ trader: 'context-trader', modelAlias: 'fable', day: '07012026', variant: 'seven-keys-scorecard', runIndex: 1 });
    deps.repo.nonTerminalBatches.mockResolvedValue([
      baseBatch({ customIdToCell: { [SC_KEY]: { ...META, featureSha256: 'scsha', staticDocSha256: 'dsha', artifactSha256: 'ksha' } } }),
    ]);
    deps.llm.batchResults = [
      { customId: SC_KEY, type: 'succeeded', text: JSON.stringify({ side: 'long', entry: 100, stopLoss: 95, takeProfit: 110, rationale: 'r', primaryZone: 'z', confidence: 3 }) },
    ];
    const rec = await build(deps);
    await rec.reconcile();
    const cell = deps.created.find((c) => c.variant === 'seven-keys-scorecard');
    expect(cell.artifactSha256).toBe('ksha');
    expect(cell.featureSha256).toBe('scsha');
  });

  it('omits artifactSha256 on a base cell (no meta field)', async () => {
    const deps = makeDeps();
    const rec = await build(deps);
    await rec.reconcile();
    const cell = deps.created.find((c) => c.runIndex === 1);
    expect(cell.artifactSha256).toBeUndefined();
  });

  it('emits a batch UsageEvent per succeeded item, attributed from the customId', async () => {
    const emitted: any[] = [];
    const emitter = { emit: (name: string, ev: any) => emitted.push({ name, ev }) };
    const batch = {
      batchId: 'msgbatch_1',
      day: '07222026',
      date: '2026-07-22',
      model: { alias: 'fable', id: 'claude-fable-5' },
      status: 'submitted',
      submittedAt: '2026-07-22T14:00:00.000Z',
      customIdToCell: {
        'context-trader__fable__07222026__base__run1': { date: '2026-07-22', personaSha256: 'p', generalSha256: 'g' },
      },
    };
    const neutralUsage = { input: 20, cacheRead: 3227, cacheCreate5m: 0, cacheCreate1h: 16434, output: 2157 };
    const llm = new FakeLlmProvider();
    llm.batchStatus = 'ended';
    llm.batchResults = [
      { customId: 'context-trader__fable__07222026__base__run1', type: 'succeeded',
        text: JSON.stringify({ side: 'long', entry: 100, stopLoss: 95, takeProfit: 110, rationale: 'r', primaryZone: 'z', confidence: 3 }),
        usage: neutralUsage },
    ];
    const repo = {
      nonTerminalBatches: async () => [batch],
      createCell: async () => {},
      updateBatch: async () => {},
    };
    const backtest = { run: async () => ({ results: [{ status: 'NOT_FILLED', points: null, dollars: null, fillTime: null, exitTime: null, maxAdverseExcursion: null, maxFavorableExcursion: null, rMultiple: null, closestApproach: 49.75 }] }) };
    const scoreboard = { generate: async () => {} };
    const config = { get: () => false };
    const reconciler = new BatchReconciler(repo as any, llm as any, backtest as any, scoreboard as any, config as any, emitter as any);
    await reconciler.reconcile();

    const usage = emitted.find((e) => e.name === 'anthropic.usage');
    expect(usage).toBeDefined();
    expect(usage.ev).toEqual(expect.objectContaining({
      id: 'msgbatch_1:context-trader__fable__07222026__base__run1',
      timestamp: '2026-07-22T14:00:00.000Z', // batch submission time, not the reconcile tick
      source: 'batch',
      serviceTier: 'batch',
      batchId: 'msgbatch_1',
      modelId: 'claude-fable-5',
      attribution: { operation: 'setup', benchmark: { modelAlias: 'fable', day: '07222026', trader: 'context-trader', variant: 'base', runIndex: 1 } },
      // Usage arrives already-neutral from the port; no tokensFromUsage transform.
      tokens: neutralUsage,
    }));
  });
});

describe('BatchReconciler scheduler gating', () => {
  it('onApplicationBootstrap does NOT reconcile when the scheduler is disabled (no Firestore access)', async () => {
    const deps = makeDeps();
    const rec = await build(deps, false);
    rec.onApplicationBootstrap();
    await new Promise((r) => setImmediate(r));
    expect(deps.repo.nonTerminalBatches).not.toHaveBeenCalled();
  });

  it('scheduledReconcile no-ops when the scheduler is disabled', async () => {
    const deps = makeDeps();
    const rec = await build(deps, false);
    const spy = jest.spyOn(rec, 'reconcile');
    rec.scheduledReconcile();
    await new Promise((r) => setImmediate(r));
    expect(spy).not.toHaveBeenCalled();
    expect(deps.repo.nonTerminalBatches).not.toHaveBeenCalled();
  });

  it('scheduledReconcile invokes reconcile when the scheduler is enabled', async () => {
    const deps = makeDeps();
    const rec = await build(deps, true);
    const spy = jest.spyOn(rec, 'reconcile').mockResolvedValue(undefined);
    rec.scheduledReconcile();
    await new Promise((r) => setImmediate(r));
    expect(spy).toHaveBeenCalled();
  });
});
