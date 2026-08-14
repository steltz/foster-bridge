# EminiPlayer Ingest Pipeline — Post-merge Follow-ups

Merged to main at `d999f58` (2026-08-06), 63 suites / 651 tests green. The final
whole-branch review's two MUST items and five strongly-recommended items were
fixed pre-merge. Everything below was explicitly triaged as **safe to defer** —
recorded here because the execution ledger was removed with the worktree.

## Selector follow-up — DONE 2026-08-14

The three scraper methods are implemented (`eminiplayer-archive.ts` holds the
pure row parsing/selection; `eminiplayer.service.ts` scrapes raw rows,
iframes, and hrefs). Verified: full suite green, plus a read-only live smoke
(`findDayEntries('08132026')` → both `getYoutubeUrl` flavors → PDF download
passing `assertPdfBuffer`). What the live-site recon settled, item by item:

1. **oEmbed titles captured (5 recap + 2 TP)** — the fear was justified:
   recap videos date with dashes (`08-13-2026 | E-mini S&P 500 and
   Nasdaq-100 Futures Trading Recap (Video Lesson)`), TP videos with slashes
   (`08/13/2026 … Key Support / Resistance Zones & Trade Plan`). The original
   slash-only forms would have 422'd every recap; `titleDateForms` /
   `ANY_TITLE_DATE` now accept both separators.
2. **Real trade-plan PDF captured** (441KB "Trader Worksheet", PDF 1.7):
   classic `/Type /Page` literal present, `%%EOF` in the last 1KB —
   `assertPdfBuffer` passes as-is.
3. **Same-origin enforcement landed** in `resolveEntryUrl`
   (`eminiplayer-archive.ts`), applied to listing hrefs AND the PDF link
   before any credentialed `page.goto`/`page.request.get`. Permalinks are
   path-keyed (`/post/YYYY/MM/DD/Title.aspx`), so `assertOnPage`'s
   pathname-only comparison needed no query extension.
4. **Three-way agreement implemented** in `selectDayEntries`: row date cell
   (ISO `YYYY-MM-DD`), title date, and title weekday vs calendar must agree
   on any selected row (else `IngestValidationError`); absence throws
   `ArchiveNotFoundError` within `RECAP_LOOKBACK_DAYS`. Titles are anchored
   regexes — the listing also carries "ES Recap Charts …", "NQ Recap …", and
   announcement posts mentioning "Trade Plan" that keyword tests would
   misfile. Weekday tokens observed: full names + "Wed."; three typos in 14
   years (e.g. "Thurday") are treated as unclassifiable.
5. **Real YouTube form**: both flavors embed via `youtube.com/embed/<id>`
   iframes (already accepted), next to a Twitter-widget iframe that
   `extractYoutubeVideoId`'s host allowlist filters out.
6. Operational smoke of the LLM verify call remains to be done on the first
   real ingest (`maxTokens: 300`; on moonshot, reasoning effort could hit
   the length ceiling → 502).

## Deferred minors (triaged safe; grouped by area)

**Verification/gates** — errors file has no dedicated spec and classes don't
set `this.name`; `%%EOF` searched across the whole buffer (last-1KB stricter);
PDF gate does a full latin1 string copy per call; flavor patterns
non-exclusive; video-id regex looser than YouTube's 11-char form;
`parseMmddyyyy` accepts implausible years (a 2000–2100 band would close it);
`TRANSCRIPT_MIN_CHARS` unreachable in fixtures.

**Transcript module** — no network-failure test for the oEmbed catch branch;
`TranscriptSegment` drops `duration` (widen if a consumer ever needs it);
`transcriptToMarkdown([])` yields an extra newline (parity-faithful; gate
rejects empty transcripts anyway).

**Orchestrator** — `_ES_RECAP.md` suffix literal in the stale-scan duplicated
outside `dayPaths`; short-circuit trusts manifest structure (partial manifest
→ raw TypeError → 500 instead of 422; the manifest service's `delete` shows
the optional-chaining pattern to copy); `manifest.version` is written but
never read (a pipeline bump won't invalidate v1 days — decide whether audit
should flag version mismatches); queued `force` can be starved under
sustained non-force traffic (eventually runs, not next-in-line); reloaded
artifacts' manifest `sources.videoId` provenance is unverified against the
reloaded bytes (adding `videoId` to `FileRecord` would let audit reconcile);
the `f.delete({ ignoreNotFound: true })` stale-cleanup argument is unpinned
by tests.

**Controller** — `isValidMmddyyyy` duplicates `parseMmddyyyy` (reuse with
try/catch; note the audit route has no IngestValidationError mapping, so
drift could surface as a 500); 400 message says "required" even for
present-but-invalid dates (repo convention); no test pins `@HttpCode(200)`;
`force` exactness (`TRUE`/`1` → false) untested and unhinted in the
stale-recap 422 message; consider requiring a date range when `deep=true`
on the audit (unbounded corpus download on one unauthenticated GET).

**Audit** — `manifestedIds` last-writer-wins misattributes the claim-check
message when a video id is duplicated across days (the duplicate anomaly
still fires); absent GCS `md5Hash` (composite objects) reports as "md5
mismatch" rather than "cannot verify"; `ok` counts storage-side checks only
(claims-pass anomalies don't decrement it — `anomalies` is the trust
signal); no storage→manifest stray-object check; an aborted day skips
video-id registration so its claims read as orphaned (extra noise on an
already-anomalous day); README's "never aborts" is now true via the per-day
backstop, but "reused artifacts are still re-verified" doesn't apply to the
committed-manifest short-circuit path (those days were verified at commit).

**Verify service** — no test for `EMINIPLAYER_VERIFY_MODEL=''`
(set-but-empty, the `.env.example` default state).

**Test scaffolding** — the manifest-service transaction fake doesn't enforce
Firestore's read-before-write rule or model retries; the scraper-stubs
describe lacks `beforeEach(clearAllMocks)`; module spec doesn't assert the
module's exports.

## Unrelated observation from the merge session

The main checkout has an uncommitted working-tree deletion of
`knowledge-base/es/07012026/07012026_ES_KEYS.md` (not part of this branch,
not committed or pushed). Restore with
`git checkout -- knowledge-base/es/07012026/07012026_ES_KEYS.md` if
unintended.
