# Ingest Ticker Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `backtest ingest` CLI subcommand that folds new candle CSVs from `ticker-data/incoming/` into the correct monthly OHLC file, appending only rows newer than each file's current data, plus a thin `/ingest-ticker-data` skill that runs it and commits the result.

**Architecture:** A new deterministic command module `src/ingest-command.js` (mirroring `src/scoreboard-command.js`) reads every `*.csv` in an inbox dir, buckets rows to `mes_<month>.csv` by their `time` interpreted in the session timezone, appends only rows strictly newer than each target file's max `time`, and deletes each inbox file on success. Rows are appended verbatim at the raw-line level so indicator columns are preserved. A local `.claude/skills/ingest-ticker-data/SKILL.md` wraps the command and commits.

**Tech Stack:** Node.js ≥20 (ESM), `node:util` `parseArgs`, `node:fs`, `Intl.DateTimeFormat` via the existing `src/session.js` `dateForTimestamp` helper, `node --test`.

---

## File Structure

- **Create** `src/ingest-command.js` — exports `runIngest(args)`, plus pure helpers `monthFileForTimestamp(unixSeconds, tz)` and `readRawCsv(text)`. One responsibility: turn inbox CSVs into appended monthly files.
- **Modify** `src/cli.js` — dispatch `ingest` to `runIngest`; add a USAGE line.
- **Create** `test/ingest-command.test.js` — spawns the CLI against temp inbox/out dirs (same pattern as `test/scoreboard-command.test.js`).
- **Create** `.claude/skills/ingest-ticker-data/SKILL.md` — the wrapper skill.

Design notes that constrain the code:
- The existing `src/parse-csv.js` **drops** indicator columns, so it must NOT be used for the append path. `readRawCsv` keeps each data line verbatim and only parses the `time` cell.
- Month bucketing uses `dateForTimestamp(unix, tz)` (returns `YYYY-MM-DD` in `tz`) → month name. Default `tz` is `America/New_York`, matching `run-command.js`. This is load-bearing: candle `1785556500` is `2026-07-31 23:55` ET but `2026-08-01 03:55` UTC; it must bucket to July.
- Each inbox file is fully validated (headers match, `time` cells parse) **before any write for that file**, so a mismatch aborts with no partial writes.
- Target-file state is re-read per inbox file, so two inbox files touching the same month stay correct.

---

### Task 1: Pure helpers — `monthFileForTimestamp` and `readRawCsv`

**Files:**
- Create: `src/ingest-command.js`
- Test: `test/ingest-command.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/ingest-command.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthFileForTimestamp, readRawCsv } from '../src/ingest-command.js';

const TZ = 'America/New_York';

test('monthFileForTimestamp buckets by the session timezone, not UTC', () => {
  // 2026-07-01 00:00 ET
  assert.equal(monthFileForTimestamp(1782878400, TZ), 'mes_july.csv');
  // 2026-08-01 00:00 ET
  assert.equal(monthFileForTimestamp(1785556800, TZ), 'mes_august.csv');
  // 2026-07-31 23:55 ET === 2026-08-01 03:55 UTC -> July, proving ET bucketing
  assert.equal(monthFileForTimestamp(1785556500, TZ), 'mes_july.csv');
});

test('readRawCsv keeps data lines verbatim and parses the time cell', () => {
  const text = [
    'time,open,high,low,close,Internal Higher High,@valuewhen',
    '200,2,2,2,2,foo,bar',
    '100,1,1,1,1,,',
  ].join('\n');
  const { header, rows } = readRawCsv(text);
  assert.equal(header, 'time,open,high,low,close,Internal Higher High,@valuewhen');
  assert.deepEqual(rows, [
    { time: 200, line: '200,2,2,2,2,foo,bar' },
    { time: 100, line: '100,1,1,1,1,,' },
  ]);
});

test('readRawCsv locates time even when it is not the first column', () => {
  const { rows } = readRawCsv('open,time\n1,150');
  assert.deepEqual(rows, [{ time: 150, line: '1,150' }]);
});

test('readRawCsv throws when the time column is missing', () => {
  assert.throws(() => readRawCsv('open,high\n1,2'), /missing required column: time/);
});

test('readRawCsv throws on a non-numeric time cell, citing the line number', () => {
  assert.throws(() => readRawCsv('time,open\n100,1\nx,2'), /line 3: invalid time value "x"/);
});

test('readRawCsv returns no rows for a header-only file', () => {
  assert.deepEqual(readRawCsv('time,open').rows, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ingest-command.test.js`
Expected: FAIL — `Cannot find module '../src/ingest-command.js'` (or export not defined).

- [ ] **Step 3: Write minimal implementation**

Create `src/ingest-command.js` with just the helpers:

```js
import { dateForTimestamp } from './session.js';

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

// Monthly file name for a candle, bucketed by month in the session timezone.
// dateForTimestamp returns YYYY-MM-DD; the MM segment selects the month name.
export function monthFileForTimestamp(unixSeconds, tz) {
  const month = Number(dateForTimestamp(unixSeconds, tz).slice(5, 7));
  return `mes_${MONTHS[month - 1]}.csv`;
}

// Splits TradingView-style CSV text into { header, rows }, keeping every data
// line verbatim (so indicator columns survive) and parsing only the time cell.
// Blank lines are ignored. Throws on a missing time column or an unparseable
// time cell. A header-only file yields rows: [].
export function readRawCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = lines[0] ?? '';
  const timeIdx = header.split(',').map((h) => h.trim().toLowerCase()).indexOf('time');
  if (timeIdx === -1) throw new Error('CSV missing required column: time');
  const rows = lines.slice(1).map((line, i) => {
    const raw = line.split(',')[timeIdx];
    const time = Number(raw);
    if (raw === undefined || raw.trim() === '' || !Number.isFinite(time)) {
      throw new Error(`CSV line ${i + 2}: invalid time value "${raw ?? ''}"`);
    }
    return { time, line };
  });
  return { header, rows };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/ingest-command.test.js`
Expected: PASS (6 helper tests).

- [ ] **Step 5: Commit**

```bash
git add src/ingest-command.js test/ingest-command.test.js
git commit -m "feat: add month-bucket and raw-CSV helpers for ingest"
```

---

### Task 2: `runIngest` core + CLI wiring — create month file, append newer-only, skip overlap

**Files:**
- Modify: `src/ingest-command.js`
- Modify: `src/cli.js`
- Test: `test/ingest-command.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/ingest-command.test.js` (add the new imports at the top of the file: `spawnSync`, `mkdtempSync`, `mkdirSync`, `writeFileSync`, `readFileSync`, `existsSync`, `rmSync`, `tmpdir`, `join`, `fileURLToPath`):

```js
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const HEADER = 'time,open,high,low,close,Internal Higher High,@valuewhen';

// Builds a temp inbox + out dir pair and returns paths plus a runner.
function harness(t) {
  const root = mkdtempSync(join(tmpdir(), 'ingest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const incoming = join(root, 'incoming');
  const out = join(root, 'out');
  mkdirSync(incoming, { recursive: true });
  mkdirSync(out, { recursive: true });
  const run = () =>
    spawnSync(
      process.execPath,
      [cli, 'ingest', '--incoming', incoming, '--out', out, '--tz', 'America/New_York'],
      { encoding: 'utf8' }
    );
  return { incoming, out, run };
}

test('creates a new monthly file with header + all rows when none exists', (t) => {
  const { incoming, out, run } = harness(t);
  writeFileSync(join(incoming, 'new.csv'), `${HEADER}\n1782878400,7532.5,7532.75,7528.25,7529.75,foo,bar\n`);
  const proc = run();
  assert.equal(proc.status, 0, proc.stderr);
  const written = readFileSync(join(out, 'mes_july.csv'), 'utf8');
  assert.equal(written, `${HEADER}\n1782878400,7532.5,7532.75,7528.25,7529.75,foo,bar\n`);
  assert.match(proc.stdout, /mes_july\.csv: created, \+1 rows, 0 skipped/);
});

test('appends only rows strictly newer than the current max, keeping sort order', (t) => {
  const { incoming, out, run } = harness(t);
  writeFileSync(join(out, 'mes_july.csv'), `${HEADER}\n1782878400,1,1,1,1,,\n1782878700,2,2,2,2,,\n`);
  // Incoming has an older row, the boundary row (==max), and two newer rows, out of order.
  writeFileSync(
    join(incoming, 'more.csv'),
    `${HEADER}\n1782879300,4,4,4,4,,\n1782878700,2,2,2,2,,\n1782879000,3,3,3,3,,\n1782878500,1,1,1,1,,\n` // 1782878500 is still July 1 ET and <= max, so it is a skip (not a June row)
  );
  const proc = run();
  assert.equal(proc.status, 0, proc.stderr);
  const written = readFileSync(join(out, 'mes_july.csv'), 'utf8');
  assert.equal(
    written,
    `${HEADER}\n1782878400,1,1,1,1,,\n1782878700,2,2,2,2,,\n1782879000,3,3,3,3,,\n1782879300,4,4,4,4,,\n`
  );
  assert.match(proc.stdout, /mes_july\.csv: appended, \+2 rows, 2 skipped/);
});

test('preserves indicator columns verbatim on append', (t) => {
  const { incoming, out, run } = harness(t);
  writeFileSync(join(out, 'mes_july.csv'), `${HEADER}\n1782878400,1,1,1,1,,\n`);
  writeFileSync(join(incoming, 'ind.csv'), `${HEADER}\n1782878700,2,2,2,2,keepme,alsokeep\n`);
  assert.equal(run().status, 0);
  assert.match(readFileSync(join(out, 'mes_july.csv'), 'utf8'), /1782878700,2,2,2,2,keepme,alsokeep/);
});

test('deletes each inbox file after a successful append', (t) => {
  const { incoming, out, run } = harness(t);
  writeFileSync(join(incoming, 'gone.csv'), `${HEADER}\n1782878400,1,1,1,1,,\n`);
  assert.equal(run().status, 0);
  assert.equal(existsSync(join(incoming, 'gone.csv')), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ingest-command.test.js`
Expected: FAIL — the CLI prints `Unknown command "ingest"` and exits 1, so `proc.status === 1`.

- [ ] **Step 3: Write the implementation (command module + CLI wiring together, so the tests go green in one commit)**

First add imports and `runIngest` to `src/ingest-command.js` (keep the Task 1 helpers). Full file after this step:

```js
import { existsSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { dateForTimestamp } from './session.js';

const DEFAULT_INCOMING = 'ticker-data/incoming';
const DEFAULT_OUT = 'ticker-data/MES/min-5';
const DEFAULT_TZ = 'America/New_York';

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

export function monthFileForTimestamp(unixSeconds, tz) {
  const month = Number(dateForTimestamp(unixSeconds, tz).slice(5, 7));
  return `mes_${MONTHS[month - 1]}.csv`;
}

export function readRawCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = lines[0] ?? '';
  const timeIdx = header.split(',').map((h) => h.trim().toLowerCase()).indexOf('time');
  if (timeIdx === -1) throw new Error('CSV missing required column: time');
  const rows = lines.slice(1).map((line, i) => {
    const raw = line.split(',')[timeIdx];
    const time = Number(raw);
    if (raw === undefined || raw.trim() === '' || !Number.isFinite(time)) {
      throw new Error(`CSV line ${i + 2}: invalid time value "${raw ?? ''}"`);
    }
    return { time, line };
  });
  return { header, rows };
}

// Reads inbox CSVs and appends only newer rows into the matching monthly file.
export function runIngest(args) {
  const { values } = parseArgs({
    args,
    options: {
      incoming: { type: 'string', default: DEFAULT_INCOMING },
      out: { type: 'string', default: DEFAULT_OUT },
      tz: { type: 'string', default: DEFAULT_TZ },
    },
  });
  const { incoming, out, tz } = values;

  if (!existsSync(incoming)) {
    console.log('nothing to ingest');
    return;
  }
  const inboxFiles = readdirSync(incoming).filter((f) => f.endsWith('.csv')).sort();
  if (inboxFiles.length === 0) {
    console.log('nothing to ingest');
    return;
  }

  const summary = [];
  for (const fileName of inboxFiles) {
    const inboxPath = join(incoming, fileName);
    const { header, rows } = readRawCsv(readFileSync(inboxPath, 'utf8'));
    if (rows.length === 0) {
      console.warn(`warning: ${inboxPath} has no data rows — leaving it in place`);
      continue;
    }

    // Group this file's rows by their target monthly file.
    const byMonth = new Map();
    for (const row of rows) {
      const monthFile = monthFileForTimestamp(row.time, tz);
      if (!byMonth.has(monthFile)) byMonth.set(monthFile, []);
      byMonth.get(monthFile).push(row);
    }

    // Validate + plan every month BEFORE writing anything for this file.
    const plans = [];
    for (const [monthFile, monthRows] of byMonth) {
      const outPath = join(out, monthFile);
      let created = true;
      let maxTime = -Infinity;
      let existingBody = null;
      if (existsSync(outPath)) {
        created = false;
        existingBody = readFileSync(outPath, 'utf8');
        const existing = readRawCsv(existingBody);
        if (existing.header !== header) {
          throw new Error(
            `${inboxPath}: header does not match ${outPath}\n` +
              `  inbox:    ${header}\n  existing: ${existing.header}`
          );
        }
        for (const r of existing.rows) if (r.time > maxTime) maxTime = r.time;
      }
      const fresh = monthRows.filter((r) => r.time > maxTime).sort((a, b) => a.time - b.time);
      plans.push({ outPath, monthFile, created, existingBody, fresh, skipped: monthRows.length - fresh.length });
    }

    // All months validated — now write.
    for (const p of plans) {
      if (p.created) {
        writeFileSync(p.outPath, [header, ...p.fresh.map((r) => r.line)].join('\n') + '\n');
      } else if (p.fresh.length > 0) {
        const base = p.existingBody.replace(/\n+$/, '');
        writeFileSync(p.outPath, base + '\n' + p.fresh.map((r) => r.line).join('\n') + '\n');
      }
      summary.push(
        `${p.monthFile}: ${p.created ? 'created' : 'appended'}, ` +
          `+${p.fresh.length} rows, ${p.skipped} skipped (not newer)`
      );
    }

    rmSync(inboxPath);
  }

  for (const line of summary) console.log(line);
}
```

Then wire the subcommand into `src/cli.js`. Add the import near the other command imports:

```js
import { runIngest } from './ingest-command.js';
```

Add a branch in the dispatch chain (alongside `run`/`transcript`/`scoreboard`):

```js
  } else if (first === 'ingest') {
    runIngest(rest);
```

Add a line to the `USAGE` string's command list:

```
  ingest      Append new candles from ticker-data/incoming/ into monthly files
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/ingest-command.test.js`
Expected: PASS — all six Task 1 helper tests and all four Task 2 CLI tests are green.

- [ ] **Step 5: Add a CLI smoke test for the subcommand**

Append to `test/cli.test.js` (reuse its existing spawn helper if present; otherwise this self-contained test):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('ingest subcommand reports an empty inbox and exits 0', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-ingest-'));
  const incoming = join(dir, 'incoming');
  mkdirSync(incoming, { recursive: true });
  const proc = spawnSync(
    process.execPath,
    [cliPath, 'ingest', '--incoming', incoming, '--out', join(dir, 'out')],
    { encoding: 'utf8' }
  );
  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /nothing to ingest/);
});
```

- [ ] **Step 6: Run the full suite to verify it passes**

Run: `node --test`
Expected: PASS — the whole suite, including the new CLI smoke test.

- [ ] **Step 7: Commit**

```bash
git add src/ingest-command.js src/cli.js test/ingest-command.test.js test/cli.test.js
git commit -m "feat: implement ingest subcommand (core + CLI wiring)"
```

---

### Task 3: Routing correctness — month-spanning, ET boundary, two files same month

**Files:**
- Test: `test/ingest-command.test.js`

These assert behavior already implemented in Task 2; they lock in the routing rules. If any fail, fix `runIngest` rather than the test.

- [ ] **Step 1: Write the tests**

Append to `test/ingest-command.test.js`:

```js
test('splits one inbox file across two monthly files by month', (t) => {
  const { incoming, out, run } = harness(t);
  writeFileSync(
    join(incoming, 'span.csv'),
    `${HEADER}\n1782878400,1,1,1,1,,\n1785556800,9,9,9,9,,\n` // 2026-07-01 and 2026-08-01 ET
  );
  assert.equal(run().status, 0);
  assert.match(readFileSync(join(out, 'mes_july.csv'), 'utf8'), /1782878400,1,1,1,1,,/);
  assert.match(readFileSync(join(out, 'mes_august.csv'), 'utf8'), /1785556800,9,9,9,9,,/);
});

test('buckets a late-July ET candle to July even though it is August in UTC', (t) => {
  const { incoming, out, run } = harness(t);
  // 1785556500 === 2026-07-31 23:55 ET === 2026-08-01 03:55 UTC
  writeFileSync(join(incoming, 'boundary.csv'), `${HEADER}\n1785556500,5,5,5,5,,\n`);
  assert.equal(run().status, 0);
  assert.equal(existsSync(join(out, 'mes_august.csv')), false);
  assert.match(readFileSync(join(out, 'mes_july.csv'), 'utf8'), /1785556500,5,5,5,5,,/);
});

test('a second inbox file compares against the max raised by the first', (t) => {
  const { incoming, out, run } = harness(t);
  // Lexicographic order: a.csv processed before b.csv.
  writeFileSync(join(incoming, 'a.csv'), `${HEADER}\n1782878400,1,1,1,1,,\n`);
  writeFileSync(join(incoming, 'b.csv'), `${HEADER}\n1782878700,2,2,2,2,,\n1782878400,1,1,1,1,,\n`);
  assert.equal(run().status, 0);
  assert.equal(
    readFileSync(join(out, 'mes_july.csv'), 'utf8'),
    `${HEADER}\n1782878400,1,1,1,1,,\n1782878700,2,2,2,2,,\n`
  );
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `node --test test/ingest-command.test.js`
Expected: PASS. If the two-file test fails, confirm `runIngest` re-reads `outPath` per inbox file (it does — `existsSync`/`readFileSync` are inside the per-file loop).

- [ ] **Step 3: Commit**

```bash
git add test/ingest-command.test.js
git commit -m "test: cover month-spanning, ET boundary, and cross-file dedup"
```

---

### Task 4: Error + edge cases — header mismatch, empty inbox, header-only file

**Files:**
- Test: `test/ingest-command.test.js`

- [ ] **Step 1: Write the tests**

Append to `test/ingest-command.test.js`:

```js
test('aborts with non-zero exit and no write when headers do not match', (t) => {
  const { incoming, out, run } = harness(t);
  const existing = `time,open,high,low,close\n1782878400,1,1,1,1\n`;
  writeFileSync(join(out, 'mes_july.csv'), existing);
  writeFileSync(join(incoming, 'bad.csv'), `${HEADER}\n1782878700,2,2,2,2,,\n`);
  const proc = run();
  assert.notEqual(proc.status, 0);
  assert.match(proc.stderr, /header does not match/);
  assert.equal(readFileSync(join(out, 'mes_july.csv'), 'utf8'), existing); // unchanged
  assert.equal(existsSync(join(incoming, 'bad.csv')), true); // retained for retry
});

test('reports nothing to ingest for an empty inbox', (t) => {
  const { run } = harness(t);
  const proc = run();
  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /nothing to ingest/);
});

test('warns and leaves a header-only inbox file in place', (t) => {
  const { incoming, out, run } = harness(t);
  writeFileSync(join(incoming, 'headeronly.csv'), `${HEADER}\n`);
  const proc = run();
  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stderr, /no data rows — leaving it in place/);
  assert.equal(existsSync(join(incoming, 'headeronly.csv')), true);
  assert.equal(existsSync(join(out, 'mes_july.csv')), false);
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `node --test test/ingest-command.test.js`
Expected: PASS. The CLI already exits 1 on a thrown error (the `catch` block in `cli.js` prints `err.message` and calls `process.exit(1)`), so the header-mismatch throw surfaces as `status !== 0` with the message on stderr.

- [ ] **Step 3: Commit**

```bash
git add test/ingest-command.test.js
git commit -m "test: cover header mismatch, empty inbox, and header-only file"
```

---

### Task 5: The `ingest-ticker-data` skill

**Files:**
- Create: `.claude/skills/ingest-ticker-data/SKILL.md`

- [ ] **Step 1: Write the skill file**

Create `.claude/skills/ingest-ticker-data/SKILL.md` with this exact content:

````markdown
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
````

- [ ] **Step 2: Verify the skill loads**

Run: `node --test`
Expected: PASS (unchanged — the skill file does not affect tests). Confirm the file exists:
Run: `test -f .claude/skills/ingest-ticker-data/SKILL.md && echo OK`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/ingest-ticker-data/SKILL.md
git commit -m "feat: add ingest-ticker-data skill wrapping the ingest command"
```

---

## Final Verification

- [ ] Run the full suite: `node --test` → all tests pass.
- [ ] Manual smoke test:

```bash
mkdir -p ticker-data/incoming
printf 'time,open,high,low,close,Internal Higher High,@valuewhen\n1784260800,7524.25,7525,7523,7524,,\n' > ticker-data/incoming/smoke.csv
node src/cli.js ingest
# Expect: "mes_july.csv: appended, +1 rows, 0 skipped (not newer)"
# Expect: ticker-data/incoming/smoke.csv is gone; the new row is the last line of mes_july.csv
git checkout ticker-data/MES/min-5/mes_july.csv   # revert the smoke-test row
rm -f ticker-data/incoming/smoke.csv 2>/dev/null; rmdir ticker-data/incoming 2>/dev/null || true
```

(`1784260800` is 5 minutes after the current last July candle, so it appends cleanly.)
