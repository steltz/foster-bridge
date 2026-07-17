import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseCsv } from './parse-csv.js';
import { normalizeOrders } from './orders.js';
import { filterDay, latestDate } from './session.js';
import { simulate } from './engine.js';
import { formatTable } from './report.js';

const USAGE =
  'Usage: backtest [run] --data <chart.csv> --orders <orders.json> ' +
  '[--date YYYY-MM-DD] [--tz <IANA timezone>] [--multiplier <n>] [--json]';

export function runBacktest(args) {
  const { values } = parseArgs({
    args,
    options: {
      data: { type: 'string' },
      orders: { type: 'string' },
      date: { type: 'string' },
      tz: { type: 'string', default: 'America/New_York' },
      multiplier: { type: 'string', default: '5' },
      json: { type: 'boolean', default: false },
    },
  });

  if (!values.data || !values.orders) throw new Error(USAGE);
  const multiplier = Number(values.multiplier);
  if (!Number.isFinite(multiplier)) throw new Error('--multiplier must be a number');
  if (values.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values.date)) {
    throw new Error('--date must be YYYY-MM-DD');
  }

  const candles = parseCsv(readFileSync(values.data, 'utf8'));

  let rawOrders;
  try {
    rawOrders = JSON.parse(readFileSync(values.orders, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read orders file: ${err.message}`);
  }
  const orders = normalizeOrders(rawOrders);

  const session = values.date ?? latestDate(candles, values.tz);
  const dayCandles = filterDay(candles, session, values.tz);
  if (dayCandles.length === 0) {
    throw new Error(`No candles found for ${session} (${values.tz})`);
  }

  const { results, summary } = simulate(dayCandles, orders, multiplier);

  if (values.json) {
    console.log(JSON.stringify({ session, orders: results, summary }, null, 2));
  } else {
    console.log(formatTable({ session, results, summary }, values.tz));
  }
}
