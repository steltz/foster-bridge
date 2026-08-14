# Review: EminiPlayer Bulk Backfill spec + plan

**Reviewed:** 2026-08-14, before implementation (feature unbuilt).
**Spec:** `docs/superpowers/specs/2026-08-14-eminiplayer-bulk-backfill-design.md`
**Plan:** `docs/superpowers/plans/2026-08-14-eminiplayer-bulk-backfill.md`
**Method:** four parallel adversarial critics (spec–plan consistency, internal plan correctness,
architecture soundness, codebase grounding), findings deduped, severities per the standard
rubric (critical −3, high −2, medium −1, low −0.5, clamp at 1).

## Scores

| doc | score | rationale |
|---|---|---|
| **Spec** | **3 / 10** | Architecture is sound at the unit-boundary level and every claim about existing code verified true, but four shutdown/robustness gaps (zombie browser after teardown, wedgeable singleton, stale-frontier recap commits, unauthenticated 19-hour amplification) plus a self-contradictory `skipped` definition are real ship-a-bug risks. |
| **Plan** | **1 / 10** (clamped) | Cannot go green as written: three independent blockers (a racing cancel test paired with a "fix the service, not the test" directive that would corrupt DELETE semantics, `.rejects` assertions against a synchronous handler, mock typings that fail ts-jest compilation and take existing tests down) plus a compile-breaking snippet in Task 3. All are cheap to fix — but "built exactly as written," an implementer stalls or ships weakened semantics. |

Grounding note: the codebase-grounding critic verified essentially every file path, symbol,
signature, visibility, line citation, calendar claim, and framework assumption in both docs as
accurate — the deductions above are concentrated in the plan's test snippets and the spec's
long-run operational story, not in its description of the existing system.

---

## High

**H1 — plan, Task 6 Step 1, "cancel lets the in-flight day finish…" (found independently by 3 critics)**
Failure: the test calls `service.cancel()` synchronously after `start()`, while `runLoop` is
still suspended at its first `await fetchArchiveRows()`. The flag is set before iteration 1,
the loop breaks immediately with `processed: 0` and zero ingest calls, and the assertions
(`processed: 1`, called once) fail deterministically. Task 6's directive "if one fails, fix the
service, not the test" then steers the implementer into moving the cancel check after day
processing — which silently weakens the spec's DELETE contract (a cancel would always let one
more day start) while making the suite green.
Fix: synchronize the test on entry into the gated day (resolve a "started" deferred from
inside the ingest mock, await it, then `cancel()`, then release), and soften the
"fix the service" directive to allow fixing a test whose synchronization is wrong.

**H2 — plan, Task 7 Step 1, the POST rejection tests (2 critics)**
Failure: `startBackfill` as implemented in Step 3 is synchronous and throws directly, but the
bad-range, reversed-range, and 409 tests use `await expect(controller.startBackfill(...)).rejects.toThrow(...)`.
The throw happens while evaluating `expect`'s argument, so all five tests fail even against a
correct implementation; Step 4's "all green" is unreachable. (The GET/DELETE tests in the same
describe correctly use the sync form.)
Fix: change the POST assertions to `expect(() => controller.startBackfill(...)).toThrow(...)`
(or make the handler `async` — pick one, keep test and implementation consistent).

**H3 — plan, Task 7 Step 1, backfill mock typing (2 critics)**
Failure: `backend/jest.config.js` runs plain ts-jest with type-checking and `strictNullChecks`.
`start: jest.fn(() => JOB)` infers a zero-arg, non-nullable mock, so
`backfill.start.mock.calls[0][1]` is TS2493 and both `mockReturnValue(null)` calls are TS2345 —
the whole `eminiplayer.controller.spec.ts` fails to compile, taking the pre-existing
ingest/audit tests down with it. Even Step 2's predicted failure ("startBackfill does not
exist") is wrong; the implementer sees compile errors instead.
Fix: type the mocks loosely (e.g. `jest.fn((..._args: unknown[]) => JOB as BackfillJobSnapshot | null)`)
so argument capture and `mockReturnValue(null)` compile.

**H4 — spec, Components + "Backend restarted mid-job" edge case**
Failure: neither doc gives the detached loop a shutdown hook, and `PlaywrightService` has no
destroyed latch. On SIGTERM/`app.close()` mid-run, `onModuleDestroy` closes the browser, the
in-flight day fails as a `stage` error, the loop continues, and `acquirePage()` sees
`isConnected() === false` and **relaunches a fresh Chromium after teardown** — the old process
keeps scraping (possibly alongside a restarted process) and never drains its event loop. This
is the already-observed "SIGTERM hangs, needed kill -9" symptom, extended across a 19-hour
window where a restart attempt is likely.
Fix: give `EminiplayerBackfillService` an `onApplicationShutdown` that sets `cancelRequested`
(and awaits `loopPromise` where feasible), and add a destroyed flag to
`PlaywrightService.acquirePage` that throws instead of relaunching after teardown.

## Medium

**M5 — spec (Components step 2–3 vs Job-snapshot definitions; plan Task 5 `allSkipped`) (2 critics)**
Failure: "all files skipped → skipped++, no delay" conflates "committed, served from manifest"
with fill-and-skip. A day resumed after a crash between artifact upload and manifest commit
returns all-`skipped` file statuses after doing 2 detail-page loads, 2 oEmbed fetches, 2 LLM
verifies, and a manifest commit — counted as manifest-served and given no politeness delay,
contradicting the spec's own count definitions, and Task 5's tests pin the wrong meaning.
Fix: make the committed-day short-circuit the explicit signal (e.g. add a `fromManifest`
boolean to `IngestResult`) and key both the count and the delay off it.

**M6 — spec, Decision 2 "staleness is not a concern"**
Failure: the frozen listing makes recap selection stale at the frontier. A recap posted after
the scrape (late-posted prior-session recap, scrape run early morning) is invisible;
`selectDayEntries` picks an older in-window recap, every gate passes against that older date,
and the day **commits with the wrong recap** — which the drift-refusal then blocks on every
future run until a human `force`.
Fix: for candidate days within `RECAP_LOOKBACK_DAYS` of the scrape timestamp, omit
`resolvedEntries` and fall back to a fresh `findDayEntries`; document the freshness contract
on the seam.

**M7 — spec, DELETE semantics / Decision 5**
Failure: no per-day time bound exists anywhere — `fetchVideoTitle` is a bare `fetch()` with no
abort, transcript and LLM calls have no documented timeout, and cancel is only checked between
days. One hung await leaves the job `running` forever: DELETE never completes its contract,
POST 409s forever, and the only remedy is the process restart the design treats as rare.
Fix: wrap each day (or each external fetch) in a timeout that converts a hung day into a
`stage` ledger entry so the loop always regains control.

**M8 — spec, API section (new exposure)**
Failure: one anonymous POST now triggers ~19 hours of scraping a paid membership site with the
operator's credentials, ~8,600 YouTube fetches, and LLM spend; one anonymous DELETE cancels a
19-hour run. Existing routes are equally unauthenticated, but the amplification is new, and
neither doc states the loopback-only assumption.
Fix: state the listen-address assumption in the spec and add a cheap guard (shared token
header or localhost-only check) on the backfill routes.

**M9 — plan, Task 3 Step 1, `getMockImplementation()!(DATE)` (2 critics)**
Failure: the builder's mock is a zero-parameter `jest.fn(() => Promise.resolve(entries))`, so
calling its implementation with an argument is a TS2554 compile error that breaks the whole
existing ingest spec file; the plan's fallback parenthetical mis-describes the condition, so
an implementer plausibly takes the broken primary path first.
Fix: use the builder's module-level `ENTRIES` constant directly and delete the
`getMockImplementation` line.

## Low

**L10 — plan, Task 5 `runDay` catch returns `true` (2 critics).** Pre-ingest failures
(`selectDayEntries` throws; pure, zero network) still sleep the politeness delay — a re-POST
over a range with `notFound` residue pays ~2 s per failed day for nothing. Fix: return `false`
from the pre-ingest failure path.

**L11 — spec, Goal section.** "Old-era days simply land in the failure ledger" is wrong: the
plan (correctly) never makes unclassifiable old-era titles candidates at all, so they're
silently absent from counts and ledger — an operator running `from=01012011` finds nothing to
triage and may conclude the days don't exist. Fix: amend the sentence to "silently excluded
from the candidate list."

**L12 — plan/spec, `start()` validation.** The spec's component contract says `start(from, to)`
validates; the plan puts all validation in the controller, so a future non-HTTP caller with a
reversed range silently gets `done` with `candidates: 0`. Fix: validate (or assert) in the
service too, or amend the spec.

**L13 — plan, Task 1 `listTradePlanDates`.** A shape-valid but impossible row date
(`2026-02-31`) passes `rowDateToMmddyyyy` and then `parseMmddyyyy` **throws**, escalating one
garbage row to a job-level `failed` at resolve — where the same row inside `selectDayEntries`
would only cost one day. Fix: try/continue around the per-row parse.

**L14 — plan, Task 3 force-coalescing recursion.** `return this.ingest(date, true)` drops
`resolvedEntries` — latent (bulk never forces) but a future caller inherits the silent
re-scrape. Fix: pass `resolvedEntries` through.

**L15 — spec, job state machine.** Selector drift yielding 0 rows completes a 2018→today job
as `done` with `candidates: 0` — total scrape failure reported as success. Fix: treat 0
classifiable rows over a multi-month range as job-level `failed`.

**L16 — plan, Task 5 `start()/status()` return the live mutable job object.** Any future
response transform (or test) that mutates the returned object writes through into job state.
Fix: return a copy (`structuredClone`) from the public methods.

**L17 — plan, Task 7 `todayMmddyyyy()`.** Server-local time vs the site's ET trading dates: a
server west of ET computes "today" a day behind around midnight and the paired test can flake.
Fix: compute in `America/New_York` or document the approximation.

**L18 — plan, Task 3.** The new signatures reference `DayEntries`, but the plan never
instructs extending the `./eminiplayer.constants` import (currently only
`ArchiveEntry, ArchiveNotFoundError, INGEST_PIPELINE_VERSION`) — TS2304 until the implementer
figures it out. Fix: add the import step.

**L19 — plan, Tasks 2–3 Step 2 expectations.** ts-jest type-checks, so the predicted failures
("is not a function", "findDayEntries WAS called") actually surface as compile errors (TS2339 /
TS2554); a strict TDD implementer may stall reproducing the documented failure mode. Fix:
reword both Step 2 expectations to "fails to compile."

---

## Verified sound (explicitly checked, no finding)

Second `start()` racing a finishing loop; cancel racing day completion; GET torn reads
(single-threaded synchronous mutations); memory bounds of the rows array and ledger; scraped
hrefs into credentialed navigation (same-origin enforced); concurrent single-day ingest during
bulk (withPage serialization + coalescing map); the single-scrape N+1 elimination; every file
path, exported symbol, signature, visibility, line citation, calendar claim, jest fixture
shape, module-wiring claim, and error-message string in both documents.

## Outcome tracking

All 19 findings were accepted and applied on 2026-08-14 by rewriting both documents
(spec revised in place; plan rewritten with the fixes baked into the task code).

| # | severity | status | where it landed |
|---|---|---|---|
| H1 | high | applied | plan Task 7 — cancel test synchronizes on day entry (`startedP`) before cancelling; "fix the service, not the test" directive removed; companion cancel-before-first-day test pins the DELETE contract |
| H2 | high | applied | plan Task 8 — all controller assertions use the sync `expect(() => …).toThrow` form; handlers stay synchronous |
| H3 | high | applied | plan Task 8 — backfill mocks typed `jest.fn() as jest.Mock` with `mockReturnValue` set separately |
| H4 | high | applied | spec decision 6 + new plan Task 5 (Playwright destroyed latch) + `onApplicationShutdown` in Task 6/7 |
| M5 | medium | applied | spec snapshot definitions + `IngestResult.fromManifest` (plan Task 3); counting/delay keyed on it (Task 6) with a fill-and-skip test |
| M6 | medium | applied | spec decision 2 carve-out + frontier fresh-resolve in Task 6 (`now()` seam) with Task 7 test; smoke week exercises it |
| M7 | medium | applied | spec decision 7 + `backfillDayTimeoutMs` config (Task 4) + `withDayTimeout` (Task 6) + hung-day test (Task 7) |
| M8 | medium | applied | spec Exposure guard + `backfillToken` config (Task 4) + `x-backfill-token` guard and tests (Task 8) |
| M9 | medium | applied | plan Task 3 — uses the builder's `ENTRIES` constant directly |
| L10 | low | applied | `runDay` returns `ingestInvoked` on failure; pinned by the notFound-no-sleep assertion (Task 7) |
| L11 | low | applied | spec Goal reworded: old-era titles silently excluded from candidacy, never ledgered |
| L12 | low | applied | `start()` validates the range itself (Task 6) + test |
| L13 | low | applied | per-row `parseMmddyyyy` try/continue in `listTradePlanDates` + impossible-date test (Task 1) |
| L14 | low | applied | force-coalescing recursion passes `resolvedEntries` through (Task 3) |
| L15 | low | applied | zero-classifiable-rows drift tripwire → job `failed` (Task 6) + tripwire and empty-range tests (Task 7); spec state-machine wording updated |
| L16 | low | applied | public methods return `structuredClone` snapshots (Task 6) + copies test |
| L17 | low | applied | `todayMmddyyyy()` computed in America/New_York (Task 8) + test |
| L18 | low | applied | Task 3 spells out the extended `DayEntries` constants import |
| L19 | low | applied | Tasks 2/3/6/8 Step 2 expectations reworded to compile-time failures (ts-jest) |
