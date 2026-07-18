# Trader Lineage — Tree of Origin

**Date:** 2026-07-18
**Status:** Approved design

## Purpose

Derive new trader personas from existing ones as controlled experiments: each
refinement is a brand-new trader file that changes exactly one thing about its
origin, and the family relationship is recorded so the scoreboard can show
which origin each trader came from and whether the tweak helped.

## Constraints discovered in the repo

- Benchmarked trader files are immutable: trader-bench hash-guards every
  `traders/*.md` against the `personaSha256` recorded in existing run cells
  and aborts if a file changed. Therefore lineage metadata can only be added
  to NEW files — the four existing traders are never edited.
- Both trader-bench and trader-panel discover personas by globbing
  `traders/*.md` flat. The lineage design must not change that layout.
- P&L is never compared across models; any origin-vs-descendant comparison
  must be within a single model alias.

## Design decisions

- **Storage:** frontmatter-only (no registry file, no directory nesting). The
  tree is derived by reading `traders/*.md` frontmatter at scoreboard time.
- **Root definition:** a trader file with no `origin` field is a root (origin
  trader). The four existing traders are roots by default, untouched.
- **Creation:** a dedicated project skill, `/trader-spawn`. The user supplies
  the hypothesis; the skill drafts the persona.
- **Naming:** descriptive suffix — origin stem + what changed
  (e.g. `basehit-deeper-entry`), not version numbers.

## 1. Lineage frontmatter schema

Descendant trader files add two fields to the existing frontmatter:

```yaml
---
name: basehit-deeper-entry
style: <one-line style summary, as today>
origin: basehit-trader
mutation: Entries rest at the zone midpoint instead of the leading edge
---
```

- `origin`: the parent trader's `name` frontmatter value (not its filename).
  Absent → the trader is a root.
- `mutation`: one line describing the single change relative to the origin.
  Required whenever `origin` is present.
- Chains of any depth are supported: a grandchild's `origin` names its direct
  parent; the full ancestry is recovered by walking `origin` links to a root.

## 2. New skill: `/trader-spawn <origin> <tweak description>`

Location: `.claude/skills/trader-spawn/SKILL.md`.

Behavior:

1. **Resolve origin.** Glob `traders/*.md`, match `<origin>` against `name`
   frontmatter (fallback: filename without `.md`). No match → abort listing
   available traders.
2. **Derive the name.** Origin stem + short descriptive suffix taken from the
   tweak (e.g. `basehit-trader` + "deeper entries" → `basehit-deeper-entry`).
   Abort if the name collides with an existing `traders/*.md` name or a
   `runs/<name>/` directory.
3. **Draft the persona.** Start from the origin's full text. Weave the single
   tweak through the persona coherently — every passage whose logic the tweak
   touches is rewritten to agree with it; everything else is preserved
   verbatim. Set frontmatter `name`, `style` (updated to reflect the tweak),
   `origin` (the parent's `name`), and `mutation` (one line).
4. **Approval gate.** Show the proposed name, the mutation line, and a
   diff-vs-origin. Only write `traders/<name>.md` after the user approves.
5. **Never modify the origin file.** The skill writes exactly one new file.

Out of scope (deliberate): the skill does not analyze bench data to propose
tweaks; the user supplies the hypothesis.

## 3. Lineage display in SCOREBOARD.md

The scoreboard-generation step of trader-bench
(`.claude/skills/trader-bench/SKILL.md`) gains:

**a) A `## Lineage` section** — an indented family tree derived from
frontmatter. Each node shows the trader name, its mean $/run per model that
has runs, and — for descendants — the delta vs its direct origin at the same
model plus its mutation line:

```
basehit-trader                fable 5r: -11.25
└─ basehit-deeper-entry       fable 5r: 41.50   (Δ vs origin: +52.75)
     Entries rest at the zone midpoint instead of the leading edge
```

Rules:
- Deltas are computed only within the same model alias, only when both
  trader and origin have runs at that model; otherwise omitted.
- Roots with no descendants still appear (single-line entries), so the
  section is the complete census of traders.
- A descendant whose `origin` names a trader that no longer exists is shown
  under an `(unknown origin: <name>)` node rather than dropped.

**b) A "vs origin" line** in each descendant's per-trader@model section:
one sentence stating the origin, the mutation, and the mean-$/run delta at
that model (or "origin has no runs at this model" when incomparable).

## 4. What does not change

- trader-panel and trader-bench discovery: descendants are plain
  `traders/*.md` files and automatically join the panel and the bench matrix.
- Run storage: cells stay keyed by trader name under `runs/<trader>/…`.
- The immutability guard: once a descendant is benchmarked, its file — and
  therefore its lineage record — is frozen. Further refinement means spawning
  a new descendant from it.

## Testing

- Spawn a descendant from an existing trader; verify the file's frontmatter
  carries `origin`/`mutation`, the origin file is byte-identical, and the
  bench preflight discovers the new trader without complaint.
- Regenerate the scoreboard with at least one descendant benchmarked; verify
  the Lineage tree renders, deltas appear only for same-model pairs, and all
  four roots appear.
- Negative: attempt `/trader-spawn` with a colliding name and with an unknown
  origin; both must abort with the specified messages.
