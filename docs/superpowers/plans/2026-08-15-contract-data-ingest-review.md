# Review: per-contract data ingest spec + plan

**Reviewed:** `docs/superpowers/specs/2026-08-15-contract-data-ingest-design.md` + `docs/superpowers/plans/2026-08-15-contract-data-ingest.md`
**Status at review time:** unbuilt (no plan file exists in `backend/src/`)
**Method:** four parallel blind critics (spec-plan consistency, internal plan correctness, architecture soundness, codebase grounding), findings deduped and scored per the severity rubric (high −2, medium −1, low −0.5, clamp at 1).

## Scores

**Spec: 5/10** — the design's decisions are sound and fully covered by the plan, but two high-severity claims are false or incomplete against the real code: the "cells implicitly record the contract" guarantee doesn't survive contact with the reconciler, and the deferred MES-deletion non-goal hides a hard ordering dependency (retire before first post-flip run) that neither doc states. (10 − 2 − 2 − 0.5 − 0.5)

**Plan: 1/10** — the plan's core logic is verified sound (every calendar/DST/arithmetic fixture, every signature, every line reference checked clean), but the volume of pre-handoff fixes is large: two high-severity operational gaps (watch-mode ingest run, unrun e2e suite) and four mediums, mostly in test-fixture grounding. The score is mechanical (10 − 2 − 2 − 1×4 − 0.5×4 → clamped); nearly every deduction is cheap to fix, and the plan re-scores ~9 once they're applied. It reflects rework-risk-if-handed-to-a-literal-implementer-today, not rot.

## High-severity findings

### S1 — Spec §4/§5 + Plan Task 7: the contract-provenance guarantee is never implemented
- **Doc:** spec ("Every stored grading result therefore records what it actually tested against"; "`CellResult` rows will implicitly carry the new `contract` field") + plan Task 7 ("no further reconciler changes").
- **Failure scenario:** `batch-reconciler.ts:248-260` builds `CellResult` by explicitly enumerating fields from `bt.results[0]` (a `SimResult`); Task 6 puts `contract` on the top-level `BacktestResult`. Built as written, zero stored cells record their contract, the advertised seam for the prev-day assertion doesn't exist, and nothing errors — it ships unnoticed (rollout only checks the HTTP echo).
- **Fix:** Task 7 gains a step persisting `bt.contract` into the cell (with a reconciler spec assertion); spec's "implicitly" wording corrected to name the explicit persistence.

### S2 — Spec Non-goals + Plan Task 7: unstated ordering dependency on MES-cell retirement
- **Doc:** spec ("Deleting `markets/MES/min-5` and the benchmark runs that used it … nothing in this design blocks it").
- **Failure scenario:** cells are keyed `{trader}__{alias}__{day}__{variant}__run{N}` with **no symbol/interval/contract** (`benchmark.types.ts:80-110`), and the scoreboard groups by `(trader, alias, variant)`. After the constant flip, a `POST /benchmark/run` topping up a day that holds old MES cells averages $5/pt and $50/pt results in one row — a 10× dollar-scale mix the drift guard cannot catch (it hashes personas/docs/features only). A batch submitted pre-flip but reconciled post-flip is graded with post-flip constants. Deferring the deletion is fine; deferring it *past the first post-flip run* is not, and neither doc says so.
- **Fix:** spec states the ordering constraint (retire MES cells and drain in-flight batches before the first post-flip run); with S1's `contract` stamp on new cells, mixed rows become at least diagnosable.

### P1 — Plan Task 8: multi-hour in-memory job run from a watch-mode process
- **Doc:** plan Task 8 Steps 1–3.
- **Failure scenario:** each `upsertDay` is a Firestore transaction (~100–250ms RTT); at the stated 10⁴–10⁵ day-docs that's ~50 min to multiple hours — not "tens of minutes." Step 1 starts `pnpm start:dev`: any file save during the window restarts Nest, kills the detached loop, and `GET` then returns `{state:'idle'}` — indistinguishable from never-ran. The poll loop has no branch for it. (The backfill pattern the spec mirrors has durable per-day manifests; this job copies the in-memory half only.)
- **Fix:** Task 8 uses `pnpm start` (one-shot); runbook notes "idle after restart = job died, re-POST (idempotent)"; duration expectation corrected.

### P2 — Plan Task 7: benchmark e2e specs break and the plan never runs them
- **Doc:** plan Task 7 Steps 3–4 ("Run: `pnpm test` — Expected: PASS").
- **Failure scenario:** `pnpm test` (jest `rootDir: src`) never touches `backend/test/`; `test/benchmark.e2e-spec.ts` (lines 134/194/253) and `test/benchmark-scorecard.e2e-spec.ts` (line 139) seed candles into `markets/MES/min-5` then drive `/benchmark/run`. Post-flip, `benchmark.service.ts` looks up the resolved contract at min-1, finds nothing, skips every day ("no candles"), and the `cellsQueued` assertions fail — but `pnpm test` stays green, so the plan completes with a permanently red `pnpm test:e2e`.
- **Fix:** Task 7 gains a step updating both e2e specs (seed the resolved contract symbols on the min-1 grid) and adds `pnpm test:e2e` to verification.

## Medium-severity findings

### P3 — Plan Tasks 4 & 6: appended tests are written against imagined fixtures, not the real spec files
- **Failure scenario (Task 6):** the block references `service`, `baseRequest`, and `marketDataMock` — none exist; the real file uses `const { service, marketData } = await build(getDay)` with a fixture named `req`, and its `getDay` mock **ignores its arguments**, so the resolution tests pass vacuously and the "404 names the contract" test cannot be arranged at all without new symbol-keyed mock machinery the plan never shows. Tests 2/3 vs test 5 also need contradictory mock states with no per-test arrangement given. Bonus: the existing "uses a different contract pointValue (ES=50)" test passes `symbol: 'ES'` and silently changes meaning after Task 6 (resolves to a quarterly; passes only because the mock is args-blind). **(Task 4):** `buildService()` doesn't exist — the real helpers are `makeIngestFirestore(existing)` + `await buildWith(firestore)` (async; the placeholder also drops the `await`).
- **Fix:** rewrite both test blocks against the real helpers; give Task 6 a symbol-keyed `getDay` mock (`mockImplementation` keyed by contract) with explicit per-test arrangement; annotate or repoint the existing `symbol: 'ES'` test.

### P4 — Plan Task 5: directory discovery is hardcoded and silent
- **Failure scenario:** spec specifies a glob (`data/ES_{1min,5min}_{update,archive}_*`); the plan hardcodes the four `_t6h13g` names and `continue`s past missing dirs. A refreshed vendor drop (`ES_1min_update_x9k2f/`) is silently ignored; a `BENCHMARK_REPO_ROOT` override pointing at a checkout without `data/` yields `files: 0` → `state: done, failed: 0` — Task 8's success criterion passes while zero documents were written.
- **Fix:** `readdirSync(dataRoot)` matching `/^ES_(1min|5min)_(archive|update)_/` (archive dirs sorted before update dirs); fail the job (or the POST) when zero contract files are found.

### P5 — Plan Tasks 1+6: calendar-invalid dates become 500s through the backtest
- **Failure scenario:** `resolveContract` throws a plain `Error` for regex-valid, calendar-invalid dates (`2026-13-01`). Task 6 calls it after the format regex, so `POST /backtest {symbol:'ES', date:'2026-13-01'}` becomes an unhandled 500 where every other path 4xxes — the spec promises "invalid date format → existing 400."
- **Fix:** Task 6 wraps resolution in try/rethrow as `BadRequestException`.

### P6 — Plan Tasks 4/5: the spec's "idempotent re-run" test is missing
- **Failure scenario:** spec's testing section requires "idempotent re-run (second run reports unchanged)." No plan test runs anything twice — and Task 5's harness can't observe it (fully mocked `ingestCandles`). If a later change flips the job to `replace: true`, the rollout's "safe to re-run after interruptions" claim breaks with no failing test.
- **Fix:** add a second-ingest test in Task 4 (same candles twice → second summary reports `unchanged: true` days).

## Low-severity findings

### P7 — Plan Task 1: September's exact switch Monday missing from the test table
Spec asks for "exact switch-Monday dates for all four quarters"; `['2025-09-15', 'ESZ25']` is absent (only 09-16 appears). Add the row.

### P8 — Plan Task 5 / Spec §3: per-file result shape drift
Spec documents `{ …, failed?, error? }`; the plan's `ContractIngestFileResult` drops `failed?`. Anything scripted against the spec's shape filters on a field that never exists. Align one of the docs (drop it from the spec or add it to the interface).

### P9 — Plan Task 5: misleading fixture comment
The `beforeEach` comment claims the test exercises "same-named contract in update must win last-write," but the fixture uses two different contracts — the test only asserts directory ordering (and can't do more against a mocked `ingestCandles`). Grounding note: there is currently **zero** filename overlap between archive (≤ Z24) and update (H25–U27), so the spec's overlap rationale is future-proofing, not a present case — soften both wordings.

### P10 — Plan Task 7 Step 3: expected literals not enumerated
"Update those expectations" doesn't say which literal each call site becomes — the reconciler path still passes `'ES'` (backtest resolves internally) while `benchmark.service.ts`'s `getDay` now sees a resolved quarterly. Spell out the per-file literals.

### S3 — Spec: ungrounded scale claims
`data/` is 590MB (not ~535MB); the largest contract file is 7.6MB (not ~40MB — smaller is safer, but the number isn't real). Correct the figures.

### S4 — Spec §3: covered by P9's grounding note (overlap wording). Counted once.

## Reported without deduction

- **Module-rewrite DI concern (invalidated):** an internal-correctness critic flagged Task 5's `market-data.module.ts` rewrite for lacking `imports`; grounding verified `ContractsModule` is `@Global()`, `ConfigModule` is `isGlobal`, and `FIRESTORE` resolves — the rewrite is DI-safe and drops nothing (current file content is exactly the plan's snippet minus the new service). Phrasing Step 6 as an edit is still kinder to the implementer.
- **Unauthenticated job endpoint:** the backfill's `x-backfill-token` guard is optional and unset in this environment, so both endpoints are equally unguarded in practice — parity with accepted posture, not new risk. Worth one sentence in the plan acknowledging the deliberate drop.
- **Mutable `snapshot()` return** (backfill precedent `structuredClone`s) and **roll-resolved-base predicate duplicated across two modules** — both are future-hypothetical coupling concerns with no present failure path; noted for the implementer's judgment.

## Verified clean (the load-bearing mass)

All seven `rollSwitchMonday` fixtures and all 12 boundary rows re-derived by calendar — correct. DST 2026 dates and both spring-forward epoch assertions — correct. `ROW_RE` capture groups, modulo fixtures, counter semantics, task ordering, name/signature consistency across tasks — clean. Every `Modify:` line reference exact (`batch-reconciler.ts:14-15`, `benchmark.service.ts:23-24`, `getDay` at 170, `app.module.ts:22/48`). All 158 data filenames match the pattern with zero exceptions. Route-conflict claim holds. `pnpm test -- <pattern>` filters as assumed. No other `'MES'`/`'min-5'` hardcodings in `src/` beyond the two constants and already-scheduled specs. Firestore day-doc size worst case ~72KB (14× under the 1MiB limit). No DST fall-back ambiguity (market halted during the repeated hour).

## Findings ledger

All 13 findings applied 2026-08-15 (user: "fix all findings").

| # | Doc | Severity | Status | Applied as |
|---|---|---|---|---|
| S1 | spec + plan T7 | high | **applied** | spec §4/§5 rewritten; plan T7 Step 3 persists `bt.contract` into `CellResult` (+ type field, + reconciler spec assertion) |
| S2 | spec | high | **applied** | Non-goals states the retire-before-first-post-flip-run constraint; rollout gains step 0; plan T8 Step 0 gate |
| P1 | plan T8 | high | **applied** | `pnpm start` (watch mode forbidden), hours-not-minutes duration, idle-after-restart = job died → re-POST |
| P2 | plan T7 | high | **applied** | T7 Step 5 updates both e2e suites (390 min-1 bars, `/markets/ESU26/min-1/candles`, direct-seed path); Step 6 runs `pnpm test && pnpm test:e2e` |
| P3 | plan T4/T6 | medium | **applied** | T4 test rewritten on `makeIngestFirestore`/local `buildWith`; T6 tests rewritten on real `build`/`req` with symbol-keyed `getDay`; existing ES pointValue test repointed to `ESU26` |
| P4 | plan T5 | medium | **applied** | `discoverDataDirs` pattern match (archive-first sort); zero files → `ContractIngestNoFilesError` → 422; two new tests |
| P5 | plan T1/T6 | medium | **applied** | resolution wrapped in try → `BadRequestException`; 400 test added; spec error-handling row updated |
| P6 | plan T4/T5 | medium | **applied** | idempotency test added to T4 `ingestCandles` suite (seeded store, expects `unchanged` + no `tx.set`) |
| P7 | plan T1 | low | **applied** | `['2025-09-15', 'ESZ25']` row added |
| P8 | plan T5 / spec §3 | low | **applied** | spec payload aligned to the plan's shape (`error?` only, no `failed?`) |
| P9 | plan T5 + spec §3 | low | **applied** | fixture comment rewritten (asserts ordering, not overwrite); spec softened to "should both ever contain" + no-present-overlap note |
| P10 | plan T7 | low | **applied** | T7 Step 4 enumerates per-call-site literals (reconciler passes base `'ES'`; benchmark.service asserts resolved quarterly) |
| S3 | spec | low | **applied** | 590MB / largest ~7.6MB / hours-scale duration |

Report-only items (no deduction) were left to the implementer's judgment as
recorded above; none were applied.
