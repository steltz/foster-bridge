# Trader-Bench Backend Port — Core Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the `trader-bench` matrix pipeline into the NestJS backend for the `base` and `seven-keys-method` variants only, running trade-decision inference through the Anthropic Batch API with 4-tier prompt caching, judging each setup with the in-process `BacktestService`, and materializing a Firestore-backed scoreboard.

**Architecture:** A new `BenchmarkModule` owns deterministic orchestration — repo-input discovery + hashing, a Firestore top-up diff, per-day PDF/transcript assembly (Firebase Storage origin + Anthropic Files serving copy), two-stage cache warming, and one Batch-API submission per day. A scheduled `BatchReconciler` (bootstrap + per-minute cron) drains ended batches into backtested, write-once cells; a `CacheWarmer` keeps in-flight day-bundles alive under the 1h TTL. `ScoreboardService` vendors the pure `src/scoreboard.js` functions and feeds them Firestore cells. Seven-keys artifact GENERATION and the `seven-keys-scorecard` variant are OUT OF SCOPE (deferred to Plan 2).

**Tech Stack:** NestJS 10, TypeScript, @anthropic-ai/sdk 0.115.0, Firebase Admin (Firestore + Storage), @nestjs/schedule, Jest.

---

## Files created/modified

| Path | Action | Task |
|---|---|---|
| `backend/package.json` | Modify — add `@nestjs/schedule` | 1 |
| `backend/src/config/configuration.ts` | Modify — add `benchmark` config | 1 |
| `backend/src/config/configuration.spec.ts` | Create | 1 |
| `backend/src/app.module.ts` | Modify — `ScheduleModule.forRoot()`, `BenchmarkModule`, `BenchmarkController` | 1, 14 |
| `backend/test/fake-firestore.ts` | Modify — `create()`, `set()`, chainable `.where()` | 2 |
| `backend/test/fake-firestore.e2e-spec.ts` | Create | 2 |
| `backend/src/benchmark/benchmark.types.ts` | Create | 3 |
| `backend/src/benchmark/benchmark.types.spec.ts` | Create | 3 |
| `backend/src/benchmark/benchmark.repository.ts` | Create | 4 |
| `backend/src/benchmark/benchmark.repository.spec.ts` | Create | 4 |
| `backend/src/benchmark/repo-inputs.service.ts` | Create | 5 |
| `backend/src/benchmark/repo-inputs.service.spec.ts` | Create | 5 |
| `backend/src/anthropic/anthropic.service.ts` | Modify — tiers, files upload, structured output, per-request context | 6 |
| `backend/src/anthropic/anthropic.service.spec.ts` | Modify — new describe blocks + mock edits | 6 |
| `backend/src/benchmark/day-artifacts.service.ts` | Create | 7 |
| `backend/src/benchmark/day-artifacts.service.spec.ts` | Create | 7 |
| `backend/src/benchmark/envelope.builder.ts` | Create | 8 |
| `backend/src/benchmark/envelope.builder.spec.ts` | Create | 8 |
| `backend/src/benchmark/benchmark.service.ts` | Create | 9 |
| `backend/src/benchmark/benchmark.service.spec.ts` | Create | 9 |
| `backend/src/benchmark/batch-reconciler.ts` | Create | 10 |
| `backend/src/benchmark/batch-reconciler.spec.ts` | Create | 10 |
| `backend/src/benchmark/cache-warmer.ts` | Create | 11 |
| `backend/src/benchmark/cache-warmer.spec.ts` | Create | 11 |
| `backend/src/benchmark/scoreboard/lineage.ts` | Create — vendored | 12 |
| `backend/src/benchmark/scoreboard/scoreboard.ts` | Create — vendored | 12 |
| `backend/src/benchmark/scoreboard/scoreboard.spec.ts` | Create | 12 |
| `backend/src/benchmark/scoreboard.service.ts` | Create | 12 |
| `backend/src/benchmark/scoreboard.service.spec.ts` | Create | 12 |
| `backend/src/benchmark/benchmark.controller.ts` | Create | 13 |
| `backend/src/benchmark/benchmark.controller.spec.ts` | Create | 13 |
| `backend/src/benchmark/benchmark.module.ts` | Create | 14 |
| `backend/test/benchmark.e2e-spec.ts` | Create | 15 |

**Jest placement decision:** the unit config (`backend/jest.config.js`) has `rootDir: 'src'` and `testRegex: '.*\\.spec\\.ts$'`, so every `*.spec.ts` MUST live under `backend/src/`. The e2e config (`backend/test/jest-e2e.json`) has `rootDir: '.'` (the `test/` dir) and `testRegex: '.e2e-spec.ts$'`. Because `fake-firestore.ts` lives in `test/`, its dedicated test is named `fake-firestore.e2e-spec.ts` (Task 2) so the e2e runner picks it up; all other new specs are co-located under `src/benchmark/` and run via `pnpm test`. Unit specs that need the fake import it across the tree (`../../test/fake-firestore`) — `rootDir` governs test discovery, not module resolution, so ts-jest resolves the relative import fine.

**Run commands:** unit `cd backend && pnpm test -- <pattern>`; e2e `cd backend && pnpm test:e2e -- <pattern>`.

---

### Task 1: Dependencies & config

**Files:**
- Modify: `backend/package.json`
- Modify: `backend/src/config/configuration.ts`
- Create: `backend/src/config/configuration.spec.ts`
- Modify: `backend/src/app.module.ts`

- [ ] **Step: Write the failing config test.**

Create `backend/src/config/configuration.spec.ts`:

```ts
import configuration from './configuration';

describe('configuration benchmark defaults', () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.BENCHMARK_MODEL;
    delete process.env.BENCHMARK_REPO_ROOT;
    delete process.env.BENCHMARK_RUN_COUNT;
  });
  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('defaults the benchmark model to claude-fable-5', () => {
    expect(configuration().benchmark.model).toBe('claude-fable-5');
  });

  it('defaults defaultRunCount to 5 and repoRoot to a non-empty absolute path', () => {
    const cfg = configuration();
    expect(cfg.benchmark.defaultRunCount).toBe(5);
    expect(cfg.benchmark.repoRoot.length).toBeGreaterThan(0);
    expect(cfg.benchmark.repoRoot.startsWith('/')).toBe(true);
  });

  it('honours env overrides', () => {
    process.env.BENCHMARK_MODEL = 'claude-opus-4-8';
    process.env.BENCHMARK_REPO_ROOT = '/tmp/fixture';
    process.env.BENCHMARK_RUN_COUNT = '3';
    const cfg = configuration();
    expect(cfg.benchmark).toEqual({
      model: 'claude-opus-4-8',
      repoRoot: '/tmp/fixture',
      defaultRunCount: 3,
    });
  });
});
```

- [ ] **Step: Run it — expect FAIL.**

`cd backend && pnpm test -- configuration.spec` → FAIL (`benchmark` is undefined on `AppConfig`).

- [ ] **Step: Extend `AppConfig` and the factory.**

Edit `backend/src/config/configuration.ts` — add the import at the top and the `benchmark` block:

```ts
import { resolve } from 'node:path';

export interface AppConfig {
  port: number;
  firebase: {
    projectId: string;
    storageBucket: string;
  };
  anthropic: {
    apiKey?: string;
    model: string;
    maxTokens: number;
  };
  benchmark: {
    model: string;
    repoRoot: string;
    defaultRunCount: number;
  };
}

export default (): AppConfig => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  firebase: {
    projectId:
      process.env.FIREBASE_PROJECT_ID ??
      process.env.GCLOUD_PROJECT ??
      'app-foster-bridge',
    storageBucket:
      process.env.FIREBASE_STORAGE_BUCKET ??
      'app-foster-bridge.firebasestorage.app',
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5',
    maxTokens: parseInt(process.env.ANTHROPIC_MAX_TOKENS ?? '4096', 10),
  },
  benchmark: {
    // Benchmark model is independent of the global ANTHROPIC_MODEL; Fable by default.
    model: process.env.BENCHMARK_MODEL ?? 'claude-fable-5',
    // configuration.{ts,js} lives at backend/src/config (dist/config after build);
    // '../../..' lands on the repo root (parent of backend/) in both layouts.
    repoRoot: process.env.BENCHMARK_REPO_ROOT ?? resolve(__dirname, '..', '..', '..'),
    defaultRunCount: parseInt(process.env.BENCHMARK_RUN_COUNT ?? '5', 10),
  },
});
```

- [ ] **Step: Run it — expect PASS.**

`cd backend && pnpm test -- configuration.spec` → PASS.

- [ ] **Step: Add `@nestjs/schedule` to dependencies and install.**

Edit `backend/package.json` `dependencies` to add (keep alphabetical-ish, after `@nestjs/platform-express`):

```json
    "@nestjs/platform-express": "^10.4.0",
    "@nestjs/schedule": "^4.1.0",
```

Then `cd backend && pnpm install` → lockfile updates, `@nestjs/schedule` resolved.

- [ ] **Step: Register `ScheduleModule.forRoot()` in AppModule.**

Edit `backend/src/app.module.ts` — add the import and the module (the `BenchmarkModule`/`BenchmarkController` wiring happens in Task 14; add only `ScheduleModule` here):

```ts
import { ScheduleModule } from '@nestjs/schedule';
```

and inside `imports: [`, add as the first entry after `ConfigModule.forRoot(...)`:

```ts
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    ScheduleModule.forRoot(),
```

- [ ] **Step: Verify the app still boots and all tests pass.**

`cd backend && pnpm test` → PASS (existing suite green; `ScheduleModule` has no scheduled providers yet).

- [ ] **Step: Commit.**

`git add -A && git commit -m "feat(benchmark): add schedule dep and benchmark config"`

---

### Task 2: Extend the Firestore fake

**Files:**
- Modify: `backend/test/fake-firestore.ts`
- Create: `backend/test/fake-firestore.e2e-spec.ts`

- [ ] **Step: Write the failing fake test.**

Create `backend/test/fake-firestore.e2e-spec.ts` (picked up by the e2e runner via the `.e2e-spec.ts$` regex; the fake lives in `test/`, so its test does too):

```ts
import { fakeFirestore } from './fake-firestore';

describe('fakeFirestore extensions', () => {
  it('create() writes once and rejects a second create with code 6', async () => {
    const db = fakeFirestore();
    const ref = db.collection('benchmarkRuns').doc('a__fable__07012026__base__run1');
    await ref.create({ trader: 'a', runIndex: 1 });
    await expect(ref.create({ trader: 'a', runIndex: 1 })).rejects.toMatchObject({ code: 6 });
    const snap = await ref.get();
    expect(snap.exists).toBe(true);
    expect(snap.data()).toEqual({ trader: 'a', runIndex: 1 });
  });

  it('set() writes and overwrites outside a transaction', async () => {
    const db = fakeFirestore();
    const ref = db.collection('benchmarkBatches').doc('batch_1');
    await ref.set({ status: 'submitted' });
    await ref.set({ status: 'reconciled' });
    expect((await ref.get()).data()).toEqual({ status: 'reconciled' });
  });

  it('where() filters with == and is chainable', async () => {
    const db = fakeFirestore();
    await db.collection('benchmarkRuns').doc('d1').set({ trader: 'a', modelAlias: 'fable', variant: 'base', runIndex: 1 });
    await db.collection('benchmarkRuns').doc('d2').set({ trader: 'a', modelAlias: 'fable', variant: 'base', runIndex: 2 });
    await db.collection('benchmarkRuns').doc('d3').set({ trader: 'b', modelAlias: 'fable', variant: 'base', runIndex: 1 });
    const snap = await db
      .collection('benchmarkRuns')
      .where('trader', '==', 'a')
      .where('variant', '==', 'base')
      .get();
    expect(snap.docs.map((d: any) => d.data().runIndex).sort()).toEqual([1, 2]);
  });

  it('where() supports the in operator', async () => {
    const db = fakeFirestore();
    await db.collection('benchmarkBatches').doc('b1').set({ status: 'submitted' });
    await db.collection('benchmarkBatches').doc('b2').set({ status: 'reconciled' });
    await db.collection('benchmarkBatches').doc('b3').set({ status: 'ended' });
    const snap = await db
      .collection('benchmarkBatches')
      .where('status', 'in', ['submitted', 'in_progress', 'ended'])
      .get();
    expect(snap.docs.map((d: any) => d.id).sort()).toEqual(['b1', 'b3']);
  });
});
```

- [ ] **Step: Run it — expect FAIL.**

`cd backend && pnpm test:e2e -- fake-firestore` → FAIL (`create`/`set`/`where` are not functions).

- [ ] **Step: Extend the fake (keep all existing behavior).**

Replace the whole body of `backend/test/fake-firestore.ts`:

```ts
// In-memory Firestore fake. Supports the access patterns the app uses:
//   collection(path).doc(id).get() / .create(data) / .set(data)
//   collection(path).get()
//   collection(path).select(...).get()
//   collection(path).where(field, op, value)[.where(...)].get()  (op '==' | 'in')
//   runTransaction(fn) -> fn({ get, set })
// Keyed by full doc path, e.g. 'markets/MES/min-5/2026-07-14'.
export function fakeFirestore() {
  const docs = new Map<string, any>();

  function docRef(path: string) {
    return {
      id: path.split('/').pop() as string,
      path,
      get: () => Promise.resolve({ exists: docs.has(path), data: () => docs.get(path) }),
      // Firestore create() is write-once: a second create rejects with the
      // ALREADY_EXISTS gRPC code (6). Callers that want idempotency swallow it.
      create: (data: any) =>
        docs.has(path)
          ? Promise.reject(Object.assign(new Error(`ALREADY_EXISTS: ${path}`), { code: 6 }))
          : Promise.resolve(void docs.set(path, data)),
      set: (data: any) => Promise.resolve(void docs.set(path, data)),
    };
  }

  function collectionRef(base: string) {
    const listDocs = () =>
      [...docs.entries()]
        .filter(([k]) => k.startsWith(base + '/') && !k.slice(base.length + 1).includes('/'))
        .map(([k, v]) => ({ id: k.split('/').pop() as string, data: () => v }));

    type Filter = { field: string; op: '==' | 'in'; value: any };
    const matches = (row: { data: () => any }, filters: Filter[]) =>
      filters.every((f) => {
        const v = row.data()[f.field];
        if (f.op === '==') return v === f.value;
        if (f.op === 'in') return Array.isArray(f.value) && f.value.includes(v);
        return false;
      });
    const query = (filters: Filter[]) => ({
      where: (field: string, op: '==' | 'in', value: any) => query([...filters, { field, op, value }]),
      get: () => Promise.resolve({ docs: listDocs().filter((r) => matches(r, filters)) }),
    });

    return {
      doc: (id: string) => docRef(`${base}/${id}`),
      get: () => Promise.resolve({ docs: listDocs() }),
      // Real Firestore's .select(...) projects fields server-side; the fake has
      // no wire transfer to shrink, so a no-op projection is sufficient.
      select: (..._fields: string[]) => ({ get: () => Promise.resolve({ docs: listDocs() }) }),
      where: (field: string, op: '==' | 'in', value: any) => query([{ field, op, value }]),
    };
  }

  return {
    collection: (path: string) => collectionRef(path),
    runTransaction: async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any) => {
          docs.set(ref.path, data);
        },
      }),
  } as any;
}
```

- [ ] **Step: Run it — expect PASS, and confirm no regressions.**

`cd backend && pnpm test:e2e -- fake-firestore` → PASS. Then `cd backend && pnpm test:e2e` → PASS (existing market-data/backtest e2e still green).

- [ ] **Step: Commit.**

`git add -A && git commit -m "test(firestore-fake): add create, set and chainable where"`

---

### Task 3: Domain types + cell key

**Files:**
- Create: `backend/src/benchmark/benchmark.types.ts`
- Create: `backend/src/benchmark/benchmark.types.spec.ts`

- [ ] **Step: Write the failing types test.**

Create `backend/src/benchmark/benchmark.types.spec.ts`:

```ts
import { cellKey, parseCellKey, SETUP_SCHEMA, CORE_VARIANTS, resolveModel } from './benchmark.types';

describe('cellKey', () => {
  it('round-trips a cell key', () => {
    const parts = { trader: 'context-trader', modelAlias: 'fable', day: '07012026', variant: 'base', runIndex: 3 };
    const key = cellKey(parts);
    expect(key).toBe('context-trader__fable__07012026__base__run3');
    expect(parseCellKey(key)).toEqual(parts);
  });

  it('round-trips the seven-keys-method variant', () => {
    const parts = { trader: 'context-structured', modelAlias: 'fable', day: '07162026', variant: 'seven-keys-method', runIndex: 12 };
    expect(parseCellKey(cellKey(parts))).toEqual(parts);
  });

  it('is safe for model ids that contain no "__" (aliases)', () => {
    // We key on the ALIAS (fable/opus/…), never the raw id, so no field carries "__".
    for (const alias of Object.keys(resolveModel.ALIASES)) {
      const parts = { trader: 'a', modelAlias: alias, day: '07012026', variant: 'base', runIndex: 1 };
      expect(parseCellKey(cellKey(parts))).toEqual(parts);
    }
  });
});

describe('resolveModel', () => {
  it('resolves a known alias to { alias, id }', () => {
    expect(resolveModel('fable')).toEqual({ alias: 'fable', id: 'claude-fable-5' });
  });
  it('resolves a known id back to its alias', () => {
    expect(resolveModel('claude-fable-5')).toEqual({ alias: 'fable', id: 'claude-fable-5' });
  });
  it('falls back to using an unknown value as both alias and id', () => {
    expect(resolveModel('claude-mystery-9')).toEqual({ alias: 'claude-mystery-9', id: 'claude-mystery-9' });
  });
});

describe('SETUP_SCHEMA / CORE_VARIANTS', () => {
  it('requires the seven setup fields and forbids extras', () => {
    expect(SETUP_SCHEMA.required).toEqual(['side', 'entry', 'stopLoss', 'takeProfit', 'rationale', 'primaryZone', 'confidence']);
    expect(SETUP_SCHEMA.additionalProperties).toBe(false);
  });
  it('scopes core variants to base + seven-keys-method', () => {
    expect(CORE_VARIANTS).toEqual(['base', 'seven-keys-method']);
  });
});
```

- [ ] **Step: Run it — expect FAIL.**

`cd backend && pnpm test -- benchmark.types.spec` → FAIL (module not found).

- [ ] **Step: Implement the types.**

Create `backend/src/benchmark/benchmark.types.ts`:

```ts
// Domain types for the trader-bench backend port. Core-pipeline scope:
// `base` and `seven-keys-method` only. Seven-keys generation and the
// `seven-keys-scorecard` variant are Plan 2.

export type Side = 'long' | 'short';

export interface Setup {
  side: Side;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  rationale: string;
  primaryZone: string;
  confidence: number; // integer 1-5
  rejectedAlternative?: string;
}

// JSON schema for structured output (output_config.format). Byte-identical to
// the SETUP_SCHEMA the legacy trader-bench Workflow used.
export const SETUP_SCHEMA = {
  type: 'object',
  required: ['side', 'entry', 'stopLoss', 'takeProfit', 'rationale', 'primaryZone', 'confidence'],
  properties: {
    side: { enum: ['long', 'short'] },
    entry: { type: 'number' },
    stopLoss: { type: 'number' },
    takeProfit: { type: 'number' },
    rationale: { type: 'string', maxLength: 400 },
    primaryZone: { type: 'string', maxLength: 100 },
    confidence: { type: 'integer', minimum: 1, maximum: 5 },
    rejectedAlternative: { type: 'string', maxLength: 200 },
  },
  additionalProperties: false,
} as const;

// TP/SL/EOD/NOT_FILLED come straight from the engine; INVALID (bad prices or a
// backtest rejection) and NO_SETUP (refusal / dead result) are bench-only.
export type CellStatus = 'TP' | 'SL' | 'EOD' | 'NOT_FILLED' | 'INVALID' | 'NO_SETUP';

export type Variant = string; // 'base' | 'seven-keys-method' in this plan
export const CORE_VARIANTS: Variant[] = ['base', 'seven-keys-method'];

export interface CellResult {
  status: CellStatus;
  points?: number | null;
  dollars?: number | null;
  fillTime?: number | null;
  exitTime?: number | null;
  maxAdverseExcursion?: number | null;
  maxFavorableExcursion?: number | null;
  rMultiple?: number | null;
  closestApproach?: number | null;
}

export interface BenchmarkCell {
  trader: string;
  model: { alias: string; id: string };
  // Flat mirror of model.alias so the Firestore fake (top-level fields only)
  // can filter on it; model.{alias,id} is what the scoreboard reads.
  modelAlias: string;
  day: string; // MMDDYYYY (cell directory key / chronology source)
  date: string; // YYYY-MM-DD (backtest date)
  variant: Variant;
  runIndex: number;
  personaSha256: string;
  generalSha256: string;
  featureSha256?: string; // omitted for base
  staticDocSha256?: string; // omitted when the variant has no staticDoc
  setup?: Setup;
  result: CellResult;
  note?: string;
  createdAt: string; // ISO-8601 UTC
}

export interface CellKeyParts {
  trader: string;
  modelAlias: string;
  day: string;
  variant: Variant;
  runIndex: number;
}

// Doc id: {trader}__{alias}__{day}__{variant}__run{N}. No field contains "__":
// trader/variant are slugs, alias is a short alias, day is 8 digits.
export function cellKey(p: CellKeyParts): string {
  return `${p.trader}__${p.modelAlias}__${p.day}__${p.variant}__run${p.runIndex}`;
}

export function parseCellKey(id: string): CellKeyParts {
  const parts = id.split('__');
  if (parts.length !== 5 || !parts[4].startsWith('run')) {
    throw new Error(`Malformed cell key: ${id}`);
  }
  const [trader, modelAlias, day, variant, runField] = parts;
  return { trader, modelAlias, day, variant, runIndex: parseInt(runField.slice(3), 10) };
}

export const MODEL_ALIASES: Record<string, string> = {
  fable: 'claude-fable-5',
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5-20251001',
};

// Accepts an alias ('fable') or a raw id ('claude-fable-5'); returns both.
// Unknown values pass through as alias === id so a new model needs no code change.
// Object.assign attaches ALIASES as a type-safe property callers can read.
export const resolveModel = Object.assign(
  (value: string): { alias: string; id: string } => {
    if (MODEL_ALIASES[value]) return { alias: value, id: MODEL_ALIASES[value] };
    const alias = Object.keys(MODEL_ALIASES).find((a) => MODEL_ALIASES[a] === value);
    if (alias) return { alias, id: value };
    return { alias: value, id: value };
  },
  { ALIASES: MODEL_ALIASES },
);
```

- [ ] **Step: Run it — expect PASS.**

`cd backend && pnpm test -- benchmark.types.spec` → PASS.

- [ ] **Step: Commit.**

`git add -A && git commit -m "feat(benchmark): add domain types and cell key"`

---

### Task 4: Benchmark repository

**Files:**
- Create: `backend/src/benchmark/benchmark.repository.ts`
- Create: `backend/src/benchmark/benchmark.repository.spec.ts`

- [ ] **Step: Write the failing repository test.**

Create `backend/src/benchmark/benchmark.repository.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { BenchmarkRepository } from './benchmark.repository';
import { FIRESTORE } from '../firebase/firebase.constants';
import { fakeFirestore } from '../../test/fake-firestore';
import { BenchmarkCell, cellKey } from './benchmark.types';

function cell(overrides: Partial<BenchmarkCell> = {}): BenchmarkCell {
  return {
    trader: 'context-trader',
    model: { alias: 'fable', id: 'claude-fable-5' },
    modelAlias: 'fable',
    day: '07012026',
    date: '2026-07-01',
    variant: 'base',
    runIndex: 1,
    personaSha256: 'p',
    generalSha256: 'g',
    result: { status: 'TP', points: 10, dollars: 50 },
    createdAt: '2026-07-26T00:00:00.000Z',
    ...overrides,
  };
}

async function build() {
  const db = fakeFirestore();
  const moduleRef = await Test.createTestingModule({
    providers: [BenchmarkRepository, { provide: FIRESTORE, useValue: db }],
  }).compile();
  return { repo: moduleRef.get(BenchmarkRepository), db };
}

describe('BenchmarkRepository', () => {
  it('createCell is write-once and swallows AlreadyExists', async () => {
    const { repo } = await build();
    await repo.createCell(cell());
    await expect(repo.createCell(cell({ result: { status: 'SL' } }))).resolves.toBeUndefined();
    const cells = await repo.listCells('fable');
    expect(cells).toHaveLength(1);
    expect(cells[0].result.status).toBe('TP'); // first write wins
  });

  it('existingRunIndices returns the present indices for a (trader, model, day, variant)', async () => {
    const { repo } = await build();
    await repo.createCell(cell({ runIndex: 1 }));
    await repo.createCell(cell({ runIndex: 3 }));
    await repo.createCell(cell({ trader: 'other', runIndex: 2 }));
    await repo.createCell(cell({ variant: 'seven-keys-method', runIndex: 5 }));
    const idx = await repo.existingRunIndices('context-trader', 'fable', '07012026', 'base');
    expect(idx.sort()).toEqual([1, 3]);
  });

  it('listCells filters by model alias', async () => {
    const { repo } = await build();
    await repo.createCell(cell());
    await repo.createCell(cell({ model: { alias: 'opus', id: 'claude-opus-4-8' }, modelAlias: 'opus', runIndex: 2 }));
    expect(await repo.listCells('fable')).toHaveLength(1);
    expect(await repo.listCells('opus')).toHaveLength(1);
  });

  it('saveBatch / nonTerminalBatches / updateBatch drive the lifecycle', async () => {
    const { repo } = await build();
    await repo.saveBatch({
      batchId: 'batch_1', day: '07012026', date: '2026-07-01', pdfPrefix: '07012026',
      model: { alias: 'fable', id: 'claude-fable-5' }, status: 'submitted',
      customIdToCell: {
        [cellKey({ trader: 'context-trader', modelAlias: 'fable', day: '07012026', variant: 'base', runIndex: 1 })]:
          { date: '2026-07-01', personaSha256: 'p', generalSha256: 'g' },
      },
      submittedAt: '2026-07-26T00:00:00.000Z',
    });
    await repo.saveBatch({
      batchId: 'batch_done', day: '07012026', date: '2026-07-01', pdfPrefix: '07012026',
      model: { alias: 'fable', id: 'claude-fable-5' }, status: 'reconciled',
      customIdToCell: {}, submittedAt: '2026-07-26T00:00:00.000Z',
    });
    const open = await repo.nonTerminalBatches();
    expect(open.map((b) => b.batchId)).toEqual(['batch_1']);
    await repo.updateBatch('batch_1', { status: 'reconciled', endedAt: '2026-07-26T01:00:00.000Z' });
    expect(await repo.nonTerminalBatches()).toHaveLength(0);
  });

  it('day artifacts and scoreboard round-trip', async () => {
    const { repo } = await build();
    expect(await repo.getDayArtifact('07012026', 'pdfFile')).toBeNull();
    await repo.saveDayArtifact('07012026', 'pdfFile', { contentHash: 'h', gcsPath: 'gs://x', anthropicFileId: 'file_1', uploadedAt: 't' });
    expect((await repo.getDayArtifact('07012026', 'pdfFile'))?.anthropicFileId).toBe('file_1');

    expect(await repo.getScoreboard('fable')).toBeNull();
    await repo.saveScoreboard('fable', { json: { groups: [] }, markdown: '# x', generatedAt: 't' });
    expect((await repo.getScoreboard('fable'))?.markdown).toBe('# x');
  });
});
```

- [ ] **Step: Run it — expect FAIL.**

`cd backend && pnpm test -- benchmark.repository.spec` → FAIL (module not found).

- [ ] **Step: Implement the repository.**

Create `backend/src/benchmark/benchmark.repository.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { Firestore } from 'firebase-admin/firestore';
import { FIRESTORE } from '../firebase/firebase.constants';
import { BenchmarkCell, cellKey } from './benchmark.types';

export type BatchStatus =
  | 'submitted'
  | 'in_progress'
  | 'ended'
  | 'reconciled'
  | 'errored'
  | 'canceled'
  | 'expired';

// Statuses that still need reconciler attention.
export const NON_TERMINAL: BatchStatus[] = ['submitted', 'in_progress', 'ended'];

// Per-cell provenance threaded from discovery through the batch so the
// reconciler can persist design-§4 content hashes onto every cell. The customId
// key (a cellKey) already encodes trader/modelAlias/day/variant/runIndex; this
// carries only what the key does NOT: the backtest date and the content hashes.
export interface CellMeta {
  date: string; // YYYY-MM-DD
  personaSha256: string;
  generalSha256: string;
  featureSha256?: string; // omitted for base
  staticDocSha256?: string; // omitted when the variant has no staticDoc
}

export interface BatchDoc {
  batchId: string;
  day: string; // MMDDYYYY
  date: string; // YYYY-MM-DD
  pdfPrefix: string; // TP filename prefix, for re-warm/rebuild
  model: { alias: string; id: string };
  status: BatchStatus;
  customIdToCell: Record<string, CellMeta>;
  submittedAt: string;
  endedAt?: string;
}

export type DayArtifactKind = 'pdfFile' | 'tpTranscript' | 'recapTranscript' | 'keys';

export interface DayArtifactDoc {
  contentHash: string;
  gcsPath: string;
  anthropicFileId?: string; // pdfFile only
  content?: string; // transcripts / keys inline copy
  uploadedAt: string;
}

export interface ScoreboardDoc {
  json: unknown;
  markdown: string;
  generatedAt: string;
}

const RUNS = 'benchmarkRuns';
const BATCHES = 'benchmarkBatches';
const ARTIFACTS = 'dayArtifacts';
const SCOREBOARD = 'benchmarkScoreboard';

@Injectable()
export class BenchmarkRepository {
  constructor(@Inject(FIRESTORE) private readonly db: Firestore) {}

  /** Write-once; a concurrent/duplicate write (ALREADY_EXISTS, gRPC code 6) is swallowed. */
  async createCell(cell: BenchmarkCell): Promise<void> {
    const id = cellKey({
      trader: cell.trader,
      modelAlias: cell.modelAlias,
      day: cell.day,
      variant: cell.variant,
      runIndex: cell.runIndex,
    });
    try {
      await this.db.collection(RUNS).doc(id).create(cell as any);
    } catch (err) {
      if ((err as { code?: number }).code === 6) return; // ALREADY_EXISTS
      throw err;
    }
  }

  async existingRunIndices(trader: string, modelAlias: string, day: string, variant: string): Promise<number[]> {
    const snap = await this.db
      .collection(RUNS)
      .where('trader', '==', trader)
      .where('modelAlias', '==', modelAlias)
      .where('day', '==', day)
      .where('variant', '==', variant)
      .get();
    return snap.docs.map((d) => (d.data() as BenchmarkCell).runIndex);
  }

  async listCells(modelAlias: string): Promise<BenchmarkCell[]> {
    const snap = await this.db.collection(RUNS).where('modelAlias', '==', modelAlias).get();
    return snap.docs.map((d) => d.data() as BenchmarkCell);
  }

  async saveBatch(doc: BatchDoc): Promise<void> {
    await this.db.collection(BATCHES).doc(doc.batchId).set(doc as any);
  }

  async nonTerminalBatches(): Promise<BatchDoc[]> {
    const snap = await this.db.collection(BATCHES).where('status', 'in', NON_TERMINAL).get();
    return snap.docs.map((d) => d.data() as BatchDoc);
  }

  async updateBatch(batchId: string, patch: Partial<BatchDoc>): Promise<void> {
    const ref = this.db.collection(BATCHES).doc(batchId);
    const snap = await ref.get();
    await ref.set({ ...(snap.data() ?? {}), ...patch } as any);
  }

  async getDayArtifact(day: string, kind: DayArtifactKind): Promise<DayArtifactDoc | null> {
    const snap = await this.db.collection(ARTIFACTS).doc(`${day}__${kind}`).get();
    return snap.exists ? (snap.data() as DayArtifactDoc) : null;
  }

  async saveDayArtifact(day: string, kind: DayArtifactKind, doc: DayArtifactDoc): Promise<void> {
    await this.db.collection(ARTIFACTS).doc(`${day}__${kind}`).set(doc as any);
  }

  async getScoreboard(modelAlias: string): Promise<ScoreboardDoc | null> {
    const snap = await this.db.collection(SCOREBOARD).doc(modelAlias).get();
    return snap.exists ? (snap.data() as ScoreboardDoc) : null;
  }

  async saveScoreboard(modelAlias: string, doc: ScoreboardDoc): Promise<void> {
    await this.db.collection(SCOREBOARD).doc(modelAlias).set(doc as any);
  }
}
```

- [ ] **Step: Run it — expect PASS.**

`cd backend && pnpm test -- benchmark.repository.spec` → PASS.

- [ ] **Step: Commit.**

`git add -A && git commit -m "feat(benchmark): add benchmark repository"`

---

### Task 5: Repo-input discovery

**Files:**
- Create: `backend/src/benchmark/repo-inputs.service.ts`
- Create: `backend/src/benchmark/repo-inputs.service.spec.ts`

Note: this is a focused TS port of `src/lineage.js` (`collectTraders`, `parseFrontmatter`) and `src/features.js` (`collectFeatures`) covering the fields the core pipeline consumes (`id`, `name`, `staticDoc`, `block`). The full combo/artifact validation from `features.js` is DEFERRED to Plan 2 (no combo or artifact-backed variant is in core scope; `seven-keys-method` has a `staticDoc` and no artifact).

- [ ] **Step: Write the failing discovery test.**

Create `backend/src/benchmark/repo-inputs.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { RepoInputsService } from './repo-inputs.service';

let root: string;

function seedFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bench-repo-'));
  mkdirSync(join(dir, 'traders'), { recursive: true });
  writeFileSync(join(dir, 'traders', 'context-trader.md'), '---\nname: context-trader\n---\nbody');
  writeFileSync(join(dir, 'traders', 'spawn.md'), '---\nname: spawn\norigin: context-trader\nmutation: tweak\n---\nbody');

  mkdirSync(join(dir, 'features'), { recursive: true });
  mkdirSync(join(dir, 'knowledge-base', 'methods'), { recursive: true });
  writeFileSync(join(dir, 'knowledge-base', 'methods', 'seven-keys.md'), 'METHODS DOC');
  writeFileSync(
    join(dir, 'features', 'seven-keys-method.md'),
    '---\nid: seven-keys-method\nname: Seven-Keys methodology\nstaticDoc: knowledge-base/methods/seven-keys.md\n---\nRead ${DOC}. Grade the zones.',
  );

  mkdirSync(join(dir, 'knowledge-base', 'general'), { recursive: true });
  writeFileSync(join(dir, 'knowledge-base', 'general', 'a.md'), 'AAA');
  writeFileSync(join(dir, 'knowledge-base', 'general', 'b.md'), 'BBB');

  const day = join(dir, 'knowledge-base', 'es', '07012026');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, '07012026_ES_TP.pdf'), 'PDFBYTES');
  writeFileSync(join(day, '07012026_ES_TP.md'), 'PLAN');
  writeFileSync(join(day, '06302026_ES_RECAP.md'), 'RECAP');
  // Incomplete day (missing recap) must be skipped.
  const bad = join(dir, 'knowledge-base', 'es', '07022026');
  mkdirSync(bad, { recursive: true });
  writeFileSync(join(bad, '07022026_ES_TP.pdf'), 'x');
  writeFileSync(join(bad, '07022026_ES_TP.md'), 'x');
  return dir;
}

async function build(repoRoot: string) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      RepoInputsService,
      { provide: ConfigService, useValue: { get: (k: string) => (k === 'benchmark.repoRoot' ? repoRoot : undefined) } },
    ],
  }).compile();
  return moduleRef.get(RepoInputsService);
}

beforeAll(() => {
  root = seedFixture();
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('RepoInputsService', () => {
  it('sha256 hashes content', async () => {
    const svc = await build(root);
    expect(svc.sha256('abc')).toBe(createHash('sha256').update('abc').digest('hex'));
  });

  it('collectTraders reads name/origin/mutation, content and hash, sorted by file', async () => {
    const svc = await build(root);
    const traders = svc.collectTraders();
    expect(traders.map((t) => t.name)).toEqual(['context-trader', 'spawn']);
    expect(traders[1].origin).toBe('context-trader');
    expect(traders[1].mutation).toBe('tweak');
    expect(traders[0].sha256).toBe(svc.sha256(traders[0].content));
  });

  it('collectFeatures reads id/name/staticDoc, extracts the block, and hashes file + staticDoc', async () => {
    const svc = await build(root);
    const [f] = svc.collectFeatures();
    expect(f.id).toBe('seven-keys-method');
    expect(f.name).toBe('Seven-Keys methodology');
    expect(f.staticDoc).toBe('knowledge-base/methods/seven-keys.md');
    expect(f.block).toBe('Read ${DOC}. Grade the zones.');
    expect(f.staticDocContent).toBe('METHODS DOC');
    expect(f.staticDocSha256).toBe(svc.sha256('METHODS DOC'));
  });

  it('collectGeneralDocs concatenates in sorted path order and hashes', async () => {
    const svc = await build(root);
    const g = svc.collectGeneralDocs();
    expect(g.concatenated).toBe('AAABBB');
    expect(g.sha256).toBe(svc.sha256('AAABBB'));
  });

  it('collectDays returns only complete folders with a derived YYYY-MM-DD date', async () => {
    const svc = await build(root);
    const days = svc.collectDays();
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ day: '07012026', date: '2026-07-01', prefix: '07012026' });
    expect(days[0].pdfPath.endsWith('07012026_ES_TP.pdf')).toBe(true);
  });

  it('readMethodsDoc returns the methods content', async () => {
    const svc = await build(root);
    expect(svc.readMethodsDoc()).toBe('METHODS DOC');
  });
});
```

- [ ] **Step: Run it — expect FAIL.**

`cd backend && pnpm test -- repo-inputs.service.spec` → FAIL (module not found).

- [ ] **Step: Implement discovery.**

Create `backend/src/benchmark/repo-inputs.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ZERO_BYTES_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface TraderInput {
  name: string;
  origin: string | null;
  mutation: string | null;
  file: string;
  content: string;
  sha256: string;
}

export interface FeatureInput {
  id: string;
  name: string;
  file: string;
  block: string;
  sha256: string;
  staticDoc: string | null; // repo-relative path
  staticDocContent: string | null;
  staticDocSha256: string | null;
}

export interface GeneralDocs {
  files: { path: string; content: string }[];
  concatenated: string;
  sha256: string;
}

export interface DayInput {
  day: string; // MMDDYYYY (folder + cell key)
  date: string; // YYYY-MM-DD
  prefix: string; // 8-digit TP filename prefix
  pdfPath: string;
  planPath: string;
  recapPath: string;
}

@Injectable()
export class RepoInputsService {
  constructor(private readonly config: ConfigService) {}

  private get root(): string {
    return this.config.get<string>('benchmark.repoRoot') as string;
  }

  sha256(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  // Frontmatter parser ported verbatim from src/lineage.js parseFrontmatter.
  private parseFrontmatter(text: string): Record<string, string> {
    const fm: Record<string, string> = {};
    const lines = text.split('\n');
    if (lines[0]?.trim() !== '---') return fm;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '---') break;
      const colon = line.indexOf(':');
      if (colon === -1 || /^\s/.test(line)) continue;
      fm[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
    return fm;
  }

  // Body after the frontmatter block; ported from src/features.js extractBlock.
  private extractBlock(text: string): string {
    const lines = text.split('\n');
    if (lines[0]?.trim() !== '---') return text.trim();
    let closeIndex = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        closeIndex = i;
        break;
      }
    }
    if (closeIndex === -1) return text.trim();
    return lines.slice(closeIndex + 1).join('\n').trim();
  }

  collectTraders(): TraderInput[] {
    const dir = join(this.root, 'traders');
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name)
      .sort()
      .map((file) => {
        const content = readFileSync(join(dir, file), 'utf8');
        const fm = this.parseFrontmatter(content);
        return {
          name: fm.name || file.slice(0, -3),
          origin: fm.origin || null,
          mutation: fm.mutation || null,
          file,
          content,
          sha256: this.sha256(content),
        };
      });
  }

  collectFeatures(): FeatureInput[] {
    const dir = join(this.root, 'features');
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name)
      .sort()
      .map((file) => {
        const content = readFileSync(join(dir, file), 'utf8');
        const fm = this.parseFrontmatter(content);
        const id = fm.id || file.slice(0, -3);
        const staticDoc = fm.staticDoc || null;
        let staticDocContent: string | null = null;
        let staticDocSha256: string | null = null;
        if (staticDoc) {
          staticDocContent = readFileSync(join(this.root, staticDoc), 'utf8');
          staticDocSha256 = this.sha256(staticDocContent);
        }
        return {
          id,
          name: fm.name || id,
          file,
          block: this.extractBlock(content),
          sha256: this.sha256(content),
          staticDoc,
          staticDocContent,
          staticDocSha256,
        };
      });
  }

  collectGeneralDocs(): GeneralDocs {
    const dir = join(this.root, 'knowledge-base', 'general');
    if (!existsSync(dir)) {
      return { files: [], concatenated: '', sha256: ZERO_BYTES_SHA256 };
    }
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
      );
    const paths = walk(dir).sort();
    const files = paths.map((path) => ({ path, content: readFileSync(path, 'utf8') }));
    const concatenated = files.map((f) => f.content).join('');
    return {
      files,
      concatenated,
      sha256: concatenated ? this.sha256(concatenated) : ZERO_BYTES_SHA256,
    };
  }

  collectDays(): DayInput[] {
    const dir = join(this.root, 'knowledge-base', 'es');
    if (!existsSync(dir)) return [];
    const days: DayInput[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const folder = join(dir, entry.name);
      const files = readdirSync(folder);
      const pdf = files.find((f) => f.endsWith('_ES_TP.pdf'));
      const plan = files.find((f) => f.endsWith('_ES_TP.md'));
      const recap = files.find((f) => f.endsWith('_ES_RECAP.md'));
      if (!pdf || !plan || !recap) continue;
      // Derive the day from the 8-digit TP prefix, not the folder name.
      const prefix = pdf.slice(0, 8);
      if (!/^\d{8}$/.test(prefix) || plan.slice(0, 8) !== prefix) continue;
      const date = `${prefix.slice(4, 8)}-${prefix.slice(0, 2)}-${prefix.slice(2, 4)}`;
      days.push({
        day: prefix,
        date,
        prefix,
        pdfPath: join(folder, pdf),
        planPath: join(folder, plan),
        recapPath: join(folder, recap),
      });
    }
    return days.sort((a, b) => a.date.localeCompare(b.date));
  }

  readMethodsDoc(): string | null {
    const path = join(this.root, 'knowledge-base', 'methods', 'seven-keys.md');
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  }
}
```

- [ ] **Step: Run it — expect PASS.**

`cd backend && pnpm test -- repo-inputs.service.spec` → PASS.

- [ ] **Step: Commit.**

`git add -A && git commit -m "feat(benchmark): add repo-input discovery service"`

---

### Task 6: Extend AnthropicService (tiers, files, structured output, per-request context)

**Files:**
- Modify: `backend/src/anthropic/anthropic.service.ts`
- Modify: `backend/src/anthropic/anthropic.service.spec.ts`

Design decisions baked into this task:
1. `CachedContext` gains `userTiers?` — an ordered list of tiers, each a group of content blocks. Each tier's LAST block gets `ONE_HOUR_CACHE_CONTROL`; the trailing `prompt` is appended as one uncached text block. Total breakpoints (system + tiers) must be ≤ 4 or the call throws 400.
2. `BatchRequestInput` gains an optional per-request `context?` — REQUIRED because a single day's batch holds cells with different personas/variants, so each request needs its own envelope while still sharing the day-bundle cache (cache hits are by content, model-scoped, not batch-scoped). When absent, the batch-level `context` still applies (back-compat).
3. `createBatch` gains `opts.outputSchema?` applied as `output_config.format = { type: 'json_schema', schema }` on every request.
4. `getBatchResults` sets `type: 'refusal'` (and `stopReason`) when a succeeded message has `stop_reason === 'refusal'`, so the reconciler can distinguish a Fable refusal from a real answer.

- [ ] **Step: Update the SDK mock and shared client in the spec.**

Edit `backend/src/anthropic/anthropic.service.spec.ts`. Replace the `jest.mock` block at the top:

```ts
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: Object.assign(function () {}, { APIError: FakeAPIError }),
  toFile: jest.fn(async (bytes: Buffer, filename: string, opts?: { type?: string }) => ({
    __uploadable: true,
    filename,
    bytes,
    type: opts?.type,
  })),
}));
```

In the `beforeEach`, add `filesUpload` to the mocks and hang a `beta.files.upload` off `fakeClient`:

```ts
  let create: jest.Mock;
  let batchesCreate: jest.Mock;
  let batchesRetrieve: jest.Mock;
  let batchesResults: jest.Mock;
  let filesUpload: jest.Mock;
  let service: AnthropicService;

  beforeEach(async () => {
    create = jest.fn();
    batchesCreate = jest.fn();
    batchesRetrieve = jest.fn();
    batchesResults = jest.fn();
    filesUpload = jest.fn();
    const fakeClient = {
      messages: {
        create,
        batches: { create: batchesCreate, retrieve: batchesRetrieve, results: batchesResults },
      },
      beta: { files: { upload: filesUpload } },
    };
    // ...rest of beforeEach unchanged...
```

- [ ] **Step: Add the failing tier / files / structured-output / refusal tests.**

Append a new describe block at the end of `describe('AnthropicService', ...)` in the same spec file (before the final closing `});`):

```ts
  describe('tiers + files + structured output', () => {
    const CC = { type: 'ephemeral', ttl: '1h' };

    it('buildCachedRequest via warmCache stamps each tier last block and appends an uncached prompt', async () => {
      create.mockResolvedValue({ model: 'claude-fable-5', usage: { cache_creation_input_tokens: 10, cache_read_input_tokens: 0 } });
      await service.warmCache(
        {
          system: 'SYS',
          userTiers: [
            { blocks: [{ type: 'text', text: 'day-a' }, { type: 'text', text: 'day-b' }] },
            { blocks: [{ type: 'text', text: 'persona' }] },
          ],
        },
        { model: 'claude-fable-5' },
      );
      expect(create).toHaveBeenCalledWith({
        model: 'claude-fable-5',
        max_tokens: 0,
        system: [{ type: 'text', text: 'SYS', cache_control: CC }],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'day-a' },
              { type: 'text', text: 'day-b', cache_control: CC },
              { type: 'text', text: 'persona', cache_control: CC },
              { type: 'text', text: 'warmup' },
            ],
          },
        ],
      });
    });

    it('throws 400 when breakpoints exceed 4 (system + 4 tiers)', async () => {
      let caught: unknown;
      try {
        await service.warmCache({
          system: 's',
          userTiers: [
            { blocks: [{ type: 'text', text: '1' }] },
            { blocks: [{ type: 'text', text: '2' }] },
            { blocks: [{ type: 'text', text: '3' }] },
            { blocks: [{ type: 'text', text: '4' }] },
          ],
        });
      } catch (e) {
        caught = e;
      }
      expect((caught as HttpException).getStatus()).toBe(400);
      expect(create).not.toHaveBeenCalled();
    });

    it('createBatch applies a per-request context and output_config schema', async () => {
      batchesCreate.mockResolvedValue({ id: 'b', processing_status: 'in_progress' });
      const schema = { type: 'object' } as any;
      await service.createBatch(
        [
          { customId: 'k1', prompt: 'go', context: { system: 'S1', userTiers: [{ blocks: [{ type: 'text', text: 't1' }] }] } },
          { customId: 'k2', prompt: 'go', context: { system: 'S2', userTiers: [{ blocks: [{ type: 'text', text: 't2' }] }] } },
        ],
        undefined,
        { model: 'claude-fable-5', outputSchema: schema },
      );
      const arg = batchesCreate.mock.calls[0][0];
      expect(arg.requests[0].params.system[0].text).toBe('S1');
      expect(arg.requests[0].params.output_config).toEqual({ format: { type: 'json_schema', schema } });
      expect(arg.requests[1].params.system[0].text).toBe('S2');
    });

    it('uploadFile posts to the Files API with the beta header and returns the id', async () => {
      filesUpload.mockResolvedValue({ id: 'file_123' });
      const id = await service.uploadFile(Buffer.from('PDF'), 'x.pdf', 'application/pdf');
      expect(id).toBe('file_123');
      expect(filesUpload).toHaveBeenCalledWith(
        { file: expect.objectContaining({ __uploadable: true, filename: 'x.pdf', type: 'application/pdf' }) },
        { betas: ['files-api-2025-04-14'] },
      );
    });

    it('getBatchResults marks a refusal succeeded-message as type refusal', async () => {
      async function* gen() {
        yield {
          custom_id: 'k',
          result: { type: 'succeeded', message: { stop_reason: 'refusal', content: [], usage: {} } },
        };
      }
      batchesResults.mockResolvedValue(gen());
      const results = await service.getBatchResults('b');
      expect(results[0]).toMatchObject({ customId: 'k', type: 'refusal', stopReason: 'refusal' });
    });
  });
```

- [ ] **Step: Run it — expect FAIL.**

`cd backend && pnpm test -- anthropic.service.spec` → FAIL (userTiers/uploadFile/outputSchema/refusal not implemented).

- [ ] **Step: Implement the extensions.**

Edit `backend/src/anthropic/anthropic.service.ts`.

Change the import line to also pull `toFile`:

```ts
import Anthropic, { toFile } from '@anthropic-ai/sdk';
```

Extend `CachedContext`:

```ts
export interface CachedContext {
  /** Cached (1h TTL) system prompt shared across requests. */
  system?: string;
  /** Cached (1h TTL) leading user-message block shared across requests. */
  prefix?: string;
  /**
   * Ordered cache tiers rendered into one user message. Each tier's LAST block
   * gets a 1h breakpoint; the trailing prompt is appended uncached. Total
   * breakpoints (system + tiers) must be <= 4.
   */
  userTiers?: Array<{ blocks: Anthropic.ContentBlockParam[] }>;
}
```

Extend `BatchRequestInput` and `BatchResultItem`:

```ts
export interface BatchRequestInput {
  customId?: string;
  prompt: string;
  /** Per-request cached envelope; overrides the batch-level context when set. */
  context?: CachedContext;
}
```

```ts
export interface BatchResultItem {
  customId: string;
  type: string;
  text?: string;
  error?: string;
  cacheReadInputTokens?: number;
  /** Present so a `refusal` stop_reason is detectable by the reconciler. */
  stopReason?: string;
}
```

Replace `buildCachedRequest` with the tier-aware version:

```ts
  private buildCachedRequest(
    context: CachedContext,
    prompt: string,
  ): {
    system?: Anthropic.TextBlockParam[];
    messages: Anthropic.MessageParam[];
  } {
    const system = context.system
      ? [{ type: 'text' as const, text: context.system, cache_control: ONE_HOUR_CACHE_CONTROL }]
      : undefined;

    let messages: Anthropic.MessageParam[];
    if (context.userTiers && context.userTiers.length) {
      const breakpoints = (system ? 1 : 0) + context.userTiers.length;
      if (breakpoints > 4) {
        throw new HttpException(
          { statusCode: 400, error: `Too many cache breakpoints: ${breakpoints} (max 4)` },
          HttpStatus.BAD_REQUEST,
        );
      }
      const content: Anthropic.ContentBlockParam[] = [];
      for (const tier of context.userTiers) {
        const blocks = tier.blocks.map((b) => ({ ...b }));
        if (blocks.length) {
          blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: ONE_HOUR_CACHE_CONTROL };
        }
        content.push(...blocks);
      }
      content.push({ type: 'text', text: prompt });
      messages = [{ role: 'user', content }];
    } else if (context.prefix) {
      messages = [
        {
          role: 'user',
          content: [
            { type: 'text', text: context.prefix, cache_control: ONE_HOUR_CACHE_CONTROL },
            { type: 'text', text: prompt },
          ],
        },
      ];
    } else {
      messages = [{ role: 'user', content: prompt }];
    }

    return system ? { system, messages } : { messages };
  }
```

Relax the `warmCache` guard to accept tiers (only change the first `if`):

```ts
    if (!context.system && !context.prefix && !(context.userTiers && context.userTiers.length)) {
      throw new HttpException(
        { statusCode: 400, error: 'CachedContext requires system, prefix or userTiers' },
        HttpStatus.BAD_REQUEST,
      );
    }
```

Update `createBatch`'s signature and body to accept per-request context and `outputSchema`:

```ts
  async createBatch(
    requests: BatchRequestInput[],
    context?: CachedContext,
    opts?: { model?: string; outputSchema?: unknown },
  ): Promise<BatchSummary> {
    const client = this.clientFactory.get();
    const model = opts?.model ?? this.defaultModel;
    const maxTokens = this.defaultMaxTokens;
    try {
      const batch = await client.messages.batches.create({
        requests: requests.map((r, i) => {
          const ctx = r.context ?? context;
          const built = ctx
            ? this.buildCachedRequest(ctx, r.prompt)
            : { messages: [{ role: 'user' as const, content: r.prompt }] };
          return {
            custom_id: r.customId ?? `request-${i}`,
            params: {
              model,
              max_tokens: maxTokens,
              ...built,
              ...(opts?.outputSchema
                ? { output_config: { format: { type: 'json_schema', schema: opts.outputSchema } } }
                : {}),
            },
          };
        }),
      });
      return { batchId: batch.id, processingStatus: batch.processing_status };
    } catch (err) {
      this.rethrow(err);
    }
  }
```

In `getBatchResults`, inside the `result.type === 'succeeded'` branch, detect refusal (replace the succeeded branch body):

```ts
        if (result.type === 'succeeded') {
          const msg = result.message;
          if (msg.stop_reason === 'refusal') {
            items.push({ customId, type: 'refusal', stopReason: 'refusal' });
            continue;
          }
          let text = '';
          for (const block of msg.content) {
            if (block.type === 'text') text += block.text;
          }
          const item: BatchResultItem = { customId, type: 'succeeded', text };
          const read = msg.usage?.cache_read_input_tokens;
          if (typeof read === 'number') item.cacheReadInputTokens = read;
          items.push(item);
        } else if (result.type === 'errored') {
```

Add the `uploadFile` method (place after `message`):

```ts
  /** Uploads bytes to the Anthropic Files API and returns the file_id. */
  async uploadFile(bytes: Buffer, filename: string, mediaType: string): Promise<string> {
    const client = this.clientFactory.get();
    try {
      const file = await toFile(bytes, filename, { type: mediaType });
      const uploaded = await client.beta.files.upload({ file }, { betas: ['files-api-2025-04-14'] });
      return uploaded.id;
    } catch (err) {
      this.rethrow(err);
    }
  }
```

- [ ] **Step: Run it — expect PASS (whole anthropic suite, incl. the untouched existing tests).**

`cd backend && pnpm test -- anthropic.service.spec` → PASS.

- [ ] **Step: Commit.**

`git add -A && git commit -m "feat(anthropic): add cache tiers, files upload, structured output"`

---

### Task 7: Day artifact / PDF pipeline

**Files:**
- Create: `backend/src/benchmark/day-artifacts.service.ts`
- Create: `backend/src/benchmark/day-artifacts.service.spec.ts`

- [ ] **Step: Write the failing day-artifacts test.**

Create `backend/src/benchmark/day-artifacts.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { DayArtifactsService } from './day-artifacts.service';
import { BenchmarkRepository } from './benchmark.repository';
import { AnthropicService } from '../anthropic/anthropic.service';
import { STORAGE_BUCKET } from '../firebase/firebase.constants';
import { FIRESTORE } from '../firebase/firebase.constants';
import { fakeFirestore } from '../../test/fake-firestore';

function fakeBucket() {
  const saved: Record<string, Buffer> = {};
  return {
    saved,
    file: (path: string) => ({
      save: (buf: Buffer) => {
        saved[path] = buf;
        return Promise.resolve();
      },
      exists: () => Promise.resolve([path in saved]),
    }),
  };
}

async function build() {
  const bucket = fakeBucket();
  const upload = jest.fn().mockResolvedValue('file_new');
  const moduleRef = await Test.createTestingModule({
    providers: [
      DayArtifactsService,
      BenchmarkRepository,
      { provide: FIRESTORE, useValue: fakeFirestore() },
      { provide: STORAGE_BUCKET, useValue: bucket },
      { provide: AnthropicService, useValue: { uploadFile: upload } },
    ],
  }).compile();
  return { svc: moduleRef.get(DayArtifactsService), bucket, upload, repo: moduleRef.get(BenchmarkRepository) };
}

describe('DayArtifactsService', () => {
  it('ensurePdf stores to GCS, uploads to Anthropic, and records the artifact', async () => {
    const { svc, bucket, upload, repo } = await build();
    const res = await svc.ensurePdf('07012026', '07012026', Buffer.from('PDFBYTES'));
    expect(res.anthropicFileId).toBe('file_new');
    expect(res.gcsPath).toBe('benchmark/es/07012026/07012026_ES_TP.pdf');
    expect(bucket.saved['benchmark/es/07012026/07012026_ES_TP.pdf']).toBeDefined();
    expect(upload).toHaveBeenCalledTimes(1);
    expect((await repo.getDayArtifact('07012026', 'pdfFile'))?.anthropicFileId).toBe('file_new');
  });

  it('ensurePdf reuses the stored file_id when the content hash matches', async () => {
    const { svc, upload } = await build();
    await svc.ensurePdf('07012026', '07012026', Buffer.from('PDFBYTES'));
    const again = await svc.ensurePdf('07012026', '07012026', Buffer.from('PDFBYTES'));
    expect(again.anthropicFileId).toBe('file_new');
    expect(upload).toHaveBeenCalledTimes(1); // not re-uploaded
  });

  it('ensureTranscript mirrors text to GCS and records it', async () => {
    const { svc, bucket, repo } = await build();
    await svc.ensureTranscript('07012026', 'tpTranscript', '07012026_ES_TP.md', 'PLAN TEXT');
    expect(bucket.saved['benchmark/es/07012026/07012026_ES_TP.md']).toBeDefined();
    expect((await repo.getDayArtifact('07012026', 'tpTranscript'))?.content).toBe('PLAN TEXT');
  });
});
```

- [ ] **Step: Run it — expect FAIL.**

`cd backend && pnpm test -- day-artifacts.service.spec` → FAIL (module not found).

- [ ] **Step: Implement the pipeline.**

Create `backend/src/benchmark/day-artifacts.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { STORAGE_BUCKET } from '../firebase/firebase.constants';
import { AnthropicService } from '../anthropic/anthropic.service';
import { BenchmarkRepository, DayArtifactKind } from './benchmark.repository';

// The GCS-backed Bucket surface this service uses (kept minimal so a fake bucket
// satisfies it in tests).
export interface StorageBucketLike {
  file(path: string): { save(buf: Buffer): Promise<unknown>; exists(): Promise<[boolean]> };
}

export interface PdfArtifact {
  gcsPath: string;
  anthropicFileId: string;
  contentHash: string;
}

@Injectable()
export class DayArtifactsService {
  constructor(
    @Inject(STORAGE_BUCKET) private readonly bucket: StorageBucketLike,
    private readonly anthropic: AnthropicService,
    private readonly repo: BenchmarkRepository,
  ) {}

  private hash(bytes: Buffer | string): string {
    return createHash('sha256').update(bytes).digest('hex');
  }

  /**
   * Firebase Storage is the durable origin; the Anthropic Files copy is the
   * serving copy. When the stored content hash matches, reuse the file_id
   * without re-writing GCS or re-uploading.
   */
  async ensurePdf(day: string, prefix: string, bytes: Buffer): Promise<PdfArtifact> {
    const contentHash = this.hash(bytes);
    const existing = await this.repo.getDayArtifact(day, 'pdfFile');
    if (existing && existing.contentHash === contentHash && existing.anthropicFileId) {
      return { gcsPath: existing.gcsPath, anthropicFileId: existing.anthropicFileId, contentHash };
    }
    const gcsPath = `benchmark/es/${day}/${prefix}_ES_TP.pdf`;
    await this.bucket.file(gcsPath).save(bytes);
    const anthropicFileId = await this.anthropic.uploadFile(bytes, `${prefix}_ES_TP.pdf`, 'application/pdf');
    await this.repo.saveDayArtifact(day, 'pdfFile', {
      contentHash,
      gcsPath,
      anthropicFileId,
      uploadedAt: new Date().toISOString(),
    });
    return { gcsPath, anthropicFileId, contentHash };
  }

  /** Mirrors a small text doc (TP / RECAP transcript) to GCS + Firestore. */
  async ensureTranscript(day: string, kind: DayArtifactKind, filename: string, text: string): Promise<void> {
    const contentHash = this.hash(text);
    const existing = await this.repo.getDayArtifact(day, kind);
    if (existing && existing.contentHash === contentHash) return;
    const gcsPath = `benchmark/es/${day}/${filename}`;
    await this.bucket.file(gcsPath).save(Buffer.from(text, 'utf8'));
    await this.repo.saveDayArtifact(day, kind, {
      contentHash,
      gcsPath,
      content: text,
      uploadedAt: new Date().toISOString(),
    });
  }
}
```

- [ ] **Step: Run it — expect PASS.**

`cd backend && pnpm test -- day-artifacts.service.spec` → PASS.

- [ ] **Step: Commit.**

`git add -A && git commit -m "feat(benchmark): add day-artifact PDF/transcript pipeline"`

---

### Task 8: Envelope builder

**Files:**
- Create: `backend/src/benchmark/envelope.builder.ts`
- Create: `backend/src/benchmark/envelope.builder.spec.ts`

- [ ] **Step: Write the failing envelope test.**

Create `backend/src/benchmark/envelope.builder.spec.ts`:

```ts
import { EnvelopeBuilder, DayBundle, TRAILING_PROMPT } from './envelope.builder';

const bundle: DayBundle = {
  date: '2026-07-01',
  anthropicFileId: 'file_1',
  tpTranscript: 'TP TEXT',
  recapTranscript: 'RECAP TEXT',
};

describe('EnvelopeBuilder', () => {
  const builder = new EnvelopeBuilder();

  it('dayBundleContext is system + one tier (the day bundle)', () => {
    const ctx = builder.dayBundleContext('GENERAL DOCS', bundle);
    expect(ctx.system).toContain('GENERAL DOCS');
    expect(ctx.userTiers).toHaveLength(1);
    const blocks = ctx.userTiers![0].blocks;
    expect(blocks[0]).toMatchObject({ type: 'document', source: { type: 'file', file_id: 'file_1' } });
    expect(blocks.some((b: any) => b.type === 'text' && b.text.includes('TP TEXT'))).toBe(true);
    expect(blocks.some((b: any) => b.type === 'text' && b.text.includes('RECAP TEXT'))).toBe(true);
  });

  it('base envelope has 3 tiers (day, persona) and NO feature tier', () => {
    const env = builder.fullEnvelope('GENERAL', bundle, 'PERSONA', { variant: 'base' });
    // system + tier2(day) + tier3(persona) = 3 breakpoints, no tier4.
    expect(env.userTiers).toHaveLength(2);
    expect(env.userTiers![1].blocks.some((b: any) => b.text.includes('PERSONA'))).toBe(true);
  });

  it('seven-keys-method envelope adds a feature tier with the methods doc', () => {
    const env = builder.fullEnvelope('GENERAL', bundle, 'PERSONA', {
      variant: 'seven-keys-method',
      featureBlock: 'Read the methodology.',
      methodsDoc: 'METHODS BODY',
    });
    expect(env.userTiers).toHaveLength(3);
    const tier4 = env.userTiers![2].blocks;
    expect(tier4.some((b: any) => b.text.includes('METHODS BODY'))).toBe(true);
    expect(tier4.some((b: any) => b.text.includes('Read the methodology.'))).toBe(true);
  });

  it('exposes the constant trailing prompt', () => {
    expect(TRAILING_PROMPT).toMatch(/single setup/i);
  });
});
```

- [ ] **Step: Run it — expect FAIL.**

`cd backend && pnpm test -- envelope.builder.spec` → FAIL (module not found).

- [ ] **Step: Implement the builder.**

Create `backend/src/benchmark/envelope.builder.ts`:

```ts
import { Injectable } from '@nestjs/common';
import type Anthropic from '@anthropic-ai/sdk';
import { CachedContext } from '../anthropic/anthropic.service';
import { Variant } from './benchmark.types';

export interface DayBundle {
  date: string;
  anthropicFileId: string;
  tpTranscript: string;
  recapTranscript: string;
}

export interface VariantSpec {
  variant: Variant;
  featureBlock?: string; // the feature's prompt body (base: undefined)
  methodsDoc?: string; // seven-keys-method's staticDoc content
}

// Constant task/schema framing appended to Tier 1 (system), shared by the whole
// matrix for a model. Mirrors the legacy trader-bench agent instructions.
const TASK_FRAMING = [
  'You are a futures trading persona on an independent benchmark run.',
  'Commit to exactly ONE trade for the ES (E-mini S&P 500) session: long or short.',
  'Anchor entry, stop loss, and take profit to the support/resistance zones in the trade plan.',
  'Prices are ES index points in quarter-point increments (e.g. 7530.25).',
  'A long requires stopLoss < entry < takeProfit; a short requires takeProfit < entry < stopLoss.',
  'Include a rationale of at most 50 words citing the plan level(s) used, a primaryZone',
  '(the specific price zone anchored to, e.g. "7481.75-7495.75"), a confidence integer 1-5,',
  'and, only if you seriously weighed a different zone or side, a rejectedAlternative',
  '(at most 30 words). Respond only with JSON matching the required schema.',
].join('\n');

export const TRAILING_PROMPT = 'Produce your single setup now as JSON matching the schema.';

@Injectable()
export class EnvelopeBuilder {
  private system(generalDocs: string): string {
    return [
      'General trading-strategy documents (session-agnostic guidance that constrains every trade):',
      generalDocs,
      '',
      TASK_FRAMING,
    ].join('\n');
  }

  private dayTier(bundle: DayBundle): { blocks: Anthropic.ContentBlockParam[] } {
    return {
      blocks: [
        {
          type: 'document',
          source: { type: 'file', file_id: bundle.anthropicFileId },
        } as Anthropic.ContentBlockParam,
        {
          type: 'text',
          text: `Trade plan video transcript for the ${bundle.date} ES session:\n${bundle.tpTranscript}`,
        },
        {
          type: 'text',
          text: `Prior-session recap transcript:\n${bundle.recapTranscript}`,
        },
      ],
    };
  }

  /** System + Tier-2 day bundle only — the cheap-to-warm, most-shared tier. */
  dayBundleContext(generalDocs: string, bundle: DayBundle): CachedContext {
    return { system: this.system(generalDocs), userTiers: [this.dayTier(bundle)] };
  }

  /** Full 3-tier (base) or 4-tier (feature) envelope for a single cell. */
  fullEnvelope(generalDocs: string, bundle: DayBundle, persona: string, spec: VariantSpec): CachedContext {
    const tiers: Array<{ blocks: Anthropic.ContentBlockParam[] }> = [
      this.dayTier(bundle),
      { blocks: [{ type: 'text', text: `Adopt this trading persona fully:\n${persona}` }] },
    ];
    if (spec.variant !== 'base') {
      const featureText = [spec.featureBlock ?? '', spec.methodsDoc ? `\n\n${spec.methodsDoc}` : '']
        .join('')
        .trim();
      tiers.push({ blocks: [{ type: 'text', text: featureText }] });
    }
    return { system: this.system(generalDocs), userTiers: tiers };
  }
}
```

- [ ] **Step: Run it — expect PASS.**

`cd backend && pnpm test -- envelope.builder.spec` → PASS.

- [ ] **Step: Commit.**

`git add -A && git commit -m "feat(benchmark): add cache-envelope builder"`

---

### Task 9: BenchmarkService.run

**Files:**
- Create: `backend/src/benchmark/benchmark.service.ts`
- Create: `backend/src/benchmark/benchmark.service.spec.ts`

- [ ] **Step: Write the failing service test.**

Create `backend/src/benchmark/benchmark.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { BenchmarkService } from './benchmark.service';
import { BenchmarkRepository } from './benchmark.repository';
import { RepoInputsService } from './repo-inputs.service';
import { DayArtifactsService } from './day-artifacts.service';
import { EnvelopeBuilder } from './envelope.builder';
import { AnthropicService } from '../anthropic/anthropic.service';
import { MarketDataService } from '../market-data/market-data.service';

jest.mock('node:fs', () => ({ ...jest.requireActual('node:fs'), readFileSync: jest.fn() }));

function makeDeps() {
  const repo = {
    existingRunIndices: jest.fn().mockResolvedValue([]),
    saveBatch: jest.fn().mockResolvedValue(undefined),
  };
  const inputs = {
    collectTraders: jest.fn().mockReturnValue([{ name: 'context-trader', origin: null, mutation: null, file: 'context-trader.md', content: 'P', sha256: 'psha' }]),
    collectFeatures: jest.fn().mockReturnValue([
      { id: 'seven-keys-method', name: 'm', file: 'seven-keys-method.md', block: 'Read ${DOC}.', sha256: 'fsha', staticDoc: 'knowledge-base/methods/seven-keys.md', staticDocContent: 'METHODS', staticDocSha256: 'dsha' },
    ]),
    collectGeneralDocs: jest.fn().mockReturnValue({ files: [], concatenated: 'GEN', sha256: 'gsha' }),
    collectDays: jest.fn().mockReturnValue([
      { day: '07012026', date: '2026-07-01', prefix: '07012026', pdfPath: '/x/07012026_ES_TP.pdf', planPath: '/x/07012026_ES_TP.md', recapPath: '/x/06302026_ES_RECAP.md' },
      { day: '07022026', date: '2026-07-02', prefix: '07022026', pdfPath: '/y/07022026_ES_TP.pdf', planPath: '/y/07022026_ES_TP.md', recapPath: '/y/07012026_ES_RECAP.md' },
    ]),
  };
  const dayArtifacts = {
    ensurePdf: jest.fn().mockResolvedValue({ gcsPath: 'gs', anthropicFileId: 'file_1', contentHash: 'h' }),
    ensureTranscript: jest.fn().mockResolvedValue(undefined),
  };
  const anthropic = {
    warmCache: jest.fn().mockResolvedValue({ cached: true }),
    createBatch: jest.fn().mockResolvedValue({ batchId: 'batch_1', processingStatus: 'in_progress' }),
  };
  const marketData = {
    getDay: jest.fn(async (_s: string, _i: string, date: string) => (date === '2026-07-01' ? [{ time: 1 }] : null)),
  };
  return { repo, inputs, dayArtifacts, anthropic, marketData };
}

async function build(deps: ReturnType<typeof makeDeps>) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      BenchmarkService,
      EnvelopeBuilder,
      { provide: BenchmarkRepository, useValue: deps.repo },
      { provide: RepoInputsService, useValue: deps.inputs },
      { provide: DayArtifactsService, useValue: deps.dayArtifacts },
      { provide: AnthropicService, useValue: deps.anthropic },
      { provide: MarketDataService, useValue: deps.marketData },
      { provide: ConfigService, useValue: { get: (k: string) => ({ 'benchmark.model': 'claude-fable-5', 'benchmark.defaultRunCount': 5 }[k]) } },
    ],
  }).compile();
  return moduleRef.get(BenchmarkService);
}

describe('BenchmarkService.run', () => {
  beforeEach(() => (readFileSync as jest.Mock).mockReturnValue(Buffer.from('BYTES')));

  it('submits one batch for the day with candles, skips the day without candles', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    const summary = await svc.run({ runCount: 2, variants: ['base'] });
    expect(deps.anthropic.createBatch).toHaveBeenCalledTimes(1);
    // 1 trader x 1 variant x 2 runs on the one candle-backed day.
    const call = deps.anthropic.createBatch.mock.calls[0];
    expect(call[0]).toHaveLength(2);
    expect(call[2].outputSchema).toBeDefined();
    expect(call[2].model).toBe('claude-fable-5');
    expect(summary.batchesSubmitted).toBe(1);
    expect(summary.cellsQueued).toBe(2);
    expect(summary.daysSkipped).toEqual([{ day: '07022026', reason: 'no candles' }]);
    expect(deps.repo.saveBatch).toHaveBeenCalledTimes(1);
    // Provenance is threaded into the batch: base cells carry date + persona/general
    // hashes and OMIT feature/staticDoc hashes.
    const saved = deps.repo.saveBatch.mock.calls[0][0];
    const meta = saved.customIdToCell['context-trader__fable__07012026__base__run1'];
    expect(meta).toEqual({ date: '2026-07-01', personaSha256: 'psha', generalSha256: 'gsha' });
  });

  it('threads feature + staticDoc hashes for the seven-keys-method variant', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    await svc.run({ runCount: 1, variants: ['seven-keys-method'] });
    const saved = deps.repo.saveBatch.mock.calls[0][0];
    const meta = saved.customIdToCell['context-trader__fable__07012026__seven-keys-method__run1'];
    expect(meta).toEqual({ date: '2026-07-01', personaSha256: 'psha', generalSha256: 'gsha', featureSha256: 'fsha', staticDocSha256: 'dsha' });
  });

  it('honours the top-up diff: no missing indices -> no batch', async () => {
    const deps = makeDeps();
    deps.repo.existingRunIndices.mockResolvedValue([1, 2]);
    const svc = await build(deps);
    const summary = await svc.run({ runCount: 2, variants: ['base'] });
    expect(deps.anthropic.createBatch).not.toHaveBeenCalled();
    expect(summary.cellsQueued).toBe(0);
  });

  it('restricts variants to the core set and warms both day-bundle and per-envelope', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    await svc.run({ runCount: 1, variants: ['base', 'seven-keys-method', 'seven-keys-scorecard'] });
    // per (trader,variant): base + seven-keys-method = 2 full-envelope warms + 1 day-bundle warm.
    expect(deps.anthropic.warmCache).toHaveBeenCalledTimes(3);
    const custIds = deps.anthropic.createBatch.mock.calls[0][0].map((r: any) => r.customId);
    expect(custIds).toEqual(
      expect.arrayContaining([
        'context-trader__fable__07012026__base__run1',
        'context-trader__fable__07012026__seven-keys-method__run1',
      ]),
    );
  });
});
```

- [ ] **Step: Run it — expect FAIL.**

`cd backend && pnpm test -- benchmark.service.spec` → FAIL (module not found).

- [ ] **Step: Implement the service.**

Create `backend/src/benchmark/benchmark.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { BenchmarkRepository, CellMeta } from './benchmark.repository';
import { RepoInputsService, DayInput } from './repo-inputs.service';
import { DayArtifactsService } from './day-artifacts.service';
import { EnvelopeBuilder, DayBundle, TRAILING_PROMPT } from './envelope.builder';
import { AnthropicService, BatchRequestInput } from '../anthropic/anthropic.service';
import { MarketDataService } from '../market-data/market-data.service';
import { CORE_VARIANTS, resolveModel, cellKey, SETUP_SCHEMA, Variant } from './benchmark.types';

// Symbol/interval the benchmark backtests against (see design §7).
const SYMBOL = 'MES';
const INTERVAL = 'min-5' as const;

export interface RunOptions {
  model?: string;
  days?: string[]; // MMDDYYYY filter
  runCount?: number;
  variants?: Variant[];
}

export interface RunSummary {
  model: { alias: string; id: string };
  batchesSubmitted: number;
  cellsQueued: number;
  daysSkipped: { day: string; reason: string }[];
}

@Injectable()
export class BenchmarkService {
  constructor(
    private readonly repo: BenchmarkRepository,
    private readonly inputs: RepoInputsService,
    private readonly dayArtifacts: DayArtifactsService,
    private readonly envelopes: EnvelopeBuilder,
    private readonly anthropic: AnthropicService,
    private readonly marketData: MarketDataService,
    private readonly config: ConfigService,
  ) {}

  async run(opts: RunOptions = {}): Promise<RunSummary> {
    const model = resolveModel(opts.model ?? (this.config.get<string>('benchmark.model') as string));
    const runCount = opts.runCount ?? this.config.get<number>('benchmark.defaultRunCount') ?? 5;
    const variants = (opts.variants ?? CORE_VARIANTS).filter((v) => CORE_VARIANTS.includes(v));

    const traders = this.inputs.collectTraders();
    const features = this.inputs.collectFeatures();
    const general = this.inputs.collectGeneralDocs();
    const featureById = new Map(features.map((f) => [f.id, f]));

    let days = this.inputs.collectDays();
    if (opts.days?.length) days = days.filter((d) => opts.days!.includes(d.day));

    const summary: RunSummary = { model, batchesSubmitted: 0, cellsQueued: 0, daysSkipped: [] };

    for (const day of days) {
      // Candle prerequisite: a day without ingested OHLC cannot be backtested.
      const candles = await this.marketData.getDay(SYMBOL, INTERVAL, day.date);
      if (!candles || candles.length === 0) {
        summary.daysSkipped.push({ day: day.day, reason: 'no candles' });
        continue;
      }

      // Compute the missing cells for this day across traders x variants.
      const requests: BatchRequestInput[] = [];
      const customIdToCell: Record<string, CellMeta> = {};
      const enveloped = new Map<string, ReturnType<EnvelopeBuilder['fullEnvelope']>>();

      const bundle = await this.assembleDay(day, general.concatenated);

      for (const trader of traders) {
        for (const variant of variants) {
          const feature = variant === 'base' ? undefined : featureById.get(variant);
          const envKey = `${trader.name}::${variant}`;
          const envelope = this.envelopes.fullEnvelope(general.concatenated, bundle.dayBundle, trader.content, {
            variant,
            featureBlock: feature?.block,
            methodsDoc: feature?.staticDocContent ?? undefined,
          });
          const existing = await this.repo.existingRunIndices(trader.name, model.alias, day.day, variant);
          const missing = Array.from({ length: runCount }, (_, i) => i + 1).filter((n) => !existing.includes(n));
          if (!missing.length) continue;
          enveloped.set(envKey, envelope);
          // Provenance threaded to the batch so the reconciler persists real
          // content hashes on every cell (design §4). base omits feature/doc hashes.
          const meta: CellMeta = {
            date: day.date,
            personaSha256: trader.sha256,
            generalSha256: general.sha256,
            ...(feature ? { featureSha256: feature.sha256 } : {}),
            ...(feature?.staticDocSha256 ? { staticDocSha256: feature.staticDocSha256 } : {}),
          };
          for (const runIndex of missing) {
            const key = cellKey({ trader: trader.name, modelAlias: model.alias, day: day.day, variant, runIndex });
            requests.push({ customId: key, prompt: TRAILING_PROMPT, context: envelope });
            customIdToCell[key] = meta;
          }
        }
      }

      if (!requests.length) continue;

      // Two-stage warm: day bundle first (Tier 2), then each distinct envelope.
      await this.anthropic.warmCache(this.envelopes.dayBundleContext(general.concatenated, bundle.dayBundle), {
        model: model.id,
      });
      for (const envelope of enveloped.values()) {
        await this.anthropic.warmCache(envelope, { model: model.id });
      }

      const batch = await this.anthropic.createBatch(requests, undefined, {
        model: model.id,
        outputSchema: SETUP_SCHEMA,
      });
      await this.repo.saveBatch({
        batchId: batch.batchId,
        day: day.day,
        date: day.date,
        pdfPrefix: day.prefix,
        model,
        status: 'submitted',
        customIdToCell,
        submittedAt: new Date().toISOString(),
      });
      summary.batchesSubmitted += 1;
      summary.cellsQueued += requests.length;
    }

    return summary;
  }

  // Store the PDF + transcripts, returning the assembled day bundle.
  private async assembleDay(day: DayInput, _generalDocs: string): Promise<{ dayBundle: DayBundle }> {
    const pdf = await this.dayArtifacts.ensurePdf(day.day, day.prefix, readFileSync(day.pdfPath));
    const tpTranscript = readFileSync(day.planPath, 'utf8');
    const recapTranscript = readFileSync(day.recapPath, 'utf8');
    await this.dayArtifacts.ensureTranscript(day.day, 'tpTranscript', `${day.prefix}_ES_TP.md`, tpTranscript);
    await this.dayArtifacts.ensureTranscript(day.day, 'recapTranscript', `${day.recapPath.split('/').pop()}`, recapTranscript);
    return {
      dayBundle: {
        date: day.date,
        anthropicFileId: pdf.anthropicFileId,
        tpTranscript,
        recapTranscript,
      },
    };
  }
}
```

- [ ] **Step: Run it — expect PASS.**

`cd backend && pnpm test -- benchmark.service.spec` → PASS.

- [ ] **Step: Commit.**

`git add -A && git commit -m "feat(benchmark): add run orchestration with top-up diff"`

---

### Task 10: BatchReconciler

**Files:**
- Create: `backend/src/benchmark/batch-reconciler.ts`
- Create: `backend/src/benchmark/batch-reconciler.spec.ts`

- [ ] **Step: Write the failing reconciler test.**

Create `backend/src/benchmark/batch-reconciler.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { BatchReconciler } from './batch-reconciler';
import { BenchmarkRepository } from './benchmark.repository';
import { AnthropicService } from '../anthropic/anthropic.service';
import { BacktestService } from '../execution/backtest.service';
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
    createCell: jest.fn(async (c: any) => created.push(c)),
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
  return { repo, anthropic, backtest, created };
}

async function build(deps: ReturnType<typeof makeDeps>) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      BatchReconciler,
      { provide: BenchmarkRepository, useValue: deps.repo },
      { provide: AnthropicService, useValue: deps.anthropic },
      { provide: BacktestService, useValue: deps.backtest },
    ],
  }).compile();
  return moduleRef.get(BatchReconciler);
}

describe('BatchReconciler.reconcile', () => {
  it('backtests a succeeded setup and writes a scored cell', async () => {
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

  it('marks the batch reconciled', async () => {
    const deps = makeDeps();
    const rec = await build(deps);
    await rec.reconcile();
    expect(deps.repo.updateBatch).toHaveBeenCalledWith('batch_1', expect.objectContaining({ status: 'reconciled' }));
  });

  it('treats a backtest 404/422 as an INVALID cell, not a crash', async () => {
    const deps = makeDeps();
    deps.backtest.run.mockRejectedValue(new NotFoundException('no candles'));
    const rec = await build(deps);
    await expect(rec.reconcile()).resolves.toBeUndefined();
    const cell = deps.created.find((c) => c.runIndex === 1);
    expect(cell.result.status).toBe('INVALID');
    expect(cell.note).toContain('no candles');
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
```

- [ ] **Step: Run it — expect FAIL.**

`cd backend && pnpm test -- batch-reconciler.spec` → FAIL (module not found).

- [ ] **Step: Implement the reconciler.**

Create `backend/src/benchmark/batch-reconciler.ts`:

```ts
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BenchmarkRepository, BatchDoc, BatchStatus, CellMeta } from './benchmark.repository';
import { AnthropicService, BatchResultItem } from '../anthropic/anthropic.service';
import { BacktestService } from '../execution/backtest.service';
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
    const summary = await this.anthropic.getBatch(batch.batchId);
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

    const results = await this.anthropic.getBatchResults(batch.batchId);
    for (const item of results) {
      // customId IS the cellKey; the CellMeta supplies date + content hashes.
      const meta = batch.customIdToCell[item.customId];
      await this.repo.createCell(await this.buildCell(batch, item.customId, meta, item));
    }
    await this.repo.updateBatch(batch.batchId, { status: 'reconciled', endedAt: new Date().toISOString() });
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
      // Missing candles (404), incomplete session (422) or bad order geometry
      // (400 from normalizeOrders) — record the cell as INVALID, never crash.
      return withMetaNote({ ...base, setup, result: { status: 'INVALID' }, note: (err as Error).message });
    }
  }
}
```

- [ ] **Step: Run it — expect PASS.**

`cd backend && pnpm test -- batch-reconciler.spec` → PASS.

- [ ] **Step: Commit.**

`git add -A && git commit -m "feat(benchmark): add batch reconciler with backtest judging"`

---

### Task 11: CacheWarmer

**Files:**
- Create: `backend/src/benchmark/cache-warmer.ts`
- Create: `backend/src/benchmark/cache-warmer.spec.ts`

**Cron interval decision:** the 1h ephemeral cache must be re-warmed strictly under 60 minutes. No plain cron expression fires *every 55 minutes* — cron minute fields are independent per hour, so `0 */55 * * * *` fires at :00 and :55 and then resets to :00 the next hour (a 5-minute gap, not 55). The correct primitive from `@nestjs/schedule` is `@Interval(name, ms)`, which fires every fixed span from app start. This task uses `@Interval('bench-cache-warm', 55 * 60 * 1000)`.

- [ ] **Step: Write the failing cache-warmer test.**

Create `backend/src/benchmark/cache-warmer.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { CacheWarmer } from './cache-warmer';
import { BenchmarkRepository } from './benchmark.repository';
import { RepoInputsService } from './repo-inputs.service';
import { EnvelopeBuilder } from './envelope.builder';
import { AnthropicService } from '../anthropic/anthropic.service';

jest.mock('node:fs', () => ({ ...jest.requireActual('node:fs'), readFileSync: jest.fn() }));

function makeDeps() {
  const repo = {
    nonTerminalBatches: jest.fn().mockResolvedValue([
      { batchId: 'b1', day: '07012026', date: '2026-07-01', pdfPrefix: '07012026', model: { alias: 'fable', id: 'claude-fable-5' }, status: 'submitted', customIdToCell: {}, submittedAt: 't' },
    ]),
    getDayArtifact: jest.fn(async (_day: string, kind: string) =>
      kind === 'pdfFile'
        ? { contentHash: 'h', gcsPath: 'gs', anthropicFileId: 'file_1', uploadedAt: 't' }
        : { contentHash: 'h', gcsPath: 'gs', content: kind === 'tpTranscript' ? 'TP' : 'RECAP', uploadedAt: 't' },
    ),
  };
  const inputs = { collectGeneralDocs: jest.fn().mockReturnValue({ files: [], concatenated: 'GEN', sha256: 'g' }) };
  const anthropic = { warmCache: jest.fn().mockResolvedValue({ cached: true }) };
  return { repo, inputs, anthropic };
}

async function build(deps: ReturnType<typeof makeDeps>) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      CacheWarmer,
      EnvelopeBuilder,
      { provide: BenchmarkRepository, useValue: deps.repo },
      { provide: RepoInputsService, useValue: deps.inputs },
      { provide: AnthropicService, useValue: deps.anthropic },
    ],
  }).compile();
  return moduleRef.get(CacheWarmer);
}

describe('CacheWarmer.warm', () => {
  beforeEach(() => (readFileSync as jest.Mock).mockReturnValue(Buffer.from('x')));

  it('re-warms the day bundle for each non-terminal batch using stored artifacts', async () => {
    const deps = makeDeps();
    const warmer = await build(deps);
    await warmer.warm();
    expect(deps.anthropic.warmCache).toHaveBeenCalledTimes(1);
    const [ctx, opts] = deps.anthropic.warmCache.mock.calls[0];
    expect(opts.model).toBe('claude-fable-5');
    expect(ctx.userTiers[0].blocks[0]).toMatchObject({ type: 'document', source: { file_id: 'file_1' } });
  });

  it('no-ops when there are no in-flight batches', async () => {
    const deps = makeDeps();
    deps.repo.nonTerminalBatches.mockResolvedValue([]);
    const warmer = await build(deps);
    await warmer.warm();
    expect(deps.anthropic.warmCache).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step: Run it — expect FAIL.**

`cd backend && pnpm test -- cache-warmer.spec` → FAIL (module not found).

- [ ] **Step: Implement the warmer.**

Create `backend/src/benchmark/cache-warmer.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { BenchmarkRepository } from './benchmark.repository';
import { RepoInputsService } from './repo-inputs.service';
import { EnvelopeBuilder } from './envelope.builder';
import { AnthropicService } from '../anthropic/anthropic.service';

// 55 minutes < the 1h ephemeral TTL. @Interval fires every fixed span from
// boot; a cron minute field cannot express "every 55 minutes" (see plan note).
const WARM_INTERVAL_MS = 55 * 60 * 1000;

@Injectable()
export class CacheWarmer {
  private readonly logger = new Logger(CacheWarmer.name);

  constructor(
    private readonly repo: BenchmarkRepository,
    private readonly inputs: RepoInputsService,
    private readonly envelopes: EnvelopeBuilder,
    private readonly anthropic: AnthropicService,
  ) {}

  @Interval('bench-cache-warm', WARM_INTERVAL_MS)
  async warm(): Promise<void> {
    const batches = await this.repo.nonTerminalBatches();
    if (!batches.length) return;
    const general = this.inputs.collectGeneralDocs().concatenated;
    // De-dup by day: one warm keeps the whole day's matrix hot.
    const seen = new Set<string>();
    for (const batch of batches) {
      if (seen.has(batch.day)) continue;
      seen.add(batch.day);
      try {
        const pdf = await this.repo.getDayArtifact(batch.day, 'pdfFile');
        const tp = await this.repo.getDayArtifact(batch.day, 'tpTranscript');
        const recap = await this.repo.getDayArtifact(batch.day, 'recapTranscript');
        if (!pdf?.anthropicFileId) continue;
        const ctx = this.envelopes.dayBundleContext(general, {
          date: batch.date,
          anthropicFileId: pdf.anthropicFileId,
          tpTranscript: tp?.content ?? '',
          recapTranscript: recap?.content ?? '',
        });
        await this.anthropic.warmCache(ctx, { model: batch.model.id });
      } catch (err) {
        this.logger.error(`Re-warm for day ${batch.day} failed: ${(err as Error).message}`);
      }
    }
  }
}
```

- [ ] **Step: Run it — expect PASS.**

`cd backend && pnpm test -- cache-warmer.spec` → PASS.

- [ ] **Step: Commit.**

`git add -A && git commit -m "feat(benchmark): add cache warmer for in-flight day bundles"`

---

### Task 12: ScoreboardService (vendor pure functions)

**Files:**
- Create: `backend/src/benchmark/scoreboard/lineage.ts`
- Create: `backend/src/benchmark/scoreboard/scoreboard.ts`
- Create: `backend/src/benchmark/scoreboard/scoreboard.spec.ts`
- Create: `backend/src/benchmark/scoreboard.service.ts`
- Create: `backend/src/benchmark/scoreboard.service.spec.ts`

- [ ] **Step: Vendor `buildLineage` + `renderLineage` as TS.**

Create `backend/src/benchmark/scoreboard/lineage.ts` — a behavior-identical TS port of the pure parts of `src/lineage.js` (`buildLineage`; `parseFrontmatter`/`collectTraders` stay in `RepoInputsService`):

```ts
export interface TraderNode {
  name: string;
  origin: string | null;
  mutation: string | null;
  children: TraderNode[];
}

export interface TraderLike {
  name: string;
  origin: string | null;
  mutation: string | null;
}

export function buildLineage(traders: TraderLike[]): {
  roots: TraderNode[];
  unknownGroups: { origin: string; children: TraderNode[] }[];
  cycles: TraderNode[];
} {
  const nodes = new Map<string, TraderNode>(traders.map((t) => [t.name, { ...t, children: [] }]));
  const roots: TraderNode[] = [];
  const unknown = new Map<string, TraderNode[]>();
  for (const node of nodes.values()) {
    if (!node.origin) roots.push(node);
    else if (nodes.has(node.origin)) nodes.get(node.origin)!.children.push(node);
    else {
      if (!unknown.has(node.origin)) unknown.set(node.origin, []);
      unknown.get(node.origin)!.push(node);
    }
  }
  const byName = (a: TraderNode, b: TraderNode) => a.name.localeCompare(b.name, 'en');
  for (const node of nodes.values()) node.children.sort(byName);
  roots.sort(byName);
  const unknownGroups = [...unknown.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'en'))
    .map(([origin, children]) => ({ origin, children: children.sort(byName) }));
  const seen = new Set<string>();
  const visit = (n: TraderNode) => {
    if (seen.has(n.name)) return;
    seen.add(n.name);
    n.children.forEach(visit);
  };
  roots.forEach(visit);
  unknownGroups.forEach((g) => g.children.forEach(visit));
  const cycles = [...nodes.values()].filter((n) => !seen.has(n.name)).sort(byName);
  return { roots, unknownGroups, cycles };
}
```

- [ ] **Step: Vendor `computeScoreboard` / `computeFeatureImpact` / `renderScoreboard` / `renderLineage` as TS.**

Create `backend/src/benchmark/scoreboard/scoreboard.ts` — a behavior-identical port of `src/scoreboard.js` (same logic, TS-annotated; `import { buildLineage }` from the vendored `./lineage`). Copy the JS verbatim and add types:

```ts
import { buildLineage, TraderLike, TraderNode } from './lineage';

export interface ScoreCell {
  trader: string;
  model: { alias: string };
  variant: string;
  day: string; // MMDDYYYY
  runIndex: number;
  setup?: { side: string; entry: number };
  result: { status: string; points?: number | null; dollars?: number | null };
  note?: string;
  combines?: string[];
}

export interface FeatureLike {
  id: string;
  name: string;
  combines?: string[] | null;
}

const SCORED = new Set(['TP', 'SL', 'EOD', 'NOT_FILLED']);
const FILLED = new Set(['TP', 'SL', 'EOD']);

const rekey = (day: string) => day.slice(4) + day.slice(0, 4);
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
function sampleStd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

export function computeScoreboard(cells: ScoreCell[]) {
  const byGroup = new Map<string, ScoreCell[]>();
  for (const c of cells) {
    const key = JSON.stringify([c.trader, c.model.alias, c.variant]);
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key)!.push(c);
  }
  const groups = [...byGroup.values()].map(summarizeGroup);
  groups.sort(
    (a, b) =>
      b.meanDollars - a.meanDollars ||
      a.trader.localeCompare(b.trader, 'en') ||
      a.model.localeCompare(b.model, 'en') ||
      a.variant.localeCompare(b.variant, 'en'),
  );
  const maxCells = groups.reduce((m, g) => Math.max(m, g.cellCount), 0);
  return { groups, maxCells };
}

export type Group = ReturnType<typeof summarizeGroup>;

function summarizeGroup(cells: ScoreCell[]) {
  const { trader, variant } = cells[0];
  const model = cells[0].model.alias;
  const days = [...new Set(cells.map((c) => c.day))].sort((a, b) => rekey(a).localeCompare(rekey(b)));
  const runIndices = [...new Set(cells.map((c) => c.runIndex))].sort((a, b) => a - b);

  const runTotals = runIndices.map((runIndex) => {
    const runCells = cells.filter((c) => c.runIndex === runIndex);
    let points = 0;
    let dollars = 0;
    for (const c of runCells) {
      if (FILLED.has(c.result.status)) {
        points += c.result.points ?? 0;
        dollars += c.result.dollars ?? 0;
      }
    }
    return { runIndex, days: runCells.length, points, dollars };
  });

  const dollarSeries = runTotals.map((r) => r.dollars);
  const scored = cells.filter((c) => SCORED.has(c.result.status));
  const filled = cells.filter((c) => FILLED.has(c.result.status));
  const wins = filled.filter((c) => (c.result.points ?? 0) > 0);
  const losses = filled.filter((c) => (c.result.points ?? 0) < 0);

  const stability = days.map((day) => {
    const withSetup = cells.filter((c) => c.day === day && c.setup);
    const entries = withSetup.map((c) => c.setup!.entry);
    return {
      day,
      runs: cells.filter((c) => c.day === day).length,
      long: withSetup.filter((c) => c.setup!.side === 'long').length,
      short: withSetup.filter((c) => c.setup!.side === 'short').length,
      entrySpread: entries.length > 1 ? Math.max(...entries) - Math.min(...entries) : 0,
    };
  });

  const errors = cells
    .filter((c) => !SCORED.has(c.result.status))
    .sort((a, b) => rekey(a.day).localeCompare(rekey(b.day)) || a.runIndex - b.runIndex)
    .map((c) => ({ day: c.day, runIndex: c.runIndex, status: c.result.status, note: c.note }));

  return {
    trader,
    model,
    variant,
    cells,
    cellCount: cells.length,
    days,
    runIndices,
    runTotals,
    meanDollars: mean(dollarSeries),
    meanPoints: mean(runTotals.map((r) => r.points)),
    stdDollars: sampleStd(dollarSeries),
    minRunDollars: Math.min(...dollarSeries),
    maxRunDollars: Math.max(...dollarSeries),
    scoredCount: scored.length,
    filledCount: filled.length,
    winCount: wins.length,
    lossCount: losses.length,
    winRate: filled.length ? wins.length / filled.length : null,
    fillRate: scored.length ? filled.length / scored.length : 0,
    avgWinPoints: wins.length ? mean(wins.map((c) => c.result.points ?? 0)) : null,
    avgLossPoints: losses.length ? mean(losses.map((c) => c.result.points ?? 0)) : null,
    stability,
    errors,
  };
}

function statsOverDays(group: Group, daySet: Set<string>) {
  const cells = group.cells.filter((c) => daySet.has(c.day));
  const runIndices = [...new Set(cells.map((c) => c.runIndex))].sort((a, b) => a - b);
  return {
    runs: runIndices.length,
    filledCount: cells.filter((c) => FILLED.has(c.result.status)).length,
    meanDollars: mean(
      runIndices.map((runIndex) =>
        cells
          .filter((c) => c.runIndex === runIndex && FILLED.has(c.result.status))
          .reduce((s, c) => s + (c.result.dollars ?? 0), 0),
      ),
    ),
  };
}

export function computeFeatureImpact(groups: Group[], features: FeatureLike[] = []) {
  const pairKey = (g: Group) => JSON.stringify([g.trader, g.model]);
  const baseByPair = new Map<string, Group>();
  for (const g of groups) if (g.variant === 'base') baseByPair.set(pairKey(g), g);
  const groupByPairVariant = new Map(groups.map((g) => [JSON.stringify([g.trader, g.model, g.variant]), g]));
  const comboMap = new Map<string, string[]>(
    features.filter((f) => f.combines).map((f) => [f.id, f.combines as string[]]),
  );
  for (const g of groups) {
    if (!comboMap.has(g.variant)) {
      const combines = g.cells.find((c) => Array.isArray(c.combines))?.combines;
      if (combines) comboMap.set(g.variant, combines);
    }
  }
  const compareRows = (variant: string, opponentFor: (g: Group) => Group | undefined) =>
    groups
      .filter((g) => g.variant === variant)
      .map((g) => {
        const opponent = opponentFor(g);
        if (!opponent) return null;
        const shared = new Set(g.days.filter((d) => opponent.days.includes(d)));
        if (!shared.size) return null;
        const o = statsOverDays(opponent, shared);
        const f = statsOverDays(g, shared);
        if (!o.filledCount || !f.filledCount) return null;
        return {
          trader: g.trader,
          model: g.model,
          days: shared.size,
          baseRuns: o.runs,
          featureRuns: f.runs,
          baseDollars: o.meanDollars,
          featureDollars: f.meanDollars,
          delta: f.meanDollars - o.meanDollars,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a!.trader.localeCompare(b!.trader, 'en') || a!.model.localeCompare(b!.model, 'en')) as any[];
  const variants = [...new Set(groups.map((g) => g.variant).filter((v) => v !== 'base'))].sort((a, b) =>
    a.localeCompare(b, 'en'),
  );
  return variants.map((variant) => {
    const rows = compareRows(variant, (g) => baseByPair.get(pairKey(g)));
    const componentComparisons = (comboMap.get(variant) ?? []).map((component) => {
      const cRows = compareRows(variant, (g) =>
        groupByPairVariant.get(JSON.stringify([g.trader, g.model, component])),
      );
      return { component, rows: cRows, overallDelta: cRows.length ? mean(cRows.map((r) => r.delta)) : null };
    });
    return {
      variant,
      rows,
      overallDelta: rows.length ? mean(rows.map((r) => r.delta)) : null,
      componentComparisons,
    };
  });
}

const money = (v: number | null | undefined) => (v == null ? '-' : v.toFixed(2));
const pct = (v: number | null | undefined) => (v == null ? '-' : `${Math.round(v * 100)}%`);
const pts = (v: number | null | undefined) => (v == null ? '-' : v.toFixed(2));
const signed = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;

export function renderLineage(traders: TraderLike[], groups: Group[]): string[] {
  const { roots, unknownGroups, cycles } = buildLineage(traders);
  const groupsByTrader = new Map<string, Group[]>();
  for (const g of groups) {
    if (!groupsByTrader.has(g.trader)) groupsByTrader.set(g.trader, []);
    groupsByTrader.get(g.trader)!.push(g);
  }
  const lines: string[] = [];
  const emit = (node: TraderNode, depth: number) => {
    const prefix = depth === 0 ? '' : '   '.repeat(depth - 1) + '└─ ';
    const stats = (groupsByTrader.get(node.name) ?? [])
      .slice()
      .sort((a, b) => a.model.localeCompare(b.model, 'en') || a.variant.localeCompare(b.variant, 'en'))
      .map((g) => {
        let s = `${g.model}/${g.variant} ${g.runIndices.length}r: ${money(g.meanDollars)}`;
        const originGroup = node.origin
          ? (groupsByTrader.get(node.origin) ?? []).find((og) => og.model === g.model && og.variant === g.variant)
          : null;
        if (originGroup) s += ` (Δ vs origin: ${signed(g.meanDollars - originGroup.meanDollars)})`;
        return s;
      });
    lines.push(`${(prefix + node.name).padEnd(30)}${stats.length ? ' ' + stats.join(' · ') : ''}`.trimEnd());
    if (node.mutation) lines.push(' '.repeat(depth * 3 + 2) + node.mutation);
    node.children.forEach((c) => emit(c, depth + 1));
  };
  roots.forEach((r) => emit(r, 0));
  for (const g of unknownGroups) {
    lines.push(`(unknown origin: ${g.origin})`);
    g.children.forEach((c) => emit(c, 1));
  }
  if (cycles.length) lines.push(`(unreachable — origin cycle: ${cycles.map((n) => n.name).join(', ')})`);
  return lines;
}

export function renderScoreboard(
  { groups, maxCells }: { groups: Group[]; maxCells: number },
  traders: TraderLike[] = [],
  features: FeatureLike[] = [],
): string {
  const totalCells = groups.reduce((s, g) => s + g.cellCount, 0);
  const nameById = new Map(features.map((f) => [f.id, f.name]));
  const lines: string[] = [
    '# Trader Scoreboard',
    '',
    `${totalCells} cells · ${groups.length} trader@model@variant groups. ` +
      'Every group is scored alone; P&L is never combined across traders, models, or variants.',
    '',
    '## Ranking (mean net USD per run)',
    '',
    '| # | Trader | Model | Variant | Days | Runs | Mean $/run | Std $ | Min $ | Max $ | Win % | Fill % |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...groups.map(
      (g, i) =>
        `| ${i + 1} | ${g.trader} | ${g.model} | ${g.variant} | ${g.days.length} | ${g.runIndices.length} ` +
        `| ${money(g.meanDollars)} | ${money(g.stdDollars)} ` +
        `| ${money(g.minRunDollars)} | ${money(g.maxRunDollars)} | ${pct(g.winRate)} | ${pct(g.fillRate)} |`,
    ),
  ];

  const impact = computeFeatureImpact(groups, features);
  if (impact.length) {
    lines.push(
      '',
      '## Feature Impact',
      '',
      'Each row compares base and feature over their shared day set only ' +
        '(the Days column); days covered by one side never bias Δ. Runs is ' +
        'base-vs-feature run counts over those days — a lopsided pair is a ' +
        'weakly sampled verdict. Pairs where either side has no filled ' +
        'trades over the shared days are omitted rather than scored zero. ' +
        'For combos, additional tables compare the combo against each of ' +
        'its components over the same shared-day rule.',
      '',
    );
    for (const feat of impact) {
      const label = nameById.get(feat.variant) ?? feat.variant;
      lines.push(
        `### ${label}`,
        '',
        `| Trader | Model | Days | Runs | Base $/run | ${label} $/run | Δ |`,
        '|---|---|---|---|---|---|---|',
        ...feat.rows.map(
          (r) =>
            `| ${r.trader} | ${r.model} | ${r.days} | ${r.baseRuns}v${r.featureRuns} ` +
            `| ${money(r.baseDollars)} | ${money(r.featureDollars)} | ${signed(r.delta)} |`,
        ),
        '',
        feat.overallDelta == null
          ? 'No comparable (trader, model) pairs yet.'
          : `**Overall Δ for ${label} across ${feat.rows.length} trader/model pair${
              feat.rows.length === 1 ? '' : 's'
            }: ${signed(feat.overallDelta)}**`,
      );
      for (const cc of feat.componentComparisons) {
        const compLabel = nameById.get(cc.component) ?? cc.component;
        lines.push(
          '',
          `#### ${label} vs ${compLabel}`,
          '',
          `| Trader | Model | Days | Runs | ${compLabel} $/run | ${label} $/run | Δ |`,
          '|---|---|---|---|---|---|---|',
          ...cc.rows.map(
            (r) =>
              `| ${r.trader} | ${r.model} | ${r.days} | ${r.baseRuns}v${r.featureRuns} ` +
              `| ${money(r.baseDollars)} | ${money(r.featureDollars)} | ${signed(r.delta)} |`,
          ),
          '',
          cc.overallDelta == null
            ? 'No comparable (trader, model) pairs yet.'
            : `**Overall Δ for ${label} vs ${compLabel} across ${cc.rows.length} pair${
                cc.rows.length === 1 ? '' : 's'
              }: ${signed(cc.overallDelta)}**`,
        );
      }
    }
  }

  if (traders.length) {
    lines.push('', '## Lineage', '', '```', ...renderLineage(traders, groups), '```');
  }

  const traderByName = new Map(traders.map((t) => [t.name, t]));
  for (const g of groups) {
    lines.push('', `## ${g.trader} @ ${g.model} [${g.variant}]`);
    const t = traderByName.get(g.trader);
    if (t?.origin) {
      const og = groups.find((x) => x.trader === t.origin && x.model === g.model && x.variant === g.variant);
      lines.push(
        '',
        `Origin: ${t.origin} — ${t.mutation ?? '(no mutation note)'} · ` +
          (og
            ? `Δ mean $/run vs origin @ ${g.model}/${g.variant}: ${signed(g.meanDollars - og.meanDollars)}`
            : `origin has no runs at ${g.model}/${g.variant}`),
      );
    }
    lines.push(
      '',
      '| Run | Days | Pts | USD |',
      '|---|---|---|---|',
      ...g.runTotals.map((r) => `| ${r.runIndex} | ${r.days} | ${r.points} | ${money(r.dollars)} |`),
      '',
      `Wins: ${g.winCount} · Losses: ${g.lossCount} · ` +
        `Avg win: ${pts(g.avgWinPoints)} pts · Avg loss: ${pts(g.avgLossPoints)} pts`,
      '',
      '### Setup stability',
      '',
      '| Day | Runs | Sides | Entry spread |',
      '|---|---|---|---|',
      ...g.stability.map((s) => `| ${s.day} | ${s.runs} | ${s.long}L/${s.short}S | ${s.entrySpread.toFixed(2)} |`),
      '',
      '### Pipeline errors',
      '',
      ...(g.errors.length
        ? g.errors.map((e) => `- ${e.day} run-${e.runIndex}: ${e.status}${e.note ? ` — ${e.note}` : ''}`)
        : ['None.']),
    );
  }

  lines.push(
    '',
    '## Coverage',
    '',
    '| Trader | Model | Variant | Cells | Days | Runs | Status |',
    '|---|---|---|---|---|---|---|',
    ...[...groups]
      .sort(
        (a, b) =>
          a.trader.localeCompare(b.trader, 'en') ||
          a.model.localeCompare(b.model, 'en') ||
          a.variant.localeCompare(b.variant, 'en'),
      )
      .map(
        (g) =>
          `| ${g.trader} | ${g.model} | ${g.variant} | ${g.cellCount} | ${g.days.length} | ${g.runIndices.length} ` +
          `| ${g.cellCount < maxCells ? `⚠ under-tested (max ${maxCells})` : 'ok'} |`,
      ),
    '',
  );

  return lines.join('\n');
}
```

- [ ] **Step: Write the vendored-parity test.**

Create `backend/src/benchmark/scoreboard/scoreboard.spec.ts`:

```ts
import { computeScoreboard, renderScoreboard, computeFeatureImpact, ScoreCell } from './scoreboard';

function cell(o: Partial<ScoreCell>): ScoreCell {
  return {
    trader: 'context-trader', model: { alias: 'fable' }, variant: 'base',
    day: '07012026', runIndex: 1,
    setup: { side: 'long', entry: 100 },
    result: { status: 'TP', points: 10, dollars: 50 },
    ...o,
  } as ScoreCell;
}

describe('computeScoreboard', () => {
  it('groups by (trader, alias, variant) and ranks by mean $/run', () => {
    const sb = computeScoreboard([
      cell({ runIndex: 1, result: { status: 'TP', points: 10, dollars: 50 } }),
      cell({ runIndex: 2, result: { status: 'SL', points: -5, dollars: -25 } }),
      cell({ trader: 'other', result: { status: 'TP', points: 20, dollars: 100 } }),
    ]);
    expect(sb.groups).toHaveLength(2);
    expect(sb.groups[0].trader).toBe('other'); // 100 > mean(50,-25)=12.5
    expect(sb.groups[1].meanDollars).toBe(12.5);
    expect(sb.maxCells).toBe(2);
  });

  it('renders a ranking table and a coverage table', () => {
    const md = renderScoreboard(computeScoreboard([cell({})]), [], []);
    expect(md).toContain('## Ranking (mean net USD per run)');
    expect(md).toContain('## Coverage');
  });

  it('computeFeatureImpact compares a feature to base over shared days', () => {
    const groups = computeScoreboard([
      cell({ variant: 'base', day: '07012026', result: { status: 'TP', points: 10, dollars: 50 } }),
      cell({ variant: 'seven-keys-method', day: '07012026', result: { status: 'TP', points: 20, dollars: 100 } }),
    ]).groups;
    const impact = computeFeatureImpact(groups, [{ id: 'seven-keys-method', name: 'm' }]);
    expect(impact[0].variant).toBe('seven-keys-method');
    expect(impact[0].rows[0].delta).toBe(50);
  });
});
```

- [ ] **Step: Run the vendored tests — expect PASS.**

`cd backend && pnpm test -- scoreboard/scoreboard.spec` → PASS.

- [ ] **Step: Write the failing ScoreboardService test.**

Create `backend/src/benchmark/scoreboard.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { ScoreboardService } from './scoreboard.service';
import { BenchmarkRepository } from './benchmark.repository';
import { RepoInputsService } from './repo-inputs.service';
import { BenchmarkCell } from './benchmark.types';

function cell(o: Partial<BenchmarkCell> = {}): BenchmarkCell {
  return {
    trader: 'context-trader', model: { alias: 'fable', id: 'claude-fable-5' }, modelAlias: 'fable',
    day: '07012026', date: '2026-07-01', variant: 'base', runIndex: 1,
    personaSha256: 'p', generalSha256: 'g',
    setup: { side: 'long', entry: 100, stopLoss: 95, takeProfit: 110, rationale: 'r', primaryZone: 'z', confidence: 3 },
    result: { status: 'TP', points: 10, dollars: 50 }, createdAt: 't',
    ...o,
  };
}

async function build(cells: BenchmarkCell[]) {
  const repo = { listCells: jest.fn().mockResolvedValue(cells), saveScoreboard: jest.fn().mockResolvedValue(undefined), getScoreboard: jest.fn() };
  const inputs = {
    collectTraders: jest.fn().mockReturnValue([{ name: 'context-trader', origin: null, mutation: null }]),
    collectFeatures: jest.fn().mockReturnValue([{ id: 'seven-keys-method', name: 'Seven-Keys methodology' }]),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      ScoreboardService,
      { provide: BenchmarkRepository, useValue: repo },
      { provide: RepoInputsService, useValue: inputs },
    ],
  }).compile();
  return { svc: moduleRef.get(ScoreboardService), repo };
}

describe('ScoreboardService.generate', () => {
  it('computes, renders and saves the scoreboard for a model', async () => {
    const { svc, repo } = await build([cell({ runIndex: 1 }), cell({ runIndex: 2, result: { status: 'SL', points: -5, dollars: -25 } })]);
    const out = await svc.generate('fable');
    expect(repo.listCells).toHaveBeenCalledWith('fable');
    expect(out.markdown).toContain('# Trader Scoreboard');
    expect(repo.saveScoreboard).toHaveBeenCalledWith('fable', expect.objectContaining({ markdown: expect.any(String), json: expect.any(Object) }));
  });
});
```

- [ ] **Step: Run it — expect FAIL.**

`cd backend && pnpm test -- scoreboard.service.spec` → FAIL (module not found).

- [ ] **Step: Implement the service.**

Create `backend/src/benchmark/scoreboard.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { BenchmarkRepository, ScoreboardDoc } from './benchmark.repository';
import { RepoInputsService } from './repo-inputs.service';
import { computeScoreboard, renderScoreboard, ScoreCell } from './scoreboard/scoreboard';

@Injectable()
export class ScoreboardService {
  constructor(
    private readonly repo: BenchmarkRepository,
    private readonly inputs: RepoInputsService,
  ) {}

  async generate(modelAlias: string): Promise<ScoreboardDoc> {
    const cells = await this.repo.listCells(modelAlias);
    // BenchmarkCell already carries every field the pure functions read.
    const scoreCells = cells as unknown as ScoreCell[];
    const sb = computeScoreboard(scoreCells);
    const traders = this.inputs.collectTraders().map((t) => ({ name: t.name, origin: t.origin, mutation: t.mutation }));
    const features = this.inputs.collectFeatures().map((f) => ({ id: f.id, name: f.name }));
    const markdown = renderScoreboard(sb, traders, features);
    const doc: ScoreboardDoc = { json: sb, markdown, generatedAt: new Date().toISOString() };
    await this.repo.saveScoreboard(modelAlias, doc);
    return doc;
  }
}
```

- [ ] **Step: Run it — expect PASS.**

`cd backend && pnpm test -- scoreboard.service.spec` → PASS.

- [ ] **Step: Commit.**

`git add -A && git commit -m "feat(benchmark): vendor scoreboard functions and add service"`

---

### Task 13: BenchmarkController

**Files:**
- Create: `backend/src/benchmark/benchmark.controller.ts`
- Create: `backend/src/benchmark/benchmark.controller.spec.ts`

- [ ] **Step: Write the failing controller test.**

Create `backend/src/benchmark/benchmark.controller.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { BenchmarkController } from './benchmark.controller';
import { BenchmarkService } from './benchmark.service';
import { ScoreboardService } from './scoreboard.service';
import { BenchmarkRepository } from './benchmark.repository';

async function build() {
  const service = { run: jest.fn().mockResolvedValue({ batchesSubmitted: 1, cellsQueued: 5, daysSkipped: [] }) };
  const scoreboard = { generate: jest.fn().mockResolvedValue({ markdown: '# x', json: {}, generatedAt: 't' }) };
  const repo = {
    nonTerminalBatches: jest.fn().mockResolvedValue([{ batchId: 'b1', day: '07012026', status: 'submitted', customIdToCell: { a: { date: '2026-07-01', personaSha256: 'p', generalSha256: 'g' }, b: { date: '2026-07-01', personaSha256: 'p', generalSha256: 'g' } } }]),
    getScoreboard: jest.fn().mockResolvedValue({ markdown: '# saved', json: {}, generatedAt: 't' }),
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [BenchmarkController],
    providers: [
      { provide: BenchmarkService, useValue: service },
      { provide: ScoreboardService, useValue: scoreboard },
      { provide: BenchmarkRepository, useValue: repo },
    ],
  }).compile();
  return { ctrl: moduleRef.get(BenchmarkController), service, scoreboard, repo };
}

describe('BenchmarkController', () => {
  it('POST /benchmark/run forwards options to the service', async () => {
    const { ctrl, service } = await build();
    const res = await ctrl.run({ model: 'fable', runCount: 3, variants: ['base'] });
    expect(service.run).toHaveBeenCalledWith({ model: 'fable', runCount: 3, variants: ['base'], days: undefined });
    expect(res.cellsQueued).toBe(5);
  });

  it('GET /benchmark/status returns non-terminal batches with cell counts', async () => {
    const { ctrl } = await build();
    const status = await ctrl.status();
    expect(status.batches[0]).toMatchObject({ batchId: 'b1', status: 'submitted', cellCount: 2 });
  });

  it('GET /benchmark/scoreboard returns the saved scoreboard when present', async () => {
    const { ctrl } = await build();
    const sb = await ctrl.scoreboard('fable');
    expect(sb.markdown).toBe('# saved');
  });

  it('GET /benchmark/scoreboard 404s when no model has been scored', async () => {
    const { ctrl, repo } = await build();
    repo.getScoreboard.mockResolvedValue(null);
    await expect(ctrl.scoreboard('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

- [ ] **Step: Run it — expect FAIL.**

`cd backend && pnpm test -- benchmark.controller.spec` → FAIL (module not found).

- [ ] **Step: Implement the controller.**

Create `backend/src/benchmark/benchmark.controller.ts`:

```ts
import { Body, Controller, Get, NotFoundException, Post, Query } from '@nestjs/common';
import { BenchmarkService, RunSummary } from './benchmark.service';
import { ScoreboardService } from './scoreboard.service';
import { BenchmarkRepository, ScoreboardDoc } from './benchmark.repository';
import { Variant } from './benchmark.types';

interface RunBody {
  model?: string;
  days?: string[];
  runCount?: number;
  variants?: Variant[];
}

@Controller('benchmark')
export class BenchmarkController {
  constructor(
    private readonly benchmark: BenchmarkService,
    private readonly scoreboard: ScoreboardService,
    private readonly repo: BenchmarkRepository,
  ) {}

  @Post('run')
  async run(@Body() body: RunBody): Promise<RunSummary> {
    return this.benchmark.run({
      model: body.model,
      days: body.days,
      runCount: body.runCount,
      variants: body.variants,
    });
  }

  @Get('status')
  async status(): Promise<{ batches: { batchId: string; day: string; status: string; cellCount: number }[] }> {
    const batches = await this.repo.nonTerminalBatches();
    return {
      batches: batches.map((b) => ({
        batchId: b.batchId,
        day: b.day,
        status: b.status,
        cellCount: Object.keys(b.customIdToCell ?? {}).length,
      })),
    };
  }

  @Get('scoreboard')
  async scoreboard(@Query('model') model: string): Promise<ScoreboardDoc> {
    const saved = await this.repo.getScoreboard(model);
    if (saved) return saved;
    throw new NotFoundException(`No scoreboard for model ${model}; run the benchmark first`);
  }
}
```

Note: `scoreboard()` serves the materialized doc; regeneration is driven explicitly via `ScoreboardService.generate` (called after reconciliation in the e2e path). If a live recompute endpoint is later wanted, add `?refresh=true` to call `generate`. Kept read-only here to match the design's HTTP-endpoints-only scope.

- [ ] **Step: Run it — expect PASS.**

`cd backend && pnpm test -- benchmark.controller.spec` → PASS.

- [ ] **Step: Commit.**

`git add -A && git commit -m "feat(benchmark): add benchmark controller"`

---

### Task 14: BenchmarkModule wiring

**Files:**
- Create: `backend/src/benchmark/benchmark.module.ts`
- Modify: `backend/src/app.module.ts`

- [ ] **Step: Create the module.**

Create `backend/src/benchmark/benchmark.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { AnthropicModule } from '../anthropic/anthropic.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { ExecutionModule } from '../execution/execution.module';
import { BenchmarkRepository } from './benchmark.repository';
import { RepoInputsService } from './repo-inputs.service';
import { DayArtifactsService } from './day-artifacts.service';
import { EnvelopeBuilder } from './envelope.builder';
import { BenchmarkService } from './benchmark.service';
import { BatchReconciler } from './batch-reconciler';
import { CacheWarmer } from './cache-warmer';
import { ScoreboardService } from './scoreboard.service';

@Module({
  // AnthropicModule + FirebaseModule are @Global, but importing AnthropicModule
  // explicitly documents the dependency; MarketData/Execution are not global.
  imports: [AnthropicModule, MarketDataModule, ExecutionModule],
  providers: [
    BenchmarkRepository,
    RepoInputsService,
    DayArtifactsService,
    EnvelopeBuilder,
    BenchmarkService,
    BatchReconciler,
    CacheWarmer,
    ScoreboardService,
  ],
  exports: [BenchmarkService, ScoreboardService, BenchmarkRepository],
})
export class BenchmarkModule {}
```

- [ ] **Step: Register the module and controller in AppModule.**

Edit `backend/src/app.module.ts` — add imports and register:

```ts
import { BenchmarkModule } from './benchmark/benchmark.module';
import { BenchmarkController } from './benchmark/benchmark.controller';
```

Add `BenchmarkModule` to the `imports` array (after `ExecutionModule`) and `BenchmarkController` to the `controllers` array (after `BacktestController`):

```ts
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    ScheduleModule.forRoot(),
    FirebaseModule,
    AnthropicModule,
    ContractsModule,
    MarketDataModule,
    ExecutionModule,
    BenchmarkModule,
  ],
  controllers: [
    HealthController,
    FirestoreDemoController,
    StorageDemoController,
    AnthropicDemoController,
    MarketDataController,
    BacktestController,
    BenchmarkController,
  ],
```

- [ ] **Step: Verify the whole unit suite passes and the app compiles.**

`cd backend && pnpm test` → PASS. Then `cd backend && pnpm build` → succeeds (no unresolved providers; `BenchmarkController`'s deps resolve through `BenchmarkModule`).

- [ ] **Step: Commit.**

`git add -A && git commit -m "feat(benchmark): wire benchmark module into app"`

---

### Task 15: End-to-end

**Files:**
- Create: `backend/test/benchmark.e2e-spec.ts`

The e2e drives the full pipeline over an in-memory Firestore + a mocked `@anthropic-ai/sdk` + a fake Storage bucket + a temp-fixture `REPO_ROOT`, then simulates a batch ending and asserts cells persist and the scoreboard renders. It also seeds a non-terminal batch before boot to prove startup reconciliation drains it.

- [ ] **Step: Write the e2e spec.**

Create `backend/test/benchmark.e2e-spec.ts`:

```ts
// The SDK mock must be declared before importing AppModule.
const succeeded = (side: string) => ({
  type: 'succeeded',
  message: {
    stop_reason: 'end_turn',
    usage: { cache_read_input_tokens: 10 },
    content: [{ type: 'text', text: JSON.stringify({ side, entry: 100, stopLoss: 95, takeProfit: 110, rationale: 'r', primaryZone: 'z', confidence: 3 }) }],
  },
});

const batchState: { status: string } = { status: 'ended' };

class FakeAPIError extends Error {
  status?: number;
  constructor(status: number | undefined, message: string) {
    super(message);
    this.status = status;
  }
}

jest.mock('@anthropic-ai/sdk', () => {
  const ctor: any = function () {
    return {
      messages: {
        create: jest.fn().mockResolvedValue({ model: 'claude-fable-5', usage: { cache_creation_input_tokens: 100, cache_read_input_tokens: 0 } }),
        batches: {
          create: jest.fn().mockResolvedValue({ id: 'batch_e2e', processing_status: 'in_progress' }),
          retrieve: jest.fn(async () => ({ id: 'batch_e2e', processing_status: batchState.status, request_counts: {} })),
          results: jest.fn(async () => {
            async function* gen() {
              // Two cells for one trader x base x runCount 2.
              yield { custom_id: 'context-trader__fable__07012026__base__run1', result: succeeded('long') };
              yield { custom_id: 'context-trader__fable__07012026__base__run2', result: succeeded('short') };
            }
            return gen();
          }),
        },
      },
      beta: { files: { upload: jest.fn().mockResolvedValue({ id: 'file_e2e' }) } },
    };
  };
  ctor.APIError = FakeAPIError;
  return { __esModule: true, default: ctor, toFile: jest.fn(async (bytes: Buffer, filename: string, o?: any) => ({ bytes, filename, type: o?.type })) };
});

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppModule } from '../src/app.module';
import { FIRESTORE, STORAGE_BUCKET } from '../src/firebase/firebase.constants';
import { fakeFirestore } from './fake-firestore';
import { BatchReconciler } from '../src/benchmark/batch-reconciler';
import { ScoreboardService } from '../src/benchmark/scoreboard.service';

function fakeBucket() {
  const saved: Record<string, Buffer> = {};
  return { saved, file: (path: string) => ({ save: (b: Buffer) => { saved[path] = b; return Promise.resolve(); }, exists: () => Promise.resolve([path in saved] as [boolean]) }) };
}

function seedRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bench-e2e-'));
  mkdirSync(join(dir, 'traders'), { recursive: true });
  writeFileSync(join(dir, 'traders', 'context-trader.md'), '---\nname: context-trader\n---\nbody');
  mkdirSync(join(dir, 'features'), { recursive: true });
  mkdirSync(join(dir, 'knowledge-base', 'general'), { recursive: true });
  writeFileSync(join(dir, 'knowledge-base', 'general', 'g.md'), 'GEN');
  const day = join(dir, 'knowledge-base', 'es', '07012026');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, '07012026_ES_TP.pdf'), 'PDF');
  writeFileSync(join(day, '07012026_ES_TP.md'), 'PLAN');
  writeFileSync(join(day, '06302026_ES_RECAP.md'), 'RECAP');
  return dir;
}

describe('Benchmark (e2e)', () => {
  let app: INestApplication;
  let repoRoot: string;
  // 09:30 ET 2026-07-01, 78 five-minute bars = a complete RTH session.
  const OPEN = Math.floor(Date.UTC(2026, 6, 1, 13, 30, 0) / 1000);
  const fullCsv = ['time,open,high,low,close', ...Array.from({ length: 78 }, (_, i) => `${OPEN + i * 300},100,120,90,110`)].join('\n');

  async function boot(preSeed?: (db: any) => Promise<void>) {
    const db = fakeFirestore();
    if (preSeed) await preSeed(db);
    process.env.BENCHMARK_REPO_ROOT = repoRoot;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(FIRESTORE).useValue(db)
      .overrideProvider(STORAGE_BUCKET).useValue(fakeBucket())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    return moduleRef;
  }

  beforeAll(() => {
    repoRoot = seedRepo();
  });
  afterAll(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    delete process.env.BENCHMARK_REPO_ROOT;
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it('runs -> submits -> reconciles -> persists cells -> renders scoreboard', async () => {
    batchState.status = 'ended';
    const moduleRef = await boot();
    // Ingest candles for the day so the backtest can score.
    await request(app.getHttpServer()).post('/markets/MES/min-5/candles').attach('file', Buffer.from(fullCsv), 'mes.csv').expect(201);

    const runRes = await request(app.getHttpServer())
      .post('/benchmark/run')
      .send({ model: 'fable', runCount: 2, variants: ['base'] })
      .expect(201);
    expect(runRes.body.batchesSubmitted).toBe(1);
    expect(runRes.body.cellsQueued).toBe(2);

    // Drive reconciliation directly (the cron would do this every minute).
    await moduleRef.get(BatchReconciler).reconcile();

    // Scoreboard: generate then serve.
    await moduleRef.get(ScoreboardService).generate('fable');
    const sb = await request(app.getHttpServer()).get('/benchmark/scoreboard?model=fable').expect(200);
    expect(sb.body.markdown).toContain('# Trader Scoreboard');
    expect(sb.body.markdown).toContain('context-trader');

    // Status now shows the batch reconciled (terminal -> not listed).
    const status = await request(app.getHttpServer()).get('/benchmark/status').expect(200);
    expect(status.body.batches).toHaveLength(0);
  });

  it('startup reconciliation drains a batch that ended while offline', async () => {
    batchState.status = 'ended';
    // Pre-seed a non-terminal batch + candles BEFORE boot; onApplicationBootstrap should drain it.
    const moduleRef = await boot(async (db) => {
      await db.collection('benchmarkBatches').doc('batch_e2e').set({
        batchId: 'batch_e2e', day: '07012026', date: '2026-07-01', pdfPrefix: '07012026',
        model: { alias: 'fable', id: 'claude-fable-5' }, status: 'submitted',
        customIdToCell: {
          'context-trader__fable__07012026__base__run1': { date: '2026-07-01', personaSha256: 'psha', generalSha256: 'gsha' },
          'context-trader__fable__07012026__base__run2': { date: '2026-07-01', personaSha256: 'psha', generalSha256: 'gsha' },
        },
        submittedAt: 't',
      });
      // Candles must exist before the bootstrap reconcile runs the backtest.
      await db.collection('markets/MES/min-5').doc('2026-07-01').set({
        candles: Array.from({ length: 78 }, (_, i) => ({ t: OPEN + i * 300, o: 100, h: 120, l: 90, c: 110 })),
      });
    });

    // Bootstrap already ran during app.init(); the batch should be reconciled.
    const status = await request(app.getHttpServer()).get('/benchmark/status').expect(200);
    expect(status.body.batches).toHaveLength(0);
    const cells = await moduleRef.get(BatchReconciler);
    expect(cells).toBeDefined();
    // Confirm cells landed by generating + serving the scoreboard.
    await moduleRef.get(ScoreboardService).generate('fable');
    const sb = await request(app.getHttpServer()).get('/benchmark/scoreboard?model=fable').expect(200);
    expect(sb.body.markdown).toContain('context-trader');
  });
});
```

- [ ] **Step: Run the e2e — expect PASS.**

`cd backend && pnpm test:e2e -- benchmark` → PASS. Then run the full e2e suite to confirm no regressions: `cd backend && pnpm test:e2e` → PASS.

- [ ] **Step: Final full test run.**

`cd backend && pnpm test && pnpm test:e2e` → PASS (unit + e2e both green).

- [ ] **Step: Commit.**

`git add -A && git commit -m "test(benchmark): add end-to-end and startup-recovery coverage"`

---

## Deferred to Plan 2 (explicitly out of scope here)

- **Seven-keys artifact GENERATION** (`SevenKeysModule` / `SevenKeysService.generate` — the four-agent Fable chain, `dayArtifacts/{day}__keys`).
- **`seven-keys-scorecard` variant** and all artifact-backed / combo feature handling: `artifactSuffix`, `generatorSkill`, `${ARTIFACT}` substitution, combo `${DOC:id}`/`${ARTIFACT:id}` resolution, and the full `collectFeatures` validation passes (id/slug/reserved-base/duplicate/placeholder guards).
- **Immutability abort-on-mismatch guards only.** Hash PERSISTENCE onto cells is in Plan 1: discovery hashes (`personaSha256`/`generalSha256`/`featureSha256`/`staticDocSha256`) are threaded through `BatchDoc.customIdToCell` (`CellMeta`) and written onto every persisted cell (design §4). What remains for Plan 2 is the guard logic that COMPARES those stored hashes against freshly discovered ones and aborts/flags a re-run when a benchmarked persona, general-doc set, feature, or staticDoc has changed (the immutability enforcement the legacy skill's Phase-1 guards perform).
