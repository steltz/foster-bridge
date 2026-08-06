# Review: EminiPlayer Ingest Pipeline (spec + plan)

> Two rounds. Round 1 reviewed the original 4-task pipeline (all 17 findings applied). Round 2, below the round-1 record, reviewed the docs after the verification system was added and the plan grew to 8 tasks.

# Round 2 — 2026-08-06 (post-verification-design)

**Reviewed at:** commit `49e21c6` (spec with Decision 6 verification layers; 8-task plan).
**Method:** same four blind lenses, briefed on the round-1 outcome table to avoid re-reporting applied findings.

## Scores

- **Spec: 2/10** — three High design gaps in the new commit/audit machinery (short-circuit freeze, claim-release asymmetry, audit scale), two Mediums, one Low. Deductions: 3×2 + 2×1 + 0.5 = 8.5 → 1.5, rounded up.
- **Plan: 1/10** — one High (a deterministic red test presented as passing), two Mediums, eleven Lows. Deductions: 2 + 2 + 5.5 = 9.5 → clamped.

Context, which matters more than round 1: the surface under review roughly quadrupled, and the defect *density* dropped sharply — the grounding critic verified every new repo/dependency claim true (LLM seam, Firestore transaction API, `ignoreNotFound`, global fetch typing, all of it), the correctness critic mentally executed the full test suites and found one genuinely failing assertion out of ~60 tests, and there are zero Critical findings. The mechanical rubric sums finding counts, and eleven real-but-small Lows on a 2,400-line plan crush the number. Every finding below is a doc edit; the three Highs are the ones that would really hurt at multi-year volume.

## High

### R2-H1 (Spec + Plan) — Manifest short-circuit freezes a day committed with the wrong (older) recap; response references a nonexistent file

**Location:** Spec Ingest flow step-5 paragraph + Decision 4 cross-reference; Plan Task 6 `run()` short-circuit branch. Found independently by two lenses.
**Failure scenario:** Day D ingests before D−1's recap posts (and D−1's own group isn't yet committed, so no claim conflict intervenes — an unstated emergent dependency). Resolve legally picks D−2's recap; every check passes *honestly* (title, invariants, LLM weekday all validate against the resolved recapDate); the day commits with the wrong session's recap. When D−1's recap posts, every subsequent run resolves the newer recapDate, sees `manifest.exists()`, and short-circuits — reporting `recapDate` and a recap `storagePath` **that does not exist in the bucket**, while the manifest permanently references the older recap. Audit passes forever (the manifest is self-consistent). This is the exact backtest-poisoning the system exists to prevent, surviving *because* of the commit machinery. The round-1 fix (stale-recap cleanup) only covers *uncommitted* days — the short-circuit returns before cleanup runs.
**Suggested fix:** In the short-circuit branch, download the manifest; build the response from the manifest's recorded recapDate/paths (never the fresh resolve); and when freshly-resolved `recapDate !== manifest.recapDate`, throw `IngestValidationError` ("committed recap is stale — rerun with force") instead of reporting all-skipped. Update the spec's step-5 paragraph and Decision 4 cross-reference to state this.

### R2-H2 (Spec + Plan) — `force` deletes the manifest but never releases video-id claims; a stale claim can permanently 422-block a neighboring day

**Location:** Spec Decision 6D / force semantics; Plan Task 5 `delete()`/`commit()`, Task 6 force branch.
**Failure scenario:** Day D commits early with recap video X (really D−1's recap). Backfilling D−1 resolves X → claim conflict → 422 "claimed by D/recap". Operator force-reruns D; the manifest is deleted and D recommits with the correct video Y — but X's claim (owned by D) survives. Every retry of D−1 422s forever, with an error message ("claimed by D/recap") that no longer matches anything visible in D's manifest. Only manual Firestore surgery fixes it; the audit reports X as orphaned but orphan *cleanup* is explicitly out of scope — this isn't orphan cleanup, it's force's uncommit semantics leaking.
**Suggested fix:** Make uncommit symmetric with commit: `EminiplayerManifestService.delete(date)` reads the manifest first and deletes both claim docs whose `claim.date === date` before removing the manifest. Add a test: force-rerun resolving different videos releases the old claims.

### R2-H3 (Spec + Plan) — Audit is one synchronous GET doing serial full-corpus downloads; unusable at exactly the scale it's for

**Location:** Spec Decision 6D audit description; Plan Task 8 `audit()`.
**Failure scenario:** At 750+ manifested days: ~3,000+ sequential GCS round-trips, several MB per PDF — realistically 10–30 minutes inside one HTTP request. Server/client timeouts kill the connection; the operator gets nothing and a retry starts from zero. "Run it before any large backtest campaign" is precisely when the corpus is largest. Mocked tests can never catch this.
**Suggested fix:** Accept `?from=&to=` range params; compare hashes via GCS object metadata (`md5Hash`/`crc32c` from `getFiles` metadata) instead of downloading content, reserving downloads for a `deep=true` mode; state the cost in the spec.

### R2-H4 (Plan) — Task 6's gate test asserts `bucket.files.get(RECAP_PATH)?.save).toBeUndefined()` but the implementation materializes the file handle before the gate throws

**Location:** Plan Task 6 Step 1 test "a failing transcript gate blocks upload and commit" vs Step 3 `produceTranscript`; Step 5 "Expected: PASS". Found independently by two lenses.
**Failure scenario:** `produceTranscript` calls `this.bucket.file(storagePath)` before the exists check (it must — the exists check needs the handle), and the fake bucket memoizes the `FakeFile` on that call. When the gate throws, `files.get(RECAP_PATH)` returns a defined object with an uncalled `save` — `toBeUndefined()` fails deterministically. Step 5's "Expected: PASS" is false; the plan presents the test as the spec, inviting a wrong "fix" (restructuring the bucket access and breaking the reload flow). The sibling mid-run test uses the same idiom *validly* (that path genuinely never touches the PDF handle), making the broken one look intentional.
**Suggested fix:** Change the assertion to `expect(bucket.files.get(RECAP_PATH)!.save).not.toHaveBeenCalled();` — keep the mid-run test as-is.

## Medium

### R2-M1 (Spec) — Spec's flow says upload-then-gate; the plan (correctly) gates before upload; the 422 row's "artifacts stay in place for diagnosis" is wrong for gate failures

**Location:** Spec Ingest flow step 3.2–3.3 + 422 error-table row; Plan Task 6 ordering (locked in by tests).
**Failure scenario:** A gate-tripping transcript produces a 422 whose documented contract says the artifact is in the bucket for diagnosis — but nothing was uploaded (the plan gates first, which is the safer order). An operator following the spec goes looking for an artifact that never existed.
**Suggested fix:** Amend the spec: gates reject *before* upload; "artifacts stay in place" applies to post-upload failures (LLM verdict, uniqueness) and reloaded artifacts.

### R2-M2 (Spec + Plan) — Coalescing silently drops the `force` flag

**Location:** Plan Task 6 `ingest()`; Spec Decision 5b (silent on mixed flags). Found by three lenses.
**Failure scenario:** An operator fires `force=true` to fix a known-bad day while a normal run (or timed-out retry) is in flight. The force call coalesces onto the non-force run — potentially the manifest short-circuit "all skipped" — and returns 200. The operator believes regeneration happened; nothing was regenerated, no error, no log.
**Suggested fix:** When a `force=true` call finds a non-force run in flight, await it and then run the forced pass (or 409). Pin with a test; document in Decision 5b.

### R2-M3 (Plan) — `assertOnPage` requires exact hostname equality; `assertOnArchivePage` deliberately tolerates `*.eminiplayer.net`

**Location:** Plan Task 2 Step 4.
**Failure scenario:** If the site 301-canonicalizes `www.` ↔ apex (the exact variance the archive assert was written to tolerate), every detail-page navigation throws `eminiplayer navigation failed` once selectors land — every date 502s at `resolve (recap)` while the archive half of the same pipeline works. Task 2's tests ship the strictness as "done".
**Suggested fix:** Reuse the archive assert's hostname rule (apex or `*.eminiplayer.net`) in `assertOnPage`, keep the exact-pathname check, add a host-form-differs-accepted test.

### R2-M4 (Spec) — The video-title format gate is a hard 422 built on a format never verified against a real YouTube title

**Location:** Spec Decision 6B; Plan Task 3 `assertVideoTitle` / Task 6 (title check runs first, gating even resume paths).
**Failure scenario:** If the channel's real titles use "6/30/26", spelled dates, or no date, **every day** 422s at the first check of every run and the pipeline is bricked until a code change. Loud and diagnosable, but a total stall at backfill volume, and the 422's meaning ("source data wrong") mislabels our-expectation-wrong.
**Suggested fix:** Add to the `TODO(selectors)` follow-up checklist: capture 3–5 real oEmbed titles and encode observed forms before trusting the gate; distinguish "unparseable format" from "contradictory date" in the error message.

## Low

- **R2-L1 (Plan, Task 1/6):** oEmbed 404/401 (video deleted/private) maps to retryable 502 instead of 422 — permanent condition, infinite retry loop. Fix: map oEmbed 4xx to `IngestValidationError`, keep network/5xx as transport.
- **R2-L2 (Plan, Task 8):** audit checks claims→manifest (orphans) but not manifest→claims; a manually-deleted claim leaves the uniqueness invariant unenforced undetected. Fix: inverse check, flag manifested ids without a matching `{date, slot}` claim.
- **R2-L3 (Spec/Plan, manifest shape):** `checks` is seven write-only always-true booleans; audit docstring claims "verdict is recorded in each manifest" — it isn't. When a committed day is questioned, there's no evidence to inspect. Fix: record the two `TranscriptVerdict`s + verify model + the two oEmbed titles instead of booleans (also enables offline title re-audit).
- **R2-L4 (Plan, Tasks 5/6/8):** storage-layout knowledge (`knowledge-base/es/<date>/`, filename templates, manifest name) duplicated across orchestrator, manifest service, and audit; audit regex drifting from the writer silently audits nothing and reports "clean". Fix: one shared `dayPaths(date, recapDate)` helper.
- **R2-L5 (Plan, Task 4):** recaps routinely preview the next session ("tomorrow, Wednesday…"); a cheap classifier can latch onto the previewed weekday → systematic false 422s at volume. Fix: tighten the prompt ("the session this video primarily covers; ignore next/previous-session mentions").
- **R2-L6 (Plan, Task 8):** no test exercises the gate-failure anomaly branch (the tamper fixture only trips the hash check). Fix: fixture whose manifest sha matches a stored-but-gate-failing artifact.
- **R2-L7 (Plan, Task 6):** the stale-recap test never exercises the exclusion filter with the current recap present; an off-by-one deleting the run's own recap would pass. Fix: test with both stale and current recap pre-seeded.
- **R2-L8 (Plan, Task 1):** byte-parity test uses a 3-segment fixture; spec requires a real-shaped knowledge-base fixture (dozens of lines, H:MM:SS boundary, entities). Fix: add it.
- **R2-L9 (Plan, Task 3):** `assertVideoTitle` accept-fixtures carry calendar-wrong weekdays ("Monday 06/30/2026" — it's a Tuesday), teaching the wrong invariant in a plan built on weekday cross-checks. Fix: correct weekdays + a comment that weekday agreement is deliberately out of this function's scope.
- **R2-L10 (Plan, Task 8):** the per-day try/catch labels any per-file transport error "manifest unreadable", misdirecting operators and double-reporting days. Fix: narrow the catch to manifest download+parse.
- **R2-L11 (Plan, Task 8 Step 5):** wiring instructions omit the `AuditReport` import and show no code for the controller-spec `build` change. Fix: name the import, show the two-line diff.
- **R2-L12 (Plan, Task 4):** `configuration.spec.ts` deletes only the four existing `EMINIPLAYER_*` env vars; an environment with `EMINIPLAYER_VERIFY_MODEL` exported makes its exact-shape `toEqual` fail — an environment-dependent full-suite red surfacing confusingly at Task 6. Fix: delete the new var in that spec's `beforeEach`.

## Verified sound in round 2 (not scored)

Every newly-introduced repo/dependency claim checked true: `LLM_PROVIDER`/`messageStructured`/`StructuredRequest`/`Attribution{operation:'other'}`, `LlmModule` and `FirebaseModule` both `@Global()`, Firestore transaction API against firebase-admin 12.7, `file.delete({ignoreNotFound})`/`download()`/`getFiles({prefix})`/`save()` against @google-cloud/storage 7.21, global fetch/Response typing under @types/node 20, all 2026 calendar fixtures (except R2-L9's titles), the 7 `build(page)` call sites, the coalescing test's determinism, the manifest-service transaction-order assertions, the audit tests' map/count math, the `FakeGlobalsModule` DI reasoning, and cross-task name consistency (zero drift across all 8 tasks). Crash-between-claim-and-manifest recovers via idempotent re-claim; Playwright cannot deadlock across dates; SSRF shape adequate.

## Round 2 outcome tracking

All 20 findings applied 2026-08-06 (user: "all").

| # | Finding | Status | How |
|---|---|---|---|
| R2-H1 | Short-circuit freezes wrong-recap committed day | applied | Short-circuit now reads the manifest (`manifest.read`), builds the response from it, and throws `IngestValidationError` on recapDate drift; spec flow + Decision 4 updated; two tests |
| R2-H2 | Force never releases video-id claims | applied | `EminiplayerManifestService.delete` reads the manifest and releases day-owned claims (transactional, never foreign) before removing it; three tests |
| R2-H3 | Audit doesn't scale | applied | `AuditOptions {from,to,deep}`; shallow default compares GCS listing `md5Hash`/`size` (no content downloads, `md5` added to `FileRecord` + `md5Base64` helper); `deep=true` downloads + sha256 + gates; controller query params; tests incl. shallow-downloads-only-manifest |
| R2-H4 | Gate test asserts on memoized file handle | applied | Assertion changed to `.not.toHaveBeenCalled()` with an explanatory comment; mid-run test's valid `toBeUndefined()` kept |
| R2-M1 | Spec upload-then-gate contradiction | applied | Spec flow step 3 + 422 row now state gate-before-upload and scope "artifacts stay in place" |
| R2-M2 | Coalescing drops force flag | applied | Inflight map stores `{force, run}`; force finding a non-force run awaits it then runs forced; spec Decision 5b; test |
| R2-M3 | assertOnPage exact-hostname strictness | applied | Hostname compared modulo leading `www.`; acceptance test added |
| R2-M4 | Title-format gate unverified | applied | Spec Decision 6B caveat + `TODO(selectors follow-up)` comment; `assertVideoTitle` distinguishes contradictory-date from no-recognizable-date |
| R2-L1 | oEmbed 4xx → 502 misclassification | applied | `VideoUnavailableError` in TranscriptService (4xx vs 5xx tests); orchestrator maps it to `IngestValidationError` |
| R2-L2 | Missing manifest→claims inverse check | applied | Audit checks both directions (`no video-id claim matching …`); test |
| R2-L3 | Write-only `checks` booleans | applied | `DayManifest.checks` replaced by `evidence` (both titles + both `TranscriptVerdict`s); `verifyTranscript` returns the verdict; happy-path assertions |
| R2-L4 | Storage-layout duplication | applied | `ES_STORAGE_PREFIX`/`manifestPath`/`dayPaths` in validation module; orchestrator, manifest service, audit all consume them; test |
| R2-L5 | referencedWeekday false 422s | applied | SYSTEM prompt: primary-session rule, ignore next/previous-session mentions |
| R2-L6 | Audit gate-anomaly branch untested | applied | Deep-mode test with hash-consistent, gate-failing artifact |
| R2-L7 | Stale-recap exclusion filter untested | applied | Test seeds stale + current recap; asserts exactly one deleted |
| R2-L8 | Byte-parity fixture too small | applied | Real-shaped 42-line fixture with entities + H:MM:SS boundary |
| R2-L9 | Wrong-weekday accept fixtures | applied | Calendar-correct weekdays + scope comment |
| R2-L10 | Audit catch misattribution | applied | Catch narrowed to manifest download+parse; per-file failures → `<artifact> unreadable`; test |
| R2-L11 | Missing AuditReport import / build diff | applied | Full import lines, constructor, route with validation, and the spec `build` helper shown |
| R2-L12 | configuration.spec env leak | applied | Task 4 adds `delete process.env.EMINIPLAYER_VERIFY_MODEL` + shape/override test |

---

# Round 1 — 2026-08-06 (original 4-task pipeline)

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
