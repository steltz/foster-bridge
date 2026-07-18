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
    // JSON key is injective: no trader/alias pair can collide with
    // another, since JSON handles all quoting and escaping.
    const key = JSON.stringify([c.trader, c.model.alias]);
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(c);
  }
  const groups = [...byGroup.values()].map(summarizeGroup);
  groups.sort(
    (a, b) =>
      b.meanDollars - a.meanDollars ||
      a.trader.localeCompare(b.trader, 'en') ||
      a.model.localeCompare(b.model, 'en')
  );
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

const money = (v) => (v == null ? '-' : v.toFixed(2));
const pct = (v) => (v == null ? '-' : `${Math.round(v * 100)}%`);
const pts = (v) => (v == null ? '-' : v.toFixed(2));

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
      .sort((a, b) => a.trader.localeCompare(b.trader, 'en') || a.model.localeCompare(b.model, 'en'))
      .map(
        (g) =>
          `| ${g.trader} | ${g.model} | ${g.cellCount} | ${g.days.length} | ${g.runIndices.length} ` +
          `| ${g.cellCount < maxCells ? `⚠ under-tested (max ${maxCells})` : 'ok'} |`
      ),
    ''
  );

  return lines.join('\n');
}
