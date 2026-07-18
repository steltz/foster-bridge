# Trader Lineage (Tree of Origin) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track and display the family tree of trader personas — new traders derived from an origin trader carry `origin`/`mutation` frontmatter, the scoreboard renders the lineage tree with performance deltas, and a `/trader-spawn` skill creates descendants.

**Architecture:** Lineage is frontmatter-only: descendant `traders/*.md` files carry `origin` (parent's `name`) and `mutation` (one-line tweak description); absence of `origin` marks a root. A new pure module `src/lineage.js` parses frontmatter and builds the tree; `src/scoreboard.js` gains a `## Lineage` section and per-group "vs origin" lines; `src/scoreboard-command.js` wires in a `--traders` directory flag. A new project skill `.claude/skills/trader-spawn/SKILL.md` drafts descendants with an approval gate. The four existing trader files are NEVER edited (they are hash-guarded by trader-bench).

**Tech Stack:** Node.js ≥20 ES modules, `node --test` + `node:assert/strict`, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-18-trader-lineage-design.md`

**Conventions that bind every task:**
- Run tests with `node --test` (all) or `node --test test/<file>.test.js` (one file) from the repo root.
- Semantic commit messages; no Claude/AI attribution in commits.
- Money formatting uses the existing `money()` helper (`v.toFixed(2)`, `-` for null); deltas use a new `signed()` helper (`+`-prefixed for ≥0).
- P&L comparisons are only ever within one model alias — a delta pairs `(trader, model)` with `(origin, same model)`.

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `src/lineage.js` | Create | Parse trader frontmatter; collect traders from a dir; build the lineage tree (roots, unknown origins, cycle guard) |
| `test/lineage.test.js` | Create | Unit tests for the above |
| `src/scoreboard.js` | Modify | `renderLineage()` (tree text) + `## Lineage` section + per-group "Origin:" line in `renderScoreboard()` |
| `test/scoreboard.test.js` | Modify | Rendering tests for lineage section and origin lines |
| `src/scoreboard-command.js` | Modify | `--traders` flag (default `traders`), pass collected traders into rendering |
| `test/scoreboard-command.test.js` | Modify | CLI integration tests with a temp traders dir |
| `.claude/skills/trader-spawn/SKILL.md` | Create | The `/trader-spawn` skill document |
| `runs/SCOREBOARD.md` | Regenerated | Gains the Lineage section (4 roots) via `node src/cli.js scoreboard` |

`traders/*.md` (existing four) and `.claude/skills/trader-bench/SKILL.md` are NOT modified — the bench's Phase 4 already runs `node src/cli.js scoreboard`, which picks up the new section automatically.

---

### Task 1: `src/lineage.js` — frontmatter parsing and tree building

**Files:**
- Create: `src/lineage.js`
- Test: `test/lineage.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/lineage.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/lineage.test.js`
Expected: FAIL — `Cannot find module '../src/lineage.js'`

- [ ] **Step 3: Implement `src/lineage.js`**

```js
// Trader lineage: parse persona frontmatter and build the family tree.
// A trader file with no `origin` field is a root (origin trader); a
// descendant's `origin` holds its parent's `name` frontmatter value.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function parseFrontmatter(text) {
  const fm = {};
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return fm;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') break;
    const colon = line.indexOf(':');
    if (colon === -1 || /^\s/.test(line)) continue;
    fm[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return fm;
}

export function collectTraders(tradersDir) {
  if (!existsSync(tradersDir)) return [];
  return readdirSync(tradersDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort()
    .map((file) => {
      const fm = parseFrontmatter(readFileSync(join(tradersDir, file), 'utf8'));
      return {
        name: fm.name || file.slice(0, -3),
        origin: fm.origin || null,
        mutation: fm.mutation || null,
      };
    });
}

export function buildLineage(traders) {
  const nodes = new Map(traders.map((t) => [t.name, { ...t, children: [] }]));
  const roots = [];
  const unknown = new Map();
  for (const node of nodes.values()) {
    if (!node.origin) roots.push(node);
    else if (nodes.has(node.origin)) nodes.get(node.origin).children.push(node);
    else {
      if (!unknown.has(node.origin)) unknown.set(node.origin, []);
      unknown.get(node.origin).push(node);
    }
  }
  const byName = (a, b) => a.name.localeCompare(b.name, 'en');
  for (const node of nodes.values()) node.children.sort(byName);
  roots.sort(byName);
  const unknownGroups = [...unknown.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'en'))
    .map(([origin, children]) => ({ origin, children: children.sort(byName) }));
  // A node whose ancestry never reaches a root (mutual origins) would be
  // silently invisible in a traversal-based render; surface it instead.
  const seen = new Set();
  const visit = (n) => {
    if (seen.has(n.name)) return;
    seen.add(n.name);
    n.children.forEach(visit);
  };
  roots.forEach(visit);
  unknownGroups.forEach((g) => g.children.forEach(visit));
  const cycles = [...nodes.values()].filter((n) => !seen.has(n.name)).sort(byName);
  return { roots, unknownGroups, cycles };
}
```

Note on collectTraders sorting: the test expects `alpha-trader, beta, alpha-deeper` — order follows the sorted **filenames** (`alpha.md`, `beta.md`, `child.md`), not the `name` values. That is intentional; buildLineage does its own name-sorting.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/lineage.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lineage.js test/lineage.test.js
git commit -m "feat: add trader lineage frontmatter parsing and tree building"
```

---

### Task 2: `## Lineage` section in the scoreboard rendering

**Files:**
- Modify: `src/scoreboard.js` (add `signed` helper + `renderLineage` export; extend `renderScoreboard` signature and insert the section after the Ranking table)
- Test: `test/scoreboard.test.js` (append tests)

- [ ] **Step 1: Write the failing tests**

Append to `test/scoreboard.test.js` (it already imports `computeScoreboard` and `renderScoreboard` from `../src/scoreboard.js` — extend that import line with `renderLineage`, and reuse its existing cell-fixture helper if one exists; otherwise use the inline `cell()` helper below):

```js
// Helper for lineage tests: minimal valid cell.
function lineageCell(trader, model, runIndex, dollars) {
  return {
    trader,
    model: { alias: model, id: 'claude-test' },
    day: '07012026',
    date: '2026-07-01',
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

test('renderLineage renders the tree with per-model stats and same-model deltas', () => {
  const { groups } = computeScoreboard([
    lineageCell('basehit-trader', 'fable', 1, -10),
    lineageCell('basehit-deeper-entry', 'fable', 1, 40),
    lineageCell('basehit-deeper-entry', 'opus', 1, 5),
  ]);
  const text = renderLineage(LINEAGE_TRADERS, groups).join('\n');
  assert.match(text, /^basehit-trader\s+fable 1r: -10\.00$/m);
  assert.match(text, /^└─ basehit-deeper-entry\s+fable 1r: 40\.00 \(Δ vs origin: \+50\.00\)/m);
  // opus has no origin runs → stats shown without a delta
  assert.match(text, /opus 1r: 5\.00(?! \(Δ)/);
  assert.match(text, /^\s+Entries rest at the zone midpoint instead of the leading edge$/m);
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/scoreboard.test.js`
Expected: FAIL — `renderLineage` is not exported / Lineage section missing

- [ ] **Step 3: Implement in `src/scoreboard.js`**

Add at the top of the file (after existing imports; the module currently has none, so this becomes line 1 territory):

```js
import { buildLineage } from './lineage.js';
```

Add near the existing `money`/`pct`/`pts` helpers:

```js
const signed = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
```

Add the new export:

```js
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
      .sort((a, b) => a.model.localeCompare(b.model, 'en'))
      .map((g) => {
        let s = `${g.model} ${g.runIndices.length}r: ${money(g.meanDollars)}`;
        const originGroup = node.origin
          ? (groupsByTrader.get(node.origin) ?? []).find((og) => og.model === g.model)
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
```

Change `renderScoreboard`'s signature and insert the section immediately after the Ranking table rows (i.e. after the `...groups.map(...)` entry in the initial `lines` array, before the per-group `for` loop):

```js
export function renderScoreboard({ groups, maxCells }, traders = []) {
```

```js
  if (traders.length) {
    lines.push('', '## Lineage', '', '```', ...renderLineage(traders, groups), '```');
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/scoreboard.test.js`
Expected: PASS (all pre-existing tests plus the 5 new ones — the default `traders = []` keeps every existing call site working)

- [ ] **Step 5: Commit**

```bash
git add src/scoreboard.js test/scoreboard.test.js
git commit -m "feat: render trader lineage tree in scoreboard"
```

---

### Task 3: "vs origin" line in each descendant's per-trader@model section

**Files:**
- Modify: `src/scoreboard.js` (per-group loop inside `renderScoreboard`)
- Test: `test/scoreboard.test.js` (append tests)

- [ ] **Step 1: Write the failing tests**

Append to `test/scoreboard.test.js` (reuses `lineageCell` and `LINEAGE_TRADERS` from Task 2):

```js
test('descendant group sections carry an Origin line with a same-model delta', () => {
  const board = computeScoreboard([
    lineageCell('basehit-trader', 'fable', 1, -10),
    lineageCell('basehit-deeper-entry', 'fable', 1, 40),
  ]);
  const md = renderScoreboard(board, LINEAGE_TRADERS);
  const section = md.split('## basehit-deeper-entry @ fable')[1];
  assert.match(
    section,
    /^Origin: basehit-trader — Entries rest at the zone midpoint instead of the leading edge · Δ mean \$\/run vs origin @ fable: \+50\.00$/m
  );
});

test('descendant Origin line says so when the origin has no runs at that model', () => {
  const board = computeScoreboard([lineageCell('basehit-deeper-entry', 'opus', 1, 5)]);
  const md = renderScoreboard(board, LINEAGE_TRADERS);
  assert.match(md, /^Origin: basehit-trader — .* · origin has no runs at opus$/m);
});

test('root trader sections carry no Origin line', () => {
  const board = computeScoreboard([lineageCell('basehit-trader', 'fable', 1, -10)]);
  const md = renderScoreboard(board, LINEAGE_TRADERS);
  assert.doesNotMatch(md.split('## basehit-trader @ fable')[1], /^Origin:/m);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/scoreboard.test.js`
Expected: FAIL — no `Origin:` line rendered

- [ ] **Step 3: Implement**

In `renderScoreboard`, build a name lookup right before the per-group loop:

```js
  const traderByName = new Map(traders.map((t) => [t.name, t]));
```

Restructure the start of the per-group loop. Currently it opens with:

```js
  for (const g of groups) {
    lines.push(
      '',
      `## ${g.trader} @ ${g.model}`,
      '',
      '| Run | Days | Pts | USD |',
```

Change to push the heading first, then the optional Origin line, then the rest unchanged:

```js
  for (const g of groups) {
    lines.push('', `## ${g.trader} @ ${g.model}`);
    const t = traderByName.get(g.trader);
    if (t?.origin) {
      const og = groups.find((x) => x.trader === t.origin && x.model === g.model);
      lines.push(
        '',
        `Origin: ${t.origin} — ${t.mutation ?? '(no mutation note)'} · ` +
          (og
            ? `Δ mean $/run vs origin @ ${g.model}: ${signed(g.meanDollars - og.meanDollars)}`
            : `origin has no runs at ${g.model}`)
      );
    }
    lines.push(
      '',
      '| Run | Days | Pts | USD |',
```

(The rest of the original `lines.push(...)` call continues unchanged from the table header row.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/scoreboard.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/scoreboard.js test/scoreboard.test.js
git commit -m "feat: add vs-origin delta line to descendant scoreboard sections"
```

---

### Task 4: Wire lineage into the scoreboard CLI command

**Files:**
- Modify: `src/scoreboard-command.js`
- Test: `test/scoreboard-command.test.js` (append tests)

- [ ] **Step 1: Write the failing tests**

Append to `test/scoreboard-command.test.js` (reuses its existing `run()` and `writeCell()` helpers):

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/scoreboard-command.test.js`
Expected: FAIL — first new test: no `## Lineage` in output (the `--traders` flag is silently unknown until implemented, so `parseArgs` throws → also acceptable failure mode: non-zero exit)

- [ ] **Step 3: Implement in `src/scoreboard-command.js`**

Add the import:

```js
import { collectTraders } from './lineage.js';
```

Change `runScoreboard`:

```js
export function runScoreboard(args) {
  const { values } = parseArgs({
    args,
    options: {
      dir: { type: 'string', default: 'runs' },
      traders: { type: 'string', default: 'traders' },
    },
  });
  const cells = collectCells(values.dir);
  const traders = collectTraders(values.traders);
  const markdown = cells.length
    ? renderScoreboard(computeScoreboard(cells), traders)
    : '# Trader Scoreboard\n\nNo benchmark cells found. Run /trader-bench to populate runs/.\n';
  mkdirSync(values.dir, { recursive: true });
  const outPath = join(values.dir, 'SCOREBOARD.md');
  writeFileSync(outPath, markdown);
  console.log(`Wrote ${outPath} (${cells.length} cells)`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/scoreboard-command.test.js`
Expected: PASS. Note: the pre-existing tests pass `--dir <tmp>` without `--traders`, so `--traders` defaults to `traders` **relative to the test's cwd** (the repo root) — the real traders dir. Those tests assert on Ranking rows only; the extra Lineage section (all four real roots, no runs → bare nodes) must not break them. If any pre-existing assertion turns out to be order/content-brittle against the added section, fix the assertion to be section-scoped, not the feature.

- [ ] **Step 5: Run the full suite**

Run: `node --test`
Expected: PASS (all files)

- [ ] **Step 6: Commit**

```bash
git add src/scoreboard-command.js test/scoreboard-command.test.js
git commit -m "feat: wire trader lineage into scoreboard command via --traders flag"
```

---

### Task 5: `/trader-spawn` skill

**Files:**
- Create: `.claude/skills/trader-spawn/SKILL.md`

- [ ] **Step 1: Write the skill file**

Create `.claude/skills/trader-spawn/SKILL.md` with exactly this content:

````markdown
---
name: trader-spawn
description: Spawn a new descendant trader persona from an existing origin trader — /trader-spawn <origin> <tweak description> drafts a new traders/*.md that changes exactly one thing about the origin and carries origin/mutation lineage frontmatter, with a diff approval gate before writing. Use when the user wants to derive, refine, tweak, evolve, or branch a trader.
---

# Trader Spawn — derive a descendant trader

Create ONE new trader file in `traders/` from an existing origin persona,
changing exactly one thing. Trader files are immutable once benchmarked
(trader-bench hash-guards them), so refinement ALWAYS means a new file —
never edit the origin. Lineage lives in frontmatter: `origin` names the
parent, `mutation` describes the single tweak; the scoreboard renders the
family tree from these fields automatically.

**Arguments:** `<origin>` — an existing trader's name — and a free-text
tweak description (the hypothesis to test). Both are required; if either
is missing, ask for it before doing anything else.

Out of scope (deliberate): this skill never analyzes bench results or the
scoreboard to invent or recommend tweaks — the user supplies the
hypothesis. If asked to "figure out what to improve," decline and ask for
a specific tweak.

## Step 1 — Resolve the origin

Glob `traders/*.md` and match `<origin>` against each file's `name:`
frontmatter value (fallback: filename without `.md`). No match → abort,
listing the available trader names. Read the origin file in full.

## Step 2 — Derive the descendant's name

Build a descriptive-suffix name: the origin's stem plus a short slug of
the tweak, kebab-case (e.g. `basehit-trader` + "try deeper entries" →
`basehit-deeper-entry`; `rotation-trader` + "tighter stops" →
`rotation-tighter-stop`). Drop a trailing `-trader` from the stem when the
suffix reads better without it. The name must not collide with any
existing `traders/*.md` name (frontmatter or filename) or any existing
`runs/<name>/` directory — on collision, abort and propose an alternative
name for the user to confirm.

## Step 3 — Draft the persona

Start from the origin's FULL text and weave the single tweak through it
coherently: rewrite every passage whose logic the tweak touches so the
persona never contradicts itself, and preserve everything else verbatim.
Do not bolt the tweak on as an extra paragraph. Frontmatter of the new
file:

```yaml
---
name: <descendant name>
style: <one-line style summary, updated to reflect the tweak>
origin: <the origin's `name` frontmatter value>
mutation: <one line describing the single change relative to the origin>
---
```

`origin` and `mutation` must both be present, each on one line.

## Step 4 — Approval gate

Before writing anything, show the user: the proposed name, the mutation
line, and a diff of the new persona against the origin (e.g. via
`diff <(cat traders/<origin-file>) <scratchpad-draft>` or an equivalent
summary of exactly what changed). Only write `traders/<name>.md` after the
user approves. If they ask for changes, revise the draft and show the diff
again.

## Step 5 — Write and confirm

Write the approved draft to `traders/<name>.md`. NEVER modify the origin
file — this skill writes exactly one new file. Confirm to the user that
the descendant now exists, is a plain `traders/*.md` file (so trader-bench
and trader-panel pick it up automatically on their next run), and suggest
`/trader-bench` to benchmark it. Committing is up to the user's usual
workflow; if the user asks, use a semantic message like
`feat: add <name> persona (<mutation, shortened>)`.
````

- [ ] **Step 2: Verify the skill file parses**

Run: `head -5 .claude/skills/trader-spawn/SKILL.md`
Expected: the frontmatter opens with `---` and `name: trader-spawn` — matching the structure of `.claude/skills/trader-bench/SKILL.md`.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/trader-spawn/SKILL.md
git commit -m "feat: add trader-spawn skill for deriving descendant traders"
```

---

### Task 6: Regenerate the real scoreboard and verify end-to-end

**Files:**
- Regenerate: `runs/SCOREBOARD.md`

No fake descendant is created in `traders/` — a test trader file would be
picked up by the next real bench/panel run. Descendant rendering is covered
by the unit and CLI tests; this task verifies the real repo path.

- [ ] **Step 1: Run the full test suite**

Run: `node --test`
Expected: PASS (all files)

- [ ] **Step 2: Regenerate the scoreboard**

Run: `node src/cli.js scoreboard`
Expected: `Wrote runs/SCOREBOARD.md (400 cells)` (cell count as of plan-writing; any higher count is fine)

- [ ] **Step 3: Verify the Lineage section**

Run: `grep -A 8 '## Lineage' runs/SCOREBOARD.md`
Expected: a fenced block listing exactly the four current traders as roots — `basehit-trader`, `context-trader`, `placement-trader`, `rotation-trader` — each with its per-model stats, no `└─` lines, no `Origin:` lines anywhere (`grep -c '^Origin:' runs/SCOREBOARD.md` → 0).

- [ ] **Step 4: Verify no trader file changed**

Run: `git status --porcelain traders/`
Expected: empty output.

- [ ] **Step 5: Commit**

```bash
git add runs/SCOREBOARD.md
git commit -m "chore: regenerate scoreboard with lineage section"
```
