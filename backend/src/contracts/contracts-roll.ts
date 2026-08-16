// The verified eminiplayer roll rule (docs/es-contract-roll-convention.md):
// a TP day belongs to the front quarterly until the Monday of expiration
// week (third Friday - 4 days), when it switches to the next quarterly.
// Pure calendar math on ET calendar dates — no I/O, no timezones.

const QUARTER_MONTHS = [3, 6, 9, 12] as const;
type QuarterMonth = (typeof QUARTER_MONTHS)[number];
const MONTH_CODES: Record<QuarterMonth, string> = { 3: 'H', 6: 'M', 9: 'U', 12: 'Z' };

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function rollSwitchMonday(year: number, quarterMonth: QuarterMonth): string {
  const firstDow = new Date(Date.UTC(year, quarterMonth - 1, 1)).getUTCDay();
  const firstFriday = 1 + ((5 - firstDow + 7) % 7);
  const thirdFriday = firstFriday + 14;
  return isoDate(year, quarterMonth, thirdFriday - 4);
}

export function resolveContract(base: 'ES', date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`resolveContract: date must be YYYY-MM-DD, got "${date}"`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`resolveContract: invalid date "${date}"`);
  }

  let quarterIndex = QUARTER_MONTHS.findIndex((m) => m >= month);
  let quarterYear = year;
  // month <= 12 always finds an index (12 is the last entry).
  if (date >= rollSwitchMonday(quarterYear, QUARTER_MONTHS[quarterIndex])) {
    quarterIndex += 1;
    if (quarterIndex === QUARTER_MONTHS.length) {
      quarterIndex = 0;
      quarterYear += 1;
    }
  }
  const quarterMonth = QUARTER_MONTHS[quarterIndex];
  return `${base}${MONTH_CODES[quarterMonth]}${String(quarterYear % 100).padStart(2, '0')}`;
}
