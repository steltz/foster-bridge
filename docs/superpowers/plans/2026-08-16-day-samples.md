# Persisted Random Day Samples Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Named, write-once Firestore documents holding a random draw of benchmarkable days, plus a `sample` parameter on `POST /benchmark/run` that pins a run to those days.

**Architecture:** A new `SamplesService` in the existing `backend/src/benchmark` module draws uniformly (partial Fisher–Yates) from the pool of committed-manifest days that pass the run's own candle-coverage prerequisite, and persists the draw via three new methods on `BenchmarkRepository` (collection `samples`, document id = name, Firestore `create()` for write-once). The controller exposes create/list/get under `/benchmark/samples`, and `BenchmarkService.runInner` resolves `opts.sample` into the existing days filter.

**Tech Stack:** NestJS 10, Firestore (`firebase-admin`), Jest with the repo's `test/fake-firestore` helper.

**Spec:** `docs/superpowers/specs/2026-08-16-day-samples-design.md`

## Global Constraints

- Samples are **write-once**: Firestore `create()`, gRPC code 6 → HTTP 409, message pattern matches `content.service.ts` ("… already exists — samples are write-once; create a new sample instead").
- Day keys are `MMDDYYYY` strings everywhere in the API; dates are `YYYY-MM-DD` internally.
- No seed persistence; reproducibility comes from the stored `days` array.
- Semantic commit messages; no Claude/AI attributions in commits.
- All commands run from `backend/`; test with `pnpm jest <paths>`.

---

### Task 1: Repository sample persistence

**Files:**
- Modify: `backend/src/benchmark/benchmark.repository.ts` (add `SampleDoc`, `SAMPLES` collection, three methods after `getScoreboard`)
- Test: `backend/src/benchmark/benchmark.repository.spec.ts`

**Interfaces:**
- Consumes: existing `FIRESTORE`-injected `db`, `test/fake-firestore`.
- Produces (Tasks 2 and 4 rely on these exact signatures):
  - `interface SampleDoc { name: string; days: string[]; requestedCount: number; poolSize: number; from: string | null; to: string | null; createdAt: string }`
  - `createSample(doc: SampleDoc): Promise<void>` — throws the raw Firestore error (code 6 on duplicate; callers map it).
  - `getSample(name: string): Promise<SampleDoc | null>`
  - `listSamples(): Promise<SampleDoc[]>`

- [ ] **Step 1: Write the failing tests** — append to `benchmark.repository.spec.ts`:

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

Run: `pnpm jest src/benchmark/benchmark.repository.spec.ts`
Expected: FAIL — `repo.createSample is not a function`.

- [ ] **Step 3: Implement** — in `benchmark.repository.ts`, next to the other collection constants add `const SAMPLES = 'samples';`; export the interface and add the methods at the end of the class:

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

Run: `pnpm jest src/benchmark/benchmark.repository.spec.ts`
Expected: PASS (all suites in the file).

- [ ] **Step 5: Commit**

```bash
git add backend/src/benchmark/benchmark.repository.ts backend/src/benchmark/benchmark.repository.spec.ts
git commit -m "feat(benchmark): sample persistence in repository"
```

---

### Task 2: SamplesService

**Files:**
- Create: `backend/src/benchmark/samples.service.ts`
- Modify: `backend/src/benchmark/benchmark.module.ts` (add `SamplesService` to `providers`)
- Test: `backend/src/benchmark/samples.service.spec.ts`

**Interfaces:**
- Consumes: `BenchmarkRepository.createSample/getSample/listSamples` and `SampleDoc` (Task 1); `CloudInputsService.snapshot()` (`snap.days: DayListing[]` with `{ day: 'MMDDYYYY', date: 'YYYY-MM-DD', ... }`); `MarketDataService.getDay(symbol, 'min-1', date)`; `ContractsService.get('ES')` (`{ rth: { open, close }, timezone }`); `resolveContract` from `../contracts/contracts-roll`; `analyzeCoverage` from `../market-data/coverage`; `intervalToSeconds` from `../market-data/candle`; `hhmmToMinutes` from `../common/session-time`.
- Produces (Task 3 relies on):
  - `interface CreateSampleOptions { name: string; count?: number; from?: string; to?: string }`
  - `interface SampleSummary { name: string; count: number; poolSize: number; firstDay: string; lastDay: string; createdAt: string }`
  - `create(opts: CreateSampleOptions): Promise<SampleDoc>` — 400 bad name/count/range, 422 count > pool, 409 duplicate.
  - `list(): Promise<SampleSummary[]>`
  - `get(name: string): Promise<SampleDoc>` — 404 unknown.

- [ ] **Step 1: Write the failing tests** — create `samples.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { SamplesService } from './samples.service';
import { BenchmarkRepository } from './benchmark.repository';
import { CloudInputsService } from './cloud-inputs.service';
import { MarketDataService } from '../market-data/market-data.service';
import { ContractsService } from '../contracts/contracts.service';
import { analyzeCoverage } from '../market-data/coverage';

jest.mock('../market-data/coverage', () => ({ analyzeCoverage: jest.fn() }));

// Ten listing days across 2025-2026 (MMDDYYYY keys, chronological order).
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
    snapshot: jest.fn().mockResolvedValue({
      days: DAYS.map(([day, date]) => ({ day, date, prefix: day, recapDate: day, fileSha256: {} })),
    }),
  };
  const marketData = { getDay: jest.fn().mockResolvedValue([{ time: 1 }]) };
  const contracts = { get: jest.fn(() => ({ rth: { open: '09:30', close: '16:00' }, timezone: 'America/New_York', pointValue: 5 })) };
  return { repo, inputs, marketData, contracts };
}

async function build(deps: ReturnType<typeof makeDeps>) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      SamplesService,
      { provide: BenchmarkRepository, useValue: deps.repo },
      { provide: CloudInputsService, useValue: deps.inputs },
      { provide: MarketDataService, useValue: deps.marketData },
      { provide: ContractsService, useValue: deps.contracts },
    ],
  }).compile();
  return moduleRef.get(SamplesService);
}

describe('SamplesService.create', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (analyzeCoverage as jest.Mock).mockReturnValue({ complete: true });
  });

  it('draws count distinct pool days, sorted chronologically, and persists', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    const doc = await svc.create({ name: 's1', count: 4 });
    expect(doc.days).toHaveLength(4);
    expect(new Set(doc.days).size).toBe(4);
    const poolKeys = DAYS.map(([day]) => day);
    for (const d of doc.days) expect(poolKeys).toContain(d);
    // Chronological: the stored order matches the pool's own chronological order.
    const inPoolOrder = poolKeys.filter((d) => doc.days.includes(d));
    expect(doc.days).toEqual(inPoolOrder);
    expect(doc).toMatchObject({ name: 's1', requestedCount: 4, poolSize: 10, from: null, to: null });
    expect(deps.repo.createSample).toHaveBeenCalledWith(doc);
  });

  it('count defaults to 100 and is rejected with 422 when it exceeds the pool', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    await expect(svc.create({ name: 's1' })).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(svc.create({ name: 's1' })).rejects.toThrow(/100 exceeds eligible pool of 10/);
  });

  it('excludes days without candles or with incomplete coverage from the pool', async () => {
    const deps = makeDeps();
    // First listing day has no candles; second returns a marker candle that fails coverage.
    deps.marketData.getDay.mockImplementation(async (_s: string, _i: string, date: string) => {
      if (date === '2025-01-06') return null;
      if (date === '2025-02-03') return [{ time: 2 }];
      return [{ time: 1 }];
    });
    (analyzeCoverage as jest.Mock).mockImplementation((candles: { time: number }[]) => ({ complete: candles[0].time !== 2 }));
    const svc = await build(deps);
    const doc = await svc.create({ name: 's1', count: 8 });
    expect(doc.poolSize).toBe(8);
    expect(doc.days).not.toContain('01062025'); // no candles
    expect(doc.days).not.toContain('02032025'); // incomplete coverage
  });

  it('honours from/to bounds inclusively', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    const doc = await svc.create({ name: 's1', count: 3, from: '06022025', to: '01052026' });
    // Eligible window: 06022025, 09082025, 12012025, 01052026 -> poolSize 4.
    expect(doc.poolSize).toBe(4);
    for (const d of doc.days) expect(['06022025', '09082025', '12012025', '01052026']).toContain(d);
  });

  it('rejects bad names, counts, and range keys with 400', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    await expect(svc.create({ name: '' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create({ name: 'Bad Name!' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create({ name: 's1', count: 0 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create({ name: 's1', count: 2.5 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create({ name: 's1', count: 2, from: '2025-01-06' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps a duplicate-name create to 409', async () => {
    const deps = makeDeps();
    deps.repo.createSample.mockRejectedValue(Object.assign(new Error('exists'), { code: 6 }));
    const svc = await build(deps);
    await expect(svc.create({ name: 's1', count: 2 })).rejects.toBeInstanceOf(ConflictException);
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

  it('get returns the doc and 404s on unknown names', async () => {
    const deps = makeDeps();
    const doc = { name: 's1', days: ['01062025'], requestedCount: 1, poolSize: 10, from: null, to: null, createdAt: 't' };
    deps.repo.getSample.mockImplementation(async (n: string) => (n === 's1' ? doc : null));
    const svc = await build(deps);
    expect(await svc.get('s1')).toEqual(doc);
    await expect(svc.get('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm jest src/benchmark/samples.service.spec.ts`
Expected: FAIL — cannot resolve `./samples.service`.

- [ ] **Step 3: Implement** — create `samples.service.ts`:

```ts
import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { BenchmarkRepository, SampleDoc } from './benchmark.repository';
import { CloudInputsService, DayListing } from './cloud-inputs.service';
import { MarketDataService } from '../market-data/market-data.service';
import { ContractsService } from '../contracts/contracts.service';
import { resolveContract } from '../contracts/contracts-roll';
import { analyzeCoverage } from '../market-data/coverage';
import { intervalToSeconds } from '../market-data/candle';
import { hhmmToMinutes } from '../common/session-time';

const SYMBOL = 'ES';
const INTERVAL = 'min-1' as const;
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const DAY_KEY_RE = /^\d{8}$/;

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

const dayToDate = (day: string): string => `${day.slice(4)}-${day.slice(0, 2)}-${day.slice(2, 4)}`;

/** Uniform draw without replacement: partial Fisher-Yates over a copy. */
export function draw(pool: string[], count: number): string[] {
  const a = [...pool];
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(Math.random() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, count);
}

@Injectable()
export class SamplesService {
  constructor(
    private readonly repo: BenchmarkRepository,
    private readonly inputs: CloudInputsService,
    private readonly marketData: MarketDataService,
    private readonly contracts: ContractsService,
  ) {}

  async create(opts: CreateSampleOptions): Promise<SampleDoc> {
    const name = opts.name?.trim();
    if (!name || !NAME_RE.test(name)) throw new BadRequestException('name must be a lowercase slug ([a-z0-9-])');
    const count = opts.count ?? 100;
    if (!Number.isInteger(count) || count < 1) throw new BadRequestException('count must be a positive integer');
    for (const [key, value] of [['from', opts.from], ['to', opts.to]] as const) {
      if (value !== undefined && !DAY_KEY_RE.test(value)) throw new BadRequestException(`${key} must be an MMDDYYYY day key`);
    }

    const snap = await this.inputs.snapshot();
    const pool = await this.eligible(snap.days, opts.from, opts.to);
    if (count > pool.length) {
      throw new UnprocessableEntityException(`count ${count} exceeds eligible pool of ${pool.length} days`);
    }

    const byDate = (a: string, b: string) => dayToDate(a).localeCompare(dayToDate(b));
    const doc: SampleDoc = {
      name,
      days: draw(pool, count).sort(byDate),
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
    const doc = await this.repo.getSample(name);
    if (!doc) throw new NotFoundException(`No sample named ${name}`);
    return doc;
  }

  /**
   * Committed-manifest days inside the range that pass the run's own candle
   * prerequisite (non-empty day + complete RTH coverage), so every sampled
   * day actually runs instead of landing in daysSkipped.
   */
  private async eligible(listings: DayListing[], from?: string, to?: string): Promise<string[]> {
    const fromDate = from ? dayToDate(from) : null;
    const toDate = to ? dayToDate(to) : null;
    const inRange = listings.filter((d) => (!fromDate || d.date >= fromDate) && (!toDate || d.date <= toDate));

    const spec = this.contracts.get(SYMBOL);
    const rthWindow = {
      openMin: hhmmToMinutes(spec.rth.open),
      closeMin: hhmmToMinutes(spec.rth.close),
      intervalSec: intervalToSeconds(INTERVAL),
      tz: spec.timezone,
    };

    const out: string[] = [];
    for (const d of inRange) {
      const candles = await this.marketData.getDay(resolveContract(SYMBOL, d.date), INTERVAL, d.date);
      if (candles && candles.length && analyzeCoverage(candles, rthWindow).complete) out.push(d.day);
    }
    return out;
  }
}
```

Then register it — in `benchmark.module.ts` add `import { SamplesService } from './samples.service';` and `SamplesService,` to the `providers` array.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm jest src/benchmark/samples.service.spec.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/benchmark/samples.service.ts backend/src/benchmark/samples.service.spec.ts backend/src/benchmark/benchmark.module.ts
git commit -m "feat(benchmark): SamplesService draws persisted random day samples"
```

---

### Task 3: Sample endpoints on the benchmark controller

**Files:**
- Modify: `backend/src/benchmark/benchmark.controller.ts`
- Test: `backend/src/benchmark/benchmark.controller.spec.ts`

**Interfaces:**
- Consumes: `SamplesService.create/list/get` (Task 2 signatures).
- Produces: `POST /benchmark/samples`, `GET /benchmark/samples`, `GET /benchmark/samples/:name` — thin pass-throughs; all error mapping lives in the service.

- [ ] **Step 1: Write the failing tests** — in `benchmark.controller.spec.ts`, extend `build()`'s providers with a samples fake and add a describe block. Add to `build()`:

```ts
  const samples = {
    create: jest.fn().mockResolvedValue({ name: 's1', days: ['01062025'], requestedCount: 1, poolSize: 10, from: null, to: null, createdAt: 't' }),
    list: jest.fn().mockResolvedValue([{ name: 's1', count: 1, poolSize: 10, firstDay: '01062025', lastDay: '01062025', createdAt: 't' }]),
    get: jest.fn().mockResolvedValue({ name: 's1', days: ['01062025'], requestedCount: 1, poolSize: 10, from: null, to: null, createdAt: 't' }),
  };
```

register `{ provide: SamplesService, useValue: samples }` (import `SamplesService` from `./samples.service`), return `samples` from `build()`, and add:

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
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm jest src/benchmark/benchmark.controller.spec.ts`
Expected: FAIL — `ctrl.createSample is not a function` (the pre-existing tests must still pass once `SamplesService` is provided).

- [ ] **Step 3: Implement** — in `benchmark.controller.ts`: add `Param` to the `@nestjs/common` import, import `SamplesService, { CreateSampleOptions }` types (`import { SamplesService, CreateSampleOptions, SampleSummary } from './samples.service';` and `SampleDoc` from `./benchmark.repository`), inject `private readonly samples: SamplesService` in the constructor, and add below `scoreboard()`:

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

- [ ] **Step 4: Run to verify pass**

Run: `pnpm jest src/benchmark/benchmark.controller.spec.ts`
Expected: PASS (all tests, old and new).

- [ ] **Step 5: Commit**

```bash
git add backend/src/benchmark/benchmark.controller.ts backend/src/benchmark/benchmark.controller.spec.ts
git commit -m "feat(benchmark): sample create/list/get endpoints"
```

---

### Task 4: `sample` parameter on the benchmark run + docs

**Files:**
- Modify: `backend/src/benchmark/benchmark.service.ts` (`RunOptions`, `runInner` day-filter block)
- Modify: `backend/src/benchmark/benchmark.controller.ts` (`RunBody` + pass-through)
- Modify: `CLAUDE.md` (benchmark section)
- Test: `backend/src/benchmark/benchmark.service.spec.ts`, `backend/src/benchmark/benchmark.controller.spec.ts`

**Interfaces:**
- Consumes: `BenchmarkRepository.getSample` (Task 1).
- Produces: `RunOptions.sample?: string` — resolved to the existing days filter; `sample`+`days` → `BadRequestException`; unknown sample → `NotFoundException`.

- [ ] **Step 1: Write the failing tests** — in `benchmark.service.spec.ts`: add `getSample: jest.fn().mockResolvedValue(null),` to the `repo` object in `makeDeps()`, then add:

```ts
  it('run({ sample }) restricts days to the persisted sample', async () => {
    const deps = makeDeps();
    deps.repo.getSample.mockResolvedValue({ name: 's1', days: ['07012026'], requestedCount: 1, poolSize: 2, from: null, to: null, createdAt: 't' });
    const svc = await build(deps);
    const summary = await svc.run({ runCount: 1, sample: 's1' });
    expect(deps.repo.getSample).toHaveBeenCalledWith('s1');
    expect(summary.cellsQueued).toBe(1);
    const saved = deps.repo.saveBatch.mock.calls[0][0];
    expect(Object.keys(saved.customIdToCell)).toEqual(['context-trader__fable__07012026__seven-keys-scorecard__run1']);
    // The other listing day (07022026) is not reported skipped-for-candles: it was filtered out by the sample.
    expect(summary.daysSkipped).toEqual([]);
  });

  it('run rejects sample together with days', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    await expect(svc.run({ sample: 's1', days: ['07012026'] })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('run 404s on an unknown sample', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    await expect(svc.run({ sample: 'nope' })).rejects.toBeInstanceOf(NotFoundException);
  });
```

with `import { BadRequestException, NotFoundException } from '@nestjs/common';` added to the spec's imports. In `benchmark.controller.spec.ts`, update the forwarding test:

```ts
    const res = await ctrl.run({ model: 'fable', runCount: 3, variants: ['base'], sample: 's1' });
    expect(service.run).toHaveBeenCalledWith({ model: 'fable', runCount: 3, variants: ['base'], days: undefined, sample: 's1' });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm jest src/benchmark/benchmark.service.spec.ts src/benchmark/benchmark.controller.spec.ts`
Expected: FAIL — the sample tests (unknown option is ignored, so days aren't filtered / no rejection) and the controller forwarding assertion.

- [ ] **Step 3: Implement** — in `benchmark.service.ts`: add `sample?: string;` to `RunOptions` (with a comment: `// name of a persisted day sample; mutually exclusive with days`), add `BadRequestException, NotFoundException` to the `@nestjs/common` import if absent, and in `runInner` replace the day-filter block

```ts
    let days = snap.days;
    if (opts.days?.length) days = days.filter((d) => opts.days!.includes(d.day));
```

with

```ts
    if (opts.sample && opts.days?.length) {
      throw new BadRequestException('sample and days are mutually exclusive — a sample IS a days filter');
    }
    let daysFilter = opts.days;
    if (opts.sample) {
      const sampleDoc = await this.repo.getSample(opts.sample);
      if (!sampleDoc) throw new NotFoundException(`No sample named ${opts.sample}`);
      daysFilter = sampleDoc.days;
    }

    let days = snap.days;
    if (daysFilter?.length) days = days.filter((d) => daysFilter!.includes(d.day));
```

and update the later issues filter to use the same list:

```ts
    let issues = snap.issues;
    if (daysFilter?.length) issues = issues.filter((i) => daysFilter!.includes(i.day));
```

Note: the mutual-exclusion + lookup happens inside `runInner`, i.e. inside the single-flight lock — acceptable because both error paths release the lock via the existing try/finally. In `benchmark.controller.ts`: add `sample?: string;` to `RunBody` and `sample: body.sample,` to the `this.benchmark.run({...})` call. In `CLAUDE.md`, under the Benchmark section, extend the endpoint block:

```
POST /benchmark/samples      body: { name, count? (default 100), from?, to? (MMDDYYYY) }
                             draws a write-once random sample of benchmarkable days
GET  /benchmark/samples      list sample summaries
GET  /benchmark/samples/:name  full day list
```

and note on `POST /benchmark/run`: `sample: "<name>"` pins the run to a persisted sample's days (mutually exclusive with `days`).

- [ ] **Step 4: Run to verify pass, then the full suite**

Run: `pnpm jest src/benchmark/benchmark.service.spec.ts src/benchmark/benchmark.controller.spec.ts`
Expected: PASS.
Run: `pnpm jest`
Expected: all suites pass (~74+, 930+ tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/benchmark/benchmark.service.ts backend/src/benchmark/benchmark.controller.ts backend/src/benchmark/benchmark.service.spec.ts backend/src/benchmark/benchmark.controller.spec.ts CLAUDE.md
git commit -m "feat(benchmark): pin runs to a persisted day sample"
```

---

## Post-implementation (manual, after all tasks)

Not part of the coded tasks — done once against the live backend, no benchmark run:

1. `curl -X POST localhost:3000/benchmark/samples -H 'Content-Type: application/json' -d '{"name":"s1-2025-2026","count":100}'` — creates the first sample from the current 2025–2026 pool (352 committed days; pool may be smaller after candle checks).
2. `curl localhost:3000/benchmark/samples/s1-2025-2026` — verify 100 chronological days.
3. Do NOT `POST /benchmark/run` — deferred at the user's request.
