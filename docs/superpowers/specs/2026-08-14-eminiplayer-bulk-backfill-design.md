# EminiPlayer Bulk Backfill — Design

**Date:** 2026-08-14 (revised same day after adversarial review — see
`../plans/2026-08-14-eminiplayer-bulk-backfill-review.md`; findings H4, M5–M8, L11, L12, L15
are incorporated below)
**Status:** Approved
**Builds on:** `2026-08-06-eminiplayer-ingest-pipeline-design.md` (single-day ingest, layered
verification, manifests) and the live-validated scrapers landed at `f078769`.

## Goal

Ingest years of EminiPlayer document groups — trade-plan PDF + TP transcript + prior-session
recap transcript per day — through one long-running server-side job, instead of a client-side
loop over `POST /eminiplayer/ingest?date=`.

**Validation target: 2018 → today (~2,150 trading days).** The endpoint itself is
range-agnostic, but every format assumption is validated against the modern era only
(`ES Key Zones and Trade Plan for …` / `ES Recap …Video Lesson… for …`), which a full capture
of the live archive (8,419 listing rows, 2026-08-14) shows is uniform from 2018 on. Older eras
(`Key Levels` 2011–2017, bare `ES Recap for` 2012–2016, the recap-less 2010–2011 era) are out
of scope. Old-era titles the classifier cannot parse are **silently excluded from the
candidate list** — they never appear in counts or the failure ledger, so a pre-2018 range
"completing clean" says nothing about those days; only days that *became candidates* and then
failed are ledgered.

## Decisions (with rationale)

1. **In-memory singleton job; re-POST to resume.** The per-day manifests are already the
   durable state: a committed day short-circuits to a manifest-served result in ~0.2 s with
   zero site traffic (proven live on 08132026). A Firestore-backed job record would duplicate
   that for a job run a handful of times. Cost of a process death mid-run is one re-POST plus
   one listing re-scrape.
2. **Single-scrape resolve (option B) — with a frontier-freshness carve-out.** `ingest(date)`
   today re-downloads the entire 1.7 MB archive listing per day. The bulk job scrapes the
   listing once and derives every day's `DayEntries` from that one capture via the
   already-pure `selectDayEntries`. Per day this drops the footprint to 2 detail-page loads +
   1 PDF, saving ~2,150 listing loads (~3.6 GB) and roughly a third of the wall clock.
   Staleness is not a concern for **historical** days (the listing is append-only for the
   past), but it IS a concern at the frontier: recap selection is time-sensitive, and a recap
   posted *after* the scrape would be invisible — `selectDayEntries` would pick an older
   in-window recap, every gate would pass against that older date, and the day would commit
   frozen-wrong data. Therefore **days within `RECAP_LOOKBACK_DAYS` of the scrape moment are
   resolved fresh** (the seam's `resolvedEntries` is omitted and the single-day
   `findDayEntries` runs) — at most ~10 extra listing loads per job. The `resolvedEntries`
   seam's contract is: entries must come from a scrape no older than
   `RECAP_LOOKBACK_DAYS` before the day being ingested.
3. **Continue-on-error with a per-day failure ledger.** One bad day must never stop a
   multi-hour run. Failures are recorded and classified; the job finishes the range.
4. **No `force` on bulk.** Re-ingesting a day is the single-day endpoint's job
   (`?force=true`). A bulk force over years is an expensive foot-gun with no current use.
5. **One job at a time.** All scraping serializes through the one Playwright tab anyway;
   overlapping bulk jobs would interleave pointlessly. Second POST while running → 409.
6. **The job participates in application shutdown.** A 19-hour run will meet a SIGTERM. The
   backfill service implements `onApplicationShutdown` (sets the cancel flag so no further
   days start), and `PlaywrightService` gets a destroyed latch so `acquirePage` **throws after
   teardown instead of relaunching Chromium** — without it, the dead-browser recovery path
   resurrects a fresh browser mid-shutdown and the process never drains (the already-observed
   "SIGTERM hangs, kill -9 required" symptom).
7. **Every day is time-bounded.** External calls (YouTube oEmbed/transcript, LLM verify,
   Playwright navigation) have no reliable timeouts of their own; one hung socket must not
   wedge the singleton forever (DELETE unable to complete, POST 409ing until a process kill).
   Each day's ingest is raced against `eminiplayer.backfillDayTimeoutMs` (default **600000** =
   10 min); a timeout becomes a `stage` ledger entry and the loop moves on. The abandoned
   day's promise keeps running harmlessly in the background — days are idempotent and
   manifest-gated, so if it eventually completes, it simply commits.

## API

```
POST   /eminiplayer/backfill?from=MMDDYYYY&to=MMDDYYYY
GET    /eminiplayer/backfill
DELETE /eminiplayer/backfill
```

- `from` **required**; `to` optional, defaults to today **in America/New_York** (the site's
  trading-date timezone — a server west of ET must not compute yesterday). Both must be real
  calendar dates (same `isValidMmddyyyy` rule as `/ingest`); `from ≤ to` else 400. The
  **service validates the range too** (`start()` throws on a malformed or reversed range), so
  a future non-HTTP caller cannot silently get a `done`/`candidates: 0` job out of a bad
  range.
- `POST` returns **202** immediately with the initial job snapshot; the work runs detached
  inside the service. A job already `running` → **409** with the running job's snapshot in
  the error body. Starting a new job replaces the retained snapshot of a finished one.
- `GET` returns the current (or most recently finished) job snapshot; **404** only when no
  job has run since boot. Snapshots returned from every route (and from the service's public
  methods) are **copies**, never the live internal object.
- `DELETE` requests cancellation: the in-flight day finishes (a day is atomic — its manifest
  either commits or doesn't), **no further days start** — a cancel that lands before the
  first day starts cancels with zero days processed. Terminal state `cancelled`. **404** only
  when no job has run since boot (same rule as `GET`); against an already-finished job it is
  a no-op **200** answered with the retained snapshot. The snapshot acknowledges the request
  via `cancelRequested` while the in-flight day finishes.

### Exposure guard

These routes command ~19 hours of credentialed scraping of a paid membership site, ~8,600
YouTube fetches, and LLM spend from a single anonymous request — a categorically bigger
amplification primitive than the existing one-day routes. The backend is assumed to listen on
loopback only (its current deployment); as a cheap belt-and-suspenders guard, when
`EMINIPLAYER_BACKFILL_TOKEN` is configured, `POST` and `DELETE` require a matching
`x-backfill-token` header (mismatch/absence → **401**). `GET` (read-only status) stays
unguarded. Unset token = no guard, preserving the local-dev workflow.

### Job snapshot

```jsonc
{
  "state": "running",            // running | done | cancelled | failed
  "from": "01012018",
  "to": "08142026",
  "startedAt": "2026-08-14T13:00:00.000Z",
  "finishedAt": null,            // set on any terminal state
  "currentDate": "03052019",     // day in flight, null when not running
  "cancelRequested": false,      // true once cancellation was requested (DELETE ack)
  "counts": {
    "candidates": 2150,          // TP dates found in range (null until listing scraped)
    "processed": 312,            // days attempted so far
    "uploaded": 300,             // days where the pipeline actually ran (produced or re-verified artifacts)
    "skipped": 9,                // days served entirely from a committed manifest (fromManifest)
    "failed": 3
  },
  "failures": [                  // full ledger, in processing order
    { "date": "02192018", "kind": "notFound",   "message": "no ES recap entry within 14 days strictly before 02192018" },
    { "date": "07032019", "kind": "validation", "message": "video title \"…\" does not look like a recap video" },
    { "date": "11122020", "kind": "stage",      "message": "eminiplayer ingest failed at transcribe (recap): …" }
  ],
  "error": null                  // only for state "failed": the job-level (not per-day) error
}
```

`skipped` vs `uploaded` is decided by an explicit signal, not inferred from file statuses:
`IngestResult` gains **`fromManifest: boolean`** — `true` only when the committed-manifest
short-circuit answered the day. A "fill-and-skip" day (artifacts existed but the manifest was
never committed — the crash-frontier case) reports all files `skipped` yet `fromManifest:
false`, because it really did 2 detail-page loads, 2 transcript re-verifies, and a manifest
commit; it counts as `uploaded` and pays the politeness delay.

Failure `kind` classification mirrors the single-day HTTP mapping:

| kind         | source error              | meaning                                   | re-POST behavior |
| ------------ | ------------------------- | ----------------------------------------- | ---------------- |
| `notFound`   | `ArchiveNotFoundError`    | day can't satisfy the TP+recap contract   | retried (same result until the archive changes) |
| `validation` | `IngestValidationError`   | permanent data condition — human review   | retried |
| `stage`      | `IngestStageError` or a day timeout | transient infrastructure/scrape failure | retried, likely succeeds |
| `unknown`    | anything else             | bug — investigate                         | retried |

`state: "failed"` is reserved for job-level failures that prevent processing any days at all:
the listing scrape or login failed, **or the scrape returned zero classifiable trade-plan rows
across the whole archive** (a selector-drift tripwire — without it, markup drift on
archive.aspx would report a 2018→today job as `done` with `candidates: 0`). A range that
legitimately contains no candidates (weekend, holiday span) while the archive still has
classifiable TP rows elsewhere completes `done` with `candidates: 0`. Per-day errors never
fail the job.

## Configuration

| env | config key | default | purpose |
| --- | --- | --- | --- |
| `EMINIPLAYER_BACKFILL_DELAY_MS` | `eminiplayer.backfillDelayMs` | `2000` | pause after each day that touched the network |
| `EMINIPLAYER_BACKFILL_DAY_TIMEOUT_MS` | `eminiplayer.backfillDayTimeoutMs` | `600000` | per-day ceiling; a timed-out day becomes a `stage` ledger entry |
| `EMINIPLAYER_BACKFILL_TOKEN` | `eminiplayer.backfillToken` | unset | when set, `POST`/`DELETE` require a matching `x-backfill-token` header |
| `EMINIPLAYER_BACKFILL_MAX_CONSECUTIVE_STAGE_FAILURES` | `eminiplayer.backfillMaxConsecutiveStageFailures` | `20` | abort the job after N consecutive `stage` failures |

## Components

### `EminiplayerBackfillService` (new)

Owns the singleton job. `start(from, to)` **validates the range itself** (real calendar dates,
`from ≤ to` — throws on violation), rejects if running, snapshots the job as `running`, and
kicks the detached loop:

1. **Resolve once:** `eminiplayer.fetchArchiveRows()` → tripwire: zero classifiable
   trade-plan rows anywhere in the scrape → job-level `failed`. Then
   `listTradePlanDates(rows, from, to)` → `counts.candidates`. Order **oldest → newest**.
2. **Per day:** if cancelled → break. **Frontier check:** if the day is within
   `RECAP_LOOKBACK_DAYS` of the scrape moment, call `ingest(date, false)` with **no**
   pre-resolved entries (fresh listing resolve — decision 2); otherwise derive `DayEntries`
   with `selectDayEntries(rows, date, ARCHIVE_URL)` (throws → ledger, continue) and call
   `ingest(date, false, entries)`. The whole day races the
   `backfillDayTimeoutMs` ceiling (decision 7). Classify the outcome:
   `result.fromManifest` → `skipped++`; else `uploaded++`; thrown/timeout → ledger +
   `failed++`, continue. A `stage`-kind outcome increments a consecutive-stage-failure
   counter; any success or non-`stage` failure resets it to zero. Once the counter reaches
   `eminiplayer.backfillMaxConsecutiveStageFailures` (default 20), the job aborts as
   job-level `failed` — a broken session or a YouTube throttle at hour 6 must not silently
   burn the remaining thousands of days.
3. **Pacing:** sleep `eminiplayer.backfillDelayMs` after each day **that touched the
   network** — `fromManifest` days and days that failed *before* ingest was invoked (a pure
   `selectDayEntries` throw) skip the delay, so a resume sprints through the committed prefix
   and through `notFound` residue alike.
4. Terminal state `done` (or `cancelled`); `finishedAt` set; snapshot retained for `GET`.

The loop's promise is held by the service but never awaited by a request handler; every
per-day exception is caught inside the loop. A crash of the loop itself (outside per-day
handling) sets `state: "failed"` with the error message rather than leaving a zombie
`running` snapshot. `onApplicationShutdown` sets the cancel flag (decision 6). Public methods
(`start`/`status`/`cancel`) return **structured clones** of the job, never the live object.

### `PlaywrightService` destroyed latch (modify)

`onModuleDestroy` sets a `destroyed` flag; `acquirePage` throws
(`eminiplayer: browser has been shut down`) when it is set, instead of relaunching a fresh
Chromium via the dead-browser recovery path. Required by decision 6.

### `EminiplayerService.fetchArchiveRows()` (refactor)

The navigate + authenticate + `$$eval(SELECTORS.archiveRows, …)` half of today's
`findDayEntries`, extracted; `findDayEntries(date)` becomes
`fetchArchiveRows()` + `selectDayEntries(rows, date, ARCHIVE_URL)`. Public behavior of
`findDayEntries` is unchanged; its existing spec stays green.

### `listTradePlanDates(rows, from, to)` (new pure function, `eminiplayer-archive.ts`)

Classified trade-plan rows (`classifyArchiveTitle` → `kind: 'tradePlan'`) whose **row date**
falls in `[from, to]`, deduped, sorted ascending, returned as `MMDDYYYY[]`. Rows that fail
classification, have malformed date cells, **or carry a shape-valid but impossible calendar
date** (`2026-02-31` — `parseMmddyyyy` would throw) are skipped, never fatal: one garbage cell
among 8,419 rows of a 14-year-old WebForms listing must cost nothing, not the whole job.

### `EminiplayerIngestService.ingest(date, force, resolvedEntries?)` (seam) + `fromManifest`

When `resolvedEntries` is provided, the resolve stage uses it instead of calling
`eminiplayer.findDayEntries(date)`; the force-coalescing retry passes `resolvedEntries`
through. Every downstream step — `assertDayInvariants`, the consumer-side
`tradePlan.date === date` backstop, the committed-day short-circuit **including its
recapDate-drift refusal**, stale-recap sweep, transcribe, title gate, LLM verify, upload,
manifest commit — is byte-for-byte the existing flow. `IngestResult` gains
`fromManifest: boolean` (true only on the committed-manifest short-circuit) so the bulk job —
and any future caller — can tell manifest-served from fill-and-skip. The in-flight per-date
coalescing map keeps working, so a manual `POST /ingest?date=` for a day the bulk job is
currently running coalesces onto the same run instead of colliding.

### Controller (`eminiplayer.controller.ts`)

Three thin routes mapping to the service; validation errors → 400, already-running → 409
(`ConflictException`), no-job → 404, token mismatch (when configured) → 401. `POST` is
`@HttpCode(202)`. Default `to` computed in `America/New_York`.

## Load, cost, duration (2018 → today)

| resource | per day | ~2,150 days |
| --- | --- | --- |
| eminiplayer.net page loads | 2 detail + 1 PDF | ~6,450 (+1 listing, + ≤ ~10 frontier re-resolves) |
| YouTube | 2 oEmbed + 2 transcript fetches | ~8,600 |
| kimi-k2.6 verify | 2 calls ≈ $0.0008 | ≈ $1.75 |
| wall clock | ~30 s + 2 s delay | **~19 h** |

All site traffic rides the single serialized Playwright tab. `PlaywrightService` already
replaces a crashed browser on next use (while the app is alive — after shutdown the destroyed
latch forbids it); a process death costs one re-POST.

## Edge cases

- **Recap-missing day** (holiday-adjacent, charts-only): `selectDayEntries` throws
  `ArchiveNotFoundError` → ledger `notFound`, continue, **no delay** (nothing touched the
  network).
- **Committed day whose archive recap has drifted:** the seam preserves the existing
  `IngestValidationError` refusal → ledger `validation`. Deliberate: frozen-wrong data needs
  a human `force`, not silent bulk regeneration.
- **Backend restarted mid-job:** shutdown hook cancels the loop; the Playwright latch stops
  browser resurrection; the process drains. `GET` after restart → 404 (memory gone). Re-POST
  the same range; committed days short-circuit at ~0.2 s each with no delay, so catching up
  to the frontier is minutes, not hours.
- **Hung external call deep into the run:** the day timeout converts it to a `stage` ledger
  entry and the loop regains control; cancel/DELETE stay honest.
- **YouTube throttling:** shows up as `stage` failures; the delay is the first knob
  (`EMINIPLAYER_BACKFILL_DELAY_MS`), a re-POST later retries exactly the failed days.
- **Single-day `POST /ingest` during a bulk run:** allowed; same-date calls coalesce; other
  dates interleave through the Playwright queue.

## Non-goals

- No durable job record, no auto-resume on boot (decision 1).
- No bulk `force` (decision 4).
- No parallel day processing — the Playwright tab and site politeness both argue for
  sequential.
- No pre-2018 era support work: no new title forms, no TP-only day contract for the
  recap-less 2010–2011 era. Old-era titles are silently excluded from candidacy (see Goal).
- No webhook/notification on completion; `GET` is the interface.
- No auth beyond the optional token guard — the loopback assumption is stated above; full
  authn/z is out of scope for a single-operator local tool.

## Testing

- **Pure:** `listTradePlanDates` — range bounds inclusive, dedupe, ascending order, skips
  unclassifiable/malformed rows AND shape-valid-but-impossible dates without throwing.
- **Service refactor:** `fetchArchiveRows` navigates + authenticates + scrapes;
  `findDayEntries` specs unchanged and green.
- **Playwright latch:** after `onModuleDestroy`, `withPage` rejects instead of relaunching.
- **Ingest seam:** with `resolvedEntries` provided, `findDayEntries` is never called and the
  provided entries flow into the existing pipeline; `fromManifest` is true exactly on the
  committed short-circuit; the force-coalescing retry keeps `resolvedEntries`.
- **Backfill service** (fake ingest/eminiplayer/manifest, spied `sleep`/`now`): candidate
  derivation; sequential oldest-first; `fromManifest`-driven skipped-vs-uploaded counting;
  delay only after network days (not after manifest-skips, not after pre-ingest failures);
  frontier days resolved fresh (no `resolvedEntries`); per-day failure → ledger + continue;
  ledger `kind` classification incl. timeout → `stage`; cancel mid-day (in-flight day
  finishes) AND cancel-before-first-day (zero days start); 409 on concurrent start;
  range validation in `start()`; zero-classifiable-rows tripwire → `failed`; job-level scrape
  failure → `failed`; snapshots are copies.
- **Controller:** 400 validation (missing/invalid/reversed range), 202 shape, 409 mapping,
  401 token guard (set vs unset), GET 404-before-first-job, DELETE semantics, ET-today
  default.
- **Live smoke before the real run:** one recent week (5 trading days, one already
  committed) — verify counts `{uploaded: 4, skipped: 1}`, then deep audit the range.

## Rollout

1. Land + full suite green.
2. Live smoke week (above).
3. `POST /eminiplayer/backfill?from=01012018` — monitor via `GET`, tail logs.
4. On completion: `GET /eminiplayer/audit?from=01012018&deep=true`, review the ledger, decide
   whether the `validation`/`notFound` residue is worth pursuing (likely a handful of holiday
   and odd-title days).
