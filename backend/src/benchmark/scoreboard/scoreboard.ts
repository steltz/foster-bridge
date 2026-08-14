import { buildLineage, TraderLike, TraderNode } from './lineage';

export interface ScoreCell {
  trader: string;
  model: { alias: string };
  variant: string;
  day: string; // MMDDYYYY
  runIndex: number;
  setup?: { side: string; entry: number };
  result: { status: string; points?: number | null; dollars?: number | null };
  note?: string;
  combines?: string[];
}

export interface FeatureLike {
  id: string;
  name: string;
  combines?: string[] | null;
}

const SCORED = new Set(['TP', 'SL', 'EOD', 'BE', 'NOT_FILLED']);
const FILLED = new Set(['TP', 'SL', 'EOD', 'BE']);

const rekey = (day: string) => day.slice(4) + day.slice(0, 4);
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
function sampleStd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

export function computeScoreboard(cells: ScoreCell[]) {
  const byGroup = new Map<string, ScoreCell[]>();
  for (const c of cells) {
    const key = JSON.stringify([c.trader, c.model.alias, c.variant]);
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key)!.push(c);
  }
  const groups = [...byGroup.values()].map(summarizeGroup);
  groups.sort(
    (a, b) =>
      b.meanDollars - a.meanDollars ||
      a.trader.localeCompare(b.trader, 'en') ||
      a.model.localeCompare(b.model, 'en') ||
      a.variant.localeCompare(b.variant, 'en'),
  );
  const maxCells = groups.reduce((m, g) => Math.max(m, g.cellCount), 0);
  return { groups, maxCells };
}

export type Group = ReturnType<typeof summarizeGroup>;

function summarizeGroup(cells: ScoreCell[]) {
  const { trader, variant } = cells[0];
  const model = cells[0].model.alias;
  const days = [...new Set(cells.map((c) => c.day))].sort((a, b) => rekey(a).localeCompare(rekey(b)));
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
  const wins = filled.filter((c) => (c.result.points ?? 0) > 0);
  const losses = filled.filter((c) => (c.result.points ?? 0) < 0);

  const stability = days.map((day) => {
    const withSetup = cells.filter((c) => c.day === day && c.setup);
    const entries = withSetup.map((c) => c.setup!.entry);
    return {
      day,
      runs: cells.filter((c) => c.day === day).length,
      long: withSetup.filter((c) => c.setup!.side === 'long').length,
      short: withSetup.filter((c) => c.setup!.side === 'short').length,
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
    variant,
    cells,
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
    avgWinPoints: wins.length ? mean(wins.map((c) => c.result.points ?? 0)) : null,
    avgLossPoints: losses.length ? mean(losses.map((c) => c.result.points ?? 0)) : null,
    stability,
    errors,
  };
}

function statsOverDays(group: Group, daySet: Set<string>) {
  const cells = group.cells.filter((c) => daySet.has(c.day));
  const runIndices = [...new Set(cells.map((c) => c.runIndex))].sort((a, b) => a - b);
  return {
    runs: runIndices.length,
    filledCount: cells.filter((c) => FILLED.has(c.result.status)).length,
    meanDollars: mean(
      runIndices.map((runIndex) =>
        cells
          .filter((c) => c.runIndex === runIndex && FILLED.has(c.result.status))
          .reduce((s, c) => s + (c.result.dollars ?? 0), 0),
      ),
    ),
  };
}

export function computeFeatureImpact(groups: Group[], features: FeatureLike[] = []) {
  const pairKey = (g: Group) => JSON.stringify([g.trader, g.model]);
  const baseByPair = new Map<string, Group>();
  for (const g of groups) if (g.variant === 'base') baseByPair.set(pairKey(g), g);
  const groupByPairVariant = new Map(groups.map((g) => [JSON.stringify([g.trader, g.model, g.variant]), g]));
  const comboMap = new Map<string, string[]>(
    features.filter((f) => f.combines).map((f) => [f.id, f.combines as string[]]),
  );
  for (const g of groups) {
    if (!comboMap.has(g.variant)) {
      const combines = g.cells.find((c) => Array.isArray(c.combines))?.combines;
      if (combines) comboMap.set(g.variant, combines);
    }
  }
  const compareRows = (variant: string, opponentFor: (g: Group) => Group | undefined) =>
    groups
      .filter((g) => g.variant === variant)
      .map((g) => {
        const opponent = opponentFor(g);
        if (!opponent) return null;
        const shared = new Set(g.days.filter((d) => opponent.days.includes(d)));
        if (!shared.size) return null;
        const o = statsOverDays(opponent, shared);
        const f = statsOverDays(g, shared);
        if (!o.filledCount || !f.filledCount) return null;
        return {
          trader: g.trader,
          model: g.model,
          days: shared.size,
          baseRuns: o.runs,
          featureRuns: f.runs,
          baseDollars: o.meanDollars,
          featureDollars: f.meanDollars,
          delta: f.meanDollars - o.meanDollars,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a!.trader.localeCompare(b!.trader, 'en') || a!.model.localeCompare(b!.model, 'en')) as any[];
  const variants = [...new Set(groups.map((g) => g.variant).filter((v) => v !== 'base'))].sort((a, b) =>
    a.localeCompare(b, 'en'),
  );
  return variants.map((variant) => {
    const rows = compareRows(variant, (g) => baseByPair.get(pairKey(g)));
    const componentComparisons = (comboMap.get(variant) ?? []).map((component) => {
      const cRows = compareRows(variant, (g) =>
        groupByPairVariant.get(JSON.stringify([g.trader, g.model, component])),
      );
      return { component, rows: cRows, overallDelta: cRows.length ? mean(cRows.map((r) => r.delta)) : null };
    });
    return {
      variant,
      rows,
      overallDelta: rows.length ? mean(rows.map((r) => r.delta)) : null,
      componentComparisons,
    };
  });
}

const money = (v: number | null | undefined) => (v == null ? '-' : v.toFixed(2));
const pct = (v: number | null | undefined) => (v == null ? '-' : `${Math.round(v * 100)}%`);
const pts = (v: number | null | undefined) => (v == null ? '-' : v.toFixed(2));
const signed = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;

export function renderLineage(traders: TraderLike[], groups: Group[]): string[] {
  const { roots, unknownGroups, cycles } = buildLineage(traders);
  const groupsByTrader = new Map<string, Group[]>();
  for (const g of groups) {
    if (!groupsByTrader.has(g.trader)) groupsByTrader.set(g.trader, []);
    groupsByTrader.get(g.trader)!.push(g);
  }
  const lines: string[] = [];
  const emit = (node: TraderNode, depth: number) => {
    const prefix = depth === 0 ? '' : '   '.repeat(depth - 1) + '└─ ';
    const stats = (groupsByTrader.get(node.name) ?? [])
      .slice()
      .sort((a, b) => a.model.localeCompare(b.model, 'en') || a.variant.localeCompare(b.variant, 'en'))
      .map((g) => {
        let s = `${g.model}/${g.variant} ${g.runIndices.length}r: ${money(g.meanDollars)}`;
        const originGroup = node.origin
          ? (groupsByTrader.get(node.origin) ?? []).find((og) => og.model === g.model && og.variant === g.variant)
          : null;
        if (originGroup) s += ` (Δ vs origin: ${signed(g.meanDollars - originGroup.meanDollars)})`;
        return s;
      });
    lines.push(`${(prefix + node.name).padEnd(30)}${stats.length ? ' ' + stats.join(' · ') : ''}`.trimEnd());
    if (node.mutation) lines.push(' '.repeat(depth * 3 + 2) + node.mutation);
    node.children.forEach((c) => emit(c, depth + 1));
  };
  roots.forEach((r) => emit(r, 0));
  for (const g of unknownGroups) {
    lines.push(`(unknown origin: ${g.origin})`);
    g.children.forEach((c) => emit(c, 1));
  }
  if (cycles.length) lines.push(`(unreachable — origin cycle: ${cycles.map((n) => n.name).join(', ')})`);
  return lines;
}

export function renderScoreboard(
  { groups, maxCells }: { groups: Group[]; maxCells: number },
  traders: TraderLike[] = [],
  features: FeatureLike[] = [],
): string {
  const totalCells = groups.reduce((s, g) => s + g.cellCount, 0);
  const nameById = new Map(features.map((f) => [f.id, f.name]));
  const lines: string[] = [
    '# Trader Scoreboard',
    '',
    `${totalCells} cells · ${groups.length} trader@model@variant groups. ` +
      'Every group is scored alone; P&L is never combined across traders, models, or variants.',
    '',
    '## Ranking (mean net USD per run)',
    '',
    '| # | Trader | Model | Variant | Days | Runs | Mean $/run | Std $ | Min $ | Max $ | Win % | Fill % |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...groups.map(
      (g, i) =>
        `| ${i + 1} | ${g.trader} | ${g.model} | ${g.variant} | ${g.days.length} | ${g.runIndices.length} ` +
        `| ${money(g.meanDollars)} | ${money(g.stdDollars)} ` +
        `| ${money(g.minRunDollars)} | ${money(g.maxRunDollars)} | ${pct(g.winRate)} | ${pct(g.fillRate)} |`,
    ),
  ];

  const impact = computeFeatureImpact(groups, features);
  if (impact.length) {
    lines.push(
      '',
      '## Feature Impact',
      '',
      'Each row compares base and feature over their shared day set only ' +
        '(the Days column); days covered by one side never bias Δ. Runs is ' +
        'base-vs-feature run counts over those days — a lopsided pair is a ' +
        'weakly sampled verdict. Pairs where either side has no filled ' +
        'trades over the shared days are omitted rather than scored zero. ' +
        'For combos, additional tables compare the combo against each of ' +
        'its components over the same shared-day rule.',
      '',
    );
    for (const feat of impact) {
      const label = nameById.get(feat.variant) ?? feat.variant;
      lines.push(
        `### ${label}`,
        '',
        `| Trader | Model | Days | Runs | Base $/run | ${label} $/run | Δ |`,
        '|---|---|---|---|---|---|---|',
        ...feat.rows.map(
          (r) =>
            `| ${r.trader} | ${r.model} | ${r.days} | ${r.baseRuns}v${r.featureRuns} ` +
            `| ${money(r.baseDollars)} | ${money(r.featureDollars)} | ${signed(r.delta)} |`,
        ),
        '',
        feat.overallDelta == null
          ? 'No comparable (trader, model) pairs yet.'
          : `**Overall Δ for ${label} across ${feat.rows.length} trader/model pair${
              feat.rows.length === 1 ? '' : 's'
            }: ${signed(feat.overallDelta)}**`,
      );
      for (const cc of feat.componentComparisons) {
        const compLabel = nameById.get(cc.component) ?? cc.component;
        lines.push(
          '',
          `#### ${label} vs ${compLabel}`,
          '',
          `| Trader | Model | Days | Runs | ${compLabel} $/run | ${label} $/run | Δ |`,
          '|---|---|---|---|---|---|---|',
          ...cc.rows.map(
            (r) =>
              `| ${r.trader} | ${r.model} | ${r.days} | ${r.baseRuns}v${r.featureRuns} ` +
              `| ${money(r.baseDollars)} | ${money(r.featureDollars)} | ${signed(r.delta)} |`,
          ),
          '',
          cc.overallDelta == null
            ? 'No comparable (trader, model) pairs yet.'
            : `**Overall Δ for ${label} vs ${compLabel} across ${cc.rows.length} pair${
                cc.rows.length === 1 ? '' : 's'
              }: ${signed(cc.overallDelta)}**`,
        );
      }
    }
  }

  if (traders.length) {
    lines.push('', '## Lineage', '', '```', ...renderLineage(traders, groups), '```');
  }

  const traderByName = new Map(traders.map((t) => [t.name, t]));
  for (const g of groups) {
    lines.push('', `## ${g.trader} @ ${g.model} [${g.variant}]`);
    const t = traderByName.get(g.trader);
    if (t?.origin) {
      const og = groups.find((x) => x.trader === t.origin && x.model === g.model && x.variant === g.variant);
      lines.push(
        '',
        `Origin: ${t.origin} — ${t.mutation ?? '(no mutation note)'} · ` +
          (og
            ? `Δ mean $/run vs origin @ ${g.model}/${g.variant}: ${signed(g.meanDollars - og.meanDollars)}`
            : `origin has no runs at ${g.model}/${g.variant}`),
      );
    }
    lines.push(
      '',
      '| Run | Days | Pts | USD |',
      '|---|---|---|---|',
      ...g.runTotals.map((r) => `| ${r.runIndex} | ${r.days} | ${r.points} | ${money(r.dollars)} |`),
      '',
      `Wins: ${g.winCount} · Losses: ${g.lossCount} · ` +
        `Avg win: ${pts(g.avgWinPoints)} pts · Avg loss: ${pts(g.avgLossPoints)} pts`,
      '',
      '### Setup stability',
      '',
      '| Day | Runs | Sides | Entry spread |',
      '|---|---|---|---|',
      ...g.stability.map((s) => `| ${s.day} | ${s.runs} | ${s.long}L/${s.short}S | ${s.entrySpread.toFixed(2)} |`),
      '',
      '### Pipeline errors',
      '',
      ...(g.errors.length
        ? g.errors.map((e) => `- ${e.day} run-${e.runIndex}: ${e.status}${e.note ? ` — ${e.note}` : ''}`)
        : ['None.']),
    );
  }

  lines.push(
    '',
    '## Coverage',
    '',
    '| Trader | Model | Variant | Cells | Days | Runs | Status |',
    '|---|---|---|---|---|---|---|',
    ...[...groups]
      .sort(
        (a, b) =>
          a.trader.localeCompare(b.trader, 'en') ||
          a.model.localeCompare(b.model, 'en') ||
          a.variant.localeCompare(b.variant, 'en'),
      )
      .map(
        (g) =>
          `| ${g.trader} | ${g.model} | ${g.variant} | ${g.cellCount} | ${g.days.length} | ${g.runIndices.length} ` +
          `| ${g.cellCount < maxCells ? `⚠ under-tested (max ${maxCells})` : 'ok'} |`,
      ),
    '',
  );

  return lines.join('\n');
}
