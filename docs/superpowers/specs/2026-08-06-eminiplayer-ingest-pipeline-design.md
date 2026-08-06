# EminiPlayer Ingest Pipeline — Design

**Date:** 2026-08-06
**Status:** Approved
**Scope:** An HTTP-triggered pipeline that, for a given trading date, scrapes eminiplayer.net for the day's Trade Plan (TP) YouTube video + PDF and the previous day's Recap YouTube video, transcribes both videos to markdown, and uploads all three documents to Firebase Storage. Scraper selector/navigation details are explicitly deferred — this design defines their contracts and ships them as structured stubs.

## Goal

Reproduce the `knowledge-base/es/MMDDYYYY/` document-group shape in Firebase Storage, produced automatically from eminiplayer.net instead of by hand. A day group is three files:

| File | Content | Source |
|---|---|---|
| `<recapDate>_ES_RECAP.md` | Transcript markdown of the **previous** day's recap video | YouTube transcript |
| `<date>_ES_TP.md` | Transcript markdown of the day's trade-plan video | YouTube transcript |
| `<date>_ES_TP.pdf` | The day's trade-plan PDF | Direct download |

Dates are `MMDDYYYY`, matching the existing local folders. Storage paths mirror the local layout exactly — `knowledge-base/es/<date>/<file>` — so a future local-sync step is trivial.

## Decisions (locked during brainstorming)

1. **Trigger:** HTTP endpoint on the backend (`POST /eminiplayer/ingest`). No cron yet.
2. **Destination:** Firebase Storage only. No local `knowledge-base/` writes.
3. **Transcription:** port the root package's ~50-line transcript logic (`src/transcript.js` + the ms→s normalization in `src/transcript-command.js`) into a backend `TranscriptService` using the same `youtube-transcript@1.3.1` dependency. Output must be byte-identical in format (`# Transcript` header, `**MM:SS** text` lines). Known shared limitation: the ÷1000 normalization is correct for srv3 captions (the common case); the library's classic-XML fallback returns seconds, which would be compressed 1000× — identical behavior to the root CLI, kept for parity.
4. **Previous-day resolution:** from the archive listing itself — the most recent recap entry dated *strictly before* the requested TP date, bounded to a 14-calendar-day lookback (`RECAP_LOOKBACK_DAYS`); no recap in that window is a not-found. No trading calendar. **This resolution is time-sensitive:** run before the previous session's recap is posted, it resolves an older recap — see the stale-recap cleanup in Decision 5.
5. **Idempotency:** fill-and-skip. Existing Storage objects are skipped; `force=true` regenerates everything. Each artifact uploads as soon as it's produced, so a mid-run failure preserves progress and a retry resumes. Two corollaries: (a) **stale-recap cleanup** — because the recap filename embeds a freshly-resolved date, every run deletes any `*_ES_RECAP.md` in the day folder that isn't the currently-resolved path (reported as `staleRecapsRemoved`), so a day group can never accumulate two recaps; (b) **same-date coalescing** — concurrent ingest requests for one date share the in-flight run's promise (the realistic trigger is a client retry after timeout), since fill-and-skip only dedupes *completed* work. Single-node in-process coalescing suffices: the shared Playwright page already makes this a one-instance system.

## Architecture

Extends `backend/src/eminiplayer/`, plus one new shared module:

```
backend/src/transcript/
  transcript.module.ts           # TranscriptModule — exports TranscriptService
  transcript.service.ts          # YouTube → markdown (port of root src/transcript.js)
  transcript.service.spec.ts

backend/src/eminiplayer/
  eminiplayer.controller.ts      # POST /eminiplayer/ingest — validation + delegation
  eminiplayer-ingest.service.ts  # Orchestration: scrape → transcribe → upload (+ IngestResult types)
  eminiplayer-ingest.errors.ts   # IngestStageError (502)
  eminiplayer.service.ts         # + findDayEntries / getYoutubeUrl / downloadTradePlanPdf
  eminiplayer.constants.ts       # + ArchiveEntry/DayEntries types, ArchiveNotFoundError (404), RECAP_LOOKBACK_DAYS
  *.spec.ts
```

- **`TranscriptService`** — one public method, `toMarkdown(youtubeUrlOrId): Promise<string>`. Fetches via `youtube-transcript`, divides `offset`/`duration` by 1000 (the library returns milliseconds), formats with the ported `transcriptToMarkdown`. Its own module because it is site-agnostic and reusable.
- **`EminiplayerService`** (extended) — three new scraper methods, each a `withPage()` callback that re-asserts its location rather than assuming where the page was left (per the module's existing concurrency contract):
  - `findDayEntries(date): Promise<{ tradePlan: ArchiveEntry; recap: ArchiveEntry }>` — scans the archive listing; `ArchiveEntry = { date: string; pageUrl: string; title: string }` with `date` normalized to `MMDDYYYY` regardless of how the site renders it. The recap is the most recent entry dated strictly before `date`, within the `RECAP_LOOKBACK_DAYS` (14-day) window — the bound keeps a bad historical date from forcing a whole-archive walk inside one `withPage` callback. **Not-found is this method's contract:** it throws `ArchiveNotFoundError` (defined in `eminiplayer.constants.ts`, owned by the scraper layer — the only layer that can detect it) when the date has no TP entry or no recap in the window; the ingest layer passes it through untouched and the controller maps it to 404.
  - `getYoutubeUrl(pageUrl): Promise<string>` — opens an archive detail page, re-asserts the landed URL structurally (`assertOnPage`), extracts the embedded YouTube URL.
  - `downloadTradePlanPdf(pageUrl): Promise<Buffer>` — opens the TP detail page, re-asserts the landed URL, downloads the PDF.
  - **Stub policy:** each method ships with its navigation/auth skeleton in place (goto inside `withPage`, login reuse) but throws `Error('eminiplayer: <method> selectors not implemented yet')` at the extraction point, marked `TODO(selectors)`. Zeroing in on live markup is follow-up work.
- **`EminiplayerIngestService`** — pure orchestration; injects `EminiplayerService`, `TranscriptService`, and the existing `STORAGE_BUCKET` provider. No Playwright, no HTTP types.
- **`EminiplayerController`** — validates `date` (`MMDDYYYY`, real calendar date), parses `force` (boolean, default false), maps orchestrator errors to HTTP statuses.

`EminiplayerModule` imports `TranscriptModule` and keeps `PlaywrightService` module-private; the controller is declared on `AppModule`'s `controllers` array, matching the repo convention (`MarketDataController`, `BenchmarkController`, …). `FirebaseModule` is `@Global()`, so `STORAGE_BUCKET` injects without an import.

## Ingest flow

`POST /eminiplayer/ingest?date=MMDDYYYY&force=false`

0. **Coalesce** — if an ingest for this date is already in flight, return its promise (Decision 5b).
1. **Resolve** — `findDayEntries(date)`. The scrape happens once, up front; entry page URLs are reused across steps.
2. **Plan** — compute the three storage paths; delete stale `*_ES_RECAP.md` objects in the day folder (Decision 5a); `bucket.file(path).exists()` for each path; anything present and not `force` is marked `skipped` without touching the site.
3. **Produce & upload** each missing artifact, in order, uploading immediately after producing:
   1. Recap markdown: `getYoutubeUrl(recap.pageUrl)` → `toMarkdown(url)` → upload (`contentType: text/markdown`).
   2. TP markdown: same via `tradePlan.pageUrl`.
   3. TP PDF: `downloadTradePlanPdf(tradePlan.pageUrl)` → upload (`contentType: application/pdf`).
4. **Respond:**

```json
{
  "date": "07012026",
  "recapDate": "06302026",
  "staleRecapsRemoved": [],
  "files": {
    "recap":       { "storagePath": "knowledge-base/es/07012026/06302026_ES_RECAP.md", "status": "uploaded" },
    "tradePlanMd": { "storagePath": "knowledge-base/es/07012026/07012026_ES_TP.md",   "status": "uploaded" },
    "tradePlanPdf":{ "storagePath": "knowledge-base/es/07012026/07012026_ES_TP.pdf",  "status": "skipped" }
  }
}
```

`status` is `"uploaded"` or `"skipped"`. When everything is skipped, step 1's scrape is still needed to learn the recap date — unless all three paths can be derived without it; they cannot (the recap filename embeds the recap date), so resolve always runs. This is acceptable: resolution is one listing-page scan.

**Duration:** a full run drives a real browser (navigation + possible login), two transcript fetches, a PDF download, and three uploads — expect tens of seconds to minutes, serialized behind any other in-flight page work. The endpoint is synchronous by design (operator tool, low concurrency); clients should set generous timeouts, and a timed-out retry coalesces onto the still-running ingest rather than restacking it.

**Completeness contract:** a day group is complete exactly when all three files exist at their computed paths. Upload-as-you-go means partial folders are a normal transient state after a failed run; consumers (e.g. the future local-sync step) must treat "fewer than three files" as incomplete, and the stale-recap cleanup guarantees there is never more than one `*_ES_RECAP.md` to count.

## Error handling

| Condition | HTTP | Notes |
|---|---|---|
| Malformed/invalid `date` | 400 | Controller validation, before any scraping |
| Archive has no TP entry for `date` | 404 | `ArchiveNotFoundError` thrown by `findDayEntries` (scraper layer); message names the date |
| Archive has no recap entry within the lookback window before `date` | 404 | Same error; covers the first-ever-day and recap-not-posted-yet cases |
| Storage pre-check / scrape / transcript-fetch / PDF-download / upload failure | 502 | `IngestStageError` names the failing stage (`plan`/`resolve`/`transcribe`/`download`/`upload`) and artifact; already-uploaded artifacts remain (resume via fill-and-skip) |
| Selectors not yet implemented (current stub state) | 502 | Same path as scrape failure — the endpoint is honest about being unwired |

Error ownership: `ArchiveNotFoundError` lives in `eminiplayer.constants.ts` and is thrown by the scraper — the only layer that can detect not-found; the orchestrator passes it through untouched and wraps everything else into `IngestStageError` (`eminiplayer-ingest.errors.ts`) with `{ stage, artifact }` context. The controller maps the former to 404 and the latter to 502.

**Trust boundary:** the endpoint is unauthenticated and each call can drive a credentialed login to eminiplayer.net, so it is an operator-only tool — the backend is assumed to bind to localhost or a trusted network, same as every other endpoint in this app. If the backend is ever exposed beyond that, this controller needs a guard (shared-secret header at minimum) before anything else does: unlike the read-only demo endpoints, abuse here loops logins against a third-party membership account.

## Testing

Unit tests only, matching existing backend spec style (jest, collaborators mocked):

- **`TranscriptService`** — fixture segments → exact markdown output (assert byte-identical formatting vs a fixture copied from a real knowledge-base file's shape); ms→s normalization; fetch failure wrapped with context.
- **`EminiplayerIngestService`** — all three collaborators mocked:
  - happy path: three uploads, correct paths and contentTypes, response shape
  - fill-and-skip: existing objects skipped, missing ones produced
  - `force=true`: everything regenerated
  - partial failure: recap uploads, TP transcript throws → stage error surfaces, recap upload already happened (resume semantics)
  - `ArchiveNotFoundError` from `findDayEntries` passes through unwrapped
  - stale-recap cleanup: mismatched `*_ES_RECAP.md` deleted and reported; the currently-resolved recap is never treated as stale
  - same-date coalescing: concurrent calls share one run; a later call runs fresh
- **`EminiplayerController`** — date validation (format + calendar validity), force parsing, error→status mapping.
- **`EminiplayerService` new methods** — with mocked Playwright page: each runs inside `withPage`, performs its navigation skeleton (including the landed-URL re-assert; a redirected detail page throws a navigation error), and throws the not-implemented error at the extraction point.
- No live-site or live-bucket tests.

## Out of scope

- Actual archive/detail-page selectors and PDF-link discovery (`TODO(selectors)` follow-up).
- Scheduling/cron, retries, backfill loops over date ranges.
- Syncing Storage back to the local `knowledge-base/` folder.
- Any parsing of the PDF or transcript content.
