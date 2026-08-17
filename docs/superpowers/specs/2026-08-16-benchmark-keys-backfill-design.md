# Benchmark KEYS Backfill — Design

Date: 2026-08-16
Status: approved for planning

## Problem

Seven-keys KEYS artifacts are generated only as a side effect of
`POST /benchmark/run`, one day at a time, and each day's lookback analyst
calibrates against the **3 most recent prior days that already have KEYS**.

That coupling breaks under the sampling structure. A persisted sample draws
100 days scattered across 20 months (median gap 5 calendar days, max 28), so
when the run reaches a sampled day its 3 prior days almost never have KEYS.
Nothing backfills them: `ensureKeys` is called only for days in the run's own
day list, so the run silently generates a bootstrap-quality or reduced-lookback
artifact and moves on.

Measured on the live corpus, warming up each sampled day is not a cheaper
alternative to building everything:

| Approach | Days to generate |
|---|---|
| Sample (100) + 3 priors each | 254 |
| …recursed one more level (priors want their own priors) | 313 |
| Entire corpus | 352 |

The warmup path costs 72–89% of a full corpus build and yields a partial,
non-reusable, quality-degraded chain. Building the corpus once, in order,
strictly dominates.

## Goals

- Generate KEYS for the entire committed eminiplayer corpus in strict
  chronological order, so every day gets a full 3-day lookback.
- Never accumulate silent gaps: a day that cannot be generated stops the job
  for manual investigation.
- Survive as a long-running (20–40 hour) detached job: observable, cancellable,
  and cheaply resumable after a process death or a fixed defect.
- Keep KEYS generation and benchmark runs mutually exclusive, so the two can
  never race `ensureKeys`.

## Non-goals

- Chunked or parallel generation. Rejected deliberately: consistent lookback is
  the point of the exercise.
- Parallelising the current-day analyst (a two-phase design). Viable — only the
  lookback stage depends on prior KEYS — but deferred; it can be added later
  without changing the artifact format or lookback semantics.
- Changing seven-keys prompts, the weighting rule, or `LOOKBACK_DAYS` (stays 3,
  hardcoded).
- A general cell-retirement endpoint. The one-time era reset below is a script.
- An auth token guard. Single-operator, local-only; the already-running 409 and
  the shared lock prevent accidental double-starts.

## Corpus facts (measured 2026-08-16)

- 352 committed manifest days, `01022025` → `08142026` (211 in 2025, 141 in 2026).
- Cost: **$0.3685/day** measured across completed days (4–6 LLM calls each).
- Wall clock: ~3.5 min/day of LLM time; ~7 min/day observed end-to-end.
- Full build after the era reset: 352 days ≈ **$130** and **20–40 hours**.

## Design decisions

### 1. Mutual exclusion with benchmark runs

`BenchmarkService` guards runs with a private `runInProgress` boolean whose
comment states the hazard directly: two concurrent callers racing `ensureKeys`
can orphan a submitted batch's pinned KEYS hash via last-write-wins
`saveKeysArtifact` — a permanent per-day wedge. The backfill calls the same
`ensureKeys`, so it must share that guard.

Extract a small injectable `BenchmarkRunLock` in the benchmark module:

```ts
type LockHolder = 'benchmark-run' | 'keys-backfill';
acquire(holder: LockHolder): void;   // throws ConflictException naming the current holder
release(holder: LockHolder): void;
get heldBy(): LockHolder | null;
```

`BenchmarkService.run()` acquires `'benchmark-run'`; the backfill acquires
`'keys-backfill'` at `start()` and releases it in the loop's `finally`, so the
lock is held for the job's entire lifetime. Either side attempting to start
while the other holds it gets **409** naming the holder. In-memory only: a
process death resets it, which is correct — nothing is running.

### 2. Failure policy: retry 3, then stop

A day is attempted up to **3 times**. `ensureKeys` returns `null` on a verifier
failure and throws on infrastructure errors; both count as attempts, because a
verifier failure is a sampling artifact and often passes on a re-run.

After 3 failed attempts the job **stops**: state `failed`, the offending day and
its diagnostics recorded, no further days started. This is deliberate — the
alternative (record the hole and continue) degrades the next 3 days to reduced
lookback per hole, which is exactly the consistency the build exists to buy.

Consequence, and a useful invariant: **the KEYS corpus is always a contiguous
prefix** of the corpus in chronological order. A re-POST after the defect is
fixed resumes precisely where it stopped.

To surface *why* a day failed, `ensureKeys` gains one optional, additive
diagnostic seam — no behaviour change for existing callers:

```ts
opts?: { force?: boolean; pinned?: boolean; onUnverified?: (mismatches: string[]) => void }
```

The backfill passes `onUnverified` to capture verifier mismatch strings into the
failure ledger.

### 3. Resume semantics: durable state lives in the artifacts

Mirrors the eminiplayer backfill's core principle. The job object is in-memory
and disposable; the durable state is the KEYS artifacts in Firestore. Resume is
just a re-POST: `ensureKeys` reuses any stored verified, unpinned artifact, so
already-built days short-circuit on a single Firestore read with no LLM spend.
No persisted ledger, no checkpoint file.

The job never passes `force` — reuse *is* the resume mechanism.

### 4. One-time era reset (prerequisite script)

All 11 existing k3 KEYS artifacts are pinned by scorecard cells, and 4 carry
degraded lookback because they were generated out of order:

| Day | Lookback missing | Pinned by |
|---|---|---|
| `01062025` | `01022025`, `01032025` | 1 keystone-trader cell (aborted run debris) |
| `08032026` | all 3 priors | 10 scorecard cells (retired `context-*`) |
| `08042026` | 2 of 3 priors | 10 scorecard cells (retired `context-*`) |
| `08052026` | 1 of 3 priors | 10 scorecard cells (retired `context-*`) |

Because a pinned doc is reused **unconditionally — even under `force`** — these
cannot be repaired in place. They are deleted and regenerated fresh in sequence.

Critical ordering constraint: deleting KEYS artifacts while pinning cells remain
triggers `ensureKeys`'s orphaned-pin guard — *"scorecard cells pinned KEYS
hash(es) … that match no stored artifact; refusing to generate … (possible
deleted artifact)"* — permanently wedging those days. **The cells must go too.**

Scope of the reset script (`backend/scripts/reset-keys-era.ts`, dry-run by
default, `--apply` to execute):

- Delete all 11 `*__keys__k3` artifacts in `dayArtifacts`.
- Delete the 101 `seven-keys-scorecard` cells in `benchmarkRuns` that pin them
  (50 `context-structured`, 50 `context-trader`, 1 `keystone-trader`).
- Leave the 200 `base` / `seven-keys-method` cells untouched — they record no
  `artifactSha256` and pin nothing.
- Refuse to run while the lock is held or any non-terminal batch exists.
- Verify post-conditions: zero `__keys__k3` docs, zero cells with a dangling
  `artifactSha256`.

### 5. Unchanged

`LOOKBACK_DAYS` stays 3 and stays hardcoded. Seven-keys prompts, the
current-day/lookback weighting rule, and the fidelity-only verifier are all
untouched. Rationale: lookback has never yet run at full strength, so tuning it
now would be tuning against a degraded 11-artifact sample; the corpus build
itself produces the evidence needed to decide later.

## API surface

```
POST   /benchmark/keys-backfill?from=MMDDYYYY&to=MMDDYYYY
GET    /benchmark/keys-backfill
DELETE /benchmark/keys-backfill
```

- **POST** → `202` with the initial snapshot. `from`/`to` are optional and
  default to the corpus bounds (so the no-arg call builds everything from the
  first committed trading day, `01022025`). `400` if `from > to` or a date is
  malformed; `409` if the lock is held (body names the holder).
- **GET** → current or last job snapshot; `404` `"no keys-backfill job has run
  since boot"` when none exists (in-memory state, matching the eminiplayer
  backfill's convention rather than an idle sentinel).
- **DELETE** → request cancellation; the in-flight day finishes, then the job
  ends `cancelled` and releases the lock. `404` when no job exists.

### Snapshot shape

```ts
interface KeysBackfillSnapshot {
  state: 'running' | 'done' | 'cancelled' | 'failed';
  flagshipAlias: string;          // lineage being built, e.g. 'k3'
  from: string;
  to: string;
  startedAt: string;
  finishedAt: string | null;
  currentDay: string | null;
  cancelRequested: boolean;
  counts: {
    candidates: number;           // days in range
    processed: number;
    generated: number;            // KEYS actually produced
    reused: number;               // already had a verified artifact
    failed: number;               // days that exhausted retries (0 or 1, then the job stops)
  };
  failures: Array<{
    day: string;
    attempts: number;
    kind: 'unverified' | 'error';
    message: string;
    mismatches: string[];         // verifier mismatch strings when kind==='unverified'
  }>;
  error: string | null;           // job-level stop reason, names the day to investigate
  progress: { avgSecondsPerDay: number | null; etaIso: string | null };
}
```

`progress` is a rolling average over completed days — a 40-hour job needs an ETA
to be operable.

## Components

- **`KeysBackfillService`** (`backend/src/benchmark/keys-backfill.service.ts`) —
  the detached singleton job. Owns the snapshot, the sequential loop, retries,
  cancellation, shutdown hooks, and the per-day timeout.
- **`BenchmarkRunLock`** (`backend/src/benchmark/run-lock.ts`) — the shared
  single-flight guard described above.
- **`BenchmarkController`** — three new routes delegating to the service.
- **`SevenKeysService`** — one additive `onUnverified` opt.
- **`reset-keys-era.ts`** — one-time prerequisite script.

### Day loop

For each day in range, oldest-first:

1. If cancelled, stop (`cancelled`).
2. `loadDay(listing)` → verifies artifacts against the manifest hashes.
3. `assembleDay(dayInput)` → `ensurePdf` + both `ensureTranscript` calls, so
   `ensureKeys` can resolve a live provider `file_id`. This logic currently
   lives in `BenchmarkService.assembleDay` (private) and must be extracted to a
   shared collaborator rather than duplicated.
4. Classify before generating: one `repo.getKeysArtifact(day, alias)` read. A
   stored **verified** artifact means this day is already built — count `reused`
   and skip to the next day without calling `ensureKeys` at all. This keeps the
   generated/reused distinction unambiguous (rather than inferring it from
   timestamps) and makes a resume pass cost one Firestore read per built day.
5. Otherwise `ensureKeys(dayInput, snap, { onUnverified })`, wrapped in a per-day
   timeout. Non-null → `generated`; null/throw → retry, up to 3 attempts; on
   exhaustion record the failure, set `failed`, and stop.

Steps 2–3 are skipped for a `reused` day, so a resume pass does no bucket
downloads or PDF re-uploads for days already built.

The corpus snapshot (`inputs.snapshot()`) is taken **once** per job. It supplies
`methodsDoc`, `general`, and `days`, all of which `ensureKeys` requires. The
traders/features emptiness check lives in `runInner`, not `snapshot()`, so a
keys-only job needs no personas.

## Error handling

| Condition | Behaviour |
|---|---|
| Verifier failure | Retry (≤3), capture mismatches, then stop the job |
| Transient LLM/infra throw | Retry (≤3), then stop the job |
| Per-day timeout | Counts as a failed attempt (config `benchmark.keysBackfillDayTimeoutMs`, default 900000) |
| Snapshot/corpus scan failure | Job-level `failed`, `error` set, lock released |
| `SIGTERM` / module destroy | Both `onModuleDestroy` and `onApplicationShutdown` set cancel, matching the eminiplayer precedent |
| Process death | Nothing persisted for the in-flight day; re-POST resumes |

## Testing

Unit tests with fakes, mirroring `eminiplayer-backfill.service.spec.ts`:

- Days processed strictly oldest-first.
- A day with an existing verified artifact is reused with no LLM call.
- A day failing twice then succeeding is generated; counts reflect one success.
- A day failing 3× stops the job: state `failed`, `error` names the day,
  mismatches captured, **no subsequent day is attempted**.
- Cancellation lets the in-flight day finish, then ends `cancelled`.
- The lock is released on every terminal state (`done`/`cancelled`/`failed`).
- `POST` while a benchmark run holds the lock → 409 naming the holder, and the
  reverse.
- `GET`/`DELETE` → 404 before any job has run.
- Shutdown hooks request cancellation.
- `from`/`to` filtering and `from > to` rejection.

## Operational notes

- Run against a one-shot server (`pnpm start`), never watch mode: job state is
  in-memory and a file-change restart kills it.
- Expect ~$130 and 20–40 hours for the full corpus.
- Poll `GET /benchmark/keys-backfill` for progress and ETA.
- On `failed`, read `failures[0]` — the day, attempt count, and verifier
  mismatches are the investigation starting point.
- Sequence: era-reset script → keys-backfill to completion → benchmark runs.
