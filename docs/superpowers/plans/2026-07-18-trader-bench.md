# Trader Benchmark Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the trader benchmark matrix from `docs/superpowers/specs/2026-07-18-trader-bench-design.md`: a write-once results store at `runs/<trader>/<model>/<day>/run-<k>.json`, a deterministic `scoreboard` CLI subcommand that renders `runs/SCOREBOARD.md`, and a `/trader-bench` skill with idempotent top-up semantics.

**Architecture:** Pure stats/rendering logic in `src/scoreboard.js` (mirrors `report.js` — no I/O), filesystem walk + output in `src/scoreboard-command.js` (mirrors `run-command.js`), wired as a third subcommand in `src/cli.js`. The orchestration lives in `.claude/skills/trader-bench/SKILL.md` and reuses the trader-panel skill's persona envelope, CLI-as-sole-judge rule, and Workflow fan-out pattern, adding the missing-cell computation and per-agent `model` option.

**Tech Stack:** Node ≥20 ESM, `node:test` + `node:assert/strict`, `node:util` `parseArgs`, Claude Code Workflow tool. No new dependencies.

---

## Key domain facts (read before any task)

- A **cell** is one JSON file: one trader × one model alias × one day × one run index. Cells are write-once; the bench only creates missing ones.
- Cell statuses: `TP | SL | EOD | NOT_FILLED` come from the backtest CLI verbatim ("scored"); `INVALID | CLI_ERROR | NO_SETUP` are orchestrator-assigned pipeline errors. `filled` = TP/SL/EOD. All cells, including errors, carry `result.status`; `NO_SETUP` cells have no `setup` key.
- The **group** unit is (trader, model alias). No metric ever sums across groups — that's the never-merge invariant, and there's a test for it.
- Day folders are `MMDDYYYY`; chronological order requires re-keying to `YYYYMMDD` (`d.slice(4) + d.slice(0, 4)`), never lexicographic sort.
- Dollars = points × multiplier (CLI default 5, MES). The scoreboard just trusts the CLI's `points`/`dollars`.

### Cell schema (fixture builders and the skill both produce exactly this)

```json
{
  "trader": "context-trader",
  "model": { "alias": "fable", "id": "claude-fable-5" },
  "day": "07152026",
  "date": "2026-07-15",
  "runIndex": 3,
  "timestamp": "2026-07-18T14:00:00.000Z",
  "personaSha256": "abc123…",
  "setup": { "side": "long", "entry": 7574, "stopLoss": 7563.25, "takeProfit": 7606.25, "rationale": "…" },
  "result": { "status": "TP", "points": 32.25, "dollars": 161.25, "fillTime": 1784112300, "exitTime": 1784116500 },
  "note": "only present on INVALID / CLI_ERROR"
}
```

---

### Task 1: `computeScoreboard` — grouping and statistics (pure logic)

**Files:**
- Create: `src/scoreboard.js`
- Create: `test/scoreboard.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/scoreboard.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeScoreboard } from '../src/scoreboard.js';

// Minimal cell factory; override any field per test.
function cell(overrides = {}) {
  return {
    trader: 'context-trader',
    model: { alias: 'fable', id: 'claude-fable-5' },
    day: '07012026',
    date: '2026-07-01',
    runIndex: 1,
    timestamp: '2026-07-18T14:00:00.000Z',
    personaSha256: 'aaa',
    setup: { side: 'long', entry: 7500, stopLoss: 7490, takeProfit: 7530, rationale: 'r' },
    result: { status: 'TP', points: 30, dollars: 150 },
    ...overrides,
  };
}

test('groups by (trader, model alias) and never merges across groups', () => {
  const cells = [
    cell({ trader: 'a', model: { alias: 'fable', id: 'x' } }),
    cell({ trader: 'a', model: { alias: 'sonnet', id: 'y' } }),
    cell({ trader: 'b', model: { alias: 'fable', id: 'x' } }),
    cell({ trader: 'b', model: { alias: 'sonnet', id: 'y' } }),
  ];
  const { groups } = computeScoreboard(cells);
  assert.equal(groups.length, 4);
  for (const g of groups) {
    assert.equal(g.cellCount, 1);
    assert.equal(g.meanDollars, 150); // each group's mean comes only from its own single cell
  }
});

test('per-run totals sum filled cells across days; NOT_FILLED scores zero', () => {
  const cells = [
    cell({ day: '07012026', runIndex: 1, result: { status: 'TP', points: 10, dollars: 50 } }),
    cell({ day: '07022026', runIndex: 1, result: { status: 'SL', points: -8, dollars: -40 } }),
    cell({ day: '07012026', runIndex: 2, result: { status: 'NOT_FILLED', points: null, dollars: null } }),
    cell({ day: '07022026', runIndex: 2, result: { status: 'TP', points: 20, dollars: 100 } }),
  ];
  const { groups } = computeScoreboard(cells);
  assert.equal(groups.length, 1);
  const g = groups[0];
  assert.deepEqual(
    g.runTotals,
    [
      { runIndex: 1, days: 2, points: 2, dollars: 10 },
      { runIndex: 2, days: 2, points: 20, dollars: 100 },
    ]
  );
  assert.equal(g.meanDollars, 55);
  assert.equal(g.minRunDollars, 10);
  assert.equal(g.maxRunDollars, 100);
  // sample std dev of [10, 100] = |100-55| * sqrt(2) ≈ 63.639…
  assert.ok(Math.abs(g.stdDollars - 63.63961030678928) < 1e-9);
});

test('win/fill rates: EOD at zero points is filled but neither win nor loss', () => {
  const cells = [
    cell({ runIndex: 1, result: { status: 'TP', points: 10, dollars: 50 } }),
    cell({ runIndex: 2, result: { status: 'SL', points: -5, dollars: -25 } }),
    cell({ runIndex: 3, result: { status: 'EOD', points: 0, dollars: 0 } }),
    cell({ runIndex: 4, result: { status: 'NOT_FILLED', points: null, dollars: null } }),
  ];
  const g = computeScoreboard(cells).groups[0];
  assert.equal(g.filledCount, 3);
  assert.equal(g.scoredCount, 4);
  assert.equal(g.winCount, 1);
  assert.equal(g.lossCount, 1);
  assert.equal(g.winRate, 1 / 3);
  assert.equal(g.fillRate, 3 / 4);
  assert.equal(g.avgWinPoints, 10);
  assert.equal(g.avgLossPoints, -5);
});

test('rates are null (not NaN) when there is nothing to rate', () => {
  const g = computeScoreboard([
    cell({ result: { status: 'NOT_FILLED', points: null, dollars: null } }),
  ]).groups[0];
  assert.equal(g.winRate, null);
  assert.equal(g.fillRate, 0);
  assert.equal(g.avgWinPoints, null);
  assert.equal(g.avgLossPoints, null);
});

test('pipeline errors are listed and excluded from scored counts', () => {
  const cells = [
    cell({ runIndex: 1 }),
    cell({ runIndex: 2, setup: undefined, result: { status: 'NO_SETUP' } }),
    cell({ runIndex: 3, result: { status: 'INVALID' }, note: 'long requires stopLoss < entry < takeProfit' }),
  ];
  const g = computeScoreboard(cells).groups[0];
  assert.equal(g.scoredCount, 1);
  assert.deepEqual(g.errors, [
    { day: '07012026', runIndex: 2, status: 'NO_SETUP', note: undefined },
    { day: '07012026', runIndex: 3, status: 'INVALID', note: 'long requires stopLoss < entry < takeProfit' },
  ]);
});

test('setup stability: side counts and entry spread per day, days in chronological order', () => {
  const cells = [
    // 12312025 sorts before 07012026 chronologically, after it lexicographically
    cell({ day: '12312025', runIndex: 1, setup: { side: 'long', entry: 7500, stopLoss: 7490, takeProfit: 7530, rationale: 'r' } }),
    cell({ day: '07012026', runIndex: 1, setup: { side: 'long', entry: 7500, stopLoss: 7490, takeProfit: 7530, rationale: 'r' } }),
    cell({ day: '07012026', runIndex: 2, setup: { side: 'short', entry: 7503, stopLoss: 7513, takeProfit: 7480, rationale: 'r' } }),
    cell({ day: '07012026', runIndex: 3, setup: undefined, result: { status: 'NO_SETUP' } }),
  ];
  const g = computeScoreboard(cells).groups[0];
  assert.deepEqual(g.days, ['12312025', '07012026']);
  assert.deepEqual(g.stability, [
    { day: '12312025', runs: 1, long: 1, short: 0, entrySpread: 0 },
    { day: '07012026', runs: 3, long: 1, short: 1, entrySpread: 3 },
  ]);
});

test('ranking sorts groups by mean dollars descending and reports maxCells', () => {
  const cells = [
    cell({ trader: 'loser', result: { status: 'SL', points: -10, dollars: -50 } }),
    cell({ trader: 'winner', runIndex: 1 }),
    cell({ trader: 'winner', runIndex: 2 }),
  ];
  const { groups, maxCells } = computeScoreboard(cells);
  assert.deepEqual(groups.map((g) => g.trader), ['winner', 'loser']);
  assert.equal(maxCells, 2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/scoreboard.test.js`
Expected: FAIL — `Cannot find module '../src/scoreboard.js'`

- [ ] **Step 3: Implement `computeScoreboard`**

Create `src/scoreboard.js`:

```js
// Pure scoreboard computation and rendering for benchmark cells.
// The comparable unit is the (trader, model-alias) group; no metric ever
// sums across groups — the user runs one trader live and picks it here.

const SCORED = new Set(['TP', 'SL', 'EOD', 'NOT_FILLED']);
const FILLED = new Set(['TP', 'SL', 'EOD']);

// Day folders are MMDDYYYY; chronological order needs YYYYMMDD.
const rekey = (day) => day.slice(4) + day.slice(0, 4);

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

function sampleStd(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

export function computeScoreboard(cells) {
  const byGroup = new Map();
  for (const c of cells) {
    const key = JSON.stringify([c.trader, c.model.alias]);
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(c);
  }
  const groups = [...byGroup.values()].map(summarizeGroup);
  groups.sort((a, b) => b.meanDollars - a.meanDollars);
  const maxCells = groups.reduce((m, g) => Math.max(m, g.cellCount), 0);
  return { groups, maxCells };
}

function summarizeGroup(cells) {
  const { trader } = cells[0];
  const model = cells[0].model.alias;
  const days = [...new Set(cells.map((c) => c.day))].sort((a, b) =>
    rekey(a).localeCompare(rekey(b))
  );
  const runIndices = [...new Set(cells.map((c) => c.runIndex))].sort((a, b) => a - b);

  const runTotals = runIndices.map((runIndex) => {
    const runCells = cells.filter((c) => c.runIndex === runIndex);
    let points = 0;
    let dollars = 0;
    for (const c of runCells) {
      if (FILLED.has(c.result.status)) {
        points += c.result.points ?? 0;
        dollars += c.result.dollars ?? 0;
      }
    }
    return { runIndex, days: runCells.length, points, dollars };
  });

  const dollarSeries = runTotals.map((r) => r.dollars);
  const scored = cells.filter((c) => SCORED.has(c.result.status));
  const filled = cells.filter((c) => FILLED.has(c.result.status));
  const wins = filled.filter((c) => c.result.points > 0);
  const losses = filled.filter((c) => c.result.points < 0);

  const stability = days.map((day) => {
    const withSetup = cells.filter((c) => c.day === day && c.setup);
    const entries = withSetup.map((c) => c.setup.entry);
    return {
      day,
      runs: cells.filter((c) => c.day === day).length,
      long: withSetup.filter((c) => c.setup.side === 'long').length,
      short: withSetup.filter((c) => c.setup.side === 'short').length,
      entrySpread: entries.length > 1 ? Math.max(...entries) - Math.min(...entries) : 0,
    };
  });

  const errors = cells
    .filter((c) => !SCORED.has(c.result.status))
    .sort((a, b) => rekey(a.day).localeCompare(rekey(b.day)) || a.runIndex - b.runIndex)
    .map((c) => ({ day: c.day, runIndex: c.runIndex, status: c.result.status, note: c.note }));

  return {
    trader,
    model,
    cellCount: cells.length,
    days,
    runIndices,
    runTotals,
    meanDollars: mean(dollarSeries),
    meanPoints: mean(runTotals.map((r) => r.points)),
    stdDollars: sampleStd(dollarSeries),
    minRunDollars: Math.min(...dollarSeries),
    maxRunDollars: Math.max(...dollarSeries),
    scoredCount: scored.length,
    filledCount: filled.length,
    winCount: wins.length,
    lossCount: losses.length,
    winRate: filled.length ? wins.length / filled.length : null,
    fillRate: scored.length ? filled.length / scored.length : 0,
    avgWinPoints: wins.length ? mean(wins.map((c) => c.result.points)) : null,
    avgLossPoints: losses.length ? mean(losses.map((c) => c.result.points)) : null,
    stability,
    errors,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/scoreboard.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Run the whole suite, then commit**

Run: `npm test`
Expected: all existing tests still pass.

```bash
git add src/scoreboard.js test/scoreboard.test.js
git commit -m "feat: add scoreboard computation for benchmark cells"
```

---

### Task 2: `renderScoreboard` — markdown rendering (pure logic)

**Files:**
- Modify: `src/scoreboard.js` (append `renderScoreboard` and helpers)
- Modify: `test/scoreboard.test.js` (append rendering tests)

- [ ] **Step 1: Write the failing tests**

Append to `test/scoreboard.test.js` (add `renderScoreboard` to the existing import):

```js
import { computeScoreboard, renderScoreboard } from '../src/scoreboard.js';
```

```js
test('renders ranking table, group details, and coverage', () => {
  const cells = [
    cell({ trader: 'winner', runIndex: 1 }),
    cell({ trader: 'winner', runIndex: 2, result: { status: 'NOT_FILLED', points: null, dollars: null } }),
    cell({ trader: 'loser', result: { status: 'SL', points: -10, dollars: -50 } }),
  ];
  const out = renderScoreboard(computeScoreboard(cells));
  assert.match(out, /# Trader Scoreboard/);
  assert.match(out, /never combined across traders or models/i);
  // ranking rows in mean-dollars order, winner first
  assert.match(out, /\| 1 \| winner \| fable \| 1 \| 2 \| 75\.00 \|/);
  assert.match(out, /\| 2 \| loser \| fable \| 1 \| 1 \| -50\.00 \|/);
  // group detail sections
  assert.match(out, /## winner @ fable/);
  assert.match(out, /## loser @ fable/);
  // per-run totals for winner: run 1 filled 150, run 2 not filled 0
  assert.match(out, /\| 1 \| 1 \| 30 \| 150\.00 \|/);
  assert.match(out, /\| 2 \| 1 \| 0 \| 0\.00 \|/);
  // stability row: day, runs, sides, spread
  assert.match(out, /\| 07012026 \| 2 \| 2L\/0S \| 0\.00 \|/);
  // coverage flags the under-tested group
  assert.match(out, /## Coverage/);
  assert.match(out, /\| loser \| fable \| 1 \| 1 \| 1 \| ⚠ under-tested \(max 2\) \|/);
  assert.match(out, /\| winner \| fable \| 2 \| 1 \| 2 \| ok \|/);
});

test('renders null rates and pipeline errors as readable text', () => {
  const cells = [
    cell({ runIndex: 1, result: { status: 'NOT_FILLED', points: null, dollars: null } }),
    cell({ runIndex: 2, setup: undefined, result: { status: 'NO_SETUP' } }),
    cell({ runIndex: 3, result: { status: 'INVALID' }, note: 'bad prices' }),
  ];
  const out = renderScoreboard(computeScoreboard(cells));
  assert.match(out, /\| - \| 0% \|/); // null win rate renders as -, zero fill rate as 0%
  assert.match(out, /- 07012026 run-2: NO_SETUP/);
  assert.match(out, /- 07012026 run-3: INVALID — bad prices/);
});

test('renders "None." when a group has no pipeline errors', () => {
  const out = renderScoreboard(computeScoreboard([cell()]));
  assert.match(out, /### Pipeline errors\n\nNone\./);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/scoreboard.test.js`
Expected: FAIL — `renderScoreboard` is not exported.

- [ ] **Step 3: Implement `renderScoreboard`**

Append to `src/scoreboard.js`:

```js
const money = (v) => (v == null ? '-' : v.toFixed(2));
const pct = (v) => (v == null ? '-' : `${Math.round(v * 100)}%`);
const pts = (v) => (v == null ? '-' : String(v));

export function renderScoreboard({ groups, maxCells }) {
  const totalCells = groups.reduce((s, g) => s + g.cellCount, 0);
  const lines = [
    '# Trader Scoreboard',
    '',
    `${totalCells} cells · ${groups.length} trader@model groups. ` +
      'Every group is scored alone; P&L is never combined across traders or models.',
    '',
    '## Ranking (mean net USD per run)',
    '',
    '| # | Trader | Model | Days | Runs | Mean $/run | Std $ | Min $ | Max $ | Win % | Fill % |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...groups.map(
      (g, i) =>
        `| ${i + 1} | ${g.trader} | ${g.model} | ${g.days.length} | ${g.runIndices.length} ` +
        `| ${money(g.meanDollars)} | ${money(g.stdDollars)} | ${money(g.minRunDollars)} ` +
        `| ${money(g.maxRunDollars)} | ${pct(g.winRate)} | ${pct(g.fillRate)} |`
    ),
  ];

  for (const g of groups) {
    lines.push(
      '',
      `## ${g.trader} @ ${g.model}`,
      '',
      '| Run | Days | Pts | USD |',
      '|---|---|---|---|',
      ...g.runTotals.map(
        (r) => `| ${r.runIndex} | ${r.days} | ${r.points} | ${money(r.dollars)} |`
      ),
      '',
      `Wins: ${g.winCount} · Losses: ${g.lossCount} · ` +
        `Avg win: ${pts(g.avgWinPoints)} pts · Avg loss: ${pts(g.avgLossPoints)} pts`,
      '',
      '### Setup stability',
      '',
      '| Day | Runs | Sides | Entry spread |',
      '|---|---|---|---|',
      ...g.stability.map(
        (s) => `| ${s.day} | ${s.runs} | ${s.long}L/${s.short}S | ${s.entrySpread.toFixed(2)} |`
      ),
      '',
      '### Pipeline errors',
      '',
      ...(g.errors.length
        ? g.errors.map(
            (e) => `- ${e.day} run-${e.runIndex}: ${e.status}${e.note ? ` — ${e.note}` : ''}`
          )
        : ['None.'])
    );
  }

  lines.push(
    '',
    '## Coverage',
    '',
    '| Trader | Model | Cells | Days | Runs | Status |',
    '|---|---|---|---|---|---|',
    ...[...groups]
      .sort((a, b) => a.trader.localeCompare(b.trader) || a.model.localeCompare(b.model))
      .map(
        (g) =>
          `| ${g.trader} | ${g.model} | ${g.cellCount} | ${g.days.length} | ${g.runIndices.length} ` +
          `| ${g.cellCount < maxCells ? `⚠ under-tested (max ${maxCells})` : 'ok'} |`
      ),
    ''
  );

  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/scoreboard.test.js`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/scoreboard.js test/scoreboard.test.js
git commit -m "feat: render scoreboard markdown from computed groups"
```

---

### Task 3: `scoreboard` CLI subcommand — walk `runs/`, write `runs/SCOREBOARD.md`

**Files:**
- Create: `src/scoreboard-command.js`
- Create: `test/scoreboard-command.test.js`
- Modify: `src/cli.js`

- [ ] **Step 1: Write the failing tests**

Create `test/scoreboard-command.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

function writeCell(dir, trader, model, day, runIndex, result, setup) {
  const cellDir = join(dir, trader, model, day);
  mkdirSync(cellDir, { recursive: true });
  const cell = {
    trader,
    model: { alias: model, id: 'claude-test' },
    day,
    date: '2026-07-01',
    runIndex,
    timestamp: '2026-07-18T14:00:00.000Z',
    personaSha256: 'aaa',
    setup: setup ?? { side: 'long', entry: 7500, stopLoss: 7490, takeProfit: 7530, rationale: 'r' },
    result,
  };
  writeFileSync(join(cellDir, `run-${runIndex}.json`), JSON.stringify(cell, null, 2));
}

test('scoreboard walks the runs tree and writes SCOREBOARD.md', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-'));
  writeCell(dir, 'context-trader', 'fable', '07012026', 1, { status: 'TP', points: 10, dollars: 50 });
  writeCell(dir, 'context-trader', 'fable', '07012026', 2, { status: 'SL', points: -4, dollars: -20 });
  writeCell(dir, 'placement-trader', 'fable', '07012026', 1, { status: 'NOT_FILLED', points: null, dollars: null });

  const proc = run(['scoreboard', '--dir', dir]);
  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /Wrote .*SCOREBOARD\.md \(3 cells\)/);

  const md = readFileSync(join(dir, 'SCOREBOARD.md'), 'utf8');
  assert.match(md, /\| 1 \| context-trader \| fable \|/);
  assert.match(md, /\| 2 \| placement-trader \| fable \|/);
});

test('scoreboard ignores files that are not run-<k>.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-'));
  writeCell(dir, 'context-trader', 'fable', '07012026', 1, { status: 'TP', points: 10, dollars: 50 });
  writeFileSync(join(dir, 'context-trader', 'fable', '07012026', 'notes.txt'), 'ignore me');

  const proc = run(['scoreboard', '--dir', dir]);
  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /\(1 cells\)/);
});

test('scoreboard with no cells writes a stub and exits 0', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'bench-')), 'runs');
  assert.equal(existsSync(dir), false);

  const proc = run(['scoreboard', '--dir', dir]);
  assert.equal(proc.status, 0, proc.stderr);
  const md = readFileSync(join(dir, 'SCOREBOARD.md'), 'utf8');
  assert.match(md, /No benchmark cells found/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/scoreboard-command.test.js`
Expected: FAIL — CLI errors with `Unknown command "scoreboard"` (exit 1).

- [ ] **Step 3: Implement the command and wire the CLI**

Create `src/scoreboard-command.js`:

```js
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { computeScoreboard, renderScoreboard } from './scoreboard.js';

// runs/<trader>/<model-alias>/<MMDDYYYY>/run-<k>.json
export function collectCells(runsDir) {
  const cells = [];
  if (!existsSync(runsDir)) return cells;
  for (const trader of subdirs(runsDir)) {
    for (const model of subdirs(join(runsDir, trader))) {
      for (const day of subdirs(join(runsDir, trader, model))) {
        const dayDir = join(runsDir, trader, model, day);
        for (const file of readdirSync(dayDir).filter((f) => /^run-\d+\.json$/.test(f)).sort()) {
          cells.push(JSON.parse(readFileSync(join(dayDir, file), 'utf8')));
        }
      }
    }
  }
  return cells;
}

function subdirs(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

export function runScoreboard(args) {
  const { values } = parseArgs({
    args,
    options: { dir: { type: 'string', default: 'runs' } },
  });
  const cells = collectCells(values.dir);
  const markdown = cells.length
    ? renderScoreboard(computeScoreboard(cells))
    : '# Trader Scoreboard\n\nNo benchmark cells found. Run /trader-bench to populate runs/.\n';
  mkdirSync(values.dir, { recursive: true });
  const outPath = join(values.dir, 'SCOREBOARD.md');
  writeFileSync(outPath, markdown);
  console.log(`Wrote ${outPath} (${cells.length} cells)`);
}
```

Modify `src/cli.js` — add the import and the dispatch branch, and mention the command in USAGE:

```js
import { runBacktest } from './run-command.js';
import { runTranscript } from './transcript-command.js';
import { runScoreboard } from './scoreboard-command.js';

const USAGE =
  'Usage: backtest <command> ...\n' +
  'Commands:\n' +
  '  run         Backtest orders against OHLC data (default when flags are given)\n' +
  '  transcript  Fetch a YouTube video transcript as markdown\n' +
  '  scoreboard  Regenerate runs/SCOREBOARD.md from benchmark cells';
```

and in the dispatch chain, before the `run` branch:

```js
  } else if (first === 'scoreboard') {
    runScoreboard(rest);
  } else if (first === 'run') {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/scoreboard-command.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the whole suite, then commit**

Run: `npm test`
Expected: all tests pass (including existing `cli.test.js` — the new branch must not break flag-style back-compat).

```bash
git add src/scoreboard-command.js test/scoreboard-command.test.js src/cli.js
git commit -m "feat: add scoreboard CLI subcommand"
```

---

### Task 4: `/trader-bench` skill

**Files:**
- Create: `.claude/skills/trader-bench/SKILL.md`

No automated test — this is orchestration prose executed by Claude Code. Correctness is checked in Task 5's live run. Follow the trader-panel skill's conventions exactly (abort wording, date rule, CLI-as-judge).

- [ ] **Step 1: Write the skill file**

Create `.claude/skills/trader-bench/SKILL.md` with exactly this content:

````markdown
---
name: trader-bench
description: Top up the trader benchmark matrix — run every traders/*.md persona N independent times against every complete knowledge-base day for one model, writing one immutable JSON cell per (trader, model, day, run-index) under runs/, then regenerate runs/SCOREBOARD.md. Use when the user asks to benchmark the traders, run the bench, or catch a new trader up, optionally with a run count (/trader-bench 5) and/or model alias (/trader-bench 5 sonnet).
---

# Trader Bench — idempotent benchmark matrix top-up

One primitive: bring every trader to N runs on every complete
knowledge-base day, for one model, running ONLY missing cells. Personas
think; this skill plumbs. The backtest CLI is the SOLE judge of every
setup — perform no validation of setups yourself. Existing cells are
write-once and NEVER rerun, overwritten, or deleted.

**Arguments:** optional integer `N` (target runs per cell, default 5) and
optional model alias (default `fable`). Valid aliases and recorded ids:

| alias | model.id |
|---|---|
| fable | claude-fable-5 |
| opus | claude-opus-4-8 |
| sonnet | claude-sonnet-5 |
| haiku | claude-haiku-4-5-20251001 |

Any other alias → abort listing the valid aliases.

## Phase 1 — Preflight (no agents; abort early with ONE specific message)

1. **Discover personas:** every `traders/*.md`; persona name = the `name:`
   frontmatter value (fall back to filename without `.md`). None → abort
   pointing at `traders/`.
2. **Immutability guard:** compute each persona file's hash with
   `shasum -a 256 traders/<file>.md`. Read `personaSha256` from every
   existing `runs/<trader>/*/*/run-*.json` for that trader (any model, any
   day). If any existing cell's hash differs from the current file's hash,
   abort naming the trader, both hashes, and the remedy: trader files are
   immutable once benchmarked — create a NEW trader file instead of
   editing this one.
3. **Discover complete days:** every `knowledge-base/es/<MMDDYYYY>/` folder
   containing all three docs by suffix: `*_ES_TP.pdf`, `*_ES_TP.md`,
   `*_ES_RECAP.md`. Folders missing any doc are SKIPPED (list them in the
   plan report with the missing suffix), not fatal. Derive each day's CLI
   date from the 8-digit `MMDDYYYY` prefix of the two TP doc FILENAMES —
   never the folder name, whose year is unreliable. The two prefixes must
   agree; a conflict skips the day with both names listed. The recap is
   named for the prior session, so its prefix is exempt. Convert to
   `YYYY-MM-DD` (e.g. `07162026` → `2026-07-16`). The day's cell directory
   key is the TP docs' 8-digit prefix.
4. **Verify candle coverage** per candidate day:
   `CSV=$(ls ticker-data/MES/min-5/*.csv | head -1)`, then

   ```bash
   node -e "Promise.all([import('./src/parse-csv.js'), import('./src/session.js')]).then(async ([p, s]) => {
     const { readFileSync } = await import('node:fs');
     const candles = p.parseCsv(readFileSync(process.argv[1], 'utf8'));
     console.log(s.filterDay(candles, process.argv[2], 'America/New_York').length);
   })" "$CSV" "$DATE"
   ```

   `0` → skip the day, list it. No candidate days at all → abort.
5. **Discover general docs:** every file under `knowledge-base/general/`
   (recursive). Empty or missing directory → proceed with none.
6. **Compute the missing set:** for every (trader, day), existing runs are
   `runs/<trader>/<alias>/<day>/run-*.json`; missing indices are `1..N`
   minus the indices present. Existing cells beyond N are left alone.
7. **Report the plan, then proceed:** traders × days × model alias, cells
   already present, cells to run, skipped days with reasons. Example:
   "2 traders × 10 days × fable, target N=5: 62 cells exist, 38 to run."
   If nothing is missing, say so and jump to Phase 4.

## Phase 2 — Fan-out (ONE Workflow invocation)

Launch the Workflow tool with the script below. INLINE the resolved values
into the constants — do NOT pass them via Workflow `args` (they can arrive
undefined; inlining is deterministic). Every agent gets the same envelope
regardless of run index — repeat runs are identical independent trials, and
agents must never see other runs, days, traders, or prior results.

```js
export const meta = {
  name: 'trader-bench',
  description: 'Independent persona setups for missing benchmark cells',
  phases: [{ title: 'Setups', detail: 'one agent per missing cell' }],
}
const MODEL = '<alias>'
const GENERAL = [
  '<absolute path to each file under knowledge-base/general/, or empty array>',
]
const DOCS_BY_DAY = {
  '<MMDDYYYY>': {
    date: '<YYYY-MM-DD>',
    pdf: '<absolute path to *_ES_TP.pdf>',
    plan: '<absolute path to *_ES_TP.md>',
    recap: '<absolute path to *_ES_RECAP.md>',
  },
}
const PERSONAS = {
  '<persona name>': '<absolute path to traders/<persona>.md>',
}
const CELLS = [
  { trader: '<persona name>', day: '<MMDDYYYY>', runIndex: 1 },
]
const SETUP_SCHEMA = {
  type: 'object',
  required: ['side', 'entry', 'stopLoss', 'takeProfit', 'rationale'],
  properties: {
    side: { enum: ['long', 'short'] },
    entry: { type: 'number' },
    stopLoss: { type: 'number' },
    takeProfit: { type: 'number' },
    rationale: { type: 'string', maxLength: 400 },
  },
  additionalProperties: false,
}
phase('Setups')
const generalBlock = GENERAL.length
  ? `Next Read ALL of these general trading-strategy documents — session-agnostic guidance that applies to every trade and constrains how this persona operates:\n` +
    GENERAL.map((g) => `- ${g}`).join('\n') + `\n\n`
  : ''
const results = await parallel(CELLS.map((cell) => () => {
  const docs = DOCS_BY_DAY[cell.day]
  return agent(
    `You are a futures trading persona on an independent benchmark run. First Read the persona file at ${PERSONAS[cell.trader]} and fully adopt that trading identity — its bias, entry style, stop and target logic.\n\n` +
    generalBlock +
    `Then Read the three documents for the ${docs.date} ES (E-mini S&P 500) session:\n` +
    `1. Trade plan worksheet (PDF, support/resistance zones): ${docs.pdf}\n` +
    `2. Trade plan video transcript: ${docs.plan}\n` +
    `3. Prior-session recap transcript: ${docs.recap}\n\n` +
    `As this persona, commit to exactly ONE trade for the session: long or short. ` +
    `Anchor your entry, stop loss, and take profit to the support/resistance zones in the trade plan. ` +
    `Prices are ES index points in quarter-point increments (e.g. 7530.25). ` +
    `A long requires stopLoss < entry < takeProfit; a short requires takeProfit < entry < stopLoss. ` +
    `Include a rationale of at most 50 words citing which plan level(s) you are using.`,
    { label: `${cell.trader}/${cell.day}#${cell.runIndex}`, schema: SETUP_SCHEMA, model: MODEL }
  ).then((setup) => ({ ...cell, setup }))
}))
log(`${results.filter(Boolean).length}/${CELLS.length} cells returned setups`)
return results.filter(Boolean)
```

Any cell absent from the returned array (its agent died) still gets a cell
file in Phase 3 with status `NO_SETUP` and no `setup` key; the bench
continues.

## Phase 3 — Judge and persist (no validation of your own)

For each cell in the missing set, in the session scratchpad write
`bench-<trader>-<day>-<runIndex>.json`:

```json
[{ "id": "<trader>", "side": "<side>", "entry": <entry>, "stopLoss": <stopLoss>, "takeProfit": <takeProfit> }]
```

Then run (capturing stdout AND stderr separately):

```bash
node src/cli.js run --data "$CSV" --orders <scratchpad>/bench-<trader>-<day>-<runIndex>.json --date "<YYYY-MM-DD>" --json
```

Interpret strictly by the CLI's verdict:

- exit 0 → parse the JSON; `orders[0]` gives `status` (TP | SL | EOD |
  NOT_FILLED), `points`, `dollars`, `fillTime`, `exitTime`. A far-off entry
  is simply `NOT_FILLED` — that IS the answer.
- exit 1 and stderr matches the CLI's order-validation wording (`requires
  stopLoss < entry < takeProfit` / `requires takeProfit < entry <
  stopLoss` / `must be a number`) → status `INVALID`, `note` = that stderr
  line.
- exit 1 otherwise → status `CLI_ERROR`, `note` = the stderr line.

Never fix, clamp, or re-request a persona's prices.

Write each cell to `runs/<trader>/<alias>/<day>/run-<runIndex>.json`
(create directories as needed). If the file already exists, do NOT
overwrite it — record the anomaly for the final summary and move on. Cell
format:

```json
{
  "trader": "<persona name>",
  "model": { "alias": "<alias>", "id": "<model.id from the table>" },
  "day": "<MMDDYYYY>",
  "date": "<YYYY-MM-DD>",
  "runIndex": <k>,
  "timestamp": "<current ISO-8601 UTC time>",
  "personaSha256": "<hash from Phase 1>",
  "setup": { "side": "...", "entry": 0, "stopLoss": 0, "takeProfit": 0, "rationale": "..." },
  "result": { "status": "...", "points": 0, "dollars": 0, "fillTime": 0, "exitTime": 0 },
  "note": "<only for INVALID / CLI_ERROR>"
}
```

Omit `setup` for NO_SETUP cells; `result` is then `{ "status": "NO_SETUP" }`.
For NOT_FILLED, keep the CLI's null points/dollars/fillTime/exitTime as
null. Statuses INVALID and CLI_ERROR keep the submitted `setup` and use
`result` = `{ "status": "INVALID" }` / `{ "status": "CLI_ERROR" }` plus the
top-level `note`.

## Phase 4 — Scoreboard and commit

```bash
node src/cli.js scoreboard
git add runs/
git commit -m "bench(<alias>): add <count> cells across <T> traders / <D> days"
```

If Phase 1 found nothing missing, still regenerate the scoreboard; commit
only if `git status` shows changes (message
`bench(<alias>): regenerate scoreboard`).

Finally, show the user the scoreboard's Ranking table inline, plus the
skipped-day list and any write-anomalies.
````

- [ ] **Step 2: Verify the skill parses and is discoverable**

Run: `head -5 .claude/skills/trader-bench/SKILL.md`
Expected: frontmatter with `name: trader-bench` (Claude Code picks it up from `.claude/skills/`; format matches the working trader-panel skill).

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/trader-bench/SKILL.md
git commit -m "feat: add trader-bench skill for benchmark matrix top-up"
```

---

### Task 5: Live end-to-end verification (manual, cheap)

**Files:** none created by hand — verifies the whole pipeline.

- [ ] **Step 1: Run a minimal bench**

Invoke `/trader-bench 1 fable` (2 traders × 10 days × N=1 = 20 agents).
Expected: preflight plan reports 20 cells to run, 0 existing; Workflow
completes; 20 cell files appear under `runs/`; `runs/SCOREBOARD.md` shows
two groups (`context-trader @ fable`, `placement-trader @ fable`), each
with 10 days × 1 run; one commit `bench(fable): add 20 cells across 2 traders / 10 days`.

- [ ] **Step 2: Verify idempotence (top-up runs nothing)**

Invoke `/trader-bench 1 fable` again.
Expected: preflight reports "nothing missing"; NO agents launched; no cell
file's mtime/content changes (`git status` clean apart from a possible
scoreboard regeneration no-op).

- [ ] **Step 3: Verify cell integrity**

Run: `cat runs/context-trader/fable/07152026/run-1.json`
Expected: matches the cell schema — model alias + id, ISO timestamp,
personaSha256 equal to `shasum -a 256 traders/context-trader.md`, setup
prices in quarter-point increments, result status from the CLI set.

- [ ] **Step 4: Verify the immutability guard fires**

Append a blank line to `traders/context-trader.md`, invoke
`/trader-bench 1 fable`, expect an abort naming context-trader and both
hashes. Then `git checkout traders/context-trader.md` to restore, and
re-run to confirm the guard clears.

---

## Self-review notes

- **Spec coverage:** storage layout + cell schema (Tasks 3–5), top-up
  semantics + preflight + immutability guard + fan-out + judging (Task 4),
  scoreboard metrics/ranking/stability/coverage/zero-cell stub (Tasks 1–3),
  error-handling table (Task 1 error tests, Task 4 phases), testing section
  (Tasks 1–3 automated, Task 5 live). `/trader-panel` untouched — no task
  modifies it.
- **Deliberate deviation from spec prose:** the spec named the file
  `src/scoreboard.js` only; this plan splits pure logic (`scoreboard.js`)
  from I/O (`scoreboard-command.js`) to match the repo's existing
  `report.js` / `run-command.js` convention.
- **Type consistency:** group fields (`meanDollars`, `stdDollars`,
  `minRunDollars`, `maxRunDollars`, `runTotals[{runIndex,days,points,dollars}]`,
  `winRate`, `fillRate`, `stability[{day,runs,long,short,entrySpread}]`,
  `errors[{day,runIndex,status,note}]`) are identical between Task 1's
  implementation, Task 2's renderer, and both test files.
