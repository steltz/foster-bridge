import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectFeatures } from '../src/features.js';

test('collectFeatures returns [] for a missing directory', () => {
  assert.deepEqual(collectFeatures(join(tmpdir(), 'no-such-features-dir')), []);
});

test('collectFeatures reads *.md files, id falls back to filename', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'features-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'seven-keys.md'), '---\nid: seven-keys\nname: Seven Keys\n---\nblock text\n');
  writeFileSync(join(dir, 'no-id.md'), '---\nname: No Id Feature\n---\nbody\n');
  writeFileSync(join(dir, 'notes.txt'), 'ignored');
  mkdirSync(join(dir, 'subdir'));

  const features = collectFeatures(dir);
  assert.equal(features.length, 2);
  assert.equal(features[0].id, 'no-id'); // "no-id.md" sorts before "seven-keys.md"
  assert.equal(features[1].id, 'seven-keys');
});

test('collectFeatures name defaults to id when absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'features-'));
  writeFileSync(join(dir, 'plain.md'), '---\nid: plain\n---\nbody\n');
  const [f] = collectFeatures(dir);
  assert.equal(f.name, 'plain');
  rmSync(dir, { recursive: true, force: true });
});

test('collectFeatures parses artifactSuffix/generatorSkill and defaults them to null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'features-'));
  writeFileSync(
    join(dir, 'seven-keys.md'),
    '---\nid: seven-keys\nname: Seven Keys\nartifactSuffix: _ES_KEYS.md\ngeneratorSkill: seven-keys\n---\nblock at ${ARTIFACT}\n'
  );
  writeFileSync(join(dir, 'static-note.md'), '---\nid: static-note\nname: Static Note\n---\nblock\n');
  const features = collectFeatures(dir);
  const keys = features.find((f) => f.id === 'seven-keys');
  const note = features.find((f) => f.id === 'static-note');
  assert.equal(keys.artifactSuffix, '_ES_KEYS.md');
  assert.equal(keys.generatorSkill, 'seven-keys');
  assert.equal(note.artifactSuffix, null);
  assert.equal(note.generatorSkill, null);
  rmSync(dir, { recursive: true, force: true });
});

test('collectFeatures extracts the body block after frontmatter, trimmed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'features-'));
  writeFileSync(
    join(dir, 'seven-keys.md'),
    '---\nid: seven-keys\nartifactSuffix: _ES_KEYS.md\ngeneratorSkill: seven-keys\n---\n\nRead the shared assessment at ${ARTIFACT} — adopt its scores.\n'
  );
  const [f] = collectFeatures(dir);
  assert.equal(f.block, 'Read the shared assessment at ${ARTIFACT} — adopt its scores.');
  rmSync(dir, { recursive: true, force: true });
});

test('collectFeatures treats a file with no frontmatter as an id-less body-only feature', () => {
  const dir = mkdtempSync(join(tmpdir(), 'features-'));
  writeFileSync(join(dir, 'raw.md'), 'Just a body, no fences.\n');
  const [f] = collectFeatures(dir);
  assert.equal(f.id, 'raw');
  assert.equal(f.name, 'raw');
  assert.equal(f.block, 'Just a body, no fences.');
  rmSync(dir, { recursive: true, force: true });
});

// Guard #0 — definition validation. Each rejection names the offending file.

test('collectFeatures rejects the reserved variant id "base"', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'features-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'base.md'), '---\nname: Sneaky Baseline\n---\nbody\n');
  assert.throws(() => collectFeatures(dir), /base\.md.*reserved/);
});

test('collectFeatures rejects two files resolving to the same id', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'features-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'alpha.md'), '---\nid: dup\n---\nbody\n');
  writeFileSync(join(dir, 'dup.md'), 'body\n'); // filename fallback also yields "dup"
  assert.throws(() => collectFeatures(dir), /duplicate feature id "dup" \(alpha\.md, dup\.md\)/);
});

test('collectFeatures rejects artifactSuffix without generatorSkill', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'features-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'broken.md'), '---\nid: broken\nartifactSuffix: _ES_X.md\n---\nreads ${ARTIFACT}\n');
  assert.throws(() => collectFeatures(dir), /broken\.md.*generatorSkill/);
});

test('collectFeatures rejects an artifact-backed body missing the placeholder', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'features-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'broken.md'), '---\nid: broken\nartifactSuffix: _ES_X.md\ngeneratorSkill: x\n---\nno placeholder here\n');
  assert.throws(() => collectFeatures(dir), /broken\.md.*ARTIFACT/);
});

test('collectFeatures rejects the placeholder in a feature with no artifact', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'features-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'broken.md'), '---\nid: broken\n---\nreads ${ARTIFACT}\n');
  assert.throws(() => collectFeatures(dir), /broken\.md.*artifactSuffix/);
});

test('collectFeatures rejects a quoted id, whose quotes would become directory characters', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'features-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'quoted.md'), '---\nid: "seven-keys"\n---\nbody\n');
  assert.throws(() => collectFeatures(dir), /quoted\.md.*kebab-case/);
});

test('collectFeatures rejects an uppercase id that collides with base on a case-insensitive filesystem', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'features-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'sneaky.md'), '---\nid: Base\n---\nbody\n');
  assert.throws(() => collectFeatures(dir), /sneaky\.md.*kebab-case/);
});

test('collectFeatures rejects an id containing a path separator', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'features-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'nested.md'), '---\nid: sub/dir\n---\nbody\n');
  assert.throws(() => collectFeatures(dir), /nested\.md.*kebab-case/);
});

test('collectFeatures rejects an empty prompt block', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'features-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'hollow.md'), '---\nid: hollow\nname: Hollow\n---\n\n');
  assert.throws(() => collectFeatures(dir), /hollow\.md.*empty/);
});

test('collectFeatures rejects a name containing a pipe, which would corrupt the scoreboard table', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'features-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'broken.md'), '---\nid: broken\nname: Bad | Name\n---\nbody\n');
  assert.throws(() => collectFeatures(dir), /broken\.md.*pipe/);
});

// staticDoc / ${DOC} — mirrors the artifactSuffix / ${ARTIFACT} rules above,
// but existence is checked relative to the parent of the features directory
// (the repo root), so these tests build a fake repo root containing both a
// features/ subdirectory and the referenced doc.

test('collectFeatures parses staticDoc and defaults it to null', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'features-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const featuresDir = join(root, 'features');
  mkdirSync(featuresDir);
  mkdirSync(join(root, 'knowledge-base', 'methods'), { recursive: true });
  writeFileSync(join(root, 'knowledge-base', 'methods', 'seven-keys.md'), 'methodology\n');
  writeFileSync(
    join(featuresDir, 'seven-keys.md'),
    '---\nid: seven-keys\nname: Seven Keys\nstaticDoc: knowledge-base/methods/seven-keys.md\n---\nsee ${DOC}\n'
  );
  writeFileSync(join(featuresDir, 'static-note.md'), '---\nid: static-note\nname: Static Note\n---\nblock\n');

  const features = collectFeatures(featuresDir);
  const keys = features.find((f) => f.id === 'seven-keys');
  const note = features.find((f) => f.id === 'static-note');
  assert.equal(keys.staticDoc, 'knowledge-base/methods/seven-keys.md');
  assert.equal(note.staticDoc, null);
});

test('collectFeatures rejects staticDoc without the ${DOC} placeholder in the body', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'features-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const featuresDir = join(root, 'features');
  mkdirSync(featuresDir);
  mkdirSync(join(root, 'knowledge-base', 'methods'), { recursive: true });
  writeFileSync(join(root, 'knowledge-base', 'methods', 'seven-keys.md'), 'methodology\n');
  writeFileSync(
    join(featuresDir, 'broken.md'),
    '---\nid: broken\nstaticDoc: knowledge-base/methods/seven-keys.md\n---\nno placeholder here\n'
  );
  assert.throws(() => collectFeatures(featuresDir), /broken\.md.*DOC/);
});

test('collectFeatures rejects the ${DOC} placeholder in a feature with no staticDoc', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'features-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const featuresDir = join(root, 'features');
  mkdirSync(featuresDir);
  writeFileSync(join(featuresDir, 'broken.md'), '---\nid: broken\n---\nreads ${DOC}\n');
  assert.throws(() => collectFeatures(featuresDir), /broken\.md.*staticDoc/);
});

test('collectFeatures rejects a staticDoc pointing at a nonexistent file', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'features-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const featuresDir = join(root, 'features');
  mkdirSync(featuresDir);
  writeFileSync(
    join(featuresDir, 'broken.md'),
    '---\nid: broken\nstaticDoc: knowledge-base/methods/missing.md\n---\nsee ${DOC}\n'
  );
  assert.throws(() => collectFeatures(featuresDir), /broken\.md.*staticDoc.*does not exist/);
});

test('collectFeatures accepts a feature declaring both staticDoc and artifactSuffix', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'features-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const featuresDir = join(root, 'features');
  mkdirSync(featuresDir);
  mkdirSync(join(root, 'knowledge-base', 'methods'), { recursive: true });
  writeFileSync(join(root, 'knowledge-base', 'methods', 'seven-keys.md'), 'methodology\n');
  writeFileSync(
    join(featuresDir, 'seven-keys-scorecard.md'),
    '---\nid: seven-keys-scorecard\nname: Seven Keys Scorecard\nartifactSuffix: _ES_KEYS.md\ngeneratorSkill: seven-keys\nstaticDoc: knowledge-base/methods/seven-keys.md\n---\nsee ${DOC} then read ${ARTIFACT}\n'
  );

  const features = collectFeatures(featuresDir);
  assert.equal(features.length, 1);
  assert.equal(features[0].staticDoc, 'knowledge-base/methods/seven-keys.md');
  assert.equal(features[0].artifactSuffix, '_ES_KEYS.md');
});
