---
name: ingest-ticker-data
description: Use when new OHLC candle CSVs need to be folded into the monthly ticker files the backtester reads — e.g. the user says to ingest, import, or append new ticker/candle data, or has dropped CSVs into ticker-data/incoming/.
---

# Ingest Ticker Data

Fold new candle CSVs from `ticker-data/incoming/` into the correct
`ticker-data/MES/min-5/mes_<month>.csv`, appending only rows newer than each
file's current data, then commit. The `backtest ingest` subcommand does the
deterministic work; this skill runs it, surfaces the result, and commits.

## When to Use

- New candle data has been dropped into `ticker-data/incoming/` and needs to be
  merged into the monthly OHLC files.
- The user asks to ingest / import / append / merge new ticker or candle data.
- NOT for editing existing rows, back-filling gaps earlier than the current
  data, or any ticker other than MES 5-minute (out of scope for the command).

## Steps

1. **Preflight.** Confirm `ticker-data/incoming/` exists and contains at least
   one `*.csv`. If it is missing or empty, stop and tell the user exactly that —
   there is nothing to ingest.
2. **Run the command** from the repo root:
   `node src/cli.js ingest`
3. **Surface the result.** Show the user the command's summary verbatim — the
   per-month `created`/`appended`, rows added, and rows skipped. If the command
   exits non-zero (e.g. a header mismatch), STOP: report the error and do not
   commit. The offending inbox file is intentionally left in place for retry.
4. **Commit** the changes with a semantic message describing what was ingested,
   e.g. `data: ingest 42 new MES 5-min candles into mes_july.csv`. Stage the
   updated `ticker-data/MES/min-5/*.csv` and the removed inbox file(s). Do not
   add any Claude Code attribution to the message.

## Common Mistakes

- Committing after a non-zero exit → The command aborts on validation errors
  with no partial writes. A non-zero exit means nothing changed; fix the input
  and re-run instead of committing.
- Re-adding data that was skipped → "skipped (not newer)" is correct behavior,
  not an error. Only rows strictly newer than a file's last candle are appended.
- Expecting UTC month boundaries → Rows are bucketed by month in
  `America/New_York`, matching how the backtester reads sessions.
