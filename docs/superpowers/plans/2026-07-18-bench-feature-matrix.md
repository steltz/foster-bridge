# Benchmark Feature-Toggle Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fourth `variant` dimension (`base` + one per `features/*.md` file) to the trader benchmark matrix, migrating Seven-Keys out of hardcoded `trader-bench` logic into the first feature file, so the scoreboard can show whether a feature actually improves results.

**Architecture:** `features/*.md` (new, mirrors `traders/*.md`) declares prompt-block features, optionally backed by a generated per-day artifact. `runs/` gains a `<variant>/` path segment; cell JSON gains `variant`, `featureSha256`, `artifactSha256`. `src/scoreboard.js` groups by `(trader, model, variant)` and adds a `## Feature Impact` section comparing each feature variant to its `base` counterpart. `trader-bench`'s SKILL.md auto-discovers features and benchmarks `base` + every feature, one at a time (never combinatorially). `trader-panel`, `trader-spawn`, and the Seven-Keys generation workflow itself are untouched.

**Tech Stack:** Plain Node.js (`node --test`), no new dependencies. Markdown-with-frontmatter config files (same pattern as `traders/*.md`).

**Reference:** `docs/superpowers/specs/2026-07-18-bench-feature-matrix-design.md` (approved design — read it first if anything below is ambiguous).

**Note on task ordering:** the design spec's own "Migration" section lists deleting `runs/` as step 1. This plan orders it *last* instead (Task 7) — all code changes are developed and verified against fixtures/temp directories, not the real `runs/` tree, so there's no reason to touch real committed data until everything else is proven working. Same end state, safer sequencing.

---

### Task 1: `src/features.js` — feature file discovery

**Files:**
- Create: `src/features.js`
- Test: `test/features.test.js`

Mirrors `src/lineage.js`'s `collectTraders` — reuses its exported `parseFrontmatter` rather than re-implementing frontmatter parsing. Unlike `collectTraders`, discovery also VALIDATES every definition (spec Guard #0) and throws naming the offending file: an id must be a kebab-case slug (it becomes a `runs/` directory segment — quotes, slashes, or an uppercase `Base` that collides with `base` on a case-insensitive filesystem all corrupt the results tree), the id `base` is reserved, two files may not resolve to the same id, `artifactSuffix` requires `generatorSkill`, an artifact-backed body must contain the literal `${ARTIFACT}` placeholder, a non-artifact body must not, and the body may not be empty. Both the scoreboard CLI and the bench skill call `collectFeatures`, so invalid definitions are rejected identically everywhere.

- [ ] **Step 1: Write the failing tests**

Create `test/features.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/features.test.js`
Expected: FAIL — `Cannot find module '../src/features.js'`

- [ ] **Step 3: Write the implementation**

Create `src/features.js`:

```js
// Feature definitions: parse features/*.md frontmatter + prompt-block body.
// Mirrors traders/*.md discovery (src/lineage.js collectTraders) so adding a
// feature to the benchmark is authoring one new markdown file, nothing else.
// Discovery validates every definition (spec Guard #0) — an invalid feature
// file must never reach the bench or the scoreboard.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter } from './lineage.js';

const PLACEHOLDER = '${ARTIFACT}';
// An id becomes a runs/ directory segment and a scoreboard label. Anything
// outside this shape either corrupts the path (quotes, slashes) or defeats
// the reserved-"base" guard on a case-insensitive filesystem ("Base").
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function extractBlock(text) {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return text.trim();
  let closeIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex === -1) return text.trim();
  return lines.slice(closeIndex + 1).join('\n').trim();
}

function validateFeatures(features) {
  const byId = new Map();
  for (const f of features) {
    if (!SLUG.test(f.id)) {
      throw new Error(f.file + ': feature id "' + f.id + '" must be a kebab-case slug — it becomes a directory name and a scoreboard label');
    }
    if (f.id === 'base') {
      throw new Error(f.file + ': the feature id "base" is reserved for the no-feature variant');
    }
    if (byId.has(f.id)) {
      throw new Error('duplicate feature id "' + f.id + '" (' + byId.get(f.id).file + ', ' + f.file + ')');
    }
    byId.set(f.id, f);
    if (f.artifactSuffix && !f.generatorSkill) {
      throw new Error(f.file + ': artifactSuffix requires generatorSkill');
    }
    const hasPlaceholder = f.block.includes(PLACEHOLDER);
    if (f.artifactSuffix && !hasPlaceholder) {
      throw new Error(f.file + ': artifact-backed feature body must contain the ' + PLACEHOLDER + ' placeholder');
    }
    if (!f.artifactSuffix && hasPlaceholder) {
      throw new Error(f.file + ': the ' + PLACEHOLDER + ' placeholder requires artifactSuffix');
    }
    if (!f.block) {
      throw new Error(f.file + ': feature body is empty — a feature with no prompt text is just a costlier "base"');
    }
  }
}

export function collectFeatures(featuresDir) {
  if (!existsSync(featuresDir)) return [];
  const features = readdirSync(featuresDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort()
    .map((file) => {
      const text = readFileSync(join(featuresDir, file), 'utf8');
      const fm = parseFrontmatter(text);
      const id = fm.id || file.slice(0, -3);
      return {
        id,
        file,
        name: fm.name || id,
        artifactSuffix: fm.artifactSuffix || null,
        generatorSkill: fm.generatorSkill || null,
        block: extractBlock(text),
      };
    });
  validateFeatures(features);
  return features;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/features.test.js`
Expected: PASS (15 tests)

- [ ] **Step 5: Commit**

```bash
git add src/features.js test/features.test.js
git commit -m "feat: add features/*.md discovery module"
```

---

### Task 2: `features/seven-keys.md` — the first feature file

**Files:**
- Create: `features/seven-keys.md`

This is a content file (config, not code), same category as `traders/*.md` — no automated test, consumed only by the `trader-bench` Workflow script (Task 6) at prompt-construction time.

- [ ] **Step 1: Write the file**

Create `features/seven-keys.md`:

```markdown
---
id: seven-keys
name: Seven Keys zone assessment
artifactSuffix: _ES_KEYS.md
generatorSkill: seven-keys
---
Read the shared Seven-Keys assessment at ${ARTIFACT} — the shared scorecard
of the day's zones. Adopt its per-zone key scores rather than re-deriving
them; apply your persona's style to choose among the zones it grades.
```

- [ ] **Step 2: Verify it parses correctly**

Run:
```bash
node -e "import('./src/features.js').then(({collectFeatures}) => console.log(JSON.stringify(collectFeatures('features'), null, 2)))"
```
Expected output: one entry with `id: "seven-keys"`, `file: "seven-keys.md"`, `name: "Seven Keys zone assessment"`, `artifactSuffix: "_ES_KEYS.md"`, `generatorSkill: "seven-keys"`, and `block` equal to the three-sentence paragraph above (no frontmatter, no leading/trailing blank lines). A nonzero exit here means the file violates Guard #0 validation — fix the file, not the validator.

- [ ] **Step 3: Commit**

```bash
git add features/seven-keys.md
git commit -m "feat: add seven-keys as the first benchmark feature"
```

---

### Task 3: `src/scoreboard.js` — variant-aware grouping, Feature Impact, variant-scoped lineage

**Files:**
- Modify: `src/scoreboard.js`
- Modify: `test/scoreboard.test.js`

This is the largest single change. It's done as one rewrite of both files rather than many micro-steps because the grouping-key change (adding `variant`) ripples through every render function simultaneously — splitting it into smaller increments would leave the file in an inconsistent, non-compiling state between steps.

- [ ] **Step 1: Rewrite the test file completely**

Replace the entire contents of `test/scoreboard.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeScoreboard, computeFeatureImpact, renderScoreboard, renderLineage } from '../src/scoreboard.js';

// Minimal cell factory; override any field per test.
function cell(overrides = {}) {
  return {
    trader: 'context-trader',
    model: { alias: 'fable', id: 'claude-fable-5' },
    day: '07012026',
    date: '2026-07-01',
    variant: 'base',
    runIndex: 1,
    timestamp: '2026-07-18T14:00:00.000Z',
    personaSha256: 'aaa',
    setup: { side: 'long', entry: 7500, stopLoss: 7490, takeProfit: 7530, rationale: 'r' },
    result: { status: 'TP', points: 30, dollars: 150 },
    ...overrides,
  };
}

test('groups by (trader, model alias, variant) and never merges across groups', () => {
  const cells = [
    cell({ trader: 'a', model: { alias: 'fable', id: 'x' } }),
    cell({ trader: 'a', model: { alias: 'sonnet', id: 'y' } }),
    cell({ trader: 'b', model: { alias: 'fable', id: 'x' } }),
    cell({ trader: 'b', model: { alias: 'sonnet', id: 'y' } }),
    cell({ trader: 'a', model: { alias: 'fable', id: 'x' }, variant: 'seven-keys' }),
  ];
  const { groups } = computeScoreboard(cells);
  assert.equal(groups.length, 5);
  for (const g of groups) {
    assert.equal(g.cellCount, 1);
    assert.equal(g.meanDollars, 150); // each group's mean comes only from its own single cell
  }
});

test('per-run totals sum filled cells across days; NOT_FILLED scores zero', () => {
  const cells = [
    cell({ day: '07012026', runIndex: 1, result: { status: 'TP', points: 10, dollars: 50 } }),
    cell({ day: '07022026', runIndex: 1, result: { status: 'SL', points: -8, dollars: -40 } }),
    cell({ day: '07012026', runIndex: 2, result: { status: 'NOT_FILLED', points: null, dollars: null } }),
    cell({ day: '07022026', runIndex: 2, result: { status: 'TP', points: 20, dollars: 100 } }),
  ];
  const { groups } = computeScoreboard(cells);
  assert.equal(groups.length, 1);
  const g = groups[0];
  assert.deepEqual(
    g.runTotals,
    [
      { runIndex: 1, days: 2, points: 2, dollars: 10 },
      { runIndex: 2, days: 2, points: 20, dollars: 100 },
    ]
  );
  assert.equal(g.meanDollars, 55);
  assert.equal(g.minRunDollars, 10);
  assert.equal(g.maxRunDollars, 100);
  // sample std dev of [10, 100] = |100-55| * sqrt(2) ≈ 63.639…
  assert.ok(Math.abs(g.stdDollars - 63.63961030678928) < 1e-9);
});

test('win/fill rates: EOD at zero points is filled but neither win nor loss', () => {
  const cells = [
    cell({ runIndex: 1, result: { status: 'TP', points: 10, dollars: 50 } }),
    cell({ runIndex: 2, result: { status: 'SL', points: -5, dollars: -25 } }),
    cell({ runIndex: 3, result: { status: 'EOD', points: 0, dollars: 0 } }),
    cell({ runIndex: 4, result: { status: 'NOT_FILLED', points: null, dollars: null } }),
  ];
  const g = computeScoreboard(cells).groups[0];
  assert.equal(g.filledCount, 3);
  assert.equal(g.scoredCount, 4);
  assert.equal(g.winCount, 1);
  assert.equal(g.lossCount, 1);
  assert.equal(g.winRate, 1 / 3);
  assert.equal(g.fillRate, 3 / 4);
  assert.equal(g.avgWinPoints, 10);
  assert.equal(g.avgLossPoints, -5);
});

test('rates are null (not NaN) when there is nothing to rate', () => {
  const g = computeScoreboard([
    cell({ result: { status: 'NOT_FILLED', points: null, dollars: null } }),
  ]).groups[0];
  assert.equal(g.winRate, null);
  assert.equal(g.fillRate, 0);
  assert.equal(g.avgWinPoints, null);
  assert.equal(g.avgLossPoints, null);
});

test('pipeline errors are listed and excluded from scored counts', () => {
  const cells = [
    cell({ runIndex: 1 }),
    cell({ runIndex: 2, setup: undefined, result: { status: 'NO_SETUP' } }),
    cell({ runIndex: 3, result: { status: 'INVALID' }, note: 'long requires stopLoss < entry < takeProfit' }),
  ];
  const g = computeScoreboard(cells).groups[0];
  assert.equal(g.scoredCount, 1);
  assert.deepEqual(g.errors, [
    { day: '07012026', runIndex: 2, status: 'NO_SETUP', note: undefined },
    { day: '07012026', runIndex: 3, status: 'INVALID', note: 'long requires stopLoss < entry < takeProfit' },
  ]);
});

test('setup stability: side counts and entry spread per day, days in chronological order', () => {
  const cells = [
    // 12312025 sorts before 07012026 chronologically, after it lexicographically
    cell({ day: '12312025', runIndex: 1, setup: { side: 'long', entry: 7500, stopLoss: 7490, takeProfit: 7530, rationale: 'r' } }),
    cell({ day: '07012026', runIndex: 1, setup: { side: 'long', entry: 7500, stopLoss: 7490, takeProfit: 7530, rationale: 'r' } }),
    cell({ day: '07012026', runIndex: 2, setup: { side: 'short', entry: 7503, stopLoss: 7513, takeProfit: 7480, rationale: 'r' } }),
    cell({ day: '07012026', runIndex: 3, setup: undefined, result: { status: 'NO_SETUP' } }),
  ];
  const g = computeScoreboard(cells).groups[0];
  assert.deepEqual(g.days, ['12312025', '07012026']);
  assert.deepEqual(g.stability, [
    { day: '12312025', runs: 1, long: 1, short: 0, entrySpread: 0 },
    { day: '07012026', runs: 3, long: 1, short: 1, entrySpread: 3 },
  ]);
});

test('ranking sorts groups by mean dollars descending and reports maxCells', () => {
  const cells = [
    cell({ trader: 'loser', result: { status: 'SL', points: -10, dollars: -50 } }),
    cell({ trader: 'winner', runIndex: 1 }),
    cell({ trader: 'winner', runIndex: 2 }),
  ];
  const { groups, maxCells } = computeScoreboard(cells);
  assert.deepEqual(groups.map((g) => g.trader), ['winner', 'loser']);
  assert.equal(maxCells, 2);
});

test('ranking ties on mean dollars break alphabetically by trader, then model, then variant', () => {
  const tied = (trader, variant = 'base') => cell({ trader, variant });
  for (const ordering of [
    [tied('zeta'), tied('alpha')],
    [tied('alpha'), tied('zeta')],
  ]) {
    const { groups } = computeScoreboard(ordering);
    assert.deepEqual(groups.map((g) => g.trader), ['alpha', 'zeta']);
  }
  const { groups } = computeScoreboard([tied('alpha', 'seven-keys'), tied('alpha', 'base')]);
  assert.deepEqual(groups.map((g) => g.variant), ['base', 'seven-keys']);
});

test('hostile trader/alias/variant names never collide into one group', () => {
  const cells = [
    cell({ trader: 'a","b', model: { alias: 'c', id: 'x' } }),
    cell({ trader: 'a', model: { alias: 'b","c', id: 'x' } }),
    cell({ trader: 'a', model: { alias: 'c', id: 'x' }, variant: 'b","c' }),
  ];
  const { groups } = computeScoreboard(cells);
  assert.equal(groups.length, 3);
});

test('renders ranking table, group details, and coverage', () => {
  const cells = [
    cell({ trader: 'winner', runIndex: 1 }),
    cell({ trader: 'winner', runIndex: 2, result: { status: 'NOT_FILLED', points: null, dollars: null } }),
    cell({ trader: 'loser', result: { status: 'SL', points: -10, dollars: -50 } }),
  ];
  const out = renderScoreboard(computeScoreboard(cells));
  assert.match(out, /# Trader Scoreboard/);
  assert.match(out, /never combined across traders, models, or variants/i);
  // ranking rows in mean-dollars order, winner first
  assert.match(out, /\| 1 \| winner \| fable \| base \| 1 \| 2 \| 75\.00 \|/);
  assert.match(out, /\| 2 \| loser \| fable \| base \| 1 \| 1 \| -50\.00 \|/);
  // group detail sections
  assert.match(out, /## winner @ fable \[base\]/);
  assert.match(out, /## loser @ fable \[base\]/);
  // per-run totals for winner: run 1 filled 150, run 2 not filled 0
  assert.match(out, /\| 1 \| 1 \| 30 \| 150\.00 \|/);
  assert.match(out, /\| 2 \| 1 \| 0 \| 0\.00 \|/);
  // stability row: day, runs, sides, spread
  assert.match(out, /\| 07012026 \| 2 \| 2L\/0S \| 0\.00 \|/);
  // coverage flags the under-tested group
  assert.match(out, /## Coverage/);
  assert.match(out, /\| loser \| fable \| base \| 1 \| 1 \| 1 \| ⚠ under-tested \(max 2\) \|/);
  assert.match(out, /\| winner \| fable \| base \| 2 \| 1 \| 2 \| ok \|/);
});

test('renders null rates and pipeline errors as readable text', () => {
  const cells = [
    cell({ runIndex: 1, result: { status: 'NOT_FILLED', points: null, dollars: null } }),
    cell({ runIndex: 2, setup: undefined, result: { status: 'NO_SETUP' } }),
    cell({ runIndex: 3, result: { status: 'INVALID' }, note: 'bad prices' }),
  ];
  const out = renderScoreboard(computeScoreboard(cells));
  assert.match(out, /\| - \| 0% \|/); // null win rate renders as -, zero fill rate as 0%
  assert.match(out, /- 07012026 run-2: NO_SETUP/);
  assert.match(out, /- 07012026 run-3: INVALID — bad prices/);
});

test('renders "None." when a group has no pipeline errors', () => {
  const out = renderScoreboard(computeScoreboard([cell()]));
  assert.match(out, /### Pipeline errors\n\nNone\./);
});

test('computeFeatureImpact computes per-(trader,model) deltas vs the base variant', () => {
  const cells = [
    cell({ trader: 'a', model: { alias: 'fable', id: 'x' }, variant: 'base', result: { status: 'TP', points: 20, dollars: 100 } }),
    cell({ trader: 'a', model: { alias: 'fable', id: 'x' }, variant: 'seven-keys', result: { status: 'TP', points: 30, dollars: 150 } }),
    cell({ trader: 'b', model: { alias: 'sonnet', id: 'y' }, variant: 'base', result: { status: 'SL', points: -10, dollars: -50 } }),
    cell({ trader: 'b', model: { alias: 'sonnet', id: 'y' }, variant: 'seven-keys', result: { status: 'TP', points: 10, dollars: 50 } }),
  ];
  const impact = computeFeatureImpact(computeScoreboard(cells).groups);
  assert.equal(impact.length, 1);
  assert.equal(impact[0].variant, 'seven-keys');
  assert.deepEqual(impact[0].rows, [
    { trader: 'a', model: 'fable', days: 1, baseRuns: 1, featureRuns: 1, baseDollars: 100, featureDollars: 150, delta: 50 },
    { trader: 'b', model: 'sonnet', days: 1, baseRuns: 1, featureRuns: 1, baseDollars: -50, featureDollars: 50, delta: 100 },
  ]);
  assert.equal(impact[0].overallDelta, 75);
});

test('computeFeatureImpact restricts both sides to their shared day set', () => {
  const cells = [
    // base covers two days; seven-keys covers only the first (e.g. its
    // artifact generation failed on the second)
    cell({ variant: 'base', day: '07012026', result: { status: 'TP', points: 20, dollars: 100 } }),
    cell({ variant: 'base', day: '07022026', result: { status: 'SL', points: -40, dollars: -200 } }),
    cell({ variant: 'seven-keys', day: '07012026', result: { status: 'TP', points: 30, dollars: 150 } }),
  ];
  const impact = computeFeatureImpact(computeScoreboard(cells).groups);
  // base's 07022026 loss is excluded: both sides compare over 07012026 only,
  // so the delta is +50 — not the +250 a raw group-mean comparison would show
  assert.deepEqual(impact[0].rows, [
    { trader: 'context-trader', model: 'fable', days: 1, baseRuns: 1, featureRuns: 1, baseDollars: 100, featureDollars: 150, delta: 50 },
  ]);
});

test('computeFeatureImpact omits (trader, model) pairs missing their base counterpart', () => {
  const impact = computeFeatureImpact(
    computeScoreboard([cell({ trader: 'a', variant: 'seven-keys' })]).groups
  );
  assert.equal(impact[0].variant, 'seven-keys');
  assert.equal(impact[0].rows.length, 0);
  assert.equal(impact[0].overallDelta, null);
});

test('computeFeatureImpact omits pairs whose day sets do not intersect', () => {
  const cells = [
    cell({ variant: 'base', day: '07012026' }),
    cell({ variant: 'seven-keys', day: '07022026' }),
  ];
  const impact = computeFeatureImpact(computeScoreboard(cells).groups);
  assert.equal(impact[0].rows.length, 0);
  assert.equal(impact[0].overallDelta, null);
});

test('computeFeatureImpact returns [] when only the base variant exists', () => {
  assert.deepEqual(computeFeatureImpact(computeScoreboard([cell()]).groups), []);
});

test('computeFeatureImpact never pairs a feature group with a different trader\'s base group', () => {
  // Naive "trader::model" concatenation makes these two collide: trader
  // 'a::fable' + model 'x' and trader 'a' + model 'fable::x' produce the
  // same key, comparing P&L across DIFFERENT traders.
  const cells = [
    cell({ trader: 'a::fable', model: { alias: 'x', id: 'i' }, variant: 'base', result: { status: 'TP', points: 20, dollars: 100 } }),
    cell({ trader: 'a', model: { alias: 'fable::x', id: 'i' }, variant: 'seven-keys', result: { status: 'TP', points: 30, dollars: 150 } }),
  ];
  const impact = computeFeatureImpact(computeScoreboard(cells).groups);
  // the feature group has no base group of its OWN trader+model, so no row
  assert.equal(impact[0].rows.length, 0);
});

test('computeFeatureImpact omits a pair whose shared days have no filled trades on either side', () => {
  const unfilled = { status: 'NOT_FILLED', points: null, dollars: null };
  const cells = [
    cell({ variant: 'base', result: unfilled }),
    cell({ variant: 'seven-keys', result: unfilled }),
  ];
  const impact = computeFeatureImpact(computeScoreboard(cells).groups);
  // both sides are 0 only because nothing filled — a real 0.00 delta here
  // would be indistinguishable from "the feature changed nothing"
  assert.equal(impact[0].rows.length, 0);
  assert.equal(impact[0].overallDelta, null);
});

test('computeFeatureImpact omits a pair when only the feature side failed to trade', () => {
  const cells = [
    cell({ variant: 'base', result: { status: 'TP', points: 20, dollars: 100 } }),
    cell({ variant: 'seven-keys', setup: undefined, result: { status: 'NO_SETUP' } }),
  ];
  const impact = computeFeatureImpact(computeScoreboard(cells).groups);
  // without the filled-count guard this would report Δ -100.00, presenting a
  // pipeline failure as the feature losing money
  assert.equal(impact[0].rows.length, 0);
});

test('computeFeatureImpact reports each side\'s run count over the shared days', () => {
  const cells = [
    cell({ variant: 'base', runIndex: 1, result: { status: 'TP', points: 20, dollars: 100 } }),
    cell({ variant: 'base', runIndex: 2, result: { status: 'SL', points: -20, dollars: -100 } }),
    cell({ variant: 'base', runIndex: 3, result: { status: 'TP', points: 20, dollars: 100 } }),
    cell({ variant: 'seven-keys', runIndex: 1, result: { status: 'TP', points: 30, dollars: 150 } }),
  ];
  const [row] = computeFeatureImpact(computeScoreboard(cells).groups)[0].rows;
  assert.equal(row.baseRuns, 3);
  assert.equal(row.featureRuns, 1);
  // a 3-run base mean vs a single feature sample — the Δ is real arithmetic
  // but weakly sampled, which the Runs column is there to expose
  assert.ok(Math.abs(row.baseDollars - 100 / 3) < 1e-9);
  assert.equal(row.featureDollars, 150);
});

test('renderScoreboard renders a Feature Impact section with per-pair deltas and an overall rollup', () => {
  const cells = [
    cell({ trader: 'a', model: { alias: 'fable', id: 'x' }, variant: 'base', result: { status: 'TP', points: 20, dollars: 100 } }),
    cell({ trader: 'a', model: { alias: 'fable', id: 'x' }, variant: 'seven-keys', result: { status: 'TP', points: 30, dollars: 150 } }),
  ];
  const out = renderScoreboard(computeScoreboard(cells), [], [{ id: 'seven-keys', name: 'Seven Keys zone assessment' }]);
  assert.match(out, /## Feature Impact/);
  assert.match(out, /### Seven Keys zone assessment/);
  assert.match(out, /\| a \| fable \| 1 \| 1v1 \| 100\.00 \| 150\.00 \| \+50\.00 \|/);
  assert.match(out, /\*\*Overall Δ for Seven Keys zone assessment across 1 trader\/model pair: \+50\.00\*\*/);
});

test('renderScoreboard falls back to the raw variant id when no matching feature name is given', () => {
  const cells = [
    cell({ trader: 'a', variant: 'base', result: { status: 'TP', points: 20, dollars: 100 } }),
    cell({ trader: 'a', variant: 'mystery-feature', result: { status: 'TP', points: 30, dollars: 150 } }),
  ];
  const out = renderScoreboard(computeScoreboard(cells));
  assert.match(out, /### mystery-feature/);
});

test('renderScoreboard omits the Feature Impact section when there is no non-base variant', () => {
  const out = renderScoreboard(computeScoreboard([cell()]));
  assert.doesNotMatch(out, /## Feature Impact/);
});

// Helper for lineage tests: minimal valid cell.
function lineageCell(trader, model, runIndex, dollars, variant = 'base') {
  return {
    trader,
    model: { alias: model, id: 'claude-test' },
    day: '07012026',
    date: '2026-07-01',
    variant,
    runIndex,
    timestamp: '2026-07-18T14:00:00.000Z',
    personaSha256: 'aaa',
    setup: { side: 'long', entry: 7500, stopLoss: 7490, takeProfit: 7530, rationale: 'r' },
    result: { status: 'TP', points: dollars / 5, dollars },
  };
}

const LINEAGE_TRADERS = [
  { name: 'basehit-trader', origin: null, mutation: null },
  {
    name: 'basehit-deeper-entry',
    origin: 'basehit-trader',
    mutation: 'Entries rest at the zone midpoint instead of the leading edge',
  },
];

test('renderLineage renders the tree with per-model/variant stats, keeping variants distinct', () => {
  const { groups } = computeScoreboard([
    lineageCell('basehit-trader', 'fable', 1, -10),
    lineageCell('basehit-trader', 'fable', 1, 999, 'seven-keys'),
    lineageCell('basehit-deeper-entry', 'fable', 1, 40),
    lineageCell('basehit-deeper-entry', 'opus', 1, 5),
  ]);
  const text = renderLineage(LINEAGE_TRADERS, groups).join('\n');
  assert.match(text, /^basehit-trader\s+fable\/base 1r: -10\.00 · fable\/seven-keys 1r: 999\.00$/m);
  assert.match(text, /^└─ basehit-deeper-entry\s+fable\/base 1r: 40\.00 \(Δ vs origin: \+50\.00\)/m);
  // opus/base has no origin runs at that model → stats shown without a delta
  assert.match(text, /opus\/base 1r: 5\.00(?! \(Δ)/);
  assert.match(text, /^\s+Entries rest at the zone midpoint instead of the leading edge$/m);
});

test('renderLineage never matches origin/descendant deltas across different variants', () => {
  const { groups } = computeScoreboard([
    lineageCell('basehit-trader', 'fable', 1, -10, 'base'),
    lineageCell('basehit-trader', 'fable', 1, 999, 'seven-keys'),
    lineageCell('basehit-deeper-entry', 'fable', 1, 40, 'seven-keys'),
  ]);
  const text = renderLineage(LINEAGE_TRADERS, groups).join('\n');
  // descendant's seven-keys group (40) must delta against origin's seven-keys group (999), never its base group (-10)
  assert.match(text, /basehit-deeper-entry\s+fable\/seven-keys 1r: 40\.00 \(Δ vs origin: -959\.00\)/);
});

test('renderLineage shows traders with no runs as bare nodes', () => {
  const text = renderLineage(LINEAGE_TRADERS, []).join('\n');
  assert.match(text, /^basehit-trader$/m);
  assert.match(text, /^└─ basehit-deeper-entry$/m);
});

test('renderLineage renders unknown origins and cycles explicitly', () => {
  const text = renderLineage(
    [
      { name: 'orphan', origin: 'deleted-trader', mutation: 'm' },
      { name: 'x', origin: 'y', mutation: 'm' },
      { name: 'y', origin: 'x', mutation: 'm' },
    ],
    []
  ).join('\n');
  assert.match(text, /^\(unknown origin: deleted-trader\)$/m);
  assert.match(text, /^└─ orphan$/m);
  assert.match(text, /^\(unreachable — origin cycle: x, y\)$/m);
});

test('renderScoreboard includes a ## Lineage section when traders are given', () => {
  const board = computeScoreboard([lineageCell('basehit-trader', 'fable', 1, -10)]);
  const md = renderScoreboard(board, LINEAGE_TRADERS);
  assert.match(md, /## Lineage/);
  assert.match(md, /```\nbasehit-trader/);
});

test('renderScoreboard omits the Lineage section when traders are absent', () => {
  const board = computeScoreboard([lineageCell('basehit-trader', 'fable', 1, -10)]);
  assert.doesNotMatch(renderScoreboard(board), /## Lineage/);
  assert.doesNotMatch(renderScoreboard(board, []), /## Lineage/);
});

test('descendant group sections carry an Origin line with a same-model-and-variant delta', () => {
  const board = computeScoreboard([
    lineageCell('basehit-trader', 'fable', 1, -10),
    lineageCell('basehit-deeper-entry', 'fable', 1, 40),
  ]);
  const md = renderScoreboard(board, LINEAGE_TRADERS);
  const section = md.split('## basehit-deeper-entry @ fable [base]')[1];
  assert.match(
    section,
    /^Origin: basehit-trader — Entries rest at the zone midpoint instead of the leading edge · Δ mean \$\/run vs origin @ fable\/base: \+50\.00$/m
  );
});

test('descendant Origin line says so when the origin has no runs at that model/variant', () => {
  const board = computeScoreboard([lineageCell('basehit-deeper-entry', 'opus', 1, 5)]);
  const md = renderScoreboard(board, LINEAGE_TRADERS);
  assert.match(md, /^Origin: basehit-trader — .* · origin has no runs at opus\/base$/m);
});

test('root trader sections carry no Origin line', () => {
  const board = computeScoreboard([lineageCell('basehit-trader', 'fable', 1, -10)]);
  const md = renderScoreboard(board, LINEAGE_TRADERS);
  assert.doesNotMatch(md.split('## basehit-trader @ fable [base]')[1], /^Origin:/m);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/scoreboard.test.js`
Expected: FAIL — `computeFeatureImpact` is not exported, plus assertion failures from the old (pre-variant) rendering.

- [ ] **Step 3: Rewrite the implementation**

Replace the entire contents of `src/scoreboard.js`:

```js
// Pure scoreboard computation and rendering for benchmark cells.
// The comparable unit is the (trader, model-alias, variant) group; no
// metric ever sums across groups — the user runs one trader live and picks
// it here.

import { buildLineage } from './lineage.js';

const SCORED = new Set(['TP', 'SL', 'EOD', 'NOT_FILLED']);
const FILLED = new Set(['TP', 'SL', 'EOD']);

// Day folders are MMDDYYYY; chronological order needs YYYYMMDD.
const rekey = (day) => day.slice(4) + day.slice(0, 4);

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

function sampleStd(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

export function computeScoreboard(cells) {
  const byGroup = new Map();
  for (const c of cells) {
    // JSON key is injective: no (trader, alias, variant) triple can collide
    // with another, since JSON handles all quoting and escaping.
    const key = JSON.stringify([c.trader, c.model.alias, c.variant]);
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(c);
  }
  const groups = [...byGroup.values()].map(summarizeGroup);
  groups.sort(
    (a, b) =>
      b.meanDollars - a.meanDollars ||
      a.trader.localeCompare(b.trader, 'en') ||
      a.model.localeCompare(b.model, 'en') ||
      a.variant.localeCompare(b.variant, 'en')
  );
  const maxCells = groups.reduce((m, g) => Math.max(m, g.cellCount), 0);
  return { groups, maxCells };
}

function summarizeGroup(cells) {
  const { trader, variant } = cells[0];
  const model = cells[0].model.alias;
  const days = [...new Set(cells.map((c) => c.day))].sort((a, b) =>
    rekey(a).localeCompare(rekey(b))
  );
  const runIndices = [...new Set(cells.map((c) => c.runIndex))].sort((a, b) => a - b);

  const runTotals = runIndices.map((runIndex) => {
    const runCells = cells.filter((c) => c.runIndex === runIndex);
    let points = 0;
    let dollars = 0;
    for (const c of runCells) {
      if (FILLED.has(c.result.status)) {
        points += c.result.points ?? 0;
        dollars += c.result.dollars ?? 0;
      }
    }
    return { runIndex, days: runCells.length, points, dollars };
  });

  const dollarSeries = runTotals.map((r) => r.dollars);
  const scored = cells.filter((c) => SCORED.has(c.result.status));
  const filled = cells.filter((c) => FILLED.has(c.result.status));
  const wins = filled.filter((c) => c.result.points > 0);
  const losses = filled.filter((c) => c.result.points < 0);

  const stability = days.map((day) => {
    const withSetup = cells.filter((c) => c.day === day && c.setup);
    const entries = withSetup.map((c) => c.setup.entry);
    return {
      day,
      runs: cells.filter((c) => c.day === day).length,
      long: withSetup.filter((c) => c.setup.side === 'long').length,
      short: withSetup.filter((c) => c.setup.side === 'short').length,
      entrySpread: entries.length > 1 ? Math.max(...entries) - Math.min(...entries) : 0,
    };
  });

  const errors = cells
    .filter((c) => !SCORED.has(c.result.status))
    .sort((a, b) => rekey(a.day).localeCompare(rekey(b.day)) || a.runIndex - b.runIndex)
    .map((c) => ({ day: c.day, runIndex: c.runIndex, status: c.result.status, note: c.note }));

  return {
    trader,
    model,
    variant,
    // Retained so computeFeatureImpact can recompute means restricted to a
    // shared day set; never rendered directly.
    cells,
    cellCount: cells.length,
    days,
    runIndices,
    runTotals,
    meanDollars: mean(dollarSeries),
    meanPoints: mean(runTotals.map((r) => r.points)),
    stdDollars: sampleStd(dollarSeries),
    minRunDollars: Math.min(...dollarSeries),
    maxRunDollars: Math.max(...dollarSeries),
    scoredCount: scored.length,
    filledCount: filled.length,
    winCount: wins.length,
    lossCount: losses.length,
    winRate: filled.length ? wins.length / filled.length : null,
    fillRate: scored.length ? filled.length / scored.length : 0,
    avgWinPoints: wins.length ? mean(wins.map((c) => c.result.points)) : null,
    avgLossPoints: losses.length ? mean(losses.map((c) => c.result.points)) : null,
    stability,
    errors,
  };
}

// One group's comparable stats over only the given days. Mean $/run is a
// per-run SUM across days, so base and feature sides of a comparison must
// cover the identical day set or missing-day P&L masquerades as a feature
// effect. filledCount is carried so a side with nothing to compare can be
// omitted rather than reported as a real zero.
function statsOverDays(group, daySet) {
  const cells = group.cells.filter((c) => daySet.has(c.day));
  const runIndices = [...new Set(cells.map((c) => c.runIndex))].sort((a, b) => a - b);
  return {
    runs: runIndices.length,
    filledCount: cells.filter((c) => FILLED.has(c.result.status)).length,
    meanDollars: mean(
      runIndices.map((runIndex) =>
        cells
          .filter((c) => c.runIndex === runIndex && FILLED.has(c.result.status))
          .reduce((s, c) => s + (c.result.dollars ?? 0), 0)
      )
    ),
  };
}

// For each non-base variant, the per-(trader, model) delta vs that pair's
// base group, both sides recomputed over the intersection of the two
// groups' day sets, plus the mean delta across all comparable pairs. A
// pair is omitted from that feature's rows — never shown as zero — when it
// is missing its base counterpart, when the two day sets do not intersect,
// or when either side has no filled cells over the shared days (all
// NOT_FILLED / NO_SETUP / errors). That last case matters: without it a
// feature whose runs all failed to produce a setup would be rendered as
// losing exactly base's P&L, presenting a pipeline failure as a feature
// effect.
export function computeFeatureImpact(groups) {
  // Key must be injective for the same reason computeScoreboard's is: with
  // naive concatenation, trader "a::fable" + model "x" collides with trader
  // "a" + model "fable::x", pairing a feature group against a DIFFERENT
  // trader's base group — the one comparison this system must never make.
  const pairKey = (g) => JSON.stringify([g.trader, g.model]);
  const baseByPair = new Map();
  for (const g of groups) {
    if (g.variant === 'base') baseByPair.set(pairKey(g), g);
  }
  const variants = [...new Set(groups.map((g) => g.variant).filter((v) => v !== 'base'))].sort(
    (a, b) => a.localeCompare(b, 'en')
  );
  return variants.map((variant) => {
    const rows = groups
      .filter((g) => g.variant === variant)
      .map((g) => {
        const base = baseByPair.get(pairKey(g));
        if (!base) return null;
        const shared = new Set(g.days.filter((d) => base.days.includes(d)));
        if (!shared.size) return null;
        const b = statsOverDays(base, shared);
        const f = statsOverDays(g, shared);
        if (!b.filledCount || !f.filledCount) return null;
        return {
          trader: g.trader,
          model: g.model,
          days: shared.size,
          baseRuns: b.runs,
          featureRuns: f.runs,
          baseDollars: b.meanDollars,
          featureDollars: f.meanDollars,
          delta: f.meanDollars - b.meanDollars,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.trader.localeCompare(b.trader, 'en') || a.model.localeCompare(b.model, 'en'));
    // Unweighted across pairs on purpose: a pair is one trader/model
    // verdict on the feature, regardless of how many days backed it. The
    // per-row Days and Runs columns are what expose uneven sampling.
    return { variant, rows, overallDelta: rows.length ? mean(rows.map((r) => r.delta)) : null };
  });
}

const money = (v) => (v == null ? '-' : v.toFixed(2));
const pct = (v) => (v == null ? '-' : `${Math.round(v * 100)}%`);
const pts = (v) => (v == null ? '-' : v.toFixed(2));
const signed = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;

export function renderLineage(traders, groups) {
  const { roots, unknownGroups, cycles } = buildLineage(traders);
  const groupsByTrader = new Map();
  for (const g of groups) {
    if (!groupsByTrader.has(g.trader)) groupsByTrader.set(g.trader, []);
    groupsByTrader.get(g.trader).push(g);
  }
  const lines = [];
  const emit = (node, depth) => {
    const prefix = depth === 0 ? '' : '   '.repeat(depth - 1) + '└─ ';
    const stats = (groupsByTrader.get(node.name) ?? [])
      .slice()
      .sort((a, b) => a.model.localeCompare(b.model, 'en') || a.variant.localeCompare(b.variant, 'en'))
      .map((g) => {
        let s = `${g.model}/${g.variant} ${g.runIndices.length}r: ${money(g.meanDollars)}`;
        const originGroup = node.origin
          ? (groupsByTrader.get(node.origin) ?? []).find(
              (og) => og.model === g.model && og.variant === g.variant
            )
          : null;
        if (originGroup) s += ` (Δ vs origin: ${signed(g.meanDollars - originGroup.meanDollars)})`;
        return s;
      });
    lines.push(
      `${(prefix + node.name).padEnd(30)}${stats.length ? ' ' + stats.join(' · ') : ''}`.trimEnd()
    );
    if (node.mutation) lines.push(' '.repeat(depth * 3 + 2) + node.mutation);
    node.children.forEach((c) => emit(c, depth + 1));
  };
  roots.forEach((r) => emit(r, 0));
  for (const g of unknownGroups) {
    lines.push(`(unknown origin: ${g.origin})`);
    g.children.forEach((c) => emit(c, 1));
  }
  if (cycles.length) {
    lines.push(`(unreachable — origin cycle: ${cycles.map((n) => n.name).join(', ')})`);
  }
  return lines;
}

export function renderScoreboard({ groups, maxCells }, traders = [], features = []) {
  const totalCells = groups.reduce((s, g) => s + g.cellCount, 0);
  const nameById = new Map(features.map((f) => [f.id, f.name]));
  const lines = [
    '# Trader Scoreboard',
    '',
    `${totalCells} cells · ${groups.length} trader@model@variant groups. ` +
      'Every group is scored alone; P&L is never combined across traders, models, or variants.',
    '',
    '## Ranking (mean net USD per run)',
    '',
    '| # | Trader | Model | Variant | Days | Runs | Mean $/run | Std $ | Min $ | Max $ | Win % | Fill % |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...groups.map(
      (g, i) =>
        `| ${i + 1} | ${g.trader} | ${g.model} | ${g.variant} | ${g.days.length} | ${g.runIndices.length} ` +
        `| ${money(g.meanDollars)} | ${money(g.stdDollars)} ` +
        `| ${money(g.minRunDollars)} | ${money(g.maxRunDollars)} | ${pct(g.winRate)} | ${pct(g.fillRate)} |`
    ),
  ];

  const impact = computeFeatureImpact(groups);
  if (impact.length) {
    lines.push(
      '',
      '## Feature Impact',
      '',
      'Each row compares base and feature over their shared day set only ' +
        '(the Days column); days covered by one side never bias Δ. Runs is ' +
        'base-vs-feature run counts over those days — a lopsided pair is a ' +
        'weakly sampled verdict. Pairs where either side has no filled ' +
        'trades over the shared days are omitted rather than scored zero.',
      ''
    );
    for (const feat of impact) {
      const label = nameById.get(feat.variant) ?? feat.variant;
      lines.push(
        `### ${label}`,
        '',
        `| Trader | Model | Days | Runs | Base $/run | ${label} $/run | Δ |`,
        '|---|---|---|---|---|---|---|',
        ...feat.rows.map(
          (r) =>
            `| ${r.trader} | ${r.model} | ${r.days} | ${r.baseRuns}v${r.featureRuns} ` +
            `| ${money(r.baseDollars)} | ${money(r.featureDollars)} | ${signed(r.delta)} |`
        ),
        '',
        feat.overallDelta == null
          ? 'No comparable (trader, model) pairs yet.'
          : `**Overall Δ for ${label} across ${feat.rows.length} trader/model pair${
              feat.rows.length === 1 ? '' : 's'
            }: ${signed(feat.overallDelta)}**`
      );
    }
  }

  if (traders.length) {
    lines.push('', '## Lineage', '', '```', ...renderLineage(traders, groups), '```');
  }

  const traderByName = new Map(traders.map((t) => [t.name, t]));

  for (const g of groups) {
    lines.push('', `## ${g.trader} @ ${g.model} [${g.variant}]`);
    const t = traderByName.get(g.trader);
    if (t?.origin) {
      const og = groups.find(
        (x) => x.trader === t.origin && x.model === g.model && x.variant === g.variant
      );
      lines.push(
        '',
        `Origin: ${t.origin} — ${t.mutation ?? '(no mutation note)'} · ` +
          (og
            ? `Δ mean $/run vs origin @ ${g.model}/${g.variant}: ${signed(g.meanDollars - og.meanDollars)}`
            : `origin has no runs at ${g.model}/${g.variant}`)
      );
    }
    lines.push(
      '',
      '| Run | Days | Pts | USD |',
      '|---|---|---|---|',
      ...g.runTotals.map(
        (r) => `| ${r.runIndex} | ${r.days} | ${r.points} | ${money(r.dollars)} |`
      ),
      '',
      `Wins: ${g.winCount} · Losses: ${g.lossCount} · ` +
        `Avg win: ${pts(g.avgWinPoints)} pts · Avg loss: ${pts(g.avgLossPoints)} pts`,
      '',
      '### Setup stability',
      '',
      '| Day | Runs | Sides | Entry spread |',
      '|---|---|---|---|',
      ...g.stability.map(
        (s) => `| ${s.day} | ${s.runs} | ${s.long}L/${s.short}S | ${s.entrySpread.toFixed(2)} |`
      ),
      '',
      '### Pipeline errors',
      '',
      ...(g.errors.length
        ? g.errors.map(
            (e) => `- ${e.day} run-${e.runIndex}: ${e.status}${e.note ? ` — ${e.note}` : ''}`
          )
        : ['None.'])
    );
  }

  lines.push(
    '',
    '## Coverage',
    '',
    '| Trader | Model | Variant | Cells | Days | Runs | Status |',
    '|---|---|---|---|---|---|---|',
    ...[...groups]
      .sort(
        (a, b) =>
          a.trader.localeCompare(b.trader, 'en') ||
          a.model.localeCompare(b.model, 'en') ||
          a.variant.localeCompare(b.variant, 'en')
      )
      .map(
        (g) =>
          `| ${g.trader} | ${g.model} | ${g.variant} | ${g.cellCount} | ${g.days.length} | ${g.runIndices.length} ` +
          `| ${g.cellCount < maxCells ? `⚠ under-tested (max ${maxCells})` : 'ok'} |`
      ),
    ''
  );

  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/scoreboard.test.js`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/scoreboard.js test/scoreboard.test.js
git commit -m "feat: group scoreboard by variant and add Feature Impact section"
```

---

### Task 4: `src/scoreboard-command.js` — four-level `collectCells` and `--features` flag

**Files:**
- Modify: `src/scoreboard-command.js`
- Modify: `test/scoreboard-command.test.js`

- [ ] **Step 1: Rewrite the test file completely**

Replace the entire contents of `test/scoreboard-command.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/scoreboard-command.test.js`
Expected: FAIL — cells written under a `<variant>/` subdirectory aren't found by the current 3-level `collectCells`, and `--features` is an unrecognized option.

- [ ] **Step 3: Rewrite the implementation**

Replace the entire contents of `src/scoreboard-command.js`:

```js
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { computeScoreboard, renderScoreboard } from './scoreboard.js';
import { collectTraders } from './lineage.js';
import { collectFeatures } from './features.js';

// runs/<trader>/<model-alias>/<MMDDYYYY>/<variant>/run-<k>.json
export function collectCells(runsDir) {
  const cells = [];
  if (!existsSync(runsDir)) return cells;
  for (const trader of subdirs(runsDir)) {
    for (const model of subdirs(join(runsDir, trader))) {
      for (const day of subdirs(join(runsDir, trader, model))) {
        const dayDir = join(runsDir, trader, model, day);
        // Cells live one level deeper, under <variant>/. A run-*.json HERE is
        // a leftover from the pre-variant layout, or a writer that regressed
        // to it — silently skipping it would under-count the board with no
        // signal a reader could notice.
        for (const stray of readdirSync(dayDir).filter((f) => /^run-\d+\.json$/.test(f)).sort()) {
          console.warn(
            `warning: ignoring ${join(dayDir, stray)} — cells belong in a <variant>/ subdirectory`
          );
        }
        for (const variant of subdirs(dayDir)) {
          const variantDir = join(dayDir, variant);
          // Lexicographic sort is for deterministic collection order only;
          // cell order is not meaningful downstream (computeScoreboard sorts
          // runIndices numerically).
          for (const file of readdirSync(variantDir).filter((f) => /^run-\d+\.json$/.test(f)).sort()) {
            const path = join(variantDir, file);
            let cell;
            try {
              cell = JSON.parse(readFileSync(path, 'utf8'));
            } catch (err) {
              throw new Error(`${path}: ${err.message}`, { cause: err });
            }
            // The walk is purely navigational — every grouping field comes
            // from the payload, so a misfiled or mislabelled cell would be
            // silently misattributed to whatever it claims to be. Cross-check
            // the two so that becomes a named error instead.
            for (const [field, found, expected] of [
              ['trader', cell.trader, trader],
              ['model.alias', cell.model?.alias, model],
              ['day', cell.day, day],
              ['variant', cell.variant, variant],
            ]) {
              if (found !== expected) {
                throw new Error(`${path}: ${field} is "${found}" but its path says "${expected}"`);
              }
            }
            cells.push(cell);
          }
        }
      }
    }
  }
  return cells;
}

function subdirs(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

export function runScoreboard(args) {
  const { values } = parseArgs({
    args,
    options: {
      dir: { type: 'string', default: 'runs' },
      traders: { type: 'string', default: 'traders' },
      features: { type: 'string', default: 'features' },
    },
  });
  const cells = collectCells(values.dir);
  const traders = collectTraders(values.traders);
  const features = collectFeatures(values.features);
  const markdown = cells.length
    ? renderScoreboard(computeScoreboard(cells), traders, features)
    : '# Trader Scoreboard\n\nNo benchmark cells found. Run /trader-bench to populate runs/.\n';
  mkdirSync(values.dir, { recursive: true });
  const outPath = join(values.dir, 'SCOREBOARD.md');
  writeFileSync(outPath, markdown);
  console.log(`Wrote ${outPath} (${cells.length} cells)`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/scoreboard-command.test.js`
Expected: PASS (all tests)

- [ ] **Step 5: Run the full suite to check nothing else regressed**

Run: `npm test`
Expected: PASS (all suites, including `test/lineage.test.js`, `test/cli.test.js`, etc., which this task doesn't touch)

- [ ] **Step 6: Commit**

```bash
git add src/scoreboard-command.js test/scoreboard-command.test.js
git commit -m "feat: collect cells across the variant path segment; add --features flag"
```

---

### Task 5: `.claude/skills/seven-keys/SKILL.md` — simplify the immutability guard

**Files:**
- Modify: `.claude/skills/seven-keys/SKILL.md`

The guard moves from a repo-wide content grep (`keysSha256`) to a path-existence check scoped to that day's `seven-keys` variant folder — simpler, and correctly scoped now that variant is part of the path.

- [ ] **Step 1: Edit the guard step**

In `.claude/skills/seven-keys/SKILL.md`, find this bullet (under "6. **Guards:**"):

```markdown
   - **Benchmark immutability (always, `force` or not):** any existing
     benchmark cell recording a `keysSha256` for this day means the day's
     keys file is immutable — regeneration is forbidden even if the file
     was deleted. Check with
     `find runs -path "*/<day>/run-*.json" -exec grep -l keysSha256 {} + 2>/dev/null`;
     any hit → abort: the remedy is a new benchmark era, not an edit.
```

Replace it with:

```markdown
   - **Benchmark immutability (always, `force` or not):** any existing
     benchmark cell under this day's `seven-keys` variant folder means the
     day's keys file is immutable — regeneration is forbidden even if the
     file was deleted. Check with
     `ls runs/*/*/<day>/seven-keys/run-*.json 2>/dev/null`; any hit →
     abort: the remedy is a new benchmark era, not an edit.
```

- [ ] **Step 2: Verify by reading the file back**

Read `.claude/skills/seven-keys/SKILL.md` and confirm the bullet now matches exactly, and no other `keysSha256` references remain in the file (`grep -n keysSha256 .claude/skills/seven-keys/SKILL.md` should print nothing).

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/seven-keys/SKILL.md
git commit -m "docs: scope the seven-keys immutability guard to its variant folder"
```

---

### Task 6: `.claude/skills/trader-bench/SKILL.md` — variant-aware benchmark matrix

**Files:**
- Modify: `.claude/skills/trader-bench/SKILL.md`

This is a full rewrite of Phase 1's steps 6 onward, the Phase 2 Workflow script, Phase 3's cell schema, and Phase 4's commit message — everything else (steps 1–5, the CLI-is-sole-judge rule, write-once invariant) stays word-for-word.

- [ ] **Step 1: Replace the frontmatter description and intro paragraph**

Replace:

```markdown
---
name: trader-bench
description: Top up the trader benchmark matrix — run every traders/*.md persona N independent times against every complete knowledge-base day for one model, auto-generating and committing any missing seven-keys assessments, writing one immutable JSON cell per (trader, model, day, run-index) under runs/, then regenerate runs/SCOREBOARD.md. Use when the user asks to benchmark the traders, run the bench, or catch a new trader up, optionally with a run count (/trader-bench 5) and/or model alias (/trader-bench 5 sonnet).
---

# Trader Bench — idempotent benchmark matrix top-up

One primitive: bring every trader to N runs on every complete
knowledge-base day, for one model, running ONLY missing cells. Personas
think; this skill plumbs. The backtest CLI is the SOLE judge of every
setup — perform no validation of setups yourself. Existing cells are
write-once and NEVER rerun, overwritten, or deleted.
```

With:

```markdown
---
name: trader-bench
description: Top up the trader benchmark matrix — run every traders/*.md persona N independent times against every complete knowledge-base day, for one model, across a base variant plus every features/*.md variant (auto-generating and committing any missing feature artifacts, e.g. seven-keys), writing one immutable JSON cell per (trader, model, day, variant, run-index) under runs/, then regenerate runs/SCOREBOARD.md. Use when the user asks to benchmark the traders, run the bench, or catch a new trader or feature up, optionally with a run count (/trader-bench 5) and/or model alias (/trader-bench 5 sonnet).
---

# Trader Bench — idempotent benchmark matrix top-up

One primitive: bring every trader to N runs on every complete
knowledge-base day, for one model, across every declared variant (`base`
plus every `features/*.md` feature, one at a time — never combined)
— running ONLY missing cells. Personas think; this skill plumbs. The
backtest CLI is the SOLE judge of every setup — perform no validation of
setups yourself. Existing cells are write-once and NEVER rerun,
overwritten, or deleted.
```

- [ ] **Step 2: Replace Phase 1 in full**

Replace everything from `## Phase 1 — Preflight` through the end of the old step 9 (the line ending `...jump to Phase 4."`) with:

```markdown
## Phase 1 — Preflight (no bench agents — step 8 may run feature-generator sub-flows; abort early with ONE specific message)

1. **Discover personas:** every `traders/*.md`; persona name = the `name:`
   frontmatter value (fall back to filename without `.md`). None → abort
   pointing at `traders/`.
2. **Immutability guard:** compute each persona file's hash with
   `shasum -a 256 traders/<file>.md`. Read `personaSha256` from every
   existing `runs/<trader>/*/*/*/run-*.json` for that trader (any model,
   any day, any variant). If any existing cell's hash differs from the
   current file's hash, abort naming the trader, both hashes, and the
   remedy: trader files are immutable once benchmarked — create a NEW
   trader file instead of editing this one.
3. **Discover complete days:** every `knowledge-base/es/<MMDDYYYY>/` folder
   containing all three docs by suffix: `*_ES_TP.pdf`, `*_ES_TP.md`,
   `*_ES_RECAP.md`. Folders missing any doc are SKIPPED (list them in the
   plan report with the missing suffix), not fatal. Derive each day's CLI
   date from the 8-digit `MMDDYYYY` prefix of the two TP doc FILENAMES —
   never the folder name, whose year is unreliable. The two prefixes must
   agree; a conflict skips the day with both names listed. The recap is
   named for the prior session, so its prefix is exempt. Convert to
   `YYYY-MM-DD` (e.g. `07162026` → `2026-07-16`). The day's cell directory
   key is the TP docs' 8-digit prefix.
4. **Verify candle coverage** per candidate day:
   `CSV=$(ls ticker-data/MES/min-5/*.csv | head -1)`, then

   ```bash
   node -e "Promise.all([import('./src/parse-csv.js'), import('./src/session.js')]).then(async ([p, s]) => {
     const { readFileSync } = await import('node:fs');
     const candles = p.parseCsv(readFileSync(process.argv[1], 'utf8'));
     console.log(s.filterDay(candles, process.argv[2], 'America/New_York').length);
   })" "$CSV" "$DATE"
   ```

   `0` → skip the day, list it. No candidate days at all → abort.
5. **Discover general docs:** every file under `knowledge-base/general/`
   (recursive). Empty or missing directory → proceed with none.
6. **Discover and validate features:** run
   `node -e "import('./src/features.js').then((m) => console.log(JSON.stringify(m.collectFeatures('features'))))"`.
   A nonzero exit means a definition violates validation (reserved id
   `base`, duplicate ids, `artifactSuffix` without `generatorSkill`, or a
   `${ARTIFACT}` placeholder mismatch) — abort relaying its error message
   verbatim; the remedy is fixing the named feature file, and no cells
   have been touched. Otherwise the printed array gives each feature's
   `id`, `name`, `artifactSuffix`, `generatorSkill`, and prompt `block`.
   `VARIANTS = ['base', ...featureIds]` (`base` always first). No feature
   files at all → `VARIANTS = ['base']` only.
7. **Feature immutability guard:** compute each `features/<id>.md`'s hash
   with `shasum -a 256 features/<id>.md`. Read `featureSha256` from every
   existing `runs/*/*/*/<id>/run-*.json`. If any existing cell's hash
   differs from the current file's hash, abort naming the feature, both
   hashes, and the remedy: feature files are immutable once benchmarked —
   create a NEW feature file (new `id`) instead of editing this one.
8. **Feature artifacts (generate missing, per feature, oldest day first):**
   for every feature with both `artifactSuffix` and `generatorSkill`, every
   candidate day needs a `<prefix><artifactSuffix>` in its folder. For days
   missing one, run that feature's `generatorSkill` flow (its own phases,
   committing each artifact; invoke it with that day's `MMDDYYYY` argument)
   sequentially in chronological order, oldest first — independently per
   feature, so each feature's own lookback (if it has one) sees only its
   own predecessors. A day whose generation aborts for a given feature is
   SKIPPED for that (day, feature) combination only — listed with the
   reason — leaving `base` and every other feature's cells for that day
   unaffected. Then compute each remaining (day, feature) artifact's hash:
   `shasum -a 256 <day folder>/<prefix><artifactSuffix>`.
9. **Artifact immutability guard:** for each (day, feature) combination
   from step 8, check `runs/*/*/<day>/<feature-id>/run-*.json`. Any match
   means that combination already has benchmark cells — compare the
   current artifact hash against those cells' `artifactSha256`; a mismatch
   aborts naming the day, feature, and both hashes, remedy: artifacts are
   immutable once benchmarked — start a new benchmark era instead of
   editing them. No matching cells → nothing to guard, proceed.
10. **Compute the missing set:** for every (trader, day, variant) where
    variant ranges over `VARIANTS`, existing runs are
    `runs/<trader>/<alias>/<day>/<variant>/run-*.json`; missing indices
    are `1..N` minus the indices present. Existing cells beyond N are left
    alone. For an artifact-backed feature, every (trader, day, feature-id)
    combination whose (day, feature) artifact is still missing after step 8
    (generation failed or was skipped) is EXCLUDED from the missing set
    entirely — a feature cell must never be run or written without its
    artifact; step 11 reports these as skipped, never as cells to run.
11. **Report the plan, then proceed:** traders × days × variants × model
    alias, cells already present, cells to run, skipped days with reasons,
    skipped (day, feature) artifact failures. Example: "2 traders × 10
    days × 2 variants (base, seven-keys) × fable, target N=5: 84 cells
    exist, 116 to run." If nothing is missing, say so and jump to Phase 4.
```

- [ ] **Step 3: Replace the Phase 2 Workflow script**

Replace the entire fenced ```js block in Phase 2 (everything from `export const meta = {` through the closing ` ``` ` right before "If the Workflow invocation itself fails...") with:

```js
export const meta = {
  name: 'trader-bench',
  description: 'Independent persona setups for missing benchmark cells',
  phases: [{ title: 'Setups', detail: 'one agent per missing cell' }],
}
const MODEL = '<alias>'
const GENERAL = [
  '<absolute path to each file under knowledge-base/general/, or empty array>',
]
const DOCS_BY_DAY = {
  '<MMDDYYYY>': {
    date: '<YYYY-MM-DD>',
    pdf: '<absolute path to *_ES_TP.pdf>',
    plan: '<absolute path to *_ES_TP.md>',
    recap: '<absolute path to *_ES_RECAP.md>',
  },
}
const PERSONAS = {
  '<persona name>': '<absolute path to traders/<persona>.md>',
}
const FEATURES = {
  '<feature id>': {
    block: '<the raw markdown body from features/<feature id>.md, ${ARTIFACT} placeholder left intact>',
    artifact: '<true if the feature has artifactSuffix, else false>',
  },
}
const ARTIFACTS_BY_DAY = {
  '<MMDDYYYY>': {
    '<feature id>': '<absolute path to that day\'s <prefix><artifactSuffix> — only present for features with an artifact>',
  },
}
const CELLS = [
  { trader: '<persona name>', day: '<MMDDYYYY>', variant: '<"base" or a feature id>', runIndex: 1 },
]
const SETUP_SCHEMA = {
  type: 'object',
  required: ['side', 'entry', 'stopLoss', 'takeProfit', 'rationale'],
  properties: {
    side: { enum: ['long', 'short'] },
    entry: { type: 'number' },
    stopLoss: { type: 'number' },
    takeProfit: { type: 'number' },
    rationale: { type: 'string', maxLength: 400 },
  },
  additionalProperties: false,
}
phase('Setups')
const generalBlock = GENERAL.length
  ? `Next Read ALL of these general trading-strategy documents — session-agnostic guidance that applies to every trade and constrains how this persona operates:\n` +
    GENERAL.map((g) => `- ${g}`).join('\n') + `\n\n`
  : ''
const results = await parallel(CELLS.map((cell) => () => {
  const docs = DOCS_BY_DAY[cell.day]
  // Preflight step 10 excluded every artifact-less (day, feature) cell, so a
  // missing path here is a preflight bug: fail the cell loudly (it drops to
  // null and is reported as an anomaly) rather than silently prompting with
  // an empty artifact path.
  const featureBlock = (() => {
    if (cell.variant === 'base') return ''
    const feature = FEATURES[cell.variant]
    if (!feature.artifact) return feature.block + '\n\n'
    const artifactPath = ARTIFACTS_BY_DAY[cell.day]?.[cell.variant]
    if (!artifactPath) throw new Error('missing artifact for ' + cell.day + '/' + cell.variant)
    return feature.block.replaceAll('${ARTIFACT}', artifactPath) + '\n\n'
  })()
  return agent(
    `You are a futures trading persona on an independent benchmark run. First Read the persona file at ${PERSONAS[cell.trader]} and fully adopt that trading identity — its bias, entry style, stop and target logic.\n\n` +
    generalBlock +
    featureBlock +
    `Then Read the three documents for the ${docs.date} ES (E-mini S&P 500) session:\n` +
    `1. Trade plan worksheet (PDF, support/resistance zones): ${docs.pdf}\n` +
    `2. Trade plan video transcript: ${docs.plan}\n` +
    `3. Prior-session recap transcript: ${docs.recap}\n\n` +
    `As this persona, commit to exactly ONE trade for the session: long or short. ` +
    `Anchor your entry, stop loss, and take profit to the support/resistance zones in the trade plan. ` +
    `Prices are ES index points in quarter-point increments (e.g. 7530.25). ` +
    `A long requires stopLoss < entry < takeProfit; a short requires takeProfit < entry < stopLoss. ` +
    `Include a rationale of at most 50 words citing which plan level(s) you are using.`,
    { label: `${cell.trader}/${cell.day}/${cell.variant}#${cell.runIndex}`, schema: SETUP_SCHEMA, model: MODEL }
  ).then((setup) => ({ ...cell, setup }))
}))
log(`${results.filter(Boolean).length}/${CELLS.length} cells returned setups`)
return results.filter(Boolean)
```

- [ ] **Step 4: Replace Phase 3 in full**

Replace everything from `## Phase 3 — Judge and persist` through the end of that section (the line ending "...records the day's keysSha256.") with:

```markdown
## Phase 3 — Judge and persist (no validation of your own)

For each returned setup, in the session scratchpad write
`bench-<trader>-<day>-<variant>-<runIndex>.json` (NO_SETUP cells skip the
CLI and go straight to the cell-file write):

```json
[{ "id": "<trader>", "side": "<side>", "entry": <entry>, "stopLoss": <stopLoss>, "takeProfit": <takeProfit> }]
```

Then run (capturing stdout AND stderr separately):

```bash
node src/cli.js run --data "$CSV" --orders <scratchpad>/bench-<trader>-<day>-<variant>-<runIndex>.json --date "<YYYY-MM-DD>" --json
```

Interpret strictly by the CLI's verdict:

- exit 0 → parse the JSON; `orders[0]` gives `status` (TP | SL | EOD |
  NOT_FILLED), `points`, `dollars`, `fillTime`, `exitTime`. A far-off entry
  is simply `NOT_FILLED` — that IS the answer.
- exit 1 and stderr matches the CLI's order-validation wording (`requires
  stopLoss < entry < takeProfit` / `requires takeProfit < entry <
  stopLoss` / `must be a number`) → status `INVALID`, `note` = that stderr
  line.
- exit 1 otherwise → status `CLI_ERROR`, `note` = the stderr line.

Never fix, clamp, or re-request a persona's prices.

Write each cell to
`runs/<trader>/<alias>/<day>/<variant>/run-<runIndex>.json` (create
directories as needed). If the file already exists, do NOT overwrite it —
record the anomaly for the final summary and move on. Cell format:

```json
{
  "trader": "<persona name>",
  "model": { "alias": "<alias>", "id": "<model.id from the table>" },
  "day": "<MMDDYYYY>",
  "date": "<YYYY-MM-DD>",
  "variant": "<\"base\" or a feature id>",
  "runIndex": <k>,
  "timestamp": "<current ISO-8601 UTC time>",
  "personaSha256": "<hash from Phase 1>",
  "featureSha256": "<hash of features/<variant>.md from Phase 1 — OMIT this key entirely when variant is \"base\">",
  "artifactSha256": "<the day's artifact hash for this variant from Phase 1 — OMIT this key entirely when the variant has no artifactSuffix>",
  "setup": { "side": "...", "entry": 0, "stopLoss": 0, "takeProfit": 0, "rationale": "..." },
  "result": { "status": "...", "points": 0, "dollars": 0, "fillTime": "<from CLI JSON, verbatim>", "exitTime": "<from CLI JSON, verbatim>" },
  "note": "<only for INVALID / CLI_ERROR>"
}
```

Omit `setup` for NO_SETUP cells; `result` is then `{ "status": "NO_SETUP" }`.
For NOT_FILLED, keep the CLI's null points/dollars/fillTime/exitTime as
null. Statuses INVALID and CLI_ERROR keep the submitted `setup` and use
`result` = `{ "status": "INVALID" }` / `{ "status": "CLI_ERROR" }` plus the
top-level `note`. Every cell — including NO_SETUP — records `variant` and
`personaSha256`; `featureSha256`/`artifactSha256` follow the omission rule
above regardless of cell status.

An artifact-backed variant cell without an `artifactSha256` is invalid by
construction — Phase 1 step 10 excluded every (day, feature) combination
lacking its artifact, so no such cell should ever reach this phase. If a
dropped (null) cell for an artifact-backed variant has no Phase 1 artifact
hash (the Phase 2 missing-artifact backstop fired), write NO cell file for
it — record it as an anomaly in the final summary instead.
```

- [ ] **Step 5: Replace Phase 4 in full**

Replace everything from `## Phase 4 — Scoreboard and commit` to the end of the file with:

```markdown
## Phase 4 — Scoreboard and commit

```bash
node src/cli.js scoreboard
git add runs/
git commit -m "bench(<alias>): add <count> cells across <T> traders / <D> days / <V> variants"
```

If Phase 1 found nothing missing, still regenerate the scoreboard; commit
only if `git status` shows changes (message
`bench(<alias>): regenerate scoreboard`).

Finally, show the user the scoreboard's Ranking table inline, plus the
Feature Impact section (if any non-base variant has cells), the
skipped-day list, any skipped (day, feature) artifact failures, and any
write-anomalies.
```

- [ ] **Step 6: Verify by reading the file back**

Read `.claude/skills/trader-bench/SKILL.md` in full and check: numbering is sequential 1–11 in Phase 1, the Phase 2 script has no leftover reference to `docs.keys` anywhere, and Phase 3's cell JSON example doesn't contradict Phase 1's field descriptions. Run `grep -n "docs.keys\|keysSha256" .claude/skills/trader-bench/SKILL.md` — expect no output. Also confirm the Phase 2 script contains the `throw new Error('missing artifact` backstop and no `?? ''` fallback on the artifact path.

- [ ] **Step 7: Commit**

```bash
git add .claude/skills/trader-bench/SKILL.md
git commit -m "feat: benchmark base + every features/*.md variant in trader-bench"
```

---

### Task 7: Migration — wipe the pre-feature-era benchmark matrix

**Files:**
- Delete: `runs/` (all 740+ existing cell files)
- Modify: `runs/SCOREBOARD.md` (regenerated stub)

This is the one destructive step in the whole plan. It was already explicitly confirmed with the user during brainstorming ("Wipe everything, start clean, no need to archive") — but since it deletes ~740 committed files in one shot, re-confirm with the user immediately before running it if you're executing this task in a fresh session that didn't see that confirmation directly.

- [ ] **Step 1: Confirm no other in-progress work depends on the old `runs/` tree**

Run: `git status`
Expected: clean (Tasks 1–6 already committed). If anything unexpected is present, stop and investigate before deleting.

- [ ] **Step 2: Delete the tracked runs/ tree**

```bash
git rm -r --quiet runs
```

Expected: no error; `git status` now shows ~740+ deletions staged.

- [ ] **Step 3: Regenerate the empty-state scoreboard stub**

```bash
node src/cli.js scoreboard
```

Expected output: `Wrote runs/SCOREBOARD.md (0 cells)`. This recreates the `runs/` directory containing only the stub file (per the "scoreboard with no cells writes a stub and exits 0" behavior verified in Task 4).

- [ ] **Step 4: Stage and commit**

```bash
git add runs/
git commit -m "chore: wipe benchmark matrix for the feature-toggle era"
```

- [ ] **Step 5: Verify**

```bash
git status
cat runs/SCOREBOARD.md
```

Expected: clean tree; `runs/SCOREBOARD.md` contains `No benchmark cells found. Run /trader-bench to populate runs/.`

---

### Task 8: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the entire test suite**

Run: `npm test`
Expected: PASS — every suite (`cli`, `engine`, `features`, `lineage`, `orders`, `parse-csv`, `report`, `scoreboard`, `scoreboard-command`, `session`, `transcript-command`, `transcript`, `vimeo-transcript-copy`).

- [ ] **Step 2: Sanity-check the feature discovery end to end**

```bash
node -e "import('./src/features.js').then(({collectFeatures}) => console.log(collectFeatures('features')))"
```
Expected: one feature object for `seven-keys` with the fields from Task 2.

- [ ] **Step 3: Report to the user**

Summarize: all code/test/skill changes committed, `runs/` wiped and stub regenerated. Note that a real first `/trader-bench` run (which spends real subagent budget generating the Seven-Keys artifacts and every base + seven-keys cell from scratch) is a separate, explicit follow-up the user should trigger themselves when ready — it is not part of this plan's automated steps.

---

## Spec coverage check (self-review)

- `features/*.md` format, discovery, immutability → Tasks 1, 2, 6 (steps 6–7).
- Feature definition validation, spec Guard #0 (reserved `base` id,
  duplicate ids, `artifactSuffix`⇒`generatorSkill`, `${ARTIFACT}`
  placeholder presence/absence) → Task 1 (`validateFeatures` + five
  rejection tests), surfaced in preflight via Task 6 (step 6).
- Variant set (`base` + one-at-a-time features) → Task 6 (step 6), Task 3 (grouping).
- Cell path/schema (`variant`, `featureSha256`, `artifactSha256`; artifact-backed cell without `artifactSha256` invalid by construction) → Task 6 (steps 2–4).
- Artifact generation generalization + per-(day,feature) failure isolation → Task 6 (step 8); artifact-less (day, feature) cells excluded from the missing set, with the Phase 2 throw as a should-never-happen backstop (no `?? ''` fallback) → Task 6 (steps 2–4).
- Artifact immutability guard, scoped by path not content grep → Task 6 (step 9), Task 5 (seven-keys' own guard).
- Scoreboard grouping by `(trader, model, variant)`, Variant column, Coverage column → Task 3.
- `## Feature Impact` section (per-pair deltas + overall rollup over each pair's base∩feature shared day set, Days column, omitting pairs with a missing side or disjoint days) → Task 3.
- Lineage matching by model AND variant → Task 3.
- `trader-panel`/`trader-spawn` untouched → confirmed via repo grep during planning; no task touches either file.
- Migration (wipe `runs/`) → Task 7.
- Testing section of the spec (unit tests for scoreboard/collectCells/guards, end-to-end live bench) → unit tests covered by Tasks 1, 3, 4; the end-to-end live bench is explicitly called out in Task 8 as a user-triggered follow-up, not an automated plan step (it costs real subagent budget).
