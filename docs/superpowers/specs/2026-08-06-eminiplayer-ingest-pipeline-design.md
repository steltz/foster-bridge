# EminiPlayer Ingest Pipeline — Design

**Date:** 2026-08-06
**Status:** Approved
**Scope:** An HTTP-triggered pipeline that, for a given trading date, scrapes eminiplayer.net for the day's Trade Plan (TP) YouTube video + PDF and the previous day's Recap YouTube video, transcribes both videos to markdown, and uploads all three documents to Firebase Storage — plus a **defense-in-depth verification system** (deterministic gates, redundant date cross-checks, LLM content verification, manifest-committed day groups, global audit) sized for multi-year unattended volume where bad data poisons strategy backtests and no human spot-checks each day. Scraper selector/navigation details are explicitly deferred — this design defines their contracts and ships them as structured stubs.

## Goal

Reproduce the `knowledge-base/es/MMDDYYYY/` document-group shape in Firebase Storage, produced automatically from eminiplayer.net instead of by hand. A day group is three files:

| File | Content | Source |
|---|---|---|
| `<recapDate>_ES_RECAP.md` | Transcript markdown of the **previous** day's recap video | YouTube transcript |
| `<date>_ES_TP.md` | Transcript markdown of the day's trade-plan video | YouTube transcript |
| `<date>_ES_TP.pdf` | The day's trade-plan PDF | Direct download |
| `manifest.json` | Commit record: sources, video ids, per-file sha256/md5/size, verification evidence (video titles + LLM verdicts), pipeline version | Written last, only after every check passes |

Dates are `MMDDYYYY`, matching the existing local folders. Storage paths mirror the local layout exactly — `knowledge-base/es/<date>/<file>` — so a future local-sync step is trivial. **The manifest is the trust gate: a day group without `manifest.json` does not exist to consumers**, no matter how many artifact files are present.

## Decisions (locked during brainstorming)

1. **Trigger:** HTTP endpoint on the backend (`POST /eminiplayer/ingest`). No cron yet.
2. **Destination:** Firebase Storage only. No local `knowledge-base/` writes.
3. **Transcription:** port the root package's ~50-line transcript logic (`src/transcript.js` + the ms→s normalization in `src/transcript-command.js`) into a backend `TranscriptService` using the same `youtube-transcript@1.3.1` dependency. Output must be byte-identical in format (`# Transcript` header, `**MM:SS** text` lines). Known shared limitation: the ÷1000 normalization is correct for srv3 captions (the common case); the library's classic-XML fallback returns seconds, which would be compressed 1000× — identical behavior to the root CLI, kept for parity.
4. **Previous-day resolution:** from the archive listing itself — the most recent recap entry dated *strictly before* the requested TP date, bounded to a 14-calendar-day lookback (`RECAP_LOOKBACK_DAYS`); no recap in that window is a not-found. No trading calendar. **This resolution is time-sensitive:** run before the previous session's recap is posted, it resolves an older recap. Two mechanisms heal the drift: for *uncommitted* days, the stale-recap cleanup in Decision 5a; for *committed* days, the manifest short-circuit compares the fresh resolution against the manifest's recapDate and 422s on mismatch (see Ingest flow) instead of freezing the wrong recap forever.
5. **Idempotency:** fill-and-skip. Existing Storage objects are skipped; `force=true` regenerates everything — uncommitting the day first, where **uncommit is symmetric with commit**: the day's Firestore video-id claims are released (claims whose `date` matches) before the manifest is deleted, so a force-rerun that resolves different videos can never leave stale claims that 422-block a neighboring day's backfill. Each artifact uploads as soon as it's produced, so a mid-run failure preserves progress and a retry resumes. **Skip means skip *production* (scraping the transcript / downloading the pdf), never skip *verification*** — a resumed run reloads skipped artifacts from the bucket and runs every gate and check on them before committing, because the previous run may have died between upload and verification. Two corollaries: (a) **stale-recap cleanup** — because the recap filename embeds a freshly-resolved date, every run deletes any `*_ES_RECAP.md` in the day folder that isn't the currently-resolved path (reported as `staleRecapsRemoved`), so a day group can never accumulate two recaps; (b) **same-date coalescing** — concurrent ingest requests for one date share the in-flight run's promise (the realistic trigger is a client retry after timeout), since fill-and-skip only dedupes *completed* work. **`force` is never silently dropped:** a `force=true` call that finds a non-force run in flight waits for it to settle, then runs the forced regeneration itself; only same-flag calls (or a non-force call finding any in-flight run) coalesce. Single-node in-process coalescing suffices: the shared Playwright page already makes this a one-instance system.
6. **Verification (all four layers approved 2026-08-06):** the pipeline is built for multi-year unattended volume feeding real-money strategy decisions, so every day group is self-validating at write time and auditable after the fact:
   - **A. Deterministic artifact gates** — transcript markdown must have ≥ minimum timestamped lines and characters, strictly non-decreasing timestamps, and a final timestamp in a plausible range (catches the known ms-vs-seconds caption bug from Decision 3 as hard rejection instead of silent corruption); PDFs must have `%PDF-` magic bytes, an `%%EOF` trailer, a minimum size, and at least one page marker. Gate failure = artifact rejected, run fails with the reason.
   - **B. Redundant date cross-checks** — the archive row date, the entry title's printed date, and the entry title's printed weekday must all agree (`findDayEntries` contract); the YouTube video's own title (via the keyless oEmbed endpoint) must contain the expected date and the right flavor (recap vs trade plan); structural invariants: `recapDate < date`, gap ≤ `RECAP_LOOKBACK_DAYS`, both weekdays. **Caveat:** the accepted title-date forms are an assumption not yet validated against real channel titles — the selector follow-up must capture 3–5 real oEmbed titles and encode the observed forms before trusting this gate at volume (a format mismatch 422s every day; the gate distinguishes "no recognizable date — format assumption may be wrong" from "contradictory date" so the two are diagnosable apart).
   - **C. LLM content verification** — a structured-output classification call per transcript through the existing `LLM_PROVIDER` seam: `{docType, isEsContent, referencedWeekday, confidence}`; any mismatch with the expected slot fails verification. **Blocking:** no manifest until it passes — an LLM outage merely delays commitment and a retry resumes. Model via `EMINIPLAYER_VERIFY_MODEL` (unset = provider default).
   - **D. Manifest-committed day groups + audit** — `manifest.json` written only after all checks pass, recording sources, per-file `sha256`/`md5`/size, and **verification evidence** (both oEmbed video titles and both LLM verdicts — not bare booleans, so a questioned day can be re-examined without re-scraping); a Firestore collection (`eminiplayer-video-ids/{videoId} → {date, slot}`) claims each YouTube video id transactionally at commit so the same video can never serve two day groups; `GET /eminiplayer/audit?from=&to=&deep=` re-verifies manifested days in the requested date range — shallow mode (default) compares stored-object `md5`/size via GCS object *metadata* (no content downloads) plus invariants, cross-day uniqueness, claim↔manifest agreement in **both** directions, and unmanifested folders; `deep=true` additionally downloads content, re-computes `sha256`, and re-runs the structural gates. Range + shallow-by-default keep the audit usable at multi-year scale where full serial downloads in one HTTP request would time out.

## Architecture

Extends `backend/src/eminiplayer/`, plus one new shared module:

```
backend/src/transcript/
  transcript.module.ts           # TranscriptModule — exports TranscriptService
  transcript.service.ts          # YouTube segments + oEmbed title fetch + pure markdown formatting (port of root src/transcript.js)
  transcript.service.spec.ts

backend/src/eminiplayer/
  eminiplayer.controller.ts        # POST /eminiplayer/ingest + GET /eminiplayer/audit — validation + delegation
  eminiplayer-ingest.service.ts    # Orchestration: scrape → gate → transcribe → verify → upload → commit (+ IngestResult types)
  eminiplayer-ingest.errors.ts     # IngestStageError (502), IngestValidationError (422)
  eminiplayer-validation.ts        # Pure gates & cross-checks: transcript/pdf gates, date invariants, video-id extraction, title checks, sha256
  eminiplayer-verify.service.ts    # LLM content verification via the LLM_PROVIDER seam
  eminiplayer-manifest.service.ts  # Manifest build/write + Firestore video-id uniqueness claims
  eminiplayer-audit.service.ts     # GET /eminiplayer/audit — re-verify all manifested days
  eminiplayer.service.ts           # + findDayEntries / getYoutubeUrl / downloadTradePlanPdf
  eminiplayer.constants.ts         # + ArchiveEntry/DayEntries types, ArchiveNotFoundError (404), RECAP_LOOKBACK_DAYS, INGEST_PIPELINE_VERSION
  *.spec.ts
```

- **`TranscriptService`** — site-agnostic YouTube access, two public methods: `fetchSegments(urlOrId): Promise<TranscriptSegment[]>` (fetches via `youtube-transcript`, divides `offset` by 1000 — see Decision 3's caveat) and `fetchVideoTitle(videoId): Promise<string>` (YouTube's public oEmbed endpoint, no API key, via global `fetch`; an HTTP 4xx throws the exported `VideoUnavailableError` — a permanent condition callers must not treat as retryable, distinct from network/5xx transport errors). The ported pure functions (`decodeEntities`, `formatOffset`, `transcriptToMarkdown`) are exported for the orchestrator to compose — segments stay available for gating before formatting. Its own module because it is site-agnostic and reusable.
- **`EminiplayerService`** (extended) — three new scraper methods, each a `withPage()` callback that re-asserts its location rather than assuming where the page was left (per the module's existing concurrency contract):
  - `findDayEntries(date): Promise<{ tradePlan: ArchiveEntry; recap: ArchiveEntry }>` — scans the archive listing; `ArchiveEntry = { date: string; pageUrl: string; title: string }` with `date` normalized to `MMDDYYYY` regardless of how the site renders it. The recap is the most recent entry dated strictly before `date`, within the `RECAP_LOOKBACK_DAYS` (14-day) window — the bound keeps a bad historical date from forcing a whole-archive walk inside one `withPage` callback. **Three-way date agreement is this method's contract:** an entry is only returned if the listing row's date, the date printed in the entry title (e.g. "…for Tuesday 04/10/2018"), and the title's printed weekday (checked against what that calendar date actually falls on) all agree — an off-by-one-row parser fails loudly here instead of filing a document under the wrong day. **Not-found is also this method's contract:** it throws `ArchiveNotFoundError` (defined in `eminiplayer.constants.ts`, owned by the scraper layer — the only layer that can detect it) when the date has no TP entry or no recap in the window; the ingest layer passes it through untouched and the controller maps it to 404.
  - `getYoutubeUrl(pageUrl): Promise<string>` — opens an archive detail page, re-asserts the landed URL structurally (`assertOnPage`), extracts the embedded YouTube URL.
  - `downloadTradePlanPdf(pageUrl): Promise<Buffer>` — opens the TP detail page, re-asserts the landed URL, downloads the PDF.
  - **Stub policy:** each method ships with its navigation/auth skeleton in place (goto inside `withPage`, login reuse) but throws `Error('eminiplayer: <method> selectors not implemented yet')` at the extraction point, marked `TODO(selectors)`. Zeroing in on live markup is follow-up work.
- **`eminiplayer-validation.ts`** — pure, dependency-free check functions (no classes, no DI): `assertTranscriptMarkdown` (parses the `**MM:SS**` lines back out of markdown so the same gate covers both freshly-generated and bucket-reloaded transcripts), `assertPdfBuffer`, `assertDayInvariants`, `assertVideoTitle`, `extractYoutubeVideoId`, `parseMmddyyyy`, `sha256Hex`, `md5Base64` (GCS metadata-comparable), and the **single home of the storage layout**: `dayPaths(date, recapDate)` + `manifestPath(date)` + `ES_STORAGE_PREFIX`, consumed by orchestrator, manifest service, and audit so the layout can never drift between writer and auditor. All assertions throw `IngestValidationError` with a named reason. Thresholds are exported constants.
- **`EminiplayerVerifyService`** — injects `LLM_PROVIDER` (`LlmProvider.messageStructured` with a JSON schema, attribution `{ operation: 'other' }`); one method `verifyTranscript(markdown, { flavor, date }): Promise<TranscriptVerdict>` — returns the verdict (recorded as manifest evidence) when it passes. Verdict mismatch throws `IngestValidationError`; transport failure throws a plain `Error` for the orchestrator to wrap as a `'verify'` stage error.
- **`EminiplayerManifestService`** — `read(date)` (parsed manifest or null), `exists(date)`, `commit(manifest)` (claims video ids in the `eminiplayer-video-ids` Firestore collection via transaction — idempotent re-claim for the same `{date, slot}`, conflict throws `IngestValidationError` — then writes `manifest.json` last), and `delete(date)` which **releases the day's claims before removing the manifest** (symmetric uncommit; see Decision 5).
- **`EminiplayerIngestService`** — pure orchestration; injects `EminiplayerService`, `TranscriptService`, `EminiplayerVerifyService`, `EminiplayerManifestService`, and the existing `STORAGE_BUCKET` provider. No Playwright, no HTTP types.
- **`EminiplayerAuditService`** — read-only re-verification of manifested days, range-scoped (`from`/`to`) and shallow by default: manifest download + invariants, per-file `md5`/size comparison via GCS object **metadata** (no content downloads), cross-day video-id uniqueness, claim↔manifest agreement in both directions, unmanifested folders. `deep=true` additionally downloads content, re-computes `sha256`, and re-runs structural gates. Per-file transport failures are attributed to the file (`<artifact> unreadable`), never misreported as a manifest problem. Returns `{ daysChecked, ok, anomalies: [{date, problem}], uncommittedDays }`.
- **`EminiplayerController`** — `POST /eminiplayer/ingest`: validates `date` (`MMDDYYYY`, real calendar date), parses `force` (boolean, default false), maps errors (`ArchiveNotFoundError`→404, `IngestValidationError`→422, `IngestStageError`→502). `GET /eminiplayer/audit?from=MMDDYYYY&to=MMDDYYYY&deep=true|false`: validates optional range params, delegates to the audit service.

`EminiplayerModule` imports `TranscriptModule` and keeps `PlaywrightService` module-private; the controller is declared on `AppModule`'s `controllers` array, matching the repo convention (`MarketDataController`, `BenchmarkController`, …). `FirebaseModule` is `@Global()`, so `STORAGE_BUCKET` injects without an import.

## Ingest flow

`POST /eminiplayer/ingest?date=MMDDYYYY&force=false`

0. **Coalesce** — if an ingest for this date is already in flight, return its promise (Decision 5b).
1. **Resolve** — `findDayEntries(date)` (three-way date agreement inside; see scraper contract). Then `assertDayInvariants(date, recapDate)`. The scrape happens once, up front; entry page URLs are reused across steps.
2. **Plan** — compute the three storage paths; on `force`, delete the day's manifest first (uncommit); delete stale `*_ES_RECAP.md` objects in the day folder (Decision 5a).
3. **Produce or reload, gate, verify, upload** — per transcript artifact (recap with `recapDate`, TP with `date`):
   1. `getYoutubeUrl(pageUrl)` → `extractYoutubeVideoId` → `fetchVideoTitle(videoId)` → `assertVideoTitle(title, expectedDate, flavor)`. A YouTube-side 4xx on the title fetch (video deleted/private/unembeddable) is a **permanent data condition → 422**, not a retryable 502.
   2. If the object exists and not `force`: download it, `assertTranscriptMarkdown` (`status: skipped` — production skipped, verification never skipped). Otherwise `fetchSegments` → `transcriptToMarkdown` → **`assertTranscriptMarkdown` → upload** (`contentType: text/markdown`, `status: uploaded`). **Gates run before upload** — a gate-tripping artifact is never written; "artifacts stay in place for diagnosis" (error table) applies to post-upload failures (LLM verdict, uniqueness) and to reloaded artifacts.
   3. `verifyTranscript(markdown, { flavor, date: expectedDate })` (LLM, blocking) — returns the verdict, which is recorded as manifest evidence.
   4. Record `{videoId, title, verdict, sha256, md5, bytes}` for the manifest.
   For the PDF: produce-or-reload via `downloadTradePlanPdf`, `assertPdfBuffer` **before** upload (`contentType: application/pdf`), record hashes/bytes.
4. **Commit** — build the manifest (sources, video ids, hashes, check booleans, `INGEST_PIPELINE_VERSION`, timestamps); claim both video ids in Firestore (conflict = validation failure); write `manifest.json`. Only now is the day visible to consumers.
5. **Respond:**

```json
{
  "date": "07012026",
  "recapDate": "06302026",
  "staleRecapsRemoved": [],
  "manifestPath": "knowledge-base/es/07012026/manifest.json",
  "files": {
    "recap":       { "storagePath": "knowledge-base/es/07012026/06302026_ES_RECAP.md", "status": "uploaded" },
    "tradePlanMd": { "storagePath": "knowledge-base/es/07012026/07012026_ES_TP.md",   "status": "uploaded" },
    "tradePlanPdf":{ "storagePath": "knowledge-base/es/07012026/07012026_ES_TP.pdf",  "status": "skipped" }
  }
}
```

`status` is `"uploaded"` or `"skipped"`. Resolve always runs even when every artifact exists (the recap filename embeds the recap date, which only the archive listing knows), and verification always runs even on fully-skipped days whose manifest is missing — a run that ends without writing a manifest left an unverified day, and only re-verification can commit it.

**Manifest short-circuit (committed day, `force=false`):** the run downloads the manifest and short-circuits after resolve — but the response is built from the **manifest's** recorded recapDate and paths (never the fresh resolve, so "skipped" can never name a nonexistent object), and if the freshly-resolved recapDate differs from the manifest's, the run throws `IngestValidationError` ("committed recap is stale — rerun with force") instead of reporting success. This closes the trap where a day committed early with an older recap (before the real one was posted — every check passes honestly against the older date) would otherwise be frozen wrong forever while re-runs report all-skipped.

**Duration:** a full run drives a real browser (navigation + possible login), two transcript fetches, a PDF download, and three uploads — expect tens of seconds to minutes, serialized behind any other in-flight page work. The endpoint is synchronous by design (operator tool, low concurrency); clients should set generous timeouts, and a timed-out retry coalesces onto the still-running ingest rather than restacking it.

**Completeness contract:** a day group is complete exactly when `manifest.json` exists — the manifest is only written after every artifact is present, gated, cross-checked, and LLM-verified, so manifest presence subsumes any file-counting heuristic. Upload-as-you-go means partial, unmanifested folders are a normal transient state after a failed run; consumers (e.g. the future local-sync step) must read only manifested days. The stale-recap cleanup guarantees a committed day never contains a second `*_ES_RECAP.md`.

## Error handling

| Condition | HTTP | Notes |
|---|---|---|
| Malformed/invalid `date` | 400 | Controller validation, before any scraping |
| Archive has no TP entry for `date` | 404 | `ArchiveNotFoundError` thrown by `findDayEntries` (scraper layer); message names the date |
| Archive has no recap entry within the lookback window before `date` | 404 | Same error; covers the first-ever-day and recap-not-posted-yet cases |
| Any verification failure — gate, date cross-check, invariant, unavailable video, LLM verdict mismatch, video-id uniqueness conflict, committed-recap staleness | 422 | `IngestValidationError` with the named reason. **We got data and refuse to trust it** — no manifest is written and the day stays invisible to consumers. Gate failures reject *before* upload (nothing is written); artifacts already uploaded by the run or a predecessor stay in place for diagnosis |
| Storage pre-check / scrape / transcript-fetch / PDF-download / oEmbed or LLM transport failure / upload / commit failure | 502 | `IngestStageError` names the failing stage (`plan`/`resolve`/`transcribe`/`download`/`verify`/`upload`/`commit`) and artifact; already-uploaded artifacts remain (resume via fill-and-skip) |
| Selectors not yet implemented (current stub state) | 502 | Same path as scrape failure — the endpoint is honest about being unwired |

Error ownership: `ArchiveNotFoundError` lives in `eminiplayer.constants.ts` and is thrown by the scraper — the only layer that can detect not-found. `IngestValidationError` lives in `eminiplayer-ingest.errors.ts` and is thrown by the pure validation functions, the verify service (verdict mismatch), and the manifest service (uniqueness conflict). The orchestrator passes both through untouched and wraps everything else into `IngestStageError` with `{ stage, artifact }` context. The controller maps 404 / 422 / 502 respectively. The distinction matters operationally: a 502 is retryable as-is; a 422 means the source data or our expectations are wrong and a human must look before that day can ever commit.

## Configuration

One new key in the `eminiplayer` config namespace (`backend/src/config/configuration.ts` + `.env.example`):

| Key | Env var | Default |
|---|---|---|
| `verifyModel` | `EMINIPLAYER_VERIFY_MODEL` | unset (`\|\| undefined` convention) — provider's default model. Set to a cheap classifier model (e.g. Haiku) to cut verification cost; classification needs no frontier model |

**Trust boundary:** the endpoint is unauthenticated and each call can drive a credentialed login to eminiplayer.net, so it is an operator-only tool — the backend is assumed to bind to localhost or a trusted network, same as every other endpoint in this app. If the backend is ever exposed beyond that, this controller needs a guard (shared-secret header at minimum) before anything else does: unlike the read-only demo endpoints, abuse here loops logins against a third-party membership account.

## Testing

Unit tests only, matching existing backend spec style (jest, collaborators mocked):

- **`TranscriptService`** — fixture segments → exact markdown output, including a real-shaped fixture (dozens of lines, an `H:MM:SS` boundary line, entity-bearing text) asserted byte-for-byte; ms→s normalization; fetch failure wrapped with context; oEmbed title fetch (global `fetch` mocked): success, 4xx → `VideoUnavailableError`, 5xx → plain error, missing title.
- **`eminiplayer-validation.ts`** — table-driven pure tests: transcript gate accepts a realistic fixture and rejects too-short / non-monotonic / implausible-duration (including a 1000×-compressed fixture) inputs; PDF gate accepts a minimal valid PDF buffer and rejects HTML-error-page / truncated / tiny buffers; invariants (recap ≥ date, gap > lookback, weekend dates); video-id extraction across `youtu.be` / `watch?v=` / `embed/` forms and rejection of non-YouTube URLs; title checks (date forms with and without leading zeros, flavor mismatch).
- **`EminiplayerVerifyService`** — `LLM_PROVIDER` mocked: passing verdict returned to the caller; each mismatch dimension (`docType`, `isEsContent`, weekday, low confidence) → `IngestValidationError`; transport failure → plain `Error`.
- **`EminiplayerManifestService`** — bucket + Firestore transaction mocked: manifest written last with correct shape; idempotent re-claim for same `{date, slot}`; conflict → `IngestValidationError`; `delete` releases the day's claims (and only the day's — foreign claims untouched) before removing the manifest; `read` parses or returns null.
- **`EminiplayerAuditService`** — mocked bucket/Firestore: clean shallow audit; metadata-hash mismatch, deep-mode gate failure (stored artifact whose recorded hash matches but whose content fails its gate), duplicate video id across manifests, orphaned claim, manifested id with no matching claim, unmanifested folder each produce a named anomaly; range filtering; per-file transport error attributed to the artifact, not the manifest.
- **`EminiplayerIngestService`** — all three collaborators mocked:
  - happy path: three uploads, correct paths and contentTypes, response shape
  - fill-and-skip: existing objects skipped, missing ones produced
  - `force=true`: everything regenerated
  - partial failure: recap uploads, TP transcript throws → stage error surfaces, recap upload already happened (resume semantics)
  - `ArchiveNotFoundError` from `findDayEntries` passes through unwrapped; `IngestValidationError` from any gate/check passes through unwrapped
  - stale-recap cleanup: mismatched `*_ES_RECAP.md` deleted and reported; the currently-resolved recap is never treated as stale
  - same-date coalescing: concurrent calls share one run; a later call runs fresh
  - manifest short-circuit: committed day + `force=false` + matching recapDate reports all-skipped (paths from the manifest) without re-verification; committed day + *different* freshly-resolved recapDate → `IngestValidationError`; missing manifest with existing artifacts → artifacts reloaded and fully re-verified before commit
  - stale-recap cleanup with the current recap also present: stale deleted, current untouched and reloaded as `skipped`
  - force queued behind an in-flight non-force run: both complete, forced regeneration actually runs
  - unavailable video (oEmbed 4xx) → `IngestValidationError`, not a stage error
  - no manifest written when any gate, title check, LLM verdict, or uniqueness claim fails; already-uploaded artifacts remain
- **`EminiplayerController`** — date validation (format + calendar validity), force parsing, error→status mapping.
- **`EminiplayerService` new methods** — with mocked Playwright page: each runs inside `withPage`, performs its navigation skeleton (including the landed-URL re-assert; a redirected detail page throws a navigation error), and throws the not-implemented error at the extraction point.
- No live-site or live-bucket tests.

## Out of scope

- Actual archive/detail-page selectors and PDF-link discovery (`TODO(selectors)` follow-up).
- Scheduling/cron, retries, backfill loops over date ranges.
- Syncing Storage back to the local `knowledge-base/` folder.
- Semantic parsing of PDF/transcript content beyond the verification checks above (no zone extraction, no PDF text extraction — the PDF gate is structural only).
- Alerting/notification channels for failed or anomalous days (the audit report and 4xx/5xx responses are the signal; wiring them to email/Slack is follow-up).
- Automated cleanup of orphaned Firestore video-id claims (audit flags them; cleanup is manual for now).
