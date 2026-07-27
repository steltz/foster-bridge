# Trader-Bench → NestJS Backend Port (Batch API + Prompt Caching)

**Date:** 2026-07-26
**Status:** Design approved, ready for implementation planning
**Goal:** Make it affordable to benchmark trader personas with **Fable** by moving model
invocation off the Claude Code Workflow `agent()` primitive (no caching, no batching)
and onto the backend's **Anthropic Batch API + prompt caching** path — the two-pronged
cost strategy: (1) pre-cache the static per-day documents/personas, (2) run the fan-out
of trades asynchronously through the Batch API (50% off).

---

## 1. Background & motivation

The existing `trader-bench` skill (`.claude/skills/trader-bench/SKILL.md`) builds a
benchmark matrix of cells keyed **(trader × model × day × variant × run-index)** and,
for each cell, invokes the model through the Workflow tool's `agent()` primitive. That
primitive does no prompt caching and no batching, so benchmarking with Fable is
prohibitively expensive.

The key structural insight the cost strategy rests on: **for a given (trader, day,
variant), all N run-indices send a byte-identical prompt** — only the model's stochastic
sampling differs. Furthermore, everything on a given day shares a token-heavy
day-bundle (general strategy docs + trade-plan PDF + plan transcript + recap
transcript). This is a textbook prompt-caching + batching setup.

The backend already ships the exact machinery needed: `AnthropicService` implements
`warmCache()` → `createBatch()` → `getBatch()` → `getBatchResults()`, with a 1-hour
ephemeral cache breakpoint (`ONE_HOUR_CACHE_CONTROL`), `cacheReadInputTokens` surfaced
for hit verification, and the model-scoped-cache caveat documented inline. The
`BacktestService` (the deterministic judge) is already ported and callable in-process.
So this project is primarily an **orchestration + assembly layer** on top of existing
plumbing, not new API plumbing.

---

## 2. Architecture decisions (locked)

1. **Backend owns the entire pipeline; no Claude Code skill in the loop.** The only
   genuinely LLM-driven step is the trade-decision inference itself (the batch — that is
   the benchmark). Everything else — discovery, hashing, top-up diff, assembly, PDF
   upload, warm, batch, reconcile, backtest, score — is plain deterministic code.
2. **Firestore is the source of truth for all outputs and runtime state.** Authored
   inputs (personas, features, knowledge-base docs) stay in git on disk and are read
   deterministically by the assembler. No `runs/*.json`, no committed `SCOREBOARD.md`.
3. **Cells laid out as a flat Firestore collection, one doc per cell.** Composite doc id
   gives free write-once immutability; top-up is a query.
4. **Per-day, hierarchical cache with a two-stage warm.** One batch per day (per model);
   4-tier cache breakpoints; day-bundle (incl. PDF) cached once per day and read by the
   whole day's matrix, plus per-cell envelope warming.
5. **PDF: Firebase Storage is the durable origin; Anthropic Files API is the serving
   copy.** PDF stored in `STORAGE_BUCKET` before any cache warm; uploaded to Anthropic
   Files API for a `file_id`; both recorded in Firestore. Re-derivable from GCS.
6. **Seven-keys generation is ported into the backend now**, as a sequential Anthropic
   chain, on **Fable**. Output is generated once, content-hashed, frozen in Firestore,
   and reused (same immutability as personas/daily docs).
7. **Scoreboard computed in the backend** by vendoring the pure `src/scoreboard.js`
   functions and feeding them Firestore cells.
8. **Benchmark model default is Fable** (`claude-fable-5`), independent of the global
   `ANTHROPIC_MODEL=claude-sonnet-5`.

---

## 3. Module layout (`backend/src/`)

### New: `BenchmarkModule`

- `BenchmarkService` — orchestration: discovery → top-up diff → per-day assembly → warm
  → submit batch.
- `BenchmarkController` — `POST /benchmark/run` (`{model?, days?, runCount?, variants?}`),
  `GET /benchmark/status`, `GET /benchmark/scoreboard`.
- `DayBundleAssembler` — deterministic repo read + `sha256` hashing + Firebase-Storage
  mirror + Anthropic Files upload + `CachedContext`/breakpoint build. Ports the discovery
  logic from `src/lineage.js` / `src/features.js`.
- `BatchReconciler` — `OnApplicationBootstrap` + `@nestjs/schedule` poll cron: drains
  non-terminal batches → results → backtest → persist cells → mark done.
- `CacheWarmer` — `@nestjs/schedule` cron (every 55 min): re-warms Tier-2 day-bundles
  that have an in-flight batch.
- `ScoreboardService` — vendors the pure `src/scoreboard.js` functions (behavior-
  identical, with tests), fed from Firestore cells.

### New: `SevenKeysModule`

- `SevenKeysService.generate(day)` — four-agent chain port (Fable), sequential, cached
  shared prefix, output frozen in Firestore.

### Reused (with small extensions)

- `AnthropicService` — extend for: `output_config.format` (setup schema on batch
  requests), Anthropic Files-API upload helper, and `document` blocks inside the cached
  prefix (today it caches text on `system`/`prefix`).
- `BacktestService` + `ExecutionEngine`, `MarketDataService`, `ContractsService`,
  `FirebaseModule` (`FIRESTORE`, `STORAGE_BUCKET`) — as-is.

### Config additions (`configuration.ts` + env)

- `REPO_ROOT` — path to authored inputs on disk.
- Enable `@nestjs/schedule`.
- Benchmark model default `claude-fable-5`.

---

## 4. Firestore data model

| Collection | Doc id | Holds |
|---|---|---|
| `benchmarkRuns` | `{trader}__{model}__{day}__{variant}__run{N}` | Immutable cell: dimension keys, all content hashes (persona/general/feature/staticDoc/artifact), `setup`, backtest `result`, `createdAt`. `create()` = write-once. |
| `benchmarkBatches` | Anthropic batch id | Lifecycle: `day`, `model`, `status`, `customId→cellKey` map, `submittedAt`, `endedAt`, `warmContextRef`. Survives restarts → drives reconciliation. |
| `dayArtifacts` | `{day}__{kind}` (`pdfFile`, `keys`, `tpTranscript`, `recapTranscript`) | For `pdfFile`: `{ gcsPath, contentHash, anthropicFileId, uploadedAt }`. For `keys`: generated content + hash. Transcripts mirrored to Storage for a uniform durable record. |
| `benchmarkScoreboard` | `{model}` | Materialized scoreboard JSON + rendered markdown + `generatedAt`. |

**Inputs stay in git on disk** (authored source of truth); **all outputs and runtime
state live in Firestore/Storage.**

---

## 5. Runtime flow

### 5.1 Cache-breakpoint layout (4 tiers, most-shared → least-shared)

Render order is `system` → `messages`; `system` is text-only; the PDF must be a
`document` block in the user turn.

| Tier | Where | Content | Shared across |
|---|---|---|---|
| 1 | `system` (bp) | general strategy docs + constant task/schema framing | the whole matrix (this model) |
| 2 | user block (bp) | **day-bundle**: PDF `document` block (by `file_id`) + TP transcript + RECAP transcript | all traders×variants×runs that day |
| 3 | user block (bp) | persona | that trader's variants/runs |
| 4 | user block (bp) | feature block + methods doc + KEYS artifact (variant-dependent; empty for `base`) | the N runs of that cell |

Trailing the four breakpoints: a tiny constant "produce your single setup now"
instruction. Nothing varies across the N runs of a cell — only sampling.

### 5.2 PDF handling (before any warm)

1. Assembler obtains PDF bytes, computes `sha256`.
2. **Store PDF in Firebase Storage** at `benchmark/es/<day>/<prefix>_ES_TP.pdf`.
3. Upload bytes to **Anthropic Files API** → `file_id`.
4. Record `dayArtifacts/{day}__pdfFile = { gcsPath, contentHash, anthropicFileId, uploadedAt }`.
5. Only then warm the cache.

On re-runs: if `contentHash` matches, skip GCS write + Anthropic upload, reuse `file_id`.
If the Anthropic file was GC'd but hash matches, re-upload from the GCS copy (never
requires a repo checkout).

### 5.3 Two-stage warm (per day, before submitting the batch)

1. **Warm the day-bundle (Tier 2)** with one `max_tokens:0` call — reliably makes the
   token-heavy PDF+transcripts a cache read for every request in the batch. This is the
   tier the 55-min cron keeps alive.
2. **Warm each distinct (trader,variant) full envelope (Tier 4)** — cheap incremental
   writes extending the already-warm day-bundle; pre-warms persona+feature so batch
   requests don't lose those to the concurrent-write race.

Net per batch request: entire static envelope at ~0.1× input price, on top of the 50%
batch discount.

### 5.4 Per-run flow (`POST /benchmark/run {model=fable, days?, runCount=5, variants?}`)

1. **Discover** traders/features/day-folders from the repo; compute content hashes.
2. **Top-up diff**: for each (trader, day, variant), query `benchmarkRuns` for existing
   run-indices; missing = `{1..N} − existing`. For any scorecard-variant day lacking a
   KEYS artifact, generate it first (§6).
3. **Per day**: assemble bundle → store PDF in Storage + upload to Files API → warm
   (§5.3) → build one batch request per missing cell (`customId` = cellKey,
   `output_config.format` = setup schema) → `createBatch` → write `benchmarkBatches` doc
   (status `submitted`, `customId→cellKey` map).

### 5.5 Batch lifecycle + reconciliation

State machine: `submitted → in_progress → ended → reconciled` (plus
`canceled/expired/errored`).

- **`OnApplicationBootstrap`** and a **poll cron**: for every non-terminal
  `benchmarkBatches` doc, `getBatch`. On `ended`, `getBatchResults`, per result:
  - **succeeded** → parse setup → `BacktestService.run` (candles from Firestore
    market-data) → write cell (status TP/SL/EOD/NOT_FILLED).
  - **refusal** (Fable can return `stop_reason:"refusal"`) or **errored** → write cell as
    NO_SETUP / INVALID. **No model fallback** — a Fable refusal is a legitimate Fable
    result; substituting another model would contaminate the benchmark.
  - Cells written with `create()` (write-once; races safe).
  - Mark batch `reconciled`.
- Recovers batches that finished while the machine was off — startup reconciliation
  drains them with zero loss.

### 5.6 Re-warm cron (`@nestjs/schedule`, every 55 min)

For each day with a non-terminal batch, re-warm Tier 2 (day-bundle) under the 1h TTL.
Stops when the day has no in-flight batch. Skipped when the server is off (reconciliation
still catches results; late requests just cache-miss — correct but costlier).

---

## 6. Seven-keys generation (`SevenKeysModule`)

`SevenKeysService.generate(day)` — sequential Anthropic chain on **Fable**
(`claude-fable-5`); stages have data dependencies so this is not a batch:

1. **Current-day analyst** — general docs + `methods/seven-keys.md` + the day's three docs.
2. **Outcome-aware lookback analyst** — up to 3 prior days' KEYS + their outcome recaps.
3. **Synthesizer** — weights the current day heavily; produces the scorecard.
4. **Verifier** — checks every scorecard row against the trade plan.

- The shared day-docs prefix is **cached** across the four stages.
- **Cross-day ordering dependency**: day N's lookback needs days N−1…N−3 KEYS, so
  generation walks days oldest-first.
- The grade-discrimination rule (elevated grades capped) is preserved from the existing
  `/seven-keys` skill.
- Output stored in `dayArtifacts/{day}__keys` (content + hash); **not** committed to git;
  injected directly into Tier 4 for the scorecard variant.
- "Deterministic" = generated once, then content-hashed, frozen, and reused — the same
  immutability guarantee cells and daily docs have (the LLM sampling itself is not
  reproducible).

---

## 7. Backtest & scoreboard

- **Backtest**: each parsed setup → `BacktestService.run` in-process; candles pulled from
  Firestore market-data. **Prerequisite**: each benchmark day's OHLC (MES/min-5) must be
  ingested via the existing `POST markets/:symbol/:interval/candles`. A missing/incomplete
  day surfaces as a cell error, not a crash.
- **Scoreboard**: `ScoreboardService` vendors the pure `src/scoreboard.js` functions
  (ranking, feature-impact, lineage, coverage), feeds them Firestore cells, writes
  `benchmarkScoreboard/{model}` (JSON + rendered markdown), served at
  `GET /benchmark/scoreboard`.

---

## 8. Edge cases

- **Refusal / dead result** → cell NO_SETUP (no model fallback).
- **Missing candles** → cell error, flagged in coverage.
- **Missing KEYS for scorecard day** → generated on demand (§6).
- **Concurrent/duplicate submits** → write-once `create()` + top-up diff make re-runs
  idempotent.
- **Batch expired (24h) / errored** → reconciler marks it; the next `POST /benchmark/run`
  re-tops-up the still-missing cells.

---

## 9. Testing (existing conventions)

- Co-located `*.spec.ts`: `DayBundleAssembler` (hashing/breakpoint assembly),
  `BenchmarkService` (top-up diff), `BatchReconciler` (state transitions),
  `SevenKeysService` (chain, mocked SDK), `ScoreboardService` (parity with the vendored
  functions).
- `test/*.e2e-spec.ts` using `fakeFirestore()` + mocked `@anthropic-ai/sdk` + a fake
  Storage bucket: full `run → submit → reconcile → cell → scoreboard` path, plus the
  startup-reconciliation recovery path.

---

## 10. Prerequisites & assumptions

- Each benchmark day's OHLC (MES/min-5) is ingested into Firestore market-data before
  backtesting.
- `ANTHROPIC_API_KEY` configured; Files API (beta `files-api-2025-04-14`) available on
  the first-party API.
- `REPO_ROOT` points at the authored inputs (`traders/`, `features/`, `knowledge-base/`).
- Fable requires 30-day data retention (not available under ZDR) — org retention must
  meet this.

---

## 11. Out of scope (this iteration)

- Migrating the legacy `src/` scoreboard **rendering** beyond vendoring the pure
  functions (no CLI/git-commit workflow retained).
- A UI for triggering/monitoring benchmarks (HTTP endpoints only for now).
- Multi-model concurrent benchmarking within a single `POST /benchmark/run` (one model
  per call; caches are model-scoped).

---

## 12. Post-implementation notes & first-run checklist

The core pipeline is implemented and merged on `feat/trader-bench-backend-port`
(Tasks 1–15). Whole-implementation review found no Critical/Important issues; unit
235 / e2e 18 pass, `tsc` clean, `nest build` succeeds. A few notes for whoever operates it:

**Intentional divergences from this spec (improvements):**
- **Cache-warmer re-warms the full envelope, not just the day-bundle (§5.6).** The 55-min
  `CacheWarmer` re-warms each distinct `(trader, variant)` full envelope for in-flight
  batches, keeping the persona/feature tiers hot (and, via cumulative breakpoints, the
  day-bundle too) — costs one `max_tokens:0` write per distinct pair per cycle, which is
  small since batches usually finish within the 1h TTL.
- **Scheduler gating.** `BatchReconciler` (cron + bootstrap) and `CacheWarmer` (interval)
  are gated behind `benchmark.schedulerEnabled` (`BENCHMARK_SCHEDULER`), which defaults
  **off under `NODE_ENV==='test'`** and on otherwise — so tests never touch real
  Firestore at boot, and in production only a dedicated worker instance need run the
  schedulers (set `BENCHMARK_SCHEDULER=false` on API-only instances).
- **`errored`/`canceled`/`expired` batch items are skipped (no cell written)** so the
  run-index stays MISSING and re-submits on the next top-up — a transient API failure is
  never baked into the benchmark. Only `refusal` writes a `NO_SETUP` cell (legitimate
  Fable result, no model fallback).

**First live run — required before a full matrix (everything above was validated against
mocks only):**
1. Ingest OHLC (MES/min-5) for the target day(s) via `POST markets/MES/min-5/candles`.
2. Do a **1-day, 1-trader, `runCount:1`, `variants:['base']`** run first
   (`POST /benchmark/run`). This is the only way to confirm two live-API behaviors the
   mocks can't: (a) a `max_tokens:0` cache warm is accepted on Fable (thinking always-on),
   and (b) the batch requests actually read the warmed cache.
3. Verify caching landed: check `cacheReadInputTokens > 0` on the reconciled batch results
   (the field is surfaced for exactly this). Warms are **non-strict**, so a caching
   regression degrades to correct-but-costlier silently — this manual check is the guard.
4. Confirm the cell(s) and `GET /benchmark/scoreboard?model=fable` look right, then scale
   to the full matrix.

**Deferred to Plan 2:** seven-keys artifact generation + the `seven-keys-scorecard`
variant + feature combos (§6 of this spec). Also deferred: an idempotency key to close
the (loudly-logged) createBatch→saveBatch orphan window, and a `?refresh=true` live
scoreboard-recompute endpoint (the injection point exists in the controller).
