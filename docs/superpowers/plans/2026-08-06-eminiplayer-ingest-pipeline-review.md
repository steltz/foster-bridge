# Review: EminiPlayer Ingest Pipeline (spec + plan)

**Date:** 2026-08-06
**Reviewed:** `docs/superpowers/specs/2026-08-06-eminiplayer-ingest-pipeline-design.md` + `docs/superpowers/plans/2026-08-06-eminiplayer-ingest-pipeline.md`
**State at review:** docs only — no implementation built yet.
**Method:** four parallel blind critics (spec-plan consistency, internal plan correctness, architecture soundness, codebase grounding), findings deduped and re-scored against the severity rubric. Findings with no concrete failure scenario were dropped.

## Scores

- **Spec: 3/10** — one High design gap (recap-date drift) plus three Medium unstated-contract gaps (not-found ownership, concurrency, trust boundary) and five Lows. Deductions: 2 + 3×1 + 5×0.5 = 7.5 → 2.5, rounded up.
- **Plan: 2/10** — two High implementer-stalling defects (broken test invocation in every task; wrong failure prediction + wrong fix for the module-spec DI break) plus three Mediums and three Lows. Deductions: 2×2 + 3×1 + 3×0.5 = 8.5 → 1.5, rounded up.

Context for the numbers: the critics also verified a lot is *right* — the TranscriptService port is line-for-line faithful to the root CLI, cross-task names/types have zero drift, task ordering has no forward dependencies, nearly every repo claim checked true, and the ingest/controller test suites mentally execute green against their implementations. The low scores reflect breadth of real findings, all of which are cheap doc edits; applying the fixes below would re-score both docs at 8+.

---

## High

### H1 (Spec) — Recap-date drift: fill-and-skip is keyed to a path that isn't stable across runs

**Location:** Spec Decisions #4 + Ingest flow steps 1–2; Plan Task 3 (`paths.recap` from `entries.recap.date`).
**Failure scenario:** The recap path embeds a date resolved fresh from the archive each run. Run ingest for day D while D−1's recap isn't posted yet (delayed video): the pipeline resolves the D−2 recap and uploads `<D-2>_ES_RECAP.md` into D's folder — response says `uploaded`, nothing looks wrong. Once the D−1 recap posts, a retry computes a *different* recap path, sees it missing, and uploads `<D-1>_ES_RECAP.md` alongside the stale one. The day group now has two RECAP files (breaking the spec's "a day group is three files" shape), and `force=true` never cleans the orphan — force regenerates only the three currently-computed paths. Without a retry, D's folder silently pairs the TP with the wrong session's recap.
**Suggested fix:** Make the recap slot self-healing: before producing the recap artifact, list `knowledge-base/es/<date>/` for `*_ES_RECAP.md` and delete (or at minimum report) any file whose recapDate differs from the resolved one; document that resolution is time-sensitive. Alternative: refuse/flag (`recapPending`) when the resolved recap looks stale relative to expectations.

### H2 (Plan) — `pnpm test -- --testPathPattern=<pattern>` runs zero tests and exits 1

**Location:** Plan Global Constraints + every test-run step in Tasks 1–4 (11 commands).
**Failure scenario:** Verified live in the repo: pnpm 10.14 forwards the literal `--` into jest's argv, so jest treats `--testPathPattern=…` as a positional test-name pattern — `0 matches`, zero tests run, exit 1. Every TDD red step "fails" for the wrong reason (falsely confirming red while the test never ran), and every green step exits 1 with nothing run, sending the implementer chasing a phantom failure. `pnpm test --testPathPattern=X` (no `--`) works — confirmed against the real suite.
**Suggested fix:** Drop the `--` in the Global Constraints line and all eleven run commands.

### H3 (Plan) — Task 3 Step 7: `eminiplayer.module.spec.ts` breaks with a DI failure the plan mispredicts, and the plan's remedy doesn't fix it

**Location:** Plan Task 3 Step 7 contingency note.
**Failure scenario:** The existing module spec compiles `EminiplayerModule` with only `ConfigModule` in the testing graph. Once the module provides `EminiplayerIngestService` (which injects `STORAGE_BUCKET`), `.compile()` throws `Nest can't resolve dependencies of the EminiplayerIngestService (…, ?)` — `FirebaseModule`'s `@Global()` providers only exist when that module is in the compiled graph, and here it isn't. The plan's note anticipates a nonexistent failure ("if the spec asserts provider/export lists, update them" — it asserts no lists) and nudges toward importing the real `FirebaseModule`, whose factory calls `getStorage(app).bucket()` — violating the plan's own no-live-bucket constraint. Implementer hits a full-suite red with guidance that doesn't match.
**Suggested fix:** Replace the note with the actual failure and fix, with code: add `{ provide: STORAGE_BUCKET, useValue: {} }` (and `TranscriptService` if needed) to that spec's testing module (or `.overrideProvider`), mirroring how the ingest-service spec stubs the bucket.

---

## Medium

### M1 (Spec, inherited by plan) — The 404 not-found contract has no owner; as written it can never fire

**Location:** Spec Error handling rows 2–3 + "The orchestrator throws typed errors" sentence; Plan Task 2 Interfaces + Task 3 Step 1 errors docstring.
**Failure scenario:** Only `findDayEntries` can detect "no TP entry" / "no recap before date", but its contract (Task 2) never mentions `IngestNotFoundError`, and the class lives in the ingest layer with a docstring claiming "Thrown by the ingest orchestrator today" — false; the orchestrator only passes it through, and nothing ever constructs it outside test mocks. When the selector follow-up lands, the natural `throw new Error('no TP entry…')` gets wrapped by `stage()` into `IngestStageError` → **502**, and the spec's two 404 rows silently never materialize. The fix direction also matters: the scraper layer importing from `eminiplayer-ingest.errors.ts` points a dependency the wrong way.
**Suggested fix:** Put the not-found signal in the scraper's contract: define the error where the scraper can own it (e.g. `eminiplayer.constants.ts` or a scraper-level errors file, re-exported/mapped by the ingest layer), extend the `findDayEntries` `TODO(selectors)` comment to "throw <NotFoundError> when there is no TP entry for `date` or no recap dated strictly before it", add it to Task 2's Produces block, and fix the docstring.

### M2 (Plan) — Task 4 Step 8's "boot smoke test (no live scraping)" scrapes live, and its expected output is environment-dependent

**Location:** Plan Task 4 Step 8; also touches the "No live-site tests" global constraint.
**Failure scenario:** The stub's navigation skeleton is real: the first curl drives Playwright to live `eminiplayer.net/archive.aspx` and attempts a real login. The promised body (`selectors not implemented yet`) only appears if live navigation + auth succeed; without credentials the 502 says "credentials are not configured", without network/browsers it's a launch/timeout error. The implementer can't tell whether their wiring is broken, and "passing" the step as written requires live credentialed scraping the constraints forbid.
**Suggested fix:** Either smoke only the 400 path, or restate the expectation as "a JSON 502 naming the `resolve (archive)` stage; exact message varies with credentials/network — the stub path does perform live navigation."

### M3 (Plan) — Task 2's new tests require a mandatory `build`-helper reshape the plan frames as conditional, and the predicted red state is wrong

**Location:** Plan Task 2 Steps 1–2.
**Failure scenario:** The existing helper returns `moduleRef.get(EminiplayerService)` directly; the new tests destructure `const { service } = await build(page)` (one also needs `playwright`). Pasted as-is, the file stops compiling under ts-jest (TS2339), taking all seven existing tests down with it — so Step 2's "new tests FAIL (`findDayEntries is not a function`); existing tests still PASS" is doubly wrong (compile error, whole file red). The line-315 note gestures at this but as an "if", covering only half the change.
**Suggested fix:** Make the helper refactor an explicit numbered part of Step 1 with the new `build` body shown (hoist the `withPage` mock, return `{ service, playwright }`, update the 7 existing call sites), and correct Step 2's expected red state to the compile error.

### M4 (Plan) — Detail-page skeletons never re-assert the landed URL, violating the module contract both docs state

**Location:** Plan Task 2 Step 4 (`getYoutubeUrl` / `downloadTradePlanPdf`); spec Architecture bullet ("re-asserts its location").
**Failure scenario:** `findDayEntries` honors the contract via `assertOnArchivePage`; the two detail-page skeletons only `gotoAuthenticated` with no post-navigation URL check. If the site redirects (expired post, soft-404, upsell page) anywhere that doesn't show the login link, execution reaches the extraction point on the wrong page — today a misleading stub error, after the selector follow-up a wrong-DOM extraction with no diagnostic. The plan ships and tests this skeleton as the finished navigation contract, so the follow-up inherits the gap as "done".
**Suggested fix:** Add a structural `assertOnPage(page, expectedUrl)` to both skeletons plus matching stub tests in Task 2 Step 1.

### M5 (Spec) — Concurrent same-date ingests: exists-then-save race, no coalescing

**Location:** Spec (no mention of concurrency anywhere); Plan Task 3 `produce()`.
**Failure scenario:** The realistic trigger is a client timing out on a long first request and retrying while it still runs: both runs pass the `exists()` checks before either `save()`, so both scrape, transcribe, and upload everything — doubling credentialed scraping of the live site, and interleaving the two runs' `withPage` callbacks (safe but roughly doubling both wall-clocks, inviting another timeout-retry). Fill-and-skip only dedupes *completed* work; the docs never say what two in-flight runs do.
**Suggested fix:** Per-date in-process coalescing in `EminiplayerIngestService` (second request for an in-flight date awaits and shares the first run's promise); one spec line stating same-date ingests coalesce. Single-node is a safe assumption — the shared Playwright page already makes this a one-instance system.

### M6 (Spec) — Unauthenticated endpoint drives credentialed logins to a third-party site; trust boundary unstated

**Location:** Spec Decisions #1 / Error handling (no auth row); Plan Task 4 (no guard — the app has none anywhere).
**Failure scenario:** Anyone who can reach the port can loop `force=true` over arbitrary valid dates, producing repeated logins and full-archive scraping against the membership site (account lockout / ToS ban risk on an external account) plus unbounded bucket writes. Neither doc states the deployment assumption (localhost-only? VPC?) that makes no-auth acceptable, so nothing preserves that assumption at deploy time.
**Suggested fix:** One spec line stating the trust boundary ("backend binds to localhost / trusted network; endpoint is operator-only"), or a minimal shared-secret header check if that can't be guaranteed.

---

## Low

### L1 (Spec) — No time budget for a multi-minute synchronous request

One request = archive scan (+possible 30s login wait) + two detail navigations + two transcript fetches + PDF download + three uploads, possibly queued behind another run's `withPage` chain. Any proxy/client timeout aborts the response while work continues server-side, feeding M5's retry race. **Fix:** document expected duration; optionally an overall deadline inside `ingest()`.

### L2 (Plan) — Task 4 Interfaces says "→ 200 `IngestResult`" but `@Post()` returns 201

Nothing in tests or smoke steps checks the success status; a client coded to the stated 200 breaks. **Fix:** add `@HttpCode(200)` or change the contract line to 201.

### L3 (Plan) — `produce()` wraps the `exists()` pre-check in stage `'upload'`

A GCS outage during the check surfaces as `failed at upload (recap)` before anything was produced — pointing operators at a save that never happened. **Fix:** wrap the check as its own stage value (or `'resolve'`).

### L4 (Spec) — No completeness signal for a day group

Upload-as-you-go guarantees partial folders exist after failed runs; the future sync consumer the spec plans for can't distinguish "failed halfway" from "complete". Two-recap folders (H1) also break a count-based heuristic. **Fix:** one spec line defining completeness (all three files present) or a manifest object written last.

### L5 (Spec) — `findDayEntries` scan bound unstated

Any valid historical date (e.g. `01012015`) legitimizes a whole-archive walk inside a single `withPage` callback, blocking all other page work for its duration. The bound is a contract property, not a selector detail. **Fix:** add "not-found if no match within N pages / M days" to the contract so the follow-up implements a bounded walk.

### L6 (Plan) — Task 4 Step 6's nested code fences corrupt the README snippet

The ```` ```markdown ```` fence contains a ```` ```bash ```` fence whose closer terminates the outer block in rendered views; an implementer pasting from a rendered view ships a truncated README section. **Fix:** four-backtick outer fence.

### L7 (Spec + Plan) — "youtube-transcript returns milliseconds" holds only for the srv3 caption path

Verified in the installed 1.3.1: the classic-XML fallback path returns seconds, which the unconditional ÷1000 would compress 1000×. Byte-parity with the root CLI still holds (it divides unconditionally too) — an upstream-shared latent bug, documented inaccurately. **Fix:** amend the comments to name the assumption and its shared provenance.

### L8 (Spec/Plan) — File-layout drift for ingest types

Spec's architecture tree says ingest result types live in `eminiplayer.constants.ts`; the plan defines them in `eminiplayer-ingest.service.ts` and adds `eminiplayer-ingest.errors.ts`, which the spec tree doesn't list. **Fix:** amend the spec tree (or move the types) so the approved architecture matches what gets built.

---

## Notes (verified, not scored)

- The plan's claim "`FirebaseModule` … NOT imported here — same as every other consumer module" is contested by the repo: `moonshot.module.ts` imports it explicitly and argues that's better practice. Build-irrelevant either way.
- Verified sound: TranscriptService port line-for-line faithful (including `OFFSET_DIVISOR`); all cross-task names/types consistent; no forward task dependencies; `STORAGE_BUCKET`/`@Global()` claims true; youtube-transcript 1.3.1 CJS-importable with static `fetchTranscript` and `{text, offset, duration}` segments; `@google-cloud/storage@7.21` `exists()`/`save()` signatures as used; browser-crash recovery and `GoogleErrorFilter` interplay fine; scraped YouTube URLs are not an SSRF vector through `youtube-transcript`; transcript fetches correctly run outside `withPage`; GCS writes atomic.

## Outcome tracking

All 17 findings applied 2026-08-06 (user: "apply all fixes").

| # | Finding | Status | How |
|---|---|---|---|
| H1 | Recap-date drift / stale orphan | applied | Spec Decision 5a + flow step 2; plan: `removeStaleRecaps` + `staleRecapsRemoved` in `IngestResult` + two tests |
| H2 | Broken test invocation (`-- --testPathPattern`) | applied | `--` dropped from all 11 commands + Global Constraints |
| H3 | Module-spec DI break + wrong contingency note | applied | Task 3 Step 7 rewritten with the real failure + `FakeFirebaseModule` stub code |
| M1 | 404 not-found contract ownership | applied | `ArchiveNotFoundError` moved to `eminiplayer.constants.ts` (scraper-owned); `findDayEntries` TODO carries the throw contract; false docstring removed; controller/tests updated |
| M2 | Smoke test scrapes live / env-dependent expectation | applied | Task 4 Step 8 smokes only the 400 path; live-navigation reality documented |
| M3 | `build` helper reshape + wrong red-state prediction | applied | Step 1a shows the new helper + call-site updates; Step 2 expects the TS2339 whole-file red |
| M4 | Missing URL re-assert in detail-page skeletons | applied | `assertOnPage` helper + both skeletons + redirect tests |
| M5 | Concurrent same-date ingest race | applied | Spec Decision 5b + flow step 0; plan: `inflight` map coalescing + test |
| M6 | Unstated trust boundary on credentialed endpoint | applied | Spec Error handling: trust-boundary paragraph |
| L1 | No request time budget documented | applied | Spec Ingest flow: Duration paragraph; README snippet mentions it |
| L2 | 201 vs 200 | applied | `@HttpCode(200)` in controller snippet + Interfaces note |
| L3 | exists() failure misattributed to 'upload' | applied | `'plan'` stage added to `IngestStageError` union; `exists()`/cleanup wrapped in it |
| L4 | No day-group completeness signal | applied | Spec Ingest flow: Completeness contract paragraph |
| L5 | Unbounded archive scan | applied | `RECAP_LOOKBACK_DAYS = 14` constant + bound in `findDayEntries` contract (spec + plan TODO) |
| L6 | Nested code fences in README snippet | applied | Four-backtick outer fence |
| L7 | ms-vs-seconds caption-path caveat | applied | `OFFSET_DIVISOR` comment + spec Decision 3 caveat |
| L8 | Ingest types file-layout drift | applied | Spec architecture tree now shows `eminiplayer-ingest.errors.ts` and actual type homes |
