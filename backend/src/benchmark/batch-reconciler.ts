import { BadRequestException, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
  private readonly schedulerEnabled: boolean;

  constructor(
    private readonly repo: BenchmarkRepository,
    private readonly anthropic: AnthropicService,
    private readonly backtest: BacktestService,
    private readonly scoreboard: ScoreboardService,
    config: ConfigService,
  ) {
    this.schedulerEnabled = config.get<boolean>('benchmark.schedulerEnabled') ?? false;
  }

  // Startup reconciliation: drains batches that finished while the server was off.
  // Fire-and-forget: a boot-time Firestore error or a slow drain must not fail
  // process startup or block HTTP readiness. Gated so tests / non-worker
  // instances never touch Firestore at boot.
  onApplicationBootstrap(): void {
    if (!this.schedulerEnabled) return;
    void this.reconcile().catch((e) => this.logger.error(`startup reconcile failed: ${e}`));
  }

  // Thin scheduled trigger — gated by config so only a dedicated worker runs the
  // cron. The core reconcile() below stays public/ungated for tests + manual runs.
  @Cron(CronExpression.EVERY_MINUTE)
  scheduledReconcile(): void {
    if (!this.schedulerEnabled) return;
    void this.reconcile().catch((e) => this.logger.error(`scheduled reconcile failed: ${e}`));
  }

  async reconcile(): Promise<void> {
    // Guards a single instance only; across replicas this is idempotent-but-
    // wasteful (createCell is write-once, so duplicate passes are harmless).
    if (this.running) return; // never overlap a slow reconcile with the next tick
    this.running = true;
    try {
      const batches = await this.repo.nonTerminalBatches();
      const reconciledAliases = new Set<string>();
      for (const batch of batches) {
        try {
          const alias = await this.reconcileBatch(batch);
          if (alias) reconciledAliases.add(alias);
        } catch (err) {
          this.logger.error(`Reconcile ${batch.batchId} failed: ${(err as Error).message}`);
        }
      }
      // Decoupled scoreboard regen: once per distinct alias, AFTER the batch
      // loop, each isolated so a scoreboard failure never affects batch
      // reconciliation (batches are already terminal) or another alias.
      for (const alias of reconciledAliases) {
        try {
          await this.scoreboard.generate(alias);
        } catch (err) {
          this.logger.error(`Scoreboard regen for ${alias} failed: ${(err as Error).message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Returns the model alias if the batch reached `ended` and was reconciled, else null. */
  private async reconcileBatch(batch: BatchDoc): Promise<string | null> {
    // Bench batches were created on the beta/files path, so read them there too.
    const summary = await this.anthropic.getBatch(batch.batchId, { files: true });
    const status = summary.processingStatus;

    if (status === 'in_progress') {
      await this.repo.updateBatch(batch.batchId, { status: 'in_progress' });
      return null;
    }
    if (status === 'canceled' || status === 'expired' || status === 'errored') {
      await this.repo.updateBatch(batch.batchId, { status: status as BatchStatus });
      return null;
    }
    if (status !== 'ended') return null; // 'submitted' / unknown: wait for the next tick

    const results = await this.anthropic.getBatchResults(batch.batchId, { files: true });
    const expected = Object.keys(batch.customIdToCell).length;
    if (results.length !== expected) {
      this.logger.warn(`Batch ${batch.batchId}: ${results.length} results for ${expected} expected cells`);
    }
    for (const item of results) {
      try {
        // errored/canceled/expired items are transient infra failures, NOT
        // results: skip them (write no cell) so the run-index stays MISSING and
        // the next top-up re-submits it — never bake a transient error into the
        // benchmark as a fake no-trade. (refusal is a real Fable result below.)
        if (item.type !== 'succeeded' && item.type !== 'refusal') {
          this.logger.warn(
            `Batch ${batch.batchId}: skipping retryable ${item.type} item ${item.customId}${item.error ? ` (${item.error})` : ''}`,
          );
          continue;
        }
        // customId IS the cellKey; the CellMeta supplies date + content hashes.
        const meta = batch.customIdToCell[item.customId];
        await this.repo.createCell(await this.buildCell(batch, item.customId, meta, item));
      } catch (err) {
        // Per-item isolation: one bad customId (e.g. malformed key) must not
        // throw out of the loop and wedge the whole batch from ever reconciling.
        this.logger.warn(`Batch ${batch.batchId}: skipping item ${item.customId}: ${(err as Error).message}`);
      }
    }
    await this.repo.updateBatch(batch.batchId, { status: 'reconciled', endedAt: new Date().toISOString() });
    return batch.model.alias;
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
      ...(meta?.artifactSha256 ? { artifactSha256: meta.artifactSha256 } : {}),
      createdAt: new Date().toISOString(),
    };
    // Merge the meta-missing note without clobbering a status note.
    const withMetaNote = (cell: BenchmarkCell): BenchmarkCell =>
      metaNote && !cell.note ? { ...cell, note: metaNote } : cell;

    // Only refusals reach here as non-succeeded (transient infra errors are
    // skipped upstream). A Fable refusal is a legitimate no-trade result ->
    // NO_SETUP (no model fallback).
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
      // missing candles (404), an incomplete session (422), and any other
      // failure are environmental -> CLI_ERROR.
      const status: CellStatus = err instanceof BadRequestException ? 'INVALID' : 'CLI_ERROR';
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
