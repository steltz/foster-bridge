import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/parse-csv.js';

const HEADER = 'time,open,high,low,close,Some Indicator,@valuewhen';

test('parses required columns and ignores extra columns', () => {
  const text = [
    HEADER,
    '1782876900,7527.75,7531.75,7527.75,7531.25,junk,',
    '1782877200,7531.25,7531.75,7529,7529.5,,',
  ].join('\n');
  const candles = parseCsv(text);
  assert.deepEqual(candles, [
    { time: 1782876900, open: 7527.75, high: 7531.75, low: 7527.75, close: 7531.25 },
    { time: 1782877200, open: 7531.25, high: 7531.75, low: 7529, close: 7529.5 },
  ]);
});

test('sorts candles by time ascending', () => {
  const text = [
    HEADER,
    '200,2,2,2,2,,',
    '100,1,1,1,1,,',
  ].join('\n');
  const candles = parseCsv(text);
  assert.deepEqual(candles.map((c) => c.time), [100, 200]);
});

test('skips blank lines', () => {
  const text = `${HEADER}\n\n100,1,2,0.5,1.5,,\n\n`;
  assert.equal(parseCsv(text).length, 1);
});

test('rejects a missing required column', () => {
  assert.throws(
    () => parseCsv('time,open,high,low\n100,1,2,0.5'),
    /missing required column: close/
  );
});

test('rejects a non-numeric value with the line number', () => {
  const text = `${HEADER}\n100,1,2,0.5,1.5,,\n200,1,abc,0.5,1.5,,`;
  assert.throws(() => parseCsv(text), /line 3: invalid high/);
});
