import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { MarketDataService } from './market-data.service';
import { parseContractTxt } from './contract-txt-parser';
import { Interval } from './candle';

// Detached one-shot job that walks the repo's data/ dirs and ingests every
// per-contract txt file into markets/{contract}/{interval}. Mirrors the
// eminiplayer backfill's in-memory job pattern, minus cancellation (the job
// is local-disk + Firestore and safely re-runnable; upserts are idempotent).

const FILE_RE = /^ES_([HMUZ]\d{2})_(1min|5min)\.txt$/;
const INTERVAL_BY_SUFFIX: Record<string, Interval> = { '1min': 'min-1', '5min': 'min-5' };

// Directory names carry an opaque export-token suffix (e.g. _t6h13g), so
// discovery is by pattern, never by literal name. Archive dirs FIRST: should
// a contract ever appear in both, update (fresher) wins last-write in the
// per-candle merge.
const DIR_RE = /^ES_(1min|5min)_(archive|update)_/;

function discoverDataDirs(dataRoot: string): string[] {
  if (!existsSync(dataRoot)) return [];
  const rank = (d: string) => (d.includes('_archive_') ? 0 : 1);
  // withFileTypes: a stray FILE named like a dir must not reach readdirSync
  // later (ENOTDIR would escape start() as an unmapped 500).
  return readdirSync(dataRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && DIR_RE.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export function mapContractFile(name: string): { symbol: string; interval: Interval } | null {
  const m = FILE_RE.exec(name);
  if (!m) return null;
  return { symbol: `ES${m[1]}`, interval: INTERVAL_BY_SUFFIX[m[2]] };
}

export interface ContractIngestFileResult {
  file: string; // relative to data/, e.g. 'ES_5min_update_t6h13g/ES_U26_5min.txt'
  contract: string;
  interval: Interval;
  days: number;
  added: number;
  updated: number;
  error?: string;
}

export interface ContractIngestSnapshot {
  state: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  currentFile: string | null;
  counts: { files: number; processed: number; failed: number };
  results: ContractIngestFileResult[];
  /** Non-contract files encountered in the data dirs (relative paths). */
  skipped: string[];
  error: string | null;
}

export class ContractIngestAlreadyRunningError extends Error {
  constructor() {
    super('a contract ingest job is already running');
  }
}

/** Zero contract files under the data root — controller maps to 422. */
export class ContractIngestNoFilesError extends Error {
  constructor(dataRoot: string) {
    super(`no contract files found under ${dataRoot} — check the data directory layout`);
  }
}

@Injectable()
export class ContractIngestService {
  private readonly logger = new Logger(ContractIngestService.name);
  private job: ContractIngestSnapshot | null = null;
  /** Test seam: the detached loop, awaitable. */
  loopPromise: Promise<void> = Promise.resolve();

  constructor(
    private readonly marketData: MarketDataService,
    private readonly config: ConfigService,
  ) {}

  snapshot(): ContractIngestSnapshot | null {
    return this.job;
  }

  start(): ContractIngestSnapshot {
    if (this.job?.state === 'running') throw new ContractIngestAlreadyRunningError();
    const dataRoot = join(this.config.get<string>('marketData.contractDataRoot')!, 'data');

    const files: { rel: string; abs: string; symbol: string; interval: Interval }[] = [];
    const skipped: string[] = [];
    for (const dir of discoverDataDirs(dataRoot)) {
      const abs = join(dataRoot, dir);
      for (const name of readdirSync(abs).sort()) {
        const mapped = mapContractFile(name);
        if (!mapped) {
          skipped.push(`${dir}/${name}`);
          continue;
        }
        files.push({ rel: `${dir}/${name}`, abs: join(abs, name), ...mapped });
      }
    }
    if (files.length === 0) throw new ContractIngestNoFilesError(dataRoot);

    this.job = {
      state: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      currentFile: null,
      counts: { files: files.length, processed: 0, failed: 0 },
      results: [],
      skipped,
      error: null,
    };
    this.loopPromise = this.run(files).catch((err) => {
      this.job!.state = 'failed';
      this.job!.error = (err as Error).message;
      this.job!.finishedAt = new Date().toISOString();
    });
    return this.job;
  }

  private async run(files: { rel: string; abs: string; symbol: string; interval: Interval }[]): Promise<void> {
    const job = this.job!;
    for (const f of files) {
      job.currentFile = f.rel;
      try {
        const candles = parseContractTxt(readFileSync(f.abs, 'utf8'));
        const summary = await this.marketData.ingestCandles(f.symbol, f.interval, candles, {});
        job.results.push({
          file: f.rel,
          contract: f.symbol,
          interval: f.interval,
          days: summary.days.length,
          added: summary.days.reduce((n, d) => n + d.added, 0),
          updated: summary.days.reduce((n, d) => n + d.updated, 0),
        });
      } catch (err) {
        job.counts.failed += 1;
        job.results.push({
          file: f.rel, contract: f.symbol, interval: f.interval,
          days: 0, added: 0, updated: 0, error: (err as Error).message,
        });
        this.logger.warn(`ingest failed for ${f.rel}: ${(err as Error).message}`);
      }
      job.counts.processed += 1;
    }
    job.currentFile = null;
    job.state = 'done';
    job.finishedAt = new Date().toISOString();
  }
}
