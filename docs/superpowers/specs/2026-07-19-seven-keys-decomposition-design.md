# Seven-Keys Decomposition — Design Spec

**Date:** 2026-07-19
**Status:** Approved design, pending implementation
**Extends:** `2026-07-18-bench-feature-matrix-design.md` (the variant/feature
mechanism it builds on is unchanged; this spec adds one feature-format
field, splits the seven-keys feature in two, and closes one guard gap)

## Purpose

The feature-matrix branch shipped with `seven-keys` as its first feature,
intending to answer "does giving personas the Seven-Keys assessment help?"
A final integration review found it does not answer that, because `base` is
not Seven-Keys-free:

- `knowledge-base/general/support_and_resistance_zones.md` contains a full
  `## 3. The Seven Keys` section — 136 of its 197 lines — and every general
  doc is injected into **every** variant, `base` included.
- Three of four personas (`basehit`, `placement`, `rotation`) instruct
  ranking zones by numbered key ("larger timeframe (Key 4), launched a
  significant prior move (Key 5)…"). Only `context-trader` is clean.

So the shipped comparison measured *a shared precomputed scorecard vs. each
persona self-deriving the scores* — a real question, but not the one the
scoreboard's heading claimed.

This spec restructures so the benchmark answers **both** questions
separately, by decomposing one feature into two.

## The decomposition

| Variant | Persona sees | Isolates |
|---|---|---|
| `base` | no zone-grading methodology, no scorecard | the floor |
| `seven-keys-method` | the Seven-Keys methodology document | value of the *framework* |
| `seven-keys-scorecard` | the methodology **and** that day's precomputed, verified scorecard | framework **plus** precomputation |

Each feature is compared against `base` independently — the existing
baseline + one-feature-at-a-time design, no interaction testing, no spec
change to the matrix. Reading the results:

- `Δ(method)` — is the Seven-Keys framework worth teaching at all?
- `Δ(scorecard)` — combined value of framework and shared precomputation.
- `Δ(scorecard) − Δ(method)` — the marginal value of precomputing, derived
  by hand from two rows. This is the number that decides whether the
  four-agent `/seven-keys` generation workflow keeps earning its cost.

`seven-keys-scorecard` deliberately carries the methodology as well as the
artifact. Without it, the subtraction above would be confounded — the two
features would differ in two ways at once rather than one.

Cost: three variants instead of two. At 4 traders × 10 days × N=5 that is
600 cells rather than 400, one time.

## New feature field: `staticDoc` and the `${DOC}` placeholder

Both new features need the same 136-line methodology. Three ways to deliver
it were considered:

1. **Inline it in each feature body.** Rejected. The body is inlined into
   the Phase 2 Workflow script as quoted JavaScript string literals; the
   methodology contains both apostrophes and double quotes (7 lines carry
   `"` — e.g. `"automatic fade zones"`), so no single quoting style works
   and the fallback is backslash escaping — precisely the escape-decoding
   hazard that already broke this script once. It would also duplicate 136
   lines across two files.
2. **A repo-relative path hardcoded in the body.** Rejected — depends on
   the executing agent's working directory, where every other document
   reference in these skills is an absolute path resolved at preflight.
3. **A new frontmatter field, resolved to an absolute path at preflight
   and substituted into the body.** Adopted. It mirrors the existing
   `artifactSuffix` / `${ARTIFACT}` pair exactly, differing only in that
   the document is static rather than generated per day.

Frontmatter:

- `staticDoc` (optional) — a repo-relative path to a document this feature
  injects (e.g. `knowledge-base/methods/seven-keys.md`). Resolved to an
  absolute path at preflight and substituted for `${DOC}` in the body.

Validation extends Guard #0 symmetrically with the artifact rules: a
`staticDoc` requires the body to contain `${DOC}`; a body containing
`${DOC}` requires a `staticDoc`; and the referenced file must exist. A
feature may declare both `staticDoc` and `artifactSuffix` — that is exactly
what `seven-keys-scorecard` does.

## Methodology extraction

`## 3. The Seven Keys` (through the rule before `## 4.`) moves **verbatim**
to a new `knowledge-base/methods/seven-keys.md`. The remaining sections of
`support_and_resistance_zones.md` are renumbered so the document still
reads 1..n, and any cross-reference to the removed section is rewritten to
point at the new file.

`knowledge-base/methods/` is a new directory, deliberately **not** under
`knowledge-base/general/` — the bench and the panel both glob `general/`
recursively, so anything left inside it would continue reaching every
variant and defeat the whole exercise.

## Persona wording

The three personas that name numbered keys are rewritten to be
**conditional**: use a provided zone scorecard when one is present, and
otherwise grade zone quality themselves on the same dimensions described in
whatever methodology they were given. Concretely this means removing the
hardcoded "(Key 4)" / "(Key 5)" citations — which are dangling references
for a `base` run that never sees the numbering — while preserving each
persona's actual selection *behavior*, which is the thing being
benchmarked.

This also resolves an existing tension: today a persona says "rank by
Seven-Keys confluence" while the feature block says "adopt its per-zone key
scores rather than re-deriving them."

Personas are edited **in place** rather than forked into new files. Normally
persona files are immutable, but that guard keys on existing benchmark
cells and `runs/` is empty — this is the one free moment to change them.
Lineage frontmatter (`origin`, `mutation`) is untouched.

## Guard gap: unhashed inputs

Cells record `personaSha256`, `featureSha256`, and `artifactSha256`, but
nothing hashes the general docs — which, before this change, carried the
single largest block of methodology into every run. Editing them silently
changed what every cell saw, with no guard firing and no record in the
data. This spec adds:

- `generalSha256` — over the concatenation of every `knowledge-base/general/`
  file in sorted order, on **every** cell including `base`.
- `staticDocSha256` — over a feature's `staticDoc`, present only when the
  feature declares one.

Both are recorded, and both are compared the same way the existing hashes
are: a mismatch against existing cells aborts, naming the file and both
hashes. Recording alone would be insufficient — an unguarded hash tells you
after the fact that results are incomparable, which is exactly when it is
too late.

## `/trader-panel` impact

The panel is the daily production report and runs the "best known
configuration." It globs `knowledge-base/general/` recursively, so once the
methodology leaves that directory the panel would silently lose it — a
regression in production output disguised as a benchmark refactor.

The panel is therefore updated to inject `knowledge-base/methods/seven-keys.md`
alongside its unconditional keys artifact, preserving today's effective
behavior exactly. This is a deliberate, minimal exception to the previous
spec's "do not change `/trader-panel`" non-goal: that non-goal existed to
keep production stable, and here changing the panel is what *keeps* it
stable. `/trader-spawn` remains untouched.

## Non-goals

- Testing feature interactions. `method` and `scorecard` are each compared
  against `base` only; the marginal value of precomputation is derived by
  subtracting two independent deltas, not by a combined variant.
- Changing what the personas actually *do*. The rewrite removes numbered-key
  citations and adds conditional handling; it must not alter entry style,
  stop/target logic, or selectivity, or the benchmark measures the rewrite
  instead of the feature.
- Preserving the shipped `features/seven-keys.md`. It is replaced by the two
  new files. No cells exist under its id, so nothing is orphaned.

## Testing

- **Feature validation:** `staticDoc` without `${DOC}`, `${DOC}` without
  `staticDoc`, a `staticDoc` pointing at a missing file, and a feature
  declaring both `staticDoc` and `artifactSuffix` (must be accepted).
- **Extraction fidelity:** the moved methodology is byte-identical to the
  removed section; the trimmed general doc has no dangling cross-reference
  and no gap in section numbering.
- **No leakage:** no file remaining under `knowledge-base/general/`
  mentions the Seven Keys methodology, verified by grep — this is the
  invariant the entire spec depends on.
- **End-to-end:** a three-variant fixture tree renders a Feature Impact
  section with one row per feature, each against the same `base`.
