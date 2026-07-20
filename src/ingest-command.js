import { dateForTimestamp } from './session.js';

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

// Monthly file name for a candle, bucketed by month in the session timezone.
// dateForTimestamp returns YYYY-MM-DD; the MM segment selects the month name.
export function monthFileForTimestamp(unixSeconds, tz) {
  const month = Number(dateForTimestamp(unixSeconds, tz).slice(5, 7));
  return `mes_${MONTHS[month - 1]}.csv`;
}

// Splits TradingView-style CSV text into { header, rows }, keeping every data
// line verbatim (so indicator columns survive) and parsing only the time cell.
// Blank lines are ignored. Throws on a missing time column or an unparseable
// time cell. A header-only file yields rows: [].
export function readRawCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = lines[0] ?? '';
  const timeIdx = header.split(',').map((h) => h.trim().toLowerCase()).indexOf('time');
  if (timeIdx === -1) throw new Error('CSV missing required column: time');
  const rows = lines.slice(1).map((line, i) => {
    const raw = line.split(',')[timeIdx];
    const time = Number(raw);
    if (raw === undefined || raw.trim() === '' || !Number.isFinite(time)) {
      throw new Error(`CSV line ${i + 2}: invalid time value "${raw ?? ''}"`);
    }
    return { time, line };
  });
  return { header, rows };
}
