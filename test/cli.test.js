import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const chart = fileURLToPath(new URL('./fixtures/chart.csv', import.meta.url));
const ordersFile = fileURLToPath(new URL('./fixtures/orders.json', import.meta.url));
const chartRth = fileURLToPath(new URL('./fixtures/chart-rth.csv', import.meta.url));
const ordersRth = fileURLToPath(new URL('./fixtures/orders-rth.json', import.meta.url));

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

// The fixture candles are stamped 23:35 ET — outside regular hours and past
// the default 14:00 entry cutoff — so tests that expect a fill run in
// full-session mode with the cutoff disabled.
test('runs a backtest and emits JSON results', () => {
  const proc = run(['--data', chart, '--orders', ordersFile, '--session', 'full', '--entry-cutoff', 'off', '--json']);
  assert.equal(proc.status, 0, proc.stderr);
  const out = JSON.parse(proc.stdout);
  assert.equal(out.session, '2026-06-30');
  assert.equal(out.orders.length, 2);
  assert.equal(out.orders[0].id, 'win');
  assert.equal(out.orders[0].status, 'TP');
  assert.equal(out.orders[0].points, 10);
  assert.equal(out.orders[0].dollars, 50);
  assert.equal(out.orders[1].status, 'NOT_FILLED');
  assert.deepEqual(out.summary, {
    orders: 2, filled: 1, wins: 1, losses: 0, netPoints: 10, netDollars: 50,
  });
});

test('default output is the human-readable table', () => {
  const proc = run(['--data', chart, '--orders', ordersFile, '--session', 'full', '--entry-cutoff', 'off']);
  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /Session: 2026-06-30/);
  assert.match(proc.stdout, /win\s+long\s+TP/);
  assert.match(proc.stdout, /Net: 10\.00 pts {2}\$50\.00/);
});

test('defaults to blocking entries after 2pm ET', () => {
  // Full session so the 23:35 ET candles exist; default 14:00 cutoff blocks the fill.
  const proc = run(['--data', chart, '--orders', ordersFile, '--session', 'full', '--json']);
  assert.equal(proc.status, 0, proc.stderr);
  const out = JSON.parse(proc.stdout);
  assert.equal(out.orders[0].status, 'NOT_FILLED');
  assert.equal(out.summary.filled, 0);
});

test('accepts a custom --entry-cutoff time', () => {
  // 23:40 ET cutoff still allows the 23:35 ET fill (full session).
  const proc = run(['--data', chart, '--orders', ordersFile, '--session', 'full', '--entry-cutoff', '23:40', '--json']);
  assert.equal(proc.status, 0, proc.stderr);
  assert.equal(JSON.parse(proc.stdout).orders[0].status, 'TP');
});

test('rejects a malformed --entry-cutoff value', () => {
  const proc = run(['--data', chart, '--orders', ordersFile, '--entry-cutoff', 'noon']);
  assert.equal(proc.status, 1);
  assert.equal(proc.stdout, '');
  assert.match(proc.stderr, /entry-cutoff/);
});

test('defaults to regular trading hours: a pre-market entry does not fill', () => {
  // chart-rth has an 08:00 ET candle that would fill (and is before the 14:00
  // cutoff, so only RTH can exclude it) and a 10:00 ET candle that does not
  // touch. RTH is the default, so the pre-market fill is excluded.
  const proc = run(['--data', chartRth, '--orders', ordersRth, '--json']);
  assert.equal(proc.status, 0, proc.stderr);
  assert.equal(JSON.parse(proc.stdout).orders[0].status, 'NOT_FILLED');
});

test('--session full includes hours outside the regular session', () => {
  const proc = run(['--data', chartRth, '--orders', ordersRth, '--session', 'full', '--json']);
  assert.equal(proc.status, 0, proc.stderr);
  assert.equal(JSON.parse(proc.stdout).orders[0].status, 'TP');
});

test('errors when a day has no regular-hours candles', () => {
  // The overnight fixture (23:35 ET) has no candles inside 09:30-16:00 ET.
  const proc = run(['--data', chart, '--orders', ordersFile]);
  assert.equal(proc.status, 1);
  assert.equal(proc.stdout, '');
  assert.match(proc.stderr, /regular/i);
});

test('rejects an unknown --session value', () => {
  const proc = run(['--data', chartRth, '--orders', ordersRth, '--session', 'weekend']);
  assert.equal(proc.status, 1);
  assert.equal(proc.stdout, '');
  assert.match(proc.stderr, /session/i);
});

test('respects --tz for session selection', () => {
  const proc = run(['--data', chart, '--orders', ordersFile, '--tz', 'UTC', '--session', 'full', '--json']);
  assert.equal(proc.status, 0, proc.stderr);
  assert.equal(JSON.parse(proc.stdout).session, '2026-07-01');
});

test('errors on a --date with no candles', () => {
  const proc = run(['--data', chart, '--orders', ordersFile, '--date', '2020-01-01']);
  assert.equal(proc.status, 1);
  assert.match(proc.stderr, /No candles found for 2020-01-01/);
  assert.equal(proc.stdout, '');
});

test('errors on a missing data file', () => {
  const proc = run(['--data', 'nope.csv', '--orders', ordersFile]);
  assert.equal(proc.status, 1);
  assert.match(proc.stderr, /nope\.csv/);
  assert.equal(proc.stdout, '');
});

test('errors when required flags are missing', () => {
  const proc = run([]);
  assert.equal(proc.status, 1);
  assert.match(proc.stderr, /Usage:/);
  assert.equal(proc.stdout, '');
});

test('explicit run subcommand works', () => {
  const proc = run(['run', '--data', chart, '--orders', ordersFile, '--session', 'full', '--json']);
  assert.equal(proc.status, 0, proc.stderr);
  assert.equal(JSON.parse(proc.stdout).session, '2026-06-30');
});

test('unknown command errors with usage', () => {
  const proc = run(['bogus']);
  assert.equal(proc.status, 1);
  assert.equal(proc.stdout, '');
  assert.match(proc.stderr, /Unknown command "bogus"/);
});
