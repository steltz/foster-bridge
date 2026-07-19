import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeScoreboard, computeFeatureImpact, renderScoreboard, renderLineage } from '../src/scoreboard.js';

// Minimal cell factory; override any field per test.
function cell(overrides = {}) {
  return {
    trader: 'context-trader',
    model: { alias: 'fable', id: 'claude-fable-5' },
    day: '07012026',
    date: '2026-07-01',
    variant: 'base',
    runIndex: 1,
    timestamp: '2026-07-18T14:00:00.000Z',
    personaSha256: 'aaa',
    setup: { side: 'long', entry: 7500, stopLoss: 7490, takeProfit: 7530, rationale: 'r' },
    result: { status: 'TP', points: 30, dollars: 150 },
    ...overrides,
  };
}

test('groups by (trader, model alias, variant) and never merges across groups', () => {
  const cells = [
    cell({ trader: 'a', model: { alias: 'fable', id: 'x' } }),
    cell({ trader: 'a', model: { alias: 'sonnet', id: 'y' } }),
    cell({ trader: 'b', model: { alias: 'fable', id: 'x' } }),
    cell({ trader: 'b', model: { alias: 'sonnet', id: 'y' } }),
    cell({ trader: 'a', model: { alias: 'fable', id: 'x' }, variant: 'seven-keys' }),
  ];
  const { groups } = computeScoreboard(cells);
  assert.equal(groups.length, 5);
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

test('ranking ties on mean dollars break alphabetically by trader, then model, then variant', () => {
  const tied = (trader, variant = 'base') => cell({ trader, variant });
  for (const ordering of [
    [tied('zeta'), tied('alpha')],
    [tied('alpha'), tied('zeta')],
  ]) {
    const { groups } = computeScoreboard(ordering);
    assert.deepEqual(groups.map((g) => g.trader), ['alpha', 'zeta']);
  }
  const { groups } = computeScoreboard([tied('alpha', 'seven-keys'), tied('alpha', 'base')]);
  assert.deepEqual(groups.map((g) => g.variant), ['base', 'seven-keys']);
});

test('hostile trader/alias/variant names never collide into one group', () => {
  const cells = [
    cell({ trader: 'a","b', model: { alias: 'c', id: 'x' } }),
    cell({ trader: 'a', model: { alias: 'b","c', id: 'x' } }),
    cell({ trader: 'a', model: { alias: 'c', id: 'x' }, variant: 'b","c' }),
  ];
  const { groups } = computeScoreboard(cells);
  assert.equal(groups.length, 3);
});

test('renders ranking table, group details, and coverage', () => {
  const cells = [
    cell({ trader: 'winner', runIndex: 1 }),
    cell({ trader: 'winner', runIndex: 2, result: { status: 'NOT_FILLED', points: null, dollars: null } }),
    cell({ trader: 'loser', result: { status: 'SL', points: -10, dollars: -50 } }),
  ];
  const out = renderScoreboard(computeScoreboard(cells));
  assert.match(out, /# Trader Scoreboard/);
  assert.match(out, /never combined across traders, models, or variants/i);
  // ranking rows in mean-dollars order, winner first
  assert.match(out, /\| 1 \| winner \| fable \| base \| 1 \| 2 \| 75\.00 \|/);
  assert.match(out, /\| 2 \| loser \| fable \| base \| 1 \| 1 \| -50\.00 \|/);
  // group detail sections
  assert.match(out, /## winner @ fable \[base\]/);
  assert.match(out, /## loser @ fable \[base\]/);
  // per-run totals for winner: run 1 filled 150, run 2 not filled 0
  assert.match(out, /\| 1 \| 1 \| 30 \| 150\.00 \|/);
  assert.match(out, /\| 2 \| 1 \| 0 \| 0\.00 \|/);
  // stability row: day, runs, sides, spread
  assert.match(out, /\| 07012026 \| 2 \| 2L\/0S \| 0\.00 \|/);
  // coverage flags the under-tested group
  assert.match(out, /## Coverage/);
  assert.match(out, /\| loser \| fable \| base \| 1 \| 1 \| 1 \| ⚠ under-tested \(max 2\) \|/);
  assert.match(out, /\| winner \| fable \| base \| 2 \| 1 \| 2 \| ok \|/);
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

test('computeFeatureImpact computes per-(trader,model) deltas vs the base variant', () => {
  const cells = [
    cell({ trader: 'a', model: { alias: 'fable', id: 'x' }, variant: 'base', result: { status: 'TP', points: 20, dollars: 100 } }),
    cell({ trader: 'a', model: { alias: 'fable', id: 'x' }, variant: 'seven-keys', result: { status: 'TP', points: 30, dollars: 150 } }),
    cell({ trader: 'b', model: { alias: 'sonnet', id: 'y' }, variant: 'base', result: { status: 'SL', points: -10, dollars: -50 } }),
    cell({ trader: 'b', model: { alias: 'sonnet', id: 'y' }, variant: 'seven-keys', result: { status: 'TP', points: 10, dollars: 50 } }),
  ];
  const impact = computeFeatureImpact(computeScoreboard(cells).groups);
  assert.equal(impact.length, 1);
  assert.equal(impact[0].variant, 'seven-keys');
  assert.deepEqual(impact[0].rows, [
    { trader: 'a', model: 'fable', days: 1, baseDollars: 100, featureDollars: 150, delta: 50 },
    { trader: 'b', model: 'sonnet', days: 1, baseDollars: -50, featureDollars: 50, delta: 100 },
  ]);
  assert.equal(impact[0].overallDelta, 75);
});

test('computeFeatureImpact restricts both sides to their shared day set', () => {
  const cells = [
    // base covers two days; seven-keys covers only the first (e.g. its
    // artifact generation failed on the second)
    cell({ variant: 'base', day: '07012026', result: { status: 'TP', points: 20, dollars: 100 } }),
    cell({ variant: 'base', day: '07022026', result: { status: 'SL', points: -40, dollars: -200 } }),
    cell({ variant: 'seven-keys', day: '07012026', result: { status: 'TP', points: 30, dollars: 150 } }),
  ];
  const impact = computeFeatureImpact(computeScoreboard(cells).groups);
  // base's 07022026 loss is excluded: both sides compare over 07012026 only,
  // so the delta is +50 — not the +250 a raw group-mean comparison would show
  assert.deepEqual(impact[0].rows, [
    { trader: 'context-trader', model: 'fable', days: 1, baseDollars: 100, featureDollars: 150, delta: 50 },
  ]);
});

test('computeFeatureImpact omits (trader, model) pairs missing their base counterpart', () => {
  const impact = computeFeatureImpact(
    computeScoreboard([cell({ trader: 'a', variant: 'seven-keys' })]).groups
  );
  assert.equal(impact[0].variant, 'seven-keys');
  assert.equal(impact[0].rows.length, 0);
  assert.equal(impact[0].overallDelta, null);
});

test('computeFeatureImpact omits pairs whose day sets do not intersect', () => {
  const cells = [
    cell({ variant: 'base', day: '07012026' }),
    cell({ variant: 'seven-keys', day: '07022026' }),
  ];
  const impact = computeFeatureImpact(computeScoreboard(cells).groups);
  assert.equal(impact[0].rows.length, 0);
  assert.equal(impact[0].overallDelta, null);
});

test('computeFeatureImpact returns [] when only the base variant exists', () => {
  assert.deepEqual(computeFeatureImpact(computeScoreboard([cell()]).groups), []);
});

test('renderScoreboard renders a Feature Impact section with per-pair deltas and an overall rollup', () => {
  const cells = [
    cell({ trader: 'a', model: { alias: 'fable', id: 'x' }, variant: 'base', result: { status: 'TP', points: 20, dollars: 100 } }),
    cell({ trader: 'a', model: { alias: 'fable', id: 'x' }, variant: 'seven-keys', result: { status: 'TP', points: 30, dollars: 150 } }),
  ];
  const out = renderScoreboard(computeScoreboard(cells), [], [{ id: 'seven-keys', name: 'Seven Keys zone assessment' }]);
  assert.match(out, /## Feature Impact/);
  assert.match(out, /### Seven Keys zone assessment/);
  assert.match(out, /\| a \| fable \| 1 \| 100\.00 \| 150\.00 \| \+50\.00 \|/);
  assert.match(out, /\*\*Overall Δ for Seven Keys zone assessment across 1 trader\/model pair: \+50\.00\*\*/);
});

test('renderScoreboard falls back to the raw variant id when no matching feature name is given', () => {
  const cells = [
    cell({ trader: 'a', variant: 'base', result: { status: 'TP', points: 20, dollars: 100 } }),
    cell({ trader: 'a', variant: 'mystery-feature', result: { status: 'TP', points: 30, dollars: 150 } }),
  ];
  const out = renderScoreboard(computeScoreboard(cells));
  assert.match(out, /### mystery-feature/);
});

test('renderScoreboard omits the Feature Impact section when there is no non-base variant', () => {
  const out = renderScoreboard(computeScoreboard([cell()]));
  assert.doesNotMatch(out, /## Feature Impact/);
});

// Helper for lineage tests: minimal valid cell.
function lineageCell(trader, model, runIndex, dollars, variant = 'base') {
  return {
    trader,
    model: { alias: model, id: 'claude-test' },
    day: '07012026',
    date: '2026-07-01',
    variant,
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

test('renderLineage renders the tree with per-model/variant stats, keeping variants distinct', () => {
  const { groups } = computeScoreboard([
    lineageCell('basehit-trader', 'fable', 1, -10),
    lineageCell('basehit-trader', 'fable', 1, 999, 'seven-keys'),
    lineageCell('basehit-deeper-entry', 'fable', 1, 40),
    lineageCell('basehit-deeper-entry', 'opus', 1, 5),
  ]);
  const text = renderLineage(LINEAGE_TRADERS, groups).join('\n');
  assert.match(text, /^basehit-trader\s+fable\/base 1r: -10\.00 · fable\/seven-keys 1r: 999\.00$/m);
  assert.match(text, /^└─ basehit-deeper-entry\s+fable\/base 1r: 40\.00 \(Δ vs origin: \+50\.00\)/m);
  // opus/base has no origin runs at that model → stats shown without a delta
  assert.match(text, /opus\/base 1r: 5\.00(?! \(Δ)/);
  assert.match(text, /^\s+Entries rest at the zone midpoint instead of the leading edge$/m);
});

test('renderLineage never matches origin/descendant deltas across different variants', () => {
  const { groups } = computeScoreboard([
    lineageCell('basehit-trader', 'fable', 1, -10, 'base'),
    lineageCell('basehit-trader', 'fable', 1, 999, 'seven-keys'),
    lineageCell('basehit-deeper-entry', 'fable', 1, 40, 'seven-keys'),
  ]);
  const text = renderLineage(LINEAGE_TRADERS, groups).join('\n');
  // descendant's seven-keys group (40) must delta against origin's seven-keys group (999), never its base group (-10)
  assert.match(text, /basehit-deeper-entry\s+fable\/seven-keys 1r: 40\.00 \(Δ vs origin: -959\.00\)/);
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

test('descendant group sections carry an Origin line with a same-model-and-variant delta', () => {
  const board = computeScoreboard([
    lineageCell('basehit-trader', 'fable', 1, -10),
    lineageCell('basehit-deeper-entry', 'fable', 1, 40),
  ]);
  const md = renderScoreboard(board, LINEAGE_TRADERS);
  const section = md.split('## basehit-deeper-entry @ fable [base]')[1];
  assert.match(
    section,
    /^Origin: basehit-trader — Entries rest at the zone midpoint instead of the leading edge · Δ mean \$\/run vs origin @ fable\/base: \+50\.00$/m
  );
});

test('descendant Origin line says so when the origin has no runs at that model/variant', () => {
  const board = computeScoreboard([lineageCell('basehit-deeper-entry', 'opus', 1, 5)]);
  const md = renderScoreboard(board, LINEAGE_TRADERS);
  assert.match(md, /^Origin: basehit-trader — .* · origin has no runs at opus\/base$/m);
});

test('root trader sections carry no Origin line', () => {
  const board = computeScoreboard([lineageCell('basehit-trader', 'fable', 1, -10)]);
  const md = renderScoreboard(board, LINEAGE_TRADERS);
  assert.doesNotMatch(md.split('## basehit-trader @ fable [base]')[1], /^Origin:/m);
});
