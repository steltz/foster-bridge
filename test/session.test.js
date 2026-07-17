import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dateForTimestamp, latestDate, filterDay } from '../src/session.js';

test('converts a unix timestamp to a calendar date in a timezone', () => {
  assert.equal(dateForTimestamp(1782876900, 'America/New_York'), '2026-06-30');
  assert.equal(dateForTimestamp(1782876900, 'UTC'), '2026-07-01');
});

test('latestDate returns the date of the last candle', () => {
  const candles = [{ time: 1782876900 }, { time: 1782876900 + 86400 }];
  assert.equal(latestDate(candles, 'UTC'), '2026-07-02');
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
