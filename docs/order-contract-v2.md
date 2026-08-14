# Order Contract v2 — managed orders (spec)

Written 2026-08-14, revised same day to unify breakeven + partial scale-out
into a single management rule. Companion to `persona-findings.md` (§8, §10) and
`benchmark-power-plan.md`. Status: **building now** (engine + orders +
backtest endpoint). §8 (conditional plans / first-hour evaluation) is
**documented for future direction only**. Persona integration is deliberately
deferred — this build is harness-only.

## 0. Framing: the engine simulates the human executor

The personas do not trade; **the user does**, following the persona's plan and
actively managing the position. The current engine scores fire-and-forget
brackets — an execution policy nobody uses — so benchmark results neither
describe nor predict the user's P&L (see `persona-findings.md` §3/§8: the
−32.5R as-run result and the +86R fixed-1R replay are *both* strawmen).

The user's actual play, in their words: buy the support zone; when the market
responds and reaches ~+1.5R, **take part of the position off and move the stop
to breakeven**, letting the remainder run to the original target. That is one
management *event* with two effects — modeled here as exactly that.

Contract v2's job: let an order carry that management event and simulate it
deterministically. The persona's output becomes an **instruction sheet**; the
engine becomes a stand-in for the user at the screen. Fidelity principle: **the
engine models what the user does, expressed as absolute price levels the user
can watch — never math the user must do mid-session.**

## 1. Schema

### 1.1 `RawOrder` additions (`execution/orders.ts`)

```ts
export interface RawOrder {
  id?: string | number;
  side: Side;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  qty?: number;
  activeFrom?: string;            // NEW: 'HH:MM' local (session tz); no entry fill before this
  management?: ManagementRule[];  // NEW: v1 = at most ONE rule
}

// One trigger, up to two effects. At least one effect must be present.
export interface ManagementRule {
  triggerR: number;       // favorable excursion in R (R = |entry − initial stopLoss|); > 0
  takeFraction?: number;  // exit this fraction of the position at the trigger price; (0, 1)
  moveStopToR?: number;   // move stop to entry + this·R·direction; 0 = exact breakeven
}
```

The rule reads as the user's sentence: *"at +1.5R, take half off and move the
stop to breakeven"* = `{ triggerR: 1.5, takeFraction: 0.5, moveStopToR: 0 }`.
Pure breakeven = omit `takeFraction`. Pure partial = omit `moveStopToR`.

Input is in **R units** (how the user thinks); normalization converts to
absolute prices once, at submission.

### 1.2 `NormalizedOrder` additions

```ts
export interface NormalizedManagement {
  triggerR: number;
  takeFraction: number | null;
  moveStopToR: number | null;
  triggerPrice: number;      // long: entry + triggerR·risk ; short mirrored
  newStop: number | null;    // long: entry + moveStopToR·risk ; null if no stop move
}
// NormalizedOrder gains: activeFromMinutes: number | null; management: NormalizedManagement[]
```

Absolute prices are computed **here and only here** — engine and trade sheet
both consume `triggerPrice` / `newStop`; neither re-derives R math.

### 1.3 Validation (extend `normalizeOrders`)

Reject with a per-order message when:

- `management.length > 1` (v1 restriction; message names it).
- Neither `takeFraction` nor `moveStopToR` present (a trigger with no effect).
- `triggerR` non-finite or `<= 0`.
- `takeFraction` present and not strictly inside `(0, 1)` (taking 100% is a
  take-profit, not a partial — use `takeProfit`).
- `moveStopToR` present and (`< 0` or `>= triggerR`) — the moved stop must sit
  strictly on the entry side of the trigger, and loosening a stop is not
  management.
- `triggerPrice` at or beyond `takeProfit` (long: `triggerPrice >= takeProfit`;
  short mirrored) — a trigger past the target can never fire before it.
- Zero-risk order (`entry === stopLoss`) with a management rule (R undefined).
  (Already unreachable via the existing `stopLoss < entry < takeProfit`
  ordering checks, but asserted for clarity.)
- `activeFrom` present but not `HH:MM` 24-hour format (reuse the `entryCutoff`
  parser convention in `backtest.service.ts`).

Omitted `management` and `activeFrom` ⇒ exactly v1 behavior (§5 golden tests).

## 2. Engine semantics (`execution/engine.ts`)

### 2.1 State machine

```
PENDING ──touch (in-window, armed)──▶ FILLED   (full position, stop = stopLoss)
FILLED ──favorable side reaches triggerPrice──▶ MANAGED
         · takeFraction exits at triggerPrice (recorded as scaleExit)
         · stop becomes newStop (if moveStopToR present; else unchanged)
FILLED|MANAGED ──effective stop hit──▶ exit remainder: 'SL' (stop unmoved) / 'BE' (stop was moved)
FILLED|MANAGED ──takeProfit hit──▶ exit remainder: 'TP'
FILLED|MANAGED ──candles exhausted──▶ exit remainder: 'EOD' @ last close
```

One-way transitions; the trigger fires at most once; the stop never moves
twice in v1.

### 2.2 Outcome shape

- `OrderStatus` gains `'BE'` — remainder exited at `newStop` after the trigger
  fired. Distinct from `'SL'` deliberately: a scratch is neither a win nor a
  loss, and the findings analysis had to reconstruct exactly this bucket from
  raw prices.
- `OrderOutcome` gains
  `scaleExit: { time: number; price: number; fraction: number } | null` —
  the partial leg, when it happened.
- **Blended per-unit accounting.** With fraction `f` exiting at trigger and
  remainder `1−f` exiting at `exitPrice`:
  - `points = qty · direction · (f·(triggerPrice − entry) + (1−f)·(exitPrice − entry))`
  - `rMultiple = (f·triggerR·risk + (1−f)·(exitPrice − entry)·direction) / risk`
    — i.e. blended against the **original** risk. Examples for the canonical
    play (`triggerR 1.5, f 0.5, moveStopToR 0`): runner scratches → **+0.75R**;
    runner hits a 3.1R target → **+2.3R**; trigger never fires, stop hit →
    **−1R**.
  - Fractions are per-unit simulation values; live execution maps them to
    contract counts. `qty` stays an integer and scales `points`/`dollars`
    as today.
- `SimSummary` gains `scratches` (status `BE`). `wins`/`losses` keep their
  `points > 0` / `points < 0` definitions — a scaled trade whose runner
  scratches has positive blended points and correctly counts as a win.
- `maxAdverseExcursion` / `maxFavorableExcursion` / `closestApproach`:
  definitions unchanged (measured from entry, full candle range).

### 2.3 Intra-candle ordering — extend the existing path model, add no new heuristics

The engine already resolves ambiguity with a candle-shape path (engine.ts:24):
bullish candle = O→L→H→C, bearish = O→H→L→C, flat = bullish; the path is **a
property of the candle alone, never of the order**. All management ordering
derives from walking that same path:

For a **long** (short is the exact mirror):

| Candle | Path | Resolution |
|---|---|---|
| Bullish, spans old stop and trigger | O→**L**→**H**→C | Low first: old stop hit before the trigger could fire → `SL`, no scale. (Matches existing `slHitsFirst`.) |
| Bearish, spans old stop and trigger | O→**H**→**L**→C | High first: trigger fires mid-candle (partial exits at `triggerPrice`, stop → `newStop`); then the low: `low <= newStop` → remainder exits `BE`, else state MANAGED. |
| Trigger and TP in one candle | any | `triggerPrice < takeProfit` always (§1.3), so the favorable leg hits the trigger en route; if the same leg reaches TP, the remainder exits `TP` in the same candle. The trigger firing never blocks a same-candle TP. |
| Fill candle spans everything (bullish) | O→L→H→C | Fill on the entry touch (the low leg, per existing rules); the favorable leg then runs L→H: trigger may fire, TP may hit. The candle's low never retroactively stops out a just-triggered order. |
| After MANAGED | — | Subsequent candles evaluate `newStop` (or the unmoved stop if `moveStopToR` was absent) and `takeProfit`; `slHitsFirst` continues to arbitrate a candle spanning both. |

Invariants asserted in code:

1. **No retroactive exits:** a price level already passed on the candle's path
   cannot act on state created later in that same path.
2. **R fixed at inception:** all R math uses `|entry − initial stopLoss|`.
3. **Optimistic touch pricing throughout** (consistent with today's TP fills):
   the partial exits exactly at `triggerPrice` when the favorable extreme
   reaches it, gaps included.

### 2.4 `activeFrom`

Per-order entry window start: effective open =
`max(session openMinutes, order.activeFromMinutes)`. Same semantics as the
existing window (engine.ts:12–16): out-of-window candles neither **arm** nor
fill the order; exits on a filled position are never blocked. An order whose
only touches occur before `activeFrom` is `NOT_FILLED`; `closestApproach`
measures in-window candles only, as today.

Granularity note: with `min-5` data the trigger/stop path within a candle is a
model, not an observation. Ingesting `min-1` (already in the `Interval` type)
tightens this materially. The path heuristic is identical at any granularity.

## 3. API surface (`POST /backtest`)

- Request: `orders[]` accepts the new fields. No new top-level parameters.
- Response: results may carry `status: 'BE'` and `scaleExit`; each result
  echoes the **normalized** management (`triggerPrice`, `newStop` — absolute
  prices) and `activeFrom`. Summary gains `scratches`.
- Backward compatibility: requests without the new fields produce results
  identical to v1 (enforced by golden tests, §5).

## 4. Benchmark integration — constant grading regime (built)

Decision (2026-08-14): **the LLM never emits management.** Personas produce
entry/stop/target only; the harness stamps constant management onto every
backtest order deterministically. Management is part of the *grading regime*
(how the user executes any plan), not part of the plan. This also keeps
persona comparisons clean — every persona is scored under identical execution.

Config (`benchmark.grading` in `configuration.ts`):

| Env | Default | Meaning |
|---|---|---|
| `BENCHMARK_RR_FLOOR` | `2` | Setups below this reward-to-risk are `INVALID` — never backtested. Floor > triggerR also guarantees the trigger always sits strictly inside the target |
| `BENCHMARK_QTY` | `2` | Contracts per order; matches the user's live 2-lot so dollar figures are real |
| `BENCHMARK_MGMT_TRIGGER_R` | `1.5` | The management event |
| `BENCHMARK_MGMT_TAKE_FRACTION` | `0.5` | Sell half at the trigger (= sell 1 of 2 contracts) |
| `BENCHMARK_MGMT_MOVE_STOP_TO_R` | `0` | Stop to exact breakeven |
| `BENCHMARK_MGMT=off` | — | Disables stamping (fire-and-forget grading, pre-v2 behavior) |

Contract-count note: per-unit fractions and integer contracts are the same
arithmetic — `takeFraction 0.5` × qty 2 ≡ "sell 1 of 2, hold 1". The only
integer constraint is live execution: the position must be a multiple of
1/takeFraction contracts; that belongs on the trade sheet, not in the engine.

Implementation: `batch-reconciler.ts` `buildCell` applies the floor check
(status `INVALID`, note `reward-to-risk X below floor Y`, backtest never
called), stamps `qty` + `management` on the order, and copies `scaleExit` into
the cell result. `CellStatus` gains `'BE'`; the scoreboard counts `BE` as
filled and scored.

**Era note:** each cell records its regime in a `grading` provenance field,
because the scoreboard groups by (trader, alias, variant) with no regime in
the key. Cells graded fire-and-forget (all pre-v2 cells) and cells graded
under management must not share a row — do not top up an old persona's cells
after this change; retire old personas and run the new panel as new files.

## 5. Test plan

1. **Golden regression:** existing engine/backtest suites untouched and green;
   a fixture set run with `management`/`activeFrom` absent produces
   v1-identical output.
2. **Path matrix:** side × candle shape (bullish/bearish/flat) × overlap set
   ({old stop, trigger, newStop, TP} in one candle) asserting §2.3, including
   the fill-candle-does-everything case and the no-stop-move variant.
3. **Accounting:** blended `points`/`rMultiple` for: runner → TP, runner → BE,
   runner → EOD, trigger-never-fires → SL; pure-breakeven and pure-partial
   variants; `rMultiple ≈ f·triggerR` for a scale-then-scratch (± float
   tolerance).
4. **Property-style:** trigger never fires before fill; stop never loosens;
   `activeFrom` ⇒ no `fillTime` earlier than the window start; `scaleExit`
   non-null ⇔ trigger fired ⇔ (status `BE` possible).
5. **Validation table:** every §1.3 rejection with its message.
6. **EOD-after-trigger:** MANAGED at data end exits remainder `EOD` at last
   close, `scaleExit` preserved.

## 6. Trade sheet (human-facing rendering)

The deliverable the user trades from. All absolute prices, no R math at
execution time:

```
ES — 2026-07-01 — <persona>
LONG 7488.00 (limit, inside 7481.75–7495.75)
  Stop:    7480.75           (risk 7.25 pts = 1R)
  Target:  7510.50           (+3.1R)
  Manage:  at 7498.88 (+1.5R) — sell half, move stop 7480.75 → 7488.00
  Active:  from RTH open · cancel entry after 14:00
Rationale: <persona rationale>
```

Renderer is a pure function of the normalized order + setup metadata; lives
with result formatting, not the engine. Deferred with §4 (persona track), but
the normalized absolute prices it needs exist from this build.

## 7. Explicit non-goals (v1)

- Multiple management rules per order (laddered scales); trailing stops;
  time-based stops; re-entry. The `management[]` array shape reserves room
  without schema breaks.
- Any LLM/persona-side change (§4).
- Replaying historical runs under v2 rules (fixing forward).

## 8. Future direction (documented, NOT being built): conditional plans / first-hour evaluation

Recorded so the contract can grow toward it without rework; **no
implementation now.**

The user trades live and can execute branching instructions. The natural next
step is *conditional plans* compiled pre-open, with the human as the runtime —
not intraday LLM checkpoints:

```
if the first RTH hour holds above 7495:
    place LONG 7488 / stop 7480.75 / target 7510.50 (manage as above)
else if the first hour accepts below 7481:
    stand down            # or an alternate short branch
```

Dependency sketch:

1. **Order-level condition** (evaluated on candles, deterministically):
   `{ type: 'holdsAbove' | 'acceptsBelow', price, evaluateUntil: 'HH:MM' }` —
   the order activates (or cancels) when the condition resolves. Composes with
   `activeFrom` (§2.4), which is the degenerate "condition = clock time" case
   and is why it ships in v2 now.
2. **Plan-level branches:** mutually exclusive order groups gated by
   conditions; at most one branch activates. The trade sheet renders the same
   if/else text for the human.
3. **Conviction gate** for early entry (enter during hour one only against an
   `automatic-fade`-grade zone from the KEYS doc) — structural, not
   self-assessed, to avoid the confidence-field failure mode
   (`persona-findings.md` §7).
4. Strict no-look-ahead discipline is inherited from the engine being
   candle-driven; if intraday *LLM* checkpoints are ever added on top, every
   decision must carry a market timestamp and see only strictly-prior data.

Open questions parked with it: condition resolution vs entry-arming rules;
whether `NOT_FILLED` splits into `NOT_TRIGGERED`/`NOT_FILLED`; scorecard
attribution of a stand-down day (0R by convention, as today's unfilled).
