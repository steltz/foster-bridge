# Seven Keys — unified daily zone assessment (design)

**Date:** 2026-07-18
**Status:** Approved

## Problem

The trading personas (placement-trader, basehit-trader, rotation-trader) each
rank the day's plan zones against the Seven Keys from
`knowledge-base/methods/seven-keys.md` (moved there from
`knowledge-base/general/support_and_resistance_zones.md` section 3 by a later
decomposition; at the time this spec was written it lived in the latter).
Today
every persona subagent in trader-panel and trader-bench performs its own
independent Seven-Keys evaluation of the same zones, so two traders can score
the same zone differently. The keys themselves are static methodology
principles; what varies per day is the **assessment** — how each of that day's
zones scores against Keys 3–7 plus the day's larger-timeframe bias.

## Goal

Compute one shared Seven-Keys assessment per session day — informed by the
previous three days' assessments — persist it as a committed artifact in the
day folder, and pass the same artifact to every persona in both trader-panel
and trader-bench before they choose a setup.

## Decisions made during brainstorming

1. **Output:** a per-zone key scorecard (Keys 3–7) plus the day's
   larger-timeframe bias, produced once per day and injected into every
   persona's prompt. Keys 1–2 (expectancy, no-confirmation) are
   trader-behavior keys, not zone properties — they stay persona-level.
2. **Lookback:** the assessment for day N is informed by the keys artifacts of
   the up-to-three most recent prior days.
3. **Architecture:** a standalone `seven-keys` skill writing a committed
   `<prefix>_ES_KEYS.md` artifact; trader-panel and trader-bench auto-generate
   it when missing and pass it to personas.
4. **Bench provenance:** new bench cells record `keysSha256`; old cells (no
   field) remain valid; the scoreboard does not distinguish eras. Keys files
   become immutable once any bench cell references them — same guard as
   persona files.
5. **Analyst shape:** a dynamic Workflow with three agents — a current-day
   analyst (general docs + the day's three docs), a lookback analyst (prior
   three keys files), and a synthesizer that weights the current-day analysis
   heavily over the lookback.

Added in review (2026-07-18):

6. **Verification gate:** a verifier agent between Synthesize and the file
   write cross-checks every scorecard row against the trade plan docs; a
   mismatch aborts without writing. The artifact is upstream of every trader
   and immutable once benchmarked, so a bad write is permanently bad.
7. **Outcome-aware lookback:** the lookback analyst reads each prior keys
   file paired with the recap that describes how that day's session actually
   traded, so lookback carries calibration signal (were the grades right?)
   rather than echoing prior opinions.
8. **Era visibility:** the keys artifact carries provenance frontmatter, and
   the scoreboard gains a minimal keys/no-keys annotation so aggregate stats
   never silently mix the two envelopes.

## Component 1 — new skill `seven-keys`

Location: `.claude/skills/seven-keys/SKILL.md`.
Arguments: optional `MMDDYYYY` (day folder), optional `force`.

### Phase 1 — Preflight (no agents; abort early with one specific message)

Mirrors trader-panel's conventions:

1. Resolve the day folder under `knowledge-base/es/`. A folder is "complete"
   when it contains all three day docs from step 2. With `MMDDYYYY`, use
   that folder. Without, order complete folders chronologically by the
   `YYYYMMDD` re-keyed prefix of their `*_ES_TP.md` (never folder name) and
   pick the latest without a `*_ES_KEYS.md`; with `force` and no day
   argument, pick the latest complete folder and overwrite.
2. Locate the three day docs by suffix (`*_ES_TP.pdf`, `*_ES_TP.md`,
   `*_ES_RECAP.md`); any missing → abort naming the suffix.
3. Derive the date from the 8-digit `MMDDYYYY` prefix of the two TP doc
   filenames (must agree; recap exempt). Convert to `YYYY-MM-DD`.
4. Discover general docs: every file under `knowledge-base/general/`
   (recursive); empty is fine.
5. Discover the **lookback set**: the up-to-three most recent complete day
   folders strictly before the target date (chronological by TP-doc prefix)
   that already contain a `*_ES_KEYS.md`. Fewer than three is fine; zero
   means the lookback agent is skipped (bootstrap case). For each lookback
   day P, also resolve its **outcome recap**: the `*_ES_RECAP.md` of the
   next complete day folder chronologically after P (recaps describe the
   prior session, so P's outcome lives in the following day's recap — for
   the most recent lookback day that is the target day's own recap). If no
   such recap exists, P's keys file is used without an outcome pairing.
6. Overwrite guards: if the day already has a `*_ES_KEYS.md` and `force` was
   not given → abort naming the file. Even with `force`, if any
   `runs/*/*/<day>/run-*.json` records a `keysSha256` for this day → abort:
   keys files are immutable once benchmarked; the remedy is a new benchmark
   era, not an edit.

### Phase 2 — ONE Workflow invocation (four agents)

Inline all resolved values into the script constants (never Workflow `args`,
per the established pattern in trader-panel/trader-bench).

- `phase('Analyze')` — in parallel:
  - **Current-day analyst**: Reads the general docs and the day's three docs.
    Returns (via schema) the larger-timeframe bias, environment/volatility
    notes, and a per-zone scorecard: for every support/resistance zone in the
    trade plan — zone prices, side, and an assessment against Key 3
    (approach/exhaustion/first-test), Key 4 (zone timeframe), Key 5
    (significant prior launched move), Key 6 (bias alignment), Key 7
    (confluence), plus an overall grade from
    `automatic-fade | strong | moderate | weak`.
  - **Lookback analyst** (only when the lookback set is non-empty): Reads
    each prior keys file PAIRED with that day's outcome recap (from preflight
    step 5). Returns calibration-aware continuity notes: for each prior day,
    whether the highly graded zones actually held per the recap; plus
    recurring zones across days, bias evolution, and anything in prior
    assessments that should sharpen today's read. Prior days whose grades
    proved wrong must be flagged, not smoothed over.
- `phase('Synthesize')` — one synthesizer agent receives both outputs inline
  (no file reads) and produces the final artifact content. Its prompt states
  the weighting explicitly: **the current-day analysis is authoritative; the
  lookback may sharpen or annotate it but never overrides current-day
  evidence.** In the bootstrap case the synthesizer runs with the current-day
  output only and marks the lookback section "none — bootstrap".
- `phase('Verify')` — one verifier agent receives the synthesized artifact
  content inline plus the paths to the day's trade plan docs (PDF and plan
  transcript). It re-reads those docs and checks every scorecard row: zone
  prices and side must match a zone actually present in the trade plan, with
  no invented, dropped-then-substituted, or transposed prices. It returns
  (via schema) `pass` or a list of specific mismatches. Any mismatch → the
  skill aborts WITHOUT writing the keys file, reporting the mismatches; a
  rerun regenerates cleanly. The verifier checks fidelity to the source docs
  only — it does not second-guess grades or bias judgments.

Agents use the session default model (no model override).

### Phase 3 — Write and commit

Write `<prefix>_ES_KEYS.md` into the day folder (`<prefix>` = the TP docs'
8-digit prefix). Format:

```markdown
---
generatedBy: <model id of the session that ran the skill, e.g. claude-fable-5>
generatedAt: <ISO-8601 UTC timestamp>
lookbackSources: [<prior keys filenames, or empty list for bootstrap>]
verified: true
---

# Seven Keys — ES <YYYY-MM-DD>

**Larger-timeframe bias:** …
**Environment notes:** …

Keys 1–2 (expectancy; no price confirmation) are trader-behavior keys and
remain the responsibility of each persona. Zones below are scored on Keys 3–7.

## Zone scorecard (Keys 3–7)

| Zone (prices) | Side | Key 3 approach | Key 4 timeframe | Key 5 prior launch | Key 6 bias align | Key 7 confluence | Grade |
|---|---|---|---|---|---|---|---|

## Automatic-fade candidates

- <zones graded automatic-fade, or "None today.">

## Lookback

Sources: <each prior keys file with its outcome recap, e.g.
"07152026_ES_KEYS.md (outcome: 07152026_ES_RECAP.md)", or "none — bootstrap">

- <calibration-aware continuity notes, including any prior grades that
  proved wrong>
```

Commit exactly the artifact:
`docs: add ES seven-keys assessment for <YYYY-MM-DD>`.
Show the user the scorecard table inline.

## Component 2 — trader-panel changes

- **Phase 1** gains a step after locating the three docs: locate the day's
  `*_ES_KEYS.md`. If missing, run the full seven-keys flow (Phases 1–3 of the
  seven-keys skill, including its commit) for that day first, then continue.
- **Phase 2** persona prompt gains one document between the general block and
  the three day docs: *"Read the shared Seven-Keys assessment at `<path>` —
  the panel-wide scorecard of the day's zones. Adopt its per-zone key scores
  rather than re-deriving them; apply your persona's style to choose among
  the zones it grades."*

## Component 3 — trader-bench changes

- **Phase 1**: every candidate day must have a `*_ES_KEYS.md`. Generate
  missing ones **sequentially, oldest first** (so each day's lookback sees
  its predecessors), committing each as it is produced. Compute each day's
  `keysSha256` with `shasum -a 256`.
- **New immutability guard** alongside the persona guard: if any existing
  cell records a `keysSha256` for a day that differs from the current file's
  hash → abort naming the day, both hashes, and the remedy (keys files are
  immutable once benchmarked). Cells without the field (pre-keys era) are
  valid and exempt.
- **Phase 2** persona prompt gains the same shared-assessment line, using the
  day's keys file path.
- **Phase 3** cell JSON gains a top-level `"keysSha256"` field.

## Component 4 — scoreboard era annotation

Minimal change to the scoreboard generator (`node src/cli.js scoreboard`):
cells with a `keysSha256` field belong to the keys era; cells without it are
pre-keys. The scoreboard gains, per (trader, model) row, a keys/no-keys cell
count (e.g. `12k/25`), and the Ranking section gains a one-line legend
explaining the annotation. No judging, aggregation, or run logic changes —
the annotation exists so aggregate stats never silently mix the two
envelopes, and so the keys artifact's effect on results stays measurable.

## Error handling

- All preflight failures abort with one specific message before any agent
  runs (established pattern).
- If the seven-keys Workflow fails or returns no synthesized artifact, abort
  without writing the keys file; a rerun regenerates cleanly.
- If the verifier reports mismatches (or itself dies), abort without writing
  the keys file, showing the mismatches; never write an unverified artifact.
- In trader-panel/trader-bench, a failed auto-generation of a required keys
  file aborts the run (panel) or skips that day with a listed reason (bench,
  consistent with its other per-day skips).

## Testing

The skills are prompt-orchestrations, not code; there is no unit surface.
Verification is by execution:

1. Run `/seven-keys` on the oldest complete day (bootstrap: no lookback) and
   inspect the artifact, including its provenance frontmatter.
2. Run it on a later day and confirm the lookback section cites each prior
   keys file with its outcome recap and comments on whether prior grades
   held up.
3. Spot-check the verification gate: confirm every scorecard row's prices
   and side appear in the day's trade plan docs (and, if feasible, that a
   deliberately corrupted synthesizer output is rejected without a write).
4. Run `/trader-panel force` on a day with a keys file and confirm every
   persona's rationale is consistent with the shared scorecard.
5. Run `/trader-bench 1` and confirm new cells carry `keysSha256`, missing
   keys files were generated oldest-first, and the immutability guard
   triggers when a keys file is hand-edited after a cell references it.
6. Regenerate the scoreboard and confirm the keys/no-keys annotation counts
   match the cells on disk.

## Out of scope

- Re-running or invalidating existing benchmark cells.
- Changing persona files (they are immutable once benchmarked).
- Scoring zones on Keys 1–2.
- Any change to the backtest CLI's run/judging logic. (The scoreboard
  generator changes only as described in Component 4.)
