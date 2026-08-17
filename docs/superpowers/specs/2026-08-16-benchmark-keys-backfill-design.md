# Benchmark KEYS Backfill — Design

Date: 2026-08-16
Status: approved for planning (revised after adversarial review — see
`../plans/2026-08-16-benchmark-keys-backfill-review.md`)

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
- Never accumulate silent gaps: a day that cannot be generated stops the job for
  manual investigation, and any day that *does* end up with reduced lookback is
  reported rather than buried.
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
- Bearer-token auth on the routes. Single-operator, local-only. Cheap
  confirmation guards are specified instead (see "API surface").

## Corpus facts (measured 2026-08-16)

- 352 committed manifest days, `01022025` → `08142026` (211 in 2025, 141 in 2026).
- Cost: **$0.3685/day** measured across completed days (4–6 LLM calls each).
- Wall clock: ~3.5 min/day of LLM time; ~7 min/day observed end-to-end.
- Full build after the era reset: 352 days ≈ **$130** and **20–40 hours**.
- The corpus is *committed manifest days*, which is a superset of benchmarkable
  days (`POST /benchmark/run` additionally skips days with no candles or an
  incomplete RTH session). The backfill deliberately does **not** apply that
  filter: a day with no candles still supplies lookback continuity to its
  successors. Some of the $130 therefore buys KEYS for days that can never be
  graded.

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
acquire(holder: LockHolder): void;   // throws LockHeldError naming the current holder
release(holder: LockHolder): void;
get heldBy(): LockHolder | null;
```

`BenchmarkService.run()` acquires `'benchmark-run'`; the backfill acquires
`'keys-backfill'` at `start()` and releases it in the loop's `finally`, so the
lock is held for the job's entire lifetime. Either side attempting to start
while the other holds it gets **409** naming the holder. The existing 409
message for a held benchmark run stays byte-identical
(`a benchmark run is already in progress`).

**Two documented limitations.**

*Single process.* The lock is in-memory. `benchmark.schedulerEnabled`
(`BENCHMARK_SCHEDULER=false`) exists precisely to split an API instance from a
worker, and with two processes a run on A and a backfill on B would both succeed
and race. This design assumes a **single backend process**, which is how the
corpus build is operated (one-shot `pnpm start`). Multi-process safety would
require a Firestore lease and is out of scope.

*Eminiplayer writers are not covered.* `POST /eminiplayer/ingest` and
`POST /eminiplayer/backfill` mutate the corpus the job reads and use a separate
guard. The job's `InputsSnapshot` pins `fileSha256` per day, so a concurrent
re-ingest makes `loadDay` throw `day X changed since the run snapshot` — a
*deterministic* failure. Rather than burn three retries on it, the job
classifies a snapshot mismatch as an immediate job-level stop with the message
*"corpus changed mid-job — re-POST to re-snapshot"*. Corollary: days committed
after the snapshot are invisible for the job's lifetime, and picking them up
requires a re-POST.

### 2. Failure policy: retry 3, then stop — with correct classification

**`ensureKeys` never throws.** This is load-bearing and the original design got
it wrong. The real code wraps the whole generation in try/catch and returns
`null`:

```ts
try { result = await this.generate(day, snap); }
catch (err) { this.logger.error(`Seven-keys generation failed for ${day.day}: …`); return null; }
```

So a rate limit, a 5xx, a dead provider file id, a missing methods doc, and a
genuine verifier rejection are all indistinguishable at the call site. The two
pin-anomaly guards also return `null`. A ledger built on "null means the
verifier rejected it" would misdirect every real investigation.

`ensureKeys` therefore gains one additive diagnostic seam — no behaviour change
for existing callers:

```ts
opts?: {
  force?: boolean;
  pinned?: boolean;
  onFailure?: (f: { kind: 'unverified' | 'error' | 'refused'; message: string; mismatches: string[] }) => void;
}
```

invoked from the generation `catch` (`error`), the `!result.verified` branch
(`unverified`, carrying real mismatches), and both pin-anomaly returns
(`refused`).

Attempt policy per day:

| Failure kind | Retryable? | Behaviour |
|---|---|---|
| `unverified` | yes | up to 3 attempts, then stop the job |
| `error` | yes | up to 3 attempts, then stop the job |
| `refused` | **no** | stop immediately — a pin anomaly cannot succeed on retry |
| day timeout | **no** | stop immediately (see below) |
| snapshot mismatch | **no** | stop immediately (corpus changed mid-job) |

Retries **back off** (`benchmark.keysBackfillRetryDelaysMs`, default
`[30000, 180000]`). Without it, `SevenKeysService.withRetry` already fires 3
immediate attempts internally, so one backfill day would be up to 9 provider
calls in a couple of seconds and any 60-second rate-limit window at hour 20
would end a 40-hour run.

**The day timeout does not retry.** `withDayTimeout` can only abandon the
in-flight promise, not cancel it; retrying would leave two or three concurrent
`ensureKeys` chains racing `saveKeysArtifact` on the same day — reopening,
within a single day, the exact wedge the lock exists to close. A day that blows
a 15-minute ceiling is not a transient worth re-racing. The timeout wraps the
**entire attempt body** (`loadDay` → `ensureDayRecorded` → `ensureKeys`), not
just the last call: a hung GCS socket must not park the loop inside an await
that never resolves, which would freeze the job at `running` forever, never
honour `DELETE`, and never release the lock.

Consequence, and a useful invariant: **the KEYS corpus is always a contiguous
prefix** of the corpus in chronological order. A re-POST after the defect is
fixed resumes precisely where it stopped.

### 3. Reuse semantics: durable state lives in the artifacts

Mirrors the eminiplayer backfill's core principle. The job object is in-memory
and disposable; the durable state is the KEYS artifacts in Firestore. Resume is
just a re-POST — reuse *is* the resume mechanism.

**`force` is passed on exactly one branch: regenerating a verified-but-degraded
artifact.** This corrects an earlier revision of this spec, which said the job
never passes `force` at all. That was wrong and self-defeating: `ensureKeys`
reuses any verified artifact whose `inputsHash` still matches, so without
`force` the "degraded → regenerate" decision below is a silent no-op — the old
degraded doc is handed straight back, counted as generated, and the whole run
eliminates nothing. Passing `force` is safe because the pin check returns
**before** `force` is consulted, so a benchmarked day stays frozen regardless.
Clean days never see `force`.

**A day is "already built" only when its artifact is verified AND has empty
`lookbackMissing`.** `saveKeysArtifact` writes `verified: true` even for a
degraded artifact (it logs a warning and stores it anyway), so a reuse rule
testing `verified` alone would skip and permanently freeze exactly the
reduced-lookback artifacts this project exists to eliminate. In a clean
oldest-first build `lookbackMissing` is always empty, so this rule costs
nothing; a non-empty value means the artifact was produced out of order and
should be rebuilt.

*Known divergence from `ensureKeys`.* The real reuse rule inside `ensureKeys`
is `verified && inputsHash === computeInputsHash(...)`. The pre-check cannot
evaluate `inputsHash` without doing the `loadDay` it exists to avoid, so a day
whose trade plan was corrected after its KEYS were built is counted `reused` and
skipped. This is accepted deliberately — the alternative is a bucket download
per already-built day on every resume. Repairing such a day requires
`POST /benchmark/run` with `regenerateKeys: true`. Days written by older code
with no `inputsHash` field at all are treated the same way.

### 4. One-time era reset (prerequisite script)

All 11 existing k3 KEYS artifacts are pinned by scorecard cells, and 4 carry
degraded lookback because they were generated out of order:

| Day | Lookback missing | Pinned by |
|---|---|---|
| `01062025` | `01022025`, `01032025` | 1 keystone-trader cell (aborted-run debris) |
| `08032026` | all 3 priors | 10 scorecard cells (retired `context-*`) |
| `08042026` | 2 of 3 priors | 10 scorecard cells (retired `context-*`) |
| `08052026` | 1 of 3 priors | 10 scorecard cells (retired `context-*`) |

Because a pinned doc is reused **unconditionally — even under `force`** — these
cannot be repaired in place. They are deleted and regenerated fresh in sequence.

**Critical ordering constraint.** Deleting KEYS artifacts while pinning cells
remain triggers `ensureKeys`'s orphaned-pin guard — *"scorecard cells pinned
KEYS hash(es) … that match no stored artifact; refusing to generate … (possible
deleted artifact)"* — permanently wedging those days. The cells must go too.

**And the reconciler can re-create them.** `BatchReconciler`'s cron is enabled
by default and writes `artifactSha256` pins from `customIdToCell` when a batch
drains. If the reset runs while a batch is submitted-but-unreconciled, the
reconciler re-writes pins for the just-deleted artifacts within a minute and
produces the very wedge the reset was meant to prevent.

Scope of the reset script (`backend/scripts/reset-keys-era.mjs`, dry-run by
default, `--apply` to execute):

- **Abort if any non-terminal batch exists.** This is the enforceable
  precondition; a standalone node process cannot observe the in-memory
  `BenchmarkRunLock`, so the original "refuse while the lock is held"
  requirement is dropped as unimplementable. Operator discipline covers the
  lock (do not run the script while a job is running).
- Delete this lineage's KEYS artifacts: `${day}__keys__${alias}`, **plus** any
  legacy unscoped `${day}__keys` doc whose `generatedBy` resolves to the same
  alias. `getKeysArtifact` resolves the legacy id, so a surviving one would be
  seen by the reuse pre-check and silently skip the day.
- Delete exactly the cells whose `artifactSha256` is the `contentHash` of an
  artifact being deleted. Filtering on "has an `artifactSha256`" would delete
  another lineage's scorecard cells — `artifactSha256` is the KEYS hash for
  scorecard cells of *any* model — which is irreversible cross-lineage data
  loss.
- Leave `base` / `seven-keys-method` cells untouched: they record no
  `artifactSha256` and pin nothing.
- Verify real post-conditions: zero surviving KEYS docs for the lineage, and no
  surviving cell pinning a hash that no surviving artifact carries. (Counting
  "cells that still have an `artifactSha256`" is tautological after deleting
  exactly those cells.)

### 5. Unchanged

`LOOKBACK_DAYS` stays 3 and stays hardcoded. Seven-keys prompts, the
current-day/lookback weighting rule, and the fidelity-only verifier are all
untouched. Rationale: lookback has never yet run at full strength, so tuning it
now would be tuning against a degraded 11-artifact sample; the corpus build
itself produces the evidence needed to decide later.

## API surface

```
POST   /benchmark/keys-backfill?confirm=true&from=MMDDYYYY&to=MMDDYYYY
GET    /benchmark/keys-backfill
DELETE /benchmark/keys-backfill?startedAt=<iso>
```

- **POST** → `202` with the initial snapshot. `from`/`to` are optional and
  default to the corpus bounds. `confirm=true` is **required**: a bare POST is
  the shortest thing to type and commits ~$130 and 40 hours, and the
  already-running 409 only protects against a *second* start. `400` on a missing
  `confirm`, a malformed date, or `from > to`; `409` if the lock is held (body
  names the holder).
- **GET** → current or last job snapshot; `404` `"no keys-backfill job has run
  since boot"` when none exists (in-memory state, matching the eminiplayer
  backfill's convention rather than an idle sentinel).
- **DELETE** → request cancellation; the in-flight *attempt* finishes, then the
  job ends `cancelled` and releases the lock. Requires `startedAt` to match the
  running job's, so a stale browser tab or a blind curl cannot kill a 29-hour
  run; `409` on mismatch, `404` when no job exists.

**`from` guard.** Starting mid-corpus silently manufactures degraded keys at the
window's leading edge — the first days would have no prior KEYS — which finding
the reuse rule would then freeze. When `from` is given, the job verifies that
the corpus days immediately preceding it already have KEYS for the lineage, and
stops with `state: 'failed'` naming the missing days if not. (Fewer than
`LOOKBACK_DAYS` priors existing at all — i.e. `from` at the corpus start — is
fine.) The check needs the corpus scan, so it lands as a job-level failure
visible on the next `GET`, not as a synchronous 400.

### Snapshot shape

```ts
interface KeysBackfillSnapshot {
  state: 'running' | 'done' | 'cancelled' | 'failed';
  flagshipAlias: string;          // lineage being built, e.g. 'k3'
  /** Request echoes until the corpus scan resolves them to real bounds. */
  from: string | null;
  to: string | null;
  startedAt: string;
  finishedAt: string | null;
  currentDay: string | null;
  cancelRequested: boolean;
  counts: {
    candidates: number;
    processed: number;             // generated + reused + failed
    generated: number;
    reused: number;
    failed: number;                // 0 or 1 — the job stops on the first
  };
  /** Days whose artifact ended up with a non-empty lookbackMissing. */
  reducedLookback: Array<{ day: string; missing: string[] }>;
  failures: Array<{
    day: string;
    attempts: number;
    kind: 'unverified' | 'error' | 'refused' | 'timeout';
    message: string;
    mismatches: string[];          // populated when kind === 'unverified'
  }>;
  error: string | null;            // job-level stop reason, names the day to investigate
  progress: { avgSecondsPerDay: number | null; etaIso: string | null };
}
```

`progress` averages over the last 10 **generated** days only. A cumulative
average including reused days is worse than no ETA: the common resume case (300
days reused at ~1s, then 52 at ~7min) would report "done in a minute" for a
six-hour job.

## Components

- **`KeysBackfillService`** (`backend/src/benchmark/keys-backfill.service.ts`) —
  the detached singleton job. Owns the snapshot, the sequential loop, retries and
  backoff, cancellation, shutdown hooks, and the per-day timeout.
- **`BenchmarkRunLock`** (`backend/src/benchmark/run-lock.ts`) — the shared
  single-flight guard.
- **`BenchmarkController`** — three new routes delegating to the service.
- **`SevenKeysService`** — one additive `onFailure` opt plus a public
  `lineageAlias` getter.
- **`keys-era-reset.ts` + `reset-keys-era.mjs`** — pure planner (unit-tested
  under `src/`, since jest's `rootDir` is `src`) plus a thin Firestore runner.

### Day loop

The corpus snapshot (`inputs.snapshot()`) is taken **once** per job. It supplies
`methodsDoc`, `general`, and `days`, all of which `ensureKeys` requires. The
traders/features emptiness check lives in `runInner`, not `snapshot()`, so a
keys-only job needs no personas — but `generate` *does* throw
`Seven-keys methods doc missing` when `snap.methodsDoc` is null, so the job
preflights that immediately after the scan and fails as a job-level error rather
than as three opaque day failures.

The job also fails at the job level when the corpus scan yields **zero days** —
a bucket, prefix, or permissions problem must not be reportable as
`done, candidates: 0`.

For each day in range, oldest-first, up to 3 attempts (with backoff between,
and cancellation checked between attempts):

1. **Classify.** One `repo.getKeysArtifact(day, alias)` read. Verified with empty
   `lookbackMissing` → count `reused` and skip the day entirely, doing no bucket
   downloads and no PDF upload. Verified but degraded → log and fall through to
   regeneration. This read is inside the attempt loop, so a transient Firestore
   error is retried rather than killing the job with an empty `failures` array,
   and a late save from a previous attempt is picked up.
2. **Generate,** wrapped as one unit in the per-day timeout: `loadDay` →
   `ensureDayRecorded` → `ensureKeys(…, { onFailure })`.
3. Non-null → count `generated`, and if the returned doc carries a non-empty
   `lookbackMissing`, append it to `reducedLookback`. Null → classify from the
   `onFailure` payload; `refused` and `timeout` break out immediately, others
   retry.

## Error handling

| Condition | Behaviour |
|---|---|
| Verifier rejection (`unverified`) | Retry (≤3) with backoff, then stop the job |
| Generation/infra failure (`error`) | Retry (≤3) with backoff, then stop the job |
| Pin anomaly (`refused`) | Stop immediately — cannot succeed on retry |
| Per-day timeout | Stop immediately; no retry (abandoned work would race) |
| Snapshot mismatch (corpus re-ingested) | Stop immediately with a re-POST instruction |
| Missing methods doc / empty corpus scan | Job-level `failed` before any day runs |
| `SIGTERM` / module destroy | Both `onModuleDestroy` and `onApplicationShutdown` set cancel |
| Process death | Nothing persisted for the in-flight day; re-POST resumes |

Every terminal state releases the lock, and the detached loop's promise is
`.catch()`-guarded so a throw in the `finally` cannot become an unhandled
rejection that kills the process hosting a 40-hour job.

## Testing

Unit tests with fakes, mirroring `eminiplayer-backfill.service.spec.ts`:

- Days processed strictly oldest-first.
- A verified artifact with empty `lookbackMissing` is reused with no LLM call and
  no `loadDay`.
- A verified artifact with non-empty `lookbackMissing` is **regenerated**.
- A day failing twice then succeeding is generated (with backoff awaited).
- A day failing 3× stops the job: `failed`, `error` names the day, mismatches
  captured, **no subsequent day attempted**.
- `refused` and `timeout` stop the job on the first occurrence without retrying.
- A generation error is classified `kind: 'error'`, not `unverified`.
- Cancellation lets the in-flight attempt finish, then ends `cancelled`.
- The lock is released on every terminal state.
- `POST` while a benchmark run holds the lock → 409 naming the holder, and the
  reverse.
- `POST` without `confirm=true` → 400; `DELETE` with a mismatched `startedAt` → 409.
- `GET`/`DELETE` → 404 before any job has run.
- Shutdown hooks request cancellation.
- Empty corpus scan and missing methods doc → job-level `failed`.
- A `from` whose priors lack KEYS → job-level `failed` naming them.
- `reducedLookback` is populated when a generated doc reports missing priors.

## Operational notes

- **Sequence: era-reset script → keys-backfill to completion → benchmark runs.**
  Running the backfill without the reset silently reuses the 11 pinned artifacts,
  4 of them known-degraded.
- Run against a one-shot server (`pnpm start`), never watch mode: job state is
  in-memory and a file-change restart kills it.
- Do not run eminiplayer ingest/backfill concurrently; a re-ingest of any corpus
  day stops the job by design.
- Expect ~$130 and 20–40 hours for the full corpus.
- Poll `GET /benchmark/keys-backfill` for progress, ETA, and `reducedLookback`.
- On `failed`, read `failures[0]` — day, attempt count, `kind`, and (for
  `unverified`) the verifier mismatches are the investigation starting point.
