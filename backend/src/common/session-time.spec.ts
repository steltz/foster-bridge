import {
  dateForTimestamp,
  minutesOfDayForTimestamp,
  filterDay,
  filterTimeWindow,
  latestDate,
  hhmmToMinutes,
} from './session-time';

// 2026-07-14 13:30:00 UTC == 09:30 America/New_York (EDT, UTC-4).
const T_0930_ET = Math.floor(Date.UTC(2026, 6, 14, 13, 30, 0) / 1000);
const T_0935_ET = T_0930_ET + 300;

describe('session-time', () => {
  it('dateForTimestamp returns YYYY-MM-DD in the tz', () => {
    expect(dateForTimestamp(T_0930_ET, 'America/New_York')).toBe('2026-07-14');
  });

  it('minutesOfDayForTimestamp returns local minutes since midnight', () => {
    expect(minutesOfDayForTimestamp(T_0930_ET, 'America/New_York')).toBe(570);
  });

  it('filterDay keeps only candles on the given local day', () => {
    const candles = [{ time: T_0930_ET }, { time: T_0930_ET - 86400 }] as any;
    expect(filterDay(candles, '2026-07-14', 'America/New_York')).toHaveLength(1);
  });

  it('filterTimeWindow keeps [open, close) local minutes', () => {
    const candles = [{ time: T_0930_ET }, { time: T_0935_ET }] as any;
    // window [570, 575) keeps only the 09:30 candle
    expect(filterTimeWindow(candles, 'America/New_York', 570, 575)).toHaveLength(1);
  });

  it('latestDate returns the last candle local day', () => {
    expect(latestDate([{ time: T_0930_ET }] as any, 'America/New_York')).toBe('2026-07-14');
  });

  it('hhmmToMinutes parses HH:MM', () => {
    expect(hhmmToMinutes('09:30')).toBe(570);
    expect(hhmmToMinutes('16:00')).toBe(960);
  });
});
