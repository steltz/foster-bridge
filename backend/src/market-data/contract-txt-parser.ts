import { Candle } from './candle';

// Parses the local per-contract export format: headerless lines of
//   YYYY-MM-DD HH:MM:SS,open,high,low,close,volume
// with ET-naive wall times. Volume is required on every parsed candle and
// stored as `v` on the day-doc. Any malformed row fails the whole file —
// reject, don't guess.

// Numeric fields are restricted to number-shaped characters — `[^,]+` would
// let a whitespace-only field through, and Number(' ') === 0 silently. The
// Number.isFinite check below stays as backstop.
const ROW_RE =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}),([0-9.eE+-]+),([0-9.eE+-]+),([0-9.eE+-]+),([0-9.eE+-]+),([0-9.eE+-]+)$/;

const ET = 'America/New_York';
const etFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: ET,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
});

// Offset (ms) such that: wall-clock-in-ET-as-if-UTC == epochMs + offset.
function etOffsetAt(epochMs: number): number {
  const parts = etFmt.formatToParts(new Date(epochMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - epochMs;
}

export function etWallTimeToEpochSeconds(
  year: number, month: number, day: number, hour: number, minute: number, second: number,
): number {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  // Two passes converge on the correct offset across DST transitions.
  let epoch = utcGuess - etOffsetAt(utcGuess);
  epoch = utcGuess - etOffsetAt(epoch);
  return epoch / 1000;
}

/** Every txt-sourced candle carries volume — required, not optional. */
export type ContractCandle = Candle & { volume: number };

export function parseContractTxt(text: string): ContractCandle[] {
  const lines = text.split(/\r?\n/);
  const candles: ContractCandle[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    const m = ROW_RE.exec(line);
    if (!m) throw new Error(`contract txt line ${i + 1}: unexpected row shape "${line.slice(0, 60)}"`);
    const [open, high, low, close] = [m[7], m[8], m[9], m[10]].map(Number);
    const volume = Number(m[11]);
    if (![open, high, low, close, volume].every(Number.isFinite)) {
      throw new Error(`contract txt line ${i + 1}: non-numeric OHLCV value`);
    }
    candles.push({
      time: etWallTimeToEpochSeconds(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])),
      open, high, low, close, volume,
    });
  }
  if (candles.length === 0) throw new Error('contract txt has no data rows');
  candles.sort((a, b) => a.time - b.time);
  return candles;
}
