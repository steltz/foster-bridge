# Composite Features (`combines:`) — Design Spec

Extends the trader-bench feature system (2026-07-18-trader-bench-design.md)
so two or more existing features can be benchmarked *together* as one new
variant, without touching the independence of the existing per-feature
variants.

## Purpose

The bench currently tests each `features/*.md` variant one at a time,
never combined. The first real question this leaves unanswered: does a
trader given BOTH the Seven-Keys methodology and the precomputed scorecard
beat a trader given either alone? Combos answer this class of question
generally: any curated set of existing features becomes a first-class
variant with the same lifecycle features already have — declared by
authoring one file, auto-run by the idempotent top-up, frozen once
benchmarked, and scored on the shared scoreboard.

Expected scale: many hand-picked pairs over time as the feature library
grows (user's stated intent), so combos get first-class machinery — but
declaration stays curated; there is no automatic pair sweep.

## Non-goals

- **No exhaustive pair generation.** Cell count would grow quadratically
  with the feature library. A combo exists only when someone authors its
  file.
- **No nested combos.** `combines` entries must be plain (non-combo)
  features. Composition depth stays 1.
- **No change to plain-feature cells or semantics.** Existing cells (630
  today) remain valid; no benchmark era reset. The plain-feature cell
  schema is byte-for-byte unchanged.
- **No combo-owned resources.** A combo cannot declare its own
  `staticDoc`, `artifactSuffix`, or `generatorSkill`; every resource comes
  from a component.

## Declaration

A combo is an ordinary `features/*.md` file distinguished by a `combines`
frontmatter key:

```markdown
---
id: seven-keys-both
name: Seven-Keys method + scorecard
combines: [seven-keys-method, seven-keys-scorecard]
---
(optional override body)
```

Rules (all enforced by `collectFeatures` validation — an invalid combo
aborts discovery exactly like an invalid feature does today):

- `combines` is an ordered list of ≥2 distinct feature ids. Order is
  semantic: it is the concatenation order of the auto-built prompt.
- Every entry must resolve to a feature declared in the same `features/`
  directory that is itself not a combo (no nesting, no dangling ids).
- A combo must not declare `staticDoc`, `artifactSuffix`, or
  `generatorSkill` of its own.
- Combo ids share the feature id namespace: same kebab-case slug rule,
  same reserved-`base` rule, same duplicate-id rule.
- Two combos with the same components in the same order and both using
  auto-concat (no override body) are the same variant in all but name →
  validation error. Same components with different override bodies (or
  different order) are distinct variants and legal.

## Prompt resolution

`collectFeatures` resolves each combo to a final prompt block:

**Auto-concat (empty body).** Each component's own block has its
`${DOC}` / `${ARTIFACT}` placeholders bound to that component's resources;
the resolved blocks are joined with a blank line, in `combines` order.
Components sharing a `staticDoc` path (the seven-keys pair does) are NOT
deduplicated — the concatenation is mechanical and a repeated "read this
doc" instruction is harmless redundancy, not an error.

**Override body (non-empty body).** Replaces the concatenation entirely.
Placeholders must be namespaced by component id:

- `${DOC:<component-id>}` — that component's `staticDoc` path.
- `${ARTIFACT:<component-id>}` — that component's per-day artifact path.

Validation mirrors the existing placeholder guards:

- Bare `${DOC}` or `${ARTIFACT}` in a combo body → error (ambiguous).
- `${DOC:x}` where component `x` has no `staticDoc`, or `${ARTIFACT:x}`
  where `x` has no `artifactSuffix`, or `x` not in `combines` → error.
- Every artifact-backed component MUST be referenced by at least one
  `${ARTIFACT:x}` in the override body — an unused artifact means the
  combo is not actually combining that component.
- A `staticDoc`-only component need not be referenced (its doc may be
  covered by another component's identical doc, as with the seven-keys
  pair) — docs inform, artifacts define.
- Namespaced placeholders in a NON-combo feature body → error.

## Bench integration (`/trader-bench` skill changes)

`VARIANTS = ['base', ...featureIds]` already includes combos because
combos are features; discovery order stays `collectFeatures`' filename
sort. Combos are top-upped, write-once, and reported identically to plain
features. Specific deltas:

- **Artifacts (Phase 1 steps 10–12).** A combo never generates artifacts.
  Its artifact needs are the union of its artifact-backed components',
  which steps 10–11 already generate and guard per component feature. A
  (day, component) artifact failure excludes BOTH the component's own
  cells and every combo containing it for that day (reported per variant
  in the skipped list).
- **Immutability guards (Phase 1).** For every existing combo cell, the
  preflight compares: the combo file's hash (`featureSha256`, as today)
  AND each component file's current hash against the cell's
  `componentSha256s` map. Any mismatch aborts with the standard remedy
  (new feature/combo id, or new era). This closes the drift gap where a
  component file is edited after only the combo — not the component
  itself — was benchmarked.
- **Phase 2 envelope.** The workflow script's `FEATURES` entry for a combo
  carries the resolved block with namespaced placeholders intact, plus
  per-component doc paths and an artifact-component id list. Per-cell
  substitution binds `${ARTIFACT:x}` from `ARTIFACTS_BY_DAY[day][x]`
  (keyed by the artifact-owning component id, as today) and `${DOC:x}`
  from the inlined component doc paths. The existing missing-path throws
  extend per component: any unresolvable placeholder fails that cell
  loudly (contained by `parallel()`, reported as an anomaly) rather than
  prompting with a literal placeholder.

## Cell schema (combo cells only)

Combo cells extend the standard cell with:

```json
{
  "variant": "seven-keys-both",
  "combines": ["seven-keys-method", "seven-keys-scorecard"],
  "featureSha256": "<hash of the combo file itself>",
  "componentSha256s": { "<component-id>": "<hash of that component file>" },
  "staticDocSha256s": { "<component-id>": "<hash of its staticDoc>" },
  "artifactSha256s": { "<component-id>": "<that day's artifact hash>" }
}
```

- `staticDocSha256s` / `artifactSha256s` contain keys only for components
  that have the corresponding resource; either map is omitted entirely
  when no component has that resource.
- Scalar `staticDocSha256` / `artifactSha256` never appear on combo
  cells; map forms never appear on plain-feature cells. The `combines`
  key is what distinguishes a combo cell.
- Every other field (trader, model, day, runIndex, timestamp,
  personaSha256, generalSha256, setup, result, note) is unchanged.

## Scoreboard

- **Ranking / per-group sections / Coverage:** combos need no special
  handling — they are variant directories like any other.
- **Feature Impact:** combos get their own subsection per combo. Each row
  set compares, over shared days only (same day-intersection rule as
  today): combo vs `base`, and combo vs EACH component variant. The
  component comparisons are the point — they show whether the combination
  beats the better of its parts, not just whether it beats nothing.
- The scoreboard obtains the combo→components mapping from
  `collectFeatures` (not from run files), falling back to the cells'
  `combines` key for combos whose file has since been removed.

## First combo: `features/seven-keys-both.md`

`combines: [seven-keys-method, seven-keys-scorecard]` with an override
body (auto-concat would contradict itself: "grade the zones yourself" vs
"adopt its scores"). Draft reconciliation, to be edited by the user before
its first benchmark run freezes it: read the methodology at the shared
doc, grade the day's zones yourself, then consult the shared scorecard at
`${ARTIFACT:seven-keys-scorecard}` as a second opinion — where your grades
disagree with it, reconcile the disagreement in your persona's style
before choosing a zone.

## Error handling summary

| Failure | Behavior |
|---|---|
| `combines` names a missing/combo id | discovery error, abort preflight, nothing touched |
| combo declares own resource keys | discovery error |
| bare placeholder in combo body / namespaced in plain body | discovery error |
| unreferenced artifact-backed component in override body | discovery error |
| duplicate auto-concat combos (same components + order) | discovery error |
| component file edited after combo benchmarked | preflight abort via `componentSha256s` guard |
| (day, component) artifact missing/failed | day excluded for component AND its combos; reported |
| unresolvable placeholder at fan-out | that cell fails loudly, anomaly-reported; no cell file |

## Testing

- `collectFeatures` unit tests: valid combo (auto-concat and override),
  each validation error above, order-sensitivity of the duplicate rule,
  shared-staticDoc non-dedup.
- Prompt resolution tests: auto-concat binds each component's own
  resources; override substitution binds namespaced placeholders; plain
  features unchanged byte-for-byte.
- Scoreboard tests: combo Feature Impact rows (vs base + vs each
  component) over shared days; combos ranked normally; plain-feature
  Feature Impact output unchanged.
- Bench dry-run test (fixture runs/ tree): missing-set computation
  includes combos; componentSha256s guard trips on a mutated component.
