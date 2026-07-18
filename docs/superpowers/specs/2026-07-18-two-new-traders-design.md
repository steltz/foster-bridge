# Design: Two New Trader Personas — basehit-trader & rotation-trader

**Date:** 2026-07-18
**Status:** Approved (design review with user)

## Context

The panel currently has two personas, `context-trader` and `placement-trader`. They
are siblings: both fade support/resistance with a single resting limit order, both
pick direction first from the docs (plan bias + recap + social lens), both demand
≥2.5:1 reward-to-risk with the stop behind the zone and the target at the next
zone. They differ only in where the reasoning effort goes (which zone vs. where
inside one zone).

Bench data (runs/SCOREBOARD.md, 300 cells): placement-trader on fable is the only
consistent winner (+$173/run). Win rates are 15–33% with ~30-pt average winners and
~8–11-pt average losers, and both traders went long in ~98% of runs.

Engine constraint (src/engine.js): entries are resting LIMIT orders only — a long
fills only on a pullback down into a zone, a short only on a rally up into one. No
breakout/stop entries, no scale-outs, one bracket (entry/SL/TP) per run, positions
force-closed at end of day. Bracket ordering is validated by src/orders.js
(long: stopLoss < entry < takeProfit; short: mirrored).

## Goal

Add two personas that are maximally different from the incumbents — and from each
other — along the expectancy axis, while staying inside the limit-fade bracket
world the engine supports. No code changes: the pipeline (trader-bench re-globs
`traders/*.md`, scoreboard groups automatically) absorbs new persona files as-is.

| | Incumbents | basehit-trader | rotation-trader |
|---|---|---|---|
| Philosophy | 3:1 hunt, ~25% win rate | Win often, win small | Rarely fill, win huge |
| R:R | ≥2.5:1 | 1.5:1–2:1 (floor 1.5:1) | ≥4:1 |
| Entry depth | varies / shallow-to-fill | shallow, leading edge | deep, premium location |
| Expected fill% | ~40–60% | high | low (unfilled is modal) |
| Direction | ~98% long | bias-respecting | range position (both sides) |

## Persona 1: basehit-trader

**Identity:** The edge is win rate, not reward size. Only engages the day's single
highest-odds zone — one with enough Seven-Keys confluence to approach "automatic
fade" grade — and takes a modest target it expects to hit most of the time.

- **Side:** synthesized from the docs like the incumbents (bias-respecting; trade
  against bias only on a genuine documented shift, with caution).
- **Zone:** ONLY the highest-confluence, bias-aligned zone of the day. The quality
  bar is the selectivity mechanism; the trader still emits exactly one setup per
  run (pipeline requirement).
- **Entry:** shallow, at the zone's leading edge — getting filled is the point; an
  unfilled high-odds setup earns nothing.
- **Stop:** at least one point beyond the zone's far edge (method unchanged).
- **Target:** the nearest logical opposing reference delivering 1.5:1 to 2:1.
  Floor 1.5:1; does NOT stretch for more — reaching for 3:1 is against its
  identity.
- **Explicit deviation clause:** the persona states plainly that it knowingly
  rejects the workshop doc's "2:1 minimum / hunt 3:1" filter and why: at a
  55–60%+ win rate on near-automatic-fade zones, 1.5:1 is solidly profitable
  (expectancy at 60% win rate and 1.5:1 = +0.5R/trade). Without this clause the
  model reading both docs will drift back toward 3:1.

**Expected bench signature:** high fill% (shallow entries), win% far above the
incumbents' ~25% (target 55%+), small average win, similar average loss.

## Persona 2: rotation-trader

**Identity:** A patient sniper trading day-range rotation. Maps the day's
realistic range from the docs (overnight levels, plan zones, recap), rests one
order at the single most significant extreme zone bounding that range, and
targets the far side of the range.

- **Side by range position** (naturally breaks the incumbents' 98%-long habit):
  price opening near the top of the expected range → short the resistance extreme
  toward range bottom; near the bottom → long the support extreme; mid-range →
  take the more significant extreme, tie-broken by the larger-timeframe bias.
- **Zone:** the most significant larger-timeframe zone at the chosen range
  extreme — Keys 4/5/7 (larger timeframe, launched a prior significant move,
  stacked confluence). Often the 2nd/3rd zone out, not the first.
- **Entry:** deep inside the zone — the opposite of placement-trader's
  shallow-to-fill logic. Demands premium location, accepts low fill odds.
- **Stop:** at least one point beyond the zone's far edge (method unchanged).
- **Target:** the near edge of the opposite range extreme.
- **R:R floor 4:1:** if the geometry gives less, move the entry deeper until it
  clears 4:1, accepting even lower fill odds.
- **Unfilled is the modal, accepted outcome** — stated explicitly in the persona
  so the model doesn't chase worse location to get filled.

**Expected bench signature:** low fill% (roughly 20–30%), rare but very large
winners, short setups appearing in the bench for the first time.

## Integration

- Two new files: `traders/basehit-trader.md`, `traders/rotation-trader.md`.
- File format identical to incumbents: YAML frontmatter with `name` and `style`,
  then prose instructions.
- Both personas keep every invariant the pipeline requires: exactly one setup per
  run; resting limit entry semantics (long fills on pullback down, short on rally
  up); valid bracket ordering per src/orders.js; stop behind the zone.
- No changes to src/, trader-bench, or trader-panel. Runs land under
  `runs/<trader>/<model>/<day>/run-N.json`; the scoreboard picks up the new
  groups automatically.

## Validation

After writing both personas, run the bench (e.g. `/trader-bench 5 fable`) and
check `runs/SCOREBOARD.md`:

- basehit-trader: high fill%, win% well above incumbents, small average win.
- rotation-trader: low fill%, large average win, at least some short setups.
- Both groups present with no pipeline errors.

Persona-quality failure modes to watch for on first bench: basehit drifting back
to 3:1 targets (deviation clause too weak), rotation chasing fills with shallow
entries (patience clause too weak), or invalid brackets (orders.js rejections
would surface as pipeline errors).

## Out of scope

- Engine changes (breakout/stop entries, scale-outs, multi-order runs).
- A contrarian/short-seeker persona (considered and rejected in brainstorming).
- Modifying the two existing personas.
