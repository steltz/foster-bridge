import { computeScoreboard, renderScoreboard, computeFeatureImpact, ScoreCell } from './scoreboard';

function cell(o: Partial<ScoreCell>): ScoreCell {
  return {
    trader: 'context-trader', model: { alias: 'fable' }, variant: 'base',
    day: '07012026', runIndex: 1,
    setup: { side: 'long', entry: 100 },
    result: { status: 'TP', points: 10, dollars: 50 },
    ...o,
  } as ScoreCell;
}

describe('computeScoreboard', () => {
  it('groups by (trader, alias, variant) and ranks by mean $/run', () => {
    const sb = computeScoreboard([
      cell({ runIndex: 1, result: { status: 'TP', points: 10, dollars: 50 } }),
      cell({ runIndex: 2, result: { status: 'SL', points: -5, dollars: -25 } }),
      cell({ trader: 'other', result: { status: 'TP', points: 20, dollars: 100 } }),
    ]);
    expect(sb.groups).toHaveLength(2);
    expect(sb.groups[0].trader).toBe('other'); // 100 > mean(50,-25)=12.5
    expect(sb.groups[1].meanDollars).toBe(12.5);
    expect(sb.maxCells).toBe(2);
  });

  it('renders a ranking table and a coverage table', () => {
    const md = renderScoreboard(computeScoreboard([cell({})]), [], []);
    expect(md).toContain('## Ranking (mean net USD per run)');
    expect(md).toContain('## Coverage');
  });

  it('computeFeatureImpact compares a feature to base over shared days', () => {
    const groups = computeScoreboard([
      cell({ variant: 'base', day: '07012026', result: { status: 'TP', points: 10, dollars: 50 } }),
      cell({ variant: 'seven-keys-method', day: '07012026', result: { status: 'TP', points: 20, dollars: 100 } }),
    ]).groups;
    const impact = computeFeatureImpact(groups, [{ id: 'seven-keys-method', name: 'm' }]);
    expect(impact[0].variant).toBe('seven-keys-method');
    expect(impact[0].rows[0].delta).toBe(50);
  });
});
