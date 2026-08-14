# EminiPlayer Bulk Backfill — Design

**Date:** 2026-08-14
**Status:** Approved (this document is the written form of the design approved in chat)
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
of scope; days from those eras that fail simply land in the failure ledger.

## Decisions (with rationale)

1. **In-memory singleton job; re-POST to resume.** The per-day manifests are already the
   durable state: a committed day short-circuits to all-`skipped` in ~0.2 s with zero site
   traffic (proven live on 08132026). A Firestore-backed job record would duplicate that for
   a job run a handful of times. Cost of a process death mid-run is one re-POST plus one
   listing re-scrape.
2. **Single-scrape resolve (option B).** `ingest(date)` today re-downloads the entire 1.7 MB
   archive listing per day. The bulk job scrapes the listing once and derives every day's
   `DayEntries` from that one capture via the already-pure `selectDayEntries`. Per day this
   drops the footprint to 2 detail-page loads + 1 PDF, saving ~2,150 listing loads (~3.6 GB)
   and roughly a third of the wall clock. Staleness is not a concern: the listing is
   append-only for past days, and every downstream gate (title dates, three-way agreement,
   oEmbed title, LLM verify) still runs per day.
3. **Continue-on-error with a per-day failure ledger.** One bad day must never stop a
   multi-hour run. Failures are recorded and classified; the job finishes the range.
4. **No `force` on bulk.** Re-ingesting a day is the single-day endpoint's job
   (`?force=true`). A bulk force over years is an expensive foot-gun with no current use.
5. **One job at a time.** All scraping serializes through the one Playwright tab anyway;
   overlapping bulk jobs would interleave pointlessly. Second POST while running → 409.

## API

```
POST   /eminiplayer/backfill?from=MMDDYYYY&to=MMDDYYYY
GET    /eminiplayer/backfill
DELETE /eminiplayer/backfill
```

- `from` **required**; `to` optional, defaults to today. Both must be real calendar dates
  (same `isValidMmddyyyy` rule as `/ingest`); `from ≤ to` else 400.
- `POST` returns **202** immediately with the initial job snapshot; the work runs detached
  inside the service. A job already `running` → **409** with the running job's snapshot in
  the error body. Starting a new job replaces the retained snapshot of a finished one.
- `GET` returns the current (or most recently finished) job snapshot; **404** only when no
  job has run since boot.
- `DELETE` requests cancellation: the in-flight day finishes (a day is atomic — its manifest
  either commits or doesn't), no further days start, terminal state `cancelled`. **404** only
  when no job has run since boot (same rule as `GET`); against an already-finished job it is
  a no-op **200** answered with the retained snapshot.

### Job snapshot

```jsonc
{
  "state": "running",            // running | done | cancelled | failed
  "from": "01012018",
  "to": "08142026",
  "startedAt": "2026-08-14T13:00:00.000Z",
  "finishedAt": null,            // set on any terminal state
  "currentDate": "03052019",     // day in flight, null when not running
  "counts": {
    "candidates": 2150,          // TP dates found in range (null until listing scraped)
    "processed": 312,            // days attempted so far
    "uploaded": 300,             // days where at least one artifact was produced
    "skipped": 9,                // committed days served entirely from their manifest
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

Failure `kind` classification mirrors the single-day HTTP mapping:

| kind         | source error              | meaning                                   | re-POST behavior |
| ------------ | ------------------------- | ----------------------------------------- | ---------------- |
| `notFound`   | `ArchiveNotFoundError`    | day can't satisfy the TP+recap contract   | retried (same result until the archive changes) |
| `validation` | `IngestValidationError`   | permanent data condition — human review   | retried |
| `stage`      | `IngestStageError`        | transient infrastructure/scrape failure   | retried, likely succeeds |
| `unknown`    | anything else             | bug — investigate                         | retried |

`state: "failed"` is reserved for job-level failures that prevent processing any days at all
(listing scrape failed, login failed). Per-day errors never fail the job.

## Components

### `EminiplayerBackfillService` (new)

Owns the singleton job. `start(from, to)` validates, rejects if running, snapshots the job as
`running`, and kicks the detached loop:

1. **Resolve once:** `eminiplayer.fetchArchiveRows()` → `listTradePlanDates(rows, from, to)`
   → `counts.candidates`. Order **oldest → newest**.
2. **Per day:** if cancelled → break. Derive `DayEntries` with
   `selectDayEntries(rows, date, ARCHIVE_URL)` (throws → ledger, continue). Call
   `ingestService.ingest(date, false, entries)`. Classify the outcome:
   all files `skipped` → `skipped++`; else `uploaded++`; thrown → ledger + `failed++`,
   continue.
3. **Pacing:** sleep `eminiplayer.backfillDelayMs` (config, `EMINIPLAYER_BACKFILL_DELAY_MS`,
   default 2000) after each day **that touched the network** — manifest-skipped days skip the
   delay so a resume sprints through the committed prefix.
4. Terminal state `done` (or `cancelled`); `finishedAt` set; snapshot retained for `GET`.

The loop's promise is held by the service but never awaited by a request handler; every
per-day exception is caught inside the loop. A crash of the loop itself (outside per-day
handling) sets `state: "failed"` with the error message rather than leaving a zombie
`running` snapshot.

### `EminiplayerService.fetchArchiveRows()` (refactor)

The navigate + authenticate + `$$eval(SELECTORS.archiveRows, …)` half of today's
`findDayEntries`, extracted; `findDayEntries(date)` becomes
`fetchArchiveRows()` + `selectDayEntries(rows, date, ARCHIVE_URL)`. Public behavior of
`findDayEntries` is unchanged; its existing spec stays green.

### `listTradePlanDates(rows, from, to)` (new pure function, `eminiplayer-archive.ts`)

Classified trade-plan rows (`classifyArchiveTitle` → `kind: 'tradePlan'`) whose **row date**
falls in `[from, to]`, deduped, sorted ascending, returned as `MMDDYYYY[]`. Rows that fail
classification or have malformed date cells are skipped exactly as `selectDayEntries` skips
them. No agreement checks here — those run per-day in `selectDayEntries` when the day is
actually processed.

### `EminiplayerIngestService.ingest(date, force, resolvedEntries?)` (seam)

When `resolvedEntries` is provided, the resolve stage uses it instead of calling
`eminiplayer.findDayEntries(date)`. Every downstream step — `assertDayInvariants`, the
consumer-side `tradePlan.date === date` backstop, the committed-day short-circuit **including
its recapDate-drift refusal**, stale-recap sweep, transcribe, title gate, LLM verify, upload,
manifest commit — is byte-for-byte the existing flow. The in-flight per-date coalescing map
keeps working, so a manual `POST /ingest?date=` for a day the bulk job is currently running
coalesces onto the same run instead of colliding.

### Controller (`eminiplayer.controller.ts`)

Three thin routes mapping to the service; validation errors → 400, already-running → 409
(`ConflictException`), no-job → 404. `POST` is `@HttpCode(202)`.

## Load, cost, duration (2018 → today)

| resource | per day | ~2,150 days |
| --- | --- | --- |
| eminiplayer.net page loads | 2 detail + 1 PDF | ~6,450 (+1 listing) |
| YouTube | 2 oEmbed + 2 transcript fetches | ~8,600 |
| kimi-k2.6 verify | 2 calls ≈ $0.0008 | ≈ $1.75 |
| wall clock | ~30 s + 2 s delay | **~19 h** |

All site traffic rides the single serialized Playwright tab. `PlaywrightService` already
replaces a crashed browser on next use; a process death costs one re-POST.

## Edge cases

- **Recap-missing day** (holiday-adjacent, charts-only): `selectDayEntries` throws
  `ArchiveNotFoundError` → ledger `notFound`, continue.
- **Committed day whose archive recap has drifted:** the seam preserves the existing
  `IngestValidationError` refusal → ledger `validation`. Deliberate: frozen-wrong data needs
  a human `force`, not silent bulk regeneration.
- **Backend restarted mid-job:** `GET` → 404 (memory gone). Re-POST the same range; committed
  days short-circuit at ~0.2 s each with no delay, so catching up to the frontier is minutes,
  not hours.
- **YouTube throttling deep into the run:** shows up as `stage` failures; the delay is the
  first knob (`EMINIPLAYER_BACKFILL_DELAY_MS`), a re-POST later retries exactly the failed
  days.
- **Single-day `POST /ingest` during a bulk run:** allowed; same-date calls coalesce; other
  dates interleave through the Playwright queue.

## Non-goals

- No durable job record, no auto-resume on boot (decision 1).
- No bulk `force` (decision 4).
- No parallel day processing — the Playwright tab and site politeness both argue for
  sequential.
- No pre-2018 era support work: no new title forms, no TP-only day contract for the
  recap-less 2010–2011 era. Whatever old-era days a wider range hits are ledger entries, not
  requirements.
- No webhook/notification on completion; `GET` is the interface.

## Testing

- **Pure:** `listTradePlanDates` — range bounds inclusive, dedupe, ascending order, skips
  unclassifiable/malformed rows (fixtures from the captured listing).
- **Service refactor:** `fetchArchiveRows` navigates + authenticates + scrapes;
  `findDayEntries` specs unchanged and green.
- **Ingest seam:** with `resolvedEntries` provided, `findDayEntries` is never called and the
  provided entries flow into the existing pipeline; without it, behavior identical to today.
- **Backfill service** (fake ingest/eminiplayer/manifest, fake timers): candidate derivation;
  sequential processing oldest-first; skipped vs uploaded counting; per-day failure →
  ledger + continue; ledger `kind` classification; cancel between days (in-flight day
  finishes); 409 on concurrent start; delay only after network days; job-level scrape failure
  → `state: "failed"`.
- **Controller:** 400 validation (missing/invalid/reversed range), 202 shape, 409 mapping,
  GET 404-before-first-job, DELETE semantics.
- **Live smoke before the real run:** one recent week (5 trading days, one already
  committed) — verify counts `{uploaded: 4, skipped: 1}`, then deep audit the range.

## Rollout

1. Land + full suite green.
2. Live smoke week (above).
3. `POST /eminiplayer/backfill?from=01012018` — monitor via `GET`, tail logs.
4. On completion: `GET /eminiplayer/audit?from=01012018&deep=true`, review the ledger, decide
   whether the `validation`/`notFound` residue is worth pursuing (likely a handful of holiday
   and odd-title days).
