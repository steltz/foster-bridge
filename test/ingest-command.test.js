import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthFileForTimestamp, readRawCsv } from '../src/ingest-command.js';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const HEADER = 'time,open,high,low,close,Internal Higher High,@valuewhen';

// Builds a temp inbox + out dir pair and returns paths plus a runner.
function harness(t) {
  const root = mkdtempSync(join(tmpdir(), 'ingest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const incoming = join(root, 'incoming');
  const out = join(root, 'out');
  mkdirSync(incoming, { recursive: true });
  mkdirSync(out, { recursive: true });
  const run = () =>
    spawnSync(
      process.execPath,
      [cli, 'ingest', '--incoming', incoming, '--out', out, '--tz', 'America/New_York'],
      { encoding: 'utf8' }
    );
  return { incoming, out, run };
}

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

test('creates a new monthly file with header + all rows when none exists', (t) => {
  const { incoming, out, run } = harness(t);
  writeFileSync(join(incoming, 'new.csv'), `${HEADER}\n1782878400,7532.5,7532.75,7528.25,7529.75,foo,bar\n`);
  const proc = run();
  assert.equal(proc.status, 0, proc.stderr);
  const written = readFileSync(join(out, 'mes_july.csv'), 'utf8');
  assert.equal(written, `${HEADER}\n1782878400,7532.5,7532.75,7528.25,7529.75,foo,bar\n`);
  assert.match(proc.stdout, /mes_july\.csv: created, \+1 rows, 0 skipped/);
});

test('appends only rows strictly newer than the current max, keeping sort order', (t) => {
  const { incoming, out, run } = harness(t);
  writeFileSync(join(out, 'mes_july.csv'), `${HEADER}\n1782878400,1,1,1,1,,\n1782878700,2,2,2,2,,\n`);
  writeFileSync(
    join(incoming, 'more.csv'),
    // 1782878500 is still July 1 ET (between the existing rows) but <= the
    // current max, so it's a stale/skip case, not a month-boundary crossing.
    `${HEADER}\n1782879300,4,4,4,4,,\n1782878700,2,2,2,2,,\n1782879000,3,3,3,3,,\n1782878500,0,0,0,0,,\n`
  );
  const proc = run();
  assert.equal(proc.status, 0, proc.stderr);
  const written = readFileSync(join(out, 'mes_july.csv'), 'utf8');
  assert.equal(
    written,
    `${HEADER}\n1782878400,1,1,1,1,,\n1782878700,2,2,2,2,,\n1782879000,3,3,3,3,,\n1782879300,4,4,4,4,,\n`
  );
  assert.match(proc.stdout, /mes_july\.csv: appended, \+2 rows, 2 skipped/);
});

test('preserves indicator columns verbatim on append', (t) => {
  const { incoming, out, run } = harness(t);
  writeFileSync(join(out, 'mes_july.csv'), `${HEADER}\n1782878400,1,1,1,1,,\n`);
  writeFileSync(join(incoming, 'ind.csv'), `${HEADER}\n1782878700,2,2,2,2,keepme,alsokeep\n`);
  assert.equal(run().status, 0);
  assert.match(readFileSync(join(out, 'mes_july.csv'), 'utf8'), /1782878700,2,2,2,2,keepme,alsokeep/);
});

test('deletes each inbox file after a successful append', (t) => {
  const { incoming, out, run } = harness(t);
  writeFileSync(join(incoming, 'gone.csv'), `${HEADER}\n1782878400,1,1,1,1,,\n`);
  assert.equal(run().status, 0);
  assert.equal(existsSync(join(incoming, 'gone.csv')), false);
});
