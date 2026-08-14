import { Injectable, Logger, OnApplicationShutdown, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EminiplayerService } from './eminiplayer.service';
import { EminiplayerIngestService, IngestResult } from './eminiplayer-ingest.service';
import {
  classifyArchiveTitle,
  listTradePlanDates,
  selectDayEntries,
  RawArchiveRow,
} from './eminiplayer-archive';
import { ARCHIVE_URL, ArchiveNotFoundError, RECAP_LOOKBACK_DAYS } from './eminiplayer.constants';
import { IngestStageError, IngestValidationError } from './eminiplayer-ingest.errors';
import { parseMmddyyyy } from './eminiplayer-validation';

export type BackfillState = 'running' | 'done' | 'cancelled' | 'failed';
export type BackfillFailureKind = 'notFound' | 'validation' | 'stage' | 'unknown';

export interface BackfillFailure {
  date: string;
  kind: BackfillFailureKind;
  message: string;
}

export interface BackfillJobSnapshot {
  state: BackfillState;
  from: string;
  to: string;
  startedAt: string;
  finishedAt: string | null;
  /** Day in flight; null when not running. */
  currentDate: string | null;
  /** True once cancellation was requested — DELETE ack while the in-flight day finishes. */
  cancelRequested: boolean;
  counts: {
    /** TP dates found in range; null until the listing is scraped. */
    candidates: number | null;
    processed: number;
    /** Days the pipeline actually ran (produced or re-verified artifacts). */
    uploaded: number;
    /** Days served entirely from a committed manifest (result.fromManifest). */
    skipped: number;
    failed: number;
  };
  failures: BackfillFailure[];
  /** Job-level failure only (listing scrape / login / drift tripwire). */
  error: string | null;
}

/** Thrown by start() when a job is already running; controller maps to 409. */
export class BackfillAlreadyRunningError extends Error {
  constructor() {
    super('a backfill job is already running');
  }
}

/** Per-day ceiling exceeded — classified as a 'stage' (transient) failure. */
class BackfillDayTimeoutError extends Error {
  constructor(date: string, ms: number) {
    super(`day ${date} exceeded the ${ms}ms backfill day timeout`);
  }
}

/**
 * In-memory singleton bulk-backfill job (see the 2026-08-14 design spec).
 * Durable state lives in the per-day manifests, not here: a process death
 * costs one re-POST, and committed days short-circuit in ~0.2s with no site
 * traffic. Scrapes the archive listing ONCE per job and derives every day's
 * entries from that capture (frontier days re-resolve fresh); one bad day
 * lands in the ledger and never stops the run; every day races a timeout so
 * a hung socket can't wedge the singleton.
 */
@Injectable()
export class EminiplayerBackfillService implements OnModuleDestroy, OnApplicationShutdown {
  private readonly logger = new Logger(EminiplayerBackfillService.name);
  private job: BackfillJobSnapshot | null = null;
  private cancelRequested = false;
  /** Test seam: the detached loop, awaitable. */
  private loopPromise: Promise<void> = Promise.resolve();

  constructor(
    private readonly eminiplayer: EminiplayerService,
    private readonly ingestService: EminiplayerIngestService,
    private readonly config: ConfigService,
  ) {}

  /**
   * A 19-hour run WILL meet a SIGTERM. Nest calls onModuleDestroy first (the
   * phase where PlaywrightService latches shut), then onApplicationShutdown —
   * setting the flag in BOTH phases guarantees no further days start no
   * matter the provider ordering; the destroyed Playwright latch cuts the
   * in-flight day short.
   */
  onModuleDestroy(): void {
    this.requestShutdownCancel();
  }

  onApplicationShutdown(): void {
    this.requestShutdownCancel();
  }

  private requestShutdownCancel(): void {
    if (this.job?.state === 'running' && !this.cancelRequested) {
      this.logger.log('shutdown: cancelling the running backfill job');
      this.cancelRequested = true;
      this.job.cancelRequested = true;
    }
  }

  start(from: string, to: string): BackfillJobSnapshot {
    // Validate here too, not just in the controller — a future non-HTTP
    // caller with a reversed range must not silently get done/candidates:0.
    if (parseMmddyyyy(from).getTime() > parseMmddyyyy(to).getTime()) {
      throw new IngestValidationError('"from" must be on or before "to"');
    }
    if (this.job?.state === 'running') throw new BackfillAlreadyRunningError();
    this.cancelRequested = false;
    this.job = {
      state: 'running',
      from,
      to,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      currentDate: null,
      cancelRequested: false,
      counts: { candidates: null, processed: 0, uploaded: 0, skipped: 0, failed: 0 },
      failures: [],
      error: null,
    };
    this.loopPromise = this.runLoop(this.job);
    return structuredClone(this.job);
  }

  /** Copy of the current (or most recently finished) job; null before the first start. */
  status(): BackfillJobSnapshot | null {
    return this.job ? structuredClone(this.job) : null;
  }

  /**
   * Request cancellation: the in-flight day finishes (a day is atomic — its
   * manifest either commits or doesn't), no further days start. No-op on a
   * finished job; null when no job has ever run.
   */
  cancel(): BackfillJobSnapshot | null {
    if (!this.job) return null;
    if (this.job.state === 'running') {
      this.cancelRequested = true;
      this.job.cancelRequested = true;
    }
    return structuredClone(this.job);
  }

  private async runLoop(job: BackfillJobSnapshot): Promise<void> {
    try {
      const rows = await this.eminiplayer.fetchArchiveRows();
      // Drift tripwire: zero classifiable TP rows ANYWHERE means the listing
      // markup changed — a "done, candidates: 0" would misreport total scrape
      // failure as success. (An empty RANGE with a healthy archive is fine.)
      if (!rows.some((r) => classifyArchiveTitle(r.title)?.kind === 'tradePlan')) {
        throw new Error('listing scrape returned no classifiable trade-plan rows — selector drift?');
      }
      const dates = listTradePlanDates(rows, job.from, job.to);
      job.counts.candidates = dates.length;
      const scrapeTime = this.now();
      this.logger.log(`backfill ${job.from}..${job.to}: ${dates.length} candidate days`);
      const maxConsecutiveStageFailures = this.maxConsecutiveStageFailures();
      let consecutiveStageFailures = 0;
      for (const date of dates) {
        if (this.cancelRequested) {
          job.state = 'cancelled';
          break;
        }
        job.currentDate = date;
        const { touchedNetwork, failureKind } = await this.runDay(job, rows, date, scrapeTime);
        job.counts.processed += 1;
        job.currentDate = null;
        if (failureKind === 'stage') {
          consecutiveStageFailures += 1;
        } else {
          consecutiveStageFailures = 0;
        }
        if (consecutiveStageFailures >= maxConsecutiveStageFailures) {
          job.state = 'failed';
          job.error = `aborted after ${maxConsecutiveStageFailures} consecutive stage failures — investigate before re-POSTing`;
          this.logger.error(job.error);
          break;
        }
        if (touchedNetwork) await this.sleep(this.delayMs());
      }
      if (job.state === 'running') job.state = 'done';
    } catch (err) {
      // Job-level failure (listing scrape, login, drift tripwire) — per-day
      // errors never land here.
      job.state = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
      this.logger.error(`backfill failed: ${job.error}`);
    } finally {
      job.currentDate = null;
      job.finishedAt = new Date().toISOString();
      this.logger.log(
        `backfill ${job.state}: ${job.counts.uploaded} uploaded, ${job.counts.skipped} skipped, ${job.counts.failed} failed`,
      );
    }
  }

  /**
   * Returns whether the day touched the network (drives the politeness
   * delay) and its failure kind (null on success) — feeds the caller's
   * consecutive-stage-failure circuit breaker.
   */
  private async runDay(
    job: BackfillJobSnapshot,
    rows: RawArchiveRow[],
    date: string,
    scrapeTime: number,
  ): Promise<{ touchedNetwork: boolean; failureKind: BackfillFailureKind | null }> {
    let ingestInvoked = false;
    try {
      // Frontier days (within the recap lookback of the scrape moment) must
      // re-resolve fresh: a recap posted AFTER the scrape would otherwise be
      // invisible and the day would commit against an older in-window recap.
      const frontier =
        parseMmddyyyy(date).getTime() >= scrapeTime - RECAP_LOOKBACK_DAYS * 86_400_000;
      const entries = frontier ? undefined : selectDayEntries(rows, date, ARCHIVE_URL);
      ingestInvoked = true;
      const result = await this.withDayTimeout(
        this.ingestService.ingest(date, false, entries),
        date,
      );
      if (result.fromManifest) {
        job.counts.skipped += 1;
        return { touchedNetwork: false, failureKind: null }; // served entirely from the manifest — no site traffic
      }
      job.counts.uploaded += 1;
      return { touchedNetwork: true, failureKind: null };
    } catch (err) {
      const kind = this.classify(err);
      const message = err instanceof Error ? err.message : String(err);
      job.counts.failed += 1;
      job.failures.push({ date, kind, message });
      this.logger.warn(`backfill day ${date} failed: ${message}`);
      // A pure selectDayEntries throw touched nothing — no delay owed.
      return { touchedNetwork: ingestInvoked, failureKind: kind };
    }
  }

  private withDayTimeout(work: Promise<IngestResult>, date: string): Promise<IngestResult> {
    const ms = this.config.get<number>('eminiplayer.backfillDayTimeoutMs') ?? 600_000;
    return new Promise<IngestResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new BackfillDayTimeoutError(date, ms)), ms);
      // The abandoned promise keeps running harmlessly: days are idempotent
      // and manifest-gated, so a late completion simply commits.
      work.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  private classify(err: unknown): BackfillFailureKind {
    if (err instanceof BackfillDayTimeoutError) return 'stage'; // transient — re-POST retries
    if (err instanceof ArchiveNotFoundError) return 'notFound';
    if (err instanceof IngestValidationError) return 'validation';
    if (err instanceof IngestStageError) return 'stage';
    return 'unknown';
  }

  private delayMs(): number {
    return this.config.get<number>('eminiplayer.backfillDelayMs') ?? 2000;
  }

  private maxConsecutiveStageFailures(): number {
    return (
      this.config.get<number>('eminiplayer.backfillMaxConsecutiveStageFailures') ?? 20
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Seam so tests can pin "frontier" deterministically. */
  private now(): number {
    return Date.now();
  }
}
