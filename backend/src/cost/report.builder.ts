import { CostRecord } from './cost.types';
import { cacheReadDiscountFactor } from './pricing';

interface Payload {
  totalRecords: number;
  totalUsd: number;
  totalTokens: number;
  standardUsd: number;
  batchUsd: number;
  netCacheBenefitUsd: number;
  grossCacheReadDiscountUsd: number;
  overTime: { date: string; usd: number }[]; // request calendar date, chronological
  records: CostRecord[];
}

function summarizePayload(records: CostRecord[]): Payload {
  let totalUsd = 0;
  let totalTokens = 0;
  let standardUsd = 0;
  let batchUsd = 0;
  let netCacheBenefitUsd = 0;
  let grossCacheReadDiscountUsd = 0;
  const byDate = new Map<string, number>();
  for (const r of records) {
    const usd = r.cost?.total ?? 0;
    totalUsd += usd;
    totalTokens += r.tokens.input + r.tokens.cacheRead + r.tokens.cacheCreate5m + r.tokens.cacheCreate1h + r.tokens.output;
    if (r.serviceTier === 'batch') batchUsd += usd;
    else standardUsd += usd;
    grossCacheReadDiscountUsd += (r.cost?.cacheRead ?? 0) * cacheReadDiscountFactor(r.model.id, r.timestamp);
    if (r.cost) netCacheBenefitUsd += r.cost.uncachedInputEquiv - (r.cost.input + r.cost.cacheRead + r.cost.cacheCreate);
    const d = r.timestamp.slice(0, 10);
    byDate.set(d, (byDate.get(d) ?? 0) + usd);
  }
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  const overTime = [...byDate.entries()]
    .map(([date, usd]) => ({ date, usd: round(usd) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    totalRecords: records.length,
    totalUsd: round(totalUsd),
    totalTokens,
    standardUsd: round(standardUsd),
    batchUsd: round(batchUsd),
    netCacheBenefitUsd: round(netCacheBenefitUsd),
    grossCacheReadDiscountUsd: round(grossCacheReadDiscountUsd),
    overTime,
    records,
  };
}

// Build a self-contained HTML document. All data is embedded as JSON; the inline
// script renders KPI tiles and a filterable/sortable breakdown table. No network.
export function buildReport(records: CostRecord[]): string {
  const payload = summarizePayload(records);
  // Embed as JSON in a script tag; </script> is escaped to avoid breaking out.
  const json = JSON.stringify(payload, null, 2).replace(/<\/script>/gi, '<\\/script>');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Anthropic API Cost Report</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --muted:#666; --line:#e5e5e5; --tile:#f7f7f7; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f0f10; --fg:#eee; --muted:#9a9a9a; --line:#2a2a2a; --tile:#191919; } }
  body { margin:0; font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--fg); }
  main { max-width:1100px; margin:0 auto; padding:24px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:var(--muted); margin:0 0 20px; }
  .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin-bottom:24px; }
  .kpi { background:var(--tile); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .kpi .v { font-size:22px; font-weight:600; }
  .kpi .l { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  label { color:var(--muted); font-size:12px; margin-right:6px; }
  select { background:var(--tile); color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:4px 8px; }
  table { width:100%; border-collapse:collapse; margin-top:12px; }
  th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); }
  th { cursor:pointer; user-select:none; color:var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; }
  td.num,th.num { text-align:right; font-variant-numeric:tabular-nums; }
  .bar { height:8px; background:var(--tile); border-radius:4px; overflow:hidden; }
  .bar > span { display:block; height:100%; background:currentColor; }
  .wrap { overflow-x:auto; }
</style>
</head>
<body>
<main>
  <h1>Anthropic API Cost Report</h1>
  <p class="sub" id="sub"></p>
  <section class="kpis" id="kpis"></section>
  <h2 style="font-size:14px;color:var(--muted);margin:8px 0">Spend over time</h2>
  <div class="wrap"><table id="ot"><tbody></tbody></table></div>
  <div style="margin-top:20px">
    <label for="groupBy">Group by</label>
    <select id="groupBy">
      <option value="operation">Operation</option>
      <option value="serviceTier">Service tier</option>
      <option value="model">Model</option>
      <option value="date">Calendar date</option>
      <option value="day">Benchmark day</option>
      <option value="trader">Trader</option>
      <option value="variant">Variant</option>
    </select>
  </div>
  <div class="wrap"><table id="tbl"><thead></thead><tbody></tbody></table></div>
</main>
<script id="data" type="application/json">
${json}
</script>
<script>
  const DATA = JSON.parse(document.getElementById('data').textContent);
  const usd = n => '$' + (n || 0).toFixed(4);
  const keyOf = (r, dim) => {
    if (dim === 'model') return r.model.alias;
    if (dim === 'date') return r.timestamp.slice(0, 10);
    if (dim === 'day') return (r.benchmark && r.benchmark.day) || '(none)';
    if (dim === 'trader') return (r.benchmark && r.benchmark.trader) || '(none)';
    if (dim === 'variant') return (r.benchmark && r.benchmark.variant) || '(none)';
    return r[dim];
  };
  document.getElementById('sub').textContent =
    DATA.totalRecords + ' requests · ' + DATA.totalTokens.toLocaleString() + ' tokens';
  const kpis = [
    ['Total spend', usd(DATA.totalUsd)],
    ['Standard tier', usd(DATA.standardUsd)],
    ['Batch tier', usd(DATA.batchUsd)],
    ['Net cache benefit', usd(DATA.netCacheBenefitUsd)],
    ['Cache read discount', usd(DATA.grossCacheReadDiscountUsd)],
    ['Requests', String(DATA.totalRecords)],
  ];
  document.getElementById('kpis').innerHTML = kpis
    .map(([l, v]) => '<div class="kpi"><div class="v">' + v + '</div><div class="l">' + l + '</div></div>')
    .join('');

  // Spend-over-time: one row per request calendar date, inline proportional bar.
  const otMax = Math.max(1, ...DATA.overTime.map(d => d.usd));
  document.querySelector('#ot tbody').innerHTML = DATA.overTime
    .map(d =>
      '<tr><td>' + d.date + '</td><td class="num">' + usd(d.usd) +
      '</td><td style="width:60%"><div class="bar"><span style="width:' +
      (100 * d.usd / otMax).toFixed(1) + '%"></span></div></td></tr>')
    .join('') || '<tr><td>(no data)</td></tr>';

  let sortKey = 'usd', sortDir = -1;
  function groups(dim) {
    const m = new Map();
    for (const r of DATA.records) {
      const k = keyOf(r, dim);
      const g = m.get(k) || { key: k, records: 0, usd: 0, tokens: 0 };
      g.records += 1;
      g.usd += (r.cost && r.cost.total) || 0;
      g.tokens += r.tokens.input + r.tokens.cacheRead + r.tokens.cacheCreate5m + r.tokens.cacheCreate1h + r.tokens.output;
      m.set(k, g);
    }
    return [...m.values()];
  }
  function render() {
    const dim = document.getElementById('groupBy').value;
    const rows = groups(dim).sort((a, b) => (a[sortKey] < b[sortKey] ? 1 : -1) * sortDir);
    const max = Math.max(1, ...rows.map(r => r.usd));
    const thead = document.querySelector('#tbl thead');
    const tbody = document.querySelector('#tbl tbody');
    thead.innerHTML =
      '<tr><th data-k="key">' + dim + '</th><th class="num" data-k="records">Requests</th>' +
      '<th class="num" data-k="tokens">Tokens</th><th class="num" data-k="usd">USD</th><th>Share</th></tr>';
    tbody.innerHTML = rows
      .map(r =>
        '<tr><td>' + r.key + '</td><td class="num">' + r.records + '</td><td class="num">' +
        r.tokens.toLocaleString() + '</td><td class="num">' + usd(r.usd) +
        '</td><td><div class="bar"><span style="width:' + (100 * r.usd / max).toFixed(1) + '%"></span></div></td></tr>')
      .join('');
    thead.querySelectorAll('th').forEach(th =>
      th.addEventListener('click', () => {
        const k = th.getAttribute('data-k');
        if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = -1; }
        render();
      }));
  }
  document.getElementById('groupBy').addEventListener('change', render);
  render();
</script>
</body>
</html>`;
}
