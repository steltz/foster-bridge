# Market-Data + Trade-Execution NestJS Modules — Design

**Date:** 2026-07-26
**Status:** Approved
**Location:** `backend/` (the existing NestJS app)

## Goal

Port the CLI's trade-execution engine into the NestJS backend as a heavily
unit-tested module, and introduce a Firestore-backed market-data model that
stores OHLC time series for multiple futures contracts (MES, ES, NQ, …). Provide
a CSV-upload ingest path that folds new candle data into Firestore idempotently,
and gate backtests so they never run on incomplete session data.

This is a single cohesive design (the candle model is the shared interface
between the two modules) delivered in three implementation phases.

## Non-Goals

- No changes to the existing CLI (`src/`) or the skills that shell out to it
  (`trader-panel`, `trader-bench`). The backend gets its own behavior-exact port
  of the engine; the CLI keeps working unchanged. Unifying them onto shared code
  is a possible later effort.
- No market-calendar of early-close ("half") days in this iteration — see
  *Known Limitations*.
- No indicator/SMC columns stored — OHLC only.
- No migration of the skills to call the backend over HTTP.
- No Firebase Auth / authz on the new endpoints beyond what the app already has.

## Established Conventions (followed exactly)

The backend is a standard NestJS 10 app (not Nx), pnpm, Jest + ts-jest. New code
follows the existing patterns:

- One folder per concern under `backend/src/` (`firebase/`, `anthropic/`,
  `common/`, `config/`, `health/`, `demo/`).
- DI tokens as `Symbol`s in `*.constants.ts`; external clients provided via
  `useFactory`, never `new`-ed in services.
- `@Global()` modules for anything exposing app-wide tokens/services.
- Services inject the raw Firestore handle via `@Inject(FIRESTORE)` — there is no
  wrapper service around Firestore.
- Lightweight inline `interface` DTOs in controllers (no `class-validator`).
- Controllers registered centrally in `app.module.ts`.
- Co-located `*.spec.ts` unit tests; Firestore mocked via
  `{ provide: FIRESTORE, useValue: fakeFirestore }`. e2e tests in `backend/test/`
  using supertest.
- Firestore/Google errors normalized by the existing global `GoogleErrorFilter`.

## Architecture Overview

Three new folders under `backend/src/`:

1. **`contracts/`** — the contract registry (static config, no Firestore).
2. **`market-data/`** — Firestore OHLC time-series storage + CSV ingest.
3. **`execution/`** — the pure engine + backtest orchestration + endpoint.

Plus shared pure time helpers added to the existing **`common/`** folder.

### Data flow

- **Ingest:** CSV → `MarketDataController` (multipart) → `MarketDataService.ingestCsv`
  (parse → group by ET day → per-day transactional merge-upsert → recompute
  coverage → write) → Firestore day-docs.
- **Backtest:** `POST /backtest` → `BacktestService.run` → `MarketDataService.getDay`
  (Firestore) + `ContractsService.get` → coverage gate → `ExecutionEngine.simulate`
  → `{ results, summary, meta }`.

## 1. Contract Registry (`contracts/`)

Static, version-controlled TypeScript config. Specs rarely change and this keeps
the module dependency-free and trivially testable. (Migratable to Firestore later
if runtime editing is ever needed.)

```ts
interface ContractSpec {
  symbol: string;          // 'MES' | 'ES' | 'NQ' | 'MNQ' | ...
  name: string;            // 'Micro E-mini S&P 500'
  pointValue: number;      // MES 5, ES 50, NQ 20, MNQ 2 — the old --multiplier
  tickSize: number;        // 0.25
  currency: string;        // 'USD'
  timezone: string;        // 'America/New_York'
  rth: { open: string; close: string }; // '09:30' / '16:00'
}
```

- `contracts.constants.ts` — the `CONTRACTS` map keyed by symbol. Seed with
  MES, ES, NQ, MNQ (more added as needed).
- `ContractsService` — `get(symbol)` (throws `NotFoundException` on unknown),
  `list()`, `has(symbol)`.
- `ContractsModule` — `@Global()`, exports `ContractsService`.
- **Tests:** known symbols resolve with correct `pointValue`/`rth`; unknown
  throws; `list()` returns all seeded contracts.

## 2. Market-Data Module (`market-data/`)

### Firestore layout — one document per trading day

Path: `markets/{symbol}/{interval}/{YYYY-MM-DD}` where `{interval}` (e.g.
`min-5`) is the subcollection name and the day-doc id is the ET calendar day.

Day-doc shape (compact candle keys keep docs small; the service maps to/from the
canonical engine `Candle`):

```ts
{
  symbol: 'MES', interval: 'min-5', date: '2026-07-14', // ET calendar day
  candles: [ { t, o, h, l, c }, ... ],  // sorted asc by t, deduped by t
  count, firstTime, lastTime,
  coverage: {                            // computed on every write
    rthComplete: boolean,
    rthExpectedCount, rthPresentCount,
    hasOpen, hasClose,
  },
  updatedAt,                             // serverTimestamp
}
```

Rationale for day-chunking: reads and writes are ~1 doc per day (vs 78–288× with
doc-per-candle); the "which days are stored / complete" question is answered by
`listDocuments()` ids + a stored flag with **no candle reads**; day-docs stay far
under the 1 MiB limit for every interval down to 1-minute (~1,440 candles ≈
60 KB). Access is day-aligned — the engine simulates a session at a time.

### Canonical types

- `Candle { time: number; open; high; low; close }` — canonical, defined here,
  imported by `execution/`. `time` is Unix epoch **seconds**.
- Storage row `{ t, o, h, l, c }` is a compact projection; `MarketDataService`
  owns the mapping both ways.
- `Interval` — a validated string set (`min-1`, `min-5`, `min-15`). Every
  supported interval must evenly divide the RTH window (390 min), so completeness
  is a whole number of bars. `min-60` is deliberately **excluded**: 09:30–16:00 is
  6.5 hours, not a whole number of hourly bars, so it can never be "complete"
  against RTH. `intervalToSeconds()` lives in `candle.ts`.

### CSV parsing — `csv-parser.ts` (pure)

Behavior-exact port of `src/parse-csv.js`:

- Required columns (case-insensitive): `time, open, high, low, close`. Extra
  TradingView indicator columns are ignored/dropped.
- Each row → `Candle` (all `Number`); `time` parsed as epoch seconds.
- Result sorted ascending by `time`.
- Throws on a missing required column or an unparseable numeric cell (surfaced as
  HTTP `400`).

### Ingest — idempotent per-day merge-upsert

`MarketDataService.ingestCsv(symbol, interval, csvText, { replace=false }) → IngestSummary`

1. Validate `symbol` (via `ContractsService`, `404` if unknown) and `interval`
   (`400` if not allowed).
2. Parse CSV → candles. **Validate interval alignment:** every candle's `time`
   must be a multiple of `intervalToSeconds(interval)` (`400` otherwise). This
   rejects mislabeled uploads — e.g. 1-minute data pushed to the `min-5`
   subcollection — before they silently enter the store and render every day
   "incomplete". (A merely-truncated or gappy day still aligns to the grid and is
   accepted; incompleteness is the coverage util's job, not ingest's.) Then group
   by ET calendar day (`dateForTimestamp`).
3. For each day, in a **Firestore transaction** on the day-doc:
   - `replace=false` (default): **merge** the day's candles into the existing
     doc keyed by `t` (a same-`t` CSV candle overwrites the stored one), re-sort.
   - `replace=true`: replace the day's candles wholesale (for correcting bad
     data).
   - Recompute `count/firstTime/lastTime/coverage`; write back.
   - If the merge yields no change, **skip the write** (reported `unchanged`).
4. Return `IngestSummary`: `totalRows`, and per-day
   `{ date, added, updated, unchanged: boolean, totalAfter, complete }`.

**Ingest retains the full 24h session, not just RTH.** Every candle in the CSV
is stored — overnight/pre-market/post-market Globex bars included (a complete
MES weekday is ~276 five-minute bars ≈ 23h, not the 78 RTH bars). RTH is only a
*lens*: it drives the completeness flag (below) and the backtest's run-time
window. Because every raw candle is retained, the day-bucketing choice is
**non-lossy and fully reversible** — the data can be re-keyed by any session
definition later without re-ingesting. See the trade-date follow-up under *Known
Limitations*.

### Read APIs

- `listStoredDays(symbol, interval) → { date, count, complete }[]` — via
  `listDocuments()` / a projected `get()`, cheap, no candle payloads where
  avoidable.
- `getDay(symbol, interval, date) → Candle[] | null`.

### Coverage / gap utility — `coverage.ts` (pure)

Shared by ingest (to store the flag) and backtest (source-of-truth gate).

```ts
analyzeCoverage(candles, { openMin, closeMin, intervalSec, tz }) → {
  complete: boolean,
  expectedCount, presentCount,
  hasOpen, hasClose,                 // starts at open & ends at close-interval
  gaps: [{ afterTime, missing }],    // interior gaps: epoch + bars missing
}
```

**Algorithm (DST-safe, no epoch-grid construction):** using
`minutesOfDayForTimestamp` on the actual candle times, verify (1) the first
candle's local minute == RTH open (e.g. 09:30 → 570), (2) the last candle's local
minute == close − interval (e.g. 15:55 → 955), (3) every consecutive pair differs
by exactly `intervalSec`. `complete` = all three. Reading local minutes off real
timestamps is robust to DST because DST transitions never fall inside RTH.
Detects both truncated sessions and interior dropped bars. Candles outside the
RTH window are ignored for the RTH judgement. Precondition: `(closeMin − openMin)`
must be divisible by the interval minutes (guaranteed by the supported-interval
set above); `analyzeCoverage` asserts this defensively so a future incoherent
interval fails loudly rather than reporting perpetual incompleteness.

### Controller — `MarketDataController`

- `POST /markets/:symbol/:interval/candles` — multipart file upload
  (`FileInterceptor`, in-memory buffer), optional `?replace=true` →
  `IngestSummary`. Requires `@types/multer` (dev dep); `@nestjs/platform-express`
  is already present.
- `GET /markets/:symbol/:interval/days` — stored days with `count` + `complete`.
- `GET /markets/:symbol/:interval/candles?date=YYYY-MM-DD` — one day's candles.

### Module

`MarketDataModule` provides/exports `MarketDataService`, registers the
controller, depends on `ContractsService` (global) and `FIRESTORE`.

## 3. Trade-Execution Module (`execution/`)

The engine stays **pure** — this is the agent-evaluation core and the primary
unit-testing target.

### Shared time helpers — `common/session-time.ts` (pure)

Ported from `src/session.js`: `dateForTimestamp`, `minutesOfDayForTimestamp`,
`filterDay`, `filterTimeWindow`, `latestDate`. Used by both `market-data/`
(day grouping, coverage) and `execution/` (session filtering).

### `engine.ts` (pure) — behavior-exact port of `src/engine.js`

`simulateOrder(order, candles, options)` and `simulate(candles, orders,
multiplier, options)`, plus `slHitsFirst`. Preserves every rule: resting-limit
fills, "armed" gating, entry time window, stop/target detection, the
ambiguous-candle candle-shape heuristic, EOD close, `NOT_FILLED`, `MAE`/`MFE`,
`rMultiple`, and PnL (`points`, `dollars`).

### `orders.ts` (pure) — behavior-exact port of `src/orders.js`

`normalizeOrders(raw)` — side/price validation, ordering invariants, qty default,
id assignment, duplicate-id rejection.

### `ExecutionEngine` (`@Injectable`, no deps)

Thin wrapper delegating to the pure `simulate*` functions so it can be
injected/mocked.

### `BacktestService` (`@Injectable`)

Injects `MarketDataService`, `ContractsService`, `ExecutionEngine`.

`run({ symbol, interval, date, session: 'rth'|'full', orders, entryCutoff?,
openBuffer?, allowIncomplete? }) → BacktestResult`:

The session timezone is always the **contract's** `spec.timezone` — there is no
`tz` request override. The RTH window (`spec.rth`) is only meaningful in the
contract's zone, so evaluating it in any other zone would silently corrupt both
the coverage grid and session filtering.

1. Resolve `ContractSpec` (pointValue, timezone, rth) — `404` on unknown symbol.
2. `normalizeOrders(orders)` — `400` on invalid orders.
3. `getDay` candles — `404` if the day has no stored data.
4. **Coverage gate:** recompute `analyzeCoverage` from the fetched candles for the
   requested session. If not `complete` and not `allowIncomplete`, **refuse to run
   the engine** → `422 Unprocessable Entity`
   `{ error: 'incomplete-session', hasOpen, hasClose, gaps }`.
5. Apply session/entry-window filtering (RTH vs full; `entryCutoff`/`openBuffer`
   derived from `ContractSpec.rth`, mirroring `run-command.js`).
6. `ExecutionEngine.simulate(candles, orders, pointValue, options)`.
7. Return `{ results, summary, meta }`.

`allowIncomplete=true` is a debugging escape hatch, default off.

### Controller — `BacktestController`

`POST /backtest` (JSON body = the request) → `BacktestResult`.

### Module

`ExecutionModule` provides/exports `ExecutionEngine` + `BacktestService`,
registers the controller, imports `MarketDataModule` + `ContractsModule`.

## Error Handling

- Firestore/Google errors → existing global `GoogleErrorFilter`.
- Unknown symbol / interval, or day with no data → `404`.
- CSV parse errors / invalid orders → `400`.
- Incomplete session on backtest → `422` with gap details.

## Testing Strategy (primary emphasis)

- **Pure engine (`engine.ts`):** port the *entire* existing engine test suite 1:1
  (node:test → Jest). Exhaustive coverage of every execution rule (armed gating,
  ambiguous-candle `slHitsFirst`, EOD, `NOT_FILLED`, MAE/MFE, rMultiple, PnL). The
  primary evaluation core — kept exhaustively tested.
- **`orders.ts`, `csv-parser.ts`, `session-time.ts`, `coverage.ts`:** pure unit
  tests; port existing cases from `test/` where they exist. Coverage util tested
  against complete days, truncated open/close, interior gaps, DST days, and
  half-day early closes (expected: flagged incomplete).
- **`MarketDataService`:** mock `FIRESTORE` (fake transaction/`listDocuments`/
  `set`) — merge-by-`t` dedup, `replace` vs merge, unchanged-skip, coverage
  recomputation, ingest summary.
- **`BacktestService`:** mock `MarketDataService` + `ContractsService` +
  `ExecutionEngine` — correct `pointValue` used, day fetched, coverage gate blocks
  incomplete sessions (`422`), session filtering applied, error paths.
- **Controllers / e2e:** supertest — multipart upload happy-path + `400`/`404`,
  `GET /days`, and `POST /backtest` incl. the `422` incomplete-session path.

## Implementation Phasing

1. **Contracts registry** (`contracts/`) + tests.
2. **Shared time utils** (`common/session-time.ts`) + **market-data module**
   (types, csv-parser, coverage util, service, controller) + tests.
3. **Trade-execution module** (`execution/`: engine, orders, ExecutionEngine,
   BacktestService, controller) + tests — porting the existing engine suite.

## Known Limitations / Follow-ups

- **Half-days (early closes)** are flagged *incomplete* against the standard
  16:00 RTH grid and therefore excluded from backtests — the conservative,
  correct-by-default behavior. Supporting them needs a per-contract
  **market-calendar** of early-close days; scoped as a follow-up.
- **Full-session completeness** is not rigorously defined (no per-contract Globex
  session window here). The enforced completeness guarantee is RTH; `session:
  'full'` runs without a hard grid gate unless a session window is later defined.
- **Day-docs are keyed by ET calendar day, not by CME trade-date.** All 24h
  Globex data *is* stored (see the ingest note above — nothing is dropped), but a
  futures session for trade-date D runs from ~18:00 ET on D-1 to ~17:00 ET on D,
  so the overnight leading into D's RTH open is currently **split across two
  day-docs** (the prior evening lands in D-1's doc, the early morning in D's). A
  concrete example from the first MES ingest: Monday's pre-market spans the
  Sunday-evening doc (18:00–24:00, ~72 bars, flagged incomplete) plus Monday's
  00:00–09:30 portion. This is not a data-retention issue — every candle is kept
  and re-bucketing is a pure re-derivation from stored candles (no re-ingest).
  **Anticipated use case:** showing the model/trader the prior night's
  pre-market before a decision on day D. When that lands, address it by either
  (a) a session-aware read (`getSession`/`getWithPriorNight`) that stitches D-1's
  evening with D, or (b) re-keying storage to CME trade-date so a session +
  its overnight is one doc (also requires defining the per-contract Globex
  window, which resolves the full-session-completeness item above). Deferred as
  a follow-up — nothing is lost by waiting.
- **Contract registry is static config.** Runtime editing would require moving it
  to Firestore later.
- **CLI/backend share no code yet** — the engine is ported (duplicated) into the
  backend deliberately, to avoid breaking the CLI-consuming skills.
