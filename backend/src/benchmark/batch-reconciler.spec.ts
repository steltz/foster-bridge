import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { BatchReconciler } from './batch-reconciler';
import { BenchmarkRepository } from './benchmark.repository';
import { AnthropicService } from '../anthropic/anthropic.service';
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
  const anthropic = {
    getBatch: jest.fn().mockResolvedValue({ batchId: 'batch_1', processingStatus: 'ended' }),
    getBatchResults: jest.fn().mockResolvedValue([
      { customId: KEY, type: 'succeeded', text: JSON.stringify({ side: 'long', entry: 100, stopLoss: 95, takeProfit: 110, rationale: 'r', primaryZone: 'z', confidence: 3 }) },
      { customId: REFUSAL_KEY, type: 'refusal', stopReason: 'refusal' },
    ]),
  };
  const backtest = {
    run: jest.fn().mockResolvedValue({
      results: [{ status: 'TP', points: 10, dollars: 50, fillTime: 1, exitTime: 2, maxAdverseExcursion: 1, maxFavorableExcursion: 2, rMultiple: 2, closestApproach: null }],
    }),
  };
  const scoreboard = { generate: jest.fn().mockResolvedValue({ markdown: '#', json: {}, generatedAt: 't' }) };
  return { repo, anthropic, backtest, scoreboard, created };
}

async function build(deps: ReturnType<typeof makeDeps>) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      BatchReconciler,
      { provide: BenchmarkRepository, useValue: deps.repo },
      { provide: AnthropicService, useValue: deps.anthropic },
      { provide: BacktestService, useValue: deps.backtest },
      { provide: ScoreboardService, useValue: deps.scoreboard },
    ],
  }).compile();
  return moduleRef.get(BatchReconciler);
}

describe('BatchReconciler.reconcile', () => {
  it('backtests a succeeded setup and writes a scored cell; reads the beta batch', async () => {
    const deps = makeDeps();
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
    // Bench batches were created on the beta/files path, so reads use it too.
    expect(deps.anthropic.getBatch).toHaveBeenCalledWith('batch_1', { files: true });
    expect(deps.anthropic.getBatchResults).toHaveBeenCalledWith('batch_1', { files: true });
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
    deps.anthropic.getBatchResults.mockResolvedValue([
      { customId: KEY, type: 'succeeded', text: JSON.stringify({ side: 'long', entry: 100, stopLoss: 95, takeProfit: 110, rationale: 'r', primaryZone: 'z', confidence: 9 }) },
    ]);
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
    deps.anthropic.getBatch.mockResolvedValue({ batchId: 'batch_1', processingStatus: 'in_progress' });
    const rec = await build(deps);
    await rec.reconcile();
    expect(deps.anthropic.getBatchResults).not.toHaveBeenCalled();
    expect(deps.repo.updateBatch).toHaveBeenCalledWith('batch_1', { status: 'in_progress' });
    expect(deps.scoreboard.generate).not.toHaveBeenCalled();
  });

  it('marks a canceled/expired/errored batch terminal without reconciling results', async () => {
    const deps = makeDeps();
    deps.anthropic.getBatch.mockResolvedValue({ batchId: 'batch_1', processingStatus: 'expired' });
    const rec = await build(deps);
    await rec.reconcile();
    expect(deps.anthropic.getBatchResults).not.toHaveBeenCalled();
    expect(deps.repo.updateBatch).toHaveBeenCalledWith('batch_1', { status: 'expired' });
  });
});
