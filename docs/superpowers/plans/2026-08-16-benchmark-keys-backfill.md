# Benchmark KEYS Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a detached, resumable, strictly sequential job that generates seven-keys KEYS artifacts for the entire committed eminiplayer corpus, so every day is graded with a full 3-day lookback.

**Architecture:** A new in-memory singleton `KeysBackfillService` walks committed days oldest-first, calling the existing `SevenKeysService.ensureKeys` one day at a time. Durable state lives in the KEYS artifacts, so a re-POST resumes. A shared `BenchmarkRunLock` makes the job and `POST /benchmark/run` mutually exclusive. A day that fails three attempts stops the job for manual investigation rather than leaving a lookback hole.

**Tech Stack:** NestJS 10, TypeScript, Jest + ts-jest (`rootDir: src`, `testRegex: .*\.spec\.ts$`), firebase-admin, pnpm.

**Spec:** `docs/superpowers/specs/2026-08-16-benchmark-keys-backfill-design.md`
**Review this plan answers:** `docs/superpowers/plans/2026-08-16-benchmark-keys-backfill-review.md`

## Global Constraints

- `LOOKBACK_DAYS` stays **3** and stays hardcoded. Do not change seven-keys prompts, the weighting rule, or the verifier.
- Max **3** attempts per day; on exhaustion the job **stops** (`state: 'failed'`). Never continue past a failed day.
- `refused` (pin anomaly), `timeout`, and a snapshot mismatch are **non-retryable** — stop on the first occurrence.
- **`ensureKeys` never throws.** It catches everything from `generate()` and returns `null`. All failure classification must come from the `onFailure` callback, never from a `catch` around `ensureKeys`.
- Reuse requires `verified === true` **and** empty `lookbackMissing`. `verified` alone is written even for degraded artifacts.
- The job never passes `force`. Job state is **in-memory only**.
- Day keys are `MMDDYYYY`; listing dates are `YYYY-MM-DD`.
- The existing 409 message for a concurrent run must stay `a benchmark run is already in progress` (asserted by `/already in progress/i` at `benchmark.service.spec.ts:358`).
- **Existing specs use `Test.createTestingModule`, never `new Service(...)`.** New constructor params require a new entry in the spec's `providers` array, or that whole spec file fails at `.compile()`.
- Tests live under `src/` (jest `rootDir` is `src`). `backend/scripts/` is not test-discovered, so logic belongs in `src/`.
- Run tests with `npx jest <path>` from `backend/`.

---

### Task 1: Shared single-flight lock

**Files:**
- Create: `backend/src/benchmark/run-lock.ts`, `backend/src/benchmark/run-lock.spec.ts`
- Modify: `backend/src/benchmark/benchmark.service.ts` (field `:81`, guard `:97-106`, constructor)
- Modify: `backend/src/benchmark/benchmark.service.spec.ts` (providers array in `build()`)
- Modify: `backend/src/benchmark/benchmark.module.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `BenchmarkRunLock` with `acquire(holder: LockHolder): void`, `release(holder: LockHolder): void`, `get heldBy(): LockHolder | null`; `type LockHolder = 'benchmark-run' | 'keys-backfill'`; `class LockHeldError extends Error { readonly holder: LockHolder }`.

- [ ] **Step 1: Write the failing test**

Create `backend/src/benchmark/run-lock.spec.ts`:

```ts
import { BenchmarkRunLock, LockHeldError } from './run-lock';

describe('BenchmarkRunLock', () => {
  it('starts unheld', () => {
    expect(new BenchmarkRunLock().heldBy).toBeNull();
  });

  it('acquire records the holder', () => {
    const lock = new BenchmarkRunLock();
    lock.acquire('keys-backfill');
    expect(lock.heldBy).toBe('keys-backfill');
  });

  it('rejects a second acquire naming the current holder', () => {
    const lock = new BenchmarkRunLock();
    lock.acquire('keys-backfill');
    try {
      lock.acquire('benchmark-run');
      throw new Error('expected LockHeldError');
    } catch (err) {
      expect(err).toBeInstanceOf(LockHeldError);
      expect((err as LockHeldError).holder).toBe('keys-backfill');
      expect((err as Error).message).toBe('a keys backfill is already in progress');
    }
  });

  it('keeps the legacy wording for a held benchmark run', () => {
    const lock = new BenchmarkRunLock();
    lock.acquire('benchmark-run');
    expect(() => lock.acquire('keys-backfill')).toThrow('a benchmark run is already in progress');
  });

  it('release frees the lock for the other holder', () => {
    const lock = new BenchmarkRunLock();
    lock.acquire('benchmark-run');
    lock.release('benchmark-run');
    expect(lock.heldBy).toBeNull();
    expect(() => lock.acquire('keys-backfill')).not.toThrow();
  });

  it('release by a non-holder is a no-op', () => {
    const lock = new BenchmarkRunLock();
    lock.acquire('benchmark-run');
    lock.release('keys-backfill');
    expect(lock.heldBy).toBe('benchmark-run');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/benchmark/run-lock.spec.ts`
Expected: FAIL — `Cannot find module './run-lock'`

- [ ] **Step 3: Write minimal implementation**

Create `backend/src/benchmark/run-lock.ts`:

```ts
import { Injectable } from '@nestjs/common';

export type LockHolder = 'benchmark-run' | 'keys-backfill';

const HOLDER_LABEL: Record<LockHolder, string> = {
  'benchmark-run': 'benchmark run',
  'keys-backfill': 'keys backfill',
};

/** Thrown by acquire() when someone else holds the lock; controllers map to 409. */
export class LockHeldError extends Error {
  constructor(readonly holder: LockHolder) {
    super(`a ${HOLDER_LABEL[holder]} is already in progress`);
  }
}

/**
 * Single-flight across everything that calls SevenKeysService.ensureKeys.
 * Two concurrent writers race saveKeysArtifact (last-write-wins) and can orphan
 * a submitted batch's pinned KEYS hash — a permanent per-day wedge.
 *
 * In-memory, so this assumes a SINGLE backend process. BENCHMARK_SCHEDULER
 * exists to split API from worker; running the keys backfill in a multi-process
 * deployment would need a Firestore lease instead. Out of scope by design.
 */
@Injectable()
export class BenchmarkRunLock {
  private holder: LockHolder | null = null;

  acquire(holder: LockHolder): void {
    if (this.holder) throw new LockHeldError(this.holder);
    this.holder = holder;
  }

  release(holder: LockHolder): void {
    if (this.holder === holder) this.holder = null;
  }

  get heldBy(): LockHolder | null {
    return this.holder;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/benchmark/run-lock.spec.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Wire BenchmarkService onto the lock**

In `benchmark.service.ts`: add the import `import { BenchmarkRunLock, LockHeldError } from './run-lock';`, delete `private runInProgress = false;` (`:81`), append `private readonly lock: BenchmarkRunLock,` to the constructor parameter list, and replace the guard block at `:97-106`:

```ts
    // Single-flight: two concurrent callers racing ensureKeys can orphan a
    // submitted batch's pinned KEYS hash (last-write-wins saveKeysArtifact) —
    // a permanent per-day wedge. Shared with the keys-backfill job.
    try {
      this.lock.acquire('benchmark-run');
    } catch (err) {
      if (err instanceof LockHeldError) throw new ConflictException(err.message);
      throw err;
    }
    try {
      return await this.runInner(opts, daysFilter);
    } finally {
      this.lock.release('benchmark-run');
    }
```

- [ ] **Step 6: Register the provider in the spec's testing module**

`benchmark.service.spec.ts` builds via `Test.createTestingModule({ providers: [BenchmarkService, EnvelopeBuilder, { provide: BenchmarkRepository, useValue: deps.repo }, …] })`. Add the **real** class (not a fake — the concurrency test needs working `heldBy` semantics) to that array:

```ts
import { BenchmarkRunLock } from './run-lock';
// …inside providers:
      BenchmarkRunLock,
```

- [ ] **Step 7: Register the provider in the module**

In `benchmark.module.ts` import `BenchmarkRunLock`, add it to `providers` (before `BenchmarkService`) **and** to `exports`.

- [ ] **Step 8: Run the full benchmark suite**

Run: `npx jest src/benchmark`
Expected: PASS — 215 existing + 6 new. The `/already in progress/i` assertion must still pass.

- [ ] **Step 9: Commit**

```bash
git add backend/src/benchmark/run-lock.ts backend/src/benchmark/run-lock.spec.ts backend/src/benchmark/benchmark.service.ts backend/src/benchmark/benchmark.service.spec.ts backend/src/benchmark/benchmark.module.ts
git commit -m "feat(benchmark): shared single-flight run lock"
```

---

### Task 2: Seven-keys failure seam

**Files:**
- Modify: `backend/src/benchmark/seven-keys/seven-keys.service.ts`
- Modify: `backend/src/benchmark/seven-keys/seven-keys.service.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SevenKeysService.lineageAlias: string` (public getter); exported `interface KeysFailure { kind: 'unverified' | 'error' | 'refused'; message: string; mismatches: string[] }`; `ensureKeys(day, snap, opts?)` where `opts` gains `onFailure?: (f: KeysFailure) => void`.

`ensureKeys` still returns `DayArtifactDoc | null` — existing callers are untouched. The seam exists because `ensureKeys` **swallows every generation error**, so `null` alone cannot be diagnosed.

- [ ] **Step 1: Write the failing test**

Append inside the existing top-level `describe` in `seven-keys.service.spec.ts`. These use the file's real helpers — `makeDeps()`, `await build(deps, configOverrides)` (returns the service **bare**), and the module-level `DAY` / `SNAP` constants:

```ts
  it('exposes the flagship lineage alias from config', async () => {
    const svc = await build(makeDeps(), { 'benchmark.model': 'kimi-k3' });
    expect(svc.lineageAlias).toBe('k3');
  });

  it('defaults the lineage alias to the anthropic flagship', async () => {
    const svc = await build(makeDeps());
    expect(svc.lineageAlias).toBe('fable');
  });

  it('reports a verifier rejection through onFailure as kind "unverified"', async () => {
    const svc = await build(makeDeps());
    jest.spyOn(svc, 'generate').mockResolvedValue({
      verified: false,
      mismatches: ['7495.25-7502.75: side mismatch'],
      artifact: '# x',
      lookbackSources: [],
      lookbackMissing: [],
    });
    const seen: KeysFailure[] = [];
    const doc = await svc.ensureKeys(DAY, SNAP, { onFailure: (f) => seen.push(f) });
    expect(doc).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'unverified', mismatches: ['7495.25-7502.75: side mismatch'] });
  });

  it('reports a generation throw through onFailure as kind "error"', async () => {
    const svc = await build(makeDeps());
    jest.spyOn(svc, 'generate').mockRejectedValue(new Error('moonshot 529 rate limited'));
    const seen: KeysFailure[] = [];
    const doc = await svc.ensureKeys(DAY, SNAP, { onFailure: (f) => seen.push(f) });
    expect(doc).toBeNull();
    expect(seen[0].kind).toBe('error');
    expect(seen[0].message).toContain('moonshot 529 rate limited');
  });

  it('reports an orphaned-pin anomaly through onFailure as kind "refused"', async () => {
    const deps = makeDeps();
    deps.repo.getKeysArtifact.mockResolvedValue(null);
    deps.repo.pinnedKeysHashes.mockResolvedValue(new Set(['dangling-kh']));
    const svc = await build(deps);
    const seen: KeysFailure[] = [];
    const doc = await svc.ensureKeys(DAY, SNAP, { onFailure: (f) => seen.push(f) });
    expect(doc).toBeNull();
    expect(seen[0].kind).toBe('refused');
    expect(seen[0].message).toContain('dangling-kh');
  });

  it('does not call onFailure when the artifact verifies', async () => {
    const deps = makeDeps();
    queueGenerationRun(deps.fake, { lookback: false });
    const svc = await build(deps);
    const onFailure = jest.fn();
    await svc.ensureKeys(DAY, SNAP, { onFailure });
    expect(onFailure).not.toHaveBeenCalled();
  });
```

Add `KeysFailure` to the file's existing import from `./seven-keys.service`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/benchmark/seven-keys/seven-keys.service.spec.ts`
Expected: FAIL — `lineageAlias` undefined and `onFailure` never invoked.

- [ ] **Step 3: Write minimal implementation**

In `seven-keys.service.ts`, export the failure type near the top:

```ts
export interface KeysFailure {
  kind: 'unverified' | 'error' | 'refused';
  message: string;
  mismatches: string[];
}
```

Add the public getter beside the private `flagshipAlias` getter:

```ts
  /** The KEYS lineage this instance reads and writes (e.g. 'k3'). */
  get lineageAlias(): string {
    return this.flagshipAlias;
  }
```

Widen the options:

```ts
  async ensureKeys(
    day: DayInput,
    snap: InputsSnapshot,
    opts?: { force?: boolean; pinned?: boolean; onFailure?: (f: KeysFailure) => void },
  ): Promise<DayArtifactDoc | null> {
```

Then invoke it at all four `return null` sites, keeping every existing log line exactly as-is and adding only the callback:

- The **in-flight-pin anomaly** return — before it:
  ```ts
      opts?.onFailure?.({ kind: 'refused', message: msg, mismatches: [] });
  ```
  where `msg` is the same string passed to `this.logger.error(...)` on the line above.
- The **orphaned-pin anomaly** return — same pattern, `kind: 'refused'`.
- The generation `catch`:
  ```ts
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`Seven-keys generation failed for ${day.day}: ${message}`);
      opts?.onFailure?.({ kind: 'error', message, mismatches: [] });
      return null;
    }
  ```
- The verifier branch:
  ```ts
    if (!result.verified) {
      this.logger.warn(`Seven-keys verifier failed for ${day.day}: ${result.mismatches.join('; ')}`);
      opts?.onFailure?.({ kind: 'unverified', message: `verifier rejected the artifact: ${result.mismatches.join('; ')}`, mismatches: result.mismatches });
      return null;
    }
  ```

Where the anomaly branches currently build their message inline in the `logger.error(...)` call, hoist it to a `const msg = ...` first so both the log and the callback use one string.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/benchmark/seven-keys`
Expected: PASS — 32 existing + 6 new.

- [ ] **Step 5: Commit**

```bash
git add backend/src/benchmark/seven-keys/seven-keys.service.ts backend/src/benchmark/seven-keys/seven-keys.service.spec.ts
git commit -m "feat(seven-keys): classified failure seam and lineage alias"
```

---

### Task 3: Extract day-artifact recording

**Files:**
- Modify: `backend/src/benchmark/day-artifacts.service.ts`, `backend/src/benchmark/day-artifacts.service.spec.ts`
- Modify: `backend/src/benchmark/benchmark.service.ts:349-356`

**Interfaces:**
- Consumes: nothing.
- Produces: `DayArtifactsService.ensureDayRecorded(day: DayInput): Promise<PdfArtifact>` — mirrors the PDF and both transcripts and returns the PDF artifact.

**Ordering contract:** `SevenKeysService.generate` calls `dayArtifacts.ensureFileId(day)`, which throws `No pdfFile artifact recorded for day X` if this ran first. `ensureDayRecorded` **must** precede `ensureKeys` for any day. That coupling is invisible in the signatures, so it is stated in both doc comments.

- [ ] **Step 1: Write the failing test**

Append to `day-artifacts.service.spec.ts`. The file's helper is `async function build(provider?)` returning `{ svc, bucket, upload, repo }` — note `svc`, and note the `await`:

```ts
  it('ensureDayRecorded mirrors the pdf and both transcripts and returns the pdf artifact', async () => {
    const { svc } = await build();
    const day = {
      day: '01022025',
      date: '2025-01-02',
      prefix: '01022025',
      recapDate: '12312024',
      fileSha256: { tradePlanMd: 'a', tradePlanPdf: 'b', recap: 'c' },
      pdf: Buffer.from('pdf-bytes'),
      tpTranscript: 'tp text',
      recapTranscript: 'recap text',
      recapFileName: '12312024_ES_RECAP.md',
    };
    const ensurePdf = jest.spyOn(svc, 'ensurePdf');
    const ensureTranscript = jest.spyOn(svc, 'ensureTranscript');

    const pdf = await svc.ensureDayRecorded(day as never);

    expect(ensurePdf).toHaveBeenCalledWith('01022025', '01022025', day.pdf);
    expect(ensureTranscript).toHaveBeenCalledWith('01022025', 'tpTranscript', '01022025_ES_TP.md', 'tp text');
    expect(ensureTranscript).toHaveBeenCalledWith('01022025', 'recapTranscript', '12312024_ES_RECAP.md', 'recap text');
    expect(pdf.providerFileId).toBeDefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/benchmark/day-artifacts.service.spec.ts`
Expected: FAIL — `svc.ensureDayRecorded is not a function`

- [ ] **Step 3: Write minimal implementation**

In `day-artifacts.service.ts` add `import type { DayInput } from './cloud-inputs.service';` (type-only, so no module cycle), then after `ensureTranscript`:

```ts
  /**
   * Records everything a day needs before seven-keys can run: the PDF (so
   * ensureFileId resolves a live provider file id) plus both transcripts.
   * MUST be called before SevenKeysService.ensureKeys for the same day —
   * generate() calls ensureFileId, which throws without the pdfFile record.
   */
  async ensureDayRecorded(day: DayInput): Promise<PdfArtifact> {
    const pdf = await this.ensurePdf(day.day, day.prefix, day.pdf);
    await this.ensureTranscript(day.day, 'tpTranscript', `${day.prefix}_ES_TP.md`, day.tpTranscript);
    await this.ensureTranscript(day.day, 'recapTranscript', day.recapFileName, day.recapTranscript);
    return pdf;
  }
```

- [ ] **Step 4: Collapse `assembleDay` onto it**

Replace `benchmark.service.ts:349-356`:

```ts
  private async assembleDay(day: DayInput): Promise<{ dayBundle: DayBundle }> {
    const pdf = await this.dayArtifacts.ensureDayRecorded(day);
    return {
      dayBundle: { date: day.date, fileId: pdf.providerFileId, tpTranscript: day.tpTranscript, recapTranscript: day.recapTranscript },
    };
  }
```

- [ ] **Step 5: Run tests**

Run: `npx jest src/benchmark`
Expected: PASS — behaviour unchanged.

- [ ] **Step 6: Commit**

```bash
git add backend/src/benchmark/day-artifacts.service.ts backend/src/benchmark/day-artifacts.service.spec.ts backend/src/benchmark/benchmark.service.ts
git commit -m "refactor(benchmark): extract ensureDayRecorded for reuse"
```

---

### Task 4: KeysBackfillService — sequential loop and preflights

**Files:**
- Create: `backend/src/benchmark/keys-backfill.service.ts`, `backend/src/benchmark/keys-backfill.service.spec.ts`

**Interfaces:**
- Consumes: `BenchmarkRunLock` (T1); `SevenKeysService.lineageAlias` + `onFailure` + `KeysFailure` (T2); `DayArtifactsService.ensureDayRecorded` (T3).
- Produces: `KeysBackfillService` with `start(opts: { from?: string; to?: string }): KeysBackfillSnapshot`, `status()`, `cancel()`; exported `MAX_DAY_ATTEMPTS`, `KeysBackfillState`, `KeysBackfillFailure`, `KeysBackfillSnapshot`; private seams `loopPromise`, `nowMs()`, `sleep(ms)`.

Retry/backoff/classification land in Task 5; cancellation and progress in Task 6.

- [ ] **Step 1: Write the failing test**

Create `backend/src/benchmark/keys-backfill.service.spec.ts`:

```ts
import { ConfigService } from '@nestjs/config';
import { KeysBackfillService } from './keys-backfill.service';
import { BenchmarkRunLock } from './run-lock';
import type { DayListing } from './cloud-inputs.service';

function listing(day: string, date: string): DayListing {
  return { day, date, prefix: day, recapDate: day, fileSha256: { tradePlanMd: 'a', tradePlanPdf: 'b', recap: 'c' } };
}

const DAYS = [
  listing('01022025', '2025-01-02'),
  listing('01032025', '2025-01-03'),
  listing('01062025', '2025-01-06'),
];

function build(
  overrides: {
    days?: DayListing[];
    methodsDoc?: string | null;
    ensureKeys?: jest.Mock;
    getKeysArtifact?: jest.Mock;
    loadDay?: jest.Mock;
  } = {},
) {
  const inputs = {
    snapshot: jest.fn(() =>
      Promise.resolve({
        traders: [],
        features: [],
        general: { files: [], concatenated: 'GEN', sha256: 'g' },
        methodsDoc: overrides.methodsDoc === undefined ? 'METHODS' : overrides.methodsDoc,
        days: overrides.days ?? DAYS,
        issues: [],
      }),
    ),
    loadDay:
      overrides.loadDay ??
      jest.fn((l: DayListing) =>
        Promise.resolve({
          ...l,
          pdf: Buffer.from('p'),
          tpTranscript: 't',
          recapTranscript: 'r',
          recapFileName: `${l.recapDate}_ES_RECAP.md`,
        }),
      ),
  };
  const dayArtifacts = {
    ensureDayRecorded: jest.fn(() => Promise.resolve({ providerFileId: 'f', gcsPath: 'g', contentHash: 'h' })),
  };
  const sevenKeys = {
    lineageAlias: 'k3',
    ensureKeys: overrides.ensureKeys ?? jest.fn(() => Promise.resolve({ contentHash: 'kh', verified: true, lookbackMissing: [] })),
  };
  const repo = { getKeysArtifact: overrides.getKeysArtifact ?? jest.fn(() => Promise.resolve(null)) };
  const lock = new BenchmarkRunLock();
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'benchmark.keysBackfillDayTimeoutMs') return 60_000;
      if (key === 'benchmark.keysBackfillRetryDelaysMs') return [10, 20];
      return undefined;
    }),
  } as unknown as ConfigService;

  const service = new KeysBackfillService(
    inputs as never,
    dayArtifacts as never,
    sevenKeys as never,
    repo as never,
    lock,
    config,
  );
  const seams = service as never as { sleep: (ms: number) => Promise<void>; loopPromise: Promise<void> };
  const sleep = jest.spyOn(seams, 'sleep').mockResolvedValue(undefined);
  return { service, inputs, dayArtifacts, sevenKeys, repo, lock, sleep };
}

/** Await the detached loop. */
async function settle(service: KeysBackfillService): Promise<void> {
  await (service as never as { loopPromise: Promise<void> }).loopPromise;
}

const daysPassedTo = (m: jest.Mock) => m.mock.calls.map((c: unknown[]) => (c[0] as DayListing).day);

describe('KeysBackfillService', () => {
  it('generates every day oldest-first and finishes done', async () => {
    const { service, sevenKeys } = build();
    service.start({});
    await settle(service);

    expect(daysPassedTo(sevenKeys.ensureKeys)).toEqual(['01022025', '01032025', '01062025']);
    const job = service.status()!;
    expect(job.state).toBe('done');
    expect(job.counts).toMatchObject({ candidates: 3, processed: 3, generated: 3, reused: 0, failed: 0 });
    expect(job.flagshipAlias).toBe('k3');
    expect(job.from).toBe('01022025');
    expect(job.to).toBe('01062025');
    expect(job.reducedLookback).toEqual([]);
  });

  it('reuses a verified artifact with empty lookbackMissing without loading the day', async () => {
    const getKeysArtifact = jest.fn((day: string) =>
      Promise.resolve(day === '01032025' ? { contentHash: 'kh', verified: true, lookbackMissing: [] } : null),
    );
    const { service, sevenKeys, inputs } = build({ getKeysArtifact });
    service.start({});
    await settle(service);

    expect(daysPassedTo(sevenKeys.ensureKeys)).toEqual(['01022025', '01062025']);
    expect(inputs.loadDay).toHaveBeenCalledTimes(2);
    expect(service.status()!.counts).toMatchObject({ generated: 2, reused: 1, processed: 3 });
  });

  it('REGENERATES a verified artifact that has a non-empty lookbackMissing', async () => {
    const getKeysArtifact = jest.fn(() =>
      Promise.resolve({ contentHash: 'kh', verified: true, lookbackMissing: ['01012025'] }),
    );
    const { service, sevenKeys } = build({ getKeysArtifact });
    service.start({});
    await settle(service);

    expect(sevenKeys.ensureKeys).toHaveBeenCalledTimes(3);
    expect(service.status()!.counts).toMatchObject({ generated: 3, reused: 0 });
  });

  it('records a generated day that still has reduced lookback', async () => {
    const ensureKeys = jest.fn(() => Promise.resolve({ contentHash: 'kh', verified: true, lookbackMissing: ['12312024'] }));
    const { service } = build({ days: [listing('01022025', '2025-01-02')], ensureKeys });
    service.start({});
    await settle(service);

    expect(service.status()!.reducedLookback).toEqual([{ day: '01022025', missing: ['12312024'] }]);
    expect(service.status()!.state).toBe('done');
  });

  it('honours a from/to window when the priors already have KEYS', async () => {
    const getKeysArtifact = jest.fn((day: string) =>
      Promise.resolve(day === '01022025' ? { contentHash: 'kh', verified: true, lookbackMissing: [] } : null),
    );
    const { service, sevenKeys } = build({ getKeysArtifact });
    service.start({ from: '01032025', to: '01032025' });
    await settle(service);

    expect(daysPassedTo(sevenKeys.ensureKeys)).toEqual(['01032025']);
    expect(service.status()!.counts.candidates).toBe(1);
  });

  it('refuses a from whose priors have no KEYS', async () => {
    const { service, sevenKeys } = build();
    service.start({ from: '01062025' });
    await settle(service);

    const job = service.status()!;
    expect(job.state).toBe('failed');
    expect(job.error).toContain('01022025');
    expect(job.error).toContain('01032025');
    expect(sevenKeys.ensureKeys).not.toHaveBeenCalled();
  });

  it('never passes force to ensureKeys', async () => {
    const { service, sevenKeys } = build();
    service.start({});
    await settle(service);
    for (const call of sevenKeys.ensureKeys.mock.calls) {
      expect((call[2] as { force?: boolean } | undefined)?.force).toBeFalsy();
    }
  });

  it('holds the lock while running and releases it when done', async () => {
    const { service, lock } = build();
    service.start({});
    expect(lock.heldBy).toBe('keys-backfill');
    await settle(service);
    expect(lock.heldBy).toBeNull();
  });

  it('throws when the lock is held and creates no job', () => {
    const { service, lock } = build();
    lock.acquire('benchmark-run');
    expect(() => service.start({})).toThrow('a benchmark run is already in progress');
    expect(service.status()).toBeNull();
  });

  it('fails the job when the corpus scan throws, and releases the lock', async () => {
    const { service, inputs, lock } = build();
    inputs.snapshot.mockRejectedValueOnce(new Error('bucket down'));
    service.start({});
    await settle(service);
    expect(service.status()!.state).toBe('failed');
    expect(service.status()!.error).toContain('bucket down');
    expect(lock.heldBy).toBeNull();
  });

  it('fails the job when the corpus scan returns zero days', async () => {
    const { service } = build({ days: [] });
    service.start({});
    await settle(service);
    expect(service.status()!.state).toBe('failed');
    expect(service.status()!.error).toMatch(/no committed days/i);
  });

  it('fails the job when the methods doc is missing', async () => {
    const { service } = build({ methodsDoc: null });
    service.start({});
    await settle(service);
    expect(service.status()!.state).toBe('failed');
    expect(service.status()!.error).toMatch(/methods doc/i);
  });

  it('status is null before the first start', () => {
    expect(build().service.status()).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/benchmark/keys-backfill.service.spec.ts`
Expected: FAIL — `Cannot find module './keys-backfill.service'`

- [ ] **Step 3: Write minimal implementation**

Create `backend/src/benchmark/keys-backfill.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
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

/**
 * Corpus-wide seven-keys generation, strictly sequential and oldest-first so
 * every day's lookback analyst sees three finalized prior assessments. The job
 * object is in-memory and disposable — durable state is the KEYS artifacts, so
 * resume is just a re-POST and already-built days short-circuit on one read.
 */
@Injectable()
export class KeysBackfillService {
  private readonly logger = new Logger(KeysBackfillService.name);
  private job: KeysBackfillSnapshot | null = null;
  private cancelRequested = false;
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

      const all = [...snap.days].sort((a, b) => a.date.localeCompare(b.date));
      const inRange = all.filter((d) => this.inWindow(d, opts));
      job.counts.candidates = inRange.length;
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
        const outcome = await this.runDay(job, l, snap);
        job.currentDay = null;
        if (outcome === 'cancelled') {
          job.state = 'cancelled';
          break;
        }
        job.counts.processed += 1;
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
      if (!doc?.verified) missing.push(p.day);
    }
    if (missing.length) {
      throw new Error(
        `refusing to start at ${first.day}: prior day(s) ${missing.join(', ')} have no KEYS for lineage ${job.flagshipAlias}, so the window's first days would be generated with reduced lookback. Omit "from" to build the whole corpus.`,
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
    const existing = await this.repo.getKeysArtifact(l.day, job.flagshipAlias);
    if (existing?.verified && !existing.lookbackMissing?.length) {
      job.counts.reused += 1;
      return 'reused';
    }
    if (existing?.verified) {
      this.logger.log(
        `keys-backfill ${l.day}: stored artifact has reduced lookback (${existing.lookbackMissing!.join(', ')}) — regenerating`,
      );
    }
    const doc = await this.generateDay(l, snap, () => undefined);
    if (doc) {
      job.counts.generated += 1;
      this.recordReducedLookback(job, l.day, doc);
      return 'generated';
    }
    job.counts.failed += 1;
    job.failures.push({ day: l.day, attempts: 1, kind: 'error', message: 'generation failed', mismatches: [] });
    return 'failed';
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
  ): Promise<DayArtifactDoc | null> {
    const dayInput = await this.inputs.loadDay(l);
    await this.dayArtifacts.ensureDayRecorded(dayInput);
    return this.sevenKeys.ensureKeys(dayInput, snap, { onFailure });
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/benchmark/keys-backfill.service.spec.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/benchmark/keys-backfill.service.ts backend/src/benchmark/keys-backfill.service.spec.ts
git commit -m "feat(benchmark): sequential keys backfill loop with preflights"
```

---

### Task 5: Retry, backoff, classification, and fail-fast

**Files:**
- Modify: `backend/src/benchmark/keys-backfill.service.ts` (`runDay`, timeout helper)
- Modify: `backend/src/benchmark/keys-backfill.service.spec.ts`

**Interfaces:**
- Consumes: `runDay` and `generateDay` from Task 4.
- Produces: `class KeysBackfillDayTimeoutError extends Error`; `runDay` retries with backoff and records a classified `KeysBackfillFailure`.

Three rules, all load-bearing:
1. Classification comes from the `onFailure` callback — never from a `catch` around `ensureKeys`, which does not throw.
2. `refused` and `timeout` are **non-retryable**. Retrying a timeout would leave the abandoned `ensureKeys` chain racing `saveKeysArtifact` against the new attempt.
3. The timeout wraps the **whole attempt body**, so a hung GCS socket cannot park the loop forever.

- [ ] **Step 1: Write the failing test**

Append inside the `describe`:

```ts
  it('retries a failed day with backoff and continues to the next day on success', async () => {
    let calls = 0;
    const ensureKeys = jest.fn((_d: unknown, _s: unknown, opts: { onFailure: (f: unknown) => void }) => {
      calls += 1;
      if (calls <= 2) {
        opts.onFailure({ kind: 'unverified', message: `attempt ${calls}`, mismatches: [`m${calls}`] });
        return Promise.resolve(null);
      }
      return Promise.resolve({ contentHash: 'kh', verified: true, lookbackMissing: [] });
    });
    const { service, sleep } = build({
      days: [listing('01022025', '2025-01-02'), listing('01032025', '2025-01-03')],
      ensureKeys,
    });
    service.start({});
    await settle(service);

    const job = service.status()!;
    expect(sleep).toHaveBeenCalledTimes(2); // backoff before attempts 2 and 3
    expect(daysPassedTo(ensureKeys)).toEqual(['01022025', '01022025', '01022025', '01032025']);
    expect(job.state).toBe('done');
    expect(job.counts).toMatchObject({ generated: 2, failed: 0, processed: 2 });
    expect(job.failures).toEqual([]);
  });

  it('stops the whole job after three failed attempts and records diagnostics', async () => {
    const ensureKeys = jest.fn((_d: unknown, _s: unknown, opts: { onFailure: (f: unknown) => void }) => {
      opts.onFailure({ kind: 'unverified', message: 'verifier rejected the artifact: side mismatch', mismatches: ['5777.75-5781.75: side mismatch'] });
      return Promise.resolve(null);
    });
    const { service } = build({ ensureKeys });
    service.start({});
    await settle(service);

    const job = service.status()!;
    expect(ensureKeys).toHaveBeenCalledTimes(3); // first day only — day 2 never attempted
    expect(job.state).toBe('failed');
    expect(job.counts.failed).toBe(1);
    expect(job.error).toContain('01022025');
    expect(job.failures[0]).toMatchObject({
      day: '01022025',
      attempts: 3,
      kind: 'unverified',
      mismatches: ['5777.75-5781.75: side mismatch'],
    });
  });

  it('classifies a generation error as kind "error", not unverified', async () => {
    const ensureKeys = jest.fn((_d: unknown, _s: unknown, opts: { onFailure: (f: unknown) => void }) => {
      opts.onFailure({ kind: 'error', message: 'moonshot 529 rate limited', mismatches: [] });
      return Promise.resolve(null);
    });
    const { service } = build({ ensureKeys });
    service.start({});
    await settle(service);

    const job = service.status()!;
    expect(ensureKeys).toHaveBeenCalledTimes(3);
    expect(job.failures[0]).toMatchObject({ kind: 'error', attempts: 3 });
    expect(job.failures[0].message).toContain('moonshot 529');
  });

  it('does NOT retry a refused pin anomaly', async () => {
    const ensureKeys = jest.fn((_d: unknown, _s: unknown, opts: { onFailure: (f: unknown) => void }) => {
      opts.onFailure({ kind: 'refused', message: 'pinned KEYS hash matches no stored artifact', mismatches: [] });
      return Promise.resolve(null);
    });
    const { service, sleep } = build({ ensureKeys });
    service.start({});
    await settle(service);

    const job = service.status()!;
    expect(ensureKeys).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(job.state).toBe('failed');
    expect(job.failures[0]).toMatchObject({ kind: 'refused', attempts: 1 });
  });

  it('does NOT retry a per-day timeout, and stops the job', async () => {
    jest.useFakeTimers();
    try {
      const ensureKeys = jest.fn(() => new Promise(() => undefined));
      const { service } = build({ days: [listing('01022025', '2025-01-02')], ensureKeys });
      service.start({});
      await jest.advanceTimersByTimeAsync(60_001);
      await settle(service);

      const job = service.status()!;
      expect(ensureKeys).toHaveBeenCalledTimes(1);
      expect(job.state).toBe('failed');
      expect(job.failures[0]).toMatchObject({ kind: 'timeout', attempts: 1 });
      expect(job.failures[0].message).toMatch(/timeout/i);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops immediately when the corpus changed under the snapshot', async () => {
    const loadDay = jest.fn(() => Promise.reject(new Error('day 01022025 changed since the run snapshot (tradePlanPdf no longer match)')));
    const { service } = build({ loadDay });
    service.start({});
    await settle(service);

    const job = service.status()!;
    expect(job.state).toBe('failed');
    expect(job.failures[0].attempts).toBe(1);
    expect(job.failures[0].message).toMatch(/re-POST to re-snapshot/i);
  });

  it('retries a transient Firestore error on the classification read', async () => {
    let reads = 0;
    const getKeysArtifact = jest.fn(() => {
      reads += 1;
      if (reads === 1) return Promise.reject(new Error('DEADLINE_EXCEEDED'));
      return Promise.resolve(null);
    });
    const { service } = build({ days: [listing('01022025', '2025-01-02')], getKeysArtifact });
    service.start({});
    await settle(service);

    expect(service.status()!.state).toBe('done');
    expect(service.status()!.counts.generated).toBe(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/benchmark/keys-backfill.service.spec.ts`
Expected: FAIL — `ensureKeys` called once where 3 expected; `attempts` always 1; no `timeout` kind.

- [ ] **Step 3: Write minimal implementation**

Add above the class in `keys-backfill.service.ts`:

```ts
export class KeysBackfillDayTimeoutError extends Error {
  constructor(day: string, ms: number) {
    super(`day ${day} exceeded the ${ms}ms keys-backfill day timeout`);
  }
}

/** loadDay/outcomeRecapForDay throw this wording when the corpus moved under us. */
const SNAPSHOT_MISMATCH = /changed since the run snapshot/;
```

Replace `runDay` wholesale:

```ts
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
        if (existing?.verified) {
          this.logger.log(
            `keys-backfill ${l.day}: stored artifact has reduced lookback (${existing.lookbackMissing!.join(', ')}) — regenerating`,
          );
        }
        const doc = await this.withDayTimeout(
          this.generateDay(l, snap, (f) => reported.push(f)),
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/benchmark/keys-backfill.service.spec.ts`
Expected: PASS (20 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/benchmark/keys-backfill.service.ts backend/src/benchmark/keys-backfill.service.spec.ts
git commit -m "feat(benchmark): classified retries with backoff and fail-fast"
```

---

### Task 6: Cancellation, shutdown, and progress

**Files:**
- Modify: `backend/src/benchmark/keys-backfill.service.ts`, `backend/src/benchmark/keys-backfill.service.spec.ts`

**Interfaces:**
- Consumes: the loop from Tasks 4-5.
- Produces: `KeysBackfillService implements OnModuleDestroy, OnApplicationShutdown`; `progress` populated from **generated days only**.

- [ ] **Step 1: Write the failing test**

```ts
  it('cancel lets the in-flight day finish, then stops before the next day', async () => {
    const seen: string[] = [];
    let svc: KeysBackfillService;
    const ensureKeys = jest.fn((d: { day: string }) => {
      seen.push(d.day);
      svc.cancel();
      return Promise.resolve({ contentHash: 'kh', verified: true, lookbackMissing: [] });
    });
    const built = build({ ensureKeys });
    svc = built.service;
    svc.start({});
    await settle(svc);

    const job = svc.status()!;
    expect(seen).toEqual(['01022025']);
    expect(job.state).toBe('cancelled');
    expect(job.cancelRequested).toBe(true);
    expect(job.counts.generated).toBe(1);
    expect(built.lock.heldBy).toBeNull();
  });

  it('cancel before any job exists returns null', () => {
    expect(build().service.cancel()).toBeNull();
  });

  it('shutdown hooks request cancellation', async () => {
    const { service } = build();
    service.start({});
    service.onApplicationShutdown();
    expect(service.status()!.cancelRequested).toBe(true);
    await settle(service);
    expect(service.status()!.state).toBe('cancelled');
  });

  it('reports avgSecondsPerDay from generated days and an eta', async () => {
    const { service } = build();
    let clock = Date.parse('2026-08-16T00:00:00.000Z');
    jest
      .spyOn(service as never as { nowMs: () => number }, 'nowMs')
      .mockImplementation(() => (clock += 10_000));
    service.start({});
    await settle(service);

    const job = service.status()!;
    expect(job.progress.avgSecondsPerDay).toBe(10);
    expect(job.progress.etaIso).not.toBeNull();
  });

  it('leaves progress null when every day was reused', async () => {
    const getKeysArtifact = jest.fn(() => Promise.resolve({ contentHash: 'kh', verified: true, lookbackMissing: [] }));
    const { service } = build({ getKeysArtifact });
    service.start({});
    await settle(service);
    expect(service.status()!.progress.avgSecondsPerDay).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/benchmark/keys-backfill.service.spec.ts`
Expected: FAIL — `service.onApplicationShutdown is not a function`; `avgSecondsPerDay` stays `null`.

- [ ] **Step 3: Write minimal implementation**

Change the imports and class declaration:

```ts
import { Injectable, Logger, OnApplicationShutdown, OnModuleDestroy } from '@nestjs/common';
```

```ts
export class KeysBackfillService implements OnModuleDestroy, OnApplicationShutdown {
```

Add a field beside `cancelRequested`:

```ts
  /** Seconds per GENERATED day, most recent PROGRESS_WINDOW entries. */
  private generatedDurations: number[] = [];
```

and the constant beside `MAX_DAY_ATTEMPTS`:

```ts
const PROGRESS_WINDOW = 10;
```

Reset it in `start()` next to `this.cancelRequested = false;`:

```ts
    this.generatedDurations = [];
```

Add the hooks and progress helpers:

```ts
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
```

In `runLoop`'s day loop, time each day and update after each completed one:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/benchmark/keys-backfill.service.spec.ts`
Expected: PASS (25 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/benchmark/keys-backfill.service.ts backend/src/benchmark/keys-backfill.service.spec.ts
git commit -m "feat(benchmark): keys backfill cancellation, shutdown hooks, progress"
```

---

### Task 7: HTTP routes, module wiring, config

**Files:**
- Modify: `backend/src/eminiplayer/eminiplayer-validation.ts` (export `isValidMmddyyyy`)
- Modify: `backend/src/eminiplayer/eminiplayer.controller.ts:29-39` (delete the local copy; merge the import)
- Modify: `backend/src/benchmark/benchmark.controller.ts`, `backend/src/benchmark/benchmark.controller.spec.ts`
- Modify: `backend/src/benchmark/benchmark.module.ts`
- Modify: `backend/src/config/configuration.ts` (**interface and literal**)

**Interfaces:**
- Consumes: `KeysBackfillService` (T4-6), `LockHeldError` (T1).
- Produces: `POST /benchmark/keys-backfill` (202), `GET`, `DELETE`; config `benchmark.keysBackfillDayTimeoutMs` (env `BENCHMARK_KEYS_DAY_TIMEOUT_MS`, default 900000) and `benchmark.keysBackfillRetryDelaysMs` (env `BENCHMARK_KEYS_RETRY_DELAYS_MS`, comma-separated, default `30000,180000`).

- [ ] **Step 1: Write the failing test**

`benchmark.controller.spec.ts` builds via `Test.createTestingModule`. Extend its imports:

```ts
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { KeysBackfillService } from './keys-backfill.service';
import { LockHeldError } from './run-lock';
```

Add a fake to the existing `build()` — declare it beside the others and register it, and return it:

```ts
  const keysBackfill = {
    start: jest.fn().mockReturnValue({ state: 'running', from: null, to: null }),
    status: jest.fn().mockReturnValue({ state: 'running', startedAt: 'T0' }),
    cancel: jest.fn().mockReturnValue({ state: 'cancelled', startedAt: 'T0' }),
  };
  // …in providers:
      { provide: KeysBackfillService, useValue: keysBackfill },
  // …in the return object:
  return { ctrl: moduleRef.get(BenchmarkController), service, scoreboard, repo, config, samples, keysBackfill };
```

Then append a new describe block:

```ts
describe('BenchmarkController keys-backfill', () => {
  it('POST requires confirm=true', async () => {
    const { ctrl, keysBackfill } = await build();
    expect(() => ctrl.startKeysBackfill(undefined, undefined, undefined)).toThrow(BadRequestException);
    expect(keysBackfill.start).not.toHaveBeenCalled();
  });

  it('POST starts the job and returns its snapshot', async () => {
    const { ctrl, keysBackfill } = await build();
    const res = ctrl.startKeysBackfill('true', undefined, undefined);
    expect(keysBackfill.start).toHaveBeenCalledWith({ from: undefined, to: undefined });
    expect(res.state).toBe('running');
  });

  it('POST rejects a malformed date and a reversed range', async () => {
    const { ctrl } = await build();
    expect(() => ctrl.startKeysBackfill('true', '2025-01-02', undefined)).toThrow(BadRequestException);
    expect(() => ctrl.startKeysBackfill('true', '01062025', '01022025')).toThrow(BadRequestException);
  });

  it('POST maps a held lock to 409', async () => {
    const { ctrl, keysBackfill } = await build();
    keysBackfill.start.mockImplementation(() => {
      throw new LockHeldError('benchmark-run');
    });
    expect(() => ctrl.startKeysBackfill('true', undefined, undefined)).toThrow(ConflictException);
  });

  it('GET 404s when no job has run', async () => {
    const { ctrl, keysBackfill } = await build();
    keysBackfill.status.mockReturnValue(null);
    expect(() => ctrl.keysBackfillStatus()).toThrow(NotFoundException);
  });

  it('DELETE requires a matching startedAt', async () => {
    const { ctrl } = await build();
    expect(() => ctrl.cancelKeysBackfill('wrong')).toThrow(ConflictException);
  });

  it('DELETE cancels when startedAt matches', async () => {
    const { ctrl, keysBackfill } = await build();
    const res = ctrl.cancelKeysBackfill('T0');
    expect(keysBackfill.cancel).toHaveBeenCalled();
    expect(res.state).toBe('cancelled');
  });

  it('DELETE 404s when no job has run', async () => {
    const { ctrl, keysBackfill } = await build();
    keysBackfill.status.mockReturnValue(null);
    expect(() => ctrl.cancelKeysBackfill('T0')).toThrow(NotFoundException);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/benchmark/benchmark.controller.spec.ts`
Expected: FAIL — `ctrl.startKeysBackfill is not a function`

- [ ] **Step 3: Export the date validator**

Move the validator into `eminiplayer-validation.ts` and export it:

```ts
/** MMDDYYYY, and a real calendar date (rejects 13012026 and 02302026). */
export function isValidMmddyyyy(date: string): boolean {
  if (!/^\d{8}$/.test(date)) return false;
  const mm = Number(date.slice(0, 2));
  const dd = Number(date.slice(2, 4));
  const yyyy = Number(date.slice(4));
  const parsed = new Date(Date.UTC(yyyy, mm - 1, dd));
  return parsed.getUTCFullYear() === yyyy && parsed.getUTCMonth() === mm - 1 && parsed.getUTCDate() === dd;
}
```

In `eminiplayer.controller.ts`, delete the local copy at **lines 29-39** (the jsdoc through the closing brace — deleting only 29-36 leaves a dangling expression and a syntax error) and add `isValidMmddyyyy` to the **existing** `eminiplayer-validation` import on line 27 rather than adding a second import statement.

- [ ] **Step 4: Add the routes**

In `benchmark.controller.ts` extend the `@nestjs/common` import with `BadRequestException, Delete, HttpCode`, and add:

```ts
import { KeysBackfillService, KeysBackfillSnapshot } from './keys-backfill.service';
import { LockHeldError } from './run-lock';
import { isValidMmddyyyy, parseMmddyyyy } from '../eminiplayer/eminiplayer-validation';
```

Append `private readonly keysBackfill: KeysBackfillService,` to the constructor, then:

```ts
  /**
   * Corpus-wide seven-keys generation: sequential, oldest-first, so every day
   * gets a full 3-day lookback. Omit from/to to build the whole committed
   * corpus. Detached — poll GET; expect 20-40 hours for a cold corpus.
   */
  @Post('keys-backfill')
  @HttpCode(202)
  startKeysBackfill(
    @Query('confirm') confirm: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
  ): KeysBackfillSnapshot {
    // A bare POST commits ~$130 and 40 hours; the already-running 409 only
    // guards a SECOND start, not the first accidental one.
    if (confirm !== 'true') {
      throw new BadRequestException('confirm=true is required — this starts a ~$130, 20-40 hour job');
    }
    for (const [name, value] of [['from', from], ['to', to]] as const) {
      if (value !== undefined && !isValidMmddyyyy(value)) {
        throw new BadRequestException(`Query param "${name}" must be MMDDYYYY when present`);
      }
    }
    if (from && to && parseMmddyyyy(from).getTime() > parseMmddyyyy(to).getTime()) {
      throw new BadRequestException('"from" must be on or before "to"');
    }
    try {
      return this.keysBackfill.start({ from, to });
    } catch (err) {
      if (err instanceof LockHeldError) {
        throw new ConflictException({ message: err.message, holder: err.holder });
      }
      throw err;
    }
  }

  @Get('keys-backfill')
  keysBackfillStatus(): KeysBackfillSnapshot {
    const job = this.keysBackfill.status();
    if (!job) throw new NotFoundException('no keys-backfill job has run since boot');
    return job;
  }

  /** startedAt must match, so a stale tab or blind curl cannot kill a 29-hour run. */
  @Delete('keys-backfill')
  cancelKeysBackfill(@Query('startedAt') startedAt: string | undefined): KeysBackfillSnapshot {
    const job = this.keysBackfill.status();
    if (!job) throw new NotFoundException('no keys-backfill job has run since boot');
    if (startedAt !== job.startedAt) {
      throw new ConflictException(`startedAt does not match the current job (${job.startedAt}) — pass ?startedAt=<that value> to confirm`);
    }
    return this.keysBackfill.cancel() as KeysBackfillSnapshot;
  }
```

- [ ] **Step 5: Wire the module**

In `benchmark.module.ts` import `KeysBackfillService` and add it to **`providers` and `exports`**. `BenchmarkController` is declared in `app.module.ts`, not here, so it resolves its dependencies only through this module's `exports` — a provider-only registration compiles, passes every test, and then fails at `pnpm start` with an unresolved-dependency error.

- [ ] **Step 6: Add config — interface AND literal**

`configuration.ts` declares an explicit `AppConfig` interface with `export default (): AppConfig => ({...})`, so adding a key to the literal alone is TS2353 and breaks the build. Add to the `benchmark` block of the **interface**:

```ts
    keysBackfillDayTimeoutMs: number;
    keysBackfillRetryDelaysMs: number[];
```

and to the literal, after `grading`:

```ts
    // Ceiling for one day's whole attempt (loadDay + record + seven-keys).
    // A day is 4-6 LLM calls at high effort, ~3.5 min of model time.
    keysBackfillDayTimeoutMs: parseInt(process.env.BENCHMARK_KEYS_DAY_TIMEOUT_MS ?? '900000', 10),
    // Backoff before retry attempts 2 and 3. Without it, SevenKeysService's own
    // withRetry means ~9 immediate provider calls, so any brief rate-limit
    // window would end a 40-hour run.
    keysBackfillRetryDelaysMs: (process.env.BENCHMARK_KEYS_RETRY_DELAYS_MS ?? '30000,180000')
      .split(',')
      .map((v) => parseInt(v.trim(), 10))
      .filter((v) => Number.isFinite(v)),
```

- [ ] **Step 7: Run the full suite**

Run: `npx jest`
Expected: PASS — all suites, including eminiplayer after the validator move.

- [ ] **Step 8: Verify the app actually boots**

Run: `pnpm build && timeout 25 node dist/main.js 2>&1 | tail -20`
Expected: `Nest application successfully started`, with `{/benchmark/keys-backfill, POST|GET|DELETE}` among the mapped routes. This step exists because the module-exports defect is invisible to jest.

- [ ] **Step 9: Commit**

```bash
git add backend/src/benchmark/benchmark.controller.ts backend/src/benchmark/benchmark.controller.spec.ts backend/src/benchmark/benchmark.module.ts backend/src/config/configuration.ts backend/src/eminiplayer/eminiplayer-validation.ts backend/src/eminiplayer/eminiplayer.controller.ts
git commit -m "feat(benchmark): keys-backfill endpoints"
```

---

### Task 8: One-time era reset

**Files:**
- Create: `backend/src/benchmark/keys-era-reset.ts`, `backend/src/benchmark/keys-era-reset.spec.ts`, `backend/scripts/reset-keys-era.mjs`

**Interfaces:**
- Consumes: `resolveModel` from `./benchmark.types`.
- Produces: `planKeysEraReset(artifacts: EraArtifact[], cells: EraCell[], lineageAlias: string): EraResetPlan`, where `EraArtifact = { id: string; contentHash?: string | null; generatedBy?: string | null }`, `EraCell = { id: string; artifactSha256?: string | null }`, `EraResetPlan = { artifactIdsToDelete: string[]; cellIdsToDelete: string[]; keptCellCount: number }`.

Cells are selected by **hash membership**, not by "has an `artifactSha256`" — that field is the KEYS hash for scorecard cells of *any* lineage, so the loose filter would irreversibly delete another provider's scoreboard.

- [ ] **Step 1: Write the failing test**

Create `backend/src/benchmark/keys-era-reset.spec.ts`:

```ts
import { planKeysEraReset } from './keys-era-reset';

const artifacts = [
  { id: '01062025__keys__k3', contentHash: 'h-k3-a' },
  { id: '08032026__keys__k3', contentHash: 'h-k3-b' },
  { id: '08032026__pdfFile', contentHash: 'h-pdf' },
  { id: '07012026__keys__fable', contentHash: 'h-fable' },
  { id: '05052025__keys', contentHash: 'h-legacy-k3', generatedBy: 'kimi-k3' },
  { id: '05062025__keys', contentHash: 'h-legacy-fable', generatedBy: 'claude-fable-5' },
];

describe('planKeysEraReset', () => {
  it("deletes this lineage's scoped artifacts and its legacy unscoped docs only", () => {
    const plan = planKeysEraReset(artifacts, [], 'k3');
    expect(plan.artifactIdsToDelete).toEqual(['01062025__keys__k3', '08032026__keys__k3', '05052025__keys']);
  });

  it('deletes only cells pinning a hash of a deleted artifact', () => {
    const cells = [
      { id: 'c-k3-a', artifactSha256: 'h-k3-a' },
      { id: 'c-fable', artifactSha256: 'h-fable' },
      { id: 'c-base', artifactSha256: null },
      { id: 'c-method' },
      { id: 'c-legacy', artifactSha256: 'h-legacy-k3' },
    ];
    const plan = planKeysEraReset(artifacts, cells, 'k3');
    expect(plan.cellIdsToDelete).toEqual(['c-k3-a', 'c-legacy']);
    expect(plan.keptCellCount).toBe(3); // fable + base + method survive
  });

  it('is a no-op on an already-clean era', () => {
    const plan = planKeysEraReset([{ id: '08032026__pdfFile' }], [{ id: 'c1' }], 'k3');
    expect(plan).toEqual({ artifactIdsToDelete: [], cellIdsToDelete: [], keptCellCount: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/benchmark/keys-era-reset.spec.ts`
Expected: FAIL — `Cannot find module './keys-era-reset'`

- [ ] **Step 3: Write minimal implementation**

Create `backend/src/benchmark/keys-era-reset.ts`:

```ts
import { resolveModel } from './benchmark.types';

export interface EraArtifact {
  id: string;
  contentHash?: string | null;
  generatedBy?: string | null;
}

export interface EraCell {
  id: string;
  artifactSha256?: string | null;
}

export interface EraResetPlan {
  artifactIdsToDelete: string[];
  cellIdsToDelete: string[];
  keptCellCount: number;
}

const LEGACY_KEYS_ID = /^\d{8}__keys$/;

/**
 * A one-time reset so the corpus can be rebuilt in strict order.
 *
 * Deleting KEYS artifacts alone WEDGES those days: ensureKeys refuses to
 * generate when cells pin a hash matching no stored artifact ("possible deleted
 * artifact"), so the pinning cells must go too. Cells are matched by HASH
 * MEMBERSHIP, not by merely carrying an artifactSha256 — that field is the KEYS
 * hash for scorecard cells of any lineage, and the loose filter would delete
 * another provider's scoreboard irreversibly.
 *
 * Legacy unscoped `${day}__keys` docs are included when their generatedBy
 * resolves to this lineage: getKeysArtifact falls back to them, so a survivor
 * would be seen by the backfill's reuse pre-check and silently skip the day.
 */
export function planKeysEraReset(
  artifacts: EraArtifact[],
  cells: EraCell[],
  lineageAlias: string,
): EraResetPlan {
  const suffix = `__keys__${lineageAlias}`;
  const doomed = artifacts.filter(
    (a) =>
      a.id.endsWith(suffix) ||
      (LEGACY_KEYS_ID.test(a.id) && resolveModel(a.generatedBy ?? 'claude-fable-5').alias === lineageAlias),
  );
  const hashes = new Set(doomed.map((a) => a.contentHash).filter((h): h is string => Boolean(h)));
  const cellIdsToDelete = cells
    .filter((c) => c.artifactSha256 && hashes.has(c.artifactSha256))
    .map((c) => c.id);
  return {
    artifactIdsToDelete: doomed.map((a) => a.id),
    cellIdsToDelete,
    keptCellCount: cells.length - cellIdsToDelete.length,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/benchmark/keys-era-reset.spec.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the runner script**

Create `backend/scripts/reset-keys-era.mjs`:

```js
// Usage (from backend/, after `pnpm build`):  node scripts/reset-keys-era.mjs [--apply]
// Deletes this lineage's KEYS artifacts AND the cells pinning them, so the
// corpus can be regenerated in strict chronological order.
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { planKeysEraReset } from '../dist/benchmark/keys-era-reset.js';

const apply = process.argv.includes('--apply');
const lineage = process.env.KEYS_LINEAGE ?? 'k3';
const NON_TERMINAL = ['created', 'submitted', 'in_progress', 'ended'];

initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID ?? 'app-foster-bridge' });
const db = getFirestore();

// The in-memory BenchmarkRunLock is invisible from this process, so the
// enforceable precondition is the batch check: if a batch is still unreconciled,
// BatchReconciler's cron will re-write pins for the artifacts we just deleted
// within a minute and wedge those days permanently.
const batches = await db.collection('benchmarkBatches').where('status', 'in', NON_TERMINAL).get();
if (!batches.empty) {
  console.error(`ABORT: ${batches.size} non-terminal batch(es) exist. Let them reconcile first —`);
  console.error('otherwise the reconciler re-creates pins for deleted artifacts and wedges those days.');
  process.exit(1);
}

const [artifactSnap, cellSnap] = await Promise.all([
  db.collection('dayArtifacts').get(),
  db.collection('benchmarkRuns').get(),
]);

const plan = planKeysEraReset(
  artifactSnap.docs.map((d) => ({ id: d.id, contentHash: d.data().contentHash ?? null, generatedBy: d.data().generatedBy ?? null })),
  cellSnap.docs.map((d) => ({ id: d.id, artifactSha256: d.data().artifactSha256 ?? null })),
  lineage,
);

console.log(`lineage:                  ${lineage}`);
console.log(`KEYS artifacts to delete: ${plan.artifactIdsToDelete.length}`);
console.log(`pinning cells to delete:  ${plan.cellIdsToDelete.length}`);
console.log(`cells kept (pin nothing or another lineage): ${plan.keptCellCount}`);

if (!apply) {
  console.log('\nDRY RUN — re-run with --apply to execute.');
  process.exit(0);
}

let batch = db.batch();
let queued = 0;
const flush = async () => {
  await batch.commit();
  batch = db.batch();
  queued = 0;
};
for (const id of plan.cellIdsToDelete) {
  batch.delete(db.collection('benchmarkRuns').doc(id));
  if (++queued === 400) await flush(); // Firestore caps a batch at 500
}
for (const id of plan.artifactIdsToDelete) {
  batch.delete(db.collection('dayArtifacts').doc(id));
  if (++queued === 400) await flush();
}
if (queued) await flush();

// Real post-conditions: (a) no surviving KEYS doc for this lineage, and (b) no
// surviving cell pinning a hash that no surviving artifact carries. Counting
// "cells that still have an artifactSha256" would be tautological.
const [afterArtifacts, afterCells] = await Promise.all([
  db.collection('dayArtifacts').get(),
  db.collection('benchmarkRuns').get(),
]);
const survivingHashes = new Set(afterArtifacts.docs.map((d) => d.data().contentHash).filter(Boolean));
const stillLineage = afterArtifacts.docs.filter((d) => d.id.endsWith(`__keys__${lineage}`)).length;
const dangling = afterCells.docs.filter((d) => {
  const h = d.data().artifactSha256;
  return h && !survivingHashes.has(h);
}).length;

console.log(`\nDone. Surviving ${lineage} KEYS docs: ${stillLineage} (must be 0).`);
console.log(`Cells pinning a missing artifact: ${dangling} (must be 0).`);
process.exit(stillLineage === 0 && dangling === 0 ? 0 : 1);
```

- [ ] **Step 6: Verify the dry run against real data**

Run from `backend/`:

```bash
pnpm build && node scripts/reset-keys-era.mjs
```

Expected: aborts if any batch is non-terminal; otherwise reports 11 KEYS artifacts and 101 pinning cells to delete, 200 cells kept, and exits without writing. Do **not** pass `--apply` — that is an operational step for when the build actually starts.

- [ ] **Step 7: Commit**

```bash
git add backend/src/benchmark/keys-era-reset.ts backend/src/benchmark/keys-era-reset.spec.ts backend/scripts/reset-keys-era.mjs
git commit -m "feat(benchmark): one-time keys era reset"
```

---

### Task 9: Document the endpoints

**Files:**
- Modify: `CLAUDE.md` (Benchmark section)

- [ ] **Step 1: Add the endpoint block**

In `CLAUDE.md`, in the Benchmark section after the samples block, add:

````markdown
Corpus-wide KEYS generation — build the lookback chain before benchmarking:

```
POST   /benchmark/keys-backfill?confirm=true&from=MMDDYYYY&to=MMDDYYYY   202, detached; omit from/to for the whole committed corpus
GET    /benchmark/keys-backfill                                          snapshot + progress/ETA + reducedLookback; 404 if none since boot
DELETE /benchmark/keys-backfill?startedAt=<iso>                          cancel; the in-flight day finishes; 409 if startedAt does not match
```

**Sequence: era-reset script → keys-backfill to completion → benchmark runs.**
Running the backfill without `backend/scripts/reset-keys-era.mjs` silently
reuses the 11 already-pinned artifacts, 4 of which have degraded lookback.

Sequential and oldest-first so every day gets a full 3-day lookback — which a
sampled run cannot provide, because a sample's scattered days almost never have
KEYS for their 3 prior days. A day is reused only when its artifact is
`verified` **and** has an empty `lookbackMissing`. Failures are classified
(`unverified` / `error` / `refused` / `timeout`); `unverified` and `error` retry
up to 3 times with backoff, `refused` and `timeout` stop immediately, and any
stop ends the job (`state: "failed"`, `failures[0]` names the day) rather than
leaving a hole. Re-POST resumes — built days short-circuit on one read.

`POST /benchmark/keys-backfill` and `POST /benchmark/run` are **mutually
exclusive**: whichever starts first holds a shared lock, the other gets 409 with
a `holder` field. Assumes a single backend process. Do not run eminiplayer
ingest/backfill concurrently — a re-ingest of any corpus day stops the job by
design. Run against a one-shot server (`pnpm start`), never watch mode: job
state is in-memory. Budget ~$130 and 20-40 hours for a cold corpus (352
committed days at ~$0.37/day).
````

- [ ] **Step 2: Fix the stale 409 sentence**

The existing text says `POST /benchmark/run` has "two 409 causes". It now has three. Change that sentence to read: *"note `POST /benchmark/run` has three 409 causes — a run in progress, a keys backfill in progress (both name the `holder`; check `GET /benchmark/status` and `GET /benchmark/keys-backfill`), vs content drift (check `GET /benchmark/drift`) — and the response body says which."*

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude-md): keys-backfill endpoints"
```

---

## Self-Review

**Spec coverage:** shared lock + single-process caveat → T1. `onFailure` classification seam + `lineageAlias` → T2. `ensureDayRecorded` extraction with its ordering contract → T3. Sequential loop, reuse-requires-empty-`lookbackMissing`, `reducedLookback` reporting, empty-corpus and methods-doc preflights, `from` guard, snapshot-once → T4. Retry with backoff, classification, `refused`/`timeout`/snapshot-mismatch fail-fast, whole-body timeout, classification read inside the retry → T5. Cancellation, shutdown hooks, generated-only progress → T6. Three routes with `confirm`/`startedAt` guards, module **exports**, `AppConfig` interface + literal, boot verification → T7. Era reset with batch guard, hash-scoped cell deletion, legacy docs, real post-conditions → T8. Operational sequencing + 409 correction → T9.

**Placeholder scan:** no TBDs; every code step carries real code.

**Type consistency:** `KeysFailure` (T2) is imported by T4 and reused for `KeysFailureKind = KeysFailure['kind'] | 'timeout'`. `generateDay`, `recordReducedLookback`, `nowMs`, `sleep` are declared `protected` in T4 and referenced in T5/T6. `EraArtifact` gained `contentHash`/`generatedBy` and the script supplies both. `ensureDayRecorded` returns `PdfArtifact`, consumed only by `assembleDay`.

**Fixture accuracy (the review's largest defect class):** every test above is written against the file's real helper. `seven-keys.service.spec.ts` → `makeDeps()` + `await build(deps, configOverrides)` returning the service bare, with module-level `DAY`/`SNAP`, and `benchmark.model` pinned wherever the alias is asserted (the default resolves to `fable`, not `k3`). `day-artifacts.service.spec.ts` → `const { svc } = await build()`. `benchmark.service.spec.ts` and `benchmark.controller.spec.ts` → new constructor deps registered in their `providers` arrays, never constructed directly.
