import { Candle } from './candle';

const REQUIRED = ['time', 'open', 'high', 'low', 'close'] as const;

// Parses TradingView-style CSV text into Candle objects, ignoring any
// indicator columns beyond the required OHLC set.
export function parseCsv(text: string): Candle[] {
  const lines = text.split(/\r?\n/);
  const rows: { lineNumber: number; cols: string[] }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') rows.push({ lineNumber: i + 1, cols: lines[i].split(',') });
  }
  if (rows.length < 2) throw new Error('CSV has no data rows');

  const header = rows[0].cols.map((h) => h.trim().toLowerCase());
  const idx: Record<string, number> = {};
  for (const name of REQUIRED) {
    const i = header.indexOf(name);
    if (i === -1) throw new Error(`CSV missing required column: ${name}`);
    idx[name] = i;
  }

  const candles = rows.slice(1).map(({ lineNumber, cols }) => {
    const candle: Record<string, number> = {};
    for (const name of REQUIRED) {
      const rawValue = cols[idx[name]];
      const value = Number(rawValue);
      if (rawValue === undefined || rawValue.trim() === '' || !Number.isFinite(value)) {
        throw new Error(`CSV line ${lineNumber}: invalid ${name} value "${rawValue ?? ''}"`);
      }
      candle[name] = value;
    }
    return candle as unknown as Candle;
  });
  candles.sort((a, b) => a.time - b.time);
  return candles;
}
