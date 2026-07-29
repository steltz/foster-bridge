# Moonshot (Kimi K3) LLM Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second benchmark LLM provider — Moonshot / Kimi with `kimi-k3` as the Fable-equivalent flagship — that plugs into the existing neutral `LlmProvider` port with hybrid batch (native `/v1/batches` for batchable models, durable client-side emulation for the sync-only `kimi-k3`), implicit-prefix caching, and per-model batch/cache pricing.

**Architecture:** New `backend/src/moonshot/` mirrors `backend/src/anthropic/`: a `MoonshotLlmProvider implements LlmProvider` backed by the OpenAI-compatible `openai` SDK (baseURL → `https://api.moonshot.ai/v1`). Because `kimi-k3` cannot use Moonshot's Batch API, `submitBatch` routes batchable models to native `/v1/batches` and `kimi-k3` to a Firestore-durable emulated batch drained by a restart-recoverable worker. The neutral port, benchmark pipeline, reconciler, and cost model are unchanged except at their documented seams.

**Tech Stack:** NestJS 10, TypeScript 5.5, `openai` SDK (pinned `^4`), Firestore (`firebase-admin`), Jest + ts-jest. Reference spec: `docs/superpowers/specs/2026-07-28-moonshot-llm-provider-design.md`.

---

## Conventions for every task

- Run tests from `backend/`: `cd backend && npx jest <path>`.
- Specs are colocated `*.spec.ts`. Prefer plain class instantiation with hand-rolled fakes (as `llm.contract.spec.ts` and `fake-llm.provider.ts` do) over `@nestjs/testing` unless a task says otherwise.
- Commit after each task with a semantic message. **Do not** add any Claude/Claude Code attribution to commits.
- Work stays on the existing branch `feat/moonshot-llm-provider`.

---

## Task 1: Dependency + Moonshot config

**Files:**
- Modify: `backend/package.json` (add `openai`)
- Modify: `backend/src/config/configuration.ts:9-25` (interface) and `:27-67` (factory)
- Modify: `backend/.env.example`
- Test: `backend/src/config/configuration.spec.ts` (create if absent)

- [ ] **Step 1: Install the OpenAI SDK (pinned to v4 for stable `files.del`/`batches` method names)**

Run: `cd backend && npm install openai@^4`
Expected: `openai` added under `dependencies` in `package.json`; `package-lock.json` updated.

- [ ] **Step 2: Write the failing config test**

Create `backend/src/config/configuration.spec.ts`:

```ts
import configuration from './configuration';

describe('configuration – moonshot', () => {
  const ENV = process.env;
  beforeEach(() => { process.env = { ...ENV }; });
  afterEach(() => { process.env = ENV; });

  it('defaults the moonshot block', () => {
    delete process.env.MOONSHOT_API_KEY;
    const cfg = configuration();
    expect(cfg.moonshot.baseUrl).toBe('https://api.moonshot.ai/v1');
    expect(cfg.moonshot.model).toBe('kimi-k3');
    expect(cfg.moonshot.batchConcurrency).toBe(8);
    expect(cfg.moonshot.completionWindow).toBe('1d');
    expect(cfg.moonshot.apiKey).toBeUndefined();
  });

  it('defaults benchmark.model to kimi-k3 when LLM_PROVIDER=moonshot', () => {
    process.env.LLM_PROVIDER = 'moonshot';
    delete process.env.BENCHMARK_MODEL;
    expect(configuration().benchmark.model).toBe('kimi-k3');
  });

  it('keeps benchmark.model as claude-fable-5 for anthropic', () => {
    delete process.env.LLM_PROVIDER;
    delete process.env.BENCHMARK_MODEL;
    expect(configuration().benchmark.model).toBe('claude-fable-5');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd backend && npx jest src/config/configuration.spec.ts`
Expected: FAIL — `cfg.moonshot` is undefined.

- [ ] **Step 4: Add the moonshot config**

In `backend/src/config/configuration.ts`, add to the `AppConfig` interface (after the `anthropic` block, before `llm`):

```ts
  moonshot: {
    apiKey?: string;
    baseUrl: string;
    model: string;
    batchConcurrency: number;
    completionWindow: string;
    batchMaxAgeMs: number;
    batchGcTtlMs: number;
  };
```

In the factory, change the `benchmark.model` line and add the `moonshot` block. Replace the `benchmark:` object's `model` field and insert `moonshot` after the `anthropic` block:

```ts
  moonshot: {
    apiKey: process.env.MOONSHOT_API_KEY,
    baseUrl: process.env.MOONSHOT_BASE_URL ?? 'https://api.moonshot.ai/v1',
    model: process.env.MOONSHOT_MODEL ?? 'kimi-k3',
    batchConcurrency: parseInt(process.env.MOONSHOT_BATCH_CONCURRENCY ?? '8', 10),
    completionWindow: process.env.MOONSHOT_COMPLETION_WINDOW ?? '1d',
    // D6: emulated-batch expiry (3h) and D5/D6 GC TTL from endedAt (24h).
    batchMaxAgeMs: parseInt(process.env.MOONSHOT_BATCH_MAX_AGE_MS ?? '10800000', 10),
    batchGcTtlMs: parseInt(process.env.MOONSHOT_BATCH_GC_TTL_MS ?? '86400000', 10),
  },
```

And make `benchmark.model` provider-aware — replace line 48:

```ts
    // Flagship benchmark model is provider-aware: Fable on Anthropic, Kimi K3 on
    // Moonshot. An explicit BENCHMARK_MODEL always wins.
    model:
      process.env.BENCHMARK_MODEL ??
      ((process.env.LLM_PROVIDER ?? 'anthropic') === 'moonshot' ? 'kimi-k3' : 'claude-fable-5'),
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && npx jest src/config/configuration.spec.ts`
Expected: PASS.

- [ ] **Step 6: Document env vars**

Append to `backend/.env.example`:

```bash
# Moonshot / Kimi provider (set LLM_PROVIDER=moonshot to activate)
MOONSHOT_API_KEY=
MOONSHOT_BASE_URL=https://api.moonshot.ai/v1
MOONSHOT_MODEL=kimi-k3
MOONSHOT_BATCH_CONCURRENCY=8
MOONSHOT_COMPLETION_WINDOW=1d
MOONSHOT_BATCH_MAX_AGE_MS=10800000
MOONSHOT_BATCH_GC_TTL_MS=86400000
```

- [ ] **Step 7: Commit**

```bash
git add backend/package.json backend/package-lock.json backend/src/config/configuration.ts backend/src/config/configuration.spec.ts backend/.env.example
git commit -m "feat(moonshot): add openai dep and provider-aware moonshot config"
```

---

## Task 2: Pricing — per-model batch & cache-read overrides + Moonshot rates

**Files:**
- Modify: `backend/src/cost/pricing.ts:3-10` (interface), `:42-77` (`priceUsage`), `:26-33` (`RATE_TABLE`)
- Test: `backend/src/cost/pricing.spec.ts` (create if absent — check first)

- [ ] **Step 1: Write the failing pricing test**

Create/extend `backend/src/cost/pricing.spec.ts`:

```ts
import { priceUsage } from './pricing';
import { UsageTokens } from './cost.types';

const T = (o: Partial<UsageTokens> = {}): UsageTokens => ({
  input: 0, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0, output: 0, ...o,
});
const TS = '2026-07-28T00:00:00.000Z';

describe('priceUsage – moonshot models', () => {
  it('prices kimi-k3 input miss at $3/MTok and output at $15/MTok', () => {
    const p = priceUsage(T({ input: 1_000_000, output: 1_000_000 }), 'kimi-k3', 'standard', TS)!;
    expect(p.cost.input).toBeCloseTo(3, 8);
    expect(p.cost.output).toBeCloseTo(15, 8);
  });

  it('prices kimi-k3 cache-read at $0.30/MTok (0.1x miss)', () => {
    const p = priceUsage(T({ cacheRead: 1_000_000 }), 'kimi-k3', 'standard', TS)!;
    expect(p.cost.cacheRead).toBeCloseTo(0.3, 8);
  });

  it('does NOT discount kimi-k3 on the batch tier (not batchable → batchMultiplier 1.0)', () => {
    const std = priceUsage(T({ input: 1_000_000 }), 'kimi-k3', 'standard', TS)!;
    const bat = priceUsage(T({ input: 1_000_000 }), 'kimi-k3', 'batch', TS)!;
    expect(bat.cost.input).toBeCloseTo(std.cost.input, 8);
  });

  it('discounts kimi-k2.6 batch to 60% of standard (40% off)', () => {
    const std = priceUsage(T({ input: 1_000_000 }), 'kimi-k2.6', 'standard', TS)!;
    const bat = priceUsage(T({ input: 1_000_000 }), 'kimi-k2.6', 'batch', TS)!;
    expect(bat.cost.input).toBeCloseTo(std.cost.input * 0.6, 8);
  });

  it('keeps the Anthropic batch tier at 0.5x (regression guard)', () => {
    const std = priceUsage(T({ input: 1_000_000 }), 'claude-fable-5', 'standard', TS)!;
    const bat = priceUsage(T({ input: 1_000_000 }), 'claude-fable-5', 'batch', TS)!;
    expect(bat.cost.input).toBeCloseTo(std.cost.input * 0.5, 8);
    expect(std.cost.input).toBeCloseTo(10, 8);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest src/cost/pricing.spec.ts`
Expected: FAIL — `kimi-k3` is unpriced (`priceUsage` returns `null`).

- [ ] **Step 3: Extend `RateEntry` and `priceUsage`, add Moonshot rates**

In `backend/src/cost/pricing.ts`, extend the interface (add two optional fields):

```ts
interface RateEntry {
  id: string; // model id, matching the id recorded by resolveModel
  inputPerMTok: number;
  outputPerMTok: number;
  effectiveFrom: string; // inclusive ISO date/datetime lower bound
  effectiveTo?: string; // exclusive upper bound; omitted = open-ended
  version: string;
  // Optional per-model overrides for providers whose economics differ from the
  // Anthropic-shaped globals. When absent, the module-level constants apply.
  batchMultiplier?: number; // replaces TIER_MULTIPLIER.batch for this model
  cacheReadMultiplier?: number; // replaces CACHE_READ for this model
}
```

Add three entries to `RATE_TABLE` (after the Anthropic rows). Cache-miss/output are the standard rates; batch is 60% (40% off); cache-read ratios are cache-hit ÷ cache-miss:

```ts
  // Moonshot / Kimi. kimi-k3 is NOT batchable → its emulated-batch spend must be
  // priced at standard (batchMultiplier 1.0). k3 cache-read $0.30 = 0.1x miss, so
  // it matches the global CACHE_READ (no override). The batchable code models are
  // 40% off on batch, with their own cache-hit/miss ratios.
  { id: 'kimi-k3', inputPerMTok: 3.0, outputPerMTok: 15.0, effectiveFrom: '2000-01-01', version: 'kimi-k3-2026-07', batchMultiplier: 1.0 },
  { id: 'kimi-k2.6', inputPerMTok: 0.95, outputPerMTok: 4.0, effectiveFrom: '2000-01-01', version: 'kimi-k2.6-2026-07', batchMultiplier: 0.6, cacheReadMultiplier: 0.16 / 0.95 },
  { id: 'kimi-k2.7-code', inputPerMTok: 0.95, outputPerMTok: 4.0, effectiveFrom: '2000-01-01', version: 'kimi-k2.7-code-2026-07', batchMultiplier: 0.6, cacheReadMultiplier: 0.19 / 0.95 },
```

In `priceUsage`, replace the `mult` line (currently `const mult = TIER_MULTIPLIER[tier];`) and the `cacheRead` line:

```ts
  const mult = tier === 'batch' ? (entry.batchMultiplier ?? TIER_MULTIPLIER.batch) : TIER_MULTIPLIER[tier];
```

```ts
  const cacheRead = tokens.cacheRead * inRate * (entry.cacheReadMultiplier ?? CACHE_READ);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx jest src/cost/pricing.spec.ts`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Run the full cost suite (regression)**

Run: `cd backend && npx jest src/cost`
Expected: PASS — existing cost/summary specs unchanged.

- [ ] **Step 6: Commit**

```bash
git add backend/src/cost/pricing.ts backend/src/cost/pricing.spec.ts
git commit -m "feat(cost): per-model batch and cache-read overrides + kimi rates"
```

---

## Task 3: Provider-aware flagship model identity

**Files:**
- Modify: `backend/src/benchmark/benchmark.types.ts:113-118` (`MODEL_ALIASES`)
- Modify: `backend/src/benchmark/seven-keys/seven-keys.service.ts:16-17,104-158,229,257`
- Test: `backend/src/benchmark/benchmark.types.spec.ts` (create if absent)

- [ ] **Step 1: Write the failing alias test**

Create/extend `backend/src/benchmark/benchmark.types.spec.ts`:

```ts
import { resolveModel, MODEL_ALIASES } from './benchmark.types';

describe('resolveModel – kimi aliases', () => {
  it('resolves the kimi aliases to ids', () => {
    expect(MODEL_ALIASES.k3).toBe('kimi-k3');
    expect(resolveModel('k3')).toEqual({ alias: 'k3', id: 'kimi-k3' });
    expect(resolveModel('k26')).toEqual({ alias: 'k26', id: 'kimi-k2.6' });
    expect(resolveModel('k27-code')).toEqual({ alias: 'k27-code', id: 'kimi-k2.7-code' });
  });

  it('maps a raw kimi id back to its alias', () => {
    expect(resolveModel('kimi-k3')).toEqual({ alias: 'k3', id: 'kimi-k3' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest src/benchmark/benchmark.types.spec.ts`
Expected: FAIL — `MODEL_ALIASES.k3` is undefined.

- [ ] **Step 3: Add kimi aliases**

In `backend/src/benchmark/benchmark.types.ts`, extend `MODEL_ALIASES`:

```ts
export const MODEL_ALIASES: Record<string, string> = {
  fable: 'claude-fable-5',
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5-20251001',
  k3: 'kimi-k3',
  k26: 'kimi-k2.6',
  'k27-code': 'kimi-k2.7-code',
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx jest src/benchmark/benchmark.types.spec.ts`
Expected: PASS.

- [ ] **Step 5: Make seven-keys use the provider-aware flagship (not the Fable literal)**

The seven-keys service hard-pins `claude-fable-5`. The flagship is realized by the provider-aware `benchmark.model` config default (Task 1). Replace the two module constants with config-derived getters and wire the attribution alias.

In `backend/src/benchmark/seven-keys/seven-keys.service.ts`:

Delete lines 14-17 (the comment + both `const … = 'claude-fable-5';`) and add these getters inside the class (next to the existing `effort`/`maxTokens` getters, after line 49). Also import `resolveModel`:

Add to the imports at the top:

```ts
import { resolveModel } from '../benchmark.types';
```

Add getters:

```ts
  // Provider-aware flagship (Fable on Anthropic, Kimi K3 on Moonshot). All four
  // seven-keys agents run on it; a blind comparison found the flagship more
  // methodology-faithful than the mid-tier model for grading.
  private get flagshipModel(): string {
    return this.config.get<string>('benchmark.model') ?? 'claude-fable-5';
  }

  private get flagshipAlias(): string {
    return resolveModel(this.flagshipModel).alias;
  }
```

Replace every remaining reference:
- Lines 109 & 122 & 139 & 152 (`model: CURRENT_DAY_MODEL` / `model: SEVEN_KEYS_MODEL`) → `model: this.flagshipModel`.
- Every `benchmark: { modelAlias: 'fable', day: day.day }` (4 occurrences, lines 114/127/143/157) → `benchmark: { modelAlias: this.flagshipAlias, day: day.day }`.
- Line 229 (`generatedBy: CURRENT_DAY_MODEL`) → `generatedBy: this.flagshipModel`.
- Line 257 (`` `generatedBy: ${CURRENT_DAY_MODEL}` ``) → `` `generatedBy: ${this.flagshipModel}` ``.

- [ ] **Step 6: Update the seven-keys spec expectations**

Run: `cd backend && npx jest src/benchmark/seven-keys/seven-keys.service.spec.ts`
Expected: it may FAIL where it asserts `model: 'claude-fable-5'` or `modelAlias: 'fable'`. In `seven-keys.service.spec.ts`, set the config stub so `benchmark.model` resolves to `claude-fable-5` (the default when no `LLM_PROVIDER`), and where the spec asserts the request `model`, assert `'claude-fable-5'` (unchanged under the default). Only the source of the value changed, not the default value, so existing assertions should hold once the config stub returns `claude-fable-5` for `benchmark.model`. If the spec's config stub returns `undefined` for `benchmark.model`, the getter's `?? 'claude-fable-5'` fallback keeps it green — verify and adjust the stub only if needed.

Run again: `cd backend && npx jest src/benchmark/seven-keys/seven-keys.service.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/benchmark/benchmark.types.ts backend/src/benchmark/benchmark.types.spec.ts backend/src/benchmark/seven-keys/seven-keys.service.ts backend/src/benchmark/seven-keys/seven-keys.service.spec.ts
git commit -m "feat(benchmark): provider-aware flagship model for seven-keys + kimi aliases"
```

---

## Task 4: Moonshot constants + usage parser

**Files:**
- Create: `backend/src/moonshot/moonshot.constants.ts`
- Create: `backend/src/moonshot/moonshot.usage.ts`
- Test: `backend/src/moonshot/moonshot.usage.spec.ts`

- [ ] **Step 1: Write the failing usage test**

Create `backend/src/moonshot/moonshot.usage.spec.ts`:

```ts
import { tokensFromUsage } from './moonshot.usage';

describe('tokensFromUsage – moonshot', () => {
  it('splits prompt_tokens into uncached input and cache-read', () => {
    expect(tokensFromUsage({ prompt_tokens: 1000, cached_tokens: 300, completion_tokens: 50 })).toEqual({
      input: 700, cacheRead: 300, cacheCreate5m: 0, cacheCreate1h: 0, output: 50,
    });
  });

  it('defaults everything to 0 and never returns negative input', () => {
    expect(tokensFromUsage(undefined)).toEqual({
      input: 0, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0, output: 0,
    });
    expect(tokensFromUsage({ prompt_tokens: 10, cached_tokens: 40 }).input).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest src/moonshot/moonshot.usage.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the constants and usage parser**

Create `backend/src/moonshot/moonshot.constants.ts`:

```ts
import type OpenAI from 'openai';

export const MOONSHOT_CLIENT = Symbol('MOONSHOT_CLIENT');

/**
 * Lazily constructs and memoizes the OpenAI-compatible Moonshot client. `get()`
 * throws an UnauthorizedException when no API key is configured and never
 * constructs at module init — so the app boots without a key (mirrors Anthropic).
 */
export interface MoonshotClientFactory {
  get(): OpenAI;
}

/** Synthetic file-id prefix returned by uploadFile; resolves to extracted text. */
export const MOONSHOT_EXTRACT_ID_PREFIX = 'moonshot-extract:';

/**
 * Models that support Moonshot's native Batch API. kimi-k3 is DELIBERATELY absent
 * — the docs state it is not batchable, so it routes to durable emulation instead.
 */
export const BATCHABLE_MODELS: ReadonlySet<string> = new Set([
  'kimi-k2.6',
  'kimi-k2.7-code',
  'kimi-k2.5',
]);

export function isBatchable(model: string): boolean {
  return BATCHABLE_MODELS.has(model);
}
```

Create `backend/src/moonshot/moonshot.usage.ts`:

```ts
import { UsageTokens } from '../cost/cost.types';

// Pull token counts from a Moonshot (OpenAI-compatible) `usage` object. Moonshot
// returns `cached_tokens` at the TOP LEVEL (not nested under
// prompt_tokens_details like OpenAI). Uncached input = prompt_tokens - cached.
// Moonshot has no cache-write token concept, so both create tiers are always 0.
export function tokensFromUsage(usage: any): UsageTokens {
  const prompt = usage?.prompt_tokens ?? 0;
  const cached = usage?.cached_tokens ?? 0;
  return {
    input: Math.max(0, prompt - cached),
    cacheRead: cached,
    cacheCreate5m: 0,
    cacheCreate1h: 0,
    output: usage?.completion_tokens ?? 0,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx jest src/moonshot/moonshot.usage.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/moonshot/moonshot.constants.ts backend/src/moonshot/moonshot.usage.ts backend/src/moonshot/moonshot.usage.spec.ts
git commit -m "feat(moonshot): client token, batchable-model set, usage parser"
```

---

## Task 5: Extract store (durable content-hash → extracted text)

**Files:**
- Create: `backend/src/moonshot/moonshot.extract-store.ts`
- Test: `backend/src/moonshot/moonshot.extract-store.spec.ts`

- [ ] **Step 1: Write the failing extract-store test**

Create `backend/src/moonshot/moonshot.extract-store.spec.ts`. It uses a tiny in-memory Firestore fake supporting the doc/collection surface the store needs:

```ts
import { MoonshotExtractStore, EXTRACT_CHUNK_SIZE } from './moonshot.extract-store';

// Minimal Firestore doc/collection fake (single collection + optional subcollection).
function fakeFirestore() {
  const docs = new Map<string, any>();
  const makeDoc = (path: string) => ({
    async get() { return { exists: docs.has(path), data: () => docs.get(path) }; },
    async set(v: any) { docs.set(path, v); },
    async delete() { docs.delete(path); },
    collection: (sub: string) => makeColl(`${path}/${sub}`),
  });
  const makeColl = (base: string) => ({
    doc: (id: string) => makeDoc(`${base}/${id}`),
    async get() {
      const prefix = `${base}/`;
      const rows = [...docs.entries()].filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'));
      return { docs: rows.map(([k, v]) => ({ id: k.slice(prefix.length), data: () => v })) };
    },
  });
  return { collection: (name: string) => makeColl(name) } as any;
}

describe('MoonshotExtractStore', () => {
  it('stores and resolves small text by hash and by id', async () => {
    const store = new MoonshotExtractStore(fakeFirestore());
    await store.put('abc', 'hello world', { filename: 'f.pdf', mediaType: 'application/pdf' });
    expect(await store.getByHash('abc')).toBe('hello world');
    expect(await store.getById('moonshot-extract:abc')).toBe('hello world');
    expect(await store.getByHash('missing')).toBeNull();
  });

  it('chunks and reassembles text larger than the chunk size (fresh instance → no LRU)', async () => {
    const db = fakeFirestore();
    const writer = new MoonshotExtractStore(db);
    const big = 'x'.repeat(EXTRACT_CHUNK_SIZE + 100) + 'END';
    await writer.put('big', big);
    // A second instance sharing the same DB has an empty LRU, forcing the
    // chunk-reassembly read path (the writer's LRU would otherwise short-circuit it).
    const reader = new MoonshotExtractStore(db);
    expect(await reader.getByHash('big')).toBe(big);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest src/moonshot/moonshot.extract-store.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the extract store**

Create `backend/src/moonshot/moonshot.extract-store.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { Firestore } from 'firebase-admin/firestore';
import { FIRESTORE } from '../firebase/firebase.constants';
import { MOONSHOT_EXTRACT_ID_PREFIX } from './moonshot.constants';

const EXTRACTS = 'moonshotExtracts';
// ~900 KB per chunk keeps each Firestore doc safely under the 1 MiB limit.
export const EXTRACT_CHUNK_SIZE = 900_000;
const LRU_MAX = 32;

interface ExtractDoc {
  filename?: string;
  mediaType?: string;
  chunked: boolean;
  chunks: number; // 1 when inline
  text?: string; // present only when !chunked
}

/**
 * Durable content-hash → extracted-text store. Cross-process because uploadFile
 * (day-artifacts) and envelope-build (warmer / run) can run in different
 * processes. An in-memory LRU fronts Firestore for hot re-reads within a process.
 */
@Injectable()
export class MoonshotExtractStore {
  private readonly lru = new Map<string, string>();

  constructor(@Inject(FIRESTORE) private readonly db: Firestore) {}

  private lruGet(hash: string): string | undefined {
    const v = this.lru.get(hash);
    if (v !== undefined) {
      this.lru.delete(hash);
      this.lru.set(hash, v); // refresh recency
    }
    return v;
  }

  private lruSet(hash: string, text: string): void {
    this.lru.set(hash, text);
    if (this.lru.size > LRU_MAX) this.lru.delete(this.lru.keys().next().value);
  }

  async put(hash: string, text: string, meta?: { filename?: string; mediaType?: string }): Promise<void> {
    const ref = this.db.collection(EXTRACTS).doc(hash);
    if (text.length <= EXTRACT_CHUNK_SIZE) {
      const doc: ExtractDoc = { chunked: false, chunks: 1, text, ...meta };
      await ref.set(doc as any);
    } else {
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += EXTRACT_CHUNK_SIZE) chunks.push(text.slice(i, i + EXTRACT_CHUNK_SIZE));
      const doc: ExtractDoc = { chunked: true, chunks: chunks.length, ...meta };
      await ref.set(doc as any);
      for (let i = 0; i < chunks.length; i++) {
        await ref.collection('chunks').doc(String(i)).set({ text: chunks[i] } as any);
      }
    }
    this.lruSet(hash, text);
  }

  async getByHash(hash: string): Promise<string | null> {
    const cached = this.lruGet(hash);
    if (cached !== undefined) return cached;
    const snap = await this.db.collection(EXTRACTS).doc(hash).get();
    if (!snap.exists) return null;
    const doc = snap.data() as ExtractDoc;
    let text: string;
    if (!doc.chunked) {
      text = doc.text ?? '';
    } else {
      const parts: string[] = [];
      for (let i = 0; i < doc.chunks; i++) {
        const c = await this.db.collection(EXTRACTS).doc(hash).collection('chunks').doc(String(i)).get();
        parts.push((c.data() as { text: string } | undefined)?.text ?? '');
      }
      text = parts.join('');
    }
    this.lruSet(hash, text);
    return text;
  }

  /** Resolves a synthetic `moonshot-extract:<hash>` id (or a bare hash) to text. */
  async getById(extractId: string): Promise<string | null> {
    const hash = extractId.startsWith(MOONSHOT_EXTRACT_ID_PREFIX)
      ? extractId.slice(MOONSHOT_EXTRACT_ID_PREFIX.length)
      : extractId;
    return this.getByHash(hash);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx jest src/moonshot/moonshot.extract-store.spec.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add backend/src/moonshot/moonshot.extract-store.ts backend/src/moonshot/moonshot.extract-store.spec.ts
git commit -m "feat(moonshot): durable content-hash extract store with chunking"
```

---

## Task 6: Chat helper + envelope builder (implicit-prefix caching)

**Files:**
- Create: `backend/src/moonshot/moonshot.chat.ts`
- Create: `backend/src/moonshot/moonshot.envelope.ts`
- Test: `backend/src/moonshot/moonshot.envelope.spec.ts`
- Test: `backend/src/moonshot/moonshot.chat.spec.ts`

- [ ] **Step 1: Write the failing envelope + chat-helper tests**

Create `backend/src/moonshot/moonshot.chat.spec.ts` (covers D8 schema shaping + fallback):

```ts
import { toMoonshotSchema, jsonSchemaFormat, createChatWithFallback } from './moonshot.chat';

describe('toMoonshotSchema (D8)', () => {
  it('marks every property required and makes optionals nullable', () => {
    const shaped = toMoonshotSchema({
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      additionalProperties: false,
    }) as any;
    expect(shaped.required.sort()).toEqual(['a', 'b']);
    expect(shaped.properties.a).toEqual({ type: 'string' });          // required: unchanged
    expect(shaped.properties.b).toEqual({ type: ['string', 'null'] }); // optional: nullable
  });
});

describe('jsonSchemaFormat', () => {
  it('wraps a shaped schema in strict json_schema', () => {
    const f = jsonSchemaFormat({ type: 'object', required: [], properties: { x: { type: 'number' } } }) as any;
    expect(f.type).toBe('json_schema');
    expect(f.json_schema.strict).toBe(true);
    expect(f.json_schema.schema.required).toEqual(['x']);
  });
});

describe('createChatWithFallback (D8)', () => {
  it('falls back to json_object + brace repair when strict json_schema is rejected', async () => {
    let call = 0;
    const client = { chat: { completions: { create: async (body: any) => {
      call++;
      if (call === 1) throw Object.assign(new Error('bad schema'), { status: 400, error: { type: 'invalid_request_error' } });
      expect(body.response_format).toEqual({ type: 'json_object' });
      expect(body.messages[body.messages.length - 1]).toEqual({ role: 'assistant', content: '{', partial: true });
      return { choices: [{ message: { content: '"a":1}' }, finish_reason: 'stop' }] };
    } } } };
    const resp = await createChatWithFallback(client as any, { model: 'kimi-k3', messages: [{ role: 'user', content: 'x' }], max_completion_tokens: 10, reasoning_effort: 'high', response_format: { type: 'json_schema' } as any });
    expect(resp.choices[0].message.content).toBe('{"a":1}');
    expect(call).toBe(2);
  });

  it('rethrows a non-schema error unchanged', async () => {
    const client = { chat: { completions: { create: async () => { throw Object.assign(new Error('boom'), { status: 500 }); } } } };
    await expect(createChatWithFallback(client as any, { model: 'k', messages: [], max_completion_tokens: 1, reasoning_effort: 'high', response_format: { type: 'json_schema' } as any })).rejects.toThrow('boom');
  });
});
```

Create `backend/src/moonshot/moonshot.envelope.spec.ts`:

```ts
import { MoonshotEnvelopeBuilder } from './moonshot.envelope';
import { PromptEnvelope } from '../llm/llm.types';

const fakeExtractStore = (map: Record<string, string>) => ({
  async getById(id: string) { return map[id] ?? null; },
}) as any;

describe('MoonshotEnvelopeBuilder.buildRequest', () => {
  it('renders tiers as leading system messages, file blocks as extracted text, prompt as final user', async () => {
    const b = new MoonshotEnvelopeBuilder(fakeExtractStore({ 'moonshot-extract:h1': 'PDF TEXT' }));
    const env: PromptEnvelope = {
      tiers: [
        { blocks: [{ type: 'text', text: 'GENERAL' }] },
        { blocks: [{ type: 'file', fileId: 'moonshot-extract:h1' }, { type: 'text', text: 'TRANSCRIPT' }] },
      ],
    };
    const { messages, promptCacheKey } = await b.buildRequest(env, 'DO IT');
    expect(messages).toEqual([
      { role: 'system', content: 'GENERAL' },
      { role: 'system', content: 'PDF TEXT\nTRANSCRIPT' },
      { role: 'user', content: 'DO IT' },
    ]);
    expect(promptCacheKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a stable cache key for the same prefix regardless of the trailing prompt', async () => {
    const b = new MoonshotEnvelopeBuilder(fakeExtractStore({}));
    const env: PromptEnvelope = { tiers: [{ blocks: [{ type: 'text', text: 'STABLE' }] }] };
    const a = await b.buildRequest(env, 'q1');
    const c = await b.buildRequest(env, 'q2');
    expect(a.promptCacheKey).toBe(c.promptCacheKey);
  });

  it('throws when a file block references an unknown extract id', async () => {
    const b = new MoonshotEnvelopeBuilder(fakeExtractStore({}));
    const env: PromptEnvelope = { tiers: [{ blocks: [{ type: 'file', fileId: 'moonshot-extract:missing' }] }] };
    await expect(b.buildRequest(env, 'x')).rejects.toThrow(/extract/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest src/moonshot/moonshot.envelope.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the chat helper and envelope builder**

Create `backend/src/moonshot/moonshot.chat.ts`:

```ts
import { UsageTokens } from '../cost/cost.types';
import { tokensFromUsage } from './moonshot.usage';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** A fully-rendered Moonshot chat request body (sampling params intentionally omitted). */
export interface MoonshotChatBody {
  model: string;
  messages: ChatMessage[];
  max_completion_tokens: number;
  reasoning_effort: string;
  prompt_cache_key?: string;
  response_format?: unknown;
}

export interface MoonshotChatResult {
  text: string;
  finishReason: string | null;
  usage: UsageTokens;
  rawUsage: any;
}

// Map benchmark/seven-keys effort strings onto Moonshot's low|high|max set.
export function mapEffort(effort?: string): string {
  switch (effort) {
    case 'low':
    case 'high':
    case 'max':
      return effort;
    default:
      return 'high';
  }
}

// D8: shape a JSON schema for Moonshot strict json_schema. OpenAI-strict semantics
// forbid optional properties (every `properties` key must be in `required`), unlike
// the Anthropic validator SETUP_SCHEMA was written for — so add all keys to
// `required` and make originally-optional ones nullable. The reconciler already
// tolerates a null/missing optional (e.g. rejectedAlternative), so nulling is safe.
export function toMoonshotSchema(schema: any): any {
  if (!schema || schema.type !== 'object' || !schema.properties) return schema;
  const props = schema.properties as Record<string, any>;
  const required = new Set<string>(schema.required ?? []);
  const shaped: Record<string, any> = {};
  for (const [key, def] of Object.entries(props)) {
    shaped[key] = required.has(key) ? def : nullable(def);
  }
  return { ...schema, properties: shaped, required: Object.keys(props), additionalProperties: false };
}

function nullable(def: any): any {
  if (def && Array.isArray(def.type)) return def.type.includes('null') ? def : { ...def, type: [...def.type, 'null'] };
  if (def && typeof def.type === 'string') return { ...def, type: [def.type, 'null'] };
  return { anyOf: [def, { type: 'null' }] }; // enum / $ref / anyOf, etc.
}

export function jsonSchemaFormat(schema: unknown): unknown {
  return { type: 'json_schema', json_schema: { name: 'setup', strict: true, schema: toMoonshotSchema(schema) } };
}

// True when an error looks like Moonshot rejecting the json_schema / response_format.
export function isSchemaRejection(err: any): boolean {
  if (err?.status !== 400) return false;
  const type = err?.error?.type ?? err?.code;
  const blob = `${err?.message ?? ''} ${JSON.stringify(err?.error ?? {})}`;
  return type === 'invalid_request_error' || /schema|response_format|json_schema/i.test(blob);
}

// D8 fallback: issue a chat call; if a strict json_schema body is rejected, retry
// once in json_object mode with a '{' partial prefill and repair the leading brace.
export async function createChatWithFallback(client: any, body: MoonshotChatBody): Promise<any> {
  try {
    return await client.chat.completions.create(body);
  } catch (err) {
    const isJsonSchema = (body.response_format as any)?.type === 'json_schema';
    if (!isJsonSchema || !isSchemaRejection(err)) throw err;
    const fallback = {
      ...body,
      response_format: { type: 'json_object' },
      messages: [...body.messages, { role: 'assistant', content: '{', partial: true }],
    };
    const resp = await client.chat.completions.create(fallback);
    const content = resp?.choices?.[0]?.message?.content ?? '';
    // Partial mode does not echo the '{' prefill; repair it. A json_object response
    // that ignored the prefill already leads with '{', so guard on it.
    if (resp?.choices?.[0]?.message && !content.trimStart().startsWith('{')) {
      resp.choices[0].message.content = '{' + content;
    }
    return resp;
  }
}

// Extract text/finish-reason/usage from an OpenAI-compatible chat response.
export function toChatResult(resp: any): MoonshotChatResult {
  const choice = resp?.choices?.[0];
  const rawUsage = resp?.usage;
  return {
    text: choice?.message?.content ?? '',
    finishReason: choice?.finish_reason ?? null,
    usage: tokensFromUsage(rawUsage),
    rawUsage,
  };
}
```

Create `backend/src/moonshot/moonshot.envelope.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PromptEnvelope } from '../llm/llm.types';
import { MoonshotExtractStore } from './moonshot.extract-store';
import { ChatMessage } from './moonshot.chat';

export interface BuiltRequest {
  messages: ChatMessage[];
  promptCacheKey: string;
}

/**
 * Renders a neutral PromptEnvelope into OpenAI-compatible messages for Moonshot.
 * Moonshot caches implicitly on a byte-identical prefix, so there are no cache
 * breakpoints: stable tiers become leading `system` messages (file blocks
 * resolved to their extracted text), and the variable per-request prompt is the
 * final `user` message. prompt_cache_key = sha256 of the stable prefix, so all
 * runs sharing a prefix route to the same cache.
 */
@Injectable()
export class MoonshotEnvelopeBuilder {
  constructor(private readonly extracts: MoonshotExtractStore) {}

  async buildRequest(envelope: PromptEnvelope | undefined, prompt: string, system?: string): Promise<BuiltRequest> {
    const messages: ChatMessage[] = [];
    if (envelope?.system) messages.push({ role: 'system', content: envelope.system });
    else if (system) messages.push({ role: 'system', content: system });

    for (const tier of envelope?.tiers ?? []) {
      const parts: string[] = [];
      for (const block of tier.blocks) {
        if (block.type === 'text') {
          parts.push(block.text);
        } else {
          const text = await this.extracts.getById(block.fileId);
          if (text == null) {
            throw new Error(`Moonshot: no extracted text for file id ${block.fileId}`);
          }
          parts.push(text);
        }
      }
      messages.push({ role: 'system', content: parts.join('\n') });
    }

    const prefix = messages.map((m) => `${m.role}\n${m.content}`).join('\n\x00\n');
    const promptCacheKey = createHash('sha256').update(prefix).digest('hex');
    messages.push({ role: 'user', content: prompt });
    return { messages, promptCacheKey };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx jest src/moonshot/moonshot.envelope.spec.ts src/moonshot/moonshot.chat.spec.ts`
Expected: PASS (envelope: 3 cases; chat: 4 cases).

- [ ] **Step 5: Commit**

```bash
git add backend/src/moonshot/moonshot.chat.ts backend/src/moonshot/moonshot.envelope.ts backend/src/moonshot/moonshot.envelope.spec.ts backend/src/moonshot/moonshot.chat.spec.ts
git commit -m "feat(moonshot): chat helper (schema shaping + fallback) + envelope builder"
```

---

## Task 7: Emulated-batch store (durable batch + item docs, claiming + expiry)

**Files:**
- Create: `backend/src/moonshot/moonshot.batch-store.ts`
- Test: `backend/src/moonshot/moonshot.batch-store.spec.ts`

- [ ] **Step 1: Write the failing batch-store test**

Create `backend/src/moonshot/moonshot.batch-store.spec.ts` (reuse a small Firestore fake with `where` support):

```ts
import { MoonshotBatchStore } from './moonshot.batch-store';

function fakeFirestore() {
  const docs = new Map<string, any>();
  const makeDoc = (path: string) => ({
    async get() { return { exists: docs.has(path), data: () => docs.get(path) }; },
    async set(v: any) { docs.set(path, v); },
    async update(v: any) { docs.set(path, { ...docs.get(path), ...v }); },
    async delete() { docs.delete(path); },
    collection: (sub: string) => makeColl(`${path}/${sub}`),
  });
  const makeColl = (base: string): any => ({
    doc: (id: string) => makeDoc(`${base}/${id}`),
    _filters: [] as [string, string][],
    where(field: string, _op: string, val: string) {
      const c = makeColl(base); c._filters = [...this._filters, [field, val]]; return c;
    },
    async get() {
      const prefix = `${base}/`;
      const rows = [...docs.entries()]
        .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
        .filter(([, v]) => this._filters.every(([f, val]) => (v as any)[f] === val));
      return { docs: rows.map(([k, v]) => ({ id: k.slice(prefix.length), data: () => v, ref: makeDoc(k) })) };
    },
  });
  // runTransaction: single-threaded in-memory — get is async, update/set apply
  // synchronously (the fake's async update has no internal await, so it commits
  // immediately), which is enough to exercise the claim's read-then-write.
  return {
    collection: (name: string) => makeColl(name),
    async runTransaction(fn: any) {
      const tx = {
        async get(ref: any) { return ref.get(); },
        update(ref: any, patch: any) { void ref.update(patch); },
        set(ref: any, val: any) { void ref.set(val); },
      };
      return fn(tx);
    },
  } as any;
}

const batch = (over: any = {}) => ({
  batchId: 'b1', model: 'kimi-k3', opts: { schema: {}, maxTokens: 100, effort: 'high' },
  status: 'in_progress', total: 2, createdAt: '2026-07-28T00:00:00.000Z', expiresAt: '2999-01-01T00:00:00.000Z', ...over,
});

describe('MoonshotBatchStore', () => {
  it('creates a batch with items, lists unfinished, updates, and completes', async () => {
    const store = new MoonshotBatchStore(fakeFirestore());
    await store.createBatch(batch(), [
      { customId: 'c1', prompt: 'p1', status: 'pending' },
      { customId: 'c2', prompt: 'p2', status: 'pending' },
    ]);
    expect((await store.listUnfinishedItems('b1')).map((i) => i.customId).sort()).toEqual(['c1', 'c2']);

    await store.updateItem('b1', 'c1', { status: 'succeeded', text: '{}' });
    expect((await store.listUnfinishedItems('b1')).map((i) => i.customId)).toEqual(['c2']);

    await store.setBatchStatus('b1', 'ended', '2026-07-28T00:05:00.000Z');
    expect((await store.getBatch('b1'))!.status).toBe('ended');
    expect((await store.listInProgressBatches()).length).toBe(0);
    expect((await store.listItems('b1')).find((i) => i.customId === 'c1')!.text).toBe('{}');
  });

  it('listUnfinishedItems returns pending and running only', async () => {
    const store = new MoonshotBatchStore(fakeFirestore());
    await store.createBatch(batch({ total: 3 }), [
      { customId: 'p', prompt: '', status: 'pending' },
      { customId: 'r', prompt: '', status: 'running' },
      { customId: 'd', prompt: '', status: 'succeeded' },
    ]);
    expect((await store.listUnfinishedItems('b1')).map((i) => i.customId).sort()).toEqual(['p', 'r']);
  });

  it('claims a pending item once, then refuses a second claim (D5)', async () => {
    const store = new MoonshotBatchStore(fakeFirestore());
    await store.createBatch(batch({ total: 1 }), [{ customId: 'c1', prompt: 'p', status: 'pending' }]);
    expect(await store.claimItem('b1', 'c1', 600_000)).toBe(true);
    expect(await store.claimItem('b1', 'c1', 600_000)).toBe(false); // now running with a fresh lease
    const item = (await store.listItems('b1'))[0];
    expect(item.status).toBe('running');
    expect(item.attempts).toBe(1);
  });

  it('reclaims a running item whose lease has expired (D5)', async () => {
    const store = new MoonshotBatchStore(fakeFirestore());
    await store.createBatch(batch({ total: 1 }), [
      { customId: 'c1', prompt: 'p', status: 'running', leaseUntil: '2000-01-01T00:00:00.000Z', attempts: 1 },
    ]);
    expect(await store.claimItem('b1', 'c1', 600_000)).toBe(true); // stale lease → reclaimable
    expect((await store.listItems('b1'))[0].attempts).toBe(2);
  });

  it('GC lists terminal batches by endedAt, not createdAt', async () => {
    const store = new MoonshotBatchStore(fakeFirestore());
    await store.createBatch(batch({ batchId: 'old', status: 'ended', endedAt: '2020-01-01T00:00:00.000Z' }), []);
    await store.createBatch(batch({ batchId: 'new', status: 'ended', endedAt: '2999-01-01T00:00:00.000Z' }), []);
    expect(await store.listTerminalBatchesOlderThan('2026-01-01T00:00:00.000Z')).toEqual(['old']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest src/moonshot/moonshot.batch-store.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the batch store**

Create `backend/src/moonshot/moonshot.batch-store.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { Firestore } from 'firebase-admin/firestore';
import { FIRESTORE } from '../firebase/firebase.constants';
import { PromptEnvelope, BatchSubmitOptions, UsageTokens } from '../llm/llm.types';

const BATCHES = 'moonshotBatches';

export type EmulatedBatchStatus = 'in_progress' | 'ended' | 'errored';
export type EmulatedItemStatus = 'pending' | 'running' | 'succeeded' | 'refusal' | 'errored';

export interface EmulatedBatchDoc {
  batchId: string;
  model: string;
  opts: BatchSubmitOptions; // schema / maxTokens / effort (model duplicated above)
  batchEnvelope?: PromptEnvelope; // batch-level fallback envelope
  status: EmulatedBatchStatus;
  total: number;
  createdAt: string;
  expiresAt: string; // D6: past this, a non-drained batch is marked errored
  endedAt?: string;
}

export interface EmulatedBatchItem {
  customId: string;
  prompt: string;
  envelope?: PromptEnvelope; // per-item; overrides batchEnvelope
  status: EmulatedItemStatus;
  attempts?: number; // D5: incremented on each claim
  leaseUntil?: string; // D5: ISO; a running item is reclaimable once this passes
  text?: string;
  error?: string;
  cacheReadTokens?: number;
  usage?: UsageTokens;
}

/** Firestore-durable store for client-side emulated batches (kimi-k3). */
@Injectable()
export class MoonshotBatchStore {
  constructor(@Inject(FIRESTORE) private readonly db: Firestore) {}

  private batchRef(id: string) { return this.db.collection(BATCHES).doc(id); }
  private itemRef(batchId: string, customId: string) { return this.batchRef(batchId).collection('items').doc(customId); }

  async createBatch(doc: EmulatedBatchDoc, items: EmulatedBatchItem[]): Promise<void> {
    await this.batchRef(doc.batchId).set(doc as any);
    for (const item of items) await this.itemRef(doc.batchId, item.customId).set(item as any);
  }

  async getBatch(batchId: string): Promise<EmulatedBatchDoc | null> {
    const snap = await this.batchRef(batchId).get();
    return snap.exists ? (snap.data() as EmulatedBatchDoc) : null;
  }

  async listItems(batchId: string): Promise<EmulatedBatchItem[]> {
    const snap = await this.batchRef(batchId).collection('items').get();
    return snap.docs.map((d) => d.data() as EmulatedBatchItem);
  }

  // Items not yet terminal (pending OR running) — the worker's work set.
  async listUnfinishedItems(batchId: string): Promise<EmulatedBatchItem[]> {
    const all = await this.listItems(batchId);
    return all.filter((i) => i.status === 'pending' || i.status === 'running');
  }

  // D5: transactional claim. Flip pending→running, or reclaim a running item whose
  // lease has expired. Returns true only to the winner, who then runs the call. This
  // is what makes concurrent kick()/bootstrap-resume across processes single-run.
  async claimItem(batchId: string, customId: string, leaseMs: number): Promise<boolean> {
    const ref = this.itemRef(batchId, customId);
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const leaseUntil = new Date(nowMs + leaseMs).toISOString();
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const item = snap.data() as EmulatedBatchItem;
      const claimable = item.status === 'pending' || (item.status === 'running' && (item.leaseUntil ?? '') < nowIso);
      if (!claimable) return false;
      tx.update(ref, { status: 'running', leaseUntil, attempts: (item.attempts ?? 0) + 1 } as any);
      return true;
    });
  }

  async updateItem(batchId: string, customId: string, patch: Partial<EmulatedBatchItem>): Promise<void> {
    await this.itemRef(batchId, customId).update(patch as any);
  }

  async setBatchStatus(batchId: string, status: EmulatedBatchStatus, endedAt?: string): Promise<void> {
    await this.batchRef(batchId).update({ status, ...(endedAt ? { endedAt } : {}) } as any);
  }

  async listInProgressBatches(): Promise<EmulatedBatchDoc[]> {
    const snap = await this.db.collection(BATCHES).where('status', '==', 'in_progress').get();
    return snap.docs.map((d) => d.data() as EmulatedBatchDoc);
  }

  // Terminal batches whose TERMINAL time (endedAt, or createdAt as a fallback) is
  // older than the cutoff. Keyed off endedAt so a lagging reconciler never has
  // results GC'd before it reads them. Filtered in memory to avoid a composite index.
  async listTerminalBatchesOlderThan(cutoffIso: string): Promise<string[]> {
    const out: string[] = [];
    for (const status of ['ended', 'errored'] as const) {
      const snap = await this.db.collection(BATCHES).where('status', '==', status).get();
      for (const d of snap.docs) {
        const doc = d.data() as EmulatedBatchDoc;
        if ((doc.endedAt ?? doc.createdAt) < cutoffIso) out.push(doc.batchId);
      }
    }
    return out;
  }

  async deleteBatch(batchId: string): Promise<void> {
    const items = await this.batchRef(batchId).collection('items').get();
    for (const d of items.docs) await d.ref.delete();
    await this.batchRef(batchId).delete();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx jest src/moonshot/moonshot.batch-store.spec.ts`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Commit**

```bash
git add backend/src/moonshot/moonshot.batch-store.ts backend/src/moonshot/moonshot.batch-store.spec.ts
git commit -m "feat(moonshot): durable emulated-batch store with item claiming + expiry"
```

---

## Task 8: Emulated-batch worker (claiming + grouped priming + expiry + recovery + GC)

**Files:**
- Create: `backend/src/moonshot/moonshot.batch-worker.ts`
- Test: `backend/src/moonshot/moonshot.batch-worker.spec.ts`

- [ ] **Step 1: Write the failing worker test**

Create `backend/src/moonshot/moonshot.batch-worker.spec.ts`:

```ts
import { MoonshotBatchWorker } from './moonshot.batch-worker';
import { MoonshotBatchStore } from './moonshot.batch-store';

// In-memory batch store double (only what the worker calls), including the D5
// claim — atomic in-memory: no `await` before the mutation, so two concurrent
// claims of the same item cannot both win.
class MemBatchStore {
  batches = new Map<string, any>();
  items = new Map<string, any[]>();
  async getBatch(id: string) { return this.batches.get(id) ?? null; }
  async listItems(id: string) { return this.items.get(id) ?? []; }
  async listUnfinishedItems(id: string) { return (this.items.get(id) ?? []).filter((i) => i.status === 'pending' || i.status === 'running'); }
  async claimItem(id: string, cid: string, leaseMs: number) {
    const it = (this.items.get(id) ?? []).find((i) => i.customId === cid);
    if (!it) return false;
    const nowIso = new Date().toISOString();
    const claimable = it.status === 'pending' || (it.status === 'running' && (it.leaseUntil ?? '') < nowIso);
    if (!claimable) return false;
    it.status = 'running';
    it.leaseUntil = new Date(Date.now() + leaseMs).toISOString();
    it.attempts = (it.attempts ?? 0) + 1;
    return true;
  }
  async updateItem(id: string, cid: string, patch: any) {
    Object.assign((this.items.get(id) ?? []).find((i) => i.customId === cid), patch);
  }
  async setBatchStatus(id: string, status: string, endedAt?: string) { Object.assign(this.batches.get(id), { status, endedAt }); }
  async listInProgressBatches() { return [...this.batches.values()].filter((b) => b.status === 'in_progress'); }
  async listTerminalBatchesOlderThan() { return []; }
  async deleteBatch() {}
}

const fakeEnvelopes = { async buildRequest() { return { messages: [{ role: 'user', content: 'x' }], promptCacheKey: 'k' }; } } as any;
const fakeConfig = { get: (k: string) => (k === 'moonshot.batchConcurrency' ? 2 : undefined) } as any;
const future = '2999-01-01T00:00:00.000Z';

function clientFactory(handler: (body: any) => any) {
  return { get: () => ({ chat: { completions: { create: async (body: any) => handler(body) } } }) } as any;
}
const okResp = (content: string) => ({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, cached_tokens: 4, completion_tokens: 2 } });

describe('MoonshotBatchWorker', () => {
  it('drains all unfinished items to succeeded and ends the batch', async () => {
    const store = new MemBatchStore();
    store.batches.set('b1', { batchId: 'b1', model: 'kimi-k3', opts: { effort: 'high', maxTokens: 100 }, status: 'in_progress', total: 2, expiresAt: future });
    store.items.set('b1', [
      { customId: 'c1', prompt: 'p1', status: 'pending' },
      { customId: 'c2', prompt: 'p2', status: 'pending' },
    ]);
    const worker = new MoonshotBatchWorker(clientFactory(() => okResp('{"ok":1}')), fakeEnvelopes, store as unknown as MoonshotBatchStore, fakeConfig);
    await worker.drainBatch('b1');
    const items = await store.listItems('b1');
    expect(items.every((i) => i.status === 'succeeded' && i.text === '{"ok":1}')).toBe(true);
    expect(items[0].usage).toEqual({ input: 6, cacheRead: 4, cacheCreate5m: 0, cacheCreate1h: 0, output: 2 });
    expect(store.batches.get('b1').status).toBe('ended');
  });

  it('classifies content_filter as refusal (kept) and persistent 5xx as errored (re-queued)', async () => {
    const store = new MemBatchStore();
    store.batches.set('b1', { batchId: 'b1', model: 'kimi-k3', opts: { effort: 'high', maxTokens: 100 }, status: 'in_progress', total: 2, expiresAt: future });
    store.items.set('b1', [
      { customId: 'refuse', prompt: 'REFUSE', status: 'pending' },
      { customId: 'boom', prompt: 'BOOM', status: 'pending' },
    ]);
    const client = clientFactory((body: any) => {
      if (JSON.stringify(body.messages).includes('REFUSE')) throw Object.assign(new Error('filtered'), { status: 400, error: { type: 'content_filter' } });
      throw Object.assign(new Error('server'), { status: 500 });
    });
    const echoEnvelopes = { async buildRequest(_e: any, prompt: string) { return { messages: [{ role: 'user', content: prompt }], promptCacheKey: 'k' }; } } as any;
    const worker = new MoonshotBatchWorker(client, echoEnvelopes, store as unknown as MoonshotBatchStore, fakeConfig);
    (worker as any).sleep = async () => {}; // skip backoff so the retry loop is instant
    await worker.drainBatch('b1');
    const items = await store.listItems('b1');
    expect(items.find((i) => i.customId === 'refuse')!.status).toBe('refusal');
    expect(items.find((i) => i.customId === 'boom')!.status).toBe('errored');
    expect(store.batches.get('b1').status).toBe('ended');
  });

  it('marks a batch past expiresAt as errored, leaving items untouched (D6)', async () => {
    const store = new MemBatchStore();
    store.batches.set('b1', { batchId: 'b1', model: 'kimi-k3', opts: {}, status: 'in_progress', total: 1, expiresAt: '2000-01-01T00:00:00.000Z' });
    store.items.set('b1', [{ customId: 'c1', prompt: 'p', status: 'pending' }]);
    let called = 0;
    const worker = new MoonshotBatchWorker(clientFactory(() => { called++; return okResp('{}'); }), fakeEnvelopes, store as unknown as MoonshotBatchStore, fakeConfig);
    await worker.drainBatch('b1');
    expect(called).toBe(0);
    expect(store.batches.get('b1').status).toBe('errored');
    expect((await store.listItems('b1'))[0].status).toBe('pending'); // untouched → reconciler re-queues
  });

  it('two workers sharing a store run each item exactly once (D5 claim gate)', async () => {
    const store = new MemBatchStore();
    store.batches.set('b1', { batchId: 'b1', model: 'kimi-k3', opts: {}, status: 'in_progress', total: 2, expiresAt: future });
    store.items.set('b1', [
      { customId: 'c1', prompt: 'p1', status: 'pending' },
      { customId: 'c2', prompt: 'p2', status: 'pending' },
    ]);
    let calls = 0;
    const mk = () => new MoonshotBatchWorker(clientFactory(() => { calls++; return okResp('{}'); }), fakeEnvelopes, store as unknown as MoonshotBatchStore, fakeConfig);
    await Promise.all([mk().drainBatch('b1'), mk().drainBatch('b1')]);
    expect(calls).toBe(2); // each item claimed + run exactly once across the two workers
    expect((await store.listItems('b1')).every((i) => i.status === 'succeeded')).toBe(true);
  });
});
```

> Note: `runOne` is public so its retry/classification is exercised directly; `sleep` is a private method the tests override to remove backoff latency; the two-worker test relies on `claimItem` being atomic (no `await` before the status flip) — the real store gets this from a Firestore transaction, the fake from single-threaded synchronicity.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest src/moonshot/moonshot.batch-worker.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the worker**

Create `backend/src/moonshot/moonshot.batch-worker.ts`:

```ts
import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHash } from 'node:crypto';
import { MOONSHOT_CLIENT, MoonshotClientFactory } from './moonshot.constants';
import { MoonshotEnvelopeBuilder } from './moonshot.envelope';
import { MoonshotBatchStore, EmulatedBatchItem, EmulatedBatchDoc } from './moonshot.batch-store';
import { MoonshotChatBody, toChatResult, mapEffort, jsonSchemaFormat, createChatWithFallback } from './moonshot.chat';
import { UsageTokens } from '../cost/cost.types';

const MAX_ATTEMPTS = 4;
const LEASE_MS = 10 * 60 * 1000; // D5: item-claim lease
const GC_TTL_DEFAULT_MS = 24 * 60 * 60 * 1000;

interface RunOutcome {
  status: 'succeeded' | 'refusal' | 'errored';
  text?: string;
  error?: string;
  usage?: UsageTokens;
  cacheReadTokens?: number;
}

/**
 * Drains kimi-k3 emulated batches. Each item is a synchronous chat call, claimed
 * transactionally (D5) so concurrent kick()/bootstrap-resume across processes never
 * double-run an item; results persist durably so getBatch/getBatchResults work from
 * any process. Items are primed one-per-prefix-group before fanning out (D7). A
 * batch past its deadline is force-terminated (D6). content_filter → refusal
 * (permanent); 429/5xx/network → retry then errored (transient → reconciler re-queues).
 */
@Injectable()
export class MoonshotBatchWorker implements OnApplicationBootstrap {
  private readonly logger = new Logger(MoonshotBatchWorker.name);
  private readonly active = new Set<string>(); // batchIds draining in THIS process

  constructor(
    @Inject(MOONSHOT_CLIENT) private readonly clientFactory: MoonshotClientFactory,
    private readonly envelopes: MoonshotEnvelopeBuilder,
    private readonly store: MoonshotBatchStore,
    private readonly config: ConfigService,
  ) {}

  private get concurrency(): number {
    return this.config.get<number>('moonshot.batchConcurrency') ?? 8;
  }

  // Fire-and-forget kick from submitBatch. Never throws to the caller.
  kick(batchId: string): void {
    void this.drainBatch(batchId).catch((e) => this.logger.error(`drain ${batchId} failed: ${e}`));
  }

  onApplicationBootstrap(): void {
    // MoonshotModule is always imported, but only resume/query Firestore when
    // Moonshot is the active provider — under Anthropic there is nothing to drain.
    if ((this.config.get<string>('llm.provider') ?? 'anthropic') !== 'moonshot') return;
    void this.resumeAll().catch((e) => this.logger.error(`resume failed: ${e}`));
  }

  async resumeAll(): Promise<void> {
    const batches = await this.store.listInProgressBatches();
    for (const b of batches) this.kick(b.batchId);
  }

  // Drain one emulated batch: expire if past deadline (D6), else claim+run each
  // unfinished item, priming one call per prefix group (D7) before fanning out.
  async drainBatch(batchId: string): Promise<void> {
    if (this.active.has(batchId)) return;
    this.active.add(batchId);
    try {
      const batch = await this.store.getBatch(batchId);
      if (!batch || batch.status !== 'in_progress') return;
      const unfinished = await this.store.listUnfinishedItems(batchId);
      if (new Date().toISOString() > batch.expiresAt) {
        if (unfinished.length) await this.store.setBatchStatus(batchId, 'errored', new Date().toISOString());
        return;
      }
      const groups = this.groupByPrefix(unfinished, batch);
      // Phase 1: prime one item per group (warms each distinct cell prefix).
      await this.runPool(groups.map((g) => g[0]), (item) => this.claimAndRun(batchId, item, batch));
      // Phase 2: fan out the remaining items of every group (siblings hit cache).
      await this.runPool(groups.flatMap((g) => g.slice(1)), (item) => this.claimAndRun(batchId, item, batch));
      const remaining = await this.store.listUnfinishedItems(batchId);
      if (!remaining.length) await this.store.setBatchStatus(batchId, 'ended', new Date().toISOString());
      else if (new Date().toISOString() > batch.expiresAt) await this.store.setBatchStatus(batchId, 'errored', new Date().toISOString());
    } finally {
      this.active.delete(batchId);
    }
  }

  // D7: group by envelope hash (1:1 with prompt_cache_key) so each distinct cell
  // prefix is primed exactly once before its sibling runIndexes fan out.
  private groupByPrefix(items: EmulatedBatchItem[], batch: EmulatedBatchDoc): EmulatedBatchItem[][] {
    const groups = new Map<string, EmulatedBatchItem[]>();
    for (const item of items) {
      const key = createHash('sha256').update(JSON.stringify(item.envelope ?? batch.batchEnvelope ?? null)).digest('hex');
      const g = groups.get(key);
      if (g) g.push(item); else groups.set(key, [item]);
    }
    return [...groups.values()];
  }

  // Claim (D5) then run one item. A lost claim (another process/tick owns it) is a no-op.
  private async claimAndRun(batchId: string, item: EmulatedBatchItem, batch: EmulatedBatchDoc): Promise<void> {
    const claimed = await this.store.claimItem(batchId, item.customId, LEASE_MS);
    if (!claimed) return;
    const outcome = await this.runOne(item, batch);
    await this.store.updateItem(batchId, item.customId, {
      status: outcome.status,
      ...(outcome.text !== undefined ? { text: outcome.text } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
      ...(outcome.cacheReadTokens !== undefined ? { cacheReadTokens: outcome.cacheReadTokens } : {}),
    });
  }

  // One item = one sync chat call (with the strict→json_object fallback).
  async runOne(item: EmulatedBatchItem, batch: EmulatedBatchDoc): Promise<RunOutcome> {
    const built = await this.envelopes.buildRequest(item.envelope ?? batch.batchEnvelope, item.prompt);
    const body: MoonshotChatBody = {
      model: batch.model,
      messages: built.messages,
      max_completion_tokens: batch.opts.maxTokens ?? 32000,
      reasoning_effort: mapEffort(batch.opts.effort),
      prompt_cache_key: built.promptCacheKey,
      ...(batch.opts.schema ? { response_format: jsonSchemaFormat(batch.opts.schema) as any } : {}),
    };
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const resp = await createChatWithFallback(this.clientFactory.get(), body);
        const r = toChatResult(resp);
        return { status: 'succeeded', text: r.text, usage: r.usage, cacheReadTokens: r.usage.cacheRead };
      } catch (err) {
        const status = (err as { status?: number }).status;
        const type = (err as any)?.error?.type ?? (err as any)?.code;
        if (status === 400 && type === 'content_filter') return { status: 'refusal' }; // permanent — recorded, not retried
        lastErr = err;
        if (attempt === MAX_ATTEMPTS || !this.isTransient(status)) break;
        await this.sleep(250 * 2 ** (attempt - 1));
      }
    }
    return { status: 'errored', error: (lastErr as Error)?.message ?? 'unknown error' };
  }

  private isTransient(status?: number): boolean {
    return status === undefined || status === 429 || (status >= 500 && status < 600);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  // Bounded-concurrency pool. Phase ordering (prime vs fan-out) is decided by the
  // caller (drainBatch); this just runs `items` at most `concurrency` at a time.
  private async runPool<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
    if (!items.length) return;
    let cursor = 0;
    const limit = Math.max(1, this.concurrency);
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) await fn(items[cursor++]);
    });
    await Promise.all(runners);
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async gc(): Promise<void> {
    if ((this.config.get<string>('llm.provider') ?? 'anthropic') !== 'moonshot') return;
    const ttl = this.config.get<number>('moonshot.batchGcTtlMs') ?? GC_TTL_DEFAULT_MS;
    const cutoff = new Date(Date.now() - ttl).toISOString();
    const stale = await this.store.listTerminalBatchesOlderThan(cutoff);
    for (const id of stale) await this.store.deleteBatch(id);
    if (stale.length) this.logger.log(`GC removed ${stale.length} terminal emulated batches`);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx jest src/moonshot/moonshot.batch-worker.spec.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Commit**

```bash
git add backend/src/moonshot/moonshot.batch-worker.ts backend/src/moonshot/moonshot.batch-worker.spec.ts
git commit -m "feat(moonshot): emulated-batch worker with claiming, grouped priming, expiry, gc"
```

---

## Task 9: Provider — messageStructured + uploadFile

**Files:**
- Create: `backend/src/moonshot/moonshot.service.ts`
- Test: `backend/src/moonshot/moonshot.service.spec.ts`

- [ ] **Step 1: Write the failing service test (sync path + upload)**

Create `backend/src/moonshot/moonshot.service.spec.ts`:

```ts
import { MoonshotLlmProvider } from './moonshot.service';
import { MoonshotEnvelopeBuilder } from './moonshot.envelope';

const fakeExtracts = () => {
  const map = new Map<string, string>();
  return {
    store: map,
    async put(hash: string, text: string) { map.set(hash, text); },
    async getById(id: string) { return map.get(id.replace('moonshot-extract:', '')) ?? null; },
    async getByHash(h: string) { return map.get(h) ?? null; },
  } as any;
};

function make(chatHandler: (body: any) => any, fileHandlers: any = {}) {
  const extracts = fakeExtracts();
  const envelopes = new MoonshotEnvelopeBuilder(extracts);
  const events: any = { emitted: [] as any[], emit(name: string, p: any) { this.emitted.push({ name, p }); return true; } };
  const client = {
    chat: { completions: { create: async (b: any) => chatHandler(b) } },
    files: {
      create: async (a: any) => ({ id: fileHandlers.id ?? 'ms-file-1' }),
      content: async (_id: string) => ({ text: async () => fileHandlers.text ?? 'EXTRACTED' }),
      del: async (_id: string) => ({}),
    },
  };
  const clientFactory = { get: () => client } as any;
  const config = { get: (k: string) => (k === 'moonshot.model' ? 'kimi-k3' : k === 'moonshot.completionWindow' ? '1d' : undefined) } as any;
  const batchStore: any = {};
  const worker: any = { kick() {} };
  const svc = new MoonshotLlmProvider(clientFactory, config, events, envelopes, extracts, batchStore, worker);
  return { svc, events, extracts };
}

describe('MoonshotLlmProvider – sync + upload', () => {
  it('messageStructured builds json_schema, parses content, emits sync usage', async () => {
    const { svc, events } = make((body) => {
      expect(body.model).toBe('kimi-k3');
      expect(body.response_format.type).toBe('json_schema');
      expect(body.temperature).toBeUndefined();
      return { choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, cached_tokens: 3, completion_tokens: 2 } };
    });
    const out = await svc.messageStructured({ prompt: 'go', schema: { type: 'object' }, effort: 'high', maxTokens: 100 }, { operation: 'keys-generation' });
    expect(out).toEqual({ a: 1 });
    expect(events.emitted[0].name).toBe('llm.usage');
    expect(events.emitted[0].p.serviceTier).toBe('standard');
    expect(events.emitted[0].p.tokens).toEqual({ input: 5, cacheRead: 3, cacheCreate5m: 0, cacheCreate1h: 0, output: 2 });
  });

  it('uploadFile extracts, caches by hash, deletes remote, returns synthetic id', async () => {
    const { svc, extracts } = make(() => ({}), { text: 'PDF CONTENT' });
    const id = await svc.uploadFile(Buffer.from('bytes'), 'f.pdf', 'application/pdf');
    expect(id.startsWith('moonshot-extract:')).toBe(true);
    expect(await extracts.getById(id)).toBe('PDF CONTENT');
  });

  it('throws 422 on content_filter refusal', async () => {
    const { svc } = make(() => { throw Object.assign(new Error('filtered'), { status: 400, error: { type: 'content_filter' } }); });
    let status = 0;
    try {
      await svc.messageStructured({ prompt: 'go' }, { operation: 'demo' });
    } catch (e: any) {
      status = e.getStatus?.() ?? e.status;
    }
    expect(status).toBe(422);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest src/moonshot/moonshot.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service (capabilities, constructor, messageStructured, uploadFile) + a rethrow/emit helper**

Create `backend/src/moonshot/moonshot.service.ts`:

```ts
import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID, createHash } from 'node:crypto';
import OpenAI, { toFile } from 'openai';
import { Attribution } from '../cost/cost.types';
import { LlmProvider, LlmCapabilities } from '../llm/llm.provider';
import {
  StructuredRequest,
  BatchItemRequest,
  BatchSubmitOptions,
  BatchHandle,
  BatchItemResult,
  PromptEnvelope,
} from '../llm/llm.types';
import { MOONSHOT_CLIENT, MoonshotClientFactory, MOONSHOT_EXTRACT_ID_PREFIX, isBatchable } from './moonshot.constants';
import { MoonshotEnvelopeBuilder } from './moonshot.envelope';
import { MoonshotExtractStore } from './moonshot.extract-store';
import { MoonshotBatchStore } from './moonshot.batch-store';
import { MoonshotBatchWorker } from './moonshot.batch-worker';
import { MoonshotChatBody, toChatResult, mapEffort, jsonSchemaFormat, createChatWithFallback } from './moonshot.chat';
import { tokensFromUsage } from './moonshot.usage';

@Injectable()
export class MoonshotLlmProvider implements LlmProvider {
  readonly capabilities: LlmCapabilities = {
    batch: true,
    fileUpload: true,
    promptCaching: true,
    structuredOutput: true,
  };
  private readonly logger = new Logger(MoonshotLlmProvider.name);

  constructor(
    @Inject(MOONSHOT_CLIENT) private readonly clientFactory: MoonshotClientFactory,
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
    private readonly envelopes: MoonshotEnvelopeBuilder,
    private readonly extracts: MoonshotExtractStore,
    private readonly batchStore: MoonshotBatchStore,
    private readonly worker: MoonshotBatchWorker,
  ) {}

  private get defaultModel(): string {
    return this.config.get<string>('moonshot.model') ?? 'kimi-k3';
  }

  async messageStructured<T = unknown>(req: StructuredRequest, attribution: Attribution): Promise<T> {
    const model = req.model ?? this.defaultModel;
    const built = await this.envelopes.buildRequest(req.envelope, req.prompt, req.system);
    const body: MoonshotChatBody = {
      model,
      messages: built.messages,
      max_completion_tokens: req.maxTokens ?? 32000,
      reasoning_effort: mapEffort(req.effort),
      prompt_cache_key: built.promptCacheKey,
      ...(req.schema ? { response_format: jsonSchemaFormat(req.schema) as any } : {}),
    };
    try {
      const resp = await createChatWithFallback(this.clientFactory.get(), body);
      const r = toChatResult(resp);
      // Capture usage BEFORE any refusal/parse throw — a refusal is still billed.
      this.emitUsage(r.rawUsage, (resp as any).model ?? model, attribution);
      if (r.finishReason === 'length') {
        throw new HttpException({ statusCode: 502, error: 'Structured output truncated (finish_reason=length)' }, HttpStatus.BAD_GATEWAY);
      }
      try {
        return JSON.parse(r.text) as T;
      } catch {
        throw new HttpException({ statusCode: 502, error: 'Structured output was not valid JSON' }, HttpStatus.BAD_GATEWAY);
      }
    } catch (err) {
      this.rethrow(err);
    }
  }

  /**
   * Upload → extract text → cache durably by content hash → delete the remote file
   * (respects the 1,000-file cap) → return a synthetic id resolving to that text.
   * Idempotent: an identical byte payload short-circuits on the content hash.
   */
  async uploadFile(bytes: Buffer, filename: string, mediaType: string): Promise<string> {
    const hash = createHash('sha256').update(bytes).digest('hex');
    const cached = await this.extracts.getByHash(hash);
    if (cached != null) return `${MOONSHOT_EXTRACT_ID_PREFIX}${hash}`;
    const client = this.clientFactory.get();
    try {
      const file = await toFile(bytes, filename, { type: mediaType });
      const uploaded = await client.files.create({ file, purpose: 'file-extract' as any });
      const text = await (await client.files.content(uploaded.id)).text();
      await this.extracts.put(hash, text, { filename, mediaType });
      try {
        await (client.files as any).del(uploaded.id);
      } catch (delErr) {
        this.logger.warn(`Moonshot file ${uploaded.id} extracted but not deleted: ${(delErr as Error).message}`);
      }
      return `${MOONSHOT_EXTRACT_ID_PREFIX}${hash}`;
    } catch (err) {
      this.rethrow(err);
    }
  }

  // Throwing stubs so the class fully implements LlmProvider (and therefore
  // type-checks) in this task. Task 10 replaces these three bodies with the real
  // hybrid batch implementation.
  async submitBatch(_requests: BatchItemRequest[], _envelope: PromptEnvelope | undefined, _opts: BatchSubmitOptions): Promise<BatchHandle> {
    throw new Error('submitBatch: implemented in Task 10');
  }

  async getBatch(_batchId: string): Promise<BatchHandle> {
    throw new Error('getBatch: implemented in Task 10');
  }

  async getBatchResults(_batchId: string): Promise<BatchItemResult[]> {
    throw new Error('getBatchResults: implemented in Task 10');
  }

  private emitUsage(rawUsage: unknown, modelId: string, attribution: Attribution): void {
    try {
      this.events.emit('llm.usage', {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        modelId,
        serviceTier: 'standard',
        attribution,
        tokens: tokensFromUsage(rawUsage),
        source: 'sync',
      });
    } catch {
      // Capture must never affect the request path.
    }
  }

  /** Maps OpenAI/Moonshot SDK errors to Nest HttpExceptions; passes others through. */
  protected rethrow(err: unknown): never {
    if (err instanceof HttpException) throw err;
    const status = (err as { status?: number }).status;
    const type = (err as any)?.error?.type ?? (err as any)?.code;
    if (typeof status === 'number') {
      if (status === 400 && type === 'content_filter') {
        throw new HttpException({ statusCode: 422, error: 'Structured message refused (content_filter)' }, HttpStatus.UNPROCESSABLE_ENTITY);
      }
      if (status >= 500) {
        this.logger.error(`Moonshot API error ${status}: ${(err as Error).message}`);
        throw new HttpException({ statusCode: status, error: 'Upstream Moonshot API error' }, status);
      }
      throw new HttpException({ statusCode: status, error: (err as Error).message }, status);
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}
```

> All imported `llm.types` names are used in this task: `StructuredRequest` (messageStructured) and `BatchItemRequest`/`PromptEnvelope`/`BatchSubmitOptions`/`BatchHandle`/`BatchItemResult` (the throwing batch stubs). Task 10 adds `BatchLifecycle` when it implements `toLifecycle`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx jest src/moonshot/moonshot.service.spec.ts`
Expected: PASS (all 3 cases).

- [ ] **Step 5: Commit**

```bash
git add backend/src/moonshot/moonshot.service.ts backend/src/moonshot/moonshot.service.spec.ts
git commit -m "feat(moonshot): provider messageStructured + uploadFile"
```

---

## Task 10: Provider — hybrid submitBatch + getBatch + getBatchResults

**Files:**
- Modify: `backend/src/moonshot/moonshot.service.ts` (add batch methods where the `// ---- batch methods ----` marker is)
- Test: `backend/src/moonshot/moonshot.service.batch.spec.ts`

- [ ] **Step 1: Write the failing batch test (emulated + native)**

Create `backend/src/moonshot/moonshot.service.batch.spec.ts`:

```ts
import { MoonshotLlmProvider } from './moonshot.service';
import { MoonshotEnvelopeBuilder } from './moonshot.envelope';

const extracts = () => ({ async getById() { return null; }, async getByHash() { return null; }, async put() {} }) as any;

function makeEmulated() {
  const created: any[] = [];
  const batchStore: any = {
    async createBatch(doc: any, items: any[]) { created.push({ doc, items }); },
    async getBatch(id: string) { return created.find((c) => c.doc.batchId === id)?.doc ?? null; },
    async listItems(id: string) { return created.find((c) => c.doc.batchId === id)?.items ?? []; },
  };
  const worker: any = { kicked: [] as string[], kick(id: string) { this.kicked.push(id); } };
  const config = { get: (k: string) => (k === 'moonshot.model' ? 'kimi-k3' : k === 'moonshot.completionWindow' ? '1d' : undefined) } as any;
  const svc = new MoonshotLlmProvider({ get: () => ({}) } as any, config, { emit: () => true } as any, new MoonshotEnvelopeBuilder(extracts()), extracts(), batchStore, worker);
  return { svc, batchStore, worker, created };
}

describe('MoonshotLlmProvider – batch (kimi-k3 → emulated)', () => {
  it('persists an emulated batch, kicks the worker, and reports in_progress then results', async () => {
    const { svc, worker, created } = makeEmulated();
    const handle = await svc.submitBatch(
      [{ customId: 'c1', prompt: 'p1', envelope: { tiers: [{ blocks: [{ type: 'text', text: 'S' }] }] } }],
      undefined,
      { model: 'kimi-k3', schema: { type: 'object' }, maxTokens: 100, effort: 'high' },
    );
    expect(handle.status).toBe('submitted');
    expect(worker.kicked).toEqual([handle.batchId]);
    expect(created[0].doc.model).toBe('kimi-k3');
    expect(created[0].items[0]).toMatchObject({ customId: 'c1', prompt: 'p1', status: 'pending' });

    // getBatch maps in_progress
    expect((await svc.getBatch(handle.batchId)).status).toBe('in_progress');

    // Simulate the worker completing an item, then read results.
    created[0].doc.status = 'ended';
    created[0].items[0] = { customId: 'c1', status: 'succeeded', text: '{"x":1}', usage: { input: 1, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0, output: 1 }, cacheReadTokens: 0 };
    expect((await svc.getBatch(handle.batchId)).status).toBe('ended');
    const results = await svc.getBatchResults(handle.batchId);
    expect(results).toEqual([{ customId: 'c1', type: 'succeeded', text: '{"x":1}', usage: { input: 1, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0, output: 1 }, cacheReadTokens: 0 }]);
  });
});

describe('MoonshotLlmProvider – batch (batchable model → native /v1/batches)', () => {
  function makeNative(retrieve: any, outputText: string) {
    const uploads: any[] = [];
    const client = {
      files: {
        create: async (a: any) => { uploads.push(a); return { id: 'file-in' }; },
        content: async (_id: string) => ({ text: async () => outputText }),
      },
      batches: {
        create: async (b: any) => { (client as any)._created = b; return { id: 'bat-1', status: 'validating' }; },
        retrieve: async (_id: string) => retrieve,
      },
    };
    const config = { get: (k: string) => (k === 'moonshot.completionWindow' ? '1d' : undefined) } as any;
    const svc = new MoonshotLlmProvider({ get: () => client } as any, config, { emit: () => true } as any, new MoonshotEnvelopeBuilder(extracts()), extracts(), {} as any, { kick() {} } as any);
    return { svc, client, uploads };
  }

  it('uploads JSONL (no temperature), creates a batch, maps status, and parses output', async () => {
    const output = JSON.stringify({ custom_id: 'c1', response: { status_code: 200, body: { choices: [{ message: { content: '{"y":2}' } }], usage: { prompt_tokens: 6, cached_tokens: 2, completion_tokens: 1 } } }, error: null });
    const { svc, client } = makeNative({ id: 'bat-1', status: 'completed', output_file_id: 'file-out', request_counts: { total: 1 } }, output);
    const handle = await svc.submitBatch(
      [{ customId: 'c1', prompt: 'p1', envelope: { tiers: [{ blocks: [{ type: 'text', text: 'S' }] }] } }],
      undefined,
      { model: 'kimi-k2.6', schema: { type: 'object' }, maxTokens: 100, effort: 'high' },
    );
    expect(handle.batchId).toBe('bat-1');
    const body = (client.batches as any).create ? (client as any)._created : null;
    expect(body.endpoint).toBe('/v1/chat/completions');
    expect(body.completion_window).toBe('1d');
    expect((await svc.getBatch('bat-1')).status).toBe('ended');
    const results = await svc.getBatchResults('bat-1');
    expect(results[0]).toMatchObject({ customId: 'c1', type: 'succeeded', text: '{"y":2}' });
    expect(results[0].usage).toEqual({ input: 4, cacheRead: 2, cacheCreate5m: 0, cacheCreate1h: 0, output: 1 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest src/moonshot/moonshot.service.batch.spec.ts`
Expected: FAIL — `submitBatch`/`getBatch`/`getBatchResults` are not defined on the class.

- [ ] **Step 3: Implement the batch methods**

In `backend/src/moonshot/moonshot.service.ts`, **replace the three throwing stub methods** (`submitBatch`/`getBatch`/`getBatchResults` from Task 9) with the real implementations + private helpers below:

```ts
  async submitBatch(
    requests: BatchItemRequest[],
    envelope: PromptEnvelope | undefined,
    opts: BatchSubmitOptions,
  ): Promise<BatchHandle> {
    const model = opts.model ?? this.defaultModel;
    return isBatchable(model)
      ? this.submitNativeBatch(requests, envelope, opts, model)
      : this.submitEmulatedBatch(requests, envelope, opts, model);
  }

  // kimi-k3: durable emulation. Persist batch + item docs, kick the worker, return
  // immediately. The reconciler polls getBatch/getBatchResults across ticks.
  private async submitEmulatedBatch(
    requests: BatchItemRequest[],
    envelope: PromptEnvelope | undefined,
    opts: BatchSubmitOptions,
    model: string,
  ): Promise<BatchHandle> {
    const batchId = `msb_${randomUUID()}`;
    const nowMs = Date.now();
    const maxAge = this.config.get<number>('moonshot.batchMaxAgeMs') ?? 10_800_000; // 3h
    const items = requests.map((r, i) => ({
      customId: r.customId ?? `request-${i}`,
      prompt: r.prompt,
      ...(r.envelope ? { envelope: r.envelope } : {}),
      status: 'pending' as const,
      attempts: 0,
    }));
    await this.batchStore.createBatch(
      {
        batchId,
        model,
        opts: { schema: opts.schema, maxTokens: opts.maxTokens, effort: opts.effort },
        ...(envelope ? { batchEnvelope: envelope } : {}),
        status: 'in_progress',
        total: items.length,
        createdAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + maxAge).toISOString(), // D6
      },
      items,
    );
    this.worker.kick(batchId);
    return { batchId, status: 'submitted' };
  }

  // batchable models: native OpenAI-compatible Batch API.
  private async submitNativeBatch(
    requests: BatchItemRequest[],
    envelope: PromptEnvelope | undefined,
    opts: BatchSubmitOptions,
    model: string,
  ): Promise<BatchHandle> {
    const client = this.clientFactory.get();
    const window = this.config.get<string>('moonshot.completionWindow') ?? '1d';
    try {
      const lines: string[] = [];
      for (let i = 0; i < requests.length; i++) {
        const r = requests[i];
        const built = await this.envelopes.buildRequest(r.envelope ?? envelope, r.prompt);
        // NOTE: no temperature/top_p — Moonshot fixes them and rejects batches that set them.
        const body: MoonshotChatBody = {
          model,
          messages: built.messages,
          max_completion_tokens: opts.maxTokens ?? 32000,
          reasoning_effort: mapEffort(opts.effort),
          prompt_cache_key: built.promptCacheKey,
          ...(opts.schema ? { response_format: jsonSchemaFormat(opts.schema) as any } : {}),
        };
        lines.push(JSON.stringify({ custom_id: r.customId ?? `request-${i}`, method: 'POST', url: '/v1/chat/completions', body }));
      }
      const file = await toFile(Buffer.from(lines.join('\n'), 'utf8'), 'batch.jsonl', { type: 'application/jsonl' });
      const input = await client.files.create({ file, purpose: 'batch' as any });
      const batch = await (client as any).batches.create({
        input_file_id: input.id,
        endpoint: '/v1/chat/completions',
        completion_window: window,
      });
      return { batchId: batch.id, status: this.toLifecycle(batch.status) };
    } catch (err) {
      this.rethrow(err);
    }
  }

  async getBatch(batchId: string): Promise<BatchHandle> {
    if (batchId.startsWith('msb_')) {
      const doc = await this.batchStore.getBatch(batchId);
      if (!doc) throw new HttpException({ statusCode: 404, error: `Unknown batch ${batchId}` }, HttpStatus.NOT_FOUND);
      const status = doc.status === 'ended' ? 'ended' : doc.status === 'errored' ? 'errored' : 'in_progress';
      return { batchId, status };
    }
    try {
      const batch = await (this.clientFactory.get() as any).batches.retrieve(batchId);
      return { batchId: batch.id, status: this.toLifecycle(batch.status), requestCounts: batch.request_counts };
    } catch (err) {
      this.rethrow(err);
    }
  }

  async getBatchResults(batchId: string): Promise<BatchItemResult[]> {
    return batchId.startsWith('msb_')
      ? this.emulatedResults(batchId)
      : this.nativeResults(batchId);
  }

  private async emulatedResults(batchId: string): Promise<BatchItemResult[]> {
    const items = await this.batchStore.listItems(batchId);
    return items
      .filter((i) => i.status !== 'pending' && i.status !== 'running') // terminal items only
      .map((i) => ({
        customId: i.customId,
        type: i.status,
        ...(i.text !== undefined ? { text: i.text } : {}),
        ...(i.error !== undefined ? { error: i.error } : {}),
        ...(i.usage !== undefined ? { usage: i.usage } : {}),
        ...(i.cacheReadTokens !== undefined ? { cacheReadTokens: i.cacheReadTokens } : {}),
      }));
  }

  private async nativeResults(batchId: string): Promise<BatchItemResult[]> {
    const client = this.clientFactory.get() as any;
    try {
      const batch = await client.batches.retrieve(batchId);
      const items: BatchItemResult[] = [];
      if (batch.output_file_id) {
        const text = await (await client.files.content(batch.output_file_id)).text();
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          const row = JSON.parse(line);
          const customId = row.custom_id;
          const status = row.response?.status_code;
          const body = row.response?.body;
          if (status === 200 && body) {
            const content = body.choices?.[0]?.message?.content ?? '';
            const item: BatchItemResult = { customId, type: 'succeeded', text: content };
            if (body.usage) {
              item.usage = tokensFromUsage(body.usage);
              item.cacheReadTokens = body.usage.cached_tokens ?? 0;
            }
            items.push(item);
          } else if (row.error || body?.error) {
            const type = (body?.error?.type ?? row.error?.type);
            items.push(type === 'content_filter' ? { customId, type: 'refusal' } : { customId, type: 'errored', error: JSON.stringify(row.error ?? body?.error) });
          } else {
            items.push({ customId, type: 'errored', error: `status ${status}` });
          }
        }
      }
      if (batch.error_file_id) {
        const text = await (await client.files.content(batch.error_file_id)).text();
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          const row = JSON.parse(line);
          items.push({ customId: row.custom_id, type: 'errored', error: JSON.stringify(row.error ?? row) });
        }
      }
      return items;
    } catch (err) {
      this.rethrow(err);
    }
  }

  // Map Moonshot native batch status → neutral lifecycle.
  private toLifecycle(status: string): BatchLifecycle {
    switch (status) {
      case 'completed':
        return 'ended';
      case 'failed':
        return 'errored';
      case 'expired':
        return 'expired';
      case 'cancelling':
      case 'cancelled':
        return 'canceled';
      case 'validating':
      case 'in_progress':
      case 'finalizing':
        return 'in_progress';
      default:
        return 'submitted';
    }
  }
```

Add `BatchLifecycle` to this file's existing `../llm/llm.types` import (the `PromptEnvelope` imported in Task 9 is now used by `submitBatch`, so no import is unused).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx jest src/moonshot/moonshot.service.batch.spec.ts`
Expected: PASS (both describe blocks).

- [ ] **Step 5: Run the whole moonshot suite**

Run: `cd backend && npx jest src/moonshot`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/moonshot/moonshot.service.ts backend/src/moonshot/moonshot.service.batch.spec.ts
git commit -m "feat(moonshot): hybrid submitBatch/getBatch/getBatchResults"
```

---

## Task 11: Module wiring + contract test

**Files:**
- Create: `backend/src/moonshot/moonshot.module.ts`
- Create: `backend/src/moonshot/moonshot.contract.spec.ts`

- [ ] **Step 1: Write the failing contract test**

Create `backend/src/moonshot/moonshot.contract.spec.ts` (mirrors `llm.contract.spec.ts`):

```ts
import { MoonshotLlmProvider } from './moonshot.service';
import { LlmProvider } from '../llm/llm.provider';

describe('MoonshotLlmProvider satisfies the LlmProvider contract', () => {
  it('exposes every port method and full capabilities', () => {
    const svc = new MoonshotLlmProvider(
      { get: () => { throw new Error('unused'); } } as any, // client factory
      { get: () => undefined } as any, // ConfigService
      { emit: () => true } as any, // EventEmitter2
      { buildRequest: async () => ({ messages: [], promptCacheKey: '' }) } as any, // envelope builder
      { getById: async () => null, getByHash: async () => null, put: async () => {} } as any, // extract store
      {} as any, // batch store
      { kick: () => {} } as any, // worker
    );
    const port: LlmProvider = svc; // compile-time contract assertion
    expect(typeof port.messageStructured).toBe('function');
    expect(typeof port.uploadFile).toBe('function');
    expect(typeof port.submitBatch).toBe('function');
    expect(typeof port.getBatch).toBe('function');
    expect(typeof port.getBatchResults).toBe('function');
    expect(port.capabilities).toEqual({ batch: true, fileUpload: true, promptCaching: true, structuredOutput: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest src/moonshot/moonshot.contract.spec.ts`
Expected: PASS at runtime is possible, but this step's purpose is to lock the constructor arg order. If it fails, it's a signature drift — fix the service constructor to match `(clientFactory, config, events, envelopes, extracts, batchStore, worker)`.

- [ ] **Step 3: Implement the module**

Create `backend/src/moonshot/moonshot.module.ts`:

```ts
import { Global, Module, Provider, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { MOONSHOT_CLIENT, MoonshotClientFactory } from './moonshot.constants';
import { MoonshotLlmProvider } from './moonshot.service';
import { MoonshotEnvelopeBuilder } from './moonshot.envelope';
import { MoonshotExtractStore } from './moonshot.extract-store';
import { MoonshotBatchStore } from './moonshot.batch-store';
import { MoonshotBatchWorker } from './moonshot.batch-worker';

// Kimi K3's always-on reasoning at a high max_completion_tokens ceiling can run
// long; give the client a generous timeout so a legitimate slow call is not
// aborted early (mirrors the Anthropic module's rationale).
const CLIENT_TIMEOUT_MS = 30 * 60 * 1000;

const moonshotClientProvider: Provider = {
  provide: MOONSHOT_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): MoonshotClientFactory => {
    let client: OpenAI | undefined;
    return {
      get(): OpenAI {
        if (!client) {
          const apiKey = config.get<string>('moonshot.apiKey');
          if (!apiKey) throw new UnauthorizedException('MOONSHOT_API_KEY is not configured');
          const baseURL = config.get<string>('moonshot.baseUrl') ?? 'https://api.moonshot.ai/v1';
          client = new OpenAI({ apiKey, baseURL, timeout: CLIENT_TIMEOUT_MS });
        }
        return client;
      },
    };
  },
};

@Global()
@Module({
  providers: [
    moonshotClientProvider,
    MoonshotExtractStore,
    MoonshotEnvelopeBuilder,
    MoonshotBatchStore,
    MoonshotBatchWorker,
    MoonshotLlmProvider,
  ],
  exports: [MOONSHOT_CLIENT, MoonshotLlmProvider],
})
export class MoonshotModule {}
```

- [ ] **Step 4: Run the contract + full moonshot suite**

Run: `cd backend && npx jest src/moonshot`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/moonshot/moonshot.module.ts backend/src/moonshot/moonshot.contract.spec.ts
git commit -m "feat(moonshot): NestJS module wiring + contract test"
```

---

## Task 12: Activate the provider at the swap seam

**Files:**
- Modify: `backend/src/llm/llm.module.ts`
- Modify: `backend/src/app.module.ts:8,25` (import MoonshotModule before LlmModule)
- Test: `backend/src/llm/llm.module.spec.ts` (create if absent)

- [ ] **Step 1: Write the failing provider-selection test**

Create `backend/src/llm/llm.module.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { LLM_PROVIDER } from './llm.constants';
import { LlmModule } from './llm.module';
import { MoonshotLlmProvider } from '../moonshot/moonshot.service';
import { AnthropicLlmProvider } from '../anthropic/anthropic.service';
import { FIRESTORE } from '../firebase/firebase.constants';

async function providerFor(llmProvider: string) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      EventEmitterModule.forRoot(),
      ConfigModule.forRoot({ isGlobal: true, load: [() => ({ llm: { provider: llmProvider }, moonshot: {}, anthropic: {} })] }),
      LlmModule,
    ],
  })
    .overrideProvider(FIRESTORE)
    .useValue({})
    .compile();
  return moduleRef.get(LLM_PROVIDER);
}

describe('LlmModule swap seam', () => {
  it('selects Moonshot when llm.provider=moonshot', async () => {
    expect(await providerFor('moonshot')).toBeInstanceOf(MoonshotLlmProvider);
  });
  it('selects Anthropic by default', async () => {
    expect(await providerFor('anthropic')).toBeInstanceOf(AnthropicLlmProvider);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest src/llm/llm.module.spec.ts`
Expected: FAIL — `moonshot` throws `Unknown llm.provider` (and/or `MoonshotModule` not imported).

- [ ] **Step 3: Wire MoonshotModule into the swap seam**

Replace `backend/src/llm/llm.module.ts` with:

```ts
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AnthropicModule } from '../anthropic/anthropic.module';
import { AnthropicLlmProvider } from '../anthropic/anthropic.service';
import { MoonshotModule } from '../moonshot/moonshot.module';
import { MoonshotLlmProvider } from '../moonshot/moonshot.service';
import { LLM_PROVIDER } from './llm.constants';
import { LlmProvider } from './llm.provider';

// Single swap seam: selects the active provider by config. Add new adapters here.
@Global()
@Module({
  imports: [AnthropicModule, MoonshotModule],
  providers: [
    {
      provide: LLM_PROVIDER,
      inject: [ConfigService, AnthropicLlmProvider, MoonshotLlmProvider],
      useFactory: (
        cfg: ConfigService,
        anthropic: AnthropicLlmProvider,
        moonshot: MoonshotLlmProvider,
      ): LlmProvider => {
        const provider = cfg.get<string>('llm.provider') ?? 'anthropic';
        switch (provider) {
          case 'anthropic':
            return anthropic;
          case 'moonshot':
            return moonshot;
          default:
            throw new Error(`Unknown llm.provider: ${provider}`);
        }
      },
    },
  ],
  exports: [LLM_PROVIDER],
})
export class LlmModule {}
```

In `backend/src/app.module.ts`, add the import and register the module before `LlmModule`:

Add after line 8 (`import { AnthropicModule } ...`):

```ts
import { MoonshotModule } from './moonshot/moonshot.module';
```

And in the `imports:` array, add `MoonshotModule,` immediately after `AnthropicModule,` (before `LlmModule,`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx jest src/llm/llm.module.spec.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add backend/src/llm/llm.module.ts backend/src/llm/llm.module.spec.ts backend/src/app.module.ts
git commit -m "feat(llm): activate moonshot provider at the config swap seam"
```

---

## Task 13: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Type-check + build the whole backend**

Run: `cd backend && npm run build`
Expected: PASS — no TypeScript errors. If unused-import errors appear in `moonshot.service.ts`, ensure `PromptEnvelope` and `BatchLifecycle` are actually referenced (they are, after Task 10).

- [ ] **Step 2: Run the entire test suite**

Run: `cd backend && npx jest`
Expected: PASS — all specs green, including the untouched benchmark/anthropic/cost suites (proves the neutral port and pipeline are unchanged) and the new moonshot suite.

- [ ] **Step 3: Sanity-check keyless boot (no MOONSHOT_API_KEY)**

Run: `cd backend && LLM_PROVIDER=moonshot NODE_ENV=test node -e "require('ts-node/register'); const {NestFactory}=require('@nestjs/core'); const {AppModule}=require('./src/app.module'); NestFactory.create(AppModule,{logger:false}).then(a=>a.close()).then(()=>console.log('BOOT OK')).catch(e=>{console.error(e);process.exit(1)})"`
Expected: prints `BOOT OK` — the module graph builds and the Moonshot client is never constructed at init (keyless boot), mirroring Anthropic. If `ts-node` invocation is awkward in this repo, instead assert boot via an e2e test that imports `AppModule` with `FIRESTORE` overridden.

- [ ] **Step 4: Final commit (if any spec adjustments were needed)**

```bash
git add -A
git commit -m "test(moonshot): full-suite verification and keyless-boot check" || echo "nothing to commit"
```

---

## Spec coverage map

| Spec section | Task(s) |
|---|---|
| §5 new files under `backend/src/moonshot/` | 4–11 |
| §6.1 messageStructured | 9 |
| §6.1.1 strict schema shaping + fallback (D8) | 6 (`toMoonshotSchema`/`createChatWithFallback`), used by 9 & 8/10 |
| §6.2 envelope / implicit caching + prompt_cache_key | 6 |
| §6.3 uploadFile → durable extract store | 5, 9 |
| §6.4 hybrid batch (native + emulated) | 7, 8, 10 |
| §6.4 D5 item claiming | 7 (`claimItem`), 8 (`claimAndRun`) |
| §6.4 D6 batch expiry | 1 (`batchMaxAgeMs`), 7 (`expiresAt`), 8 (drain expiry check) |
| §6.4 D7 prefix-grouped priming | 8 (`groupByPrefix` + two-phase `runPool`) |
| §6.4.1 cache-warmer mapping (works via emulated submitBatch) | 8, 10 (no benchmark change) |
| §6.5 usage mapping | 4 |
| §6.6 pricing overrides + kimi rates | 2 |
| §6.7 provider-aware flagship | 1, 3 |
| §7 config/env (incl. `batchMaxAgeMs`/`batchGcTtlMs`) | 1 |
| §8 Firestore data model (`running`/lease/`attempts`/`expiresAt`) | 5, 7 |
| §9 testing (contract, usage, envelope, chat, batch, pricing, swap, D5/D6/D8) | 2, 4, 5, 6, 7, 8, 9, 10, 11, 12 |
| §10 risks (chunking, backoff, GC-by-endedAt, write amplification, K3 token budget) | 5, 7, 8 |

## Notes for the implementer

- **SDK method names are pinned to `openai@^4`** (`files.del`, `files.content(id).text()`, `batches.create/retrieve`). If a later task shows a type error against an installed v5, adjust `files.del`→`files.delete` and re-pin — do not change the request/response shapes.
- **Never send `temperature`/`top_p`** in any Moonshot request (sync or batch) — Moonshot fixes them and rejects batches that set them.
- **The reconciler and cache-warmer are unchanged.** They drive Moonshot purely through the neutral port; the emulated batch's synthetic `msb_…` id is opaque to them (only `customId` is ever parsed).
- **Emulated k3 batches emit `serviceTier:'batch'`** via the existing reconciler, but pricing charges them at standard rates (`kimi-k3` `batchMultiplier:1.0`) — this is intentional, since k3 gets no batch discount.
- **Hardening (D5–D8) lives entirely in the Moonshot adapter.** D5 item claiming (`claimItem` transaction) makes concurrent `kick()`/bootstrap-resume single-run; D6 `expiresAt` prevents stuck `in_progress` batches; D7 groups the emulated fan-out by prefix so caching actually pays off; D8 shapes the schema for strict mode and adds a `json_object`/`partial` fallback. All schema sends go through `jsonSchemaFormat` (which applies `toMoonshotSchema`), and all sync chat sends (service + worker) go through `createChatWithFallback`.
- **`claimItem` atomicity is load-bearing.** The real store gets it from a Firestore `runTransaction`; the test fakes rely on single-threaded synchronicity (no `await` before the status flip). Do not introduce an `await` between the claimability check and the `update` inside `claimItem`.
