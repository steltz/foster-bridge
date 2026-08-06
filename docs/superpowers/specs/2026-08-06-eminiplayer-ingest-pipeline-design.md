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
3. **Transcription:** port the root package's ~50-line transcript logic (`src/transcript.js` + the ms→s normalization in `src/transcript-command.js`) into a backend `TranscriptService` using the same `youtube-transcript@1.3.1` dependency. Output must be byte-identical in format (`# Transcript` header, `**MM:SS** text` lines).
4. **Previous-day resolution:** from the archive listing itself — the most recent recap entry dated *strictly before* the requested TP date. No trading calendar.
5. **Idempotency:** fill-and-skip. Existing Storage objects are skipped; `force=true` regenerates everything. Each artifact uploads as soon as it's produced, so a mid-run failure preserves progress and a retry resumes.

## Architecture

Extends `backend/src/eminiplayer/`, plus one new shared module:

```
backend/src/transcript/
  transcript.module.ts           # TranscriptModule — exports TranscriptService
  transcript.service.ts          # YouTube → markdown (port of root src/transcript.js)
  transcript.service.spec.ts

backend/src/eminiplayer/
  eminiplayer.controller.ts      # POST /eminiplayer/ingest — validation + delegation
  eminiplayer-ingest.service.ts  # Orchestration: scrape → transcribe → upload
  eminiplayer.service.ts         # + findDayEntries / getYoutubeUrl / downloadTradePlanPdf
  eminiplayer.constants.ts       # + archive entry types, ingest result types
  *.spec.ts
```

- **`TranscriptService`** — one public method, `toMarkdown(youtubeUrlOrId): Promise<string>`. Fetches via `youtube-transcript`, divides `offset`/`duration` by 1000 (the library returns milliseconds), formats with the ported `transcriptToMarkdown`. Its own module because it is site-agnostic and reusable.
- **`EminiplayerService`** (extended) — three new scraper methods, each a `withPage()` callback that re-asserts its location rather than assuming where the page was left (per the module's existing concurrency contract):
  - `findDayEntries(date): Promise<{ tradePlan: ArchiveEntry; recap: ArchiveEntry }>` — scans the archive listing; `ArchiveEntry = { date: string; pageUrl: string; title: string }` with `date` normalized to `MMDDYYYY` regardless of how the site renders it. The recap is the most recent entry dated strictly before `date`.
  - `getYoutubeUrl(pageUrl): Promise<string>` — opens an archive detail page, extracts the embedded YouTube URL.
  - `downloadTradePlanPdf(pageUrl): Promise<Buffer>` — opens the TP detail page, downloads the PDF.
  - **Stub policy:** each method ships with its navigation/auth skeleton in place (goto inside `withPage`, login reuse) but throws `Error('eminiplayer: <method> selectors not implemented yet')` at the extraction point, marked `TODO(selectors)`. Zeroing in on live markup is follow-up work.
- **`EminiplayerIngestService`** — pure orchestration; injects `EminiplayerService`, `TranscriptService`, and the existing `STORAGE_BUCKET` provider. No Playwright, no HTTP types.
- **`EminiplayerController`** — validates `date` (`MMDDYYYY`, real calendar date), parses `force` (boolean, default false), maps orchestrator errors to HTTP statuses.

`EminiplayerModule` imports `TranscriptModule` and keeps `PlaywrightService` module-private; the controller is declared on `AppModule`'s `controllers` array, matching the repo convention (`MarketDataController`, `BenchmarkController`, …). `FirebaseModule` is `@Global()`, so `STORAGE_BUCKET` injects without an import.

## Ingest flow

`POST /eminiplayer/ingest?date=MMDDYYYY&force=false`

1. **Resolve** — `findDayEntries(date)`. The scrape happens once, up front; entry page URLs are reused across steps.
2. **Plan** — compute the three storage paths; `bucket.file(path).exists()` for each; anything present and not `force` is marked `skipped` without touching the site.
3. **Produce & upload** each missing artifact, in order, uploading immediately after producing:
   1. Recap markdown: `getYoutubeUrl(recap.pageUrl)` → `toMarkdown(url)` → upload (`contentType: text/markdown`).
   2. TP markdown: same via `tradePlan.pageUrl`.
   3. TP PDF: `downloadTradePlanPdf(tradePlan.pageUrl)` → upload (`contentType: application/pdf`).
4. **Respond:**

```json
{
  "date": "07012026",
  "recapDate": "06302026",
  "files": {
    "recap":       { "storagePath": "knowledge-base/es/07012026/06302026_ES_RECAP.md", "status": "uploaded" },
    "tradePlanMd": { "storagePath": "knowledge-base/es/07012026/07012026_ES_TP.md",   "status": "uploaded" },
    "tradePlanPdf":{ "storagePath": "knowledge-base/es/07012026/07012026_ES_TP.pdf",  "status": "skipped" }
  }
}
```

`status` is `"uploaded"` or `"skipped"`. When everything is skipped, step 1's scrape is still needed to learn the recap date — unless all three paths can be derived without it; they cannot (the recap filename embeds the recap date), so resolve always runs. This is acceptable: resolution is one listing-page scan.

## Error handling

| Condition | HTTP | Notes |
|---|---|---|
| Malformed/invalid `date` | 400 | Controller validation, before any scraping |
| Archive has no TP entry for `date` | 404 | Message names the date |
| Archive has no recap entry before `date` | 404 | First-ever-day edge case |
| Scrape / transcript-fetch / PDF-download / upload failure | 502 | Message names the failing stage and artifact; already-uploaded artifacts remain (resume via fill-and-skip) |
| Selectors not yet implemented (current stub state) | 502 | Same path as scrape failure — the endpoint is honest about being unwired |

The orchestrator throws typed errors (`IngestNotFoundError`, `IngestStageError`) that the controller maps; stage errors carry `{ stage, artifact }` context.

## Testing

Unit tests only, matching existing backend spec style (jest, collaborators mocked):

- **`TranscriptService`** — fixture segments → exact markdown output (assert byte-identical formatting vs a fixture copied from a real knowledge-base file's shape); ms→s normalization; fetch failure wrapped with context.
- **`EminiplayerIngestService`** — all three collaborators mocked:
  - happy path: three uploads, correct paths and contentTypes, response shape
  - fill-and-skip: existing objects skipped, missing ones produced
  - `force=true`: everything regenerated
  - partial failure: recap uploads, TP transcript throws → stage error surfaces, recap upload already happened (resume semantics)
  - not-found cases from `findDayEntries`
- **`EminiplayerController`** — date validation (format + calendar validity), force parsing, error→status mapping.
- **`EminiplayerService` new methods** — with mocked Playwright page: each runs inside `withPage`, performs its navigation skeleton, and throws the not-implemented error at the extraction point.
- No live-site or live-bucket tests.

## Out of scope

- Actual archive/detail-page selectors and PDF-link discovery (`TODO(selectors)` follow-up).
- Scheduling/cron, retries, backfill loops over date ranges.
- Syncing Storage back to the local `knowledge-base/` folder.
- Any parsing of the PDF or transcript content.
