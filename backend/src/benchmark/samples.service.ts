import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { BenchmarkRepository, SampleDoc } from './benchmark.repository';
import { CloudInputsService, DayListing } from './cloud-inputs.service';
import { MarketDataService } from '../market-data/market-data.service';
import { resolveContract } from '../contracts/contracts-roll';
import { dayTime } from '../eminiplayer/eminiplayer-validation';

const SYMBOL = 'ES';
const INTERVAL = 'min-1' as const;
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const NAME_MAX = 64;

export interface CreateSampleOptions {
  name: string;
  count?: number;
  from?: string; // MMDDYYYY, inclusive
  to?: string; // MMDDYYYY, inclusive
}

export interface SampleSummary {
  name: string;
  count: number;
  poolSize: number;
  firstDay: string;
  lastDay: string;
  createdAt: string;
}

/** Uniform draw without replacement: partial Fisher-Yates over a copy. */
export function draw(pool: string[], count: number): string[] {
  const a = [...pool];
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(Math.random() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, count);
}

/** Shared gate (also used by BenchmarkService's sample resolution): user input never reaches a Firestore doc id unvalidated. */
export function assertSampleName(name: unknown): string {
  if (typeof name !== 'string' || !NAME_RE.test(name) || name.length > NAME_MAX) {
    throw new BadRequestException(`name must match ^[a-z0-9][a-z0-9-]*$ and be at most ${NAME_MAX} characters`);
  }
  return name;
}

@Injectable()
export class SamplesService {
  constructor(
    private readonly repo: BenchmarkRepository,
    private readonly inputs: CloudInputsService,
    private readonly marketData: MarketDataService,
  ) {}

  /** Calendar time of an MMDDYYYY day key, or a 400 naming the field. */
  private assertDayKey(field: 'from' | 'to', value: unknown): number {
    const t = typeof value === 'string' ? dayTime(value) : null;
    if (t === null) throw new BadRequestException(`${field} must be a real calendar date in MMDDYYYY form`);
    return t;
  }

  async create(opts: CreateSampleOptions): Promise<SampleDoc> {
    const name = assertSampleName(opts.name);
    const count = opts.count ?? 100;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
      throw new BadRequestException('count must be a positive integer');
    }
    const fromT = opts.from !== undefined ? this.assertDayKey('from', opts.from) : null;
    const toT = opts.to !== undefined ? this.assertDayKey('to', opts.to) : null;
    if (fromT !== null && toT !== null && fromT > toT) {
      throw new BadRequestException('"from" must be on or before "to"');
    }

    // Early duplicate check: fail a retried name before the pool scan. The
    // race-safe authority stays createSample's ALREADY_EXISTS mapping below.
    if (await this.repo.getSample(name)) {
      throw new ConflictException(`samples/${name} already exists — samples are write-once; create a new sample instead`);
    }

    const { pool, inRangeCount } = await this.eligible(fromT, toT);
    if (count > pool.length) {
      throw new UnprocessableEntityException(
        `count ${count} exceeds eligible pool of ${pool.length} days (${inRangeCount} committed days in range, ${pool.length} with complete candles)`,
      );
    }

    const doc: SampleDoc = {
      name,
      days: draw(pool, count).sort((a, b) => dayTime(a)! - dayTime(b)!),
      requestedCount: count,
      poolSize: pool.length,
      from: opts.from ?? null,
      to: opts.to ?? null,
      createdAt: new Date().toISOString(),
    };
    try {
      await this.repo.createSample(doc);
    } catch (err) {
      if ((err as { code?: number }).code === 6) {
        throw new ConflictException(`samples/${name} already exists — samples are write-once; create a new sample instead`);
      }
      throw err;
    }
    return doc;
  }

  async list(): Promise<SampleSummary[]> {
    const docs = await this.repo.listSamples();
    return docs.map((s) => ({
      name: s.name,
      count: s.days.length,
      poolSize: s.poolSize,
      firstDay: s.days[0],
      lastDay: s.days[s.days.length - 1],
      createdAt: s.createdAt,
    }));
  }

  async get(name: string): Promise<SampleDoc> {
    const valid = assertSampleName(name);
    const doc = await this.repo.getSample(valid);
    if (!doc) throw new NotFoundException(`No sample named ${valid}`);
    return doc;
  }

  /**
   * Pool = committed knowledge days (manifest scan) ∩ complete candle days
   * (stored coverage.rthComplete — written at ingest by the same
   * analyzeCoverage the benchmark run re-checks live). One projected query
   * per resolved quarterly contract; no per-day candle reads. Any error here
   * aborts the whole create — a sample is only drawn from a fully-scanned
   * pool, never a truncated one.
   */
  private async eligible(fromT: number | null, toT: number | null): Promise<{ pool: string[]; inRangeCount: number }> {
    const { listings } = await this.inputs.listDays();
    const inRange = listings.filter((d) => {
      const t = dayTime(d.day)!;
      return (fromT === null || t >= fromT) && (toT === null || t <= toT);
    });

    const byContract = new Map<string, DayListing[]>();
    for (const d of inRange) {
      const contract = resolveContract(SYMBOL, d.date);
      if (!byContract.has(contract)) byContract.set(contract, []);
      byContract.get(contract)!.push(d);
    }

    const pool: string[] = [];
    for (const [contract, days] of byContract) {
      const stored = await this.marketData.listStoredDays(contract, INTERVAL);
      const complete = new Set(stored.filter((s) => s.complete).map((s) => s.date));
      for (const d of days) if (complete.has(d.date)) pool.push(d.day);
    }
    return { pool, inRangeCount: inRange.length };
  }
}
