---
name: trader-spawn
description: Spawn a new descendant trader persona from an existing origin trader — /trader-spawn <origin> <tweak description> drafts a new traders/*.md that changes exactly one thing about the origin and carries origin/mutation lineage frontmatter, with a diff approval gate before writing. Use when the user wants to derive, refine, tweak, evolve, or branch a trader.
---

> **Retired — no API replacement.** Authoring a persona is a file edit, not a
> service operation: add a `traders/*.md` directly, keeping the `origin` /
> `mutation` lineage frontmatter this document describes (see `CLAUDE.md`). The
> conventions below still hold — only the skill wrapper is retired. Hidden from
> Claude via `skillOverrides` in `.claude/settings.json`.

# Trader Spawn — derive a descendant trader

Create ONE new trader file in `traders/` from an existing origin persona,
changing exactly one thing. Trader files are immutable once benchmarked
(trader-bench hash-guards them), so refinement ALWAYS means a new file —
never edit the origin. Lineage lives in frontmatter: `origin` names the
parent, `mutation` describes the single tweak; the scoreboard renders the
family tree from these fields automatically.

**Arguments:** `<origin>` — an existing trader's name — and a free-text
tweak description (the hypothesis to test). Both are required; if either
is missing, ask for it before doing anything else.

Out of scope (deliberate): this skill never analyzes bench results or the scoreboard to invent or recommend tweaks — the user supplies the hypothesis. If asked to "figure out what to improve," decline and ask for a specific tweak.

## Step 1 — Resolve the origin

Glob `traders/*.md` and match `<origin>` against each file's `name:`
frontmatter value (fallback: filename without `.md`). No match → abort,
listing the available trader names. Read the origin file in full.

## Step 2 — Derive the descendant's name

Build a descriptive-suffix name: the origin's stem plus a short slug of
the tweak, kebab-case (e.g. `basehit-trader` + "try deeper entries" →
`basehit-deeper-entry`; `rotation-trader` + "tighter stops" →
`rotation-tighter-stop`). Drop a trailing `-trader` from the stem when the
suffix reads better without it. The name must not collide with any
existing `traders/*.md` name (frontmatter or filename) or any existing
`runs/<name>/` directory — on collision, abort and propose an alternative
name for the user to confirm.

## Step 3 — Draft the persona

Start from the origin's FULL text and weave the single tweak through it
coherently: rewrite every passage whose logic the tweak touches so the
persona never contradicts itself, and preserve everything else verbatim.
Do not bolt the tweak on as an extra paragraph. Frontmatter of the new
file:

```yaml
---
name: <descendant name>
style: <one-line style summary, updated to reflect the tweak>
origin: <the origin's `name` frontmatter value>
mutation: <one line describing the single change relative to the origin>
---
```

`origin` and `mutation` must both be present, each on one line.

## Step 4 — Approval gate

Before writing anything, show the user: the proposed name, the mutation
line, and a diff of the new persona against the origin (e.g. via
`diff <(cat traders/<origin-file>) <scratchpad-draft>` or an equivalent
summary of exactly what changed). Only write `traders/<name>.md` after the
user approves. If they ask for changes, revise the draft and show the diff
again.

## Step 5 — Write and confirm

Write the approved draft to `traders/<name>.md`. NEVER modify the origin
file — this skill writes exactly one new file. Confirm to the user that
the descendant now exists, is a plain `traders/*.md` file (so trader-bench
and trader-panel pick it up automatically on their next run), and suggest
`/trader-bench` to benchmark it. Committing is up to the user's usual
workflow; if the user asks, use a semantic message like
`feat: add <name> persona (<mutation, shortened>)`.
