import { Injectable, Logger, OnApplicationShutdown, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BenchmarkRepository, DayArtifactDoc } from './benchmark.repository';
import { CloudInputsService, DayListing, InputsSnapshot } from './cloud-inputs.service';
import { DayArtifactsService } from './day-artifacts.service';
import { SevenKeysService, KeysFailure } from './seven-keys/seven-keys.service';
import { BenchmarkRunLock } from './run-lock';

/** Attempts per day before the job stops for manual investigation. */
export const MAX_DAY_ATTEMPTS = 3;
/** Must match SevenKeysService's LOOKBACK_DAYS — used only by the `from` guard. */
const LOOKBACK_DAYS = 3;
/** Sliding window of generated-day durations feeding the ETA. */
const PROGRESS_WINDOW = 10;

export type KeysBackfillState = 'running' | 'done' | 'cancelled' | 'failed';
export type KeysFailureKind = KeysFailure['kind'] | 'timeout';

export interface KeysBackfillFailure {
  day: string;
  attempts: number;
  kind: KeysFailureKind;
  message: string;
  mismatches: string[];
}

export interface KeysBackfillSnapshot {
  state: KeysBackfillState;
  flagshipAlias: string;
  from: string | null;
  to: string | null;
  startedAt: string;
  finishedAt: string | null;
  currentDay: string | null;
  cancelRequested: boolean;
  counts: { candidates: number; processed: number; generated: number; reused: number; failed: number };
  reducedLookback: { day: string; missing: string[] }[];
  failures: KeysBackfillFailure[];
  error: string | null;
  progress: { avgSecondsPerDay: number | null; etaIso: string | null };
}

type DayOutcome = 'generated' | 'reused' | 'failed' | 'cancelled';

export class KeysBackfillDayTimeoutError extends Error {
  constructor(day: string, ms: number) {
    super(`day ${day} exceeded the ${ms}ms keys-backfill day timeout`);
  }
}

/** loadDay/outcomeRecapForDay throw this wording when the corpus moved under us. */
const SNAPSHOT_MISMATCH = /changed since the run snapshot/;

/**
 * Corpus-wide seven-keys generation, strictly sequential and oldest-first so
 * every day's lookback analyst sees three finalized prior assessments. The job
 * object is in-memory and disposable — durable state is the KEYS artifacts, so
 * resume is just a re-POST and already-built days short-circuit on one read.
 */
@Injectable()
export class KeysBackfillService implements OnModuleDestroy, OnApplicationShutdown {
  private readonly logger = new Logger(KeysBackfillService.name);
  private job: KeysBackfillSnapshot | null = null;
  private cancelRequested = false;
  /** Seconds per GENERATED day, most recent PROGRESS_WINDOW entries. */
  private generatedDurations: number[] = [];
  /** Test seam: the detached loop, awaitable. */
  private loopPromise: Promise<void> = Promise.resolve();

  constructor(
    private readonly inputs: CloudInputsService,
    private readonly dayArtifacts: DayArtifactsService,
    private readonly sevenKeys: SevenKeysService,
    private readonly repo: BenchmarkRepository,
    private readonly lock: BenchmarkRunLock,
    private readonly config: ConfigService,
  ) {}

  start(opts: { from?: string; to?: string }): KeysBackfillSnapshot {
    this.lock.acquire('keys-backfill');
    this.cancelRequested = false;
    this.generatedDurations = [];
    this.job = {
      state: 'running',
      flagshipAlias: this.sevenKeys.lineageAlias,
      from: opts.from ?? null,
      to: opts.to ?? null,
      startedAt: new Date(this.nowMs()).toISOString(),
      finishedAt: null,
      currentDay: null,
      cancelRequested: false,
      counts: { candidates: 0, processed: 0, generated: 0, reused: 0, failed: 0 },
      reducedLookback: [],
      failures: [],
      error: null,
      progress: { avgSecondsPerDay: null, etaIso: null },
    };
    // .catch so a throw in runLoop's finally can never become an unhandled
    // rejection that kills the process hosting a 40-hour job.
    this.loopPromise = this.runLoop(this.job, opts).catch((err) =>
      this.logger.error(`keys-backfill loop crashed: ${(err as Error).message}`),
    );
    return structuredClone(this.job);
  }

  status(): KeysBackfillSnapshot | null {
    return this.job ? structuredClone(this.job) : null;
  }

  cancel(): KeysBackfillSnapshot | null {
    if (!this.job) return null;
    if (this.job.state === 'running') {
      this.cancelRequested = true;
      this.job.cancelRequested = true;
    }
    return structuredClone(this.job);
  }

  /**
   * A 20-40 hour run WILL meet a SIGTERM. Both lifecycle phases set the flag so
   * no further day starts regardless of provider ordering; the in-flight
   * attempt finishes and its artifact either saved or did not.
   */
  onModuleDestroy(): void {
    this.requestShutdownCancel();
  }

  onApplicationShutdown(): void {
    this.requestShutdownCancel();
  }

  private requestShutdownCancel(): void {
    if (this.job?.state === 'running' && !this.cancelRequested) {
      this.logger.log('shutdown: cancelling the running keys-backfill job');
      this.cancelRequested = true;
      this.job.cancelRequested = true;
    }
  }

  /**
   * Averages GENERATED days only. A cumulative average including reused days
   * makes the common resume case (300 reused at ~1s, then 52 at ~7min) report
   * "done in a minute" for a six-hour job.
   */
  private updateProgress(job: KeysBackfillSnapshot): void {
    if (!this.generatedDurations.length) return;
    const avg = this.generatedDurations.reduce((a, b) => a + b, 0) / this.generatedDurations.length;
    const remaining = Math.max(0, job.counts.candidates - job.counts.processed);
    job.progress = {
      avgSecondsPerDay: Math.round(avg),
      etaIso: new Date(this.nowMs() + remaining * avg * 1000).toISOString(),
    };
  }

  private async runLoop(job: KeysBackfillSnapshot, opts: { from?: string; to?: string }): Promise<void> {
    try {
      const snap = await this.inputs.snapshot();
      // A bucket/prefix/permissions failure must not read as "done, 0 days".
      if (!snap.days.length) {
        throw new Error('corpus scan returned no committed days — check the bucket prefix and credentials');
      }
      // generate() throws on a null methods doc; preflight it into a clean
      // job-level failure instead of three opaque day failures.
      if (!snap.methodsDoc) {
        throw new Error('methods doc missing — PUT /knowledge/methods before running the keys backfill');
      }

      // A submitted-but-unreconciled batch holds pins that pinnedKeysHashes
      // cannot see yet. Force-regenerating such a day would leave the
      // reconciler writing cells that pin an artifact we just replaced —
      // a permanent wedge. The run path guards this with `pinned`; we refuse
      // to start instead. Mirrors the era-reset script's own precondition.
      const inFlight = await this.repo.nonTerminalBatches();
      if (inFlight.length) {
        throw new Error(
          `${inFlight.length} non-terminal batch(es) exist — let them reconcile (GET /benchmark/status) before starting the keys backfill; regenerating a day they pinned would wedge it`,
        );
      }

      const all = [...snap.days].sort((a, b) => a.date.localeCompare(b.date));
      const inRange = all.filter((d) => this.inWindow(d, opts));
      job.counts.candidates = inRange.length;
      if (!inRange.length) {
        this.logger.warn(
          `keys-backfill: window ${opts.from ?? 'corpus-start'}..${opts.to ?? 'corpus-end'} matched no committed days`,
        );
      }
      job.from = inRange[0]?.day ?? null;
      job.to = inRange[inRange.length - 1]?.day ?? null;
      if (inRange.length) await this.assertLookbackReady(job, all, inRange[0]);
      this.logger.log(`keys-backfill: ${inRange.length} candidate days for lineage ${job.flagshipAlias}`);

      for (const l of inRange) {
        if (this.cancelRequested) {
          job.state = 'cancelled';
          break;
        }
        job.currentDay = l.day;
        const startedMs = this.nowMs();
        const outcome = await this.runDay(job, l, snap);
        job.currentDay = null;
        if (outcome === 'cancelled') {
          job.state = 'cancelled';
          break;
        }
        if (outcome === 'generated') {
          this.generatedDurations.push((this.nowMs() - startedMs) / 1000);
          if (this.generatedDurations.length > PROGRESS_WINDOW) this.generatedDurations.shift();
        }
        job.counts.processed += 1;
        this.updateProgress(job);
        if (outcome === 'failed') {
          job.state = 'failed';
          job.error = `day ${l.day} failed (${job.failures[job.failures.length - 1]?.kind}) — investigate before re-POSTing; later days were not attempted`;
          this.logger.error(job.error);
          break;
        }
      }
      if (job.state === 'running') job.state = 'done';
    } catch (err) {
      job.state = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
      this.logger.error(`keys-backfill failed: ${job.error}`);
    } finally {
      job.currentDay = null;
      job.finishedAt = new Date(this.nowMs()).toISOString();
      this.lock.release('keys-backfill');
      this.logger.log(
        `keys-backfill ${job.state}: ${job.counts.generated} generated, ${job.counts.reused} reused, ${job.counts.failed} failed`,
      );
    }
  }

  /**
   * Starting mid-corpus would generate the window's first days with reduced
   * lookback, and the reuse rule would then freeze them. Refuse instead.
   * Fewer than LOOKBACK_DAYS priors existing at all (a `from` at the corpus
   * start) is fine.
   */
  private async assertLookbackReady(job: KeysBackfillSnapshot, all: DayListing[], first: DayListing): Promise<void> {
    const idx = all.findIndex((d) => d.day === first.day);
    const priors = all.slice(Math.max(0, idx - LOOKBACK_DAYS), idx);
    const missing: string[] = [];
    for (const p of priors) {
      const doc = await this.repo.getKeysArtifact(p.day, job.flagshipAlias);
      if (!doc?.verified || doc.lookbackMissing?.length) missing.push(p.day);
    }
    if (missing.length) {
      throw new Error(
        `refusing to start at ${first.day}: prior day(s) ${missing.join(', ')} have no finalized KEYS for lineage ${job.flagshipAlias}, so the window's first days would be generated with reduced lookback. Omit "from" to build the whole corpus.`,
      );
    }
  }

  /** Inclusive MMDDYYYY window against the listing's YYYY-MM-DD date. */
  private inWindow(l: DayListing, opts: { from?: string; to?: string }): boolean {
    const iso = (d: string) => `${d.slice(4, 8)}-${d.slice(0, 2)}-${d.slice(2, 4)}`;
    if (opts.from && l.date < iso(opts.from)) return false;
    if (opts.to && l.date > iso(opts.to)) return false;
    return true;
  }

  private async runDay(job: KeysBackfillSnapshot, l: DayListing, snap: InputsSnapshot): Promise<DayOutcome> {
    let last: { kind: KeysFailureKind; message: string; mismatches: string[] } = {
      kind: 'error',
      message: 'no attempt was made',
      mismatches: [],
    };
    let attempts = 0;

    for (let attempt = 1; attempt <= MAX_DAY_ATTEMPTS; attempt++) {
      // Cancellation is checked BETWEEN attempts: the in-flight attempt always
      // finishes, matching the eminiplayer backfill's "in-flight day finishes".
      if (this.cancelRequested && attempt > 1) return 'cancelled';
      if (attempt > 1) await this.sleep(this.retryDelayMs(attempt));
      attempts = attempt;
      // An array, not a scalar: TS narrows a `let x: T | null = null` assigned
      // only inside a callback back to `null` at the read site.
      const reported: KeysFailure[] = [];
      try {
        // Inside the loop so a transient Firestore error is retried rather than
        // killing the job with an empty failures[], and so a late save from an
        // abandoned attempt is picked up.
        const existing = await this.repo.getKeysArtifact(l.day, job.flagshipAlias);
        if (existing?.verified && !existing.lookbackMissing?.length) {
          job.counts.reused += 1;
          return 'reused';
        }
        // A verified-but-degraded artifact must be REPLACED. ensureKeys reuses any
        // verified artifact whose inputsHash still matches unless forced, so without
        // this the regeneration decision is a silent no-op. Pins are checked before
        // force, so a benchmarked day stays frozen either way.
        const regenerateDegraded = Boolean(existing?.verified);
        if (regenerateDegraded) {
          this.logger.log(
            `keys-backfill ${l.day}: stored artifact has reduced lookback (${existing!.lookbackMissing!.join(', ')}) — regenerating`,
          );
        }
        const doc = await this.withDayTimeout(
          this.generateDay(l, snap, (f) => reported.push(f), regenerateDegraded),
          l.day,
        );
        if (doc) {
          job.counts.generated += 1;
          this.recordReducedLookback(job, l.day, doc);
          return 'generated';
        }
        last = reported[0] ?? {
          kind: 'error',
          message: 'ensureKeys returned null without reporting a reason',
          mismatches: [],
        };
        // outcomeRecapForDay throws the mismatch inside generate(), so
        // ensureKeys catches it and reports it here via onFailure rather than
        // throwing. Same deterministic corpus change as the catch below —
        // retrying is waste. Keep the two paths' wording identical.
        if (SNAPSHOT_MISMATCH.test(last.message)) {
          last = {
            kind: 'error',
            message: `corpus changed mid-job — re-POST to re-snapshot (${last.message})`,
            mismatches: [],
          };
          break;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof KeysBackfillDayTimeoutError) {
          last = { kind: 'timeout', message, mismatches: [] };
        } else if (SNAPSHOT_MISMATCH.test(message)) {
          // A concurrent eminiplayer re-ingest. Deterministic — retrying is waste.
          last = {
            kind: 'error',
            message: `corpus changed mid-job — re-POST to re-snapshot (${message})`,
            mismatches: [],
          };
          break;
        } else {
          last = { kind: 'error', message, mismatches: [] };
        }
      }
      this.logger.warn(`keys-backfill ${l.day} attempt ${attempt}/${MAX_DAY_ATTEMPTS} failed [${last.kind}]: ${last.message}`);
      // Neither can succeed on retry; a timeout would also leave the abandoned
      // chain racing saveKeysArtifact against the next attempt.
      if (last.kind === 'refused' || last.kind === 'timeout') break;
    }

    job.counts.failed += 1;
    job.failures.push({ day: l.day, attempts, kind: last.kind, message: last.message, mismatches: last.mismatches });
    return 'failed';
  }

  private retryDelayMs(attempt: number): number {
    const delays = this.config.get<number[]>('benchmark.keysBackfillRetryDelaysMs') ?? [30_000, 180_000];
    return delays[Math.min(attempt - 2, delays.length - 1)] ?? 30_000;
  }

  private withDayTimeout<T>(work: Promise<T>, day: string): Promise<T> {
    const ms = this.config.get<number>('benchmark.keysBackfillDayTimeoutMs') ?? 900_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new KeysBackfillDayTimeoutError(day, ms)), ms);
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

  protected recordReducedLookback(job: KeysBackfillSnapshot, day: string, doc: DayArtifactDoc): void {
    if (!doc.lookbackMissing?.length) return;
    job.reducedLookback.push({ day, missing: doc.lookbackMissing });
    this.logger.warn(`keys-backfill ${day}: generated with reduced lookback — ${doc.lookbackMissing.join(', ')}`);
  }

  protected async generateDay(
    l: DayListing,
    snap: InputsSnapshot,
    onFailure: (f: KeysFailure) => void,
    force = false,
  ): Promise<DayArtifactDoc | null> {
    const dayInput = await this.inputs.loadDay(l);
    await this.dayArtifacts.ensureDayRecorded(dayInput);
    return this.sevenKeys.ensureKeys(dayInput, snap, { onFailure, force });
  }

  /** Seam so specs can pin the clock. */
  protected nowMs(): number {
    return Date.now();
  }

  /** Seam so specs skip real backoff waits. */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
