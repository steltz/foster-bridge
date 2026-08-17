# Benchmark KEYS Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a detached, resumable, strictly sequential job that generates seven-keys KEYS artifacts for the entire committed eminiplayer corpus, so every day is graded with a full 3-day lookback.

**Architecture:** A new in-memory singleton `KeysBackfillService` walks committed days oldest-first, calling the existing `SevenKeysService.ensureKeys` one day at a time. Durable state lives in the KEYS artifacts themselves, so a re-POST resumes. A new shared `BenchmarkRunLock` makes the job and `POST /benchmark/run` mutually exclusive, closing the `ensureKeys` race that the old private `runInProgress` flag guarded against. A day that fails three attempts stops the job for manual investigation rather than leaving a lookback hole.

**Tech Stack:** NestJS 10, TypeScript, Jest + ts-jest (`rootDir: src`, `testRegex: .*\.spec\.ts$`), firebase-admin (Firestore + Storage), pnpm.

**Spec:** `docs/superpowers/specs/2026-08-16-benchmark-keys-backfill-design.md`

## Global Constraints

- `LOOKBACK_DAYS` stays **3** and stays hardcoded. Do not change seven-keys prompts, the current-day/lookback weighting rule, or the fidelity-only verifier.
- Max attempts per day is **3**; on exhaustion the job **stops** (`state: 'failed'`). Never continue past a failed day.
- The job never passes `force` to `ensureKeys` — reuse is the resume mechanism.
- Job state is **in-memory only**. No persisted ledger, no checkpoint file.
- Day keys are `MMDDYYYY`; candle/listing dates are `YYYY-MM-DD`.
- The existing 409 message for a concurrent benchmark run must stay exactly `a benchmark run is already in progress` (existing specs assert it).
- No auth token guard on these routes (single-operator, local).
- Tests live under `src/` (jest `rootDir` is `src`); anything under `backend/scripts/` is not test-discovered, so testable logic belongs in `src/`.
- Run all tests with `npx jest <path>` from `backend/`.

---

### Task 1: Shared single-flight lock

**Files:**
- Create: `backend/src/benchmark/run-lock.ts`
- Create: `backend/src/benchmark/run-lock.spec.ts`
- Modify: `backend/src/benchmark/benchmark.service.ts` (field at :81, guard at :100-105, constructor)
- Modify: `backend/src/benchmark/benchmark.module.ts` (providers)

**Interfaces:**
- Consumes: nothing from earlier tasks.
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
    expect(() => lock.acquire('benchmark-run')).toThrow(LockHeldError);
    try {
      lock.acquire('benchmark-run');
    } catch (err) {
      expect((err as LockHeldError).holder).toBe('keys-backfill');
      expect((err as Error).message).toBe('a keys backfill is already in progress');
    }
  });

  it('uses the legacy wording for a held benchmark run', () => {
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
 * a submitted batch's pinned KEYS hash — a permanent per-day wedge. In-memory
 * by design: a process death resets it, which is correct, because nothing is
 * running after a process death.
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

In `backend/src/benchmark/benchmark.service.ts`, delete the `private runInProgress = false;` field (:81) and add the lock to the constructor (append to the existing parameter list):

```ts
    private readonly lock: BenchmarkRunLock,
```

Add the import:

```ts
import { BenchmarkRunLock, LockHeldError } from './run-lock';
```

Replace the guard block (currently :97-106):

```ts
    // Single-flight: two concurrent runs racing ensureKeys can orphan a
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

- [ ] **Step 6: Register the provider**

In `backend/src/benchmark/benchmark.module.ts`, add `BenchmarkRunLock` to the import list and to `providers` (before `BenchmarkService`), and add it to `exports`.

- [ ] **Step 7: Run the full benchmark suite**

Run: `npx jest src/benchmark`
Expected: PASS — 215+ tests. `benchmark.service.spec.ts` constructs `BenchmarkService` directly, so add `new BenchmarkRunLock()` as the new final constructor argument wherever it is built; the existing "already in progress" assertion must still pass unchanged.

- [ ] **Step 8: Commit**

```bash
git add backend/src/benchmark/run-lock.ts backend/src/benchmark/run-lock.spec.ts backend/src/benchmark/benchmark.service.ts backend/src/benchmark/benchmark.service.spec.ts backend/src/benchmark/benchmark.module.ts
git commit -m "feat(benchmark): shared single-flight run lock"
```

---

### Task 2: Seven-keys seams for the backfill

**Files:**
- Modify: `backend/src/benchmark/seven-keys/seven-keys.service.ts`
- Modify: `backend/src/benchmark/seven-keys/seven-keys.service.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SevenKeysService.lineageAlias: string` (public getter); `ensureKeys(day, snap, opts?)` where `opts` gains `onUnverified?: (mismatches: string[]) => void`.

Both additive. `ensureKeys` already returns `DayArtifactDoc | null` and must keep doing so — existing callers are untouched.

- [ ] **Step 1: Write the failing test**

Append to `backend/src/benchmark/seven-keys/seven-keys.service.spec.ts` (reuse whatever `build()`/fake helpers the file already defines; the assertions below are the contract):

```ts
  it('exposes the flagship lineage alias', () => {
    const { service } = build();
    expect(service.lineageAlias).toBe('k3');
  });

  it('reports verifier mismatches through onUnverified', async () => {
    const { service, day, snap } = build({
      verify: { pass: false, mismatches: ['7495.25-7502.75: side mismatch'] },
    });
    const seen: string[] = [];
    const doc = await service.ensureKeys(day, snap, { onUnverified: (m) => seen.push(...m) });
    expect(doc).toBeNull();
    expect(seen).toEqual(['7495.25-7502.75: side mismatch']);
  });

  it('does not call onUnverified when the artifact verifies', async () => {
    const { service, day, snap } = build();
    const onUnverified = jest.fn();
    await service.ensureKeys(day, snap, { onUnverified });
    expect(onUnverified).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/benchmark/seven-keys/seven-keys.service.spec.ts`
Expected: FAIL — `service.lineageAlias` is undefined and `onUnverified` is never invoked.

- [ ] **Step 3: Write minimal implementation**

In `seven-keys.service.ts`, add the public getter next to the existing private `flagshipAlias` getter:

```ts
  /** The KEYS lineage this instance reads and writes (e.g. 'k3'). */
  get lineageAlias(): string {
    return this.flagshipAlias;
  }
```

Widen the `ensureKeys` options type:

```ts
  async ensureKeys(
    day: DayInput,
    snap: InputsSnapshot,
    opts?: { force?: boolean; pinned?: boolean; onUnverified?: (mismatches: string[]) => void },
  ): Promise<DayArtifactDoc | null> {
```

Find the branch where generation completes and the artifact fails verification (`result.verified` is false, currently returning `null` after logging). Invoke the callback immediately before that `return null`:

```ts
    if (!result.verified) {
      opts?.onUnverified?.(result.mismatches ?? []);
      this.logger.warn(
        `Seven-keys verifier failed for ${day.day}: ${(result.mismatches ?? []).join('; ')}`,
      );
      return null;
    }
```

Keep the existing log wording; only the callback line is new.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/benchmark/seven-keys`
Expected: PASS — 32 existing + 3 new.

- [ ] **Step 5: Commit**

```bash
git add backend/src/benchmark/seven-keys/seven-keys.service.ts backend/src/benchmark/seven-keys/seven-keys.service.spec.ts
git commit -m "feat(seven-keys): expose lineage alias and verifier mismatch seam"
```

---

### Task 3: Extract day-artifact recording

**Files:**
- Modify: `backend/src/benchmark/day-artifacts.service.ts`
- Modify: `backend/src/benchmark/day-artifacts.service.spec.ts`
- Modify: `backend/src/benchmark/benchmark.service.ts:349-356` (`assembleDay`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `DayArtifactsService.ensureDayRecorded(day: DayInput): Promise<PdfArtifact>` — mirrors the PDF and both transcripts to GCS/Firestore and returns the PDF artifact (whose `providerFileId` is a live file id). Callers that only need `ensureFileId` to work afterwards can ignore the return value.

`assembleDay` currently inlines these three calls; the backfill needs the same preparation without the envelope `DayBundle`, so the shared part moves down into `DayArtifactsService`.

- [ ] **Step 1: Write the failing test**

Append to `backend/src/benchmark/day-artifacts.service.spec.ts`:

```ts
  it('ensureDayRecorded mirrors the pdf and both transcripts and returns the pdf artifact', async () => {
    const { service } = build();
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
    const ensurePdf = jest.spyOn(service, 'ensurePdf');
    const ensureTranscript = jest.spyOn(service, 'ensureTranscript');

    const pdf = await service.ensureDayRecorded(day as never);

    expect(ensurePdf).toHaveBeenCalledWith('01022025', '01022025', day.pdf);
    expect(ensureTranscript).toHaveBeenCalledWith('01022025', 'tpTranscript', '01022025_ES_TP.md', 'tp text');
    expect(ensureTranscript).toHaveBeenCalledWith('01022025', 'recapTranscript', '12312024_ES_RECAP.md', 'recap text');
    expect(pdf.providerFileId).toBeDefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/benchmark/day-artifacts.service.spec.ts`
Expected: FAIL — `service.ensureDayRecorded is not a function`

- [ ] **Step 3: Write minimal implementation**

In `day-artifacts.service.ts` add the type-only import (type-only avoids any module cycle):

```ts
import type { DayInput } from './cloud-inputs.service';
```

Add the method after `ensureTranscript`:

```ts
  /**
   * Records everything a day needs before seven-keys can run: the PDF (so
   * ensureFileId resolves a live provider file id) plus both transcripts.
   * Shared by the benchmark run's envelope assembly and the keys backfill.
   */
  async ensureDayRecorded(day: DayInput): Promise<PdfArtifact> {
    const pdf = await this.ensurePdf(day.day, day.prefix, day.pdf);
    await this.ensureTranscript(day.day, 'tpTranscript', `${day.prefix}_ES_TP.md`, day.tpTranscript);
    await this.ensureTranscript(day.day, 'recapTranscript', day.recapFileName, day.recapTranscript);
    return pdf;
  }
```

- [ ] **Step 4: Collapse `assembleDay` onto it**

Replace `backend/src/benchmark/benchmark.service.ts:349-356` with:

```ts
  private async assembleDay(day: DayInput): Promise<{ dayBundle: DayBundle }> {
    const pdf = await this.dayArtifacts.ensureDayRecorded(day);
    return {
      dayBundle: { date: day.date, fileId: pdf.providerFileId, tpTranscript: day.tpTranscript, recapTranscript: day.recapTranscript },
    };
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/benchmark`
Expected: PASS — behaviour is unchanged, so every existing benchmark test still passes.

- [ ] **Step 6: Commit**

```bash
git add backend/src/benchmark/day-artifacts.service.ts backend/src/benchmark/day-artifacts.service.spec.ts backend/src/benchmark/benchmark.service.ts
git commit -m "refactor(benchmark): extract ensureDayRecorded for reuse"
```

---

### Task 4: KeysBackfillService — sequential loop

**Files:**
- Create: `backend/src/benchmark/keys-backfill.service.ts`
- Create: `backend/src/benchmark/keys-backfill.service.spec.ts`

**Interfaces:**
- Consumes: `BenchmarkRunLock` (Task 1); `SevenKeysService.lineageAlias` + `ensureKeys(..., { onUnverified })` (Task 2); `DayArtifactsService.ensureDayRecorded` (Task 3).
- Produces: `KeysBackfillService` with `start(opts: { from?: string; to?: string }): KeysBackfillSnapshot`, `status(): KeysBackfillSnapshot | null`, `cancel(): KeysBackfillSnapshot | null`; exported types `KeysBackfillState`, `KeysBackfillFailure`, `KeysBackfillSnapshot`; private awaitable `loopPromise` test seam.

Retry, timeout, cancellation, and progress arrive in Tasks 5-6 — this task establishes ordering, reuse, and lock handling only.

- [ ] **Step 1: Write the failing test**

Create `backend/src/benchmark/keys-backfill.service.spec.ts`:

```ts
import { ConfigService } from '@nestjs/config';
import { KeysBackfillService } from './keys-backfill.service';
import { BenchmarkRunLock } from './run-lock';
import type { DayListing } from './cloud-inputs.service';

function listing(day: string, date: string): DayListing {
  return {
    day,
    date,
    prefix: day,
    recapDate: day,
    fileSha256: { tradePlanMd: 'a', tradePlanPdf: 'b', recap: 'c' },
  };
}

const DAYS = [
  listing('01022025', '2025-01-02'),
  listing('01032025', '2025-01-03'),
  listing('01062025', '2025-01-06'),
];

function build(
  overrides: {
    days?: DayListing[];
    ensureKeys?: jest.Mock;
    getKeysArtifact?: jest.Mock;
  } = {},
) {
  const inputs = {
    snapshot: jest.fn(() =>
      Promise.resolve({
        traders: [],
        features: [],
        general: { files: [], concatenated: '', sha256: 'g' },
        methodsDoc: 'methods',
        days: overrides.days ?? DAYS,
        issues: [],
      }),
    ),
    loadDay: jest.fn((l: DayListing) =>
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
    ensureKeys: overrides.ensureKeys ?? jest.fn(() => Promise.resolve({ contentHash: 'kh', verified: true })),
  };
  const repo = { getKeysArtifact: overrides.getKeysArtifact ?? jest.fn(() => Promise.resolve(null)) };
  const lock = new BenchmarkRunLock();
  const config = {
    get: jest.fn((key: string) =>
      key === 'benchmark.keysBackfillDayTimeoutMs' ? 60_000 : undefined,
    ),
  } as unknown as ConfigService;

  const service = new KeysBackfillService(
    inputs as never,
    dayArtifacts as never,
    sevenKeys as never,
    repo as never,
    lock,
    config,
  );
  return { service, inputs, dayArtifacts, sevenKeys, repo, lock };
}

/** Await the detached loop. */
async function settle(service: KeysBackfillService): Promise<void> {
  await (service as never as { loopPromise: Promise<void> }).loopPromise;
}

describe('KeysBackfillService', () => {
  it('generates every day oldest-first and finishes done', async () => {
    const { service, sevenKeys } = build();
    service.start({});
    await settle(service);

    const daysSeen = sevenKeys.ensureKeys.mock.calls.map((c: unknown[]) => (c[0] as DayListing).day);
    expect(daysSeen).toEqual(['01022025', '01032025', '01062025']);
    const job = service.status()!;
    expect(job.state).toBe('done');
    expect(job.counts).toMatchObject({ candidates: 3, processed: 3, generated: 3, reused: 0, failed: 0 });
    expect(job.flagshipAlias).toBe('k3');
    expect(job.from).toBe('01022025');
    expect(job.to).toBe('01062025');
  });

  it('reuses an existing verified artifact without generating or loading the day', async () => {
    const getKeysArtifact = jest.fn((day: string) =>
      Promise.resolve(day === '01032025' ? { contentHash: 'kh', verified: true } : null),
    );
    const { service, sevenKeys, inputs } = build({ getKeysArtifact });
    service.start({});
    await settle(service);

    const daysSeen = sevenKeys.ensureKeys.mock.calls.map((c: unknown[]) => (c[0] as DayListing).day);
    expect(daysSeen).toEqual(['01022025', '01062025']);
    expect(inputs.loadDay).toHaveBeenCalledTimes(2);
    expect(service.status()!.counts).toMatchObject({ generated: 2, reused: 1, processed: 3 });
  });

  it('regenerates a stored artifact that is not verified', async () => {
    const getKeysArtifact = jest.fn(() => Promise.resolve({ contentHash: 'kh', verified: false }));
    const { service, sevenKeys } = build({ getKeysArtifact });
    service.start({});
    await settle(service);
    expect(sevenKeys.ensureKeys).toHaveBeenCalledTimes(3);
  });

  it('honours a from/to window', async () => {
    const { service, sevenKeys } = build();
    service.start({ from: '01032025', to: '01032025' });
    await settle(service);
    const daysSeen = sevenKeys.ensureKeys.mock.calls.map((c: unknown[]) => (c[0] as DayListing).day);
    expect(daysSeen).toEqual(['01032025']);
    expect(service.status()!.counts.candidates).toBe(1);
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

  it('throws when the lock is already held and does not create a job', () => {
    const { service, lock } = build();
    lock.acquire('benchmark-run');
    expect(() => service.start({})).toThrow('a benchmark run is already in progress');
    expect(service.status()).toBeNull();
  });

  it('fails the job and releases the lock when the corpus scan throws', async () => {
    const { service, inputs, lock } = build();
    inputs.snapshot.mockRejectedValueOnce(new Error('bucket down'));
    service.start({});
    await settle(service);
    const job = service.status()!;
    expect(job.state).toBe('failed');
    expect(job.error).toContain('bucket down');
    expect(lock.heldBy).toBeNull();
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
import { BenchmarkRepository } from './benchmark.repository';
import { CloudInputsService, DayListing, InputsSnapshot } from './cloud-inputs.service';
import { DayArtifactsService } from './day-artifacts.service';
import { SevenKeysService } from './seven-keys/seven-keys.service';
import { BenchmarkRunLock } from './run-lock';

export type KeysBackfillState = 'running' | 'done' | 'cancelled' | 'failed';

export interface KeysBackfillFailure {
  day: string;
  attempts: number;
  kind: 'unverified' | 'error';
  message: string;
  mismatches: string[];
}

export interface KeysBackfillSnapshot {
  state: KeysBackfillState;
  flagshipAlias: string;
  /** Resolved corpus bounds; null until the corpus scan completes. */
  from: string | null;
  to: string | null;
  startedAt: string;
  finishedAt: string | null;
  currentDay: string | null;
  cancelRequested: boolean;
  counts: {
    candidates: number;
    processed: number;
    generated: number;
    reused: number;
    failed: number;
  };
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
      startedAt: new Date().toISOString(),
      finishedAt: null,
      currentDay: null,
      cancelRequested: false,
      counts: { candidates: 0, processed: 0, generated: 0, reused: 0, failed: 0 },
      failures: [],
      error: null,
      progress: { avgSecondsPerDay: null, etaIso: null },
    };
    this.loopPromise = this.runLoop(this.job, opts);
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
      const inRange = [...snap.days]
        .sort((a, b) => a.date.localeCompare(b.date))
        .filter((d) => this.inWindow(d, opts));
      job.counts.candidates = inRange.length;
      job.from = inRange[0]?.day ?? null;
      job.to = inRange[inRange.length - 1]?.day ?? null;
      this.logger.log(`keys-backfill: ${inRange.length} candidate days for lineage ${job.flagshipAlias}`);

      for (const listing of inRange) {
        if (this.cancelRequested) {
          job.state = 'cancelled';
          break;
        }
        job.currentDay = listing.day;
        const outcome = await this.runDay(job, listing, snap);
        job.currentDay = null;
        if (outcome === 'cancelled') {
          job.state = 'cancelled';
          break;
        }
        job.counts.processed += 1;
        if (outcome === 'failed') {
          job.state = 'failed';
          job.error =
            `day ${listing.day} failed all attempts — investigate before re-POSTing; ` +
            `days after it were not attempted`;
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
      job.finishedAt = new Date().toISOString();
      this.lock.release('keys-backfill');
      this.logger.log(
        `keys-backfill ${job.state}: ${job.counts.generated} generated, ${job.counts.reused} reused, ${job.counts.failed} failed`,
      );
    }
  }

  /** Inclusive MMDDYYYY window against the listing's YYYY-MM-DD date. */
  private inWindow(listing: DayListing, opts: { from?: string; to?: string }): boolean {
    const iso = (mmddyyyy: string) => `${mmddyyyy.slice(4, 8)}-${mmddyyyy.slice(0, 2)}-${mmddyyyy.slice(2, 4)}`;
    if (opts.from && listing.date < iso(opts.from)) return false;
    if (opts.to && listing.date > iso(opts.to)) return false;
    return true;
  }

  private async runDay(
    job: KeysBackfillSnapshot,
    listing: DayListing,
    snap: InputsSnapshot,
  ): Promise<DayOutcome> {
    const existing = await this.repo.getKeysArtifact(listing.day, job.flagshipAlias);
    if (existing?.verified) {
      job.counts.reused += 1;
      return 'reused';
    }
    const dayInput = await this.inputs.loadDay(listing);
    await this.dayArtifacts.ensureDayRecorded(dayInput);
    const mismatches: string[] = [];
    const doc = await this.sevenKeys.ensureKeys(dayInput, snap, {
      onUnverified: (m) => mismatches.push(...m),
    });
    if (doc) {
      job.counts.generated += 1;
      return 'generated';
    }
    job.counts.failed += 1;
    job.failures.push({
      day: listing.day,
      attempts: 1,
      kind: 'unverified',
      message: `verifier rejected the artifact: ${mismatches.join('; ') || 'no mismatch detail'}`,
      mismatches,
    });
    return 'failed';
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/benchmark/keys-backfill.service.spec.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/benchmark/keys-backfill.service.ts backend/src/benchmark/keys-backfill.service.spec.ts
git commit -m "feat(benchmark): sequential keys backfill job loop"
```

---

### Task 5: Retry three times, then stop

**Files:**
- Modify: `backend/src/benchmark/keys-backfill.service.ts` (`runDay`, new constants and timeout helper)
- Modify: `backend/src/benchmark/keys-backfill.service.spec.ts`

**Interfaces:**
- Consumes: `KeysBackfillService.runDay` from Task 4.
- Produces: exported `MAX_DAY_ATTEMPTS = 3`. `runDay` retries the whole generate cycle and records a `KeysBackfillFailure` with `attempts: 3` on exhaustion. A per-day timeout counts as one failed attempt.

- [ ] **Step 1: Write the failing test**

Append to `keys-backfill.service.spec.ts` (inside the top-level `describe`):

```ts
  it('retries a failed day and continues when a later attempt succeeds', async () => {
    let calls = 0;
    const ensureKeys = jest.fn((_d: unknown, _s: unknown, opts: { onUnverified?: (m: string[]) => void }) => {
      calls += 1;
      if (calls <= 2) {
        opts.onUnverified?.([`attempt ${calls} mismatch`]);
        return Promise.resolve(null);
      }
      return Promise.resolve({ contentHash: 'kh', verified: true });
    });
    const { service } = build({ days: [listing('01022025', '2025-01-02')], ensureKeys });
    service.start({});
    await settle(service);

    const job = service.status()!;
    expect(ensureKeys).toHaveBeenCalledTimes(3);
    expect(job.state).toBe('done');
    expect(job.counts).toMatchObject({ generated: 1, failed: 0 });
    expect(job.failures).toEqual([]);
  });

  it('stops the whole job after three failed attempts and records diagnostics', async () => {
    const ensureKeys = jest.fn((_d: unknown, _s: unknown, opts: { onUnverified?: (m: string[]) => void }) => {
      opts.onUnverified?.(['5777.75-5781.75: side mismatch']);
      return Promise.resolve(null);
    });
    const { service } = build({ ensureKeys });
    service.start({});
    await settle(service);

    const job = service.status()!;
    expect(ensureKeys).toHaveBeenCalledTimes(3); // first day only — never reached day 2
    expect(job.state).toBe('failed');
    expect(job.counts.failed).toBe(1);
    expect(job.error).toContain('01022025');
    expect(job.failures).toHaveLength(1);
    expect(job.failures[0]).toMatchObject({
      day: '01022025',
      attempts: 3,
      kind: 'unverified',
      mismatches: ['5777.75-5781.75: side mismatch'],
    });
  });

  it('classifies a thrown error as kind "error" and still stops after three attempts', async () => {
    const ensureKeys = jest.fn(() => Promise.reject(new Error('firestore blip')));
    const { service } = build({ ensureKeys });
    service.start({});
    await settle(service);

    const job = service.status()!;
    expect(ensureKeys).toHaveBeenCalledTimes(3);
    expect(job.state).toBe('failed');
    expect(job.failures[0]).toMatchObject({ day: '01022025', attempts: 3, kind: 'error' });
    expect(job.failures[0].message).toContain('firestore blip');
  });

  it('treats a per-day timeout as a failed attempt', async () => {
    jest.useFakeTimers();
    try {
      const ensureKeys = jest.fn(() => new Promise(() => undefined));
      const { service } = build({ days: [listing('01022025', '2025-01-02')], ensureKeys });
      service.start({});
      await jest.advanceTimersByTimeAsync(60_000 * 3 + 10);
      await settle(service);

      const job = service.status()!;
      expect(job.state).toBe('failed');
      expect(job.failures[0].message).toMatch(/timeout/i);
    } finally {
      jest.useRealTimers();
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/benchmark/keys-backfill.service.spec.ts`
Expected: FAIL — `ensureKeys` is called once, not three times; `attempts` is 1.

- [ ] **Step 3: Write minimal implementation**

In `keys-backfill.service.ts`, add above the class:

```ts
/** Attempts per day before the job stops for manual investigation. */
export const MAX_DAY_ATTEMPTS = 3;

class KeysBackfillDayTimeoutError extends Error {
  constructor(day: string, ms: number) {
    super(`day ${day} exceeded the ${ms}ms keys-backfill day timeout`);
  }
}
```

Replace `runDay` with the retrying version:

```ts
  private async runDay(
    job: KeysBackfillSnapshot,
    listing: DayListing,
    snap: InputsSnapshot,
  ): Promise<DayOutcome> {
    const existing = await this.repo.getKeysArtifact(listing.day, job.flagshipAlias);
    if (existing?.verified) {
      job.counts.reused += 1;
      return 'reused';
    }

    let lastKind: KeysBackfillFailure['kind'] = 'error';
    let lastMessage = 'no attempt was made';
    let lastMismatches: string[] = [];

    for (let attempt = 1; attempt <= MAX_DAY_ATTEMPTS; attempt++) {
      // Cancellation is checked BETWEEN attempts: the in-flight attempt always
      // finishes, matching the eminiplayer backfill's "in-flight day finishes".
      if (this.cancelRequested && attempt > 1) return 'cancelled';
      const mismatches: string[] = [];
      try {
        const dayInput = await this.inputs.loadDay(listing);
        await this.dayArtifacts.ensureDayRecorded(dayInput);
        const doc = await this.withDayTimeout(
          this.sevenKeys.ensureKeys(dayInput, snap, {
            onUnverified: (m) => mismatches.push(...m),
          }),
          listing.day,
        );
        if (doc) {
          job.counts.generated += 1;
          return 'generated';
        }
        lastKind = 'unverified';
        lastMismatches = mismatches;
        lastMessage = `verifier rejected the artifact: ${mismatches.join('; ') || 'no mismatch detail'}`;
      } catch (err) {
        lastKind = 'error';
        lastMismatches = [];
        lastMessage = err instanceof Error ? err.message : String(err);
      }
      this.logger.warn(
        `keys-backfill ${listing.day} attempt ${attempt}/${MAX_DAY_ATTEMPTS} failed: ${lastMessage}`,
      );
    }

    job.counts.failed += 1;
    job.failures.push({
      day: listing.day,
      attempts: MAX_DAY_ATTEMPTS,
      kind: lastKind,
      message: lastMessage,
      mismatches: lastMismatches,
    });
    return 'failed';
  }

  private withDayTimeout<T>(work: Promise<T>, day: string): Promise<T> {
    const ms = this.config.get<number>('benchmark.keysBackfillDayTimeoutMs') ?? 900_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new KeysBackfillDayTimeoutError(day, ms)), ms);
      // The abandoned promise keeps running harmlessly: a late save is just a
      // stored artifact the next attempt reuses.
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
Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/benchmark/keys-backfill.service.ts backend/src/benchmark/keys-backfill.service.spec.ts
git commit -m "feat(benchmark): retry keys days three times then stop the job"
```

---

### Task 6: Cancellation, shutdown, and progress

**Files:**
- Modify: `backend/src/benchmark/keys-backfill.service.ts`
- Modify: `backend/src/benchmark/keys-backfill.service.spec.ts`

**Interfaces:**
- Consumes: the loop from Tasks 4-5.
- Produces: `KeysBackfillService implements OnModuleDestroy, OnApplicationShutdown`; `progress.avgSecondsPerDay` / `progress.etaIso` populated after each completed day; private `nowMs()` seam for tests.

- [ ] **Step 1: Write the failing test**

Append to `keys-backfill.service.spec.ts`:

```ts
  it('cancel lets the in-flight day finish, then stops before the next day', async () => {
    const seen: string[] = [];
    let svc: KeysBackfillService;
    const ensureKeys = jest.fn((d: { day: string }) => {
      seen.push(d.day);
      svc.cancel(); // cancel while day 1 is in flight
      return Promise.resolve({ contentHash: 'kh', verified: true });
    });
    const built = build({ ensureKeys });
    svc = built.service;
    svc.start({});
    await settle(svc);

    const job = svc.status()!;
    expect(seen).toEqual(['01022025']); // day 1 completed, day 2 never started
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

  it('reports progress and an eta after a completed day', async () => {
    const { service } = build();
    let clock = 1_000_000;
    jest
      .spyOn(service as never as { nowMs: () => number }, 'nowMs')
      .mockImplementation(() => (clock += 10_000)); // 10s per call
    service.start({});
    await settle(service);

    const job = service.status()!;
    expect(job.progress.avgSecondsPerDay).toBeGreaterThan(0);
    expect(job.progress.etaIso).not.toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/benchmark/keys-backfill.service.spec.ts`
Expected: FAIL — `service.onApplicationShutdown is not a function`; `progress.avgSecondsPerDay` stays null.

- [ ] **Step 3: Write minimal implementation**

Change the class declaration and imports:

```ts
import { Injectable, Logger, OnApplicationShutdown, OnModuleDestroy } from '@nestjs/common';
```

```ts
export class KeysBackfillService implements OnModuleDestroy, OnApplicationShutdown {
```

Add the shutdown hooks and seams:

```ts
  /**
   * A 20-40 hour run WILL meet a SIGTERM. Both lifecycle phases set the flag so
   * no further day starts regardless of provider ordering; the in-flight day
   * finishes and its artifact either saved or did not.
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

  /** Seam so specs can pin the clock. */
  private nowMs(): number {
    return Date.now();
  }

  private updateProgress(job: KeysBackfillSnapshot): void {
    const done = job.counts.processed;
    if (done <= 0) return;
    const elapsedSeconds = (this.nowMs() - Date.parse(job.startedAt)) / 1000;
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) return;
    const avg = elapsedSeconds / done;
    const remaining = Math.max(0, job.counts.candidates - done);
    job.progress = {
      avgSecondsPerDay: Math.round(avg),
      etaIso: new Date(this.nowMs() + remaining * avg * 1000).toISOString(),
    };
  }
```

In `runLoop`, call `this.updateProgress(job);` immediately after `job.counts.processed += 1;`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/benchmark/keys-backfill.service.spec.ts`
Expected: PASS (17 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/benchmark/keys-backfill.service.ts backend/src/benchmark/keys-backfill.service.spec.ts
git commit -m "feat(benchmark): keys backfill cancellation, shutdown hooks, progress"
```

---

### Task 7: HTTP routes, module wiring, config

**Files:**
- Modify: `backend/src/eminiplayer/eminiplayer-validation.ts` (export `isValidMmddyyyy`)
- Modify: `backend/src/eminiplayer/eminiplayer.controller.ts:29-36` (drop the local copy, import instead)
- Modify: `backend/src/benchmark/benchmark.controller.ts`
- Modify: `backend/src/benchmark/benchmark.controller.spec.ts`
- Modify: `backend/src/benchmark/benchmark.module.ts`
- Modify: `backend/src/config/configuration.ts` (benchmark block, after `grading`)

**Interfaces:**
- Consumes: `KeysBackfillService` (Tasks 4-6), `LockHeldError` (Task 1).
- Produces: `POST /benchmark/keys-backfill` (202), `GET /benchmark/keys-backfill`, `DELETE /benchmark/keys-backfill`; config key `benchmark.keysBackfillDayTimeoutMs` (env `BENCHMARK_KEYS_DAY_TIMEOUT_MS`, default 900000).

- [ ] **Step 1: Write the failing test**

Append to `backend/src/benchmark/benchmark.controller.spec.ts` (matching however the file already constructs the controller — pass a `keysBackfill` fake as the new constructor argument):

```ts
describe('BenchmarkController keys-backfill', () => {
  function buildController(keysBackfill: Partial<Record<string, unknown>>) {
    return new BenchmarkController(
      {} as never, // benchmark
      {} as never, // scoreboardService
      {} as never, // repo
      { get: () => 'kimi-k3' } as never, // config
      {} as never, // samples
      keysBackfill as never,
    );
  }

  it('POST returns the snapshot', () => {
    const snapshot = { state: 'running' };
    const controller = buildController({ start: jest.fn(() => snapshot) });
    expect(controller.startKeysBackfill(undefined, undefined)).toBe(snapshot);
  });

  it('POST rejects a malformed from', () => {
    const controller = buildController({ start: jest.fn() });
    expect(() => controller.startKeysBackfill('2025-01-02', undefined)).toThrow(BadRequestException);
  });

  it('POST rejects a reversed range', () => {
    const controller = buildController({ start: jest.fn() });
    expect(() => controller.startKeysBackfill('01062025', '01022025')).toThrow(BadRequestException);
  });

  it('POST maps a held lock to 409 naming the holder', () => {
    const start = jest.fn(() => {
      throw new LockHeldError('benchmark-run');
    });
    const controller = buildController({ start, status: () => null });
    expect(() => controller.startKeysBackfill(undefined, undefined)).toThrow(ConflictException);
  });

  it('GET 404s when no job has run', () => {
    const controller = buildController({ status: () => null });
    expect(() => controller.keysBackfillStatus()).toThrow(NotFoundException);
  });

  it('DELETE 404s when no job has run', () => {
    const controller = buildController({ cancel: () => null });
    expect(() => controller.cancelKeysBackfill()).toThrow(NotFoundException);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/benchmark/benchmark.controller.spec.ts`
Expected: FAIL — `controller.startKeysBackfill is not a function`

- [ ] **Step 3: Export the date validator**

In `backend/src/eminiplayer/eminiplayer-validation.ts`, move the validator in and export it:

```ts
/** MMDDYYYY, and a real calendar date (rejects 13012026 and 02302026). */
export function isValidMmddyyyy(date: string): boolean {
  if (!/^\d{8}$/.test(date)) return false;
  const mm = Number(date.slice(0, 2));
  const dd = Number(date.slice(2, 4));
  const yyyy = Number(date.slice(4));
  const parsed = new Date(Date.UTC(yyyy, mm - 1, dd));
  return (
    parsed.getUTCFullYear() === yyyy &&
    parsed.getUTCMonth() === mm - 1 &&
    parsed.getUTCDate() === dd
  );
}
```

In `eminiplayer.controller.ts`, delete the local `isValidMmddyyyy` (:29-36) and add it to the existing `eminiplayer-validation` import.

- [ ] **Step 4: Add the routes**

In `benchmark.controller.ts`, extend the imports:

```ts
import { BadRequestException, Delete, HttpCode } from '@nestjs/common';
import { KeysBackfillService, KeysBackfillSnapshot } from './keys-backfill.service';
import { LockHeldError } from './run-lock';
import { isValidMmddyyyy, parseMmddyyyy } from '../eminiplayer/eminiplayer-validation';
```

Add `private readonly keysBackfill: KeysBackfillService,` as the last constructor parameter, then append these routes:

```ts
  /**
   * Corpus-wide seven-keys generation. Sequential and oldest-first so every day
   * gets a full 3-day lookback; omit from/to to build the entire committed
   * corpus. Detached — poll GET, and expect 20-40 hours for a cold corpus.
   */
  @Post('keys-backfill')
  @HttpCode(202)
  startKeysBackfill(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
  ): KeysBackfillSnapshot {
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

  @Delete('keys-backfill')
  cancelKeysBackfill(): KeysBackfillSnapshot {
    const job = this.keysBackfill.cancel();
    if (!job) throw new NotFoundException('no keys-backfill job has run since boot');
    return job;
  }
```

- [ ] **Step 5: Wire the module and config**

In `benchmark.module.ts`, add `KeysBackfillService` to the imports and `providers`.

In `configuration.ts`, inside the `benchmark` block after `grading`, add:

```ts
    // Ceiling for one day's full seven-keys cycle in the corpus backfill.
    // Generous: a day is 4-6 LLM calls at high effort, ~3.5 min of model time.
    keysBackfillDayTimeoutMs: parseInt(process.env.BENCHMARK_KEYS_DAY_TIMEOUT_MS ?? '900000', 10),
```

- [ ] **Step 6: Run the full suite**

Run: `npx jest`
Expected: PASS — all suites, including eminiplayer (the validator move must not break it).

- [ ] **Step 7: Commit**

```bash
git add backend/src/benchmark/benchmark.controller.ts backend/src/benchmark/benchmark.controller.spec.ts backend/src/benchmark/benchmark.module.ts backend/src/config/configuration.ts backend/src/eminiplayer/eminiplayer-validation.ts backend/src/eminiplayer/eminiplayer.controller.ts
git commit -m "feat(benchmark): keys-backfill endpoints"
```

---

### Task 8: One-time era reset

**Files:**
- Create: `backend/src/benchmark/keys-era-reset.ts`
- Create: `backend/src/benchmark/keys-era-reset.spec.ts`
- Create: `backend/scripts/reset-keys-era.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `planKeysEraReset(artifactIds: string[], cells: EraCell[], lineageAlias: string): EraResetPlan` where `EraCell = { id: string; artifactSha256?: string | null }` and `EraResetPlan = { artifactIdsToDelete: string[]; cellIdsToDelete: string[]; keptCellCount: number }`.

The decision logic is pure and unit-tested in `src/`; the script is a thin Firestore runner (jest's `rootDir` is `src`, so logic must live there to be tested).

- [ ] **Step 1: Write the failing test**

Create `backend/src/benchmark/keys-era-reset.spec.ts`:

```ts
import { planKeysEraReset } from './keys-era-reset';

describe('planKeysEraReset', () => {
  const artifacts = ['01062025__keys__k3', '08032026__keys__k3', '08032026__pdfFile', '07012026__keys__fable'];

  it('deletes only this lineage\'s keys artifacts', () => {
    const plan = planKeysEraReset(artifacts, [], 'k3');
    expect(plan.artifactIdsToDelete).toEqual(['01062025__keys__k3', '08032026__keys__k3']);
  });

  it('deletes exactly the cells that pin a KEYS hash', () => {
    const cells = [
      { id: 'c1', artifactSha256: 'h1' },
      { id: 'c2', artifactSha256: null },
      { id: 'c3' },
      { id: 'c4', artifactSha256: 'h2' },
    ];
    const plan = planKeysEraReset(artifacts, cells, 'k3');
    expect(plan.cellIdsToDelete).toEqual(['c1', 'c4']);
    expect(plan.keptCellCount).toBe(2);
  });

  it('is a no-op on an already-clean era', () => {
    const plan = planKeysEraReset(['08032026__pdfFile'], [{ id: 'c1' }], 'k3');
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
export interface EraCell {
  id: string;
  artifactSha256?: string | null;
}

export interface EraResetPlan {
  artifactIdsToDelete: string[];
  cellIdsToDelete: string[];
  keptCellCount: number;
}

/**
 * A one-time reset so the corpus can be rebuilt in strict order.
 *
 * Deleting KEYS artifacts alone would WEDGE those days: ensureKeys refuses to
 * generate when cells pin a hash matching no stored artifact ("possible deleted
 * artifact"). So every cell that pins a KEYS hash goes too. Cells with no
 * artifactSha256 (base / seven-keys-method) pin nothing and are kept.
 */
export function planKeysEraReset(
  artifactIds: string[],
  cells: EraCell[],
  lineageAlias: string,
): EraResetPlan {
  const suffix = `__keys__${lineageAlias}`;
  const artifactIdsToDelete = artifactIds.filter((id) => id.endsWith(suffix));
  const cellIdsToDelete = cells.filter((c) => Boolean(c.artifactSha256)).map((c) => c.id);
  return {
    artifactIdsToDelete,
    cellIdsToDelete,
    keptCellCount: cells.length - cellIdsToDelete.length,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/benchmark/keys-era-reset.spec.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the runner script**

Create `backend/scripts/reset-keys-era.mjs`. Run it from `backend/` so firebase-admin resolves. Dry-run by default:

```js
// Usage (from backend/):  node scripts/reset-keys-era.mjs [--apply]
// Deletes this lineage's KEYS artifacts AND every scorecard cell pinning one,
// so the corpus can be regenerated in strict chronological order.
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { planKeysEraReset } from '../dist/benchmark/keys-era-reset.js';

const apply = process.argv.includes('--apply');
const lineage = process.env.KEYS_LINEAGE ?? 'k3';

initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID ?? 'app-foster-bridge' });
const db = getFirestore();

const [artifacts, cells] = await Promise.all([
  db.collection('dayArtifacts').get(),
  db.collection('benchmarkRuns').get(),
]);

const plan = planKeysEraReset(
  artifacts.docs.map((d) => d.id),
  cells.docs.map((d) => ({ id: d.id, artifactSha256: d.data().artifactSha256 ?? null })),
  lineage,
);

console.log(`lineage:                 ${lineage}`);
console.log(`KEYS artifacts to delete: ${plan.artifactIdsToDelete.length}`);
console.log(`pinning cells to delete:  ${plan.cellIdsToDelete.length}`);
console.log(`cells kept (pin nothing): ${plan.keptCellCount}`);

if (!apply) {
  console.log('\nDRY RUN — re-run with --apply to execute.');
  process.exit(0);
}

let batch = db.batch();
let queued = 0;
const flush = async () => { await batch.commit(); batch = db.batch(); queued = 0; };
for (const id of plan.cellIdsToDelete) {
  batch.delete(db.collection('benchmarkRuns').doc(id));
  if (++queued === 400) await flush();
}
for (const id of plan.artifactIdsToDelete) {
  batch.delete(db.collection('dayArtifacts').doc(id));
  if (++queued === 400) await flush();
}
if (queued) await flush();

// Post-condition: no cell may pin a hash with no stored artifact.
const after = await db.collection('benchmarkRuns').get();
const dangling = after.docs.filter((d) => d.data().artifactSha256).length;
console.log(`\nDone. Cells still pinning a KEYS hash: ${dangling} (must be 0).`);
process.exit(dangling === 0 ? 0 : 1);
```

- [ ] **Step 6: Verify the dry run against real data**

Run from `backend/`:

```bash
pnpm build && node scripts/reset-keys-era.mjs
```

Expected: reports 11 KEYS artifacts and 101 pinning cells to delete, 200 cells kept, and exits without writing. Do **not** pass `--apply` yet — that is an operational step, run deliberately when starting the build.

- [ ] **Step 7: Commit**

```bash
git add backend/src/benchmark/keys-era-reset.ts backend/src/benchmark/keys-era-reset.spec.ts backend/scripts/reset-keys-era.mjs
git commit -m "feat(benchmark): one-time keys era reset"
```

---

### Task 9: Document the endpoints

**Files:**
- Modify: `CLAUDE.md` (Benchmark section)

**Interfaces:**
- Consumes: the routes from Task 7.
- Produces: no code.

- [ ] **Step 1: Add the endpoint block**

In `CLAUDE.md`, inside the Benchmark section after the samples block, add:

````markdown
Corpus-wide KEYS generation — build the lookback chain before benchmarking:

```
POST   /benchmark/keys-backfill?from=MMDDYYYY&to=MMDDYYYY   202, detached; omit from/to for the whole committed corpus
GET    /benchmark/keys-backfill                             job snapshot + progress/ETA; 404 if none since boot
DELETE /benchmark/keys-backfill                             cancel; the in-flight day finishes first
```

Sequential and oldest-first so every day gets a full 3-day lookback — which a
sampled run cannot provide, because a sample's scattered days almost never have
KEYS for their 3 prior days. A day that fails **3 attempts stops the job**
(`state: "failed"`, `failures[0]` carries the day and the verifier mismatches)
rather than leaving a hole that degrades the next three days. Re-POST resumes:
days with a stored verified artifact short-circuit on one read.

`POST /benchmark/keys-backfill` and `POST /benchmark/run` are **mutually
exclusive** — whichever starts first holds a shared lock and the other gets 409
naming the holder. Run against a one-shot server (`pnpm start`), never watch
mode: job state is in-memory. Budget ~$130 and 20-40 hours for a cold corpus
(352 committed days at ~$0.37/day).
````

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude-md): keys-backfill endpoints"
```

---

## Self-Review

**Spec coverage:** Mutual exclusion → Task 1. `onUnverified` seam → Task 2. `assembleDay` extraction → Task 3. Sequential oldest-first loop, reuse pre-check, resume, corpus snapshot taken once → Task 4. Retry-3-then-stop, failure ledger with mismatches, per-day timeout → Task 5. Cancellation, shutdown hooks, lock release on every terminal state, progress/ETA → Task 6. Three routes, 202/404/409, `from`/`to` defaults and validation, config knob → Task 7. Era reset incl. the orphaned-pin constraint → Task 8. Operational notes → Task 9. Non-goals (chunking, two-phase, prompt changes, `LOOKBACK_DAYS`, token guard, general retirement endpoint) have no tasks, by design.

**Placeholder scan:** No TBDs. Every code step carries real code.

**Type consistency:** `KeysBackfillSnapshot`, `KeysBackfillFailure`, `DayOutcome`, `LockHolder`, `LockHeldError`, `EraResetPlan`, and `EraCell` are defined once and referenced consistently. `ensureDayRecorded` returns `PdfArtifact` in Task 3 and its return value is used (`pdf.providerFileId`) only in `assembleDay`; the backfill ignores it. `lineageAlias` is a getter in Task 2 and read as a property in Task 4.

**Known wiring detail for executors:** Tasks 1 and 7 change constructor arities of `BenchmarkService` and `BenchmarkController`. Their existing specs construct these directly and must be updated in the same task, or the suite breaks.
