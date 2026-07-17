import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseCsv } from './parse-csv.js';
import { normalizeOrders } from './orders.js';
import { filterDay, latestDate } from './session.js';
import { simulate } from './engine.js';
import { formatTable } from './report.js';

const USAGE =
  'Usage: backtest [run] --data <chart.csv> --orders <orders.json> ' +
  '[--date YYYY-MM-DD] [--tz <IANA timezone>] [--multiplier <n>] ' +
  '[--entry-cutoff HH:MM|off] [--json]';

// No new entries at or after this local time of day, unless overridden.
const DEFAULT_ENTRY_CUTOFF = '14:00';

// Returns minutes since local midnight, or null when the cutoff is disabled.
function parseEntryCutoff(value) {
  if (value === 'off' || value === 'none' || value === '') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  const hour = match && Number(match[1]);
  const minute = match && Number(match[2]);
  if (!match || hour > 23 || minute > 59) {
    throw new Error('--entry-cutoff must be a 24-hour HH:MM time or "off"');
  }
  return hour * 60 + minute;
}

export function runBacktest(args) {
  const { values } = parseArgs({
    args,
    options: {
      data: { type: 'string' },
      orders: { type: 'string' },
      date: { type: 'string' },
      tz: { type: 'string', default: 'America/New_York' },
      multiplier: { type: 'string', default: '5' },
      'entry-cutoff': { type: 'string', default: DEFAULT_ENTRY_CUTOFF },
      json: { type: 'boolean', default: false },
    },
  });

  if (!values.data || !values.orders) throw new Error(USAGE);
  const multiplier = Number(values.multiplier);
  if (!Number.isFinite(multiplier)) throw new Error('--multiplier must be a number');
  if (values.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values.date)) {
    throw new Error('--date must be YYYY-MM-DD');
  }
  const cutoffMinutes = parseEntryCutoff(values['entry-cutoff']);

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

  const { results, summary } = simulate(dayCandles, orders, multiplier, {
    cutoffMinutes,
    tz: values.tz,
  });

  if (values.json) {
    console.log(JSON.stringify({ session, orders: results, summary }, null, 2));
  } else {
    console.log(formatTable({ session, results, summary }, values.tz));
  }
}
