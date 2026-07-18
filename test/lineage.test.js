import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFrontmatter, collectTraders, buildLineage } from '../src/lineage.js';

test('parseFrontmatter reads simple key: value pairs between --- fences', () => {
  const fm = parseFrontmatter(
    '---\nname: basehit-deeper-entry\nstyle: Deep entries\norigin: basehit-trader\nmutation: Entries rest at the zone midpoint\n---\n\nBody text: ignored\n'
  );
  assert.deepEqual(fm, {
    name: 'basehit-deeper-entry',
    style: 'Deep entries',
    origin: 'basehit-trader',
    mutation: 'Entries rest at the zone midpoint',
  });
});

test('parseFrontmatter returns {} when there is no frontmatter', () => {
  assert.deepEqual(parseFrontmatter('Just a body.\nname: nope\n'), {});
});

test('parseFrontmatter skips indented (nested) and colon-free lines', () => {
  const fm = parseFrontmatter('---\nname: x\n  nested: y\nnocolon\n---\n');
  assert.deepEqual(fm, { name: 'x' });
});

test('collectTraders reads *.md files, name falls back to filename', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'traders-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'alpha.md'), '---\nname: alpha-trader\nstyle: s\n---\nbody\n');
  writeFileSync(join(dir, 'beta.md'), 'no frontmatter body\n');
  writeFileSync(
    join(dir, 'child.md'),
    '---\nname: alpha-deeper\norigin: alpha-trader\nmutation: goes deeper\n---\nbody\n'
  );
  writeFileSync(join(dir, 'notes.txt'), 'ignored');
  mkdirSync(join(dir, 'subdir'));

  assert.deepEqual(collectTraders(dir), [
    { name: 'alpha-trader', origin: null, mutation: null },
    { name: 'beta', origin: null, mutation: null },
    { name: 'alpha-deeper', origin: 'alpha-trader', mutation: 'goes deeper' },
  ]);
});

test('collectTraders returns [] for a missing directory', () => {
  assert.deepEqual(collectTraders('/nonexistent/path/traders'), []);
});

test('buildLineage attaches children to parents and sorts everything', () => {
  const { roots, unknownGroups, cycles } = buildLineage([
    { name: 'b-root', origin: null, mutation: null },
    { name: 'a-root', origin: null, mutation: null },
    { name: 'a-child-2', origin: 'a-root', mutation: 'tweak 2' },
    { name: 'a-child-1', origin: 'a-root', mutation: 'tweak 1' },
    { name: 'a-grandchild', origin: 'a-child-1', mutation: 'tweak 3' },
  ]);
  assert.deepEqual(cycles, []);
  assert.deepEqual(unknownGroups, []);
  assert.deepEqual(roots.map((r) => r.name), ['a-root', 'b-root']);
  assert.deepEqual(roots[0].children.map((c) => c.name), ['a-child-1', 'a-child-2']);
  assert.deepEqual(roots[0].children[0].children.map((c) => c.name), ['a-grandchild']);
});

test('buildLineage groups orphans under their unknown origin', () => {
  const { roots, unknownGroups } = buildLineage([
    { name: 'orphan', origin: 'deleted-trader', mutation: 'm' },
  ]);
  assert.deepEqual(roots, []);
  assert.equal(unknownGroups.length, 1);
  assert.equal(unknownGroups[0].origin, 'deleted-trader');
  assert.deepEqual(unknownGroups[0].children.map((c) => c.name), ['orphan']);
});

test('buildLineage reports origin cycles instead of dropping or looping', () => {
  const { roots, cycles } = buildLineage([
    { name: 'x', origin: 'y', mutation: 'm' },
    { name: 'y', origin: 'x', mutation: 'm' },
    { name: 'root', origin: null, mutation: null },
  ]);
  assert.deepEqual(roots.map((r) => r.name), ['root']);
  assert.deepEqual(cycles.map((n) => n.name), ['x', 'y']);
});
