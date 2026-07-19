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

function writeCell(dir, trader, model, day, variant, runIndex, result, setup) {
  const cellDir = join(dir, trader, model, day, variant);
  mkdirSync(cellDir, { recursive: true });
  const cell = {
    trader,
    model: { alias: model, id: 'claude-test' },
    day,
    date: '2026-07-01',
    variant,
    runIndex,
    timestamp: '2026-07-18T14:00:00.000Z',
    personaSha256: 'aaa',
    setup: setup ?? { side: 'long', entry: 7500, stopLoss: 7490, takeProfit: 7530, rationale: 'r' },
    result,
  };
  writeFileSync(join(cellDir, `run-${runIndex}.json`), JSON.stringify(cell, null, 2));
}

test('scoreboard walks the runs tree (including the variant level) and writes SCOREBOARD.md', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeCell(dir, 'context-trader', 'fable', '07012026', 'base', 1, { status: 'TP', points: 10, dollars: 50 });
  writeCell(dir, 'context-trader', 'fable', '07012026', 'base', 2, { status: 'SL', points: -4, dollars: -20 });
  writeCell(dir, 'context-trader', 'fable', '07012026', 'seven-keys', 1, { status: 'TP', points: 10, dollars: 50 });
  writeCell(dir, 'placement-trader', 'fable', '07012026', 'base', 1, { status: 'NOT_FILLED', points: null, dollars: null });

  const proc = run(['scoreboard', '--dir', dir, '--traders', join(dir, 'no-traders'), '--features', join(dir, 'no-features')]);
  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /Wrote .*SCOREBOARD\.md \(4 cells\)/);

  const md = readFileSync(join(dir, 'SCOREBOARD.md'), 'utf8');
  assert.match(md, /\| context-trader \| fable \| base \|/);
  assert.match(md, /\| context-trader \| fable \| seven-keys \|/);
  assert.match(md, /\| placement-trader \| fable \| base \|/);
});

test('scoreboard ignores files that are not run-<k>.json', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeCell(dir, 'context-trader', 'fable', '07012026', 'base', 1, { status: 'TP', points: 10, dollars: 50 });
  writeFileSync(join(dir, 'context-trader', 'fable', '07012026', 'base', 'notes.txt'), 'ignore me');

  const proc = run(['scoreboard', '--dir', dir, '--traders', join(dir, 'no-traders'), '--features', join(dir, 'no-features')]);
  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /\(1 cells\)/);
});

test('scoreboard with no cells writes a stub and exits 0', (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'bench-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const dir = join(parent, 'runs');
  assert.equal(existsSync(dir), false);

  const proc = run([
    'scoreboard',
    '--dir', dir,
    '--traders', join(parent, 'no-traders'),
    '--features', join(parent, 'no-features'),
  ]);
  assert.equal(proc.status, 0, proc.stderr);
  const md = readFileSync(join(dir, 'SCOREBOARD.md'), 'utf8');
  assert.match(md, /No benchmark cells found/);
});

test('scoreboard names the offending file on a corrupt cell', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeCell(dir, 'context-trader', 'fable', '07012026', 'base', 1, { status: 'TP', points: 10, dollars: 50 });
  writeFileSync(join(dir, 'context-trader', 'fable', '07012026', 'base', 'run-2.json'), 'not json');

  const proc = run(['scoreboard', '--dir', dir, '--traders', join(dir, 'no-traders'), '--features', join(dir, 'no-features')]);
  assert.equal(proc.status, 1);
  assert.match(proc.stderr, /run-2\.json/);
});

test('scoreboard warns about a stray old-layout cell instead of silently dropping it', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeCell(dir, 'context-trader', 'fable', '07012026', 'base', 1, { status: 'TP', points: 10, dollars: 50 });
  // a cell left at the pre-variant 3-level position
  writeFileSync(
    join(dir, 'context-trader', 'fable', '07012026', 'run-9.json'),
    JSON.stringify({ trader: 'context-trader', day: '07012026' })
  );

  const proc = run(['scoreboard', '--dir', dir, '--traders', join(dir, 'no-traders'), '--features', join(dir, 'no-features')]);
  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stderr, /ignoring .*run-9\.json/);
  assert.match(proc.stdout, /\(1 cells\)/);
});

test('scoreboard rejects a cell whose payload contradicts its path', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeCell(dir, 'context-trader', 'fable', '07012026', 'base', 1, { status: 'TP', points: 10, dollars: 50 });
  // same cell file, but stored under base/ while claiming to be seven-keys
  const misfiled = JSON.parse(
    readFileSync(join(dir, 'context-trader', 'fable', '07012026', 'base', 'run-1.json'), 'utf8')
  );
  misfiled.variant = 'seven-keys';
  writeFileSync(
    join(dir, 'context-trader', 'fable', '07012026', 'base', 'run-2.json'),
    JSON.stringify(misfiled)
  );

  const proc = run(['scoreboard', '--dir', dir, '--traders', join(dir, 'no-traders'), '--features', join(dir, 'no-features')]);
  assert.equal(proc.status, 1);
  assert.match(proc.stderr, /run-2\.json: variant is "seven-keys" but its path says "base"/);
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
  writeCell(dir, 'basehit-trader', 'fable', '07012026', 'base', 1, { status: 'TP', points: 10, dollars: 50 });
  writeCell(dir, 'basehit-deeper-entry', 'fable', '07012026', 'base', 1, { status: 'TP', points: 20, dollars: 100 });

  const proc = run(['scoreboard', '--dir', dir, '--traders', tradersDir, '--features', join(dir, 'no-features')]);
  assert.equal(proc.status, 0, proc.stderr);
  const md = readFileSync(join(dir, 'SCOREBOARD.md'), 'utf8');
  assert.match(md, /## Lineage/);
  assert.match(md, /└─ basehit-deeper-entry\s+fable\/base 1r: 100\.00 \(Δ vs origin: \+50\.00\)/);
  assert.match(md, /Origin: basehit-trader — deeper entries/);
});

test('scoreboard omits lineage when the traders dir is missing', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeCell(dir, 'context-trader', 'fable', '07012026', 'base', 1, { status: 'TP', points: 10, dollars: 50 });

  const proc = run(['scoreboard', '--dir', dir, '--traders', join(dir, 'no-such-dir'), '--features', join(dir, 'no-features')]);
  assert.equal(proc.status, 0, proc.stderr);
  const md = readFileSync(join(dir, 'SCOREBOARD.md'), 'utf8');
  assert.doesNotMatch(md, /## Lineage/);
});

test('scoreboard default --traders and --features resolve relative to cwd', (t) => {
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
  writeCell(join(tmp, 'runs'), 'context-trader', 'fable', '07012026', 'base', 1, { status: 'TP', points: 10, dollars: 50 });
  writeCell(join(tmp, 'runs'), 'context-deeper-entry', 'fable', '07012026', 'base', 1, { status: 'TP', points: 20, dollars: 100 });

  const proc = spawnSync(process.execPath, [cli, 'scoreboard'], { encoding: 'utf8', cwd: tmp });
  assert.equal(proc.status, 0, proc.stderr);
  const md = readFileSync(join(tmp, 'runs', 'SCOREBOARD.md'), 'utf8');
  assert.match(md, /## Lineage/);
  assert.match(md, /└─ context-deeper-entry/);
});

test('scoreboard reads --features to label the Feature Impact section', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const featuresDir = join(dir, 'features');
  mkdirSync(featuresDir);
  writeFileSync(
    join(featuresDir, 'seven-keys.md'),
    '---\nid: seven-keys\nname: Seven Keys zone assessment\n---\nblock text\n'
  );
  writeCell(dir, 'context-trader', 'fable', '07012026', 'base', 1, { status: 'TP', points: 20, dollars: 100 });
  writeCell(dir, 'context-trader', 'fable', '07012026', 'seven-keys', 1, { status: 'TP', points: 30, dollars: 150 });

  const proc = run([
    'scoreboard',
    '--dir', dir,
    '--traders', join(dir, 'no-traders'),
    '--features', featuresDir,
  ]);
  assert.equal(proc.status, 0, proc.stderr);
  const md = readFileSync(join(dir, 'SCOREBOARD.md'), 'utf8');
  assert.match(md, /### Seven Keys zone assessment/);
});

test('scoreboard falls back to the raw variant id when --features is missing', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeCell(dir, 'context-trader', 'fable', '07012026', 'base', 1, { status: 'TP', points: 20, dollars: 100 });
  writeCell(dir, 'context-trader', 'fable', '07012026', 'seven-keys', 1, { status: 'TP', points: 30, dollars: 150 });

  const proc = run(['scoreboard', '--dir', dir, '--traders', join(dir, 'no-traders'), '--features', join(dir, 'no-features')]);
  assert.equal(proc.status, 0, proc.stderr);
  const md = readFileSync(join(dir, 'SCOREBOARD.md'), 'utf8');
  assert.match(md, /### seven-keys/);
});
