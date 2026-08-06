# EminiPlayer Ingest Pipeline — Post-merge Follow-ups

Merged to main at `d999f58` (2026-08-06), 63 suites / 651 tests green. The final
whole-branch review's two MUST items and five strongly-recommended items were
fixed pre-merge. Everything below was explicitly triaged as **safe to defer** —
recorded here because the execution ledger was removed with the worktree.

## Selector follow-up (the next piece of real work)

`findDayEntries` / `getYoutubeUrl` / `downloadTradePlanPdf` still throw
`selectors not implemented yet`. When implementing against the live site:

1. **Capture 3–5 real oEmbed video titles first** and encode the observed
   date/flavor forms in `assertVideoTitle` (`eminiplayer-validation.ts`) —
   the current `M/D/YYYY` + flavor-keyword patterns are an unvalidated
   assumption; a format mismatch would 422 every single day. The gate already
   distinguishes "no recognizable date (our assumption may be wrong)" from
   "contradictory date" to make this diagnosable.
2. **Capture a real trade-plan PDF** — the structural gate accepts classic
   `/Type /Page` or compressed `/ObjStm` markers; confirm real PDFs pass.
3. **Validate scraped hrefs are absolute and same-origin** before returning
   them from `findDayEntries` — `pageUrl` flows into `page.goto` on a
   credentialed session (security control, not a nit). Note `assertOnPage`
   compares pathname only; if permalinks turn out to be query-keyed
   (`/post.aspx?id=…`), extend it to compare the query too.
4. **Honor the contracts in the `TODO(selectors)` comments**: three-way date
   agreement (row date = title date = title weekday), `ArchiveNotFoundError`
   within `RECAP_LOOKBACK_DAYS`, and note the orchestrator now also re-asserts
   `entries.tradePlan.date === date` as a consumer-side backstop.
5. **Check real YouTube URL forms** — extraction accepts youtube.com /
   youtube-nocookie.com hosts and `/watch`, `/embed/`, `/live/`, `/shorts/`,
   `/v/`, `youtu.be` paths.
6. Operational smoke: verify the configured LLM provider handles the verify
   call (`maxTokens: 300`; on moonshot, reasoning effort could hit the
   length ceiling → 502).

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
