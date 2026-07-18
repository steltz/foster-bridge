import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

function writeCell(dir, trader, model, day, runIndex, result, setup) {
  const cellDir = join(dir, trader, model, day);
  mkdirSync(cellDir, { recursive: true });
  const cell = {
    trader,
    model: { alias: model, id: 'claude-test' },
    day,
    date: '2026-07-01',
    runIndex,
    timestamp: '2026-07-18T14:00:00.000Z',
    personaSha256: 'aaa',
    setup: setup ?? { side: 'long', entry: 7500, stopLoss: 7490, takeProfit: 7530, rationale: 'r' },
    result,
  };
  writeFileSync(join(cellDir, `run-${runIndex}.json`), JSON.stringify(cell, null, 2));
}

test('scoreboard walks the runs tree and writes SCOREBOARD.md', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-'));
  writeCell(dir, 'context-trader', 'fable', '07012026', 1, { status: 'TP', points: 10, dollars: 50 });
  writeCell(dir, 'context-trader', 'fable', '07012026', 2, { status: 'SL', points: -4, dollars: -20 });
  writeCell(dir, 'placement-trader', 'fable', '07012026', 1, { status: 'NOT_FILLED', points: null, dollars: null });

  const proc = run(['scoreboard', '--dir', dir]);
  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /Wrote .*SCOREBOARD\.md \(3 cells\)/);

  const md = readFileSync(join(dir, 'SCOREBOARD.md'), 'utf8');
  assert.match(md, /\| 1 \| context-trader \| fable \|/);
  assert.match(md, /\| 2 \| placement-trader \| fable \|/);
});

test('scoreboard ignores files that are not run-<k>.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-'));
  writeCell(dir, 'context-trader', 'fable', '07012026', 1, { status: 'TP', points: 10, dollars: 50 });
  writeFileSync(join(dir, 'context-trader', 'fable', '07012026', 'notes.txt'), 'ignore me');

  const proc = run(['scoreboard', '--dir', dir]);
  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /\(1 cells\)/);
});

test('scoreboard with no cells writes a stub and exits 0', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'bench-')), 'runs');
  assert.equal(existsSync(dir), false);

  const proc = run(['scoreboard', '--dir', dir]);
  assert.equal(proc.status, 0, proc.stderr);
  const md = readFileSync(join(dir, 'SCOREBOARD.md'), 'utf8');
  assert.match(md, /No benchmark cells found/);
});
