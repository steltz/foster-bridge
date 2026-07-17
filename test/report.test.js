import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTable } from '../src/report.js';

const payload = {
  session: '2026-06-30',
  results: [
    {
      id: 'long-1', side: 'long', status: 'TP', qty: 1,
      entry: 100, stopLoss: 95, takeProfit: 110,
      fillTime: 1782876900, exitTime: 1782877200, exitPrice: 110,
      points: 10, dollars: 50,
    },
    {
      id: 'miss', side: 'short', status: 'NOT_FILLED', qty: 1,
      entry: 200, stopLoss: 210, takeProfit: 190,
      fillTime: null, exitTime: null, exitPrice: null,
      points: null, dollars: null,
    },
  ],
  summary: { orders: 2, filled: 1, wins: 1, losses: 0, netPoints: 10, netDollars: 50 },
};

test('formats a session header, order rows, and summary', () => {
  const out = formatTable(payload, 'America/New_York');
  assert.match(out, /Session: 2026-06-30/);
  assert.match(out, /ID\s+SIDE\s+STATUS\s+FILL\s+EXIT\s+EXIT PX\s+PTS\s+USD/);
  // 1782876900 = 23:35 New York, 1782877200 = 23:40
  assert.match(out, /long-1\s+long\s+TP\s+23:35\s+23:40\s+110\s+10\.00\s+50\.00/);
  assert.match(out, /miss\s+short\s+NOT_FILLED\s+-\s+-\s+-\s+-\s+-/);
  assert.match(out, /Orders: 2 {2}Filled: 1 {2}Wins: 1 {2}Losses: 0/);
  assert.match(out, /Net: 10\.00 pts {2}\$50\.00/);
});
