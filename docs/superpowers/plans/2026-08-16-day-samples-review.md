# Review: Persisted Random Day Samples (spec + plan)

Reviewed: 2026-08-16, adversarial four-lens pass (spec-plan consistency,
internal plan correctness, architecture soundness, codebase grounding) over

- Spec: `docs/superpowers/specs/2026-08-16-day-samples-design.md`
- Plan: `docs/superpowers/plans/2026-08-16-day-samples.md`

Feature is unbuilt; the review question is bug/rework risk if built exactly
as written.

## Scores

**Spec: 4.5 / 10.** Structurally complete and unambiguous about the data
model and API, but two High-severity design choices are baked into it: the
per-day candle-scan eligibility mechanism (which turns sample creation into
~352 sequential full-day reads on one HTTP request) and the deliberate
"silent non-match" rule for sampled days missing at run time, which defeats
the comparability purpose the spec itself states. One overclaimed guarantee
and one unverifiable factual anchor round it out.

**Plan: 1 / 10 (clamped; raw deduction exceeds the scale).** The core
service/test code was verified sound by two independent critics (the
deterministic-draw math, the fake-firestore usage, every cited import and
signature checks out). But built exactly as written the backend does not
boot — `SamplesService` is registered in `BenchmarkModule.providers` only,
while `BenchmarkController` lives in `AppModule` and resolves from the
module's *exports* — and the plan's own verification gate (`pnpm jest`,
rootDir `src`) structurally cannot catch it; only `pnpm test:e2e` boots
`AppModule`, and the plan never runs it. Around that sit a cluster of
error-contract violations (500s and misdirected 409/422s where the spec
promises 400/404) and several implementer-stalling inaccuracies.

A low plan score here means "many real findings against the rubric," not
"rewrite from scratch" — every finding below has a targeted fix.

---

## Findings

### Critical

**1. App fails to boot: `SamplesService` never exported from
`BenchmarkModule`.** (plan — Task 2 Step 3, Task 3 Step 3; found
independently by three lenses)
`BenchmarkController` is declared in `AppModule.controllers`
(`backend/src/app.module.ts:54`), not in `BenchmarkModule`, so its
constructor deps resolve from `BenchmarkModule`'s **exports**
(`benchmark.module.ts:32` — currently `BenchmarkService, ScoreboardService,
BenchmarkRepository` only). Adding `SamplesService` to `providers` alone
leaves it invisible; `NestFactory.create(AppModule)` throws "Nest can't
resolve dependencies of the BenchmarkController (…, index [4])". All four
task gates stay green because the controller spec hand-provides a fake and
`pnpm jest` (rootDir `src`) never boots `AppModule`; the first symptom is
the post-implementation `curl` against a dead server, after all commits.
*Fix:* Task 2 Step 3 adds `SamplesService` to both `providers` and
`exports`; Task 4 Step 4 adds `pnpm test:e2e` (which boots `AppModule` via
`test/benchmark.e2e-spec.ts:187`) — ideally with supertest cases for the
three new routes, which also closes the route-wiring test gap (finding 17).

### High

**2. Eligibility scan: ~352 sequential full-day candle reads inside one
HTTP request.** (spec §Components 1 step 3; plan Task 2 `eligible()`)
`MarketDataService.getDay` reads and materializes a full day document
(~1,380 candles); the plan loops it serially per listing day, after
`snapshot()`'s own 352-manifest download. The post-implementation `curl`
hangs for minutes; any proxy timeout kills it mid-draw with no signal
whether the sample persisted; a retry pays the whole scan again before the
duplicate-name 409 (which only fires at the final `create()`); a mid-scan
Firestore error has no stated semantics (as written: unmapped 500 after
~300 reads); a zero pool yields an undiagnosed `422 count 100 exceeds
eligible pool of 0 days`. The repo already has the cheap primitive:
`MarketDataService.listStoredDays(symbol, interval)`
(`market-data.service.ts:63-72`) returns `{date, complete}` via projected
queries (~8 for 2025–2026), where `complete` is `coverage.rthComplete`
written at ingest **by the same `analyzeCoverage`**.
*Fix:* eligibility = committed manifests ∩ `listStoredDays` complete-days,
grouped by `resolveContract`; early `getSample(name)` 409 before any scan;
spec's "exactly the run's own prerequisite" wording amended to name the
stored-coverage mechanism; enrich the 422 with pool diagnostics.

**3. Sampled days missing at run time vanish silently — defeating the
feature's stated purpose.** (spec §Components 4; plan Task 4 Step 1
`expect(summary.daysSkipped).toEqual([])`)
If manifests are removed or a day folder degrades (`scanDays` routes it to
`issues`, which the plan then filters away too), a run over a 100-day
sample silently grades 94 days and the scoreboard row is quietly
non-comparable — exactly what the spec's Purpose section says the feature
prevents. The plan's test cements the silence.
*Fix:* when `opts.sample` is set, report unmatched sample days in
`summary.daysSkipped` with `reason: 'sample day not in snapshot'`; update
spec §Components 4 and the plan's assertion.

**4. `sample`/`days` 400 and unknown-sample 404 sit after the snapshot,
drift guard, and single-flight lock.** (plan Task 4 Step 3)
As placed (replacing `benchmark.service.ts:122`), a malformed
`{sample, days}` request: (a) returns the drift **409** instead of 400
whenever any content drift exists; (b) returns "run already in progress"
409 if issued during a run; (c) costs a full inputs snapshot plus a
`listCellsForDrift()` scan of every cell before failing; (d) holds the
run lock while doing so.
*Fix:* mutual-exclusion check and `getSample` resolution at the top of
`run()`, before `this.runInProgress = true`.

### Medium

**5. Empty-days sample fails open into a full-corpus run.** (plan Task 4
Step 3) After `daysFilter = sampleDoc.days`, the filter is still guarded by
`daysFilter?.length`; a sample doc with `days: []` (out-of-band write,
partial doc) silently benchmarks every committed day — hundreds of batches
of real spend. *Fix:* throw `UnprocessableEntityException` on an empty
resolved sample (or apply the filter unconditionally when a sample was
requested); add a test.

**6. Eligibility predicate is a copy of `runInner`'s internals with no
shared unit.** (plan Task 2 `eligible()` vs `benchmark.service.ts:147-200`)
Duplicated `SYMBOL`/`INTERVAL`/`rthWindow`/predicate can silently diverge:
a future third per-day gate in the run means a 100-day sample yields fewer
benchmarked days with no test noticing. *Fix:* largely absorbed by finding
2's `listStoredDays` approach; whatever remains shared (contract
resolution, completeness meaning) gets one exported helper used by both.

**7. Untyped request bodies produce 500s where the spec promises 400.**
(plan Tasks 2/3) No `ValidationPipe` exists (`main.ts` registers none);
`{"name":123}` → `.trim is not a function` → 500; a numeric `from`
string-coerces past `DAY_KEY_RE` then crashes in `dayToDate`. *Fix:*
`typeof` guards on `name`/`from`/`to` (and `sample` in the run path)
before use; tests passing `as any` bodies.

**8. `name` validation applies only in `create`; `get` and run-`sample`
pass raw input to a Firestore document id.** (plan Task 2 `get`, Task 4)
`GET /benchmark/samples/%2E%2E` or `{"sample":"a/b/c"}` hits
firebase-admin argument validation → 500 instead of 400/404; no length cap
(Firestore's 1,500-byte id limit → INVALID_ARGUMENT 500). *Fix:* one
private `assertName()` (regex + ≤64 chars) used by `create`, `get`, and
run-sample resolution.

**9. `from`/`to` accept non-dates, YYYYMMDD, and inverted ranges — and
persist the lie into an immutable doc.** (plan Task 2; spec error table)
`/^\d{8}$/` passes `20250101` (YYYYMMDD → garbage `dayToDate` → bound
silently ignored, then **persisted** as `from` in a write-once doc),
`13322025`, and `from > to` — all surfacing as a misleading 422 about
`count`. The repo already exports `isValidMmddyyyy`/`parseMmddyyyy`
(`eminiplayer-validation.ts`) and the eminiplayer controller validates all
three conditions (`eminiplayer.controller.ts:116-124`). *Fix:* reuse those
validators; reject invalid dates and `from > to` with 400 before any scan.

**10. Sampling inherits the whole run's input-availability failure
surface.** (plan Task 2 `snapshot()`) `snapshot()` also reads all traders,
features, and general docs, fail-closed — one malformed persona doc makes
`POST /benchmark/samples` return 503 about traders. *Fix:* narrow
`CloudInputsService.listDays()` that runs only `scanDays()`;
`SamplesService` depends on that.

**11. Spec overclaims: "guarantees every sampled day actually runs."**
(spec §Components 1 step 3; echoed in the plan's doc comment) Sampled days
can still skip via missing docs, keys-generation failure, or the per-day
error catch. *Fix:* soften to "removes the dominant skip causes (no
candles / incomplete session)".

**12. Red-phase expectations are wrong: ts-jest reports compile errors,
not runtime failures.** (plan Steps 2 of Tasks 1/3/4) Diagnostics are on;
the real failures are `TS2339`/`TS2353` suite compile errors. Task 4's
"unknown option is ignored" is actively false — the spec file won't
compile, and an implementer may "fix" it with `as any`, permanently
defeating the type check. *Fix:* restate each expected failure as the
specific compile error; verify pre-existing tests in Step 4, not Step 2.

### Low

**13. Commit pathspecs contradict the "run from `backend/`" constraint.**
(plan, every Step 5) From `backend/`, `git add backend/src/...` and
`git add CLAUDE.md` both fail. *Fix:* state that git runs from the repo
root (only `pnpm jest` runs from `backend/`).

**14. "Expected: PASS (10 tests)" — the plan defines 9.** (plan Task 2
Step 4) *Fix:* say 9.

**15. Name-regex drift between docs, and the 400 message misdescribes the
shipped regex.** (spec §3 `[a-z0-9-]+` vs plan
`/^[a-z0-9][a-z0-9-]*$/`) *Fix:* align the spec to the stricter pattern
and make the error message match.

**16. Task 4's new service tests must land inside
`describe('BenchmarkService.run')` (its `beforeEach` sets the coverage
mock), and the `@nestjs/common` import should extend line 2, not
duplicate it.** (plan Task 4 Step 1) *Fix:* say so explicitly.

**17. Controller tests never pin error pass-through.** (plan Task 3) A
409/422/404 from `SamplesService` reaching the client unaltered is
untested; `run` already precedent-wraps errors. Largely covered by the
finding-1 e2e fix; otherwise add one rejection-pass-through test.

**18. "352 committed days (211 + 141)" is stated as fact, undated and
unverifiable from the repo.** (spec Context; plan post-implementation)
*Fix:* date the claim ("as of 2026-08-16 per bucket listing") and have the
post-implementation step read `poolSize` off the created doc instead of
assuming 352.

---

## Verified clean (so it isn't re-litigated)

Both code-reading critics independently confirmed: the deterministic
Fisher–Yates draw test matches the implementation; `test/fake-firestore`
supports every access pattern used (`create()` rejecting `{code: 6}`,
`get().exists/data()`, `collection().get().docs`); all cited imports exist
under the stated names/paths/signatures (`resolveContract`,
`analyzeCoverage`, `intervalToSeconds`, `hhmmToMinutes`,
`MarketDataService.getDay`, `ContractsService.get`, `DayListing`);
`ContractsModule` is `@Global`; `MarketDataModule` is imported by
`BenchmarkModule`; the code-6 → `ConflictException` pattern mirrors
`content.service.ts` faithfully; jest mock semantics in the sampler spec
are sound (no cross-test pollution); and the spec's out-of-scope
deferrals are honoured by the plan.

## Disposition

**All 18 findings applied** (user: "fix all findings by rewriting spec and
plan", 2026-08-16). Both documents were rewritten in place:

- 1 — applied: module `exports` + mandatory `pnpm test:e2e` gates (plan Tasks 2–4).
- 2 — applied: eligibility now intersects manifests with per-contract
  `listStoredDays` stored coverage (no per-day candle reads); early 409;
  mid-scan abort rule; diagnostic 422 message. Spec §Eligibility rewritten.
- 3 — applied: `daysSkipped` gains `'sample day not in snapshot'`; spec §4
  and plan tests updated.
- 4 — applied: resolution moved into `run()` before the single-flight lock;
  tests assert no snapshot read and no lock latch on rejection.
- 5 — applied: empty-days sample → 422, with test.
- 6 — applied: absorbed by the stored-coverage design (finding 2); the
  shared meaning of "complete" is the ingest-written `coverage.rthComplete`.
- 7 — applied: `typeof` guards on name/count/from/to; `as any` tests.
- 8 — applied: exported `assertSampleName` used by create, get, and the run
  path; ≤64-char cap; tests for `..`/`a/b`.
- 9 — applied: `dayTime()` from eminiplayer-validation; YYYYMMDD, non-dates,
  and inverted ranges → 400 before any I/O, with tests.
- 10 — applied: new `CloudInputsService.listDays()`; sampler no longer
  calls `snapshot()`.
- 11 — applied: spec claim softened to "removes the dominant skip causes".
- 12 — applied: every red-phase step restates the expected TS compile error.
- 13 — applied: git commands documented as repo-root; `pnpm` from `backend/`.
- 14 — applied: test counts corrected (now 13 sampler tests, stated).
- 15 — applied: spec aligned to `^[a-z0-9][a-z0-9-]*$`; message matches.
- 16 — applied: test placement inside the `describe` stated; import
  extension instead of duplication.
- 17 — applied: error pass-through unit test + supertest e2e coverage.
- 18 — applied: day counts dated in spec; post-implementation reads
  `poolSize` off the response.
