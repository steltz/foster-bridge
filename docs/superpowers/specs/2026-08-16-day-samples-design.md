# Persisted Random Day Samples — Design

Date: 2026-08-16
Status: Approved design, revised after adversarial review
(`docs/superpowers/plans/2026-08-16-day-samples-review.md`), pre-implementation

## Purpose

Benchmark runs need a fixed, reusable set of test days so that every future
persona and variant is graded against the *same* days, keeping scoreboard
rows comparable across eras. Today `POST /benchmark/run` either takes an
explicit `days` list or runs every complete day; there is no durable notion
of "the 100 days we test against."

This feature adds **persisted random day samples**: a named, write-once
Firestore document holding a uniformly-drawn random subset of the
benchmarkable days, plus a `sample` parameter on `POST /benchmark/run` that
resolves to that day list.

## Context and constraints

- As of 2026-08-16 (per a live bucket listing — the corpus is cloud-only
  and this number moves), the eminiplayer knowledge bucket holds **352
  committed days** (211 in 2025, 141 in 2026). Candle data extends back
  further, but a day is only benchmarkable when its knowledge manifest is
  committed, so the sample pool is the intersection of both.
- The first sample will be **100 days** drawn from the 2025–2026 pool. As
  more knowledge years are ingested later, *new* samples get created over
  the larger pool; existing samples never change.
- Reproducibility comes from **persisting the drawn days**, not from a seed.
  No seed is stored; the sampler may use any randomness source.
- Samples follow the project's write-once content rule (same as personas):
  once created, a sample is immutable — refining means a new name. This
  keeps recorded benchmark cells meaning what they meant when they ran.

## Components

### 1. `SamplesService` (`backend/src/benchmark/samples.service.ts`)

One public method per endpoint:

- `create({ name, count = 100, from?, to? })`
  1. Validates inputs (see **Validation** below) — all failures are 400s
     that fire before any I/O.
  2. **Early duplicate check**: `getSample(name)` — 409 if it exists,
     *before* computing the pool, so a retried request fails fast. The
     race-safe authority remains Firestore `create()` at persist time.
  3. Builds the eligible pool (see **Eligibility** below).
  4. Validates `count <= pool.length`, else **422** with diagnostics:
     the message names the requested count, the eligible pool size, the
     in-range committed-day count, and the complete-candle-day count, so a
     zero pool is self-diagnosing.
  5. Draws `count` days uniformly without replacement (partial
     Fisher–Yates), sorts them chronologically, and persists.
  6. **409** if the name was created concurrently (Firestore `create()`
     ALREADY_EXISTS, gRPC code 6 — same mechanism as personas).
- `list()` — summaries: name, day count, pool size, first/last day,
  createdAt.
- `get(name)` — validates the name (400), then the full document; **404**
  if absent.

### Eligibility

The pool is the intersection of two cheap listings — no per-day candle
document reads:

1. **Committed knowledge days**: a new narrow
   `CloudInputsService.listDays()` that runs only the manifest scan
   (`scanDays()`), wrapped in the same fail-closed `wrap()`. Sampling must
   NOT call `snapshot()` — that would drag trader/feature/general-doc
   reads (and their 503s) into an operation that needs none of them.
2. **Complete candle days**: group the in-range listing dates by
   `resolveContract('ES', date)` (a handful of quarterlies for any
   two-year span), and for each contract call
   `MarketDataService.listStoredDays(contract, 'min-1')` — one projected
   Firestore query per contract returning `{ date, complete }`, where
   `complete` is the stored `coverage.rthComplete` **written at ingest by
   the same `analyzeCoverage` the benchmark run uses**. A day is eligible
   iff its date appears in its contract's listing with `complete: true`.

This removes the dominant skip causes (no candles / incomplete session)
for sampled days. It is deliberately **not** a guarantee that every
sampled day runs: a day can still skip at run time for run-only reasons
(missing docs discovered at load, keys-generation failure, per-day
errors) — those are reported, see §4.

**Mid-scan failure rule**: any error during pool construction aborts the
whole `create` — a sample is only ever drawn from a fully-scanned pool.
No partial pools, no silently-shrunken `poolSize`. (An aborted create
persists nothing, so a retry is safe.)

### Validation (shared)

- `name`: must be a string matching `^[a-z0-9][a-z0-9-]*$` and ≤ 64
  characters. Enforced by one private `assertName()` used by `create`,
  `get`, **and** the run's `sample` resolution — user input never reaches
  a Firestore document id unvalidated (no `..`, no slashes, no over-long
  ids surfacing as 500s).
- `count`: integer ≥ 1 (`typeof` checked; non-numbers are 400, not
  TypeErrors).
- `from`/`to`: strings that are **real calendar dates** in `MMDDYYYY`,
  validated with the exported `dayTime()` from
  `backend/src/eminiplayer/eminiplayer-validation.ts` (the shared "is
  this even a day?" helper every corpus walker uses — returns `null` for
  shape-invalid and non-real dates, so `13322025` and YYYYMMDD inputs are
  rejected instead of silently mis-filtering and being persisted wrong
  into an immutable doc). Both bounds inclusive; either alone is fine;
  `from > to` is a 400 (mirroring `eminiplayer.controller.ts`'s range
  endpoints). Bodies arrive unvalidated (there is no global
  `ValidationPipe`), so every field is `typeof`-guarded before use.

### 2. Persistence (methods added to `BenchmarkRepository`)

New Firestore collection `samples`, document id = sample name:

```
samples/{name}: {
  name: string,
  days: string[],          // MMDDYYYY keys, sorted chronologically
  requestedCount: number,
  poolSize: number,        // eligible days at creation time
  from: string | null,     // requested range bound, if any
  to: string | null,
  createdAt: ISO string,
}
```

Repository methods: `createSample(doc)` (create-only; surfaces the raw
code-6 error for the service to map), `getSample(name)`, `listSamples()`.
Folded into the existing `BenchmarkRepository` — two reads and a create
against one collection.

### 3. HTTP endpoints (`benchmark.controller.ts`)

```
POST /benchmark/samples          body: { name, count?, from?, to? }
                                 201 → the created doc
                                 400 invalid name/count/range · 409 name
                                 exists · 422 count > pool (with diagnostics)
GET  /benchmark/samples          200 → summaries
GET  /benchmark/samples/:name    200 → full doc · 400 invalid name · 404 unknown
```

The controller methods are thin pass-throughs; all validation and error
mapping lives in `SamplesService`.

**Module wiring** (load-bearing): `BenchmarkController` is declared in
`AppModule`, not `BenchmarkModule`, so `SamplesService` must be added to
`BenchmarkModule`'s **`exports` as well as `providers`** — providers alone
leaves the controller unresolvable and the app fails to boot. Because unit
specs hand-provide fakes, only the e2e suite (`pnpm test:e2e`, which boots
`AppModule`) catches wiring mistakes — it is a required verification step.

### 4. Run integration (`benchmark.service.ts`)

`RunOptions` gains `sample?: string`, exposed through the controller body.

- Resolution happens in `run()`, **before** the single-flight lock, the
  snapshot, and the drift guard — so a malformed request can never surface
  as a drift 409 or an in-progress 409, never costs a corpus read, and
  never holds the run lock:
  - `sample` and `days` together → **400** (mutually exclusive; a sample
    *is* a days filter).
  - Invalid `sample` name (per `assertName`) → **400**.
  - Unknown sample → **404**.
  - A resolved sample whose `days` is empty → **422** (fail closed — an
    empty filter must never fall through to a full-corpus run).
- The resolved day list then behaves as the days filter; everything
  downstream — top-up semantics, drift guard, variant defaulting,
  `daysSkipped` reporting — is unchanged.
- **Missing-day observability**: when `sample` is set, any sampled day
  with no matching snapshot listing is reported in
  `summary.daysSkipped` with `reason: 'sample day not in snapshot'` (and
  day-issue listings keep their existing `missing docs` reporting). A run
  that graded 94 of 100 sampled days must say so — silent shrinkage would
  make the scoreboard row quietly non-comparable, defeating this
  feature's purpose.

## Error handling summary

| Condition | Response |
|---|---|
| Sample name exists (early check or create race) | 409 (write-once, like personas) |
| `count` exceeds eligible pool | 422 with pool diagnostics |
| Invalid/missing/non-string `name`, bad `count`, non-date or inverted range | 400 |
| `sample` + `days` on run | 400 (checked before the run lock) |
| Unknown `sample` on run | 404 (checked before the run lock) |
| Resolved sample with empty `days` | 422 |
| Unknown sample on `GET /benchmark/samples/:name` | 404 |
| Any error during pool construction | aborts create; nothing persisted |

## Testing

TDD throughout, following existing spec patterns (fake repo/inputs/market
data). ts-jest runs with diagnostics on, so red-phase failures for
not-yet-implemented symbols are **TypeScript compile errors** (TS2339 /
TS2353), not runtime "is not a function" — plans and executors must expect
that.

- **SamplesService**: draws exactly `count` distinct days; eligibility
  intersects manifests with per-contract `listStoredDays` completeness;
  honours inclusive `from`/`to`; rejects non-dates, YYYYMMDD, inverted
  ranges, non-string fields (400); early-409s an existing name without
  computing the pool; 422 with diagnostics on count > pool; sorts output
  chronologically; deterministic under a mocked `Math.random`.
- **CloudInputsService.listDays()**: returns the scan result without
  touching traders/features/general.
- **Run integration**: sample resolves to the days filter; `sample`+`days`
  → 400 and unknown → 404 *without* taking the lock or reading the
  snapshot; empty-days sample → 422; missing sampled days reported in
  `daysSkipped`.
- **e2e (`pnpm test:e2e`)**: boots `AppModule` (catching module wiring),
  exercises the three routes over HTTP with supertest — 201/200/404/409/400
  — proving decorators, param binding, and error pass-through.

## Explicitly out of scope

- No seed persistence or replayable RNG.
- No sample editing, deletion, or versioning endpoints — new era, new name.
- No scoreboard changes: cells record days as before; sample membership is
  not part of the cell key or scoreboard grouping.
- No automatic "top up the sample when new years arrive" — growth is a new
  sample by an explicit `POST`.
- Running the first benchmark over the sample (deferred at the user's
  request). The first sample itself is created after implementation; its
  `poolSize` is read off the response, not assumed from the day counts
  above.

## Documentation

`CLAUDE.md` gains the three endpoints and the `sample` run parameter under
the benchmark section.
