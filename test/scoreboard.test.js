import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeScoreboard, renderScoreboard, renderLineage } from '../src/scoreboard.js';

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

test('ranking ties on mean dollars break alphabetically by trader, then model', () => {
  const tied = (trader) => cell({ trader }); // identical result cells → identical meanDollars
  for (const ordering of [
    [tied('zeta'), tied('alpha')],
    [tied('alpha'), tied('zeta')],
  ]) {
    const { groups } = computeScoreboard(ordering);
    assert.deepEqual(groups.map((g) => g.trader), ['alpha', 'zeta']);
  }
});

test('hostile trader/alias names never collide into one group', () => {
  const cells = [
    cell({ trader: 'a","b', model: { alias: 'c', id: 'x' } }),
    cell({ trader: 'a', model: { alias: 'b","c', id: 'x' } }),
  ];
  const { groups } = computeScoreboard(cells);
  assert.equal(groups.length, 2);
});

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
  assert.match(out, /\| 1 \| winner \| fable \| 1 \| 2 \| 0k\/2 \| 75\.00 \|/);
  assert.match(out, /\| 2 \| loser \| fable \| 1 \| 1 \| 0k\/1 \| -50\.00 \|/);
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

// Helper for lineage tests: minimal valid cell.
function lineageCell(trader, model, runIndex, dollars) {
  return {
    trader,
    model: { alias: model, id: 'claude-test' },
    day: '07012026',
    date: '2026-07-01',
    runIndex,
    timestamp: '2026-07-18T14:00:00.000Z',
    personaSha256: 'aaa',
    setup: { side: 'long', entry: 7500, stopLoss: 7490, takeProfit: 7530, rationale: 'r' },
    result: { status: 'TP', points: dollars / 5, dollars },
  };
}

const LINEAGE_TRADERS = [
  { name: 'basehit-trader', origin: null, mutation: null },
  {
    name: 'basehit-deeper-entry',
    origin: 'basehit-trader',
    mutation: 'Entries rest at the zone midpoint instead of the leading edge',
  },
];

test('renderLineage renders the tree with per-model stats and same-model deltas', () => {
  const { groups } = computeScoreboard([
    lineageCell('basehit-trader', 'fable', 1, -10),
    lineageCell('basehit-deeper-entry', 'fable', 1, 40),
    lineageCell('basehit-deeper-entry', 'opus', 1, 5),
  ]);
  const text = renderLineage(LINEAGE_TRADERS, groups).join('\n');
  assert.match(text, /^basehit-trader\s+fable 1r: -10\.00$/m);
  assert.match(text, /^└─ basehit-deeper-entry\s+fable 1r: 40\.00 \(Δ vs origin: \+50\.00\)/m);
  // opus has no origin runs → stats shown without a delta
  assert.match(text, /opus 1r: 5\.00(?! \(Δ)/);
  assert.match(text, /^\s+Entries rest at the zone midpoint instead of the leading edge$/m);
});

test('renderLineage shows traders with no runs as bare nodes', () => {
  const text = renderLineage(LINEAGE_TRADERS, []).join('\n');
  assert.match(text, /^basehit-trader$/m);
  assert.match(text, /^└─ basehit-deeper-entry$/m);
});

test('renderLineage renders unknown origins and cycles explicitly', () => {
  const text = renderLineage(
    [
      { name: 'orphan', origin: 'deleted-trader', mutation: 'm' },
      { name: 'x', origin: 'y', mutation: 'm' },
      { name: 'y', origin: 'x', mutation: 'm' },
    ],
    []
  ).join('\n');
  assert.match(text, /^\(unknown origin: deleted-trader\)$/m);
  assert.match(text, /^└─ orphan$/m);
  assert.match(text, /^\(unreachable — origin cycle: x, y\)$/m);
});

test('renderScoreboard includes a ## Lineage section when traders are given', () => {
  const board = computeScoreboard([lineageCell('basehit-trader', 'fable', 1, -10)]);
  const md = renderScoreboard(board, LINEAGE_TRADERS);
  assert.match(md, /## Lineage/);
  assert.match(md, /```\nbasehit-trader/);
});

test('renderScoreboard omits the Lineage section when traders are absent', () => {
  const board = computeScoreboard([lineageCell('basehit-trader', 'fable', 1, -10)]);
  assert.doesNotMatch(renderScoreboard(board), /## Lineage/);
  assert.doesNotMatch(renderScoreboard(board, []), /## Lineage/);
});

test('descendant group sections carry an Origin line with a same-model delta', () => {
  const board = computeScoreboard([
    lineageCell('basehit-trader', 'fable', 1, -10),
    lineageCell('basehit-deeper-entry', 'fable', 1, 40),
  ]);
  const md = renderScoreboard(board, LINEAGE_TRADERS);
  const section = md.split('## basehit-deeper-entry @ fable')[1];
  assert.match(
    section,
    /^Origin: basehit-trader — Entries rest at the zone midpoint instead of the leading edge · Δ mean \$\/run vs origin @ fable: \+50\.00$/m
  );
});

test('descendant Origin line says so when the origin has no runs at that model', () => {
  const board = computeScoreboard([lineageCell('basehit-deeper-entry', 'opus', 1, 5)]);
  const md = renderScoreboard(board, LINEAGE_TRADERS);
  assert.match(md, /^Origin: basehit-trader — .* · origin has no runs at opus$/m);
});

test('root trader sections carry no Origin line', () => {
  const board = computeScoreboard([lineageCell('basehit-trader', 'fable', 1, -10)]);
  const md = renderScoreboard(board, LINEAGE_TRADERS);
  assert.doesNotMatch(md.split('## basehit-trader @ fable')[1], /^Origin:/m);
});

test('keys-era cells are counted and annotated per group', () => {
  const cells = [cell(), cell({ runIndex: 2, keysSha256: 'k1' })];
  const sb = computeScoreboard(cells);
  assert.equal(sb.groups[0].keysCellCount, 1);
  assert.equal(sb.groups[0].cellCount, 2);
  const md = renderScoreboard(sb);
  assert.match(md, /Keys: Nk\/M = N of the group's M cells ran with the shared Seven-Keys artifact/);
  assert.match(md, /\| 1k\/2 \|/);
});
