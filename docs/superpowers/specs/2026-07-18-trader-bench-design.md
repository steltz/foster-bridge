# Trader Benchmark Matrix — Design Spec

**Date:** 2026-07-18
**Status:** Approved design, pending implementation plan

## Purpose

A repeatable eval harness for trading personas. Knowledge-base days are
static fixtures; trader personas are immutable subjects; models are a
controlled variable. The harness runs each trader N independent times
against every day in the knowledge base, stores every result as an
immutable cell in a four-dimensional results matrix —
**(trader, model, day, run-index)** — and generates a deterministic
scoreboard that ranks traders while keeping every trader's and every
model's P&L fully segregated.

Motivating use cases:

1. **Variance measurement.** Personas are LLM-driven and non-deterministic;
   N independent runs with identical inputs expose run-to-run variance so a
   single lucky run is never mistaken for skill.
2. **Trader selection.** The user runs exactly one trader live and picks it
   from the scoreboard. P&L is therefore never summed across traders.
3. **New-trader catch-up.** Traders never change after creation, but new
   ones are added over time. A new trader must be testable apples-to-apples
   against incumbents: same day set, same run count, same model.
4. **Model comparison.** The same immutable trader may be run under
   different models (fable, sonnet, opus, …). Each (trader, model) pair is
   a distinct competitor; results are never merged across models.

## Non-goals

- Replacing `/trader-panel`. The one-day panel skill, its Workflow, and the
  `*_ES_PANEL.md` day-folder reports are untouched. The bench is additive.
- Cross-trader or cross-model P&L aggregation, anywhere, ever.
- Position sizing (qty stays 1, matching the panel and CLI).
- Multi-instrument support (ES only, same as the rest of the repo).
- Editing or re-scoring existing cells. Cells are write-once.
- Scheduling/automation (user-invoked only).

## Core semantics: idempotent top-up

There is one orchestration primitive, the fill command:

> Bring every trader to N runs on every complete knowledge-base day, for
> the given model, running only the missing cells.

This single rule covers every scenario:

- Fresh benchmark: all cells missing → runs N × days × traders agents.
- New trader added: its column is empty → catch-up is automatic and
  apples-to-apples by construction; existing cells are not touched or
  re-spent.
- New knowledge-base days added: every trader is missing those days → only
  those cells run.
- Higher confidence wanted later: invoke with a larger N → tops up the
  extra runs per day.
- New model: a full column of cells for that model is missing → full
  re-spend for that model, by design.

Cost scales as N × days × traders per model (e.g. 5 × 10 × 2 = 100
subagents for one model today). Top-up semantics guarantee no cell is ever
paid for twice.

## Storage layout

```
runs/
  <trader>/                      — persona name (traders/<trader>.md)
    <model-alias>/               — fable | sonnet | opus | haiku
      <MMDDYYYY>/                — same 8-digit prefix the day's TP docs use
        run-1.json … run-N.json  — one immutable cell per run
runs/SCOREBOARD.md               — generated; safe to regenerate anytime
```

Everything under `runs/` is committed to git.

### Cell schema (`run-<k>.json`)

```json
{
  "trader": "context-trader",
  "model": { "alias": "fable", "id": "claude-fable-5" },
  "day": "07152026",
  "date": "2026-07-15",
  "runIndex": 3,
  "timestamp": "<ISO-8601, recorded at write time>",
  "personaSha256": "<hash of traders/<trader>.md at run time>",
  "setup": {
    "side": "long",
    "entry": 7574,
    "stopLoss": 7563.25,
    "takeProfit": 7606.25,
    "rationale": "<persona's ≤400-char rationale>"
  },
  "result": {
    "status": "TP",
    "points": 32.25,
    "dollars": 161.25,
    "fillTime": "<from CLI JSON, when present>",
    "exitTime": "<from CLI JSON, when present>"
  },
  "note": "<stderr line for INVALID / CLI_ERROR; absent otherwise>"
}
```

`result.status` is the CLI's verdict verbatim: `TP | SL | EOD | NOT_FILLED`,
or the orchestrator-assigned `INVALID` (CLI order-validation rejection),
`CLI_ERROR` (other CLI failure), `NO_SETUP` (agent died; `setup` omitted).
The CLI remains the sole judge; the orchestrator never validates, fixes, or
clamps a persona's prices. A `NO_SETUP` or `CLI_ERROR` cell still occupies
its run slot (it is a real observation of the pipeline), but see fill rate
and error surfacing in the scoreboard section.

### Model aliases

The directory key and `model.alias` use the Workflow `agent()` model enum
(`fable`, `sonnet`, `opus`, `haiku`) so the recorded value is exactly what
was requested. `model.id` records the precise model identifier when it can
be determined (from the environment or agent self-report); alias is the
dimension key, id is provenance.

## The fill command: `/trader-bench` skill

A new project skill at `.claude/skills/trader-bench/SKILL.md`.

**Arguments:** optional `N` (target runs per cell, default 5) and optional
model alias (default `fable`, matching the project's standing subagent-model
preference).

### Phase 1 — Preflight (no agents; abort early with one specific message)

1. **Discover traders:** every `traders/*.md`; persona name from `name:`
   frontmatter, falling back to filename. None → abort.
2. **Immutability guard:** compute SHA-256 of each persona file. If any
   existing cell for that trader (any model/day/run) records a different
   `personaSha256`, abort naming the trader and both hashes. The remedy is
   creating a new trader file, not overwriting history.
3. **Discover complete days:** every `knowledge-base/es/<MMDDYYYY>/` folder
   containing all three docs (`*_ES_TP.pdf`, `*_ES_TP.md`, `*_ES_RECAP.md`),
   using the panel skill's exact date rule: CLI date derives from the
   8-digit prefix of the two TP doc filenames (which must agree), never the
   folder name. Incomplete folders are skipped with a listed reason, not
   fatal.
4. **Verify candle coverage** for each candidate day via the repo's own
   modules (`parseCsv` + `filterDay`, same check as the panel skill). Days
   with zero candles are skipped and listed, not fatal.
5. **Discover general docs:** all files under `knowledge-base/general/`
   (recursive); empty is fine.
6. **Compute the missing set:** for each (trader, day), existing cells are
   `runs/<trader>/<model>/<day>/run-*.json`; missing run indices are
   `1..N` minus existing. Existing cells beyond N are left alone.
7. **Report the plan before launching:** traders × days × model, cell count
   already present, cell count to run (e.g. "38 missing cells → 38
   agents"), then proceed. If nothing is missing, say so and skip straight
   to scoreboard regeneration.

### Phase 2 — Fan-out (one Workflow invocation)

One Workflow run, one subagent per missing cell, `parallel()` over the
missing-cell list (the workflow runtime caps concurrency). Resolved values
(dates, doc paths, general docs, personas, missing cells) are inlined into
the script constants, not passed via Workflow `args` (same reliability rule
the panel skill follows).

Each agent gets the panel skill's persona envelope, unchanged in substance:
adopt the persona file, read the general docs, read the day's three docs,
commit to exactly ONE long-or-short setup anchored to plan levels, return
`{side, entry, stopLoss, takeProfit, rationale}` via the same
`SETUP_SCHEMA`. The agent is launched with `model: <alias>`. Agents are
blind: no other runs, days, traders, or prior results in their context.
Run-index does not alter the prompt — repeat runs are identical trials.

Agents that die return null → those cells become `NO_SETUP`.

### Phase 3 — Judge and persist (main loop, no validation of its own)

For each returned setup: write a one-order JSON to the session scratchpad,
run `node src/cli.js run --data <csv> --orders <file> --date <date> --json`,
interpret exit status and stderr exactly as the panel skill does
(TP/SL/EOD/NOT_FILLED from JSON; INVALID on order-validation stderr;
CLI_ERROR otherwise), then write the cell file
`runs/<trader>/<model>/<day>/run-<k>.json`. Never overwrite an existing
cell.

### Phase 4 — Scoreboard and commit

Run the scoreboard generator (below), then commit new cells plus the
regenerated `runs/SCOREBOARD.md` in one commit:
`bench(<model>): <count> new cells across <traders> traders / <days> days`.
Show the user the scoreboard's ranking table inline.

## The scoreboard: deterministic Node script

`src/scoreboard.js`, exposed as `node src/cli.js scoreboard` (third
subcommand beside `run` and `transcript`). No LLM anywhere; it reads every
cell JSON under `runs/` and rewrites `runs/SCOREBOARD.md`. Regenerating is
free and idempotent, so it can be rerun after any manual inspection or
partial bench.

Grouping unit: **(trader, model)**. No number in the report ever sums
across traders or across models.

Per (trader, model) group:

- **Ranking metric:** mean net P&L per full run, where run k's total is the
  sum of that trader's day results at run-index k across all days it has at
  that index. Groups are ranked by this mean.
- **Distribution:** per-run totals listed individually, std dev, min run,
  max run.
- **Trade quality:** win rate (points > 0 among filled), fill rate
  (filled = TP/SL/EOD over all decided cells; NOT_FILLED scores $0 but is
  surfaced), average win vs average loss.
- **Setup stability per day:** side agreement across runs (e.g. 5/5 long
  vs 3L/2S) and entry-price spread (max − min entry). Instability is
  informational, not penalized in the ranking.
- **Coverage:** days × runs present vs the maximum any group has;
  under-tested groups are flagged so apples-to-oranges comparisons are
  visible rather than silent. Cells with status NO_SETUP / INVALID /
  CLI_ERROR are counted and listed as pipeline errors per group.

Report structure: a top ranking table (one row per (trader, model) group),
then a detail section per group, then a coverage matrix.

## Error handling summary

| Failure | Behavior |
|---|---|
| Persona file hash mismatch vs history | Abort preflight, name trader + hashes |
| No traders / no complete days | Abort preflight with specific message |
| Day missing a doc or candles | Skip day, list it in the plan report |
| Agent dies | Cell recorded as NO_SETUP, bench continues |
| CLI rejects prices | Cell recorded as INVALID with stderr note |
| Other CLI failure | Cell recorded as CLI_ERROR with stderr note |
| Cell file already exists | Never overwritten (write-once invariant) |
| Scoreboard with zero cells | Writes a stub noting no runs exist |

## Testing

- **Scoreboard (pure logic):** unit tests in `test/` alongside existing
  suites — fixture cell JSONs covering wins/losses/NOT_FILLED/errors,
  verifying grouping, per-run totals, std dev, stability metrics, coverage
  flags, and the never-merge invariant (a fixture with two traders and two
  models must produce four groups and no combined totals).
- **Preflight missing-set logic:** exercised via fixture `runs/` trees
  (already-full, partially-full, empty, over-full) if extracted into a
  testable helper; otherwise verified manually during implementation.
- **End-to-end:** a small live bench (N=1, one model) against the existing
  knowledge base, verifying cells appear, the immutability of existing
  cells, and scoreboard regeneration.
