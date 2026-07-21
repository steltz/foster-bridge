# Backtest CLI — Scenario Log & Future Ideas

Running record of scenarios exercised against the backtest CLI, plus scenarios
and features worth revisiting. Data set: `ticker-data/MES/min-5/CME_MINI_MES1!, 5.csv`
(5-minute MES, 2026-06-30 → 2026-07-17, New York sessions). MES = $5/point.

## Scenarios verified (2026-07-17)

### 1. Mixed winning day — 2026-07-15

Session: O 7607 / H 7627.75 / L 7571.75 / C 7624.5 (+17.50).

| Order | Setup | Result |
|---|---|---|
| dip-long | long 7600, SL 7590, TP 7615 | TP: filled overnight 03:25, target hit 09:05, +15 pts |
| fade-short | short 7620, SL 7630, TP 7600 | TP: filled 09:30, survived 7627.75 high (2.25 pts from stop), target 10:40, +20 pts |
| deep-long | long 7560 (below session low) | NOT_FILLED |
| top-short | short 7625, qty 2 | TP: filled on 09:35 spike, 7605 hit 09:45, +40 pts total |

Net +75 pts / +$375. Sequencing hand-verified against raw candles: the 09:45
low of 7603 tagged top-short's 7605 target but not fade-short's 7600, which
waited until 10:40 — the engine ordered exits correctly.

### 2. Losing day with stop-outs — 2026-07-16

Session: O 7624.5 / H 7632 / L 7524.25 / C 7524.25 (−100.25, closed on the low).

| Order | Setup | Result |
|---|---|---|
| buy-dip-1 | long 7600, SL 7590 | SL: filled 03:55, stopped 07:45, −10 pts |
| buy-dip-2 | long 7570, SL 7560 | SL: filled 14:40, stopped 15:25, −10 pts |
| knife-catch | long 7530, SL 7520 | EOD: session low 7524.25 never hit the stop; force-closed at 7524.25, −5.75 pts |
| hedge-short | short 7630, SL 7640, TP 7550 | TP: filled 2 pts from the high at 01:30, +80 pts / +$400 |

Net +54.25 pts / +$271.25 despite going 1-for-4 — the hedge carried the day.
Verified: the 7632 session high printed *before* buy-dip-1's fill, so its
stop-out (not a 7625 take-profit) is correct.

### 3. Ambiguous-candle rule (candle-shape tie-break) — 2026-07-14, updated 2026-07-20

The 08:30 news candle spans 57.25 pts (O 7559.25 / H 7613.75 / L 7556.5 / C 7596)
— the widest candle in the file. Two identical longs at 7580 with TP 7595,
differing only in stop placement:

| Order | Stop | Result |
|---|---|---|
| tight-stop | 7570 (inside the candle's range) | SL on the fill candle itself, −10 pts |
| wide-stop | 7550 (below the candle's low) | TP on the fill candle itself, +15 pts |

Both filled and exited on the same 08:30 candle. This candle is bullish
(close 7596 >= open 7559.25), so under the shape-based tie-break it still
resolves the tight-stop order to SL — not from a blanket worst-case rule, but
because the assumed intrabar path (a small early dip below 7570, then the
rally to new highs) plausibly stops the trade out before the later rally
reaches the target.

The rule genuinely varies by candle shape, though. A hypothetical bearish
mirror of the same candle — same range, but opening near the high and
closing near the low (e.g. O 7610 / H 7613.75 / L 7556.5 / C 7560) — would
resolve the same tight-stop long to **TP** instead: the assumed path rallies
to the high first, then sells off, so the target is reached before the stop.
**Takeaway: on 5-minute data, an ambiguous candle's resolution now depends on
that candle's own bullish/bearish shape, not on how tight the trader's stop
is** — see
`docs/superpowers/specs/2026-07-20-ambiguous-candle-resolution-design.md`.
Finer-grained data (1-minute) would still shrink how often this ambiguity
arises at all.

### 4. JSON output for scripting

`--json | jq` works cleanly, e.g.:

```bash
node src/cli.js --data "ticker-data/MES/min-5/CME_MINI_MES1!, 5.csv" \
  --orders orders.json --date 2026-07-16 --json \
  | jq -c '{session, net: .summary.netDollars}'
```

This is the building block for shell-scripting a loop over all sessions today,
without any new features.

## Scenarios not yet exercised (testable with the current CLI)

- **Gap/no-fill subtlety** — an entry price that falls between one candle's
  range and the next never fills (touch-fill skips gapped-over prices).
  Relevant around the daily maintenance-break gap.
- **Break-even EOD** — a position force-closed exactly at its entry counts as
  neither win nor loss, so `Wins + Losses` can be less than `Filled`. Worth
  seeing once so the summary isn't misread as an arithmetic bug.
- **`--tz UTC` day boundaries** — how the session reshuffles when the calendar
  day is defined in UTC instead of New York, especially for late-evening fills.
- **`--multiplier` override** — e.g. `--multiplier 50` to model full-size ES
  with the same price data.

## Feature candidates (need new development)

In rough build order:

1. **Batch mode across all days** — run the same orders over every session in
   the file and aggregate P/L. The engine is pure (arrays in, results out), so
   this is cheap to add, and it is the actual "backtest a strategy" workflow.
2. **Entry types (limit vs stop-entry)** — touch-fill cannot express "buy the
   breakout above 7620"; today that order would also fill on the way down.
3. **Time-windowed orders** — valid-from/valid-until (e.g. 09:30–11:00) and
   cancel-if-unfilled-by. Currently every order works the full session, which
   is how a "morning" order can fill at 03:25.
4. **OCO / bracket groups** — "if the long fills, cancel the short." All
   orders are independent today.
5. **Slippage and commissions** — even a flat per-side tick cost can flip
   marginal strategies from green to red.
6. **Other timeframes** — 1-minute data support (mostly just new data files;
   also reduces the ambiguous-candle distortion from scenario 3).

## Known quirks (documented behavior, not bugs)

- Break-even trades count as neither win nor loss.
- Negative net renders as `$-1.25` (not `-$1.25`).
- `--multiplier 0` or negative values are accepted without complaint.
- EXIT PX column prints raw precision (`7524.25`) while PTS/USD are fixed to
  two decimals.
