# Persisted Random Day Samples — Design

Date: 2026-08-16
Status: Approved design, pre-implementation

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

- The eminiplayer knowledge bucket currently holds **352 committed days**
  (211 in 2025, 141 in 2026). Candle data extends back to 2008, but a day is
  only benchmarkable when its knowledge manifest is committed, so the sample
  pool is the intersection of both.
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
  1. Takes the cloud-inputs snapshot's day listings (committed manifests).
  2. Optionally filters to the `from`/`to` day-key range (`MMDDYYYY`,
     compared by calendar date, both bounds inclusive; either bound may be
     given alone).
  3. Filters to days with complete candle coverage, using exactly the run's
     own prerequisite: `resolveContract('ES', date)` →
     `marketData.getDay(contract, 'min-1', date)` → non-empty and
     `analyzeCoverage(candles, rthWindow).complete`. This guarantees every
     sampled day actually runs instead of landing in `daysSkipped`.
  4. Validates `count <= pool.length`, else **422** naming both numbers.
  5. Draws `count` days uniformly without replacement (Fisher–Yates partial
     shuffle), sorts them chronologically, and persists.
  6. **409** if the name already exists (Firestore `create()`, same
     mechanism as personas).
- `list()` — summaries: name, day count, pool size, first/last day,
  createdAt.
- `get(name)` — the full document; **404** if absent.

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

Repository methods: `createSample(doc)` (create-only, throws on existing),
`getSample(name)`, `listSamples()`. Folded into the existing
`BenchmarkRepository` rather than a new repository class — it is two reads
and a create against one collection.

### 3. HTTP endpoints (`benchmark.controller.ts`)

```
POST /benchmark/samples          body: { name, count?, from?, to? }
                                 201 → the created doc
                                 409 name exists · 422 count > pool
GET  /benchmark/samples          200 → summaries
GET  /benchmark/samples/:name    200 → full doc · 404 unknown
```

`name` is required and must be a non-empty slug (`[a-z0-9-]+`); **400**
otherwise.

### 4. Run integration (`benchmark.service.ts`)

`RunOptions` gains `sample?: string`, exposed through the controller body.

- `sample` and `days` together → **400** (mutually exclusive; a sample *is*
  a days filter).
- When `sample` is set, the service loads the doc (404 →
  `NotFoundException`) and proceeds exactly as if `opts.days` had been the
  sample's day list. Everything downstream — top-up semantics, drift guard,
  single-flight lock, variant defaulting, `daysSkipped` reporting — is
  unchanged.
- A sampled day absent from the current snapshot (e.g. a manifest was
  removed later) becomes a silent non-match, consistent with how an unknown
  explicit `days` entry behaves today. Days that lost candle coverage since
  sampling surface as `daysSkipped` through the existing per-day checks.

## Error handling summary

| Condition | Response |
|---|---|
| Sample name exists | 409 (write-once, like personas) |
| `count` exceeds eligible pool | 422 with both numbers |
| Invalid/missing `name`, bad `count`/range | 400 |
| `sample` + `days` on run | 400 |
| Unknown `sample` on run | 404 |
| Unknown sample on `GET /benchmark/samples/:name` | 404 |

## Testing

TDD throughout, following existing spec patterns (fake repo/inputs/market
data, `analyzeCoverage` mocked):

- **SamplesService**: draws exactly `count` distinct days from the pool;
  excludes days failing candle/coverage checks; honours `from`/`to`; sorts
  output chronologically; 422 on count > pool; 409 propagates from
  repository create; list/get pass-throughs.
- **Randomness**: with a mocked shuffle, the drawn set is deterministic;
  without mocking, assert only set-membership and size (no flaky
  distribution assertions).
- **Run integration**: `run({ sample })` filters days to the sample's list;
  `run({ sample, days })` rejects with 400; unknown sample rejects with 404.
- **Controller**: route wiring and body validation.

## Explicitly out of scope

- No seed persistence or replayable RNG.
- No sample editing, deletion, or versioning endpoints — new era, new name.
- No scoreboard changes: cells record days as before; sample membership is
  not part of the cell key or scoreboard grouping.
- No automatic "top up the sample when new years arrive" — growth is a new
  sample by an explicit `POST`.
- Running the first benchmark over the sample (deferred at the user's
  request; the first sample itself — 100 days, 2025–2026, name chosen at
  creation — is created after implementation).

## Documentation

`CLAUDE.md` gains the three endpoints and the `sample` run parameter under
the benchmark section.
