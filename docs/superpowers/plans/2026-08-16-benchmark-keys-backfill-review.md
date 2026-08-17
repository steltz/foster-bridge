# Review — Benchmark KEYS Backfill spec & plan

Date: 2026-08-16
Reviewed: `docs/superpowers/specs/2026-08-16-benchmark-keys-backfill-design.md`
and `docs/superpowers/plans/2026-08-16-benchmark-keys-backfill.md`
Method: four blind adversarial lenses (spec-plan consistency, internal plan
correctness, architecture soundness, codebase grounding), findings deduplicated
and re-scored against the shared severity rubric. Feature is **not yet built** —
none of the files the plan creates exist, so this measures bug risk baked into
the instructions.

## Scores

**Spec: 1/10** (raw deductions ≈ 17, clamped at 1)
**Plan: 1/10** (raw deductions ≈ 31, clamped at 1)

Both floor. The clamp hides a real difference — the plan carries roughly twice
the deduction — so read the raw totals, not the clamped scores.

**What the scores do not mean.** The architecture is sound: the shared lock, the
stop-on-failure invariant, artifacts-as-durable-state, and the era-reset
ordering constraint are all correct and well-motivated. Every finding below is a
surgical fix, not a redesign. The scores are low because this plan authorizes an
irreversible, unattended, ~$130 / 20-40 hour operation against production data,
and the rubric weights baked-in risk accordingly. Two defects would silently
produce a corpus just as degraded as the one being replaced; two more can
permanently wedge days; one prevents the app from booting.

**Headline:** the spec asserts a property of `ensureKeys` that the code does not
have, and the plan's reuse rule reintroduces the exact defect the whole project
exists to eliminate. Both were verified directly against source.

---

## Critical

### 1. `ensureKeys` never throws — the failure ledger is blank on every real failure
**Docs:** spec §2 "Failure policy"; plan Tasks 2 & 5
**Verified:** `seven-keys.service.ts`

The spec states *"`ensureKeys` returns `null` on a verifier failure and **throws
on infrastructure errors**."* The second half is false:

```ts
let result: KeysArtifact;
try {
  result = await this.generate(day, snap);
} catch (err) {
  this.logger.error(`Seven-keys generation failed for ${day.day}: ${(err as Error).message}`);
  return null;
}
```

`generate()` contains the methods-doc check, `ensureFileId`, and all four LLM
calls. Every one of those failures returns `null`, indistinguishable from a
verifier rejection. The in-flight-pin and orphaned-pin refusals also return
`null`.

**Failure scenario:** the job dies at hour 20 on a provider 429 storm. `runDay`
sees `doc === null` three times with an empty `mismatches` array and records
`kind: 'unverified'`, `mismatches: []`, `message: "verifier rejected the
artifact: no mismatch detail"`. Task 9's operational note tells the operator to
read `failures[0]` for verifier mismatches, so they debug a verifier that never
ran. Task 5's test `classifies a thrown error as kind "error"` passes green
because the *fake* rejects — certifying behavior the real collaborator cannot
produce.

**Fix:** replace the `onUnverified` seam with
`onFailure?: (f: { kind: 'unverified' | 'error' | 'refused'; message: string; mismatches: string[] }) => void`,
invoked from the `catch`, the `!result.verified` branch, and both anomaly
`return null` sites. Correct the spec sentence. Treat `refused` as fail-fast (see
finding 18).

### 2. The reuse pre-check locks in reduced-lookback artifacts — defeating the project's purpose
**Docs:** spec "Day loop" step 4; plan Task 4 `runDay`
**Verified:** `seven-keys.service.ts`

`saveKeysArtifact` writes `verified: true` **even when `lookbackMissing` is
non-empty** — it logs a warning and stores the doc anyway. The reuse rule tests
`existing?.verified` alone, so every degraded artifact is skipped and frozen.

**Failure scenario:** operator runs the era reset, starts the backfill, cancels
at hour 12 to run a quick sampled `POST /benchmark/run` (which generates
bootstrap-quality keys for scattered sampled days), then resumes. The backfill
reuses all of them, reports `done`, `failed: 0`, and the corpus is exactly as
degraded as before — the precise condition the spec's Problem section exists to
eliminate, with nothing in the snapshot recording it. This is the same defect as
the four known-degraded days (`01062025`, `0803`–`08052026`), reintroduced by
the tool built to fix them.

**Fix:** reuse only when `existing.verified && !(existing.lookbackMissing?.length)`.
Add `reducedLookback: Array<{ day: string; missing: string[] }>` to the snapshot,
populated from each generated doc, and surface it in Task 9. Add a test: *a
stored verified artifact with non-empty `lookbackMissing` is regenerated, not
reused.* Do **not** fail-stop on it — the first 3 days of a cold build are
legitimately reduced — but it must be visible.

### 3. `KeysBackfillService` is never exported from `BenchmarkModule` — the app will not boot
**Doc:** plan Task 7 Step 5
**Verified:** `app.module.ts`, `benchmark.module.ts`

`BenchmarkController` is registered in `app.module.ts`, **not** in
`BenchmarkModule`. Its deps resolve only because `BenchmarkModule` *exports*
them. Step 5 adds `KeysBackfillService` to `providers` only.

**Failure scenario:** `npx jest` passes in Step 6 (both controller specs build
their own testing module), then `pnpm start` dies at bootstrap: *"Nest can't
resolve dependencies of the BenchmarkController … argument KeysBackfillService
at index [5] is available in the AppModule context."* Discovered at launch of a
40-hour job. Task 1 correctly remembered `exports` for `BenchmarkRunLock`, so
this is an inconsistency, not a policy.

**Fix:** add `KeysBackfillService` to `exports` as well as `providers`.

### 4. The era-reset script omits the non-terminal-batch guard — the reconciler re-creates the deleted pins within 60 seconds
**Docs:** spec §4 (requires it); plan Task 8 Step 5 (omits it)
**Verified:** `batch-reconciler.ts`, `configuration.ts`, `benchmark.repository.ts`

The spec requires the script to *"Refuse to run while the lock is held or any
non-terminal batch exists."* The script implements neither. The scheduler is
**on by default** (`BENCHMARK_SCHEDULER !== 'false'`) and will be running on the
same one-shot server for all 40 hours.

**Failure scenario:** `--apply` runs while a batch is submitted-but-unreconciled.
The script deletes the cells and artifacts and exits 0. Within a minute
`BatchReconciler` drains that batch and calls `createCell` from
`customIdToCell`, re-writing `artifactSha256: <deleted hash>`. Those pins now
match no stored artifact, so `ensureKeys`'s orphaned-pin guard refuses
**forever**. The backfill burns 3 attempts per day and stops. This is the exact
permanent wedge §4 was written to prevent, produced by the prerequisite script.

**Fix:** query `benchmarkBatches where status in NON_TERMINAL` and abort
non-zero if any exist — cross-process observable, unlike the in-memory lock.
Additionally strip `artifactSha256` from any surviving `customIdToCell`, or mark
those batches terminal, so a later reconcile cannot resurrect pins. Amend the
spec: the "lock is held" half is **unimplementable** from a separate process.

---

## High

### 5. Task 2's tests are written against a `build()` helper that does not exist
**Doc:** plan Task 2 Step 1 · **Verified:** `seven-keys.service.spec.ts`

Real helper: `async function build(deps: ReturnType<typeof makeDeps>, configOverrides = {})`
returning the service *bare*. The plan calls `build()` with no args, doesn't
`await`, destructures `{ service, day, snap }`, and passes a `verify: { pass:
false }` override that does not exist (verifier outcomes are driven by queueing
responses onto `FakeLlmProvider`). Independently, `expect(service.lineageAlias).toBe('k3')`
**fails even once fixed**: the default config supplies only `benchmark.effort`,
so `flagship` falls back to `claude-fable-5` and the alias is `'fable'`.

**Fix:** rewrite against `makeDeps()` + `await build(deps, { 'benchmark.model': 'kimi-k3' })`,
drive the verifier failure via `jest.spyOn(svc, 'generate')`, and use the file's
module-level `DAY`/`SNAP` constants.

### 6. Task 3's test destructures the wrong key from an un-awaited async helper
**Doc:** plan Task 3 Step 1 · **Verified:** `day-artifacts.service.spec.ts`

Real helper is `async function build(provider?)` returning `{ svc, bucket, upload, repo }`.
The plan writes `const { service } = build();` — un-awaited, wrong key — so
`service` is `undefined` and `jest.spyOn(undefined, 'ensurePdf')` throws
`Cannot use spyOn on a primitive value`. Step 2's stated expected failure never
appears, so the TDD gate is meaningless.

**Fix:** `const { svc } = await build();` and rename references.

### 7. The claim that existing specs construct their subjects directly is false
**Doc:** plan Task 1 Step 7, Task 7 Step 1, and the Self-Review note
**Verified:** `benchmark.service.spec.ts`, `benchmark.controller.spec.ts`

Both use `Test.createTestingModule({ providers: [...] }).compile()`. There is no
`new BenchmarkService(` anywhere in the repo.

**Failure scenario:** the implementer searches for the constructor call, finds
nothing, concludes there's nothing to do, and adding the ctor param makes
`.compile()` throw for **all 215** tests in `src/benchmark` — including the
"already in progress" assertion the plan promises will pass unchanged.

**Fix:** Task 1 → add `BenchmarkRunLock` (the real class, so `heldBy` behaves) to
`benchmark.service.spec.ts`'s `build()` providers. Task 7 → add
`{ provide: KeysBackfillService, useValue: { start: jest.fn(), status: () => null, cancel: () => null } }`
to `benchmark.controller.spec.ts`'s providers. Correct the self-review note.

### 8. Task 6's progress test cannot pass against Task 6's own implementation
**Doc:** plan Task 6 Steps 1 & 3

`start()` sets `startedAt: new Date().toISOString()` (real clock ≈ 1.79e12 ms)
while the test mocks only `nowMs` (≈ 1.01e6). So
`elapsedSeconds ≈ -1.79e9`, the `elapsedSeconds <= 0` guard returns early,
`avgSecondsPerDay` stays `null`, and `expect(null).toBeGreaterThan(0)` fails.
Both halves are prescribed verbatim, so the implementer will assume a typo.

**Fix:** route `startedAt` through the seam —
`startedAt: new Date(this.nowMs()).toISOString()` — and initialize the test clock
from `Date.now()`.

### 9. The per-day timeout abandons `ensureKeys` without cancelling it, racing `saveKeysArtifact` against itself
**Doc:** plan Task 5 `withDayTimeout`

`withDayTimeout` rejects the wrapper but the underlying 4-call chain keeps
running; the retry loop immediately starts another for the same day. After two
timeouts, up to **three concurrent `ensureKeys` calls** on one day all reach
`saveKeysArtifact(day, alias, doc)` — last-write-wins, verbatim the hazard
`run-lock.ts`'s own docblock calls *"a permanent per-day wedge."* The design
closes the cross-process race and reopens it inside a single day. The inline
comment (*"a late save is just a stored artifact the next attempt reuses"*) is
also false: the reuse pre-check sits **outside** the retry loop, so nothing
re-reads it.

**Fix:** move the reuse read inside the loop so a late save is genuinely picked
up, and prefer *not* retrying a timeout at all — a 15-minute overrun is not a
transient worth re-racing. Correct the comment.

### 10. The per-day timeout covers only `ensureKeys`, leaving the GCS downloads and provider upload unguarded
**Doc:** plan Task 5 `runDay`; config comment in Task 7

`loadDay` (three GCS downloads) and `ensureDayRecorded` (GCS write + provider
upload) are awaited outside the wrapper, and neither has an internal deadline.
The config comment calls the knob a *"Ceiling for one day's full seven-keys
cycle"* — it isn't.

**Failure scenario:** a hung socket at hour 14 parks the loop inside an await
that never resolves. `state` stays `'running'`, `currentDay` frozen, ETA
unchanged. `DELETE` sets `cancelRequested` but the loop never reaches the check,
so the job never reaches `cancelled` and **never releases the lock** —
`POST /benchmark/run` is 409'd indefinitely and only a restart recovers. The
eminiplayer precedent wraps the whole day for exactly this reason.

**Fix:** wrap the entire attempt body (`loadDay` → `ensureDayRecorded` →
`ensureKeys`) in `withDayTimeout`.

### 11. `planKeysEraReset` deletes cells lineage-blind while deleting artifacts lineage-scoped
**Doc:** plan Task 8 Step 3 · **Verified:** `benchmark.repository.ts`

```ts
const artifactIdsToDelete = artifactIds.filter((id) => id.endsWith(suffix)); // scoped
const cellIdsToDelete = cells.filter((c) => Boolean(c.artifactSha256)).map((c) => c.id); // NOT scoped
```

`artifactSha256` is the KEYS hash for scorecard cells of **any** model. The
plan's own fixture encodes the bug: it includes `07012026__keys__fable`, asserts
that artifact survives, yet deletes every pinning cell.

**Failure scenario:** CLAUDE.md documents per-provider lineages. Running
`KEYS_LINEAGE=k3 … --apply` once a Fable lineage exists irreversibly deletes
every Fable scorecard cell while leaving Fable's artifacts orphaned — and the
post-condition check reports 0 and exits clean. Today the two sets coincide, so
the dry run prints exactly the expected numbers and the divergence stays hidden
until it destroys data.

**Fix:** pass the doomed artifacts' `contentHash` set into `planKeysEraReset` and
select `cells.filter(c => c.artifactSha256 && hashes.has(c.artifactSha256))`. The
current signature receives only ids, so the boundary cannot express the correct
rule.

### 12. `from`/`to` silently manufactures permanently-degraded keys at the window's leading edge
**Doc:** spec "API surface"; plan Task 4 `inWindow`

`POST /benchmark/keys-backfill?from=06012026` begins with zero prior KEYS, so the
window's first three days get bootstrap lookback, are stored `verified: true`,
and — per finding 2 — are reused forever. The convenience parameter manufactures
the exact defect the feature removes, and the safe call (no args) is the
implicit one while the dangerous call is explicit.

**Fix:** resolve the effective start backwards to the first day whose 3 priors
already have KEYS and 400 otherwise (*"days before `from` have no KEYS for
lineage k3"*), or at minimum surface it via finding 2's `reducedLookback` field
and state in both docs that a partial window is not a prefix of a full build.

### 13. The lock excludes eminiplayer ingest/backfill, which mutate the corpus the job is reading
**Doc:** spec §1; plan Task 1 · **Verified:** `cloud-inputs.service.ts`

`POST /eminiplayer/ingest?force=true` and `POST /eminiplayer/backfill` use a
separate guard. The job's `InputsSnapshot` pins `fileSha256` per day, and
`loadDay` throws *"day X changed since the run snapshot"* on mismatch — a
**deterministic** failure, so all 3 attempts fail and the job stops.

**Failure scenario (a):** a legitimate concurrent re-ingest kills a 30-hour run.
**(b):** days committed after the snapshot are invisible for the job's whole
lifetime and it reports `done` on a stale corpus.

**Fix:** bring eminiplayer ingest/backfill under the same lock, or classify a
snapshot-mismatch as a job-level stop with *"corpus changed mid-job — re-POST to
re-snapshot"* rather than a 3-retry day failure. Document the staleness window.

### 14. Retries have no backoff, so any outage longer than seconds kills the job
**Doc:** spec §2; plan Task 5 · **Verified:** `seven-keys.service.ts` `withRetry`

`SevenKeysService.withRetry` already retries 3× back-to-back with no sleep, so
one backfill day is up to **9 immediate provider calls in a couple of seconds**,
then a hard stop. A 60-second rate-limit window at hour 20 of 40 ends the run.
The eminiplayer precedent has both a politeness delay and a 20-consecutive-failure
circuit breaker; this has neither, with a far more aggressive stop policy.

**Fix:** sleep between attempts (e.g. 30s then 3min — negligible against a
7-min/day loop) and consider exempting 429/5xx from the attempt count.

---

## Medium

### 15. The reset script's post-condition check is tautological
**Doc:** plan Task 8 Step 5. It counts cells with *any* `artifactSha256` after
deleting exactly those cells, so it is 0 by construction. "Dangling" means
pinning a hash with no surviving artifact, which requires cross-referencing
`dayArtifacts`; that comparison is never made, and the spec's second
post-condition (zero `__keys__<lineage>` docs) is absent entirely. A partial
batch failure would print `0 (must be 0)` and exit clean.
**Fix:** re-read both collections; assert no surviving `__keys__<lineage>` doc and
that every surviving pin matches a surviving artifact's `contentHash`.

### 16. Legacy unscoped `${day}__keys` docs survive the reset and get reused
**Doc:** plan Task 8; spec §4 · **Verified:** `benchmark.repository.ts`
`getKeysArtifact` falls back to a legacy `${day}__keys` doc when the scoped id is
absent, returning it if `generatedBy` resolves to the requested alias. Such a doc
survives `endsWith('__keys__k3')`, is then seen by the reuse pre-check, counted
`reused`, and never regenerated — the reset silently under-deletes while its
post-condition passes.
**Fix:** match `${day}__keys__${alias}` **or** `${day}__keys` with a matching
`generatedBy`; verify the post-condition as *`getKeysArtifact(day, alias)` returns
null for every corpus day*.

### 17. The reuse pre-check ignores `inputsHash`, diverging from `ensureKeys`
**Docs:** spec "Day loop" step 4; plan Task 4 · **Verified:** `seven-keys.service.ts`
`ensureKeys` reuses on `verified && inputsHash === computeInputsHash(...)`; the
pre-check drops the hash term and short-circuits before `ensureKeys` sees the day.
A day whose trade plan was corrected after its KEYS were built is skipped as
`reused`, and no re-POST can repair it because the job never passes `force`. Also
affects older docs with no `inputsHash` at all.
**Fix:** document the divergence explicitly (the tradeoff is one Firestore read
vs. a bucket download per built day) and fall through when `inputsHash` is absent.

### 18. Deterministic refusals burn three attempts and three PDF uploads
**Doc:** plan Task 5 · The missing-artifact-under-pin and orphaned-pin guards can
never succeed on retry, yet each attempt re-runs `loadDay` and
`ensureDayRecorded` first. Stopping is the right outcome; retrying three times
and reporting "verifier rejected the artifact" is the wrong path.
**Fix:** give the seam a `refused` kind (finding 1) and short-circuit to a job
stop on first occurrence with the refusal's actual text.

### 19. The reuse pre-check sits outside the retry try/catch
**Doc:** plan Task 5 `runDay` · A transient Firestore error on day 180 throws out
of `runDay`, is caught by `runLoop`'s outer catch, and yields `state: 'failed'`,
`failures: []`, `currentDay: null` — no day name, contradicting the `error`
contract ("names the day to investigate") and Task 9's operational text. A
transient read the retry policy exists to absorb kills a 20-hour job.
**Fix:** move the pre-check inside the attempt loop (also fixes finding 9).

### 20. `AppConfig` interface not updated — the build fails
**Doc:** plan Task 7 Step 5 · **Verified:** `configuration.ts` declares an explicit
`AppConfig` interface with `export default (): AppConfig => ({...})`. Adding
`keysBackfillDayTimeoutMs` to the literal without the interface is TS2353,
failing `pnpm build` and every ts-jest suite. `eminiplayer` models this correctly
with `backfillDayTimeoutMs: number;`.
**Fix:** add `keysBackfillDayTimeoutMs: number;` to `AppConfig['benchmark']` in the
same step.

### 21. An empty corpus scan reports success
**Doc:** plan Task 4 `runLoop` · A bucket/prefix/permissions problem returning zero
days yields `state: 'done'`, `candidates: 0`, `from: null` — total scan failure
indistinguishable from success. `EminiplayerBackfillService` added an explicit
drift tripwire for exactly this.
**Fix:** fail the job when `snap.days.length === 0`; distinguish that from an empty
*window*, which may stay `done` with a warning.

### 22. No `methodsDoc` preflight
**Doc:** spec "Components / Day loop" · The spec reasoned carefully about
traders/features but missed that `generate` throws *"Seven-keys methods doc
missing"* when `snap.methodsDoc` is null. A missing methods doc becomes 3 failed
attempts on day 1 with the opaque message from finding 1.
**Fix:** after `snapshot()`, `if (!snap.methodsDoc) throw new Error('methods doc
missing — PUT /knowledge/methods before running the keys backfill')`.

### 23. Task 7's new test block references three unimported symbols
**Doc:** plan Task 7 Step 1 · `BadRequestException`, `LockHeldError`, and
`KeysBackfillService` are used but the spec file imports only
`ConflictException, NotFoundException`. TS2304 fails the whole file, so Step 2's
expected failure never appears.
**Fix:** add the imports explicitly in Step 1.

### 24. The ETA is an order of magnitude wrong on the most common operational case
**Docs:** spec "Snapshot shape" (says *rolling* average); plan Task 6 · The
implementation is cumulative (`elapsed_since_start / processed`) and `remaining`
counts reused days as future work. On a resume — 300 reused days at ~1s, 52 left
at ~7min — `avgSecondsPerDay` reads ~1 and the ETA says "done in a minute" for a
six-hour job. The ETA exists so a 40-hour job is operable; at that error scale it
is worse than `null`.
**Fix:** average over the last N *generated* days only; exclude reused days from
`remaining`.

### 25. Task 9's documentation omits the mandatory era-reset-first sequencing
**Doc:** plan Task 9 vs spec "Operational notes" · The CLAUDE.md block covers
routes, the 3-attempt stop, resume, exclusivity, and cost, but never states the
reset is a prerequisite — and nothing enforces the ordering. A future session
following CLAUDE.md would POST without resetting, and the 11 pinned artifacts
(4 known-degraded) would be silently classified `reused`.
**Fix:** add the sequence line; log a startup warning when any in-range day's
stored artifact carries a non-empty `lookbackMissing`.

### 26. The in-memory lock assumes a single process, which the codebase contradicts
**Doc:** spec §1 · `configuration.ts` exists specifically to split an API instance
(`BENCHMARK_SCHEDULER=false`) from a worker. With two processes, a run on A and a
backfill on B both succeed and race `saveKeysArtifact` — the wedge the lock was
created to prevent, with no 409 anywhere.
**Fix:** state the single-process assumption in both docs, or use a Firestore
lease as the lock of record.

### 27. Unauthenticated `POST`/`DELETE` consequences beyond double-starts
**Doc:** spec "Non-goals" · Not re-litigating the no-token decision — but the
stated mitigation ("the already-running 409 and the shared lock prevent
accidental double-starts") covers neither the *first* accidental start (a bare
`POST` is the shortest thing to type and commits ~$130 / 40 hours) nor `DELETE`,
which the lock does nothing for — a stray curl or an agent following CLAUDE.md's
endpoint list kills a 29-hour run with no confirmation and no record.
**Fix:** require `confirm=true` (or explicit `from`/`to`) on `POST`, and require
echoing the job's `startedAt` on `DELETE`. Both cost the no-token decision nothing.

---

## Low

28. **`isValidMmddyyyy` is lines 29–39, not 29–36** (plan Task 7). Deleting 29–36
    leaves a dangling `parsed.getUTCFullYear() === yyyy && …);}` — a syntax error.
    `parseMmddyyyy` is also already imported at line 27, so the new import must be
    merged, not added. **Fix:** cite `:29-39`; merge the import.
29. **Snapshot `from`/`to` nullability drift** — spec declares `string`, plan
    `string | null`. The plan is right; the spec is the contract a consumer reads,
    and the 202 body genuinely carries `null`. The spec's day-loop also numbers
    `loadDay`/`assembleDay` as steps 2–3 before the step-4 classify, then says 2–3
    are skipped. **Fix:** align the type; reorder the numbering.
30. **The timeout test doesn't assert the behavior it exists to prove** (plan Task
    5). It checks only `state === 'failed'` and `/timeout/i`; an implementation
    that aborts after one timeout passes identically. **Fix:** assert
    `toHaveBeenCalledTimes(3)` and `attempts: 3`; advance timers per attempt.
31. **Task 5's "continues" test uses a single day**, so "continues to the next day"
    is never exercised. **Fix:** add a second day and assert both were seen.
32. **Task 2 Step 3 contradicts its own code** — says "keep the existing log
    wording; only the callback line is new" while changing `result.mismatches` to
    `(result.mismatches ?? [])`. `mismatches` is non-optional, so the `?? []` is
    dead. **Fix:** drop one or the other.
33. **`loopPromise` is never `.catch()`ed** (plan Task 4 `start()`). `runLoop`'s
    `finally` is outside the try, so a throw there becomes an unhandled rejection
    that can take down the process hosting the 40-hour job. **Fix:**
    `.catch((e) => this.logger.error(e))`.
34. **Corpus is manifest days, not benchmarkable days** (spec "Corpus facts").
    `BenchmarkService` skips days with no candles or an incomplete session before
    generating keys; the backfill has no such check, so part of the $130 buys KEYS
    for days that can never be graded. Defensible for lookback continuity, but
    unstated. **Fix:** say so, or split `candidates`.
35. **`ensureDayRecorded`'s contract hides a temporal coupling** (plan Task 3).
    The backfill depends on it purely as a side effect: `generate` calls
    `ensureFileId`, which throws if the record wasn't written first. Nothing in
    either signature expresses the ordering. **Fix:** name it for its contract and
    document the ordering on `ensureKeys`.
36. **CLAUDE.md's "two 409 causes" is now three** (plan Task 9), and
    `BenchmarkService.run` throws `ConflictException(err.message)` without the
    `holder` field the new route includes. **Fix:** update the sentence; thread
    `holder` into both 409 bodies.
37. **`CacheWarmer` also writes the `pdfFile` doc concurrently** — it calls
    `ensureFileId` on a cron for days with non-terminal batches, which may
    re-upload and `saveDayArtifact`. Overlapping with `ensureDayRecorded` on the
    same day is last-write-wins on `providerFileId`; worst case a stale id makes
    the next `generate` fail. Narrow (in-flight batch days only). **Fix:** note it,
    or no-op `CacheWarmer` while `keys-backfill` holds the lock.

---

## Verified correct

Recorded so they are not re-litigated: all cited line numbers
(`benchmark.service.ts:81`, `:97-106`, `:349-356`) are accurate; `ensureKeys` has
exactly two call sites, so the lock covers every writer; `DayListing`,
`DayInput`, `InputsSnapshot`, `PdfArtifact` field names in the plan's fixtures are
exact; `DayArtifactDoc` does carry `verified?: boolean`; `parseMmddyyyy`,
`resolveModel`, and `MODEL_ALIASES` exist as used; jest `rootDir: 'src'` confirmed;
`structuredClone` available on Node v22.18.0; `app.enableShutdownHooks()` is
called in `main.ts`, so Task 6's hooks fire; Firestore's batch cap is 500 so the
400-flush is safe; the `.mjs` → `dist/` import was empirically built and executed
and **works** (commonjs emit, no `"type"` field, `dist/benchmark/*.js` layout);
`@HttpCode(202)` and the 404 wording match existing convention; no route
collision; `npx jest src/benchmark` → 215 passed; the existing 409 assertion is a
`/already in progress/i` regex, satisfied by the new message; `job.from`/`job.to`
assertions in Task 4 are sound; the `cancelRequested && attempt > 1` guard is
correct and the `'cancelled'` path correctly skips both counters; no non-goal is
reintroduced.

---

## Disposition

| # | Severity | Applied? |
|---|---|---|
| 1-4 | Critical | pending |
| 5-14 | High | pending |
| 15-27 | Medium | pending |
| 28-37 | Low | pending |
