# Persisted Random Day Samples Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Named, write-once Firestore documents holding a random draw of benchmarkable days, plus a `sample` parameter on `POST /benchmark/run` that pins a run to those days.

**Architecture:** A new `SamplesService` in the existing `backend/src/benchmark` module builds its pool as the intersection of committed knowledge days (via a new narrow `CloudInputsService.listDays()`) and complete candle days (via `MarketDataService.listStoredDays` per resolved quarterly contract — projected queries, no per-day candle reads), draws uniformly (partial Fisher–Yates), and persists via three new methods on `BenchmarkRepository` (collection `samples`, Firestore `create()` for write-once). The controller exposes create/list/get under `/benchmark/samples`; `BenchmarkService.run` resolves `opts.sample` into the days filter **before** the single-flight lock. `SamplesService` must be in `BenchmarkModule`'s `exports` (not just `providers`) because `BenchmarkController` is declared in `AppModule`.

**Tech Stack:** NestJS 10, Firestore (`firebase-admin`), Jest + ts-jest (diagnostics ON — red phases are compile errors), supertest e2e via `pnpm test:e2e`.

**Spec:** `docs/superpowers/specs/2026-08-16-day-samples-design.md`

## Global Constraints

- Samples are **write-once**: Firestore `create()`, gRPC code 6 → HTTP 409, message "samples/<name> already exists — samples are write-once; create a new sample instead".
- `name` contract: string, `^[a-z0-9][a-z0-9-]*$`, ≤ 64 chars — enforced by one `assertName()` used by create, get, and run-sample resolution. Error message must state the actual pattern.
- `from`/`to`: real calendar dates in MMDDYYYY validated via `dayTime()` from `backend/src/eminiplayer/eminiplayer-validation.ts`; inclusive; `from > to` → 400.
- Request bodies are unvalidated JSON (no `ValidationPipe` exists): `typeof`-guard every field before calling string/number methods on it.
- Day keys are `MMDDYYYY` in the API; dates are `YYYY-MM-DD` internally.
- Semantic commit messages; no Claude/AI attributions in commits.
- **cwd conventions:** `pnpm jest` and `pnpm test:e2e` run from `backend/`; **git commands run from the repo root** (`/Users/nicholasstelter/Code/foster-bridge`).
- Red-phase expectations: ts-jest fails the whole suite with TS errors (e.g. `TS2339`) when a symbol doesn't exist yet — do NOT expect runtime "is not a function", and do NOT "fix" compile errors with `as any`.

---

### Task 1: Repository sample persistence

**Files:**
- Modify: `backend/src/benchmark/benchmark.repository.ts` (add `SampleDoc`, `SAMPLES` collection, three methods after `getScoreboard`)
- Test: `backend/src/benchmark/benchmark.repository.spec.ts`

**Interfaces:**
- Consumes: existing `FIRESTORE`-injected `db`, `test/fake-firestore` (its `doc().create()` rejects with `{ code: 6 }` on duplicates; `doc().get()` returns `{ exists, data() }`; `collection().get()` returns `{ docs }`).
- Produces (Tasks 2 and 4 rely on these exact signatures):
  - `interface SampleDoc { name: string; days: string[]; requestedCount: number; poolSize: number; from: string | null; to: string | null; createdAt: string }`
  - `createSample(doc: SampleDoc): Promise<void>` — throws the raw Firestore error (code 6 on duplicate; callers map it).
  - `getSample(name: string): Promise<SampleDoc | null>`
  - `listSamples(): Promise<SampleDoc[]>`

- [ ] **Step 1: Write the failing tests** — append inside the existing `describe('BenchmarkRepository')` in `benchmark.repository.spec.ts`:

```ts
  describe('samples', () => {
    const sample = {
      name: 's1-2025-2026',
      days: ['01062025', '03042026'],
      requestedCount: 2,
      poolSize: 300,
      from: null,
      to: null,
      createdAt: '2026-08-16T00:00:00.000Z',
    };

    it('createSample persists and getSample round-trips', async () => {
      const { repo } = await build();
      await repo.createSample(sample);
      expect(await repo.getSample('s1-2025-2026')).toEqual(sample);
    });

    it('getSample returns null for an unknown name', async () => {
      const { repo } = await build();
      expect(await repo.getSample('nope')).toBeNull();
    });

    it('createSample rejects a duplicate name with Firestore code 6', async () => {
      const { repo } = await build();
      await repo.createSample(sample);
      await expect(repo.createSample({ ...sample, days: ['07012025'] })).rejects.toMatchObject({ code: 6 });
    });

    it('listSamples returns all stored samples', async () => {
      const { repo } = await build();
      await repo.createSample(sample);
      await repo.createSample({ ...sample, name: 's2' });
      const names = (await repo.listSamples()).map((s) => s.name).sort();
      expect(names).toEqual(['s1-2025-2026', 's2']);
    });
  });
```

- [ ] **Step 2: Run to verify failure**

Run (from `backend/`): `pnpm jest src/benchmark/benchmark.repository.spec.ts`
Expected: suite FAILS TO COMPILE with `TS2339: Property 'createSample' does not exist on type 'BenchmarkRepository'` (ts-jest diagnostics; no tests execute).

- [ ] **Step 3: Implement** — in `benchmark.repository.ts`, next to the other collection constants add `const SAMPLES = 'samples';`; export the interface (near the other exported interfaces) and add the methods at the end of the class:

```ts
export interface SampleDoc {
  name: string;
  days: string[]; // MMDDYYYY keys, sorted chronologically
  requestedCount: number;
  poolSize: number; // eligible days at creation time
  from: string | null; // requested range bound, if any
  to: string | null;
  createdAt: string;
}
```

```ts
  /** Write-once; duplicate create surfaces the raw ALREADY_EXISTS (code 6) for the caller to map. */
  async createSample(doc: SampleDoc): Promise<void> {
    await this.db.collection(SAMPLES).doc(doc.name).create(doc as any);
  }

  async getSample(name: string): Promise<SampleDoc | null> {
    const snap = await this.db.collection(SAMPLES).doc(name).get();
    return snap.exists ? (snap.data() as SampleDoc) : null;
  }

  async listSamples(): Promise<SampleDoc[]> {
    const snap = await this.db.collection(SAMPLES).get();
    return snap.docs.map((d) => d.data() as SampleDoc);
  }
```

- [ ] **Step 4: Run to verify pass**

Run (from `backend/`): `pnpm jest src/benchmark/benchmark.repository.spec.ts`
Expected: PASS (all tests in the file, pre-existing plus the 4 new).

- [ ] **Step 5: Commit** (from the repo root)

```bash
git add backend/src/benchmark/benchmark.repository.ts backend/src/benchmark/benchmark.repository.spec.ts
git commit -m "feat(benchmark): sample persistence in repository"
```

---

### Task 2: `CloudInputsService.listDays()` + `SamplesService` + module wiring

**Files:**
- Modify: `backend/src/benchmark/cloud-inputs.service.ts` (one public method after `snapshot()`)
- Create: `backend/src/benchmark/samples.service.ts`
- Modify: `backend/src/benchmark/benchmark.module.ts` (add `SamplesService` to **both** `providers` and `exports`)
- Test: `backend/src/benchmark/cloud-inputs.service.spec.ts`, `backend/src/benchmark/samples.service.spec.ts`

**Interfaces:**
- Consumes: `BenchmarkRepository.createSample/getSample/listSamples` + `SampleDoc` (Task 1); private `scanDays()` and `wrap()` in `cloud-inputs.service.ts`; `MarketDataService.listStoredDays(symbol, interval)` → `{ date: string; count: number; complete: boolean }[]` (`market-data.service.ts:63`); `ContractsService` (only injected transitively by MarketDataService — SamplesService itself does NOT need it); `resolveContract` from `../contracts/contracts-roll`; `dayTime` from `../eminiplayer/eminiplayer-validation`.
- Produces (Tasks 3 and 4 rely on):
  - `CloudInputsService.listDays(): Promise<{ listings: DayListing[]; issues: DayIssue[] }>`
  - `interface CreateSampleOptions { name: string; count?: number; from?: string; to?: string }`
  - `interface SampleSummary { name: string; count: number; poolSize: number; firstDay: string; lastDay: string; createdAt: string }`
  - `SamplesService.create(opts: CreateSampleOptions): Promise<SampleDoc>` — 400 bad name/count/range, 409 duplicate (early check + create race), 422 count > pool with diagnostics.
  - `SamplesService.list(): Promise<SampleSummary[]>`
  - `SamplesService.get(name: string): Promise<SampleDoc>` — 400 invalid name, 404 unknown.
  - `assertSampleName(name: unknown): string` — exported module-level function (throws `BadRequestException`); Task 4's run path imports it so user input never reaches a Firestore doc id unvalidated.

- [ ] **Step 1a: Write the failing `listDays` test** — append inside `describe('CloudInputsService (firestore half)')` (or as a new top-level describe) in `cloud-inputs.service.spec.ts`. The existing file constructs the service directly with `fakeDb`/`fakeBucket` helpers defined at the top:

```ts
describe('CloudInputsService.listDays', () => {
  it('returns the day scan without reading traders, features, or general docs', async () => {
    const svc = new CloudInputsService(fakeDb({}), fakeBucket());
    const scan = { listings: [{ day: '07012026', date: '2026-07-01', prefix: '07012026', recapDate: '06302026', fileSha256: { tradePlanMd: 'a', tradePlanPdf: 'b', recap: 'c' } }], issues: [] };
    const scanSpy = jest.spyOn(svc as any, 'scanDays').mockResolvedValue(scan);
    const tradersSpy = jest.spyOn(svc, 'collectTraders');
    expect(await svc.listDays()).toEqual(scan);
    expect(scanSpy).toHaveBeenCalledTimes(1);
    expect(tradersSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 1b: Write the failing `SamplesService` tests** — create `samples.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { SamplesService } from './samples.service';
import { BenchmarkRepository } from './benchmark.repository';
import { CloudInputsService } from './cloud-inputs.service';
import { MarketDataService } from '../market-data/market-data.service';
import { resolveContract } from '../contracts/contracts-roll';

// Ten committed days across 2025-2026 (MMDDYYYY keys, chronological order).
const DAYS = [
  ['01062025', '2025-01-06'], ['02032025', '2025-02-03'], ['03102025', '2025-03-10'],
  ['06022025', '2025-06-02'], ['09082025', '2025-09-08'], ['12012025', '2025-12-01'],
  ['01052026', '2026-01-05'], ['03022026', '2026-03-02'], ['06012026', '2026-06-01'],
  ['08032026', '2026-08-03'],
] as const;

function makeDeps() {
  const repo = {
    createSample: jest.fn().mockResolvedValue(undefined),
    getSample: jest.fn().mockResolvedValue(null),
    listSamples: jest.fn().mockResolvedValue([]),
  };
  const inputs = {
    listDays: jest.fn().mockResolvedValue({
      listings: DAYS.map(([day, date]) => ({ day, date, prefix: day, recapDate: day, fileSha256: { tradePlanMd: 'a', tradePlanPdf: 'b', recap: 'c' } })),
      issues: [],
    }),
  };
  // Every stored day complete by default; keyed per contract symbol on demand.
  const marketData = {
    listStoredDays: jest.fn(async (contract: string, _interval: string) =>
      DAYS.filter(([, date]) => resolveContract('ES', date) === contract).map(([, date]) => ({ date, count: 390, complete: true })),
    ),
  };
  return { repo, inputs, marketData };
}

async function build(deps: ReturnType<typeof makeDeps>) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      SamplesService,
      { provide: BenchmarkRepository, useValue: deps.repo },
      { provide: CloudInputsService, useValue: deps.inputs },
      { provide: MarketDataService, useValue: deps.marketData },
    ],
  }).compile();
  return moduleRef.get(SamplesService);
}

describe('SamplesService.create', () => {
  beforeEach(() => jest.clearAllMocks());

  it('draws count distinct pool days, sorted chronologically, and persists', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    const doc = await svc.create({ name: 's1', count: 4 });
    expect(doc.days).toHaveLength(4);
    expect(new Set(doc.days).size).toBe(4);
    const poolKeys = DAYS.map(([day]) => day);
    for (const d of doc.days) expect(poolKeys).toContain(d);
    // Chronological: the stored order matches the pool's own chronological order.
    expect(doc.days).toEqual(poolKeys.filter((d) => doc.days.includes(d)));
    expect(doc).toMatchObject({ name: 's1', requestedCount: 4, poolSize: 10, from: null, to: null });
    expect(deps.repo.createSample).toHaveBeenCalledWith(doc);
  });

  it('count defaults to 100 and 422s with diagnostics when it exceeds the pool', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    await expect(svc.create({ name: 's1' })).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(svc.create({ name: 's1' })).rejects.toThrow(/count 100 exceeds eligible pool of 10 days \(10 committed days in range, 10 with complete candles\)/);
  });

  it('excludes days whose stored coverage is missing or incomplete', async () => {
    const deps = makeDeps();
    deps.marketData.listStoredDays.mockImplementation(async (contract: string) =>
      DAYS.filter(([, date]) => resolveContract('ES', date) === contract)
        .filter(([, date]) => date !== '2025-01-06') // no stored day at all
        .map(([, date]) => ({ date, count: 390, complete: date !== '2025-02-03' })), // stored but incomplete
    );
    const svc = await build(deps);
    const doc = await svc.create({ name: 's1', count: 8 });
    expect(doc.poolSize).toBe(8);
    expect(doc.days).not.toContain('01062025');
    expect(doc.days).not.toContain('02032025');
  });

  it('queries listStoredDays once per resolved contract, not per day', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    await svc.create({ name: 's1', count: 4 });
    const contracts = new Set(DAYS.map(([, date]) => resolveContract('ES', date)));
    expect(deps.marketData.listStoredDays).toHaveBeenCalledTimes(contracts.size);
  });

  it('honours from/to bounds inclusively', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    const doc = await svc.create({ name: 's1', count: 3, from: '06022025', to: '01052026' });
    // Eligible window: 06022025, 09082025, 12012025, 01052026 -> poolSize 4.
    expect(doc.poolSize).toBe(4);
    for (const d of doc.days) expect(['06022025', '09082025', '12012025', '01052026']).toContain(d);
  });

  it('rejects bad names, counts, and ranges with 400 before any I/O', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    await expect(svc.create({ name: '' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create({ name: 'Bad Name!' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create({ name: 123 as any })).rejects.toBeInstanceOf(BadRequestException); // non-string, no TypeError
    await expect(svc.create({ name: 'x'.repeat(65) })).rejects.toBeInstanceOf(BadRequestException); // length cap
    await expect(svc.create({ name: 's1', count: 0 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create({ name: 's1', count: 2.5 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create({ name: 's1', count: '5' as any })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create({ name: 's1', count: 2, from: '2025-01-06' })).rejects.toBeInstanceOf(BadRequestException); // wrong shape
    await expect(svc.create({ name: 's1', count: 2, from: '20250101' })).rejects.toBeInstanceOf(BadRequestException); // YYYYMMDD
    await expect(svc.create({ name: 's1', count: 2, from: '13322025' })).rejects.toBeInstanceOf(BadRequestException); // not a real date
    await expect(svc.create({ name: 's1', count: 2, from: 1012025 as any })).rejects.toBeInstanceOf(BadRequestException); // non-string
    await expect(svc.create({ name: 's1', count: 2, from: '12312026', to: '01012025' })).rejects.toBeInstanceOf(BadRequestException); // inverted
    expect(deps.inputs.listDays).not.toHaveBeenCalled();
    expect(deps.repo.createSample).not.toHaveBeenCalled();
  });

  it('409s an existing name early, before computing the pool', async () => {
    const deps = makeDeps();
    deps.repo.getSample.mockResolvedValue({ name: 's1', days: ['01062025'], requestedCount: 1, poolSize: 1, from: null, to: null, createdAt: 't' });
    const svc = await build(deps);
    await expect(svc.create({ name: 's1', count: 2 })).rejects.toBeInstanceOf(ConflictException);
    expect(deps.inputs.listDays).not.toHaveBeenCalled();
  });

  it('maps a create-time duplicate race (code 6) to 409', async () => {
    const deps = makeDeps();
    deps.repo.createSample.mockRejectedValue(Object.assign(new Error('exists'), { code: 6 }));
    const svc = await build(deps);
    await expect(svc.create({ name: 's1', count: 2 })).rejects.toBeInstanceOf(ConflictException);
  });

  it('aborts the whole create when a pool query fails — nothing persisted', async () => {
    const deps = makeDeps();
    deps.marketData.listStoredDays.mockRejectedValue(new Error('firestore blip'));
    const svc = await build(deps);
    await expect(svc.create({ name: 's1', count: 2 })).rejects.toThrow('firestore blip');
    expect(deps.repo.createSample).not.toHaveBeenCalled();
  });

  it('is deterministic under a mocked Math.random', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    const rnd = jest.spyOn(Math, 'random').mockReturnValue(0); // j === i every swap -> first N pool days
    const doc = await svc.create({ name: 's1', count: 3 });
    expect(doc.days).toEqual(['01062025', '02032025', '03102025']);
    rnd.mockRestore();
  });
});

describe('SamplesService.list / get', () => {
  it('list returns summaries with first/last day', async () => {
    const deps = makeDeps();
    deps.repo.listSamples.mockResolvedValue([
      { name: 's1', days: ['01062025', '08032026'], requestedCount: 2, poolSize: 10, from: null, to: null, createdAt: 't' },
    ]);
    const svc = await build(deps);
    expect(await svc.list()).toEqual([
      { name: 's1', count: 2, poolSize: 10, firstDay: '01062025', lastDay: '08032026', createdAt: 't' },
    ]);
  });

  it('get returns the doc, 400s an invalid name, 404s an unknown name', async () => {
    const deps = makeDeps();
    const doc = { name: 's1', days: ['01062025'], requestedCount: 1, poolSize: 10, from: null, to: null, createdAt: 't' };
    deps.repo.getSample.mockImplementation(async (n: string) => (n === 's1' ? doc : null));
    const svc = await build(deps);
    expect(await svc.get('s1')).toEqual(doc);
    await expect(svc.get('nope')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.get('a/b')).rejects.toBeInstanceOf(BadRequestException); // never reaches Firestore as a doc id
    await expect(svc.get('..')).rejects.toBeInstanceOf(BadRequestException);
    expect(deps.repo.getSample).toHaveBeenCalledTimes(2); // only the two valid names
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run (from `backend/`): `pnpm jest src/benchmark/cloud-inputs.service.spec.ts src/benchmark/samples.service.spec.ts`
Expected: `cloud-inputs.service.spec.ts` FAILS TO COMPILE with `TS2339: Property 'listDays' does not exist on type 'CloudInputsService'`; `samples.service.spec.ts` fails to resolve `./samples.service`.

- [ ] **Step 3a: Implement `listDays`** — in `cloud-inputs.service.ts`, directly below `snapshot()`:

```ts
  /**
   * Day listings only — no trader/feature/general-doc reads. For consumers
   * (sampling) that need the committed corpus without inheriting the run's
   * full input-availability failure surface.
   */
  async listDays(): Promise<{ listings: DayListing[]; issues: DayIssue[] }> {
    return this.wrap(() => this.scanDays());
  }
```

- [ ] **Step 3b: Implement `SamplesService`** — create `samples.service.ts`:

```ts
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
```

- [ ] **Step 3c: Wire the module** — in `benchmark.module.ts` add `import { SamplesService } from './samples.service';`, add `SamplesService,` to `providers`, **and add it to `exports`** (`exports: [BenchmarkService, ScoreboardService, BenchmarkRepository, SamplesService]`). This is load-bearing: `BenchmarkController` is declared in `AppModule` (`app.module.ts:54`) and resolves its deps from this module's exports — providers alone means the app fails to boot, and only the e2e suite would catch it.

- [ ] **Step 4: Run to verify pass**

Run (from `backend/`): `pnpm jest src/benchmark/cloud-inputs.service.spec.ts src/benchmark/samples.service.spec.ts`
Expected: PASS — 1 new `listDays` test and 13 `samples.service` tests (11 create + 2 list/get).

- [ ] **Step 5: Commit** (from the repo root)

```bash
git add backend/src/benchmark/cloud-inputs.service.ts backend/src/benchmark/cloud-inputs.service.spec.ts backend/src/benchmark/samples.service.ts backend/src/benchmark/samples.service.spec.ts backend/src/benchmark/benchmark.module.ts
git commit -m "feat(benchmark): SamplesService draws persisted random day samples"
```

---

### Task 3: Sample endpoints on the benchmark controller (+ e2e)

**Files:**
- Modify: `backend/src/benchmark/benchmark.controller.ts`
- Test: `backend/src/benchmark/benchmark.controller.spec.ts`, `backend/test/benchmark.e2e-spec.ts`

**Interfaces:**
- Consumes: `SamplesService.create/list/get` (Task 2 signatures), `SampleDoc` (Task 1).
- Produces: `POST /benchmark/samples`, `GET /benchmark/samples`, `GET /benchmark/samples/:name` — thin pass-throughs; all error mapping lives in the service and must reach the client unaltered.

- [ ] **Step 1a: Write the failing unit tests** — in `benchmark.controller.spec.ts`, extend `build()`'s providers with a samples fake and return it. Add to `build()` (import `SamplesService` from `./samples.service` at the top):

```ts
  const samples = {
    create: jest.fn().mockResolvedValue({ name: 's1', days: ['01062025'], requestedCount: 1, poolSize: 10, from: null, to: null, createdAt: 't' }),
    list: jest.fn().mockResolvedValue([{ name: 's1', count: 1, poolSize: 10, firstDay: '01062025', lastDay: '01062025', createdAt: 't' }]),
    get: jest.fn().mockResolvedValue({ name: 's1', days: ['01062025'], requestedCount: 1, poolSize: 10, from: null, to: null, createdAt: 't' }),
  };
```

register `{ provide: SamplesService, useValue: samples }`, add `samples` to `build()`'s return object, and append:

```ts
describe('BenchmarkController samples', () => {
  it('POST /benchmark/samples forwards the body to the service', async () => {
    const { ctrl, samples } = await build();
    const res = await ctrl.createSample({ name: 's1', count: 100, from: '01012025', to: '12312026' });
    expect(samples.create).toHaveBeenCalledWith({ name: 's1', count: 100, from: '01012025', to: '12312026' });
    expect(res.name).toBe('s1');
  });

  it('GET /benchmark/samples lists summaries', async () => {
    const { ctrl, samples } = await build();
    const res = await ctrl.listSamples();
    expect(samples.list).toHaveBeenCalled();
    expect(res[0].name).toBe('s1');
  });

  it('GET /benchmark/samples/:name fetches one sample', async () => {
    const { ctrl, samples } = await build();
    const res = await ctrl.getSample('s1');
    expect(samples.get).toHaveBeenCalledWith('s1');
    expect(res.days).toEqual(['01062025']);
  });

  it('service errors pass through unwrapped', async () => {
    const { ctrl, samples } = await build();
    const conflict = new ConflictException('exists');
    samples.create.mockRejectedValue(conflict);
    await expect(ctrl.createSample({ name: 's1' })).rejects.toBe(conflict);
    const notFound = new NotFoundException('nope');
    samples.get.mockRejectedValue(notFound);
    await expect(ctrl.getSample('nope')).rejects.toBe(notFound);
  });
});
```

(`ConflictException` needs adding to the spec's existing `@nestjs/common` import alongside `NotFoundException`.)

- [ ] **Step 1b: Write the failing e2e test** — in `backend/test/benchmark.e2e-spec.ts`, append inside `describe('Benchmark (e2e)')` (it already has `boot()`, `fullCsv`, and a candle-ingest pattern; day `07012026` is the seeded committed day):

```ts
  it('samples: create over HTTP, list, get, 404/400/409 semantics', async () => {
    await boot();
    // Complete candles for the one committed day -> pool of exactly 1.
    await request(app.getHttpServer()).post('/markets/ESU26/min-1/candles').attach('file', Buffer.from(fullCsv), 'es.csv').expect(201);

    const created = await request(app.getHttpServer()).post('/benchmark/samples').send({ name: 's1', count: 1 }).expect(201);
    expect(created.body.days).toEqual(['07012026']);
    expect(created.body.poolSize).toBe(1);

    const listed = await request(app.getHttpServer()).get('/benchmark/samples').expect(200);
    expect(listed.body).toEqual([expect.objectContaining({ name: 's1', count: 1 })]);

    const fetched = await request(app.getHttpServer()).get('/benchmark/samples/s1').expect(200);
    expect(fetched.body.days).toEqual(['07012026']);

    await request(app.getHttpServer()).get('/benchmark/samples/nope').expect(404);
    await request(app.getHttpServer()).post('/benchmark/samples').send({ name: 'Bad Name!' }).expect(400);
    await request(app.getHttpServer()).post('/benchmark/samples').send({ name: 's1', count: 1 }).expect(409);
    await request(app.getHttpServer()).post('/benchmark/samples').send({ name: 's2', count: 5 }).expect(422);
  });
```

- [ ] **Step 2: Run to verify failure**

Run (from `backend/`): `pnpm jest src/benchmark/benchmark.controller.spec.ts`
Expected: suite FAILS TO COMPILE with `TS2339: Property 'createSample' does not exist on type 'BenchmarkController'`. (Defer the e2e run to Step 4 — it fails for the same missing routes.)

- [ ] **Step 3: Implement** — in `benchmark.controller.ts`: add `Param` to the `@nestjs/common` import; add `import { SamplesService, CreateSampleOptions, SampleSummary } from './samples.service';` and extend the repository import to include `SampleDoc` (`import { BenchmarkRepository, ScoreboardDoc, SampleDoc } from './benchmark.repository';`); inject `private readonly samples: SamplesService` in the constructor; add below `scoreboard()`:

```ts
  @Post('samples')
  async createSample(@Body() body: CreateSampleOptions): Promise<SampleDoc> {
    return this.samples.create(body);
  }

  @Get('samples')
  async listSamples(): Promise<SampleSummary[]> {
    return this.samples.list();
  }

  @Get('samples/:name')
  async getSample(@Param('name') name: string): Promise<SampleDoc> {
    return this.samples.get(name);
  }
```

- [ ] **Step 4: Run to verify pass — unit AND e2e**

Run (from `backend/`): `pnpm jest src/benchmark/benchmark.controller.spec.ts`
Expected: PASS (all tests, old and new).
Run (from `backend/`): `pnpm test:e2e`
Expected: PASS — this boots `AppModule` and is the step that proves the module wiring from Task 2 Step 3c (a `providers`-only registration dies here with "Nest can't resolve dependencies of the BenchmarkController").

- [ ] **Step 5: Commit** (from the repo root)

```bash
git add backend/src/benchmark/benchmark.controller.ts backend/src/benchmark/benchmark.controller.spec.ts backend/test/benchmark.e2e-spec.ts
git commit -m "feat(benchmark): sample create/list/get endpoints"
```

---

### Task 4: `sample` parameter on the benchmark run + docs

**Files:**
- Modify: `backend/src/benchmark/benchmark.service.ts` (`RunOptions`, `run()`, `runInner` day-filter block)
- Modify: `backend/src/benchmark/benchmark.controller.ts` (`RunBody` + pass-through)
- Modify: `CLAUDE.md` (repo root — benchmark section)
- Test: `backend/src/benchmark/benchmark.service.spec.ts`, `backend/src/benchmark/benchmark.controller.spec.ts`

**Interfaces:**
- Consumes: `BenchmarkRepository.getSample` (Task 1).
- Produces: `RunOptions.sample?: string`, resolved in `run()` BEFORE the single-flight lock: `sample`+`days` → `BadRequestException`; unknown → `NotFoundException`; empty resolved `days` → `UnprocessableEntityException`; sampled days missing from the snapshot reported in `daysSkipped`.

- [ ] **Step 1: Write the failing tests** — in `benchmark.service.spec.ts`: add `getSample: jest.fn().mockResolvedValue(null),` to the `repo` object in `makeDeps()`; extend the existing `@nestjs/common` import on line 2 to `import { BadRequestException, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';`; then add these tests **inside** `describe('BenchmarkService.run', ...)`, after its last `it` (placement matters — the describe's `beforeEach` sets the `analyzeCoverage` mock these tests depend on):

```ts
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
```

In `benchmark.controller.spec.ts`, update the existing forwarding test:

```ts
    const res = await ctrl.run({ model: 'fable', runCount: 3, variants: ['base'], sample: 's1' });
    expect(service.run).toHaveBeenCalledWith({ model: 'fable', runCount: 3, variants: ['base'], days: undefined, sample: 's1' });
```

- [ ] **Step 2: Run to verify failure**

Run (from `backend/`): `pnpm jest src/benchmark/benchmark.service.spec.ts src/benchmark/benchmark.controller.spec.ts`
Expected: both suites FAIL TO COMPILE — `TS2353: Object literal may only specify known properties, and 'sample' does not exist in type 'RunOptions'` (and the same for `RunBody`). No assertions execute at this step; do not "fix" the compile error with `as any`.

- [ ] **Step 3: Implement** — in `benchmark.service.ts`:

1. Add to `RunOptions`: `sample?: string; // name of a persisted day sample; mutually exclusive with days`.
2. Extend the `@nestjs/common` import with `BadRequestException, NotFoundException` (keep existing names; `UnprocessableEntityException` and `ConflictException` are already imported), and add `import { assertSampleName } from './samples.service';`.
3. Replace `run()` so resolution happens BEFORE the single-flight lock:

```ts
  async run(opts: RunOptions = {}): Promise<RunSummary> {
    // Sample resolution and mutual exclusion live OUTSIDE the single-flight
    // lock and BEFORE any snapshot/drift work: a malformed request must never
    // surface as a drift 409 or in-progress 409, cost a corpus read, or hold
    // the lock (see the day-samples design doc, §4).
    let daysFilter = opts.days;
    if (opts.sample !== undefined) {
      if (opts.days?.length) throw new BadRequestException('sample and days are mutually exclusive — a sample IS a days filter');
      const sampleName = assertSampleName(opts.sample);
      const sampleDoc = await this.repo.getSample(sampleName);
      if (!sampleDoc) throw new NotFoundException(`No sample named ${sampleName}`);
      if (!sampleDoc.days.length) throw new UnprocessableEntityException(`sample ${opts.sample} has no days — refusing to fall through to a full-corpus run`);
      daysFilter = sampleDoc.days;
    }
    // Single-flight: two concurrent runs racing ensureKeys can orphan a
    // submitted batch's pinned KEYS hash (last-write-wins saveKeysArtifact) —
    // a permanent per-day wedge. Same posture as BatchReconciler's guard.
    if (this.runInProgress) throw new ConflictException('a benchmark run is already in progress');
    this.runInProgress = true;
    try {
      return await this.runInner(opts, daysFilter);
    } finally {
      this.runInProgress = false;
    }
  }
```

4. Change `runInner`'s signature to `private async runInner(opts: RunOptions, daysFilter?: string[]): Promise<RunSummary>` and replace its day-filter block

```ts
    let days = snap.days;
    if (opts.days?.length) days = days.filter((d) => opts.days!.includes(d.day));
```

with

```ts
    let days = snap.days;
    if (daysFilter?.length) days = days.filter((d) => daysFilter.includes(d.day));
```

and the later issues filter

```ts
    let issues = snap.issues;
    if (opts.days?.length) issues = issues.filter((i) => opts.days!.includes(i.day));
```

with

```ts
    let issues = snap.issues;
    if (daysFilter?.length) issues = issues.filter((i) => daysFilter.includes(i.day));
```

5. Immediately after the `daysSkipped` push-loop over `issues`, add the sample-observability report (only when a sample was used — `opts.sample` is still in scope):

```ts
    // A sampled day with no snapshot listing must be reported, not silently
    // dropped: a 94-of-100-day run would otherwise masquerade as the full row.
    if (opts.sample !== undefined) {
      for (const d of daysFilter ?? []) {
        if (!snap.days.some((l) => l.day === d)) {
          summary.daysSkipped.push({ day: d, reason: 'sample day not in snapshot' });
        }
      }
    }
```

In `benchmark.controller.ts`: add `sample?: string;` to `RunBody` and `sample: body.sample,` to the `this.benchmark.run({...})` call.

In `CLAUDE.md` (repo root), under the Benchmark section's endpoint block, add:

```
POST /benchmark/samples        body: { name, count? (default 100), from?, to? (MMDDYYYY) }
                               draws a write-once random sample of benchmarkable
                               days (committed manifests ∩ complete candle days)
GET  /benchmark/samples        list sample summaries
GET  /benchmark/samples/:name  full day list
```

and note on `POST /benchmark/run`: `sample: "<name>"` pins the run to a persisted sample's days (mutually exclusive with `days`; resolved before the run lock, so bad requests 400/404 instead of 409).

- [ ] **Step 4: Run to verify pass, then the full suites**

Run (from `backend/`): `pnpm jest src/benchmark/benchmark.service.spec.ts src/benchmark/benchmark.controller.spec.ts`
Expected: PASS.
Run (from `backend/`): `pnpm jest`
Expected: all unit suites pass.
Run (from `backend/`): `pnpm test:e2e`
Expected: all e2e suites pass (boots `AppModule`).

- [ ] **Step 5: Commit** (from the repo root)

```bash
git add backend/src/benchmark/benchmark.service.ts backend/src/benchmark/benchmark.controller.ts backend/src/benchmark/benchmark.service.spec.ts backend/src/benchmark/benchmark.controller.spec.ts CLAUDE.md
git commit -m "feat(benchmark): pin runs to a persisted day sample"
```

---

## Post-implementation (manual, after all tasks)

Not part of the coded tasks — done once against the live backend, no benchmark run:

1. `curl -X POST localhost:3000/benchmark/samples -H 'Content-Type: application/json' -d '{"name":"s1-2025-2026","count":100}'` — creates the first sample from the current 2025–2026 pool. Read `poolSize` off the response (do not assume the day counts quoted in the spec's Context section — they were a point-in-time bucket listing).
2. `curl localhost:3000/benchmark/samples/s1-2025-2026` — verify 100 chronological days.
3. Do NOT `POST /benchmark/run` — deferred at the user's request.
