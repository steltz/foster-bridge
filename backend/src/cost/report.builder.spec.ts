import { buildReport } from './report.builder';
import { CostRecord } from './cost.types';

const rec = (over: Partial<CostRecord> = {}): CostRecord => ({
  id: 'a',
  timestamp: '2026-07-27T13:00:00.000Z',
  model: { alias: 'fable', id: 'claude-fable-5' },
  serviceTier: 'batch',
  operation: 'setup',
  benchmark: { modelAlias: 'fable', day: '07222026', trader: 'context-trader', variant: 'base', runIndex: 1 },
  tokens: { input: 20, cacheRead: 3227, cacheCreate5m: 0, cacheCreate1h: 16434, output: 2157 },
  cost: { input: 0.0001, cacheRead: 0.0032, cacheCreate: 0.164, output: 0.108, total: 0.2753, uncachedInputEquiv: 0.19681 },
  pricingVersion: 'fable-2026-07',
  source: 'batch',
  batchId: 'msgbatch_x',
  ...over,
});

describe('buildReport', () => {
  it('produces a self-contained HTML document with the data embedded', () => {
    const html = buildReport([rec(), rec({ id: 'b', serviceTier: 'standard' })]);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<style>');
    expect(html).toContain('<script>');
    // No external resource references (CSP-safe / offline).
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toMatch(/href="https?:/);
    // Records are embedded as JSON.
    expect(html).toContain('"totalRecords": 2');
    expect(html).toContain('context-trader');
  });

  it('renders the total spend and net-cache KPIs', () => {
    const html = buildReport([rec()]);
    expect(html).toContain('0.2753'); // total USD appears in the embedded data
    expect(html).toMatch(/Total spend/i);
    expect(html).toMatch(/Net cache benefit/i);
    expect(html).toMatch(/Cache read discount/i);
  });

  it('embeds a spend-over-time series keyed by the request calendar date', () => {
    const html = buildReport([
      rec({ id: 'a', timestamp: '2026-07-22T10:00:00.000Z' }),
      rec({ id: 'b', timestamp: '2026-07-23T10:00:00.000Z' }),
    ]);
    expect(html).toContain('"overTime"');
    expect(html).toContain('2026-07-22');
    expect(html).toContain('2026-07-23');
    expect(html).toMatch(/Spend over time/i);
  });

  it('handles an empty record set without throwing', () => {
    const html = buildReport([]);
    expect(html).toContain('"totalRecords": 0');
  });
});
