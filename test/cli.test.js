import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const chart = fileURLToPath(new URL('./fixtures/chart.csv', import.meta.url));
const ordersFile = fileURLToPath(new URL('./fixtures/orders.json', import.meta.url));

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

test('runs a backtest and emits JSON results', () => {
  const proc = run(['--data', chart, '--orders', ordersFile, '--json']);
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
  const proc = run(['--data', chart, '--orders', ordersFile]);
  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /Session: 2026-06-30/);
  assert.match(proc.stdout, /win\s+long\s+TP/);
  assert.match(proc.stdout, /Net: 10\.00 pts {2}\$50\.00/);
});

test('respects --tz for session selection', () => {
  const proc = run(['--data', chart, '--orders', ordersFile, '--tz', 'UTC', '--json']);
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
  const proc = run(['run', '--data', chart, '--orders', ordersFile, '--json']);
  assert.equal(proc.status, 0, proc.stderr);
  assert.equal(JSON.parse(proc.stdout).session, '2026-06-30');
});

test('unknown command errors with usage', () => {
  const proc = run(['bogus']);
  assert.equal(proc.status, 1);
  assert.equal(proc.stdout, '');
  assert.match(proc.stderr, /Unknown command "bogus"/);
});
