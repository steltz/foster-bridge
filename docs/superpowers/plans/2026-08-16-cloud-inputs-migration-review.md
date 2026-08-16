# Review: Cloud Inputs Migration spec + plan

**Reviewed:** 2026-08-16
**Spec:** `docs/superpowers/specs/2026-08-16-cloud-inputs-migration-design.md`
**Plan:** `docs/superpowers/plans/2026-08-16-cloud-inputs-migration.md`
**Method:** four parallel adversarial critics (spec-plan consistency, internal plan correctness, architecture soundness, codebase grounding), findings deduplicated. Feature unbuilt at review time.

## Outcome (2026-08-16)

All 20 findings were addressed via a full v2 rewrite of both documents, combined with the user's clean-slate decision (the skills-era benchmark data — cells, batches, scoreboards, day artifacts — is wiped as part of the migration; no backward compatibility with old hashes or persona versions). Notable resolutions:

- Findings 2 and 3 were resolved **structurally**: features no longer embed `staticDocContent` at all — the methods doc has one copy in the bucket, resolved live at snapshot time. There is nothing to forget at import time, and the drift protection works exactly as the local-file era's did.
- Finding 4's fix became the design's centerpiece: a per-run `InputsSnapshot` (one bucket list, parallel manifest downloads, everything fetched once and threaded down).
- Finding 12 became **moot**: the era wipe deletes all KEYS artifacts, so first-run regeneration is expected, not silent drift.
- Finding 1's fix (lineage optional for root personas) also removed the byte-preservation bind entirely, since no legacy hashes survive the wipe.

## Scores

- **Spec: 2/10.** One Critical (the mandated lineage validation makes migrating the root persona impossible), one High (the methods-doc drift promise is unimplementable as designed — the spec simultaneously freezes `staticDocContent` at feature creation and promises the methods doc stays guarded "exactly as it did for local files"), plus four Medium/Low internal contradictions. Deductions exceed the scale; clamped up from 1.5.
- **Plan: 1/10 (clamped).** Two Criticals — both in the one-time migration whose acceptance gate is structurally blind to them — one High (the spec's performance requirements are never implemented), seven Mediums, six Lows. The plan is otherwise precisely grounded: every line citation, signature, and fixture shape the critics checked against the real repo was accurate.

Both scores are dominated by a small number of fixable defects; with the findings below applied, the pair re-scores in the 8–9 range.

---

## Critical

### 1. Root persona cannot pass the mandated lineage validation; the acceptance gate cannot see the failure
- **Doc:** Spec §Write endpoints ("requires the `origin`/`mutation` lineage fields") + Plan Task 6 Step 3 (`createTrader` requires `name`/`origin`/`mutation` present) + Task 8 Steps 1/4.
- **Failure scenario:** The real `traders/context-trader.md` frontmatter has only `name` and `style` — it is the ROOT of the family tree (`context-structured.md` declares `origin: context-trader`); today's code treats lineage as optional (`fm.origin || null`). Task 8's `curl -sf POST /traders` for it returns 400 and prints nothing. There is no legal remedy: adding lineage lines changes the sha256 the 476 cells pin → permanent drift. The Step 4 gate passes anyway, because `detectDrift` deliberately ignores cells whose trader is absent from current inputs — so the migration reports success half-done, Task 9 deletes `traders/`, and every future run 422s with "no traders."
- **Fix:** Validate `name` always; accept `origin`/`mutation` as optional (root personas), or require them only as a pair when either is present. Update the spec's validation sentence and Task 6's "no lineage" test case to match. Harden Task 8 Step 4: `GET /traders` returning exactly the 2 expected names and `GET /features` the 2 expected ids becomes a MUST-pass part of the gate (the drift check cannot detect missing inputs).
- **Status:** applied (v2 rewrite)

### 2. Scorecard feature imported without `staticDocContent`; gate blind; every scorecard run then breaks silently
- **Doc:** Plan Task 8 Step 2 (first command) + spec §One-time migration (same omission by silence).
- **Failure scenario:** BOTH feature files declare `staticDoc: knowledge-base/methods/seven-keys.md` (verified via `git show`), so existing scorecard cells recorded a `staticDocSha256`. The plan imports `seven-keys-scorecard` with `{content: .}` only. Result: `staticDocSha256: null` → `drift.ts` skips the staticDoc comparison when the current value is null (absent-is-not-a-mismatch, by design) → the Task 8 gate passes. Then every scorecard-variant run throws in `envelope.builder.ts` ("requires a methods doc to substitute"), which `run()`'s per-day isolation converts to silent `daysSkipped` for every day. Features are write-once, so the bad doc is only fixable by manual Firestore deletion.
- **Fix:** Give the scorecard import the same `--argjson sd "$STATIC"` treatment as the method feature. Optionally harden the gate: flag any feature whose recorded cells carry a `staticDocSha256` while the current value is null.
- **Status:** applied (v2 rewrite)

## High

### 3. Methods-doc drift protection silently lost
- **Doc:** Spec §Drift guard vs §Storage layout deliberate choice 2 (internal contradiction); no plan task implements a methods-doc drift family.
- **Failure scenario:** Today the protection exists because `collectFeatures` reads `staticDocContent` live from the methods file on every run, so a methods edit fires the `staticDoc` drift family. Under the plan, `staticDocContent` is frozen into the feature doc at create time and nothing hashes the bucket's methods doc into `driftInputs`. Operator PUTs an edited methods doc after cells exist → next run proceeds (spec says 409) → seven-keys regenerates KEYS from methods-v2 while trader envelopes still embed frozen methods-v1 → the scoreboard silently averages v1 and v2 cells into the same rows. Also creates two divergeable copies of one document.
- **Fix:** Add a methods drift comparison (bucket methods doc sha256 vs recorded `staticDocSha256`, which is that same document's hash today), or derive the drift-checked `staticDocSha256` from the live bucket methods doc in `collectFeatures`. Decide explicitly which copy prompts consume, and say so in both docs.
- **Status:** applied (v2 rewrite)

### 4. Spec's performance requirements have no implementing task — O(days²) GCS round-trips per run, non-reproducible day set mid-run
- **Doc:** Plan Tasks 2/4/5 vs Spec §Performance ("metadata only, one list call"; "fetched once and passed down").
- **Failure scenario:** Every `collectDays`/`collectDayIssues`/`priorCompleteDays`/`outcomeRecapForDay` call runs a fresh `scanDays()` = one list + one **sequential** manifest download per committed day. `run()` calls it twice; seven-keys calls `priorCompleteDays` per day and `outcomeRecapForDay` per lookback day (the loop iterates ALL prior keyed days before slicing to 3); `readMethodsDoc()` is downloaded twice per day (`generate` + `computeInputsHash`); `collectGeneralDocs` re-downloads per day. For a ~30-day corpus with KEYS generation: ~467 scans × ~30 serial manifest downloads ≈ 14,000 GCS round-trips before/during one run — minutes of pure I/O plus rate-limit exposure. And because every scan re-lists the bucket, a manifest committed mid-run changes `priorCompleteDays` between days of the same run — non-reproducible lookback inputs. A related correctness edge: a `PUT /knowledge/methods` landing between `generate()`'s fetch and `computeInputsHash`'s separate fetch stores an `inputsHash` over bytes that were not the generation inputs.
- **Fix:** Fetch traders/features/general/methods once per run in `run()` and thread them down into `ensureKeys`/`generate`; memoize `scanDays()` (per-run snapshot or in-flight promise cache); `outcomeRecapForDay` needs only the name list — skip manifest downloads; compute `inputsHash` from the same in-memory values `generate()` consumed; parallelize manifest downloads within a single scan.
- **Status:** applied (v2 rewrite)

## Medium

### 5. `loadDay` never verifies against the manifest — a force-rerun can freeze a torn day into cell provenance
- **Doc:** Plan Task 2; spec §Error handling silent on it.
- **Failure scenario:** The eminiplayer force path is delete-manifest → overwrite artifacts → commit new manifest. A run that listed days before the delete later `loadDay()`s mid-overwrite: new TP.md with old PDF, or the old recap when the rerun resolved a different `recapDate` (old recap file is left behind). Mixed content flows into day artifacts, envelopes, and `inputsHash`; once a scorecard cell pins the resulting KEYS hash, the torn inputs are immutable by design. The manifest already records per-file `sha256` precisely for this. Related: `outcomeRecapForDay` scans all object names, so it reads recaps out of uncommitted (manifest-deleted) folders, violating the spec's own "day existence = committed manifest" principle.
- **Fix:** `loadDay` re-reads the manifest and verifies each artifact's sha256 against its `FileRecord`; mismatch/missing → throw into the per-day skip path. Restrict `outcomeRecapForDay` to manifest-committed folders.
- **Status:** applied (v2 rewrite)

### 6. General/methods storage paths defined in two modules — writer and reader can silently drift
- **Doc:** Plan Task 2 Step 3 (`generalPrefix`/`methodsPath` in `cloud-inputs.service.ts`) vs Task 6 Step 3 (`GENERAL_PREFIX`/`METHODS_PATH` in `content.service.ts`).
- **Failure scenario:** The spec celebrates eminiplayer-validation as "the single home of the storage contract so writer and reader can never drift apart" — then the plan introduces the exact anti-pattern for the two new paths. If either copy is edited later, `PUT` writes where the benchmark never reads; drift reports clean; every future run silently benchmarks stale docs.
- **Fix:** Export `GENERAL_PREFIX`, `generalDocPath(name)`, `METHODS_PATH` from one module (e.g. `cloud-inputs.service.ts`, which `content.service.ts` already imports collection constants from) and use them in both.
- **Status:** applied (v2 rewrite)

### 7. Concurrent `POST /benchmark/run` can orphan a submitted batch's pinned KEYS hash — a permanent per-day wedge
- **Doc:** Neither doc; the migration widens a pre-existing race from milliseconds (sync fs) to minutes (cloud I/O + per-day LLM chains).
- **Failure scenario:** Two concurrent runs both pass the guard, both compute the same missing indices, both reach `ensureKeys` for the same day; `saveKeysArtifact` is last-write-wins. Run A submits a batch pinning hash Hₐ; run B overwrites the artifact with H_b; when A reconciles, its cells' `artifactSha256` matches no stored doc — the exact "orphaned-pin anomaly" `ensureKeys` answers by refusing to ever generate for that day again without manual intervention. Duplicate run indices also waste real batch spend.
- **Fix:** Make `run()` single-flight (per-process mutex or Firestore lease) returning 409 "a run is already in progress" — consistent with `BatchReconciler.reconcile()`'s existing single-flight guard. Document it.
- **Status:** applied (v2 rewrite)

### 8. Firestore stored schema drifts from the spec's documented layout (undeclared third deviation)
- **Doc:** Spec §Storage layout (traders store `origin`/`mutation`; features store `name`/`block`/`artifactSuffix`) vs Plan Task 6 (stores `{name|id, content, (staticDocContent,) sha256, createdAt}`, derives the rest at read time).
- **Failure scenario:** Anything later built against the approved spec — a console query for the family tree (`traders where origin == ...`), an index, a security rule — finds the fields absent, returns empty with no error. Same drift for `POST /traders` body (`{name, content}` vs `{content}`).
- **Fix:** Amend the spec to the plan's content-as-canonical shape (the better design) and declare it in the plan's Self-review notes; or store the derived fields too.
- **Status:** applied (v2 rewrite)

### 9. `GET /knowledge/general` contract: `sha256` promised in three places, absent in the implementation
- **Doc:** Spec endpoint table + Plan Task 6 Interfaces block vs Task 6 Step 3 `listGeneral()` (returns `{path}` only, never downloads).
- **Failure scenario:** The listing's stated purpose is verifying uploaded content by hash; a consumer reads `undefined` and either crashes or "verifies" nothing. No test asserts sha256, so it ships silently short.
- **Fix:** Download-and-hash in `listGeneral()` and assert `sha256` in the service spec; or amend all three contract statements to path-only.
- **Status:** applied (v2 rewrite)

### 10. Task 5's fake-idiom instruction omits `loadDay` and the fixture split — stalls the implementer
- **Doc:** Plan Task 5 Step 1 ("same idiom as Task 4: each `collect*` method a `jest.fn`").
- **Failure scenario:** The migrated `run()` calls `inputs.loadDay(day)` — not a `collect*` method; the existing `benchmark.service.spec.ts` fake has no `loadDay`, and its `collectDays` fixtures carry old path fields with no `recapDate`. A literal implementer converts the five `collect*` mocks and hits `this.inputs.loadDay is not a function` across the suite with no guidance.
- **Fix:** Spell out the new fake: `collectDays: jest.fn(async () => [<DayListing with recapDate>])`, `loadDay: jest.fn(async (l) => ({ ...l, pdf: Buffer.from('PDF'), tpTranscript: 'PLAN', recapTranscript: 'RECAP', recapFileName: '06302026_ES_RECAP.md' }))`.
- **Status:** applied (v2 rewrite)

### 11. Spec's hashing sentence contradicts its own byte-for-byte goal
- **Doc:** Spec §CloudInputsService: "persona `content` sha256, feature `block` sha256". Actual scheme (and the plan's Global Constraints, and today's code): full markdown for both.
- **Failure scenario:** A reviewer reconciling plan against approved spec "corrects" Task 1 to hash `extractBlock(content)` → every feature hash changes → the Task 8 gate fails / all runs 409.
- **Fix:** Amend to "feature `content` sha256 (full markdown, frontmatter included)".
- **Status:** applied (v2 rewrite)

### 12. Bucket day-doc byte-equivalence with the deleted local files is asserted, not verified
- **Doc:** Spec §Drift guard, day docs: "keeps working since hashes cover the same bytes."
- **Failure scenario:** Existing KEYS artifacts' `inputsHash` came from local files; post-migration bytes come from bucket objects written by the eminiplayer pipeline — nothing establishes byte-identity. Any difference → `ensureKeys` sees `inputsHash` drift on every non-pinned day → silent flagship-model regeneration spend and replaced KEYS artifacts on the first post-migration run (pinned days are immune).
- **Fix:** Soften the spec claim and state the expected behavior: non-pinned days MAY regenerate once post-migration (accepted cost), or add a verification step comparing a sample day's bucket bytes against `git show` before the first run.
- **Status:** applied (v2 rewrite)

### 13. Task 7's seedCloud has three unstated prerequisites
- **Doc:** Plan Task 7 Step 2.
- **Failure scenario:** (a) Both suites construct fakes inline (`.overrideProvider(STORAGE_BUCKET).useValue(fakeBucket())`) — the instance is never held, so `seedCloud(db, bucket)` requires restructuring `boot()` the plan doesn't spell out. (b) The instruction says "keep the same content strings" but the snippet changes the persona content (adds lineage lines) — contradictory guidance. (c) `benchmark.e2e-spec.ts:300` calls `collectGeneralDocs().sha256` synchronously; it must become `(await ...).sha256` — compile failure until found.
- **Fix:** Show the boot restructuring (hold `const db = fakeFirestore(); const bucket = fakeBucket();` before override); use the suite's existing persona string (root persona — no lineage needed once Finding 1's fix lands); call out the await at line ~300.
- **Status:** applied (v2 rewrite)

## Low

### 14. `scanDays` hand-builds the manifest regex, violating the plan's own Global Constraint
- **Doc:** Plan Task 2 Step 3 (`/^knowledge-base\/es\/(\d{8})\/manifest\.json$/`); `manifestPath` is imported on paper but never called.
- **Failure scenario:** `ES_STORAGE_PREFIX` changes → `getFiles` prefix follows, regex matches nothing → empty corpus, clean empty run summary, no error.
- **Fix:** Build the matcher from `ES_STORAGE_PREFIX`/`manifestPath`.
- **Status:** applied (v2 rewrite)

### 15. Task 8 mixes `HEAD~1` and `HEAD`
- **Doc:** Plan Task 8 Step 2 (`HEAD~1`) vs Step 3 (`HEAD`) vs its own note ("HEAD itself should work"). Both resolve today, but the methods doc read at `HEAD~1` for `staticDocContent` and at `HEAD` for the bucket PUT could diverge.
- **Fix:** `HEAD:` everywhere.
- **Status:** applied (v2 rewrite)

### 16. `curl -sf` swallows every failure body — the amplifier for both Criticals
- **Doc:** Plan Task 8, all commands.
- **Failure scenario:** A 400/409/503 prints nothing; the operator scrolls past a failed import.
- **Fix:** `curl -sS --fail-with-body` and chain steps with `&&`.
- **Status:** applied (v2 rewrite)

### 17. "Remove the `resolve`/path import if now unused" — it is used
- **Doc:** Plan Task 5 Step 6. `configuration.ts` uses `resolve` for `eminiplayer.screenshotDir`; the hedge saves it but the implied expectation is wrong.
- **Fix:** Say the import stays.
- **Status:** applied (v2 rewrite)

### 18. Malformed Firestore doc (missing `name`) throws TypeError before validation
- **Doc:** Plan Tasks 1/6 — `sort((a,b) => a.name.localeCompare(...))` runs before any shape check; an out-of-band write without `name` yields an unhelpful 503 instead of a named finding — the exact scenario the recomputed-sha comment defends against.
- **Fix:** Filter/flag docs missing `name`/`content` before sorting.
- **Status:** applied (v2 rewrite)

### 19. Fail-closed 503 claim overstates its scope
- **Doc:** Plan Task 1 `wrap` comment ("must abort before anything is uploaded or submitted") vs Task 5 placing `loadDay` inside `run()`'s per-day try — a bucket outage after day 1's batch submits becomes a `daysSkipped` entry, not a 503. No regression vs today, but the comment should scope the promise to the up-front collects.
- **Fix:** Reword the comment.
- **Status:** applied (v2 rewrite)

### 20. `PUT /knowledge/*` body: spec says raw markdown, plan implements JSON `{content}`
- **Doc:** Spec §Write endpoints (`body: markdown`) vs Plan Task 6.
- **Fix:** Amend the spec table to `body: { content }`.
- **Status:** applied (v2 rewrite)

---

## Verified clean (for the record)

Every line citation the plan makes was confirmed accurate against the repo (`checkDrift` at 75, `assembleDay` at 303, `computeInputsHash` at 278, cache-warmer 53–55, scoreboard 18–19); `dayPaths`/`manifestPath`/`ES_STORAGE_PREFIX` exist with the exact property names used; the `\x00` inputsHash scheme matches byte-for-byte; `fake-firestore.ts` supports `set()`/write-once `create()` with `{code: 6}`; both e2e fakeBuckets hold Buffers as Task 7 assumes; Nest exports both exception classes; firebase-admin `create()` rejects ALREADY_EXISTS with gRPC code 6; all four Task 8 files are retrievable at `HEAD:`; `knowledge-base/general/` holds exactly one tracked file so the concatenation hash reproduces; no forward references or name drift across the plan's nine tasks; the two declared deviations were honored as pre-approved.
