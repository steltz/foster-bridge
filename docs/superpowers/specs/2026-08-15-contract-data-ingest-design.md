# Per-contract market data ingest & contract-aware backtesting — design

**Date:** 2026-08-15
**Status:** approved design, pre-implementation
**Depends on:** `docs/es-contract-roll-convention.md` (the verified roll rule)

## Problem

The benchmark grades TP setups by backtesting against `markets/MES/min-5` —
a single continuous series with no notion of which quarterly contract a day
belongs to. Eminiplayer TP levels are quoted on a specific ES quarterly
(H/M/U/Z), and adjacent quarterlies trade 40–100+ points apart, so grading
against the wrong series shifts every level by the full spread. The roll
convention is now verified (`docs/es-contract-roll-convention.md`): TP sheets
switch contracts on the **Monday of expiration week**, not CME's
second-Thursday roll date.

The repo has per-contract candle files in `data/` (ES only), and the backtest
must become contract-aware so we are confident every graded day runs against
the contract its TP levels were quoted on.

## Decisions (settled with the user)

1. **Backtest resolves the contract internally.** Callers keep passing
   `symbol: 'ES'` + date; `BacktestService` applies the roll rule and reads
   the resolved contract's candles. Explicit contract symbols also work.
2. **Ingest everything:** both intervals (`min-1`, `min-5`), all contracts,
   both folders (update **and** archive, back to 2008). No liquid-window
   clipping — the existing RTH-coverage gate keeps junk days out of backtests.
3. **ES economics:** grade at ES's real \$50/pt (previous MES runs will be
   deleted; continuity with them is worthless).
4. **Benchmark switches to `min-1`** as its backtest interval.
5. **Ingest mechanism:** detached local-read job endpoint (approach A) — the
   backend reads `data/` off disk; no multipart uploads, no driver script.

## Non-goals (explicitly out of scope)

- Deleting `markets/MES/min-5` and the benchmark runs that used it (separate
  future task). **Ordering constraint this design does depend on:** benchmark
  cells carry no symbol/interval in their key, and the scoreboard groups by
  `(trader, alias, variant)` — so old $5/pt MES cells and new $50/pt ES cells
  would silently average into the same rows. The MES cells must be retired
  (manual Firestore op) and in-flight batches drained **before the first
  post-flip `POST /benchmark/run`**; the deletion itself can still happen
  later. New cells record `result.contract` (see §5), which makes any
  accidental mixing diagnosable after the fact.
- The TP prev-day-summary runtime assertion (~2-pt tolerance tripwire from
  the roll-convention doc). Follow-up feature; this design leaves an obvious
  seam for it (the backtest response records which contract was used).
- ~~Volume storage~~ *(superseded 2026-08-16: volume from the txt files IS
  now stored — required on every txt-sourced candle, persisted as `v` on the
  day-doc; the CSV upload path stays volume-less since its format has no
  volume column)*. Original rationale: the day-doc schema stays OHLC-only;
  `data/` files on disk
  remain the volume source if ever needed (they were only needed offline, to
  verify the roll rule).
- Quarterly resolution for NQ/MNQ (no per-contract data exists for them; the
  design makes ES the only roll-resolved base but doesn't hard-code against
  extending later).

## Design

### 1. Contract identity & resolution (`backend/src/contracts/`)

**Naming.** Quarterly contracts are addressed as `<base><monthCode><yy>`:
`ESH25`, `ESM26`, `ESU27`, … Month codes H/M/U/Z = Mar/Jun/Sep/Dec. Derived
mechanically from the data filenames (`ES_U26_1min.txt` → `ESU26`).

**Spec derivation.** `ContractsService.get(symbol)` learns to recognize a
quarterly symbol: `/^ES[HMUZ]\d{2}$/` → returns the base `ES` spec with
`symbol` set to the quarterly code (same \$50 pointValue, 0.25 tick, ET
timezone, same RTH window). Unknown symbols still 404. The static registry
(`MES`/`ES`/`NQ`/`MNQ`) is unchanged.

**Resolution.** New pure function in the contracts module:

```
resolveContract(base: 'ES', date: string /* YYYY-MM-DD */): string  // e.g. 'ESM26'
```

Rule (verified against all six 2025–2026 rolls):

1. Candidate contract month = the nearest quarterly month (Mar/Jun/Sep/Dec)
   at or after the date's month (April → June; December → December).
2. Candidate's expiration = third Friday of that month; switch day =
   expiration-week Monday = third Friday − 4 days.
3. `date <` switch Monday → the candidate contract.
   `date >=` switch Monday → the **next** quarterly (Dec rolls into next
   year's Mar).

Pure calendar math, no I/O, no timezone dependency (dates are ET calendar
days end to end). Table-driven unit tests over all 12 verified boundary rows
from `docs/es-contract-roll-convention.md` (e.g. 2026-06-12 → `ESM26`,
2026-06-15 → `ESU26`), plus year-boundary (Dec→Mar) and the switch-Monday ==
date edge itself.

### 2. Storage layout (`backend/src/market-data/`)

Day-docs move to per-contract collections, same doc schema as today:

```
markets/ESU26/min-1/{YYYY-MM-DD}
markets/ESU26/min-5/{YYYY-MM-DD}
```

`getDay`/`listStoredDays`/`upsertDay` are unchanged except that
`validate()`'s symbol check now passes for quarterly symbols (via the
`ContractsService.get` extension above). The existing multipart CSV upload
endpoint keeps working for any valid symbol, including quarterlies.

**New parser** (`parseContractTxt` alongside `parseCsv`): the local format is
headerless `YYYY-MM-DD HH:MM:SS,open,high,low,close,volume` with ET-naive
timestamps. Conversion ET→epoch uses `America/New_York` (DST-correct; unit
test spans a DST transition day). Volume is required on every parsed candle
and stored as `v` in the day-doc *(amended 2026-08-16; originally
parsed-and-dropped)*.
Malformed rows fail the file (all-or-nothing per file), matching the repo's
reject-don't-guess validation posture.

### 3. Ingest job (`backend/src/market-data/`)

```
POST /markets/ingest-contracts        202; detached job (409 if already running)
GET  /markets/ingest-contracts        current/last job snapshot
```

Mirrors the eminiplayer backfill job pattern (in-memory job state, ledger of
per-file outcomes, no persistence of job state across restarts). Because the
state is in-memory only, the job **must run against a one-shot server**
(`pnpm start`), never watch mode — a dev-mode restart kills the loop silently
and `GET` then reports `{ state: 'idle' }`, which after a restart means "the
job died; re-POST" (safe: upserts are idempotent).

Behavior:

- Discover directories by pattern, not by name: `readdirSync(<repoRoot>/data)`
  filtered to `/^ES_(1min|5min)_(archive|update)_/` — the trailing suffix is
  an opaque export token and must not be hardcoded. Archive dirs are ordered
  before update dirs. Within each dir, walk `ES_<code>_<interval>.txt`;
  files that don't match the pattern are reported as skipped, not errors.
  **Zero contract files found fails the POST** (422) rather than reporting a
  vacuous `done` — a misconfigured root must not look like success.
- Per file: parse, group candles by ET calendar day, upsert each day through
  the existing transactional `upsertDay` (idempotent; re-running the job on
  unchanged files is a no-op per day).
- Update dirs are processed **after** archive dirs so that, should both ever
  contain the same contract, update (fresher) wins last-write. (Today there
  is no overlap — archive holds ≤ Z24, update holds H25–U27 — so the
  ordering is future-proofing, not a present case.)
- Status payload: per-file `{ file, contract, interval, days, added, updated,
  error? }` plus running totals (`error` present iff the file failed). A file
  failure doesn't stop the job; it's recorded and the job continues (per-file
  all-or-nothing, job-wide keep-going).
- Scale expectation: 158 files, ~590MB, order 10⁴–10⁵ day-docs. Parse
  file-by-file (full read per file — largest is ~7.6MB), batch day upserts
  sequentially per file. Each upsert is a Firestore transaction round-trip,
  so the full run takes **one to several hours** — plan operations
  accordingly. No concurrency tuning unless it proves too slow in practice
  (YAGNI).

### 4. Backtest resolution (`backend/src/execution/`)

In `BacktestService.run`:

- If `req.symbol` is a **roll-resolved base** (exactly `'ES'` for now):
  `contract = resolveContract('ES', req.date)`, candles read from
  `markets/{contract}/{interval}/{date}`, spec/pointValue from the base
  (identical by derivation).
- If `req.symbol` is an explicit quarterly (`ESU26`): used as-is, no
  resolution.
- Any other symbol (`MES`, `NQ`, …): exactly today's behavior.
- The response gains `contract: string` — the concrete contract the
  simulation ran against (equal to `symbol` for non-resolved symbols).
  **This does not reach stored cells by itself**: the reconciler builds
  `CellResult` by explicitly enumerating fields off `bt.results[0]`, so §5
  requires an explicit persistence step. Once persisted, the stored
  `result.contract` is the seam the future prev-day assertion plugs into.
- Resolution failures for regex-valid but calendar-invalid dates
  (`2026-13-01`) are rethrown as `BadRequestException` — the endpoint's 400
  surface, never a 500.

No changes to the engine, orders, session/coverage logic — `min-1` flows
through the existing interval-generic code paths.

### 5. Benchmark switch (`backend/src/benchmark/`)

- `batch-reconciler.ts`: `SYMBOL = 'ES'`, `INTERVAL = 'min-1'`.
- `benchmark.service.ts`: same two constants updated (it uses them for
  day-data availability checks and coverage math).
- Grading config (rrFloor, qty, management) unchanged; PnL is now real ES
  dollars at \$50/pt via the ES spec.
- `CellResult` gains an explicit `contract?: string` field, and the
  reconciler explicitly persists `bt.contract` into it when building the
  cell (it enumerates fields off `bt.results[0]`, so nothing carries over
  implicitly). Additive, no migration needed; asserted by a reconciler spec.
- `benchmark.service.ts` reads candles directly (`getDay`) for its
  availability/coverage pre-check — a direct store read does not pass
  through backtest resolution, so it resolves the per-day contract itself.
- The two benchmark e2e suites (`test/benchmark.e2e-spec.ts`,
  `test/benchmark-scorecard.e2e-spec.ts`) seed `markets/MES/min-5` today;
  they move to seeding the resolved contract on the min-1 grid, and
  `pnpm test:e2e` joins the verification steps (the default `pnpm test`
  never runs `backend/test/`).

## Error handling

- Backtest on a date whose resolved contract has no stored day → existing
  404 (`No stored candle data for ESU26 min-1 2026-06-16`) — the message now
  names the contract, which is the diagnostic that matters.
- Backtest on a sparse pre-liquidity day → existing 422 coverage gate
  (unchanged behavior, now per-contract).
- Ingest: malformed row → file marked failed with line context, job
  continues. Unknown filename shape → skipped, listed in status.
- Resolution is total for valid dates (every date maps to some contract);
  invalid date format → existing 400; regex-valid but calendar-invalid
  dates → 400 via the rethrow in §4, not a 500.

## Testing

- **`resolveContract`**: table-driven over the 12 verified boundary rows +
  Dec→Mar year rollover + exact switch-Monday dates for all four quarters.
- **Parser**: happy path, DST-transition day (ET→epoch correctness), malformed
  row rejection, volume column tolerated-and-dropped.
- **ContractsService**: quarterly symbol recognition, derivation equals base
  spec, unknown symbol still 404s.
- **Backtest**: `'ES'` resolves and echoes `contract`; explicit `ESU26`
  bypasses resolution; `MES` untouched; resolved-but-missing day 404s with
  contract in message.
- **Ingest job**: filename mapping, idempotent re-run (second run reports
  unchanged), archive-then-update ordering, per-file failure isolation.
- **Reconciler**: existing specs updated for `ES`/`min-1` constants.

## Rollout

0. Pre-flip gate: drain in-flight benchmark batches (`GET /benchmark/status`
   empty) before deploying the constant flip, and retire the MES cells
   before the first post-flip `POST /benchmark/run` (see Non-goals for why).
1. Land code; run `POST /markets/ingest-contracts` once against production
   Firestore from a **one-shot** server process (idempotent, safe to re-run
   after interruptions; expect one to several hours).
2. Spot-check: `GET /markets/ESU26/min-1/days` shows the liquid window with
   `complete: true` days; a known TP day backtests with the expected
   `contract` echo.
3. Benchmark runs from then on grade against per-contract ES data. (MES
   cleanup happens later, separately.)
