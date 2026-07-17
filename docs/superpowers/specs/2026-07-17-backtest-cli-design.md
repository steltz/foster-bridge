# Backtest CLI — Design Spec

**Date:** 2026-07-17
**Status:** Approved design, pending implementation plan

## Purpose

A JavaScript CLI that simulates trade execution against historical candlestick
(OHLC) data to backtest orders. First target: 5-minute MES futures data
exported from TradingView. Given a chart CSV and a list of orders (long/short
with entry, stop loss, take profit), it replays one trading day and reports
which orders filled, how each trade exited, and profit/loss.

## Non-goals (this version)

- Live data or broker integration.
- Multiple simultaneous timeframes (data files other than 5-minute work
  incidentally, but nothing is timeframe-aware).
- Strategy logic (signals, indicators). Orders are supplied by the user.
- Netting, margin, or interaction between orders — each order is independent.
- Slippage or commission modeling.

## CLI interface

```
node src/cli.js --data <chart.csv> --orders <orders.json>
                [--date YYYY-MM-DD] [--tz <IANA timezone>]
                [--multiplier <dollars-per-point>] [--json]
```

| Flag | Required | Default | Meaning |
|---|---|---|---|
| `--data` | yes | — | Path to OHLC chart CSV |
| `--orders` | yes | — | Path to orders JSON file |
| `--date` | no | most recent full day in file | Calendar day to simulate |
| `--tz` | no | `America/New_York` | Timezone defining the calendar day |
| `--multiplier` | no | `5` | Dollars per point per contract (MES = $5) |
| `--json` | no | off | Emit machine-readable JSON instead of the table |

## Input formats

### Chart CSV

TradingView export format. Required columns: `time` (unix seconds, bar open),
`open`, `high`, `low`, `close`. All other columns (indicator overlays etc.) are
ignored. Rows with missing/non-numeric OHLC values are rejected with a clear
error naming the line number.

### Orders JSON

A JSON array of order objects:

```json
[
  { "id": "morning-long", "side": "long",  "entry": 7530, "stopLoss": 7520, "takeProfit": 7550, "qty": 1 },
  { "side": "short", "entry": 7560, "stopLoss": 7570, "takeProfit": 7540 }
]
```

- `side` — `"long"` or `"short"` (required)
- `entry`, `stopLoss`, `takeProfit` — numbers (required)
- `id` — optional; auto-generated as `<side>-<n>` when omitted
- `qty` — optional contract count, default `1`

Validation (errors abort before simulation):

- long: `stopLoss < entry < takeProfit`
- short: `takeProfit < entry < stopLoss`
- unknown fields are ignored; duplicate ids are an error.

## Simulation semantics

Candles for the selected day are replayed in chronological order. Every order
starts **pending**.

1. **Fill (touch = fill):** a pending order fills the first time a candle's
   `[low, high]` range contains the entry price. Fill price is exactly the
   entry price. Direction of approach does not matter.
2. **Exit:** once filled, each candle — including the candle that produced the
   fill — is checked for exit:
   - long: SL hit if `low <= stopLoss` (exit at `stopLoss`); TP hit if
     `high >= takeProfit` (exit at `takeProfit`)
   - short: SL hit if `high >= stopLoss`; TP hit if `low <= takeProfit`
   - If a single candle satisfies both, **the stop loss wins** (worst-case
     convention so results never overstate performance).
3. **End of day:** a position still open after the last candle is force-closed
   at that candle's `close` and labeled `EOD`. A never-filled order is
   labeled `NOT_FILLED`.

P/L per order:

- points = `(exitPrice - entry) * qty` for longs, `(entry - exitPrice) * qty`
  for shorts
- dollars = `points * multiplier`
- `NOT_FILLED` orders have no P/L and are excluded from win/loss counts.

## Day selection

The `time` column (unix seconds) is converted to a calendar date in the
`--tz` timezone. `--date` selects all candles on that date. When `--date` is
omitted, the CLI uses the latest date present in the file (which may be a
partial day if the export ends mid-session). A `--date` with no matching
candles is an error.

## Output

Default: a human-readable table on stdout, one row per order —
`id, side, status (TP|SL|EOD|NOT_FILLED), fill time, exit time, exit price,
P/L points, P/L dollars` — followed by a summary: orders placed, filled, wins,
losses, net points, net dollars. Times are formatted in `--tz`.

`--json`: the same data as a JSON object `{ session, orders: [...],
summary: {...} }` for downstream tooling.

## Code structure

Zero runtime dependencies; Node 20+ built-ins only (`util.parseArgs`,
`node:test`, `Intl` for timezone handling).

```
package.json          — name, bin entry, type: module
src/cli.js            — parseArgs, wiring, exit codes
src/parse-csv.js      — CSV text → [{time, open, high, low, close}]
src/orders.js         — load + validate orders JSON
src/session.js        — timezone-aware day filtering, latest-day detection
src/engine.js         — pure simulation (candles + orders → results), no I/O
src/report.js         — table and JSON formatting
test/*.test.js        — node:test unit suites
```

`src/engine.js` is pure (arrays in, results out) so future work — other
timeframes, strategy-generated orders, batch runs — can reuse it directly.

## Error handling

Missing/unreadable files, malformed CSV rows, invalid order objects, unknown
flags, and empty day selections each produce a one-line stderr message and a
non-zero exit code. No partial output on error.

## Testing

TDD with `node:test`. Engine tests use small synthetic candle arrays covering:

- order never touched → `NOT_FILLED`
- fill then TP; fill then SL (long and short)
- ambiguous candle spanning both SL and TP → SL wins
- fill and exit within the same candle
- open at end of day → `EOD` close at last close
- validation rejections (bad SL/TP ordering, malformed CSV)

Parser, session filtering, and order validation each get their own suite. The
CLI is smoke-tested end-to-end against a fixture CSV.
