# Anthropic API Cost Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture the dollar cost of every Anthropic API request (standard and batch) as an immutable Firestore record, attributed by service tier, operation, benchmark coordinates, and time; expose aggregation endpoints and a self-contained HTML report.

**Architecture:** A new `CostModule` prices usage locally from a versioned rate table. `AnthropicService` (sync calls) and `BatchReconciler` (per batch-result item) emit a `UsageEvent` via Nest's `EventEmitter`; a `@OnEvent` listener in `CostService` prices and persists it — fire-and-forget, so capture never adds latency to or fails the real request. Endpoints aggregate the records; `GET /costs/report` returns a self-contained HTML page.

**Tech Stack:** NestJS 10, TypeScript (ESM via ts-jest), `@nestjs/event-emitter`, Firebase Admin Firestore, Jest.

**Spec:** `docs/superpowers/specs/2026-07-27-cost-dashboard-design.md`

**Working directory:** all paths are under `backend/`. Run all commands from `backend/`.

---

### Task 1: Add event-emitter dependency and register it

**Files:**
- Modify: `backend/package.json`
- Modify: `backend/src/app.module.ts`

- [ ] **Step 1: Install the dependency**

```bash
pnpm add @nestjs/event-emitter@^2.1.1
```

- [ ] **Step 2: Register `EventEmitterModule` in AppModule**

Modify `backend/src/app.module.ts` — add the import at the top with the other imports:

```typescript
import { EventEmitterModule } from '@nestjs/event-emitter';
```

And add `EventEmitterModule.forRoot()` as the first entry of the `imports` array (before `ConfigModule.forRoot(...)` is fine; order does not matter functionally):

```typescript
  imports: [
    EventEmitterModule.forRoot(),
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    ScheduleModule.forRoot(),
    FirebaseModule,
    AnthropicModule,
    ContractsModule,
    MarketDataModule,
    ExecutionModule,
    BenchmarkModule,
  ],
```

- [ ] **Step 3: Verify the app still builds**

Run: `pnpm build`
Expected: builds with no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml src/app.module.ts
git commit -m "chore(cost): add @nestjs/event-emitter and register EventEmitterModule"
```

---

### Task 2: Cost domain types + usage parsing helpers

**Files:**
- Create: `backend/src/cost/cost.types.ts`
- Test: `backend/src/cost/cost.types.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/cost/cost.types.spec.ts`:

```typescript
import { tokensFromUsage, serviceTierFromUsage } from './cost.types';

describe('tokensFromUsage', () => {
  it('reads the detailed cache_creation TTL split when present', () => {
    const t = tokensFromUsage({
      input_tokens: 20,
      cache_read_input_tokens: 3227,
      cache_creation_input_tokens: 16434,
      cache_creation: { ephemeral_5m_input_tokens: 434, ephemeral_1h_input_tokens: 16000 },
      output_tokens: 2157,
    });
    expect(t).toEqual({ input: 20, cacheRead: 3227, cacheCreate5m: 434, cacheCreate1h: 16000, output: 2157 });
  });

  it('attributes a flat cache_creation number to 1h (this app caches at 1h TTL)', () => {
    const t = tokensFromUsage({
      input_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 16784,
      output_tokens: 1416,
    });
    expect(t).toEqual({ input: 20, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 16784, output: 1416 });
  });

  it('defaults every field to 0 for an empty/absent usage object', () => {
    expect(tokensFromUsage(undefined)).toEqual({ input: 0, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0, output: 0 });
  });
});

describe('serviceTierFromUsage', () => {
  it('returns the usage service_tier when it is a known value', () => {
    expect(serviceTierFromUsage({ service_tier: 'batch' }, 'standard')).toBe('batch');
  });
  it('falls back when service_tier is missing or unknown', () => {
    expect(serviceTierFromUsage({ service_tier: 'weird' }, 'standard')).toBe('standard');
    expect(serviceTierFromUsage({}, 'batch')).toBe('batch');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/cost/cost.types.spec.ts`
Expected: FAIL — cannot find module `./cost.types`.

- [ ] **Step 3: Write the types + helpers**

Create `backend/src/cost/cost.types.ts`:

```typescript
export type ServiceTier = 'standard' | 'batch' | 'priority';

export type Operation = 'warm' | 'setup' | 'keys-generation' | 'demo' | 'message' | 'other';

export interface BenchmarkAttribution {
  modelAlias: string;
  day?: string; // MMDDYYYY
  trader?: string;
  variant?: string;
  runIndex?: number;
}

export interface Attribution {
  operation: Operation;
  benchmark?: BenchmarkAttribution;
}

// Raw token counts extracted from a response's `usage` object.
export interface UsageTokens {
  input: number; // uncached input tokens (full price)
  cacheRead: number; // cache_read_input_tokens
  cacheCreate5m: number; // 5-minute-TTL cache writes
  cacheCreate1h: number; // 1-hour-TTL cache writes
  output: number;
}

// Emitted on the 'anthropic.usage' event by every capture point.
export interface UsageEvent {
  id: string; // deterministic for batch (`${batchId}:${customId}`), uuid for sync
  timestamp: string; // ISO-8601 UTC
  modelId: string; // the model id used on the request (e.g. 'claude-fable-5')
  serviceTier: ServiceTier;
  attribution: Attribution;
  tokens: UsageTokens;
  source: 'sync' | 'batch';
  batchId?: string;
}

export interface CostBreakdown {
  input: number;
  cacheRead: number;
  cacheCreate: number;
  output: number;
  total: number; // USD
}

// Persisted, immutable, one per request.
export interface CostRecord {
  id: string;
  timestamp: string;
  model: { alias: string; id: string };
  serviceTier: ServiceTier;
  operation: Operation;
  benchmark?: BenchmarkAttribution;
  tokens: UsageTokens;
  cost: CostBreakdown | null; // null when the model is unpriced
  pricingVersion: string | null;
  source: 'sync' | 'batch';
  batchId?: string;
  note?: string;
}

// Pull token counts from an Anthropic SDK `usage` object (beta or non-beta).
// The detailed cache_creation TTL split is used when present; otherwise a flat
// cache_creation_input_tokens is attributed to 1h, because every cached path in
// this app uses ONE_HOUR_CACHE_CONTROL. A future 5m path must surface its TTL.
export function tokensFromUsage(usage: any): UsageTokens {
  const cc = usage?.cache_creation;
  const has5m = typeof cc?.ephemeral_5m_input_tokens === 'number';
  const has1h = typeof cc?.ephemeral_1h_input_tokens === 'number';
  const hasSplit = has5m || has1h;
  const flat = usage?.cache_creation_input_tokens ?? 0;
  return {
    input: usage?.input_tokens ?? 0,
    cacheRead: usage?.cache_read_input_tokens ?? 0,
    cacheCreate5m: hasSplit ? (has5m ? cc.ephemeral_5m_input_tokens : 0) : 0,
    cacheCreate1h: hasSplit ? (has1h ? cc.ephemeral_1h_input_tokens : 0) : flat,
    output: usage?.output_tokens ?? 0,
  };
}

export function serviceTierFromUsage(usage: any, fallback: ServiceTier): ServiceTier {
  const t = usage?.service_tier;
  return t === 'standard' || t === 'batch' || t === 'priority' ? t : fallback;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/cost/cost.types.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cost/cost.types.ts src/cost/cost.types.spec.ts
git commit -m "feat(cost): cost domain types and usage-parsing helpers"
```

---

### Task 3: Pricing — versioned rate table + `priceUsage`

**Files:**
- Create: `backend/src/cost/pricing.ts`
- Test: `backend/src/cost/pricing.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/cost/pricing.spec.ts`:

```typescript
import { priceUsage } from './pricing';
import { UsageTokens } from './cost.types';

const zero: UsageTokens = { input: 0, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0, output: 0 };
const TS = '2026-07-27T13:00:00.000Z';

describe('priceUsage', () => {
  it('prices fable input + output at standard tier', () => {
    const r = priceUsage({ ...zero, input: 1_000_000, output: 1_000_000 }, 'claude-fable-5', 'standard', TS);
    expect(r).not.toBeNull();
    expect(r!.cost.input).toBeCloseTo(10, 6); // $10 / MTok
    expect(r!.cost.output).toBeCloseTo(50, 6); // $50 / MTok
    expect(r!.cost.total).toBeCloseTo(60, 6);
    expect(r!.version).toBe('fable-2026-07');
  });

  it('applies cache multipliers on the input rate (fable: 1h write x2, read x0.1)', () => {
    const r = priceUsage({ ...zero, cacheCreate1h: 1_000_000, cacheRead: 1_000_000 }, 'claude-fable-5', 'standard', TS);
    expect(r!.cost.cacheCreate).toBeCloseTo(20, 6); // 10 * 2.0
    expect(r!.cost.cacheRead).toBeCloseTo(1, 6); // 10 * 0.1
    expect(r!.cost.total).toBeCloseTo(21, 6);
  });

  it('prices 5m cache writes at x1.25', () => {
    const r = priceUsage({ ...zero, cacheCreate5m: 1_000_000 }, 'claude-fable-5', 'standard', TS);
    expect(r!.cost.cacheCreate).toBeCloseTo(12.5, 6); // 10 * 1.25
  });

  it('halves everything at batch tier', () => {
    const r = priceUsage({ ...zero, input: 1_000_000, output: 1_000_000 }, 'claude-fable-5', 'batch', TS);
    expect(r!.cost.total).toBeCloseTo(30, 6); // 60 * 0.5
  });

  it('prices opus and haiku (recorded id has a date suffix)', () => {
    const opus = priceUsage({ ...zero, input: 1_000_000 }, 'claude-opus-4-8', 'standard', TS);
    expect(opus!.cost.input).toBeCloseTo(5, 6);
    const haiku = priceUsage({ ...zero, input: 1_000_000 }, 'claude-haiku-4-5-20251001', 'standard', TS);
    expect(haiku!.cost.input).toBeCloseTo(1, 6);
  });

  it('selects sonnet intro pricing before 2026-09-01 and standard after', () => {
    const intro = priceUsage({ ...zero, input: 1_000_000 }, 'claude-sonnet-5', 'standard', '2026-08-15T00:00:00.000Z');
    expect(intro!.cost.input).toBeCloseTo(2, 6); // $2 intro
    expect(intro!.version).toBe('sonnet5-intro');
    const std = priceUsage({ ...zero, input: 1_000_000 }, 'claude-sonnet-5', 'standard', '2026-09-15T00:00:00.000Z');
    expect(std!.cost.input).toBeCloseTo(3, 6); // $3 standard
    expect(std!.version).toBe('sonnet5-standard');
  });

  it('returns null for an unknown model id (never throws)', () => {
    expect(priceUsage({ ...zero, input: 100 }, 'claude-unknown-9', 'standard', TS)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/cost/pricing.spec.ts`
Expected: FAIL — cannot find module `./pricing`.

- [ ] **Step 3: Write `pricing.ts`**

Create `backend/src/cost/pricing.ts`:

```typescript
import { CostBreakdown, ServiceTier, UsageTokens } from './cost.types';

interface RateEntry {
  id: string; // model id, matching the id recorded by resolveModel
  inputPerMTok: number;
  outputPerMTok: number;
  effectiveFrom: string; // inclusive ISO date/datetime lower bound
  effectiveTo?: string; // exclusive upper bound; omitted = open-ended
  version: string;
}

const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2.0;
const CACHE_READ = 0.1;

// Batch = 50% of standard. Priority is stubbed at 1 (the app does not use it).
const TIER_MULTIPLIER: Record<ServiceTier, number> = { standard: 1, batch: 0.5, priority: 1 };

// Rates per MTok, sourced from the claude-api pricing reference (2026-07).
// Date-windowed so historical records reprice correctly across a rate change.
export const RATE_TABLE: RateEntry[] = [
  { id: 'claude-fable-5', inputPerMTok: 10, outputPerMTok: 50, effectiveFrom: '2000-01-01', version: 'fable-2026-07' },
  { id: 'claude-opus-4-8', inputPerMTok: 5, outputPerMTok: 25, effectiveFrom: '2000-01-01', version: 'opus48-2026-07' },
  // Sonnet 5 introductory pricing runs through 2026-08-31; standard from 2026-09-01.
  { id: 'claude-sonnet-5', inputPerMTok: 2, outputPerMTok: 10, effectiveFrom: '2000-01-01', effectiveTo: '2026-09-01', version: 'sonnet5-intro' },
  { id: 'claude-sonnet-5', inputPerMTok: 3, outputPerMTok: 15, effectiveFrom: '2026-09-01', version: 'sonnet5-standard' },
  { id: 'claude-haiku-4-5-20251001', inputPerMTok: 1, outputPerMTok: 5, effectiveFrom: '2000-01-01', version: 'haiku45-2026-07' },
];

export interface PriceResult {
  cost: CostBreakdown;
  version: string;
}

// Pure. Returns null (never throws) for an unpriceable model so cost capture can
// record it as "unpriced" without ever breaking the request path.
export function priceUsage(
  tokens: UsageTokens,
  modelId: string,
  tier: ServiceTier,
  timestamp: string,
): PriceResult | null {
  const entry = RATE_TABLE.find(
    (r) => r.id === modelId && r.effectiveFrom <= timestamp && (!r.effectiveTo || timestamp < r.effectiveTo),
  );
  if (!entry) return null;

  const inRate = entry.inputPerMTok / 1_000_000;
  const outRate = entry.outputPerMTok / 1_000_000;
  const mult = TIER_MULTIPLIER[tier];
  const round = (n: number) => Math.round(n * mult * 1e8) / 1e8; // apply tier, then 8-dp round

  const input = tokens.input * inRate;
  const cacheRead = tokens.cacheRead * inRate * CACHE_READ;
  const cacheCreate = tokens.cacheCreate5m * inRate * CACHE_WRITE_5M + tokens.cacheCreate1h * inRate * CACHE_WRITE_1H;
  const output = tokens.output * outRate;

  return {
    cost: {
      input: round(input),
      cacheRead: round(cacheRead),
      cacheCreate: round(cacheCreate),
      output: round(output),
      total: round(input + cacheRead + cacheCreate + output),
    },
    version: entry.version,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/cost/pricing.spec.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cost/pricing.ts src/cost/pricing.spec.ts
git commit -m "feat(cost): versioned rate table and priceUsage pure function"
```

---

### Task 4: Cost repository (Firestore)

**Files:**
- Create: `backend/src/cost/cost.repository.ts`
- Test: `backend/src/cost/cost.repository.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/cost/cost.repository.spec.ts`:

```typescript
import { CostRepository } from './cost.repository';
import { CostRecord } from './cost.types';

// Minimal in-spec Firestore fake (write-once create + collection scan), mirroring
// the app's create()/get() usage. Matches test/fake-firestore.ts semantics.
function fakeDb() {
  const docs = new Map<string, any>();
  return {
    docs,
    collection: (base: string) => ({
      doc: (id: string) => ({
        create: (data: any) =>
          docs.has(`${base}/${id}`)
            ? Promise.reject(Object.assign(new Error('ALREADY_EXISTS'), { code: 6 }))
            : Promise.resolve(void docs.set(`${base}/${id}`, data)),
      }),
      get: () =>
        Promise.resolve({
          docs: [...docs.entries()]
            .filter(([k]) => k.startsWith(base + '/'))
            .map(([, v]) => ({ data: () => v })),
        }),
    }),
  } as any;
}

const rec = (id: string): CostRecord => ({
  id,
  timestamp: '2026-07-27T13:00:00.000Z',
  model: { alias: 'fable', id: 'claude-fable-5' },
  serviceTier: 'standard',
  operation: 'warm',
  tokens: { input: 20, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 100, output: 5 },
  cost: { input: 0, cacheRead: 0, cacheCreate: 0, output: 0, total: 0.001 },
  pricingVersion: 'fable-2026-07',
  source: 'sync',
});

describe('CostRepository', () => {
  it('saves a record and reads it back', async () => {
    const db = fakeDb();
    const repo = new CostRepository(db);
    await repo.save(rec('a'));
    const all = await repo.list();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('a');
  });

  it('is idempotent — a duplicate id is swallowed (batch write-once)', async () => {
    const db = fakeDb();
    const repo = new CostRepository(db);
    await repo.save(rec('dup'));
    await expect(repo.save(rec('dup'))).resolves.toBeUndefined();
    expect(await repo.list()).toHaveLength(1);
  });

  it('filters by model on read', async () => {
    const db = fakeDb();
    const repo = new CostRepository(db);
    await repo.save(rec('a'));
    await repo.save({ ...rec('b'), model: { alias: 'opus', id: 'claude-opus-4-8' } });
    const fable = await repo.list({ model: 'fable' });
    expect(fable.map((r) => r.id)).toEqual(['a']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/cost/cost.repository.spec.ts`
Expected: FAIL — cannot find module `./cost.repository`.

- [ ] **Step 3: Write `cost.repository.ts`**

Create `backend/src/cost/cost.repository.ts`:

```typescript
import { Inject, Injectable } from '@nestjs/common';
import type { Firestore } from 'firebase-admin/firestore';
import { FIRESTORE } from '../firebase/firebase.constants';
import { CostRecord } from './cost.types';

const COLLECTION = 'costRecords';

export interface ListFilters {
  model?: string; // matches model.alias
  from?: string; // ISO lower bound (inclusive) on timestamp
  to?: string; // ISO upper bound (exclusive) on timestamp
}

@Injectable()
export class CostRepository {
  constructor(@Inject(FIRESTORE) private readonly db: Firestore) {}

  // Write-once via create(): a duplicate id (a re-reconciled batch item keyed
  // `${batchId}:${customId}`) is swallowed so nothing is double-counted.
  async save(record: CostRecord): Promise<void> {
    try {
      await this.db.collection(COLLECTION).doc(record.id).create(record as any);
    } catch (err) {
      if ((err as { code?: number }).code === 6) return; // ALREADY_EXISTS
      throw err;
    }
  }

  // In-memory filter after a full-collection read. Adequate at this scale; swap
  // to Firestore where() queries if the collection grows large.
  async list(filters: ListFilters = {}): Promise<CostRecord[]> {
    const snap = await this.db.collection(COLLECTION).get();
    let rows = snap.docs.map((d) => d.data() as CostRecord);
    if (filters.model) rows = rows.filter((r) => r.model.alias === filters.model);
    if (filters.from) rows = rows.filter((r) => r.timestamp >= filters.from!);
    if (filters.to) rows = rows.filter((r) => r.timestamp < filters.to!);
    return rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/cost/cost.repository.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cost/cost.repository.ts src/cost/cost.repository.spec.ts
git commit -m "feat(cost): Firestore cost record repository (write-once, filtered read)"
```

---

### Task 5: Cost service — price, persist (event listener), summarize

**Files:**
- Create: `backend/src/cost/cost.service.ts`
- Test: `backend/src/cost/cost.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/cost/cost.service.spec.ts`:

```typescript
import { CostService } from './cost.service';
import { CostRecord, UsageEvent } from './cost.types';

class FakeRepo {
  saved: CostRecord[] = [];
  async save(r: CostRecord) {
    this.saved.push(r);
  }
  async list() {
    return this.saved;
  }
}

const event = (over: Partial<UsageEvent> = {}): UsageEvent => ({
  id: 'evt-1',
  timestamp: '2026-07-27T13:00:00.000Z',
  modelId: 'claude-fable-5',
  serviceTier: 'batch',
  attribution: { operation: 'setup', benchmark: { modelAlias: 'fable', day: '07222026', trader: 'context-trader', variant: 'base', runIndex: 1 } },
  tokens: { input: 20, cacheRead: 3227, cacheCreate5m: 0, cacheCreate1h: 16434, output: 2157 },
  source: 'batch',
  batchId: 'msgbatch_x',
  ...over,
});

describe('CostService.onUsage', () => {
  it('prices the event and persists a record with model alias, tier, operation, benchmark', async () => {
    const repo = new FakeRepo();
    const svc = new CostService(repo as any);
    await svc.onUsage(event());
    expect(repo.saved).toHaveLength(1);
    const r = repo.saved[0];
    expect(r.model).toEqual({ alias: 'fable', id: 'claude-fable-5' });
    expect(r.serviceTier).toBe('batch');
    expect(r.operation).toBe('setup');
    expect(r.benchmark?.trader).toBe('context-trader');
    expect(r.cost!.total).toBeGreaterThan(0);
    expect(r.pricingVersion).toBe('fable-2026-07');
  });

  it('records cost:null + a note for an unknown model, still persists', async () => {
    const repo = new FakeRepo();
    const svc = new CostService(repo as any);
    await svc.onUsage(event({ modelId: 'claude-unknown-9', attribution: { operation: 'demo' } }));
    const r = repo.saved[0];
    expect(r.cost).toBeNull();
    expect(r.pricingVersion).toBeNull();
    expect(r.note).toMatch(/unpriced/i);
    expect(r.model.alias).toBe('claude-unknown-9'); // no benchmark alias -> id
  });

  it('never throws out of onUsage even if the repo fails', async () => {
    const svc = new CostService({ save: () => Promise.reject(new Error('firestore down')), list: async () => [] } as any);
    await expect(svc.onUsage(event())).resolves.toBeUndefined();
  });

  it('summarize groups totals by the requested dimension', async () => {
    const repo = new FakeRepo();
    const svc = new CostService(repo as any);
    await svc.onUsage(event({ id: 'a', serviceTier: 'batch' }));
    await svc.onUsage(event({ id: 'b', serviceTier: 'standard', tokens: { input: 1_000_000, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0, output: 0 } }));
    const summary = await svc.summarize({ groupBy: 'tier' });
    const tiers = summary.groups.map((g) => g.key).sort();
    expect(tiers).toEqual(['batch', 'standard']);
    expect(summary.totalUsd).toBeCloseTo(summary.groups.reduce((s, g) => s + g.usd, 0), 6);
    expect(summary.cacheSavingsUsd).toBeGreaterThan(0); // event 'a' had cacheRead tokens
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/cost/cost.service.spec.ts`
Expected: FAIL — cannot find module `./cost.service`.

- [ ] **Step 3: Write `cost.service.ts`**

Create `backend/src/cost/cost.service.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { CostRepository, ListFilters } from './cost.repository';
import { priceUsage } from './pricing';
import { CostRecord, UsageEvent } from './cost.types';

export type GroupBy = 'tier' | 'operation' | 'model' | 'day' | 'trader' | 'variant';

export interface SummaryQuery extends ListFilters {
  groupBy: GroupBy;
}

export interface SummaryGroup {
  key: string;
  records: number;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export interface Summary {
  groupBy: GroupBy;
  totalUsd: number;
  totalRecords: number;
  cacheSavingsUsd: number; // full-rate cost of cacheRead tokens minus the 0.1x actually paid
  groups: SummaryGroup[];
}

@Injectable()
export class CostService {
  private readonly logger = new Logger(CostService.name);

  constructor(private readonly repo: CostRepository) {}

  // Event listener. Fire-and-forget from the emitter's perspective: any failure
  // is logged and swallowed so a pricing/persist error never affects the request.
  @OnEvent('anthropic.usage')
  async onUsage(event: UsageEvent): Promise<void> {
    try {
      const priced = priceUsage(event.tokens, event.modelId, event.serviceTier, event.timestamp);
      const alias = event.attribution.benchmark?.modelAlias ?? event.modelId;
      const record: CostRecord = {
        id: event.id,
        timestamp: event.timestamp,
        model: { alias, id: event.modelId },
        serviceTier: event.serviceTier,
        operation: event.attribution.operation,
        ...(event.attribution.benchmark ? { benchmark: event.attribution.benchmark } : {}),
        tokens: event.tokens,
        cost: priced ? priced.cost : null,
        pricingVersion: priced ? priced.version : null,
        source: event.source,
        ...(event.batchId ? { batchId: event.batchId } : {}),
        ...(priced ? {} : { note: `unpriced model: ${event.modelId}` }),
      };
      await this.repo.save(record);
    } catch (err) {
      this.logger.error(`Cost capture failed for ${event.id}: ${(err as Error).message}`);
    }
  }

  async summarize(query: SummaryQuery): Promise<Summary> {
    const { groupBy, ...filters } = query;
    const records = await this.repo.list(filters);
    const keyOf = (r: CostRecord): string => {
      switch (groupBy) {
        case 'tier':
          return r.serviceTier;
        case 'operation':
          return r.operation;
        case 'model':
          return r.model.alias;
        case 'day':
          return r.benchmark?.day ?? '(none)';
        case 'trader':
          return r.benchmark?.trader ?? '(none)';
        case 'variant':
          return r.benchmark?.variant ?? '(none)';
      }
    };

    const byKey = new Map<string, SummaryGroup>();
    let totalUsd = 0;
    let cacheSavingsUsd = 0;
    for (const r of records) {
      const usd = r.cost?.total ?? 0;
      totalUsd += usd;
      // cache savings = 9x the paid cacheRead cost (paid 0.1x, full would be 1x -> saved 0.9x)
      cacheSavingsUsd += (r.cost?.cacheRead ?? 0) * 9;
      const key = keyOf(r);
      const g =
        byKey.get(key) ??
        { key, records: 0, usd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
      g.records += 1;
      g.usd += usd;
      g.inputTokens += r.tokens.input;
      g.outputTokens += r.tokens.output;
      g.cacheReadTokens += r.tokens.cacheRead;
      g.cacheCreateTokens += r.tokens.cacheCreate5m + r.tokens.cacheCreate1h;
      byKey.set(key, g);
    }
    const round = (n: number) => Math.round(n * 1e8) / 1e8;
    const groups = [...byKey.values()].map((g) => ({ ...g, usd: round(g.usd) })).sort((a, b) => b.usd - a.usd);
    return {
      groupBy,
      totalUsd: round(totalUsd),
      totalRecords: records.length,
      cacheSavingsUsd: round(cacheSavingsUsd),
      groups,
    };
  }

  async list(filters: ListFilters): Promise<CostRecord[]> {
    return this.repo.list(filters);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/cost/cost.service.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cost/cost.service.ts src/cost/cost.service.spec.ts
git commit -m "feat(cost): CostService onUsage listener + summarize aggregation"
```

---

### Task 6: Report builder (self-contained HTML)

**Files:**
- Create: `backend/src/cost/report.builder.ts`
- Test: `backend/src/cost/report.builder.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/cost/report.builder.spec.ts`:

```typescript
import { buildReport } from './report.builder';
import { CostRecord } from './cost.types';

const rec = (over: Partial<CostRecord> = {}): CostRecord => ({
  id: 'a',
  timestamp: '2026-07-27T13:00:00.000Z',
  model: { alias: 'fable', id: 'claude-fable-5' },
  serviceTier: 'batch',
  operation: 'setup',
  benchmark: { modelAlias: 'fable', day: '07222026', trader: 'context-trader', variant: 'base', runIndex: 1 },
  tokens: { input: 20, cacheRead: 3227, cacheCreate5m: 0, cacheCreate1h: 16434, output: 2157 },
  cost: { input: 0.0001, cacheRead: 0.0032, cacheCreate: 0.164, output: 0.108, total: 0.2753 },
  pricingVersion: 'fable-2026-07',
  source: 'batch',
  batchId: 'msgbatch_x',
  ...over,
});

describe('buildReport', () => {
  it('produces a self-contained HTML document with the data embedded', () => {
    const html = buildReport([rec(), rec({ id: 'b', serviceTier: 'standard' })]);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<style>');
    expect(html).toContain('<script>');
    // No external resource references (CSP-safe / offline).
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toMatch(/href="https?:/);
    // Records are embedded as JSON.
    expect(html).toContain('"totalRecords": 2');
    expect(html).toContain('context-trader');
  });

  it('renders the total spend KPI', () => {
    const html = buildReport([rec()]);
    expect(html).toContain('0.2753'); // total USD appears in the embedded data
    expect(html).toMatch(/Total spend/i);
  });

  it('handles an empty record set without throwing', () => {
    const html = buildReport([]);
    expect(html).toContain('"totalRecords": 0');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/cost/report.builder.spec.ts`
Expected: FAIL — cannot find module `./report.builder`.

- [ ] **Step 3: Write `report.builder.ts`**

Create `backend/src/cost/report.builder.ts`. This is a functional baseline (KPIs + a filterable table + inline bar charts, no external libraries). Polish the visuals later with the `dataviz` skill.

```typescript
import { CostRecord } from './cost.types';

interface Payload {
  totalRecords: number;
  totalUsd: number;
  totalTokens: number;
  standardUsd: number;
  batchUsd: number;
  cacheSavingsUsd: number;
  records: CostRecord[];
}

function summarizePayload(records: CostRecord[]): Payload {
  let totalUsd = 0;
  let totalTokens = 0;
  let standardUsd = 0;
  let batchUsd = 0;
  let cacheSavingsUsd = 0;
  for (const r of records) {
    const usd = r.cost?.total ?? 0;
    totalUsd += usd;
    totalTokens += r.tokens.input + r.tokens.cacheRead + r.tokens.cacheCreate5m + r.tokens.cacheCreate1h + r.tokens.output;
    if (r.serviceTier === 'batch') batchUsd += usd;
    else standardUsd += usd;
    cacheSavingsUsd += (r.cost?.cacheRead ?? 0) * 9;
  }
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  return {
    totalRecords: records.length,
    totalUsd: round(totalUsd),
    totalTokens,
    standardUsd: round(standardUsd),
    batchUsd: round(batchUsd),
    cacheSavingsUsd: round(cacheSavingsUsd),
    records,
  };
}

// Build a self-contained HTML document. All data is embedded as JSON; the inline
// script renders KPI tiles and a filterable/sortable breakdown table. No network.
export function buildReport(records: CostRecord[]): string {
  const payload = summarizePayload(records);
  // Embed as JSON in a script tag; </script> is escaped to avoid breaking out.
  const json = JSON.stringify(payload, null, 2).replace(/<\/script>/gi, '<\\/script>');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Anthropic API Cost Report</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --muted:#666; --line:#e5e5e5; --tile:#f7f7f7; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f0f10; --fg:#eee; --muted:#9a9a9a; --line:#2a2a2a; --tile:#191919; } }
  body { margin:0; font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--fg); }
  main { max-width:1100px; margin:0 auto; padding:24px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:var(--muted); margin:0 0 20px; }
  .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin-bottom:24px; }
  .kpi { background:var(--tile); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .kpi .v { font-size:22px; font-weight:600; }
  .kpi .l { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  label { color:var(--muted); font-size:12px; margin-right:6px; }
  select { background:var(--tile); color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:4px 8px; }
  table { width:100%; border-collapse:collapse; margin-top:12px; }
  th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); }
  th { cursor:pointer; user-select:none; color:var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; }
  td.num,th.num { text-align:right; font-variant-numeric:tabular-nums; }
  .bar { height:8px; background:var(--tile); border-radius:4px; overflow:hidden; }
  .bar > span { display:block; height:100%; background:currentColor; }
  .wrap { overflow-x:auto; }
</style>
</head>
<body>
<main>
  <h1>Anthropic API Cost Report</h1>
  <p class="sub" id="sub"></p>
  <section class="kpis" id="kpis"></section>
  <div>
    <label for="groupBy">Group by</label>
    <select id="groupBy">
      <option value="operation">Operation</option>
      <option value="serviceTier">Service tier</option>
      <option value="model">Model</option>
      <option value="day">Day</option>
      <option value="trader">Trader</option>
      <option value="variant">Variant</option>
    </select>
  </div>
  <div class="wrap"><table id="tbl"><thead></thead><tbody></tbody></table></div>
</main>
<script id="data" type="application/json">
${json}
</script>
<script>
  const DATA = JSON.parse(document.getElementById('data').textContent);
  const usd = n => '$' + (n || 0).toFixed(4);
  const keyOf = (r, dim) => {
    if (dim === 'model') return r.model.alias;
    if (dim === 'day') return (r.benchmark && r.benchmark.day) || '(none)';
    if (dim === 'trader') return (r.benchmark && r.benchmark.trader) || '(none)';
    if (dim === 'variant') return (r.benchmark && r.benchmark.variant) || '(none)';
    return r[dim];
  };
  document.getElementById('sub').textContent =
    DATA.totalRecords + ' requests · ' + DATA.totalTokens.toLocaleString() + ' tokens';
  const kpis = [
    ['Total spend', usd(DATA.totalUsd)],
    ['Standard tier', usd(DATA.standardUsd)],
    ['Batch tier', usd(DATA.batchUsd)],
    ['Cache savings', usd(DATA.cacheSavingsUsd)],
    ['Requests', String(DATA.totalRecords)],
  ];
  document.getElementById('kpis').innerHTML = kpis
    .map(([l, v]) => '<div class="kpi"><div class="v">' + v + '</div><div class="l">' + l + '</div></div>')
    .join('');

  let sortKey = 'usd', sortDir = -1;
  function groups(dim) {
    const m = new Map();
    for (const r of DATA.records) {
      const k = keyOf(r, dim);
      const g = m.get(k) || { key: k, records: 0, usd: 0, tokens: 0 };
      g.records += 1;
      g.usd += (r.cost && r.cost.total) || 0;
      g.tokens += r.tokens.input + r.tokens.cacheRead + r.tokens.cacheCreate5m + r.tokens.cacheCreate1h + r.tokens.output;
      m.set(k, g);
    }
    return [...m.values()];
  }
  function render() {
    const dim = document.getElementById('groupBy').value;
    const rows = groups(dim).sort((a, b) => (a[sortKey] < b[sortKey] ? 1 : -1) * sortDir);
    const max = Math.max(1, ...rows.map(r => r.usd));
    const thead = document.querySelector('#tbl thead');
    const tbody = document.querySelector('#tbl tbody');
    thead.innerHTML =
      '<tr><th data-k="key">' + dim + '</th><th class="num" data-k="records">Requests</th>' +
      '<th class="num" data-k="tokens">Tokens</th><th class="num" data-k="usd">USD</th><th>Share</th></tr>';
    tbody.innerHTML = rows
      .map(r =>
        '<tr><td>' + r.key + '</td><td class="num">' + r.records + '</td><td class="num">' +
        r.tokens.toLocaleString() + '</td><td class="num">' + usd(r.usd) +
        '</td><td><div class="bar"><span style="width:' + (100 * r.usd / max).toFixed(1) + '%"></span></div></td></tr>')
      .join('');
    thead.querySelectorAll('th').forEach(th =>
      th.addEventListener('click', () => {
        const k = th.getAttribute('data-k');
        if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = -1; }
        render();
      }));
  }
  document.getElementById('groupBy').addEventListener('change', render);
  render();
</script>
</body>
</html>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/cost/report.builder.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cost/report.builder.ts src/cost/report.builder.spec.ts
git commit -m "feat(cost): self-contained HTML cost report builder"
```

---

### Task 7: Cost controller + module wiring

**Files:**
- Create: `backend/src/cost/cost.controller.ts`
- Create: `backend/src/cost/cost.module.ts`
- Test: `backend/src/cost/cost.controller.spec.ts`
- Modify: `backend/src/app.module.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/cost/cost.controller.spec.ts`:

```typescript
import { CostController } from './cost.controller';

describe('CostController', () => {
  const service = {
    summarize: jest.fn().mockResolvedValue({ groupBy: 'tier', totalUsd: 1, totalRecords: 2, cacheSavingsUsd: 0, groups: [] }),
    list: jest.fn().mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]),
  };
  const builder = jest.fn().mockReturnValue('<!doctype html>...');
  const ctrl = new CostController(service as any, { build: builder } as any);

  afterEach(() => jest.clearAllMocks());

  it('summary defaults groupBy to operation and passes filters through', async () => {
    await ctrl.summary(undefined, 'fable', '2026-07-01', '2026-08-01');
    expect(service.summarize).toHaveBeenCalledWith({ groupBy: 'operation', model: 'fable', from: '2026-07-01', to: '2026-08-01' });
  });

  it('rejects an invalid groupBy', async () => {
    await expect(ctrl.summary('nonsense' as any, undefined, undefined, undefined)).rejects.toBeDefined();
  });

  it('records applies a limit/offset window', async () => {
    const out = await ctrl.records(undefined, undefined, undefined, '2', '1');
    expect(out.total).toBe(3);
    expect(out.records).toHaveLength(2);
  });

  it('report returns the builder HTML', async () => {
    const html = await ctrl.report(undefined, undefined, undefined);
    expect(html).toContain('<!doctype html>');
    expect(builder).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/cost/cost.controller.spec.ts`
Expected: FAIL — cannot find module `./cost.controller`.

- [ ] **Step 3: Write the controller, a thin report-builder provider, and the module**

Create `backend/src/cost/report-builder.provider.ts` (wrap the pure `buildReport` in an injectable so the controller can be unit-tested with a fake):

```typescript
import { Injectable } from '@nestjs/common';
import { buildReport } from './report.builder';
import { CostRecord } from './cost.types';

@Injectable()
export class ReportBuilder {
  build(records: CostRecord[]): string {
    return buildReport(records);
  }
}
```

Create `backend/src/cost/cost.controller.ts`:

```typescript
import { BadRequestException, Controller, Get, Header, Query } from '@nestjs/common';
import { CostService, GroupBy, Summary } from './cost.service';
import { ReportBuilder } from './report-builder.provider';
import { CostRecord } from './cost.types';

const GROUP_BYS: GroupBy[] = ['tier', 'operation', 'model', 'day', 'trader', 'variant'];

@Controller('costs')
export class CostController {
  constructor(
    private readonly cost: CostService,
    private readonly report: ReportBuilder,
  ) {}

  @Get('summary')
  async summary(
    @Query('groupBy') groupBy: GroupBy | undefined,
    @Query('model') model: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
  ): Promise<Summary> {
    const gb = groupBy ?? 'operation';
    if (!GROUP_BYS.includes(gb)) {
      throw new BadRequestException(`groupBy must be one of: ${GROUP_BYS.join(', ')}`);
    }
    return this.cost.summarize({ groupBy: gb, model, from, to });
  }

  @Get('records')
  async records(
    @Query('model') model: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
  ): Promise<{ total: number; records: CostRecord[] }> {
    const all = await this.cost.list({ model, from, to });
    const off = Math.max(0, parseInt(offset ?? '0', 10) || 0);
    const lim = Math.max(1, Math.min(1000, parseInt(limit ?? '100', 10) || 100));
    return { total: all.length, records: all.slice(off, off + lim) };
  }

  @Get('report')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async report(
    @Query('model') model: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
  ): Promise<string> {
    const records = await this.cost.list({ model, from, to });
    return this.report.build(records);
  }
}
```

Create `backend/src/cost/cost.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { CostService } from './cost.service';
import { CostRepository } from './cost.repository';
import { CostController } from './cost.controller';
import { ReportBuilder } from './report-builder.provider';

// FirebaseModule is @Global, so FIRESTORE injects without importing it here.
@Module({
  controllers: [CostController],
  providers: [CostService, CostRepository, ReportBuilder],
  exports: [CostService],
})
export class CostModule {}
```

- [ ] **Step 4: Wire the module into AppModule**

Modify `backend/src/app.module.ts` — add the import near the other module imports:

```typescript
import { CostModule } from './cost/cost.module';
```

And add `CostModule` to the `imports` array (after `BenchmarkModule`):

```typescript
    BenchmarkModule,
    CostModule,
```

- [ ] **Step 5: Run tests + build to verify**

Run: `npx jest src/cost/cost.controller.spec.ts && pnpm build`
Expected: controller spec PASS (4 tests); build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/cost/cost.controller.ts src/cost/cost.controller.spec.ts src/cost/report-builder.provider.ts src/cost/cost.module.ts src/app.module.ts
git commit -m "feat(cost): /costs endpoints (summary, records, report) + CostModule wiring"
```

---

### Task 8: Emit UsageEvents from AnthropicService (sync calls) + carry batch usage

**Files:**
- Modify: `backend/src/anthropic/anthropic.service.ts`
- Modify: `backend/src/anthropic/anthropic.service.spec.ts`

Context: `message`, `messageStructured`, and `warmCache` return responses with `usage`; `getBatchResults` yields per-item results. Sync calls emit here; batch items are emitted by the reconciler (Task 9), which needs each item's raw usage — so `getBatchResults` must attach it.

- [ ] **Step 1: Write the failing tests**

Add to `backend/src/anthropic/anthropic.service.spec.ts`. First, find the existing `beforeEach`/module setup and add an `EventEmitter2` provider mock. Near the top of the file, add the import:

```typescript
import { EventEmitter2 } from '@nestjs/event-emitter';
```

In the `Test.createTestingModule({ providers: [...] })` blocks that construct `AnthropicService`, add a mock emitter provider so the service can be instantiated. Locate each `providers: [` array that includes `AnthropicService` and add:

```typescript
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
```

Then add a new `describe` block at the end of the file:

```typescript
describe('AnthropicService usage emission', () => {
  function build() {
    const emit = jest.fn();
    const create = jest.fn().mockResolvedValue({
      model: 'claude-fable-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 0, service_tier: 'standard' },
    });
    const config = { get: (k: string) => (k === 'anthropic.model' ? 'claude-fable-5' : 4096) };
    const clientFactory = { get: () => ({ messages: { create }, beta: { messages: { create } } }) };
    const svc = new (require('./anthropic.service').AnthropicService)(clientFactory, config, { emit });
    return { svc, emit, create };
  }

  it('message() emits an anthropic.usage event with attribution', async () => {
    const { svc, emit } = build();
    await svc.message({ prompt: 'x', attribution: { operation: 'demo' } });
    expect(emit).toHaveBeenCalledWith('anthropic.usage', expect.objectContaining({
      modelId: 'claude-fable-5',
      serviceTier: 'standard',
      source: 'sync',
      attribution: { operation: 'demo' },
      tokens: expect.objectContaining({ input: 10, output: 3 }),
    }));
  });

  it('message() defaults attribution to operation "message" when none given', async () => {
    const { svc, emit } = build();
    await svc.message({ prompt: 'x' });
    expect(emit).toHaveBeenCalledWith('anthropic.usage', expect.objectContaining({ attribution: { operation: 'message' } }));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/anthropic/anthropic.service.spec.ts -t "usage emission"`
Expected: FAIL — `AnthropicService` constructor has no 3rd (emitter) param / `message` has no `attribution`.

- [ ] **Step 3: Add the emitter, attribution options, and emit calls**

Modify `backend/src/anthropic/anthropic.service.ts`:

3a. Add imports near the top:

```typescript
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';
import { Attribution, ServiceTier, serviceTierFromUsage, tokensFromUsage } from '../cost/cost.types';
```

3b. Inject the emitter in the constructor. Change:

```typescript
  constructor(
    @Inject(ANTHROPIC_CLIENT)
    private readonly clientFactory: AnthropicClientFactory,
    private readonly config: ConfigService,
  ) {}
```

to:

```typescript
  constructor(
    @Inject(ANTHROPIC_CLIENT)
    private readonly clientFactory: AnthropicClientFactory,
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
  ) {}
```

3c. Add a private emit helper as a method on the class (place it just above `rethrow`):

```typescript
  // Emit a fire-and-forget usage event for a synchronous (standard-tier) call.
  private emitUsage(usage: unknown, modelId: string, attribution?: Attribution): void {
    try {
      const tier: ServiceTier = serviceTierFromUsage(usage, 'standard');
      this.events.emit('anthropic.usage', {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        modelId,
        serviceTier: tier,
        attribution: attribution ?? { operation: 'message' },
        tokens: tokensFromUsage(usage),
        source: 'sync',
      });
    } catch {
      // Capture must never affect the request; swallow emit failures.
    }
  }
```

3d. Add `attribution?: Attribution` to `MessageInput`:

```typescript
export interface MessageInput {
  prompt: string;
  system?: string;
  model?: string;
  maxTokens?: number;
  attribution?: Attribution;
}
```

3e. In `message()`, after `response` is obtained and before `return`, emit:

```typescript
      this.emitUsage(response.usage, response.model, input.attribution);
```

Insert it just before the `return {` in the try block.

3f. Add `attribution?: Attribution` to the `messageStructured` opts type and emit after `resp` is obtained (before parsing). In the `opts?:` type add `attribution?: Attribution;`, then right after the `resp` is assigned and the refusal check, add:

```typescript
      this.emitUsage((resp as any).usage, (resp as any).model ?? model, opts?.attribution);
```

3g. In `warmCache`, add `attribution?: Attribution` to the opts type. After `const first = await call();` add:

```typescript
      this.emitUsage((first as any).usage, model, opts?.attribution);
```

And inside the `if (opts?.strict)` block, after `const probe = await call();`, add:

```typescript
        this.emitUsage((probe as any).usage, model, opts?.attribution);
```

3h. Extend `createBatch`'s opts and `BatchResultItem` to carry usage for the reconciler. Add to `BatchResultItem`:

```typescript
  /** Raw usage object for succeeded/refusal items; consumed by the cost capture. */
  usage?: unknown;
```

In `getBatchResults`, where a `succeeded` item is built, attach the message usage:

```typescript
          const item: BatchResultItem = { customId, type: 'succeeded', text, usage: msg.usage };
```

(Replace the existing `const item: BatchResultItem = { customId, type: 'succeeded', text };` line; keep the subsequent `cacheReadInputTokens` attachment.) For the refusal branch, include usage too:

```typescript
          if (msg.stop_reason === 'refusal') {
            items.push({ customId, type: 'refusal', stopReason: 'refusal', usage: msg.usage });
            continue;
          }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/anthropic/anthropic.service.spec.ts`
Expected: the whole anthropic spec PASSES (existing tests + the 2 new emission tests). If an existing `providers` array constructing `AnthropicService` now errors for a missing `EventEmitter2`, add the mock provider from Step 1 to that block.

- [ ] **Step 5: Commit**

```bash
git add src/anthropic/anthropic.service.ts src/anthropic/anthropic.service.spec.ts
git commit -m "feat(cost): emit usage events from AnthropicService sync calls; carry batch usage"
```

---

### Task 9: Emit UsageEvents per batch item from the reconciler

**Files:**
- Modify: `backend/src/benchmark/batch-reconciler.ts`
- Modify: `backend/src/benchmark/batch-reconciler.spec.ts`

- [ ] **Step 1: Write the failing test**

Add to `backend/src/benchmark/batch-reconciler.spec.ts`. Near the top, ensure the emitter import:

```typescript
import { EventEmitter2 } from '@nestjs/event-emitter';
```

Find where the spec constructs `BatchReconciler` (a `new BatchReconciler(...)` call or a testing module). Add a captured emitter. Then add this test in the appropriate `describe`:

```typescript
it('emits a batch UsageEvent per succeeded item, attributed from the customId', async () => {
  const emitted: any[] = [];
  const emitter = { emit: (name: string, ev: any) => emitted.push({ name, ev }) };
  const batch = {
    batchId: 'msgbatch_1',
    day: '07222026',
    date: '2026-07-22',
    model: { alias: 'fable', id: 'claude-fable-5' },
    status: 'submitted',
    customIdToCell: {
      'context-trader__fable__07222026__base__run1': { date: '2026-07-22', personaSha256: 'p', generalSha256: 'g' },
    },
  };
  const anthropic = {
    getBatch: async () => ({ processingStatus: 'ended' }),
    getBatchResults: async () => [
      { customId: 'context-trader__fable__07222026__base__run1', type: 'succeeded',
        text: JSON.stringify({ side: 'long', entry: 100, stopLoss: 95, takeProfit: 110, rationale: 'r', primaryZone: 'z', confidence: 3 }),
        usage: { input_tokens: 20, output_tokens: 2157, cache_read_input_tokens: 3227, cache_creation_input_tokens: 16434, service_tier: 'batch' } },
    ],
  };
  const repo = {
    nonTerminalBatches: async () => [batch],
    createCell: async () => {},
    updateBatch: async () => {},
  };
  const backtest = { run: async () => ({ results: [{ status: 'NOT_FILLED', points: null, dollars: null, fillTime: null, exitTime: null, maxAdverseExcursion: null, maxFavorableExcursion: null, rMultiple: null, closestApproach: 49.75 }] }) };
  const scoreboard = { generate: async () => {} };
  const config = { get: () => false };
  const reconciler = new BatchReconciler(repo as any, anthropic as any, backtest as any, scoreboard as any, config as any, emitter as any);
  await reconciler.reconcile();

  const usage = emitted.find((e) => e.name === 'anthropic.usage');
  expect(usage).toBeDefined();
  expect(usage.ev).toEqual(expect.objectContaining({
    id: 'msgbatch_1:context-trader__fable__07222026__base__run1',
    source: 'batch',
    serviceTier: 'batch',
    batchId: 'msgbatch_1',
    modelId: 'claude-fable-5',
    attribution: { operation: 'setup', benchmark: { modelAlias: 'fable', day: '07222026', trader: 'context-trader', variant: 'base', runIndex: 1 } },
    tokens: expect.objectContaining({ input: 20, cacheRead: 3227, cacheCreate1h: 16434, output: 2157 }),
  }));
});
```

If the existing spec constructs `BatchReconciler` elsewhere without the 6th arg, update those constructions to pass `{ emit: jest.fn() } as any` as the final argument.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/benchmark/batch-reconciler.spec.ts -t "emits a batch UsageEvent"`
Expected: FAIL — `BatchReconciler` constructor has no 6th (emitter) param.

- [ ] **Step 3: Inject the emitter and emit per item**

Modify `backend/src/benchmark/batch-reconciler.ts`:

3a. Add imports near the top:

```typescript
import { EventEmitter2 } from '@nestjs/event-emitter';
import { tokensFromUsage } from '../cost/cost.types';
```

3b. Add the emitter to the constructor (after `config`):

```typescript
  constructor(
    private readonly repo: BenchmarkRepository,
    private readonly anthropic: AnthropicService,
    private readonly backtest: BacktestService,
    private readonly scoreboard: ScoreboardService,
    config: ConfigService,
    private readonly events: EventEmitter2,
  ) {
    this.schedulerEnabled = config.get<boolean>('benchmark.schedulerEnabled') ?? false;
  }
```

3c. In `reconcileBatch`, inside the `for (const item of results)` loop, immediately after the guard that `continue`s on non-succeeded/non-refusal items and before `await this.repo.createCell(...)`, emit the usage event:

```typescript
        // Cost capture: emit per-item usage attributed from the cellKey. Never
        // let a cost emit failure interfere with cell reconciliation.
        try {
          const p = parseCellKey(item.customId);
          this.events.emit('anthropic.usage', {
            id: `${batch.batchId}:${item.customId}`,
            timestamp: new Date().toISOString(),
            modelId: batch.model.id,
            serviceTier: 'batch',
            attribution: {
              operation: 'setup',
              benchmark: {
                modelAlias: batch.model.alias,
                day: batch.day,
                trader: p.trader,
                variant: p.variant,
                runIndex: p.runIndex,
              },
            },
            tokens: tokensFromUsage(item.usage),
            source: 'batch',
            batchId: batch.batchId,
          });
        } catch (e) {
          this.logger.warn(`Cost emit failed for ${item.customId}: ${(e as Error).message}`);
        }
```

Note: `parseCellKey` is already imported in this file (used by `buildCell`). The `logger` field already exists.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/benchmark/batch-reconciler.spec.ts`
Expected: whole reconciler spec PASSES (existing + new emission test).

- [ ] **Step 5: Commit**

```bash
git add src/benchmark/batch-reconciler.ts src/benchmark/batch-reconciler.spec.ts
git commit -m "feat(cost): emit per-item batch usage events from BatchReconciler"
```

---

### Task 10: Thread attribution from benchmark warms, seven-keys, and demo callers

**Files:**
- Modify: `backend/src/benchmark/benchmark.service.ts`
- Modify: `backend/src/benchmark/benchmark.service.spec.ts`
- Modify: `backend/src/benchmark/seven-keys/seven-keys.service.ts`
- Modify: `backend/src/demo/anthropic-demo.controller.ts`

- [ ] **Step 1: Write the failing test (benchmark warms carry attribution)**

In `backend/src/benchmark/benchmark.service.spec.ts`, find the test that asserts the first `warmCache` call args (currently `expect(deps.anthropic.warmCache.mock.calls[0][1]).toEqual({ model: 'claude-fable-5', files: true, effort: 'high', outputSchema: SETUP_SCHEMA })`). Change that assertion to also require the attribution:

```typescript
    expect(deps.anthropic.warmCache.mock.calls[0][1]).toEqual({
      model: 'claude-fable-5',
      files: true,
      effort: 'high',
      outputSchema: SETUP_SCHEMA,
      attribution: { operation: 'warm', benchmark: expect.objectContaining({ modelAlias: 'fable', day: expect.any(String) }) },
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/benchmark/benchmark.service.spec.ts -t "submits one batch"`
Expected: FAIL — warmCache called without `attribution`.

- [ ] **Step 3: Add attribution to the two benchmark warm calls**

In `backend/src/benchmark/benchmark.service.ts`, the two `warmCache` calls (the day-bundle warm and the per-envelope warm) currently look like:

```typescript
        await this.anthropic.warmCache(this.envelopes.dayBundleContext(general.concatenated, bundle.dayBundle), {
          model: model.id,
          files: true,
          effort,
          outputSchema: SETUP_SCHEMA,
        });
        for (const envelope of enveloped.values()) {
          await this.anthropic.warmCache(envelope, { model: model.id, files: true, effort, outputSchema: SETUP_SCHEMA });
        }
```

Change them to pass attribution. The day-bundle warm is shared across traders, so it carries only the day; the per-envelope warm loop must know its trader/variant. Replace with:

```typescript
        await this.anthropic.warmCache(this.envelopes.dayBundleContext(general.concatenated, bundle.dayBundle), {
          model: model.id,
          files: true,
          effort,
          outputSchema: SETUP_SCHEMA,
          attribution: { operation: 'warm', benchmark: { modelAlias: model.alias, day: day.day } },
        });
        for (const { trader, variant } of dayCells) {
          const envelope = enveloped.get(`${trader.name}::${variant}`);
          if (!envelope) continue;
          await this.anthropic.warmCache(envelope, {
            model: model.id,
            files: true,
            effort,
            outputSchema: SETUP_SCHEMA,
            attribution: { operation: 'warm', benchmark: { modelAlias: model.alias, day: day.day, trader: trader.name, variant } },
          });
        }
```

This iterates `dayCells` (which carries `{ trader, variant }`) instead of the anonymous `enveloped.values()`, so each warm is attributed to its trader/variant. `enveloped` is the `Map<string, ...>` keyed `${trader.name}::${variant}` built just above; the key format is unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/benchmark/benchmark.service.spec.ts`
Expected: whole benchmark.service spec PASSES.

- [ ] **Step 5: Commit**

```bash
git add src/benchmark/benchmark.service.ts src/benchmark/benchmark.service.spec.ts
git commit -m "feat(cost): attribute benchmark warm calls (operation=warm, day/trader/variant)"
```

- [ ] **Step 6: Attribute seven-keys generation calls**

In `backend/src/benchmark/seven-keys/seven-keys.service.ts`, the `generate(day)` method makes **four** `this.anthropic.messageStructured(...)` calls — current-day, lookback, synthesize, verify — each hard-pinned to Fable (`CURRENT_DAY_MODEL` / `SEVEN_KEYS_MODEL` are both `'claude-fable-5'`). To the 2nd argument (the `opts` object) of **all four** calls, add this exact line (the model is hard-pinned to Fable, and `day.day` is the MMDDYYYY key in scope):

```typescript
        attribution: { operation: 'keys-generation', benchmark: { modelAlias: 'fable', day: day.day } },
```

For example, the current-day call becomes:

```typescript
      this.anthropic.messageStructured<Record<string, unknown>>(
        { prompt: currentDayPrompt({ date: day.date, generalDocs: general.concatenated, methodsDoc, tpTranscript, recapTranscript }) },
        { model: CURRENT_DAY_MODEL, outputSchema: CURRENT_SCHEMA, files: true, effort: this.effort, context: this.pdfContext(fileId),
          attribution: { operation: 'keys-generation', benchmark: { modelAlias: 'fable', day: day.day } } },
      );
```

Apply the same `attribution:` addition to the lookback, synthesize, and verify calls. No test change is required — the seven-keys spec mocks `messageStructured` and does not assert its `opts`; the attribution flows through to the emitter at runtime.

- [ ] **Step 7: Attribute the demo endpoints**

In `backend/src/demo/anthropic-demo.controller.ts`, find the handler(s) that call `this.anthropic.message(...)` (the `POST /ai/message` route). Add `attribution: { operation: 'demo' }` to the `MessageInput` passed in. For example, change `this.anthropic.message({ prompt })` to `this.anthropic.message({ prompt, attribution: { operation: 'demo' } })`.

- [ ] **Step 8: Build to verify**

Run: `pnpm build`
Expected: builds with no TypeScript errors.

- [ ] **Step 9: Commit**

```bash
git add src/benchmark/seven-keys/seven-keys.service.ts src/demo/anthropic-demo.controller.ts
git commit -m "feat(cost): attribute seven-keys generation and demo endpoint calls"
```

---

### Task 11: End-to-end test over the fake Firestore

**Files:**
- Create: `backend/test/cost.e2e-spec.ts`

- [ ] **Step 1: Write the e2e test**

First open a sibling e2e spec (e.g. `backend/test/benchmark.e2e-spec.ts`) and match its **supertest import style** (`import request from 'supertest'` vs `import * as request from 'supertest'`) — use whichever it uses. The module below declares `CostController` + providers directly and supplies the fake for the `FIRESTORE` token, rather than importing `CostModule` (whose `CostRepository` needs `FIRESTORE`, normally supplied by the `@Global` `FirebaseModule` — absent here). Create `backend/test/cost.e2e-spec.ts`:

```typescript
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import request from 'supertest';
import { FIRESTORE } from '../src/firebase/firebase.constants';
import { CostController } from '../src/cost/cost.controller';
import { CostService } from '../src/cost/cost.service';
import { CostRepository } from '../src/cost/cost.repository';
import { ReportBuilder } from '../src/cost/report-builder.provider';
import { fakeFirestore } from './fake-firestore';
import { UsageEvent } from '../src/cost/cost.types';

describe('Cost (e2e)', () => {
  let app: INestApplication;
  let emitter: EventEmitter2;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      controllers: [CostController],
      providers: [
        CostService,
        CostRepository,
        ReportBuilder,
        { provide: FIRESTORE, useValue: fakeFirestore() },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    emitter = app.get(EventEmitter2);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('captures emitted usage and serves aggregation + report', async () => {
    const ev = (over: Partial<UsageEvent>): UsageEvent => ({
      id: 'x',
      timestamp: '2026-07-27T13:00:00.000Z',
      modelId: 'claude-fable-5',
      serviceTier: 'standard',
      attribution: { operation: 'warm', benchmark: { modelAlias: 'fable', day: '07222026' } },
      tokens: { input: 1_000_000, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0, output: 0 },
      source: 'sync',
      ...over,
    });

    // emitAsync awaits the @OnEvent listener so the write completes before we query.
    await emitter.emitAsync('anthropic.usage', ev({ id: 'warm-1' }));
    await emitter.emitAsync('anthropic.usage', ev({ id: 'setup-1', serviceTier: 'batch', attribution: { operation: 'setup', benchmark: { modelAlias: 'fable', day: '07222026' } } }));

    const summary = await request(app.getHttpServer()).get('/costs/summary?groupBy=operation').expect(200);
    expect(summary.body.totalRecords).toBe(2);
    const ops = summary.body.groups.map((g: any) => g.key).sort();
    expect(ops).toEqual(['setup', 'warm']);
    expect(summary.body.totalUsd).toBeGreaterThan(0);

    const records = await request(app.getHttpServer()).get('/costs/records').expect(200);
    expect(records.body.total).toBe(2);

    const report = await request(app.getHttpServer()).get('/costs/report').expect(200);
    expect(report.headers['content-type']).toMatch(/text\/html/);
    expect(report.text.startsWith('<!doctype html>')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the e2e test**

Run: `pnpm test:e2e -- cost.e2e-spec.ts`
Expected: PASS. If the bootstrap differs from the assumption (e.g. the fake needs a different override shape), align it with the existing `benchmark.e2e-spec.ts` bootstrap you read in Step 1.

- [ ] **Step 3: Commit**

```bash
git add test/cost.e2e-spec.ts
git commit -m "test(cost): e2e capture + summary/records/report over fake Firestore"
```

---

### Task 12: Full suite + manual smoke, then finalize

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit suite**

Run: `pnpm test`
Expected: all suites pass (existing + new cost specs).

- [ ] **Step 2: Run the full e2e suite**

Run: `pnpm test:e2e`
Expected: all e2e specs pass.

- [ ] **Step 3: Manual smoke (optional, requires ADC + API key)**

With the backend running (`node dist/main.js`), submit a tiny benchmark run as in the design's live-test flow, let the reconciler drain, then:

```bash
curl -s "localhost:3000/costs/summary?groupBy=operation" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(s))"
curl -s "localhost:3000/costs/report" -o costs.html && echo "wrote costs.html"
```

Expected: `summary` shows `warm` and `setup` operations with non-zero USD; `costs.html` opens locally and renders the dashboard.

- [ ] **Step 4: Final commit (if any doc updates)**

```bash
git add -A
git commit -m "chore(cost): finalize cost dashboard" || echo "nothing to finalize"
```

---

## Self-review notes (author)

- **Spec coverage:** local pricing table (Task 3), all-call capture (Tasks 8–10), four breakdown dimensions (Task 5 `summarize` + Task 6 report), one record per request with idempotent batch keys (Tasks 4–5), API endpoints (Task 7), self-contained HTML report (Task 6). Out-of-scope items (backfill, Cost-API reconcile, priority tier, auth) intentionally not implemented.
- **Type consistency:** `UsageEvent`, `Attribution`, `UsageTokens`, `CostRecord`, `ServiceTier`, `Operation` defined once in Task 2 and used verbatim in Tasks 3–11. `priceUsage(tokens, modelId, tier, timestamp)` signature is stable across Tasks 3, 5. `tokensFromUsage`/`serviceTierFromUsage` from Task 2 used in Tasks 8–9.
- **Cache-savings definition:** paid cacheRead = 0.1× full input rate, so savings = paid × 9 (used identically in `cost.service` and `report.builder`).
