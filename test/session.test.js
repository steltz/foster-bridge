import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dateForTimestamp,
  latestDate,
  filterDay,
  minutesOfDayForTimestamp,
  filterTimeWindow,
} from '../src/session.js';

test('converts a unix timestamp to a calendar date in a timezone', () => {
  assert.equal(dateForTimestamp(1782876900, 'America/New_York'), '2026-06-30');
  assert.equal(dateForTimestamp(1782876900, 'UTC'), '2026-07-01');
});

test('latestDate returns the date of the last candle', () => {
  const candles = [{ time: 1782876900 }, { time: 1782876900 + 86400 }];
  assert.equal(latestDate(candles, 'UTC'), '2026-07-02');
});

test('minutesOfDayForTimestamp returns minutes since local midnight', () => {
  // 1782876900 is 23:35 in New York, 03:35 in UTC
  assert.equal(minutesOfDayForTimestamp(1782876900, 'America/New_York'), 23 * 60 + 35);
  assert.equal(minutesOfDayForTimestamp(1782876900, 'UTC'), 3 * 60 + 35);
});

test('filterTimeWindow keeps candles within [open, close) local minutes', () => {
  const open = Date.UTC(2026, 5, 30, 13, 30) / 1000; // 09:30 ET == 570 min
  const close = Date.UTC(2026, 5, 30, 20, 0) / 1000;  // 16:00 ET == 960 min (excluded)
  const after = Date.UTC(2026, 5, 30, 20, 30) / 1000; // 16:30 ET == 990 min (excluded)
  const candles = [{ time: open }, { time: close }, { time: after }];
  const rth = filterTimeWindow(candles, 'America/New_York', 570, 960);
  assert.deepEqual(rth.map((c) => c.time), [open]);
});

test('filterDay keeps only candles on the given date', () => {
  const candles = [
    { time: 1782876900 },            // 2026-06-30 NY
    { time: 1782876900 + 300 },      // 2026-06-30 NY
    { time: 1782876900 + 86400 },    // 2026-07-01 NY
  ];
  const day = filterDay(candles, '2026-06-30', 'America/New_York');
  assert.deepEqual(day.map((c) => c.time), [1782876900, 1782877200]);
});
