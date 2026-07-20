import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthFileForTimestamp, readRawCsv } from '../src/ingest-command.js';

const TZ = 'America/New_York';

test('monthFileForTimestamp buckets by the session timezone, not UTC', () => {
  // 2026-07-01 00:00 ET
  assert.equal(monthFileForTimestamp(1782878400, TZ), 'mes_july.csv');
  // 2026-08-01 00:00 ET
  assert.equal(monthFileForTimestamp(1785556800, TZ), 'mes_august.csv');
  // 2026-07-31 23:55 ET === 2026-08-01 03:55 UTC -> July, proving ET bucketing
  assert.equal(monthFileForTimestamp(1785556500, TZ), 'mes_july.csv');
});

test('readRawCsv keeps data lines verbatim and parses the time cell', () => {
  const text = [
    'time,open,high,low,close,Internal Higher High,@valuewhen',
    '200,2,2,2,2,foo,bar',
    '100,1,1,1,1,,',
  ].join('\n');
  const { header, rows } = readRawCsv(text);
  assert.equal(header, 'time,open,high,low,close,Internal Higher High,@valuewhen');
  assert.deepEqual(rows, [
    { time: 200, line: '200,2,2,2,2,foo,bar' },
    { time: 100, line: '100,1,1,1,1,,' },
  ]);
});

test('readRawCsv locates time even when it is not the first column', () => {
  const { rows } = readRawCsv('open,time\n1,150');
  assert.deepEqual(rows, [{ time: 150, line: '1,150' }]);
});

test('readRawCsv throws when the time column is missing', () => {
  assert.throws(() => readRawCsv('open,high\n1,2'), /missing required column: time/);
});

test('readRawCsv throws on a non-numeric time cell, citing the line number', () => {
  assert.throws(() => readRawCsv('time,open\n100,1\nx,2'), /line 3: invalid time value "x"/);
});

test('readRawCsv returns no rows for a header-only file', () => {
  assert.deepEqual(readRawCsv('time,open').rows, []);
});
