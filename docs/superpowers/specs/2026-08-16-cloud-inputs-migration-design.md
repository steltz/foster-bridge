# Cloud Inputs Migration — Design (v2)

**Date:** 2026-08-16
**Status:** Approved (v2 — clean-slate rewrite after adversarial review; see
`docs/superpowers/plans/2026-08-16-cloud-inputs-migration-review.md`)

## Problem

The benchmark's input layer (`backend/src/benchmark/repo-inputs.service.ts`)
reads every input from the local filesystem: day docs from
`knowledge-base/es/`, general docs from `knowledge-base/general/`, the methods
doc from `knowledge-base/methods/seven-keys.md`, personas from `traders/`, and
features from `features/`. This is an artifact of the retired skills-based
workflow. The local `knowledge-base/` tree has been deliberately deleted; the
eminiplayer pipeline already writes day docs to Firebase Storage, and
seven-keys KEYS artifacts already live in Firestore.

**This is a clean-slate migration.** The skills-era benchmark data — every
recorded cell, batch, scoreboard, and day artifact — is retired and deleted as
part of this work. Nothing carries over: no backward compatibility with old
cells, old hashes, or old persona versions. The new era starts empty, with
Firebase Storage + Firestore as the sole source of truth and nothing the
benchmark consumes living in the repo. (This also retires the legacy MES-era
$5/pt cells CLAUDE.md warns about — the fresh era makes that mixing hazard
moot.)

## Goals

- Firebase Storage + Firestore are the sole source of truth for every
  benchmark input. No local-file reads remain.
- A fresh benchmark era: the four benchmark Firestore collections
  (`benchmarkRuns`, `benchmarkBatches`, `benchmarkScoreboard`, `dayArtifacts`)
  are wiped before the first new run.
- Drift-guard semantics preserved for the NEW era (no bypass; 409 on
  mismatch; a future era change means retiring cells) — including restoring
  the methods-doc protection that a naive embed-at-create design would lose.
- One inputs fetch per run: a run operates on an immutable in-memory snapshot
  of every input, taken once at run start.
- Validated write endpoints so future content management goes through the API
  (write-once for personas/features).

## Non-goals

- No backward compatibility with skills-era cells, scorecards, hashes, or
  persona versions. No migration-era dual-read paths.
- No changes to grading, KEYS generation logic, the Batch API flow, or the
  scoreboard's grouping/keying.
- No general era-retirement tooling — the one-time wipe is a documented
  manual operation, and future era changes remain manual by design.

## Storage layout

### Firebase Storage bucket (shared, blob-like inputs)

```
knowledge-base/es/<MMDDYYYY>/            # already exists — eminiplayer writes it
    <day>_ES_TP.md
    <day>_ES_TP.pdf
    <recapDay>_ES_RECAP.md
    manifest.json                        # commit marker = "this day exists"
knowledge-base/general/<name>.md         # new: general docs
knowledge-base/methods/seven-keys.md     # new: THE methods doc (single copy)
```

Day-doc paths come from the eminiplayer module's single home of the storage
contract (`eminiplayer-validation.ts`: `ES_STORAGE_PREFIX`, `dayPaths`,
`manifestPath`). The two NEW paths (`general/`, `methods/`) get the same
treatment: `GENERAL_PREFIX`, `generalDocPath(name)`, and `METHODS_PATH` are
exported from exactly one module (`cloud-inputs.service.ts`) and imported by
both the reader and the writer — a second definition anywhere is a defect.

### Firestore (persona-scoped, write-once, content-canonical)

```
traders/<name>    { name, content, sha256, createdAt }
features/<id>     { id, content, sha256, createdAt }
```

**Content is canonical.** The full markdown (frontmatter included) is the
stored truth; everything else — a trader's `origin`/`mutation` lineage, a
feature's display `name`, `block`, `artifactSuffix`, and its `staticDoc`
marker — is derived from `content` at read time by parsing frontmatter. The
stored `sha256` is a convenience copy computed server-side at write time;
readers always recompute from `content` so out-of-band edits are visible to
the drift guard. Direct Firestore queries against derived fields (e.g.
`where origin == ...`) are not supported and not needed.

Deliberate choices:

1. **Day existence = committed manifest.** A day is benchmarkable iff
   `knowledge-base/es/<day>/manifest.json` exists in the bucket AND every
   artifact the manifest promises is present. Partial days are issues, never
   days. This applies to every read — including outcome-recap lookups, which
   must never read files out of an uncommitted (force-rerun-in-progress)
   folder.
2. **The methods doc has ONE copy.** A feature whose frontmatter carries a
   `staticDoc` key does NOT embed the document; the reader resolves
   `staticDocContent` live from the bucket's `knowledge-base/methods/seven-keys.md`
   at snapshot time. This keeps prompts, KEYS generation, and the drift guard
   all reading the same bytes, and preserves today's behavior where editing
   the methods doc after cells exist trips the `staticDoc` drift family.

## CloudInputsService

Replaces `RepoInputsService` (which is deleted). The interface is built
around a **per-run snapshot**: one call fetches everything, and the run
operates on those immutable values — no re-fetching mid-run, no N+1 bucket
scans, no possibility of different days in one run seeing different inputs.

```ts
interface TraderInput {
  name: string;
  origin: string | null;    // from frontmatter; null for root personas
  mutation: string | null;
  content: string;
  sha256: string;
}
interface FeatureInput {
  id: string;
  name: string;
  block: string;
  sha256: string;
  staticDocContent: string | null;  // live bucket methods doc when frontmatter has staticDoc
  staticDocSha256: string | null;
  artifactSuffix: string | null;
}
interface GeneralDocs {
  files: { path: string; content: string }[];
  concatenated: string;   // path-sorted concatenation
  sha256: string;         // zero-bytes sentinel when empty
}
interface DayListing {
  day: string;        // MMDDYYYY
  date: string;       // YYYY-MM-DD
  prefix: string;     // TP filename prefix (== day in the bucket layout)
  recapDate: string;  // from the manifest
  fileSha256: { tradePlanMd: string; tradePlanPdf: string; recap: string }; // from manifest FileRecords
}
interface DayInput extends DayListing {
  pdf: Buffer;
  tpTranscript: string;
  recapTranscript: string;
  recapFileName: string;  // `${recapDate}_ES_RECAP.md`
}
interface DayIssue { day: string; missing: string[] }

interface InputsSnapshot {
  traders: TraderInput[];
  features: FeatureInput[];      // staticDocContent already resolved from methodsDoc
  general: GeneralDocs;
  methodsDoc: string | null;
  days: DayListing[];            // committed, fully-present days, asc by date
  issues: DayIssue[];
}

snapshot(): Promise<InputsSnapshot>
  // One bucket list over the ES prefix + parallel manifest downloads + the
  // general/methods/traders/features fetches, all concurrent. The single
  // fetch a run performs.

loadDay(listing: DayListing): Promise<DayInput>
  // Downloads the three artifacts and VERIFIES each one's sha256 against the
  // manifest FileRecords captured in the listing. A mismatch (a force-rerun
  // overwrote the day mid-run) throws — the run's per-day isolation turns it
  // into a daysSkipped entry instead of freezing torn inputs into provenance.

outcomeRecapForDay(day: string, snap: InputsSnapshot): Promise<string | null>
  // A day's outcome recap is `<day>_ES_RECAP.md` in the FOLLOWING committed
  // day's folder: found via the snapshot's listings (a listing whose
  // recapDate === day), downloaded and sha256-verified. Committed days only.

priorCompleteDays(targetDay: string, snap: InputsSnapshot): DayListing[]
  // Pure filter over snap.days — no I/O.
```

Consumers thread the snapshot down instead of re-fetching:
`BenchmarkService.run()` takes one snapshot at start and passes it (or values
from it) into seven-keys; `SevenKeysService.generate`/`ensureKeys` take
`(day: DayInput, snap: InputsSnapshot)` and compute `inputsHash` from the
same in-memory `snap.methodsDoc` the generation prompts consume — never from
a second fetch. `checkDrift`, the scoreboard, and the cache-warmer each take
their own snapshot per invocation (they run outside benchmark runs).

Hashing scheme (consistent, not legacy-bound): persona sha256 = sha256 of
full markdown (frontmatter included); feature sha256 = sha256 of full
markdown; `staticDocSha256` = sha256 of the resolved methods doc;
general sha256 = sha256 of the path-sorted concatenation, zero-bytes sentinel
(`e3b0c4...b855`) when empty.

Malformed Firestore docs (missing `name`/`id`/`content` — only possible via
out-of-band writes) produce a named error (`traders/<docid> is malformed`),
never a bare TypeError.

### Consumers

Six touchpoints migrate; logic otherwise unchanged:

- `benchmark.service.ts` — one `snapshot()` at run start; day materialization
  via `loadDay`; refuses with 422 when the snapshot has zero traders or zero
  features; **single-flight**: a second concurrent `POST /benchmark/run`
  gets 409 (`a benchmark run is already in progress`), closing the
  duplicate-KEYS / orphaned-pin race the review found.
- `seven-keys/seven-keys.service.ts` — `(day, snap)` signatures; lookback and
  outcome recaps resolved through the snapshot.
- `drift.ts` — pure comparison unchanged; findings gain
  `source: 'firestore' | 'bucket'` (`general` and `staticDoc` → bucket;
  `persona`/`feature` → firestore). `staticDocSha256` hashes the bucket's
  methods doc, so a staticDoc drift can only be a bucket-side change — the
  409 must point there, not at the Firestore feature doc.
- `scoreboard.service.ts`, `cache-warmer.ts` — take a snapshot per invocation.
- `benchmark.module.ts` — provides `CloudInputsService`.

## Write endpoints

All bodies are JSON.

```
POST /traders                  { content }             → 201 { name, sha256 }; 400 invalid; 409 exists
POST /features                 { content }             → 201 { id, sha256 };   400 invalid; 409 exists
PUT  /knowledge/general/:name  { content }             → 200 { path, sha256 }  (mutable)
PUT  /knowledge/methods        { content }             → 200 { path, sha256 }  (mutable)
GET  /traders                  [{ name, origin, mutation, sha256 }]
GET  /features                 [{ id, name, sha256 }]
GET  /knowledge/general        [{ path, sha256 }]      (sha256 computed from content)
```

Validation at the door:

- `POST /traders` requires frontmatter `name` (matching `[A-Za-z0-9_-]+`).
  `origin`/`mutation` are **optional** — a root persona (the head of a family
  tree, like `context-trader`) legitimately has neither; when present they
  are recorded as lineage. There is no root-persona penalty.
- `POST /features` requires frontmatter `id` (same charset). No
  `staticDocContent` in the body — the `staticDoc` frontmatter key is a
  marker resolved live at read time (see deliberate choice 2).
- Write-once via Firestore `create()` (atomic fail-on-existing → 409), not
  read-then-write.
- The mutable `PUT` endpoints overwrite freely — the drift guard, not the
  write path, protects benchmarked eras. Avoid PUTs while a run is in flight
  (the single-flight guard bounds a run; check `GET /benchmark/status`).
- `:name` on the general PUT is validated against the same charset (this is
  also the path-traversal guard).

## Drift guard

Semantics unchanged for the new era: before uploading or submitting
anything, `POST /benchmark/run` hashes the snapshot's inputs and compares
against every recorded cell; any mismatch → 409 with no bypass flag.

- **Personas & features** — structurally immutable (write-once), still
  verified (defends against out-of-band edits; content sha recomputed at
  read).
- **General docs** — mutable via PUT; the guard does the real work.
- **Methods doc** — protected through the `staticDoc` family: because
  `staticDocContent` is resolved live from the bucket, a `PUT
  /knowledge/methods` after cells exist changes the computed
  `staticDocSha256`, which mismatches the recorded one → 409. This is the
  same protection the local-file era had.
- **Day docs** — not a drift family; `loadDay`'s manifest verification plus
  KEYS `inputsHash` provenance handle changed days.
- Findings carry `source: 'firestore' | 'bucket'` so a 409 names where to
  look.

## Error handling

- Unreachable bucket/Firestore during the run-start snapshot → 503 before
  anything is uploaded or submitted (fail-closed). After batches start
  submitting, a per-day failure (including a `loadDay` verification
  mismatch) is isolated into `daysSkipped` — the 503 promise is scoped to
  the up-front snapshot, matching today's behavior.
- Manifest present but artifacts missing/unreadable → the day appears in
  `snapshot().issues` with the reason.
- Zero traders or zero features in the snapshot → 422 with an explicit
  message naming the endpoint to call.
- Malformed Firestore content docs → named 503, not a TypeError.

## Fresh-era migration (one-time)

Order matters: wipe first, then import, then verify. All commands documented
in the plan; none kept as repo scripts.

1. **Wipe the old era**: delete the Firestore collections `benchmarkRuns`,
   `benchmarkBatches`, `benchmarkScoreboard`, `dayArtifacts` (firebase-tools
   recursive delete, or the Firebase console). `GET /benchmark/status` must
   be empty first (no in-flight batches).
2. **Import personas** (2): `POST /traders` from the on-disk
   `traders/context-trader.md` (root — no lineage) and
   `traders/context-structured.md`.
3. **Import features** (2): `POST /features` from `git show
   HEAD:features/seven-keys-method.md` and `HEAD:features/seven-keys-scorecard.md`
   — content only; their `staticDoc` frontmatter resolves live.
4. **Upload shared docs**: `PUT /knowledge/general/support_and_resistance_zones`
   and `PUT /knowledge/methods` from `git show HEAD:` of the corresponding
   files. `HEAD` consistently — never `HEAD~1`.
5. **Acceptance gate** (all MUST pass; the drift check alone cannot detect a
   missing input, so the listings are load-bearing):
   - `GET /traders` returns exactly `context-structured`, `context-trader`
   - `GET /features` returns exactly `seven-keys-method`, `seven-keys-scorecard`
   - `GET /knowledge/general` returns the doc with sha256 equal to
     `git show HEAD:knowledge-base/general/support_and_resistance_zones.md | shasum -a 256`
   - `GET /benchmark/drift` returns `{"findings":[],"cellsExamined":0}`
   All curl steps use `-sS --fail-with-body` and are chained with `&&` so a
   400/409/503 halts the sequence loudly instead of being swallowed.

## Testing

- Unit: mock bucket + Firestore using the existing idioms from the
  eminiplayer specs. Port the drift-guard spec matrix and add: `source`
  labels, write-once 409s, root-persona acceptance, malformed-doc named
  errors, manifest-without-artifacts issues, `loadDay` sha mismatch, the
  zero-traders/zero-features refusals, and the single-flight 409.
- E2e: the benchmark suites replace their temp-repo seeding with seeded
  fakes (`fakeFirestore` + a `fakeBucket` extended with `getFiles`), with
  manifests that carry `FileRecord` sha256s so `loadDay` verification
  passes.

## Repo cleanup (after the migration gate passes)

- Commit the pending deletions (`knowledge-base/`, `features/`, retired
  `.claude/skills/`), plus delete `traders/` (migrated).
- Update `CLAUDE.md`: personas are write-once Firestore docs via
  `POST /traders` (lineage optional for roots); content endpoints
  documented; day availability = committed eminiplayer manifests; **remove
  the legacy MES-era warning block** (obsolete — those cells are deleted).
