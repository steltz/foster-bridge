# Trader Panel Skill — Design Spec

**Date:** 2026-07-17
**Status:** Approved design, pending implementation plan

## Purpose

A project skill, `/trader-panel`, that backtests a panel of futures-trading
persona subagents against a single trading day. Each persona reads the day's
knowledge-base documents, commits to exactly one trade setup, and the
orchestrator runs every setup through the backtest CLI and writes a scored
panel report into the day's knowledge-base folder. It is the daily
"run the panel on the previous session" ritual; personas themselves are
authored separately and are data, not code.

## Non-goals (MVP)

- Authoring sophisticated personas (only 3 simple starters ship, as pipeline
  validators to be replaced).
- More than one setup per persona (future expansion; MVP is one long-or-short
  determination each).
- Multi-instrument support (ES only; layout generalizes later).
- Cross-day aggregation/leaderboards (each run scores one day; history
  accumulates as committed reports).
- Automatic scheduling (the user invokes the skill; cron can come later).
- Position sizing (qty is always 1).

## Inputs and layout

```
knowledge-base/es/<MMDDYYYY>/     — day folder (folder year may be wrong; see Date rule)
  *_ES_TP.pdf                     — trade plan worksheet (support/resistance zones)
  *_ES_TP.md                      — trade-plan video transcript
  *_ES_RECAP.md                   — prior-session recap transcript
ticker-data/MES/min-5/*.csv       — 5-minute OHLC candles (backtest CLI input)
traders/*.md                      — persona prompt files (one per persona)
```

**Date rule:** the CLI `--date` (true `YYYY-MM-DD`) is derived from the
8-digit `MMDDYYYY` prefix of the two trade-plan docs (`*_ES_TP.pdf` and
`*_ES_TP.md`) — never from the folder name, whose year is unreliable. Those
two prefixes must agree; a conflict aborts. The recap file is named for the
prior session it recaps, so its prefix is expected to differ and is exempt
from the agreement check.

## Skill structure

```
.claude/skills/trader-panel/SKILL.md   — the orchestration instructions
traders/support-buyer.md               — starter persona
traders/breakout-trader.md             — starter persona
traders/fade-the-move.md               — starter persona
```

The SKILL.md contains the full procedure, the workflow script to run, the
persona envelope prompt, the output JSON schema, and the report template —
everything needed with zero conversation context.

## Orchestration flow (hybrid: inline scout → workflow fan-out → inline execute)

### Phase 1 — Preflight (inline, no agents)

1. Resolve the day folder: explicit `MMDDYYYY` argument, else the latest
   folder under `knowledge-base/es/` that contains all three docs AND no
   existing `*_ES_PANEL.md`, where "latest" is chronological by the
   `*_ES_TP.md` date prefix re-keyed `YYYYMMDD` (never folder-name order).
   If the chosen folder already has a panel report, abort unless the user
   said `force`. `force` without a day argument means: take the latest
   complete folder even if it has a report, and overwrite that report.
2. Locate the three docs by suffix; derive the CLI date per the Date rule.
3. Verify the ticker CSV contains candles for that date (single awk/grep
   pass). Missing → abort naming the date.
4. Discover personas: every `traders/*.md`. Zero personas → abort telling the
   user to author personas (starters ship with the skill, so this only
   happens if they were deleted).

Every abort is one specific message; no agents have been spawned yet.

### Phase 2 — Persona fan-out (one dynamic Workflow invocation)

The skill launches the Workflow tool with a script whose
`DATE`/`DOCS`/`PERSONAS` constants are inlined at generation time (the
Workflow `args` channel proved unreliable in live verification — inlining is
deterministic). The script runs `parallel` over personas; each `agent()`
call gets:

- The persona envelope prompt (below) with that persona's file path.
- A JSON schema forcing the setup shape, so malformed replies are retried at
  the tool layer.

**Persona envelope (standard wrapper around each persona file):** the agent
must (1) Read its persona file and adopt that trading identity, (2) Read all
three day documents (PDF via the Read tool), (3) decide long or short for the
session, (4) return exactly one setup with prices anchored to the plan's
support/resistance zones, plus a rationale of at most 50 words.

**Setup schema (workflow `agent()` schema option):**

```json
{
  "type": "object",
  "required": ["side", "entry", "stopLoss", "takeProfit", "rationale"],
  "properties": {
    "side": { "enum": ["long", "short"] },
    "entry": { "type": "number" },
    "stopLoss": { "type": "number" },
    "takeProfit": { "type": "number" },
    "rationale": { "type": "string", "maxLength": 400 }
  },
  "additionalProperties": false
}
```

The workflow returns `[{ persona, setup }]`. A persona whose agent dies
resolves to null and is reported as `NO_SETUP` — one failed persona never
sinks the panel.

### Phase 3 — Validate and execute (inline, after the workflow)

The orchestrator performs NO validation of its own — the CLI is the single
source of truth for all deterministic judgment. For each returned setup:

1. **Execute**: write `{ "id": "<persona>", "side": ..., "entry": ...,
   "stopLoss": ..., "takeProfit": ... }` as a single-order JSON file in the
   session scratchpad, then run:
   `node src/cli.js run --data "<csv>" --orders <file> --date <YYYY-MM-DD> --json`
   One CLI run per persona so each result is traceable.
2. **Interpret the CLI's verdict**: exit 0 → the persona's row shows the
   CLI-reported result (`TP`/`SL`/`EOD`/`NOT_FILLED` — a far-off entry is
   simply `NOT_FILLED`, which is the honest deterministic answer). Exit 1
   with the CLI's order-validation message (e.g. long requires
   `stopLoss < entry < takeProfit`) → the persona is marked `INVALID` with
   that message. Any other CLI failure → `CLI_ERROR` (with stderr). The
   panel continues in every case.

### Phase 4 — Report (inline)

Write `<MMDDYYYY>_ES_PANEL.md` (date prefix matching the folder's file
convention) into the day folder, then commit it with a semantic message.
The report is written exactly once, at the end — no partial writes.

```markdown
# Trader Panel — ES <YYYY-MM-DD>

| Persona | Side | Entry | Stop | Target | Result | Pts | USD |
|---|---|---|---|---|---|---|---|
| support-buyer | long | 7530 | 7524 | 7550 | TP | +20.00 | +$100.00 |
| breakout-trader | short | ... | ... | ... | NOT_FILLED | - | - |

**Panel:** N personas · F filled · W wins · net X pts / $Y

## Rationales
- **support-buyer:** "<rationale>"

## Notes
<personas that were INVALID / NO_SETUP / CLI_ERROR, with reasons>
```

Result values come from the CLI's `--json` output (`TP`/`SL`/`EOD`/
`NOT_FILLED`); `INVALID`, `NO_SETUP`, and `CLI_ERROR` are orchestrator
statuses. Every discovered persona appears in the report exactly once.

## Starter personas (deliberately simple)

- `support-buyer.md` — looks to buy the plan's primary support zone,
  stop below the zone, target the next resistance.
- `breakout-trader.md` — looks to enter in the direction of a break of the
  plan's key level, stop inside the broken zone, target the next zone.
- `fade-the-move.md` — looks to fade extensions into the plan's outer
  zones, stop beyond the zone, target back toward value.

Each is a short markdown file with `name`/`style` frontmatter and a prompt
body. They exist so the pipeline is testable end-to-end today and are
expected to be replaced by real persona work later.

## Error handling summary

| Condition | Behavior |
|---|---|
| Day folder missing / docs missing | Abort, name the missing piece |
| Trade-plan doc prefixes (pdf vs md) conflict | Abort, show the conflict |
| No candles for the date | Abort, name the date and CSV |
| Panel report already exists | Abort unless `force` |
| No persona files | Abort, point at `traders/` |
| One persona agent fails | `NO_SETUP` row, panel continues |
| CLI rejects the order (its validation) | `INVALID` row with the CLI's message |
| CLI fails any other way | `CLI_ERROR` row with stderr |

## Testing

The deliverable is a skill (instructions + workflow script + personas), not
new `src/` code, so verification is a live end-to-end run:
`/trader-panel 07162027` with the three starter personas against the real
07/16 data. Success criteria: three persona rows with CLI-derived results, a
correct panel summary line, report committed in the day folder, and rerun
without `force` aborts on the existing report. The backtest CLI itself is
already covered by its 51-test suite and is unchanged by this work.

## Future directions (recorded, not in scope)

Multiple setups per persona; persona memory of prior panel results; NQ and
other instruments; cross-day leaderboards; scheduled daily runs; persona
tournaments and evolution.
