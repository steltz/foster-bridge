import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BenchmarkRepository, BatchDoc, BatchStatus, CellMeta } from './benchmark.repository';
import { AnthropicService, BatchResultItem } from '../anthropic/anthropic.service';
import { BacktestService } from '../execution/backtest.service';
import { ScoreboardService } from './scoreboard.service';
import { BenchmarkCell, CellResult, CellStatus, Setup, parseCellKey } from './benchmark.types';

const SYMBOL = 'MES';
const INTERVAL = 'min-5' as const;

@Injectable()
export class BatchReconciler implements OnApplicationBootstrap {
  private readonly logger = new Logger(BatchReconciler.name);
  private running = false;

  constructor(
    private readonly repo: BenchmarkRepository,
    private readonly anthropic: AnthropicService,
    private readonly backtest: BacktestService,
    private readonly scoreboard: ScoreboardService,
  ) {}

  // Startup reconciliation: drains batches that finished while the server was off.
  async onApplicationBootstrap(): Promise<void> {
    await this.reconcile();
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async reconcile(): Promise<void> {
    if (this.running) return; // never overlap a slow reconcile with the next tick
    this.running = true;
    try {
      const batches = await this.repo.nonTerminalBatches();
      for (const batch of batches) {
        await this.reconcileBatch(batch).catch((err) =>
          this.logger.error(`Reconcile ${batch.batchId} failed: ${(err as Error).message}`),
        );
      }
    } finally {
      this.running = false;
    }
  }

  private async reconcileBatch(batch: BatchDoc): Promise<void> {
    // Bench batches were created on the beta/files path, so read them there too.
    const summary = await this.anthropic.getBatch(batch.batchId, { files: true });
    const status = summary.processingStatus;

    if (status === 'in_progress') {
      await this.repo.updateBatch(batch.batchId, { status: 'in_progress' });
      return;
    }
    if (status === 'canceled' || status === 'expired' || status === 'errored') {
      await this.repo.updateBatch(batch.batchId, { status: status as BatchStatus });
      return;
    }
    if (status !== 'ended') return; // 'submitted' / unknown: wait for the next tick

    const results = await this.anthropic.getBatchResults(batch.batchId, { files: true });
    for (const item of results) {
      // customId IS the cellKey; the CellMeta supplies date + content hashes.
      const meta = batch.customIdToCell[item.customId];
      await this.repo.createCell(await this.buildCell(batch, item.customId, meta, item));
    }
    await this.repo.updateBatch(batch.batchId, { status: 'reconciled', endedAt: new Date().toISOString() });
    // Refresh the materialized scoreboard for this model now that cells landed.
    await this.scoreboard.generate(batch.model.alias);
  }

  private async buildCell(
    batch: BatchDoc,
    key: string,
    meta: CellMeta | undefined,
    item: BatchResultItem,
  ): Promise<BenchmarkCell> {
    const parts = parseCellKey(key);
    // Persist design-§4 provenance from the threaded meta. Missing meta
    // shouldn't happen; fall back to key dimensions, empty hashes, and a note.
    const metaNote = meta ? undefined : 'missing cell meta; hashes empty';
    const base: Omit<BenchmarkCell, 'result' | 'setup' | 'note'> = {
      trader: parts.trader,
      model: batch.model,
      modelAlias: batch.model.alias,
      day: batch.day,
      date: meta?.date ?? batch.date,
      variant: parts.variant,
      runIndex: parts.runIndex,
      personaSha256: meta?.personaSha256 ?? '',
      generalSha256: meta?.generalSha256 ?? '',
      ...(meta?.featureSha256 ? { featureSha256: meta.featureSha256 } : {}),
      ...(meta?.staticDocSha256 ? { staticDocSha256: meta.staticDocSha256 } : {}),
      createdAt: new Date().toISOString(),
    };
    // Merge the meta-missing note without clobbering a status note.
    const withMetaNote = (cell: BenchmarkCell): BenchmarkCell =>
      metaNote && !cell.note ? { ...cell, note: metaNote } : cell;

    // Refusal / errored / canceled / expired -> NO_SETUP (no model fallback:
    // a Fable refusal is a legitimate Fable result).
    if (item.type !== 'succeeded') {
      const status: CellStatus = 'NO_SETUP';
      return withMetaNote({ ...base, result: { status }, note: item.error });
    }

    let setup: Setup;
    try {
      setup = JSON.parse(item.text ?? '');
    } catch {
      return withMetaNote({ ...base, result: { status: 'INVALID' }, note: 'unparseable setup JSON' });
    }
    // Light re-validation of the ranges/shape the schema no longer enforces
    // (structured outputs rejects maxLength/minimum/maximum — see SETUP_SCHEMA).
    if (!this.validSetup(setup)) {
      return withMetaNote({ ...base, result: { status: 'INVALID' }, note: 'setup failed validation' });
    }

    try {
      const bt = await this.backtest.run({
        symbol: SYMBOL,
        interval: INTERVAL,
        date: meta?.date ?? batch.date,
        session: 'rth',
        allowIncomplete: false,
        orders: [{ side: setup.side, entry: setup.entry, stopLoss: setup.stopLoss, takeProfit: setup.takeProfit }],
      });
      const r = bt.results[0];
      const result: CellResult = {
        status: r.status as CellStatus,
        points: r.points,
        dollars: r.dollars,
        fillTime: r.fillTime,
        exitTime: r.exitTime,
        maxAdverseExcursion: r.maxAdverseExcursion,
        maxFavorableExcursion: r.maxFavorableExcursion,
        rMultiple: r.rMultiple,
        closestApproach: r.closestApproach,
      };
      return withMetaNote({ ...base, setup, result });
    } catch (err) {
      // Preserve the judge's verdict: bad order geometry / "must be a number"
      // (BadRequest 400 from normalizeOrders) is the SETUP's fault -> INVALID;
      // missing candles (404) or an incomplete session (422), and any other
      // failure, are environmental -> CLI_ERROR.
      let status: CellStatus;
      if (err instanceof BadRequestException) status = 'INVALID';
      else if (err instanceof NotFoundException || err instanceof UnprocessableEntityException) status = 'CLI_ERROR';
      else status = 'CLI_ERROR';
      return withMetaNote({ ...base, setup, result: { status }, note: (err as Error).message });
    }
  }

  // Required fields present, side in {long,short}, numeric prices, integer
  // confidence 1..5. Mirrors the constraints stripped from SETUP_SCHEMA.
  private validSetup(s: any): boolean {
    return (
      !!s &&
      (s.side === 'long' || s.side === 'short') &&
      Number.isFinite(s.entry) &&
      Number.isFinite(s.stopLoss) &&
      Number.isFinite(s.takeProfit) &&
      typeof s.rationale === 'string' &&
      typeof s.primaryZone === 'string' &&
      Number.isInteger(s.confidence) &&
      s.confidence >= 1 &&
      s.confidence <= 5
    );
  }
}
