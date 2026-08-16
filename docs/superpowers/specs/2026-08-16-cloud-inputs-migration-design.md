# Cloud Inputs Migration — Design

**Date:** 2026-08-16
**Status:** Approved

## Problem

The benchmark's input layer (`backend/src/benchmark/repo-inputs.service.ts`)
reads every input from the local filesystem: day docs from
`knowledge-base/es/`, general docs from `knowledge-base/general/`, the methods
doc from `knowledge-base/methods/seven-keys.md`, personas from `traders/`, and
features from `features/`. This is an artifact of the retired skills-based
workflow. The local `knowledge-base/` tree has been deliberately deleted; the
eminiplayer pipeline already writes day docs to Firebase Storage, and
seven-keys KEYS artifacts already live in Firestore. The benchmark must read
from those cloud stores, and nothing the benchmark consumes may live in the
repo.

## Goals

- Firebase Storage + Firestore are the sole source of truth for every
  benchmark input. No local-file reads remain.
- Preserve drift-guard semantics exactly (no bypass; 409 on mismatch; new era
  = manual cell retirement).
- Preserve the sha256 hashing scheme byte-for-byte so the 476 existing
  scorecard cells' recorded hashes remain valid — the migration itself must
  produce zero drift findings.
- Provide validated write endpoints so future content management goes through
  the API (write-once for personas/features).

## Non-goals

- No changes to grading, KEYS generation logic, the Batch API flow, or the
  scoreboard's grouping/keying.
- No retirement/era tooling for existing cells (still a manual Firestore
  operation, per the drift guard's design).
- No backfill or re-run of existing cells.

## Storage layout

### Firebase Storage bucket (shared, blob-like inputs)

```
knowledge-base/es/<MMDDYYYY>/            # already exists — eminiplayer writes it
    <day>_ES_TP.md
    <day>_ES_TP.pdf
    <recapDay>_ES_RECAP.md
    manifest.json                        # commit marker = "this day exists"
knowledge-base/general/<name>.md         # new: general docs
knowledge-base/methods/seven-keys.md     # new: methods doc
```

Path constants are shared with the eminiplayer module's single home of the
storage contract (`eminiplayer-validation.ts`: `ES_STORAGE_PREFIX`,
`dayPaths`, `manifestPath`) so the day-doc writer and the benchmark reader can
never drift apart.

### Firestore (persona-scoped / structured, write-once)

```
traders/<name>    { name, origin, mutation, content, sha256, createdAt }
features/<id>     { id, name, block, staticDocContent?, artifactSuffix?, sha256, createdAt }
```

The existing `benchmark-artifacts` collection (KEYS artifacts, day artifacts)
is unchanged.

Deliberate choices:

1. **Day existence = committed manifest.** A day is benchmarkable iff
   `knowledge-base/es/<day>/manifest.json` exists in the bucket. This replaces
   filename-suffix matching and means only days the eminiplayer pipeline
   actually committed are visible to the benchmark.
2. **Features embed their static doc.** `staticDoc` stops being a
   repo-relative path; the document content is stored in the feature's
   Firestore doc (`staticDocContent`) at creation time. There is no repo to
   reference.

## CloudInputsService

Replaces `RepoInputsService` (which is deleted). Same conceptual interface
with two systematic changes: every method is **async**, and `DayInput`
carries **content, not paths**.

```ts
interface DayListing {
  day: string;              // MMDDYYYY
  date: string;             // YYYY-MM-DD
  prefix: string;           // 8-digit TP filename prefix
}

interface DayInput extends DayListing {
  pdf: Buffer;              // was pdfPath
  tpTranscript: string;     // was planPath
  recapTranscript: string;  // was recapPath
}

collectTraders(): Promise<TraderInput[]>       // Firestore traders/ — shape unchanged
collectFeatures(): Promise<FeatureInput[]>     // Firestore features/
collectGeneralDocs(): Promise<GeneralDocs>     // bucket general/*, path-sorted, concatenated — same sha256 scheme
collectDays(): Promise<DayListing[]>           // bucket manifest listing (metadata only, one list call)
loadDay(day: string): Promise<DayInput>        // downloads the 3 artifacts on demand
collectDayIssues(): Promise<DayIssue[]>        // manifest present but artifacts missing/ambiguous
readMethodsDoc(): Promise<string | null>
priorCompleteDays(day: string): Promise<DayListing[]>
outcomeRecapForDay(day: string): Promise<string | null>  // was outcomeRecapPathForDay; returns content
```

Performance:

- **Lazy day loading.** `collectDays()` returns listings only (day/date/prefix
  derived from the manifest); artifacts download on first `loadDay()`.
  Consumers materialize only the days they actually run.
- **Per-run memoization.** Within one `POST /benchmark/run`, traders,
  features, general docs, and the methods doc are fetched once and passed
  down as values (largely how consumers already treat them).

Hashing is byte-identical to today: persona `content` sha256, feature `block`
sha256, `staticDocContent` sha256, general-docs concatenation sha256
(path-sorted, zero-bytes sentinel when empty). Existing cells' recorded
hashes therefore remain valid with no false drift.

### Consumers

Six touchpoints switch to `await` + content fields; logic otherwise
unchanged:

- `benchmark.service.ts` — day materialization via `loadDay`; drops its
  `readFileSync` calls.
- `seven-keys/seven-keys.service.ts` — same; `outcomeRecapForDay` now returns
  content directly.
- `drift.ts` — pure comparison logic unchanged; inputs arrive as values.
- `scoreboard.service.ts` — `collectTraders`/`collectFeatures` awaited.
- `cache-warmer.ts` — awaited.
- `benchmark.module.ts` — provides `CloudInputsService` (needs the
  `STORAGE_BUCKET` and `FIRESTORE` providers from the Firebase module).

## Write endpoints

```
POST /traders                  body: { name, content }                  → 201; 409 if exists
POST /features                 body: { id, content, staticDocContent? } → 201; 409 if exists
PUT  /knowledge/general/:name  body: markdown                           → 200 (mutable)
PUT  /knowledge/methods        body: markdown                           → 200 (mutable)
GET  /traders                  list (name, origin, mutation, sha256)
GET  /features                 list (id, name, sha256)
GET  /knowledge/general        list (name, sha256)
```

Validation at the door:

- `POST /traders` parses frontmatter and requires the `origin` / `mutation`
  lineage fields (the scoreboard family tree depends on them). `sha256` is
  computed server-side.
- `POST /features` parses frontmatter for `name` / `artifactSuffix`, extracts
  the body block server-side, hashes server-side.
- Write-once is enforced with Firestore `create()` (atomic fail-on-existing),
  not read-then-write.
- The mutable `PUT` endpoints overwrite freely — the drift guard, not the
  write path, protects benchmarked eras.

## Drift guard

Semantics unchanged: before uploading or submitting anything,
`POST /benchmark/run` hashes current inputs and compares against every
recorded cell; any mismatch → 409 with no bypass flag. What changes is the
source of "current":

- **Personas & features** — read from Firestore. Drift is structurally
  impossible via write-once `create()`, but the guard still verifies them
  (cheap; defends against out-of-band console/script edits).
- **General docs & methods doc** — mutable in the bucket; the guard does real
  work here exactly as it did for local files. Editing after cells exist
  blocks runs until reverted; "new era = manually retire cells" carries over.
- **Day docs** — not a drift family (unchanged); KEYS provenance
  (`sourceSha`) already handles force-regenerated days and keeps working
  since hashes cover the same bytes.

Addition: each drift finding gains a `source` field (`firestore` | `bucket`)
so a 409 names where to look.

## Error handling

- Manifest exists but an artifact fails to download or is missing → the day
  appears in `collectDayIssues` with the reason; never a crash, never a
  silent disappearance.
- Bucket or Firestore unavailable → `POST /benchmark/run` returns 503 before
  anything is submitted (fail-closed, consistent with the guard).
- Zero traders or zero features in Firestore → the run refuses with an
  explicit message rather than benchmarking an empty matrix.

## One-time migration

Run against the local backend once the endpoints exist; content sourced from
the working tree / git history. No migration scripts are kept in the repo —
these are documented curl calls.

1. `POST /traders` × 2 — `traders/context-structured.md`,
   `traders/context-trader.md` (still on disk).
2. `POST /features` × 2 — `features/seven-keys-method.md`,
   `features/seven-keys-scorecard.md` via
   `git show HEAD:features/<file>` (variants are still active; 476 existing
   cells reference them).
3. `PUT /knowledge/general/support_and_resistance_zones` —
   `git show HEAD:knowledge-base/general/support_and_resistance_zones.md`.
4. `PUT /knowledge/methods` —
   `git show HEAD:knowledge-base/methods/seven-keys.md`.
5. **Verify:** `GET /benchmark/drift` returns `{}` findings — the migrated
   content hashes match what the 476 existing cells recorded. This is the
   acceptance gate for the migration.

## Testing

- Unit: mock bucket + Firestore using the existing idioms from the
  eminiplayer specs. Port the drift-guard spec matrix; add specs for
  write-once 409s, lineage validation, manifest-without-artifacts day issues,
  and the zero-traders/zero-features refusal.
- E2e: existing benchmark e2e suites swap filesystem fixtures for mocked
  storage/Firestore surfaces (same pattern as the moonshot batch e2e mocks).

## Repo cleanup (after migration verifies)

- Commit the ~1,544 pending deletions (`knowledge-base/`, `features/`,
  retired `.claude/skills/`), plus delete `traders/` (migrated).
- Update `CLAUDE.md`: document the new endpoints; rewrite "personas are
  files" to "personas are write-once Firestore docs created via
  `POST /traders`"; note that day availability comes from committed
  eminiplayer manifests.
