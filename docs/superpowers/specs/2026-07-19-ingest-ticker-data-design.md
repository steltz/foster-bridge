# Design: `ingest` subcommand + `ingest-ticker-data` skill

**Date:** 2026-07-19
**Status:** Approved

## Problem

New OHLC candle exports arrive periodically as TradingView-style CSVs with the
same columns as the monthly ticker files the backtester reads
(`ticker-data/MES/min-5/mes_<month>.csv`). Today there is no supported way to
fold that new data into the existing monthly file. We want to drop a new CSV
into an inbox, look at only the rows that are actually new, and append them to
the correct monthly file — losslessly, deterministically, and idempotently.

## Existing context

- The CLI (`src/cli.js`) dispatches subcommands: `run`, `transcript`,
  `scoreboard`. Each has a `*-command.js` module exporting a `run<Name>`
  function. `ingest` follows the same shape (`src/ingest-command.js`).
- Monthly files are TradingView exports: header row `time,open,high,low,close,`
  plus ~15 indicator columns; data rows are 5-minute candles; `time` is a unix
  epoch (seconds); rows are sorted ascending by `time`.
- `src/parse-csv.js` intentionally **drops** every column except OHLC. Ingest
  must NOT use it for the append path — it would lose the indicator columns.
  Ingest works at the raw-line level and only parses the `time` column.
- `ticker-data/` is git-tracked (`.gitignore` only excludes `.worktrees/` and
  `node_modules/`).
- Month bucketing must use the **session timezone `America/New_York`**, not
  UTC. Verified: the current file's first candle `1782878400` is exactly
  `2026-07-01 00:00 America/New_York`, and its last `1784260500` is
  `2026-07-16 23:55 ET` = `2026-07-17 03:55 UTC`. UTC bucketing would leak
  late-July ET candles into an August file.

## Decisions (from brainstorming)

| Question | Decision |
|----------|----------|
| Input source | Fixed inbox dir: `ticker-data/incoming/` |
| Month target | Derive from each row's `time` (in ET) → `mes_<month>.csv` |
| Dedup / append rule | Only rows strictly newer than the month file's current max `time` |
| Architecture | New deterministic CLI subcommand + thin skill wrapping it |
| Post-ingest cleanup | Delete each inbox file after a successful append |
| Ticker scope | MES / min-5 only (hardcoded path) |
| Auto-commit | Skill commits updated monthly CSV(s) with a semantic message |

## Component 1 — `backtest ingest` (`src/ingest-command.js`)

Exports `runIngest(args)`, wired into `src/cli.js` (`else if (first === 'ingest')`).

**Options (via `parseArgs`):**
- `--tz <IANA>` — timezone for month bucketing. Default `America/New_York`.
  (Present so tests can bucket deterministically and so the boundary rule is
  explicit; no other tz is expected in normal use.)
- `--incoming <dir>` — inbox directory. Default `ticker-data/incoming/`.
  (Injectable so tests run against a temp dir.)
- `--out <dir>` — monthly-files directory. Default `ticker-data/MES/min-5/`.
  (Injectable for tests.)

**Algorithm:**

1. If `--incoming` does not exist or contains no `*.csv`, print
   `nothing to ingest` and return (exit 0).
2. For each inbox `*.csv` (lexicographic order), processed independently:
   a. Read raw text; split into lines; drop blank lines. Fewer than 2
      non-blank lines (header only / empty) → **warn and leave the file in
      place** (looks like a mistake), continue to next file.
   b. Header = first line. Locate the `time` column index (case-insensitive,
      trimmed). Missing `time` column → error, leave file in place, non-zero
      exit.
   c. For each data line, parse the `time` cell as a finite integer; invalid
      → error citing the line number, leave file in place, non-zero exit.
   d. Bucket each data line by month of its `time` in `--tz` →
      `mes_<monthname>.csv` (lowercase full English month name).
   e. For each target month file, **re-read its current state now** (so a
      prior inbox file that already appended to this month is accounted for):
      - Existing file: its header must **exactly equal** this inbox file's
        header (same names, same order). Mismatch → error, leave inbox file
        in place, non-zero exit, no writes. Compute current max `time`.
      - No existing file: this inbox header becomes the new file's header;
        max `time` = −∞ (all rows qualify).
   f. Keep only rows with `time > max`; sort them ascending by `time`; append
      verbatim (raw line text) to the month file. New file = header + rows.
      Guarantee exactly one trailing newline; never introduce blank rows.
   g. After all months for this file are written successfully, **delete** the
      inbox file.
3. Print a summary, one line per touched month file:
   `mes_july.csv: created|appended, +N rows, M skipped (not newer)`.

**Why re-read max per inbox file (2e):** two inbox files can both carry July
rows. Processing file A raises July's max; file B must compare against the new
max, not a stale snapshot. Re-reading is simplest and correct.

**Idempotency:** the newer-only rule means re-running with already-ingested
data appends 0 rows. Combined with delete-on-success, a given file is normally
ingested exactly once.

**Failure isolation:** each inbox file is validated fully before any write for
that file. On any validation error the file is left in place with a non-zero
exit so the operator can fix and retry. Files processed earlier in the run
that already succeeded stay committed (their inbox copies deleted) — the
summary reflects exactly what happened.

## Component 2 — Skill `.claude/skills/ingest-ticker-data/SKILL.md`

Thin technique/utility skill (modeled on the existing `trader-bench` /
`seven-keys` local skills), invoked as `/ingest-ticker-data`.

**Flow:**
1. **Preflight:** confirm `ticker-data/incoming/` exists and holds at least one
   `*.csv`. If not, abort with one specific message.
2. **Run:** `node src/cli.js ingest` from the repo root.
3. **Surface** the CLI summary to the user verbatim (created/appended/skipped
   counts). If the CLI exits non-zero, stop and report the error; do not
   commit.
4. **Commit:** stage the changed `ticker-data/MES/min-5/*.csv` and the removed
   inbox file(s); commit with a semantic message, e.g.
   `data: ingest N new MES 5-min candles into mes_july.csv`. No Claude Code
   attribution in the message (per repo convention).

## Component 3 — Tests (`test/ingest-command.test.js`, `node --test`)

Each test builds a temp `--incoming` and `--out` dir from fixtures and asserts
resulting file contents and the inbox state.

| Case | Assertion |
|------|-----------|
| New-month creation | No existing `mes_<m>.csv` → file created with header + all rows |
| Append newer-only | Rows with `time >` max appended; file stays sorted |
| Overlap skipped | Rows with `time <=` max not appended; counted as skipped |
| Month-spanning input | One inbox file with July+August rows writes to both month files |
| Header mismatch | Existing file header ≠ inbox header → non-zero exit, no write, inbox file retained |
| Empty inbox | `nothing to ingest`, exit 0 |
| Header-only inbox file | Warned, left in place, no write |
| Inbox cleanup | Inbox file deleted after successful append |
| Two inbox files, same month | Second file compares against max raised by the first |
| Indicator columns preserved | Appended lines retain all non-OHLC columns verbatim |

## Non-goals / known MVP limits

- **Single ticker/timeframe:** `ticker-data/MES/min-5/` is the only target.
  Adding tickers/timeframes later means deriving them from the inbox
  filename/subfolder — out of scope now.
- **No year in month filename:** `mes_july.csv` has no year, so July 2026 and
  July 2027 would collide. Acceptable while all data is single-year (2026).
  Documented so it isn't mistaken for a bug.
- **No gap-fill / no back-fill:** only strictly-newer rows are added. Filling
  holes earlier than the current max is out of scope.
- **No reformatting:** rows are appended byte-for-byte from the inbox; ingest
  does not normalize decimals, column order, or the indicator columns.
