export interface HasTime {
  time: number; // Unix epoch seconds
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>();
function dayFormatterFor(tz: string): Intl.DateTimeFormat {
  let fmt = dayFormatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFormatters.set(tz, fmt);
  }
  return fmt;
}

const timeFormatters = new Map<string, Intl.DateTimeFormat>();
function timeFormatterFor(tz: string): Intl.DateTimeFormat {
  let fmt = timeFormatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    timeFormatters.set(tz, fmt);
  }
  return fmt;
}

// en-CA formats as YYYY-MM-DD.
export function dateForTimestamp(unixSeconds: number, tz: string): string {
  return dayFormatterFor(tz).format(new Date(unixSeconds * 1000));
}

// Minutes since local midnight in `tz` (0..1439).
export function minutesOfDayForTimestamp(unixSeconds: number, tz: string): number {
  const parts = timeFormatterFor(tz).formatToParts(new Date(unixSeconds * 1000));
  const hour = Number(parts.find((p) => p.type === 'hour')!.value);
  const minute = Number(parts.find((p) => p.type === 'minute')!.value);
  return hour * 60 + minute;
}

export function latestDate<T extends HasTime>(candles: T[], tz: string): string {
  return dateForTimestamp(candles[candles.length - 1].time, tz);
}

export function filterDay<T extends HasTime>(candles: T[], date: string, tz: string): T[] {
  return candles.filter((c) => dateForTimestamp(c.time, tz) === date);
}

// Keeps candles whose local time of day is in [openMinutes, closeMinutes).
export function filterTimeWindow<T extends HasTime>(candles: T[], tz: string, openMinutes: number, closeMinutes: number): T[] {
  return candles.filter((c) => {
    const m = minutesOfDayForTimestamp(c.time, tz);
    return m >= openMinutes && m < closeMinutes;
  });
}

// 'HH:MM' -> minutes since midnight.
export function hhmmToMinutes(hhmm: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!match) throw new Error(`Invalid HH:MM time: "${hhmm}"`);
  return Number(match[1]) * 60 + Number(match[2]);
}
