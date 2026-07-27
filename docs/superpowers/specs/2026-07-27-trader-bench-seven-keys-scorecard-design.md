# Seven-Keys Generation + Scorecard Variant (Backend Port — Plan 2)

**Date:** 2026-07-27
**Status:** Design approved, ready for implementation planning
**Builds on:** `2026-07-26-trader-bench-backend-port-design.md` (core pipeline, merged to
`main`). This spec extracts and expands §6 ("Seven-keys generation") of that document into
a standalone design, and adds the `seven-keys-scorecard` variant that consumes the
generated artifact.

**Goal:** Port the four-agent seven-keys generation workflow (today a Claude Code skill)
into the NestJS backend as a sequential Anthropic-API chain on **Fable**, storing the
verified KEYS scorecard in Firestore, and wire the `seven-keys-scorecard` benchmark
variant to consume it — so the benchmark can measure the marginal value of precomputed
zone grading (`Δ(scorecard) − Δ(method)`).

---

## 1. Scope

**In scope**
- `SevenKeysModule` / `SevenKeysService.generate(day)` — the four-agent chain
  (current-day analyst ∥ outcome-aware lookback → synthesizer → verifier), producing the
  verified KEYS markdown, stored in Firestore.
- The `seven-keys-scorecard` benchmark variant: feature block + methodology doc + the
  generated KEYS artifact (`${DOC}` + `${ARTIFACT}`) injected into the existing feature
  tier.
- **Auto-generation on `POST /benchmark/run`**: before batching any scorecard cells, the
  run generates any missing per-day KEYS artifact (days walked oldest-first for the
  lookback dependency), idempotently.
- Provenance: `artifactSha256` threaded onto scorecard cells (extends `CellMeta`).

**Out of scope (deferred)**
- Feature **combos** (`combines`, namespaced `${DOC:id}` / `${ARTIFACT:id}`, combo
  scoreboard impact) — a later plan.
- A committed-to-git KEYS file / the `/seven-keys` skill workflow (replaced by the
  backend service; the skill remains for manual use).
- A standalone regeneration endpoint (generation is auto-on-run only; a
  `POST /benchmark/seven-keys` endpoint can be a later addition).

---

## 2. Background — how seven-keys works today (source of truth)

The workflow produces ONE shared per-day scorecard grading the trade plan's zones on
**Keys 3–7** (Keys 1–2 are trader-behavior/expectancy, deliberately excluded — they stay
with the personas). It runs four agents `current-day ∥ lookback → synthesize → verify`
and writes `<prefix>_ES_KEYS.md` **only after the verifier passes**.

**The four agents** (each has a JSON output schema in the existing skill script):

1. **Current-day analyst** — pinned to **`claude-fable-5`** (a blind comparison found it
   more methodology-faithful/better-calibrated than Sonnet for grading). Reads: all
   `knowledge-base/general/` docs, the day's three docs (TP PDF, TP transcript, prior
   RECAP), and the methodology doc `knowledge-base/methods/seven-keys.md`. Produces
   (`CURRENT_SCHEMA`): `bias`, `environment`, and `zones[]` where each zone has `prices`,
   `side` (support|resistance), `key3`…`key7` rationale strings, and `grade` ∈
   {automatic-fade, strong, moderate, weak}. Copies prices EXACTLY. This is the
   authoritative source.
2. **Outcome-aware lookback analyst** (`LOOKBACK_SCHEMA`) — SKIPPED on bootstrap (no prior
   KEYS). Reads up to three prior days' `*_ES_KEYS.md`, each paired with that day's
   outcome recap. Produces `calibration[]` (`{day, verdict}` — did the highly-graded zones
   hold?) and `continuity[]` (recurring zones / bias evolution). **Strictly advisory —
   "today's analyst outranks you."**
3. **Synthesizer** (`SYNTH_SCHEMA`) — reads no files; takes the two agents' JSON inline.
   Produces the KEYS markdown body. Current-day is authoritative; lookback may sharpen
   wording / add calibration history but must NEVER change a zone's prices, add/drop
   zones, or override a grade unless current-day evidence is itself ambiguous.
4. **Verifier** (`VERIFY_SCHEMA`) — reads the two trade-plan docs + the synthesized
   artifact. Produces `{pass, mismatches[]}`. **Fidelity-only**: every scorecard row's
   `prices`+`side` must match a zone actually in the trade plan (no invented / dropped /
   transposed / rounded prices). Does NOT judge grades/bias/wording. A failure aborts the
   write.

**Grade-discrimination rule:** grades must discriminate at the top — `strong` +
`automatic-fade` together are only the few priority zones (**≤ ~1/3 of the sheet**);
`moderate` is a deliberate middle call, not a default; many distant zones collapse to
`weak`. **Elevated grades are capped by same-day reachability**: a zone with excellent
larger-timeframe pedigree that sits beyond a plausible single-session move is capped at
`moderate` (pedigree recorded in the key4/key5 cells, not the grade).

**KEYS artifact format** (markdown; frontmatter `generatedBy` [always `claude-fable-5`],
`generatedAt`, `lookbackSources[]` [oldest-first, or `[]`], `verified`):
`# Seven Keys — ES <date>`, bias/environment notes, `## Zone scorecard (Keys 3–7)`
(8-column table, one row per zone), `## Automatic-fade candidates`, `## Lookback`.

**Lookback / outcome mechanism:**
- Lookback set = the up-to-3 most recent **complete** day folders strictly before the
  target date (chronological by the 8-digit TP-prefix re-keyed `YYYYMMDD`) that already
  have a `*_ES_KEYS.md`. Zero → bootstrap. Ordered oldest-first.
- For each lookback day P, the outcome recap is literally `<P>_ES_RECAP.md` (recaps are
  named for the session they describe and physically sit in the *next* day's folder). No
  such recap → `outcome: null`.

**Feature definitions:**
- `features/seven-keys-scorecard.md`: `id`, `name`, `staticDoc:
  knowledge-base/methods/seven-keys.md`, `artifactSuffix: _ES_KEYS.md`,
  `generatorSkill: seven-keys`. Body uses BOTH `${DOC}` (methodology) and `${ARTIFACT}`
  (the day's KEYS): "adopt its per-zone key scores rather than re-deriving them; apply
  your persona's style to choose among the zones it grades."
- `features/seven-keys-method.md`: `staticDoc` only, no artifact (already supported by the
  core pipeline).

---

## 3. Architecture (additions to the merged core pipeline)

### New: `SevenKeysModule`

- `SevenKeysService.generate(day: DayInput): Promise<KeysArtifact>` — runs the four-agent
  chain on **Fable** and returns the verified KEYS markdown + provenance; throws /
  signals `verified:false` without persisting on verifier failure.
- Internal schemas `CURRENT_SCHEMA`, `LOOKBACK_SCHEMA`, `SYNTH_SCHEMA`, `VERIFY_SCHEMA`
  (ported from the skill script), used as structured-output formats.
- `SevenKeysService.ensureKeys(day): Promise<DayArtifactDoc | null>` — idempotent
  wrapper: returns the stored KEYS (matching content inputs) if present; else generates,
  verifies, and persists; returns null (and logs) if the verifier fails so the caller
  skips the scorecard variant for that day.

### Reused / extended

- **`AnthropicService`** — add a **structured single-message** call, e.g.
  `messageStructured(input, opts?: { model?; outputSchema?; context?: CachedContext;
  files?; effort? })`, returning parsed JSON. The four agents are sequential/parallel
  single calls (NOT a batch), each with its schema; current-day + verifier carry the PDF
  (Files beta path, `files-api-2025-04-14`) and may share a cached day-docs prefix
  (best-effort — the shared cacheable content is general docs + methods + the day's docs).
- **`DayArtifactsService`** — the KEYS artifact is stored via the existing
  `dayArtifacts/{day}__keys` (`DayArtifactKind` already includes `'keys'`;
  `DayArtifactDoc.content` holds the markdown, `contentHash` the sha256). Add a
  `getKeys(day)` / `saveKeys(day, doc)` convenience (or reuse `getDayArtifact`/
  `saveDayArtifact` with kind `'keys'`). Provenance frontmatter fields
  (`generatedBy`/`generatedAt`/`lookbackSources`/`verified`) stored alongside.
- **`RepoInputsService.collectFeatures`** — extend to read `artifactSuffix` (already reads
  `id`/`name`/`staticDoc`/`block`). This makes the scorecard feature discoverable with its
  artifact binding. (No `generatorSkill` handling needed — generation is backend-owned.)
- **`RepoInputsService`** — add lookback helpers: given a target day, return the up-to-3
  prior complete days that have a KEYS artifact (querying Firestore via the repository for
  which days have `__keys`), and resolve each prior day's outcome recap path
  (`<P>_ES_RECAP.md` in the next day's folder). Cross-day discovery already exists
  (`collectDays` is chronological).
- **`EnvelopeBuilder`** — the scorecard variant substitutes BOTH `${DOC}` (methods) and
  `${ARTIFACT}` (KEYS content) into the feature block; the artifact text goes INTO the
  existing feature tier (no new breakpoint — still ≤4 tiers). `fullEnvelope` gains an
  optional `artifact` input; when the variant needs an artifact and it's absent, the
  existing empty-feature-tier guard applies.
- **`benchmark.types`** — add `artifactSha256?` to `CellMeta` and `BenchmarkCell` (the
  scorecard cell's provenance). `CORE_VARIANTS` gains `'seven-keys-scorecard'` (or a new
  `VARIANTS` constant; keep base + method + scorecard).
- **`BenchmarkService.run`** — when the scorecard variant is in the requested set:
  discover the scorecard feature; walk the target days **oldest-first**; for each day that
  has missing scorecard cells, call `SevenKeysService.ensureKeys(day)` BEFORE assembling/
  batching; if it returns null (verifier failed) skip the scorecard variant for that day
  (`daysSkipped` reason `keys generation failed`); otherwise build the scorecard envelope
  with the KEYS content and thread `artifactSha256` into `CellMeta`.
- **`BatchReconciler.buildCell`** — persist `artifactSha256` from the threaded `CellMeta`
  for scorecard cells (base/method unchanged).
- **`ScoreboardService`** — the vendored `computeFeatureImpact` already compares
  base-vs-feature over shared day sets; with the scorecard variant now producing cells,
  it will surface `Δ(scorecard)` alongside `Δ(method)` automatically (no change needed
  beyond cells existing). Confirm the vendored function handles three variants cleanly.

### Immutability

The KEYS artifact is **frozen once benchmarked**: if any `seven-keys-scorecard` cell
exists for a day, `ensureKeys` must NOT regenerate — it reuses the stored KEYS (matching
the recorded content hash). This mirrors the skill's benchmark-immutability guard
(previously keyed on `runs/*.json` `keysSha256`; here keyed on the presence of scorecard
cells + the stored `dayArtifacts/{day}__keys` hash). Regeneration only happens for a day
with no scorecard cells yet.

---

## 4. Runtime flow (scorecard variant)

`POST /benchmark/run {model=fable, variants:['seven-keys-scorecard', ...], days?, runCount?}`:

1. Discover traders/features/days; identify the scorecard feature (`artifactSuffix`).
2. Compute top-up per (trader, model, day, `seven-keys-scorecard`) — same diff as core
   (persisted cells + in-flight exclusion).
3. **Walk days oldest-first.** For each day with missing scorecard cells:
   a. `SevenKeysService.ensureKeys(day)`:
      - If `dayArtifacts/{day}__keys` exists (and — when scorecard cells exist — is frozen)
        → reuse.
      - Else run the chain: build the lookback set (prior days with KEYS + their recaps);
        current-day (Fable, day docs + methods + general) ∥ lookback (Fable, prior KEYS +
        recaps) → synthesize (Fable) → verify (Fable, TP docs + artifact). On `pass` →
        store `{content, contentHash, generatedBy, generatedAt, lookbackSources, verified}`
        in `dayArtifacts/{day}__keys`. On fail → don't store; return null.
      - Oldest-first ordering guarantees a day's lookback set (prior days' KEYS) is
        already generated before it's needed.
   b. If null → record the day in `daysSkipped` (reason `keys generation failed`) and skip
      the scorecard variant for that day.
   c. Else build the scorecard envelope (feature tier = feature block with `${DOC}` methods
      + `${ARTIFACT}` KEYS content) and include `artifactSha256` in the cell's `CellMeta`.
4. Warm + batch + reconcile exactly as the core pipeline (the scorecard cells ride the same
   per-day batch as base/method cells).

Cost note: seven-keys generation is 4 sync Fable calls per day (not batched — the stages
have data dependencies), incurred ONCE per day (frozen thereafter). This is generation
overhead, separate from the batched, cached trade-decision inference.

---

## 5. Edge cases

- **Bootstrap day (no prior KEYS):** lookback agent skipped; synthesizer marks lookback
  "none — bootstrap"; artifact still produced/verified.
- **Verifier fails:** no KEYS stored; scorecard variant skipped for that day (`daysSkipped`);
  a later run retries generation.
- **KEYS already benchmarked (scorecard cells exist):** frozen — reused, never regenerated.
- **Incomplete-RTH / missing-candles day:** the core pipeline already skips these before
  batching; seven-keys generation should also be gated to days that will actually batch
  (don't spend generation calls on a day that will be skipped for candles) — compute the
  candle/coverage skip BEFORE `ensureKeys`.
- **Missing methods doc / day docs:** abort generation for that day with a clear reason.
- **Generation itself refused (Fable refusal on an agent):** treat as generation failure →
  skip scorecard for the day (log), retry next run.

---

## 6. Testing

- `SevenKeysService` spec (mocked SDK): the four-stage chain wiring (current-day pinned
  Fable, lookback skipped on bootstrap, synth/verify sequencing), verifier-fail → no
  persist + null, verifier-pass → persisted artifact with provenance, idempotent reuse,
  frozen-when-benchmarked guard, oldest-first lookback assembly.
- `RepoInputsService` spec: `collectFeatures` reads `artifactSuffix`; lookback-set +
  outcome-recap resolution.
- `EnvelopeBuilder` spec: scorecard variant substitutes `${DOC}` + `${ARTIFACT}` into the
  feature tier; still ≤4 tiers; missing artifact for a non-base artifact-variant throws
  (guard).
- `BenchmarkService` spec: scorecard variant triggers `ensureKeys` oldest-first before
  batching; skips the day on generation failure; threads `artifactSha256`.
- `BatchReconciler` spec: scorecard cell persists `artifactSha256`.
- e2e: extend the benchmark e2e with a `seven-keys-scorecard` run over a fixture day with
  a mocked seven-keys chain → KEYS stored → scorecard cell persisted → scoreboard shows a
  scorecard group + a feature-impact delta.

---

## 7. Prerequisites & assumptions

- Core pipeline (Plan 1) merged to `main` (done).
- `knowledge-base/methods/seven-keys.md` present; scorecard feature file with
  `artifactSuffix: _ES_KEYS.md` present.
- Generation model is **Fable** for all four agents (current-day explicitly pinned;
  matches the `/seven-keys` model preference). Fable requires 30-day data retention.
- The four output schemas are ported faithfully from the existing skill script so the KEYS
  content is equivalent to the skill's.

---

## 8. Out of scope (this iteration)

- Feature combos / composite features (`combines`, `${DOC:id}`, `${ARTIFACT:id}`).
- A standalone `POST /benchmark/seven-keys` regeneration endpoint (auto-on-run only).
- Regenerating/backfilling KEYS for days already benchmarked (frozen by design).
