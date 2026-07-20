import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { dateForTimestamp } from './session.js';

const DEFAULT_INCOMING = 'ticker-data/incoming';
const DEFAULT_OUT = 'ticker-data/MES/min-5';
const DEFAULT_TZ = 'America/New_York';

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

// Reads inbox CSVs and appends only newer rows into the matching monthly file.
export function runIngest(args) {
  const { values } = parseArgs({
    args,
    options: {
      incoming: { type: 'string', default: DEFAULT_INCOMING },
      out: { type: 'string', default: DEFAULT_OUT },
      tz: { type: 'string', default: DEFAULT_TZ },
    },
  });
  const { incoming, out, tz } = values;

  if (!existsSync(incoming)) {
    console.log('nothing to ingest');
    return;
  }
  const inboxFiles = readdirSync(incoming).filter((f) => f.endsWith('.csv')).sort();
  if (inboxFiles.length === 0) {
    console.log('nothing to ingest');
    return;
  }

  mkdirSync(out, { recursive: true });

  for (const fileName of inboxFiles) {
    const inboxPath = join(incoming, fileName);
    const { header, rows } = readRawCsv(readFileSync(inboxPath, 'utf8'));
    if (rows.length === 0) {
      console.warn(`warning: ${inboxPath} has no data rows — leaving it in place`);
      continue;
    }

    // Group this file's rows by their target monthly file.
    const byMonth = new Map();
    for (const row of rows) {
      const monthFile = monthFileForTimestamp(row.time, tz);
      if (!byMonth.has(monthFile)) byMonth.set(monthFile, []);
      byMonth.get(monthFile).push(row);
    }

    // Validate + plan every month BEFORE writing anything for this file.
    const plans = [];
    for (const [monthFile, monthRows] of byMonth) {
      const outPath = join(out, monthFile);
      let created = true;
      let maxTime = -Infinity;
      let existingBody = null;
      if (existsSync(outPath)) {
        created = false;
        existingBody = readFileSync(outPath, 'utf8');
        const existing = readRawCsv(existingBody);
        if (existing.header !== header) {
          throw new Error(
            `${inboxPath}: header does not match ${outPath}\n` +
              `  inbox:    ${header}\n  existing: ${existing.header}`
          );
        }
        for (const r of existing.rows) if (r.time > maxTime) maxTime = r.time;
      }
      const fresh = monthRows.filter((r) => r.time > maxTime).sort((a, b) => a.time - b.time);
      plans.push({ outPath, monthFile, created, existingBody, fresh, skipped: monthRows.length - fresh.length });
    }

    // All months validated — now write.
    for (const p of plans) {
      if (p.created) {
        writeFileSync(p.outPath, [header, ...p.fresh.map((r) => r.line)].join('\n') + '\n');
      } else if (p.fresh.length > 0) {
        const base = p.existingBody.replace(/\n+$/, '');
        writeFileSync(p.outPath, base + '\n' + p.fresh.map((r) => r.line).join('\n') + '\n');
      }
      // Print immediately so already-applied work is reported even if a later
      // inbox file throws before the loop completes.
      console.log(
        `${p.monthFile}: ${p.created ? 'created' : 'appended'}, ` +
          `+${p.fresh.length} rows, ${p.skipped} skipped (not newer)`
      );
      // List the distinct calendar days the appended rows cover (session tz).
      // fresh is sorted ascending, so the Set preserves chronological order.
      if (p.fresh.length > 0) {
        const days = [...new Set(p.fresh.map((r) => dateForTimestamp(r.time, tz)))];
        console.log(`  new days: ${days.join(', ')}`);
      }
    }

    rmSync(inboxPath);
  }
}
