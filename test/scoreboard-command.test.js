import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
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

test('scoreboard walks the runs tree and writes SCOREBOARD.md', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeCell(dir, 'context-trader', 'fable', '07012026', 1, { status: 'TP', points: 10, dollars: 50 });
  writeCell(dir, 'context-trader', 'fable', '07012026', 2, { status: 'SL', points: -4, dollars: -20 });
  writeCell(dir, 'placement-trader', 'fable', '07012026', 1, { status: 'NOT_FILLED', points: null, dollars: null });

  const proc = run(['scoreboard', '--dir', dir, '--traders', join(dir, 'no-traders')]);
  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /Wrote .*SCOREBOARD\.md \(3 cells\)/);

  const md = readFileSync(join(dir, 'SCOREBOARD.md'), 'utf8');
  assert.match(md, /\| 1 \| context-trader \| fable \|/);
  assert.match(md, /\| 2 \| placement-trader \| fable \|/);
});

test('scoreboard ignores files that are not run-<k>.json', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeCell(dir, 'context-trader', 'fable', '07012026', 1, { status: 'TP', points: 10, dollars: 50 });
  writeFileSync(join(dir, 'context-trader', 'fable', '07012026', 'notes.txt'), 'ignore me');

  const proc = run(['scoreboard', '--dir', dir, '--traders', join(dir, 'no-traders')]);
  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /\(1 cells\)/);
});

test('scoreboard with no cells writes a stub and exits 0', (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'bench-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const dir = join(parent, 'runs');
  assert.equal(existsSync(dir), false);

  const proc = run(['scoreboard', '--dir', dir, '--traders', join(parent, 'no-traders')]);
  assert.equal(proc.status, 0, proc.stderr);
  const md = readFileSync(join(dir, 'SCOREBOARD.md'), 'utf8');
  assert.match(md, /No benchmark cells found/);
});

test('scoreboard names the offending file on a corrupt cell', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeCell(dir, 'context-trader', 'fable', '07012026', 1, { status: 'TP', points: 10, dollars: 50 });
  writeFileSync(join(dir, 'context-trader', 'fable', '07012026', 'run-2.json'), 'not json');

  const proc = run(['scoreboard', '--dir', dir, '--traders', join(dir, 'no-traders')]);
  assert.equal(proc.status, 1);
  assert.match(proc.stderr, /run-2\.json/);
});

test('scoreboard renders lineage from --traders frontmatter', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tradersDir = join(dir, 'traders');
  mkdirSync(tradersDir);
  writeFileSync(
    join(tradersDir, 'basehit-trader.md'),
    '---\nname: basehit-trader\nstyle: s\n---\nbody\n'
  );
  writeFileSync(
    join(tradersDir, 'basehit-deeper-entry.md'),
    '---\nname: basehit-deeper-entry\nstyle: s\norigin: basehit-trader\nmutation: deeper entries\n---\nbody\n'
  );
  writeCell(dir, 'basehit-trader', 'fable', '07012026', 1, { status: 'TP', points: 10, dollars: 50 });
  writeCell(dir, 'basehit-deeper-entry', 'fable', '07012026', 1, { status: 'TP', points: 20, dollars: 100 });

  const proc = run(['scoreboard', '--dir', dir, '--traders', tradersDir]);
  assert.equal(proc.status, 0, proc.stderr);
  const md = readFileSync(join(dir, 'SCOREBOARD.md'), 'utf8');
  assert.match(md, /## Lineage/);
  assert.match(md, /└─ basehit-deeper-entry\s+fable 1r: 100\.00 \(Δ vs origin: \+50\.00\)/);
  assert.match(md, /Origin: basehit-trader — deeper entries/);
});

test('scoreboard omits lineage when the traders dir is missing', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeCell(dir, 'context-trader', 'fable', '07012026', 1, { status: 'TP', points: 10, dollars: 50 });

  const proc = run(['scoreboard', '--dir', dir, '--traders', join(dir, 'no-such-dir')]);
  assert.equal(proc.status, 0, proc.stderr);
  const md = readFileSync(join(dir, 'SCOREBOARD.md'), 'utf8');
  assert.doesNotMatch(md, /## Lineage/);
});

test('scoreboard default --traders resolves relative to cwd', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'bench-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const tradersDir = join(tmp, 'traders');
  mkdirSync(tradersDir);
  writeFileSync(
    join(tradersDir, 'context-trader.md'),
    '---\nname: context-trader\nstyle: s\n---\nbody\n'
  );
  writeFileSync(
    join(tradersDir, 'context-deeper-entry.md'),
    '---\nname: context-deeper-entry\nstyle: s\norigin: context-trader\nmutation: deeper entries\n---\nbody\n'
  );
  writeCell(join(tmp, 'runs'), 'context-trader', 'fable', '07012026', 1, { status: 'TP', points: 10, dollars: 50 });
  writeCell(join(tmp, 'runs'), 'context-deeper-entry', 'fable', '07012026', 1, { status: 'TP', points: 20, dollars: 100 });

  const proc = spawnSync(process.execPath, [cli, 'scoreboard'], { encoding: 'utf8', cwd: tmp });
  assert.equal(proc.status, 0, proc.stderr);
  const md = readFileSync(join(tmp, 'runs', 'SCOREBOARD.md'), 'utf8');
  assert.match(md, /## Lineage/);
  assert.match(md, /└─ context-deeper-entry/);
});
