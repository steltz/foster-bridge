const REQUIRED = ['time', 'open', 'high', 'low', 'close'];

// Parses TradingView-style CSV text into candle objects, ignoring any
// indicator columns beyond the required OHLC set.
export function parseCsv(text) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') rows.push({ lineNumber: i + 1, cols: lines[i].split(',') });
  }
  if (rows.length < 2) throw new Error('CSV has no data rows');

  const header = rows[0].cols.map((h) => h.trim().toLowerCase());
  const idx = {};
  for (const name of REQUIRED) {
    const i = header.indexOf(name);
    if (i === -1) throw new Error(`CSV missing required column: ${name}`);
    idx[name] = i;
  }

  const candles = rows.slice(1).map(({ lineNumber, cols }) => {
    const candle = {};
    for (const name of REQUIRED) {
      const value = Number(cols[idx[name]]);
      if (!Number.isFinite(value)) {
        throw new Error(`CSV line ${lineNumber}: invalid ${name} value "${cols[idx[name]] ?? ''}"`);
      }
      candle[name] = value;
    }
    return candle;
  });
  candles.sort((a, b) => a.time - b.time);
  return candles;
}
