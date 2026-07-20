# Composite Features (`combines:`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let two or more existing `features/*.md` entries be benchmarked together as one new variant (declared via `combines:` frontmatter), with full validation, immutability guards, scoreboard comparisons against base AND each component, and the first combo file `seven-keys-both`.

**Architecture:** A combo is an ordinary feature file whose `combines` frontmatter lists component ids. `collectFeatures` validates it and resolves its prompt block (auto-concat of component blocks with namespaced `${DOC:id}`/`${ARTIFACT:id}` placeholders, or a hand-written override body using those same namespaced forms). Everything downstream — bench top-up, write-once cells, scoreboard — treats a combo as just another variant; the deltas are per-component hash guards (`componentSha256s`), map-form doc/artifact hashes on combo cells, and combo-vs-component scoreboard tables. Two skill files (`trader-bench`, `seven-keys`) are executable prose and are first-class deliverables.

**Tech Stack:** Node ≥20 ES modules, `node --test` + `node:assert/strict`, no dependencies. Spec: `docs/superpowers/specs/2026-07-20-composite-features-design.md`.

**Conventions for this repo:** semantic commit messages, NO Claude attribution lines in commits. Tests live in `test/*.test.js` mirroring `src/*.js`. Run a single file with `node --test test/features.test.js`, everything with `npm test`.

---

## File map

| File | Change |
|---|---|
| `src/features.js` | Parse `combines`, combo validation, block resolution |
| `test/features.test.js` | Combo parsing/validation/resolution tests |
| `src/scoreboard.js` | `computeFeatureImpact(groups, features)` + combo-vs-component rendering |
| `test/scoreboard.test.js` | Component-comparison + fallback + render tests |
| `features/seven-keys-both.md` | Create — first combo (override body) |
| `.claude/skills/trader-bench/SKILL.md` | Steps 7–12, Phase 2 template, Phase 3 cell format |
| `.claude/skills/seven-keys/SKILL.md` | Guard #1: derive consuming variants from `collectFeatures` |

No changes to `src/scoreboard-command.js` (its `collectCells` cross-check ignores extra keys) or to any existing cell under `runs/` (no era reset — verified in Task 7).

---

### Task 1: `combines` parsing + structural validation

**Files:**
- Modify: `src/features.js`
- Test: `test/features.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/features.test.js`. First add a shared helper (place it directly above the new tests, after the last existing test):

```js
// Combos — a fake repo root with two plain component features to combine.
function comboRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'features-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const featuresDir = join(root, 'features');
  mkdirSync(featuresDir);
  mkdirSync(join(root, 'knowledge-base', 'methods'), { recursive: true });
  writeFileSync(join(root, 'knowledge-base', 'methods', 'seven-keys.md'), 'methodology\n');
  writeFileSync(
    join(featuresDir, 'method.md'),
    '---\nid: method\nstaticDoc: knowledge-base/methods/seven-keys.md\n---\ngrade zones via ${DOC}\n'
  );
  writeFileSync(
    join(featuresDir, 'scorecard.md'),
    '---\nid: scorecard\nstaticDoc: knowledge-base/methods/seven-keys.md\nartifactSuffix: _ES_KEYS.md\ngeneratorSkill: seven-keys\n---\nsee ${DOC} then adopt ${ARTIFACT}\n'
  );
  return featuresDir;
}

test('collectFeatures parses combines as an ordered id list; plain features get combines null', (t) => {
  const dir = comboRoot(t);
  writeFileSync(
    join(dir, 'both.md'),
    '---\nid: both\nname: Both\ncombines: [method, scorecard]\n---\n\n'
  );
  const features = collectFeatures(dir);
  const both = features.find((f) => f.id === 'both');
  const method = features.find((f) => f.id === 'method');
  assert.deepEqual(both.combines, ['method', 'scorecard']);
  assert.equal(both.staticDoc, null);
  assert.equal(both.artifactSuffix, null);
  assert.equal(both.generatorSkill, null);
  assert.equal(method.combines, null);
});

test('collectFeatures rejects combines with fewer than 2 ids', (t) => {
  const dir = comboRoot(t);
  writeFileSync(join(dir, 'solo.md'), '---\nid: solo\ncombines: [method]\n---\n\n');
  assert.throws(() => collectFeatures(dir), /solo\.md.*at least 2/);
});

test('collectFeatures rejects a duplicate id inside combines', (t) => {
  const dir = comboRoot(t);
  writeFileSync(join(dir, 'twice.md'), '---\nid: twice\ncombines: [method, method]\n---\n\n');
  assert.throws(() => collectFeatures(dir), /twice\.md.*duplicate component/);
});

test('collectFeatures rejects combines referencing an unknown id, naming the coupled-removal remedy', (t) => {
  const dir = comboRoot(t);
  writeFileSync(join(dir, 'orphan.md'), '---\nid: orphan\ncombines: [method, ghost]\n---\n\n');
  assert.throws(() => collectFeatures(dir), /orphan\.md.*unknown feature id "ghost".*same change/);
});

test('collectFeatures rejects nested combos', (t) => {
  const dir = comboRoot(t);
  writeFileSync(join(dir, 'inner.md'), '---\nid: inner\ncombines: [method, scorecard]\n---\n\n');
  writeFileSync(join(dir, 'outer.md'), '---\nid: outer\ncombines: [inner, method]\n---\n\n');
  assert.throws(() => collectFeatures(dir), /outer\.md.*nested/);
});

test('collectFeatures rejects a combo declaring its own resources', (t) => {
  const dir = comboRoot(t);
  writeFileSync(
    join(dir, 'greedy.md'),
    '---\nid: greedy\ncombines: [method, scorecard]\nstaticDoc: knowledge-base/methods/seven-keys.md\n---\n\n'
  );
  assert.throws(() => collectFeatures(dir), /greedy\.md.*must not declare/);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test test/features.test.js`
Expected: the six new tests FAIL (`combines` is undefined / no throw); all pre-existing tests PASS.

- [ ] **Step 3: Implement parsing + structural validation in `src/features.js`**

Add below the `SLUG` constant (line 16):

```js
// parseFrontmatter returns "[a, b]" as a raw string; combos need the list.
function parseCombines(raw) {
  if (!raw) return null;
  const inner = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  return inner.split(',').map((s) => s.trim()).filter(Boolean);
}
```

In the `collectFeatures` map callback, add `combines` to the returned object:

```js
      return {
        id,
        file,
        name: fm.name || id,
        artifactSuffix: fm.artifactSuffix || null,
        generatorSkill: fm.generatorSkill || null,
        staticDoc: fm.staticDoc || null,
        combines: parseCombines(fm.combines),
        block: extractBlock(text),
      };
```

In `validateFeatures`, restructure the single loop into two passes. Pass 1 (the existing loop) keeps the id/name rules for ALL features but applies the resource/placeholder/empty-block rules only to plain features. Replace the loop body from `byId.set(f.id, f);` down to the closing brace of the empty-block check with:

```js
    byId.set(f.id, f);
    if (f.name.includes('|') || f.name.includes('\n')) {
      throw new Error(f.file + ': feature name "' + f.name + '" must not contain a pipe or newline — it is interpolated into a markdown table');
    }
    if (f.combines) continue; // combo-specific rules run in pass 2, below
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
    const hasDocPlaceholder = f.block.includes(DOC_PLACEHOLDER);
    if (f.staticDoc && !hasDocPlaceholder) {
      throw new Error(f.file + ': staticDoc-backed feature body must contain the ' + DOC_PLACEHOLDER + ' placeholder');
    }
    if (!f.staticDoc && hasDocPlaceholder) {
      throw new Error(f.file + ': the ' + DOC_PLACEHOLDER + ' placeholder requires staticDoc');
    }
    if (f.staticDoc && !existsSync(join(repoRoot, f.staticDoc))) {
      throw new Error(f.file + ': staticDoc "' + f.staticDoc + '" does not exist (resolved from ' + repoRoot + ')');
    }
    if (!f.block) {
      throw new Error(f.file + ': feature body is empty — a feature with no prompt text is just a costlier "base"');
    }
```

Then append pass 2 after the loop, still inside `validateFeatures`:

```js
  for (const f of features) {
    if (!f.combines) continue;
    if (f.combines.length < 2) {
      throw new Error(f.file + ': combines needs at least 2 component ids');
    }
    const seen = new Set();
    for (const id of f.combines) {
      if (seen.has(id)) {
        throw new Error(f.file + ': duplicate component id "' + id + '" in combines');
      }
      seen.add(id);
      const comp = byId.get(id);
      if (!comp) {
        throw new Error(f.file + ': combines references unknown feature id "' + id + '" — remove or retire the combo in the same change as its component');
      }
      if (comp.combines) {
        throw new Error(f.file + ': combines references combo "' + id + '" — nested combos are not allowed');
      }
    }
    if (f.staticDoc || f.artifactSuffix || f.generatorSkill) {
      throw new Error(f.file + ': a combo must not declare staticDoc, artifactSuffix, or generatorSkill of its own — resources come from its components');
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/features.test.js`
Expected: ALL tests PASS (new and pre-existing).

- [ ] **Step 5: Commit**

```bash
git add src/features.js test/features.test.js
git commit -m "feat: parse and structurally validate combines in feature files"
```

---

### Task 2: Combo body rules + auto-concat resolution

**Files:**
- Modify: `src/features.js`
- Test: `test/features.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/features.test.js` (they reuse `comboRoot` from Task 1):

```js
test('collectFeatures auto-concats an empty combo body from namespaced component blocks in declared order', (t) => {
  const dir = comboRoot(t);
  writeFileSync(join(dir, 'both.md'), '---\nid: both\ncombines: [method, scorecard]\n---\n\n');
  const both = collectFeatures(dir).find((f) => f.id === 'both');
  assert.equal(
    both.block,
    'grade zones via ${DOC:method}\n\nsee ${DOC:scorecard} then adopt ${ARTIFACT:scorecard}'
  );
});

test('collectFeatures keeps a combo override body verbatim', (t) => {
  const dir = comboRoot(t);
  writeFileSync(
    join(dir, 'both.md'),
    '---\nid: both\ncombines: [method, scorecard]\n---\nread ${DOC:method}, then consult ${ARTIFACT:scorecard}\n'
  );
  const both = collectFeatures(dir).find((f) => f.id === 'both');
  assert.equal(both.block, 'read ${DOC:method}, then consult ${ARTIFACT:scorecard}');
});

test('collectFeatures rejects bare placeholders in a combo override body', (t) => {
  const dir = comboRoot(t);
  writeFileSync(
    join(dir, 'both.md'),
    '---\nid: both\ncombines: [method, scorecard]\n---\nread ${DOC} and ${ARTIFACT:scorecard}\n'
  );
  assert.throws(() => collectFeatures(dir), /both\.md.*bare/);
});

test('collectFeatures rejects a namespaced placeholder naming a non-component', (t) => {
  const dir = comboRoot(t);
  writeFileSync(
    join(dir, 'both.md'),
    '---\nid: both\ncombines: [method, scorecard]\n---\nread ${DOC:ghost} and ${ARTIFACT:scorecard}\n'
  );
  assert.throws(() => collectFeatures(dir), /both\.md.*"ghost".*not.*component/);
});

test('collectFeatures rejects ${ARTIFACT:x} where component x has no artifact', (t) => {
  const dir = comboRoot(t);
  writeFileSync(
    join(dir, 'both.md'),
    '---\nid: both\ncombines: [method, scorecard]\n---\nread ${ARTIFACT:method} and ${ARTIFACT:scorecard}\n'
  );
  assert.throws(() => collectFeatures(dir), /both\.md.*"method".*no artifactSuffix/);
});

test('collectFeatures rejects ${DOC:x} where component x has no staticDoc', (t) => {
  const dir = comboRoot(t);
  writeFileSync(join(dir, 'plain.md'), '---\nid: plain\n---\njust prose\n');
  writeFileSync(
    join(dir, 'both.md'),
    '---\nid: both\ncombines: [plain, scorecard]\n---\nread ${DOC:plain} and ${ARTIFACT:scorecard}\n'
  );
  assert.throws(() => collectFeatures(dir), /both\.md.*"plain".*no staticDoc/);
});

test('collectFeatures rejects an override body that never references an artifact-backed component', (t) => {
  const dir = comboRoot(t);
  writeFileSync(
    join(dir, 'both.md'),
    '---\nid: both\ncombines: [method, scorecard]\n---\nread ${DOC:method} only\n'
  );
  assert.throws(() => collectFeatures(dir), /both\.md.*"scorecard".*never referenced/);
});

test('collectFeatures rejects namespaced placeholders in a non-combo feature body', (t) => {
  const dir = comboRoot(t);
  writeFileSync(join(dir, 'plain.md'), '---\nid: plain\n---\nreads ${DOC:method}\n');
  assert.throws(() => collectFeatures(dir), /plain\.md.*namespaced/);
});

test('collectFeatures rejects two auto-concat combos with identical components and order', (t) => {
  const dir = comboRoot(t);
  writeFileSync(join(dir, 'a-both.md'), '---\nid: a-both\ncombines: [method, scorecard]\n---\n\n');
  writeFileSync(join(dir, 'b-both.md'), '---\nid: b-both\ncombines: [method, scorecard]\n---\n\n');
  assert.throws(() => collectFeatures(dir), /same components.*same order/);
});

test('collectFeatures allows identical components when the order or an override body differs', (t) => {
  const dir = comboRoot(t);
  writeFileSync(join(dir, 'ab.md'), '---\nid: ab\ncombines: [method, scorecard]\n---\n\n');
  writeFileSync(join(dir, 'ba.md'), '---\nid: ba\ncombines: [scorecard, method]\n---\n\n');
  writeFileSync(
    join(dir, 'custom.md'),
    '---\nid: custom\ncombines: [method, scorecard]\n---\nblend ${DOC:method} with ${ARTIFACT:scorecard}\n'
  );
  assert.equal(collectFeatures(dir).length, 5); // method, scorecard, ab, ba, custom
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test test/features.test.js`
Expected: the ten new tests FAIL; everything else PASSES.

- [ ] **Step 3: Implement body rules + resolution in `src/features.js`**

Add below `parseCombines`:

```js
const NAMESPACED = /\$\{(DOC|ARTIFACT):([^}]+)\}/g;
```

In pass 1 of `validateFeatures`, immediately AFTER the `if (f.combines) continue;` line (the ban applies only to plain features, and everything after that `continue` is plain-feature-only), add:

```js
    if (f.block.match(NAMESPACED)) {
      throw new Error(f.file + ': namespaced placeholders (${DOC:id} / ${ARTIFACT:id}) are only valid in combo bodies');
    }
```

Extend pass 2: after the own-resources check inside the combo loop, add:

```js
    if (f.block) {
      if (f.block.includes(PLACEHOLDER) || f.block.includes(DOC_PLACEHOLDER)) {
        throw new Error(f.file + ': bare ' + DOC_PLACEHOLDER + ' / ' + PLACEHOLDER + ' placeholders are ambiguous in a combo body — use ${DOC:<component-id>} / ${ARTIFACT:<component-id>}');
      }
      for (const m of f.block.matchAll(NAMESPACED)) {
        const [, kind, id] = m;
        if (!seen.has(id)) {
          throw new Error(f.file + ': placeholder references "' + id + '" which is not a component of this combo');
        }
        const comp = byId.get(id);
        if (kind === 'DOC' && !comp.staticDoc) {
          throw new Error(f.file + ': ${DOC:' + id + '} but component "' + id + '" has no staticDoc');
        }
        if (kind === 'ARTIFACT' && !comp.artifactSuffix) {
          throw new Error(f.file + ': ${ARTIFACT:' + id + '} but component "' + id + '" has no artifactSuffix');
        }
      }
      for (const id of f.combines) {
        const comp = byId.get(id);
        if (comp.artifactSuffix && !f.block.includes('${ARTIFACT:' + id + '}')) {
          throw new Error(f.file + ': artifact-backed component "' + id + '" is never referenced by the override body — an unused artifact means the combo is not actually combining it');
        }
      }
    }
```

Append after the combo loop, still inside `validateFeatures` (duplicate auto-concat rule):

```js
  const autoConcatByKey = new Map();
  for (const f of features) {
    if (!f.combines || f.block) continue;
    const key = f.combines.join(' ');
    const prior = autoConcatByKey.get(key);
    if (prior) {
      throw new Error(prior.file + ' and ' + f.file + ': same components in the same order, both auto-concat — the same variant in all but name');
    }
    autoConcatByKey.set(key, f);
  }
```

Finally, in `collectFeatures`, after `validateFeatures(features, repoRoot);` and before `return features;`, resolve auto-concat blocks:

```js
  const byId = new Map(features.map((f) => [f.id, f]));
  for (const f of features) {
    if (!f.combines || f.block) continue;
    f.block = f.combines
      .map((id) => {
        const comp = byId.get(id);
        return comp.block
          .replaceAll(PLACEHOLDER, '${ARTIFACT:' + id + '}')
          .replaceAll(DOC_PLACEHOLDER, '${DOC:' + id + '}');
      })
      .join('\n\n');
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/features.test.js`
Expected: ALL tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features.js test/features.test.js
git commit -m "feat: validate combo bodies and resolve auto-concat combo blocks"
```

---

### Task 3: Scoreboard combo-vs-component comparisons

**Files:**
- Modify: `src/scoreboard.js` (`computeFeatureImpact` ~line 147, `renderScoreboard` ~line 257)
- Test: `test/scoreboard.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/scoreboard.test.js` (imports of `computeScoreboard`, `computeFeatureImpact`, `renderScoreboard` already exist at the top of that file; verify and extend the import line if any is missing):

```js
// Combos — minimal cell factory. dollars null → NOT_FILLED.
const comboCell = (trader, model, day, variant, runIndex, dollars, extra = {}) => ({
  trader,
  model: { alias: model },
  day,
  date: '2026-07-01',
  variant,
  runIndex,
  setup: { side: 'long', entry: 1, stopLoss: 0, takeProfit: 2, rationale: '' },
  result:
    dollars == null
      ? { status: 'NOT_FILLED', points: null, dollars: null }
      : { status: 'TP', points: dollars / 5, dollars },
  ...extra,
});

test('computeFeatureImpact adds componentComparisons for combos, empty for plain features', () => {
  const cells = [
    comboCell('t', 'fable', '07012026', 'base', 1, 10),
    comboCell('t', 'fable', '07012026', 'method', 1, 20),
    comboCell('t', 'fable', '07012026', 'scorecard', 1, 30),
    comboCell('t', 'fable', '07012026', 'both', 1, 60, { combines: ['method', 'scorecard'] }),
  ];
  const { groups } = computeScoreboard(cells);
  const features = [
    { id: 'method', name: 'Method', combines: null },
    { id: 'scorecard', name: 'Scorecard', combines: null },
    { id: 'both', name: 'Both', combines: ['method', 'scorecard'] },
  ];
  const impact = computeFeatureImpact(groups, features);
  const both = impact.find((f) => f.variant === 'both');
  assert.equal(both.rows[0].delta, 50); // vs base, unchanged semantics
  const vsMethod = both.componentComparisons.find((c) => c.component === 'method');
  const vsScorecard = both.componentComparisons.find((c) => c.component === 'scorecard');
  assert.equal(vsMethod.rows[0].delta, 40);
  assert.equal(vsMethod.overallDelta, 40);
  assert.equal(vsScorecard.rows[0].delta, 30);
  assert.deepEqual(impact.find((f) => f.variant === 'method').componentComparisons, []);
});

test('computeFeatureImpact component comparisons use shared days only and omit unfilled sides', () => {
  const cells = [
    comboCell('t', 'fable', '07012026', 'base', 1, 10),
    comboCell('t', 'fable', '07012026', 'method', 1, 20),
    comboCell('t', 'fable', '07022026', 'method', 1, 999), // day not shared with combo
    comboCell('t', 'fable', '07012026', 'both', 1, 60, { combines: ['method', 'scorecard'] }),
  ];
  const { groups } = computeScoreboard(cells);
  const features = [{ id: 'both', name: 'Both', combines: ['method', 'scorecard'] }];
  const both = computeFeatureImpact(groups, features).find((f) => f.variant === 'both');
  const vsMethod = both.componentComparisons.find((c) => c.component === 'method');
  assert.equal(vsMethod.rows[0].days, 1);
  assert.equal(vsMethod.rows[0].delta, 40); // 999 on the unshared day never leaks in
  const vsScorecard = both.componentComparisons.find((c) => c.component === 'scorecard');
  assert.deepEqual(vsScorecard.rows, []); // no scorecard cells at all
  assert.equal(vsScorecard.overallDelta, null);
});

test('computeFeatureImpact falls back to the cells combines key when the combo file is gone', () => {
  const cells = [
    comboCell('t', 'fable', '07012026', 'base', 1, 10),
    comboCell('t', 'fable', '07012026', 'method', 1, 20),
    comboCell('t', 'fable', '07012026', 'both', 1, 60, { combines: ['method', 'scorecard'] }),
  ];
  const { groups } = computeScoreboard(cells);
  const both = computeFeatureImpact(groups, []).find((f) => f.variant === 'both');
  assert.equal(both.componentComparisons.length, 2);
  assert.equal(both.componentComparisons[0].component, 'method');
});

test('renderScoreboard renders combo component comparison tables', () => {
  const cells = [
    comboCell('t', 'fable', '07012026', 'base', 1, 10),
    comboCell('t', 'fable', '07012026', 'method', 1, 20),
    comboCell('t', 'fable', '07012026', 'both', 1, 60, { combines: ['method', 'scorecard'] }),
  ];
  const features = [
    { id: 'method', name: 'Method', combines: null },
    { id: 'both', name: 'Both', combines: ['method', 'scorecard'] },
  ];
  const md = renderScoreboard(computeScoreboard(cells), [], features);
  assert.match(md, /#### Both vs Method/);
  assert.match(md, /Overall Δ for Both vs Method across 1 pair: \+40\.00/);
  assert.match(md, /#### Both vs scorecard/); // no feature entry → falls back to the id
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test test/scoreboard.test.js`
Expected: the four new tests FAIL (`componentComparisons` undefined / missing render sections); pre-existing tests PASS.

- [ ] **Step 3: Implement in `src/scoreboard.js`**

Replace the whole `computeFeatureImpact` function (keep its existing lead comment) with:

```js
export function computeFeatureImpact(groups, features = []) {
  // Key must be injective for the same reason computeScoreboard's is: with
  // naive concatenation, trader "a::fable" + model "x" collides with trader
  // "a" + model "fable::x", pairing a feature group against a DIFFERENT
  // trader's base group — the one comparison this system must never make.
  const pairKey = (g) => JSON.stringify([g.trader, g.model]);
  const baseByPair = new Map();
  for (const g of groups) {
    if (g.variant === 'base') baseByPair.set(pairKey(g), g);
  }
  const groupByPairVariant = new Map(
    groups.map((g) => [JSON.stringify([g.trader, g.model, g.variant]), g])
  );
  // Combo → components, from the live feature files first; cells' own
  // combines key covers combos whose file has since been retired.
  const comboMap = new Map(features.filter((f) => f.combines).map((f) => [f.id, f.combines]));
  for (const g of groups) {
    if (!comboMap.has(g.variant) && Array.isArray(g.cells[0]?.combines)) {
      comboMap.set(g.variant, g.cells[0].combines);
    }
  }
  const compareRows = (variant, opponentFor) =>
    groups
      .filter((g) => g.variant === variant)
      .map((g) => {
        const opponent = opponentFor(g);
        if (!opponent) return null;
        const shared = new Set(g.days.filter((d) => opponent.days.includes(d)));
        if (!shared.size) return null;
        const o = statsOverDays(opponent, shared);
        const f = statsOverDays(g, shared);
        if (!o.filledCount || !f.filledCount) return null;
        return {
          trader: g.trader,
          model: g.model,
          days: shared.size,
          baseRuns: o.runs,
          featureRuns: f.runs,
          baseDollars: o.meanDollars,
          featureDollars: f.meanDollars,
          delta: f.meanDollars - o.meanDollars,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.trader.localeCompare(b.trader, 'en') || a.model.localeCompare(b.model, 'en'));
  const variants = [...new Set(groups.map((g) => g.variant).filter((v) => v !== 'base'))].sort(
    (a, b) => a.localeCompare(b, 'en')
  );
  return variants.map((variant) => {
    const rows = compareRows(variant, (g) => baseByPair.get(pairKey(g)));
    const componentComparisons = (comboMap.get(variant) ?? []).map((component) => {
      const cRows = compareRows(variant, (g) =>
        groupByPairVariant.get(JSON.stringify([g.trader, g.model, component]))
      );
      return {
        component,
        rows: cRows,
        overallDelta: cRows.length ? mean(cRows.map((r) => r.delta)) : null,
      };
    });
    // Unweighted across pairs on purpose: a pair is one trader/model
    // verdict on the feature, regardless of how many days backed it. The
    // per-row Days and Runs columns are what expose uneven sampling.
    return {
      variant,
      rows,
      overallDelta: rows.length ? mean(rows.map((r) => r.delta)) : null,
      componentComparisons,
    };
  });
}
```

In `renderScoreboard`, change the impact call (currently `const impact = computeFeatureImpact(groups);`) to:

```js
  const impact = computeFeatureImpact(groups, features);
```

and inside the `for (const feat of impact)` loop, after the existing overall-delta `lines.push(...)` block, append:

```js
      for (const cc of feat.componentComparisons) {
        const compLabel = nameById.get(cc.component) ?? cc.component;
        lines.push(
          '',
          `#### ${label} vs ${compLabel}`,
          '',
          `| Trader | Model | Days | Runs | ${compLabel} $/run | ${label} $/run | Δ |`,
          '|---|---|---|---|---|---|---|',
          ...cc.rows.map(
            (r) =>
              `| ${r.trader} | ${r.model} | ${r.days} | ${r.baseRuns}v${r.featureRuns} ` +
              `| ${money(r.baseDollars)} | ${money(r.featureDollars)} | ${signed(r.delta)} |`
          ),
          '',
          cc.overallDelta == null
            ? 'No comparable (trader, model) pairs yet.'
            : `**Overall Δ for ${label} vs ${compLabel} across ${cc.rows.length} pair${
                cc.rows.length === 1 ? '' : 's'
              }: ${signed(cc.overallDelta)}**`
        );
      }
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: ALL tests PASS (in particular every pre-existing scoreboard test — the vs-base refactor through `compareRows` must be behavior-identical).

- [ ] **Step 5: Commit**

```bash
git add src/scoreboard.js test/scoreboard.test.js
git commit -m "feat: score combos against base and each component in feature impact"
```

---

### Task 4: First combo file `features/seven-keys-both.md`

**Files:**
- Create: `features/seven-keys-both.md`

- [ ] **Step 1: Write the file** (exact content; the user may edit the body prose any time before its first benchmark run freezes it):

```markdown
---
id: seven-keys-both
name: Seven-Keys method + scorecard
combines: [seven-keys-method, seven-keys-scorecard]
---
Read the Seven-Keys zone-grading methodology at ${DOC:seven-keys-method}.
Grade the day's zones on the Seven Keys yourself, then read the shared
assessment at ${ARTIFACT:seven-keys-scorecard} as a second opinion. Where
your grades and the shared scorecard disagree, reconcile the disagreement
in your persona's style before choosing among the zones.
```

- [ ] **Step 2: Verify discovery accepts it**

Run: `node -e "import('./src/features.js').then((m) => console.log(JSON.stringify(m.collectFeatures('features'), null, 2)))"`
Expected: exit 0; three entries; `seven-keys-both` has `combines: ["seven-keys-method","seven-keys-scorecard"]`, null resources, and the body verbatim as its `block`.

- [ ] **Step 3: Verify the scoreboard is byte-identical (no era disturbance)**

Run: `node src/cli.js scoreboard && git diff --exit-code runs/SCOREBOARD.md`
Expected: exit 0 — a combo with no cells changes nothing.

- [ ] **Step 4: Commit**

```bash
git add features/seven-keys-both.md
git commit -m "feat: add seven-keys-both combo feature"
```

---

### Task 5: trader-bench SKILL.md updates

**Files:**
- Modify: `.claude/skills/trader-bench/SKILL.md`

This file is executable prose — the edits below are exact replacement/addition text. Apply each with the Edit tool.

- [ ] **Step 1: Step 7 (feature discovery) — describe combos.** After the sentence ending "and prompt `block`." insert:

```
Entries may also carry `combines` (an ordered component-id list): such a
feature is a COMBO — its `block` arrives pre-resolved with namespaced
`${DOC:<component-id>}` / `${ARTIFACT:<component-id>}` placeholders (built
by auto-concat, or authored as an override body), and its own
`artifactSuffix`/`generatorSkill`/`staticDoc` are always null; every
resource belongs to a component, found by id in this same array. Combo
validation failures (unknown/nested component ids, own resource keys, bare
or mismatched placeholders, an override body that skips an artifact-backed
component, duplicate auto-concat twins, a component file removed while a
combo still references it) surface as the same nonzero exit relayed
verbatim; for a removed component the remedy is removing or retiring the
referencing combo(s) in the same change.
```

- [ ] **Step 2: Step 8 (feature immutability) — combo component hashes.** Append to step 8:

```
For a COMBO, additionally hash every component's `file` field the same way
and read `componentSha256s` from every existing
`runs/*/*/*/<combo-id>/run-*.json`; any component hash mismatch aborts
naming the combo, the component, and both hashes — same remedy: component
files are frozen by the combos benchmarked on them.
```

- [ ] **Step 3: Step 9 (static doc guard) — map form for combos.** Append to step 9:

```
For a COMBO, the guard covers each component's `staticDoc` (when declared)
via the map key `staticDocSha256s.<component-id>` read from
`runs/*/*/*/<combo-id>/run-*.json`, compared against the same
freshly computed per-doc hashes.
```

- [ ] **Step 4: Step 10 (artifact precheck) — consuming variants.** In step 10, replace the sentence beginning "BEFORE generating anything, for each (day, feature) whose artifact is missing, check `runs/*/*/<day>/<feature-id>/run-*.json`:" with:

```
BEFORE generating anything, for each (day, feature) whose artifact is
missing, check `runs/*/*/<day>/<v>/run-*.json` for EVERY consuming variant
`<v>` — the feature's own id plus every combo whose `combines` includes
it:
```

- [ ] **Step 5: Step 11 (artifact guard) — combo map form.** Append to step 11:

```
Combo cells freeze the same artifacts through their `artifactSha256s` map:
for each (day, feature) also check every `runs/*/*/<day>/<combo-id>/run-*.json`
of combos containing that feature and compare
`artifactSha256s.<feature-id>` the same way.
```

- [ ] **Step 6: Step 12 (missing set) — combo exclusion.** Append to step 12:

```
A COMBO cell needs every artifact-backed component's (day, artifact) to be
present: any component artifact still missing after step 10 excludes the
combo's (trader, day, combo-id) combinations exactly like the component's
own — reported separately per variant, never run.
```

- [ ] **Step 7: Phase 2 template — FEATURES shape + substitution.** In the workflow script template, replace the `FEATURES` constant block (from `const FEATURES = {` through its closing `}`) with:

```js
const FEATURES = {
  '<plain feature id>': {
    block: [
      "<lines of the body, ${ARTIFACT} and ${DOC} left intact, as before>",
    ].join(NL),
    // Both BARE booleans, never quoted — the string 'false' is truthy, which
    // would send a feature with no artifact (or no static doc) down that
    // substitution path and kill every one of its cells on the matching
    // missing-path throw below.
    artifact: <true if the feature has artifactSuffix, else false>,
    hasDoc: <true if the feature has staticDoc, else false>,
    docPath: <absolute path string if hasDoc, else null>,
    combines: null,
  },
  '<combo id>': {
    block: [
      "<lines of the RESOLVED combo block from step 7, namespaced ${DOC:id}/${ARTIFACT:id} left intact>",
    ].join(NL),
    // Combos never use the scalar keys above.
    artifact: false,
    hasDoc: false,
    docPath: null,
    combines: ['<component id>', '<component id>'],
    // Absolute per-component staticDoc paths — ONLY components that declare
    // one appear here.
    docPaths: { '<component id>': '<absolute staticDoc path>' },
    // Component ids that declare artifactSuffix, possibly empty.
    artifactComponents: ['<component id>'],
  },
}
```

- [ ] **Step 8: Phase 2 template — featureBlock closure.** Replace the `const featureBlock = (() => { ... })()` closure body with (note every placeholder search string is BUILT BY CONCATENATION — never write `${DOC:` inside a template literal, where it interpolates into a ReferenceError at script parse; this is the same escape-free rule as the NL/double-quote comment above the FEATURES constant):

```js
  const featureBlock = (() => {
    if (cell.variant === 'base') return ''
    const feature = FEATURES[cell.variant]
    let block = feature.block
    if (feature.combines) {
      for (const compId of Object.keys(feature.docPaths)) {
        block = block.replaceAll('${DOC:' + compId + '}', feature.docPaths[compId])
      }
      for (const compId of feature.artifactComponents) {
        const artifactPath = ARTIFACTS_BY_DAY[cell.day]?.[compId]
        if (!artifactPath) throw new Error('missing artifact for ' + cell.day + '/' + compId)
        block = block.replaceAll('${ARTIFACT:' + compId + '}', artifactPath)
      }
      // Any placeholder that survives substitution can only mean the FEATURES
      // constant was authored wrong — fail this cell loudly (contained by
      // parallel(), reported as an anomaly) rather than prompting with a
      // literal placeholder.
      if (block.indexOf('${DOC:') !== -1 || block.indexOf('${ARTIFACT:') !== -1) {
        throw new Error('unresolved placeholder in ' + cell.variant)
      }
      return block + NL + NL
    }
    if (feature.hasDoc) {
      if (!feature.docPath) throw new Error('missing static doc for ' + cell.variant)
      block = block.replaceAll('${DOC}', feature.docPath)
    }
    if (!feature.artifact) return block + NL + NL
    const artifactPath = ARTIFACTS_BY_DAY[cell.day]?.[cell.variant]
    if (!artifactPath) throw new Error('missing artifact for ' + cell.day + '/' + cell.variant)
    return block.replaceAll('${ARTIFACT}', artifactPath) + NL + NL
  })()
```

Keep the existing explanatory comment block above the closure; append one sentence to it: `For combos, ARTIFACTS_BY_DAY is keyed by the artifact-owning COMPONENT id (unchanged — component ids are feature ids), and docPaths is inlined per component the same way docPath is for plain features.`

- [ ] **Step 9: Phase 3 cell format — combo keys.** In the cell-format JSON block, after the `"artifactSha256"` line, add:

```json
  "combines": ["<component ids — ONLY on combo cells, verbatim from the feature>"],
  "componentSha256s": { "<component id>": "<that component FILE's hash from Phase 1 — ONLY on combo cells>" },
  "staticDocSha256s": { "<component id>": "<its staticDoc hash — ONLY on combo cells; keys only for components declaring one; omit the whole map when none do>" },
  "artifactSha256s": { "<component id>": "<the day's artifact hash — ONLY on combo cells; keys only for artifact-backed components; omit the whole map when none are>" },
```

and replace the paragraph beginning "Every cell — including NO_SETUP — records" with:

```
Every cell — including NO_SETUP — records `variant`, `personaSha256`, and
`generalSha256`. Plain feature cells use the scalar `featureSha256` /
`staticDocSha256` / `artifactSha256` rules above and NEVER the map forms;
combo cells always record `combines`, `featureSha256` (the combo file
itself), and `componentSha256s`, plus the map-form `staticDocSha256s` /
`artifactSha256s` per their omission rules, and NEVER the scalar
doc/artifact keys — all regardless of cell status. A dropped (null) cell
for a combo missing ANY Phase 1 hash its schema requires (component,
static doc, or that day's artifact) gets NO cell file — record it as an
anomaly, exactly like the existing artifact/doc-backed exception.
```

- [ ] **Step 10: Verify and commit.** Re-read the modified SKILL.md top to bottom checking that: every mention of "feature" in steps 8–12 now has its combo counterpart, the Phase 2 template parses as JS if extracted (mentally trace the featureBlock closure), and no instruction still claims features are "never combined" (the intro line "one at a time — never combined" in the header MUST also be updated to: "one at a time, plus any declared `combines:` combos — components never combine implicitly"). Then:

```bash
git add .claude/skills/trader-bench/SKILL.md
git commit -m "docs: teach trader-bench skill combo variants and per-component guards"
```

---

### Task 6: seven-keys SKILL.md guard derivation

**Files:**
- Modify: `.claude/skills/seven-keys/SKILL.md`

- [ ] **Step 1: Replace Guard #1.** Replace the entire **Benchmark immutability** bullet (from `- **Benchmark immutability (always, \`force\` or not):**` through the closing parenthesis of its parenthetical) with:

```
   - **Benchmark immutability (always, `force` or not):** any existing
     benchmark cell under ANY variant that consumes this day's keys file
     means the file is immutable — regeneration is forbidden even if the
     file was deleted. Derive the consuming variant ids by running
     `node -e "import('./src/features.js').then((m) => console.log(JSON.stringify(m.collectFeatures('features'))))"`:
     they are every feature whose `generatorSkill` is `seven-keys` (the
     artifact owners), plus every combo whose `combines` includes one of
     those. For each consuming id `<v>`, check
     `ls runs/*/*/<day>/<v>/run-*.json 2>/dev/null`; any hit → abort naming
     the variant that froze it: the remedy is a new benchmark era, not an
     edit. (Derived, not hardcoded, so a renamed scorecard feature or a new
     combo consuming the artifact is protected automatically — the failure
     the old literal `seven-keys-scorecard` segment could not catch.)
```

- [ ] **Step 2: Verify the derivation command works against the live repo**

Run: `node -e "import('./src/features.js').then((m) => { const fs = m.collectFeatures('features'); const owners = fs.filter((f) => f.generatorSkill === 'seven-keys').map((f) => f.id); const combos = fs.filter((f) => f.combines && f.combines.some((c) => owners.includes(c))).map((f) => f.id); console.log([...owners, ...combos].join(' ')); })"`
Expected: `seven-keys-scorecard seven-keys-both`

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/seven-keys/SKILL.md
git commit -m "docs: derive seven-keys regeneration guard from consuming variants"
```

---

### Task 7: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run everything**

Run: `npm test`
Expected: ALL tests PASS.

- [ ] **Step 2: End-to-end discovery + scoreboard check against the live repo**

Run: `node -e "import('./src/features.js').then((m) => console.log(m.collectFeatures('features').map((f) => f.id + (f.combines ? ' [combo: ' + f.combines.join('+') + ']' : '')).join('\n')))" && node src/cli.js scoreboard && git status --short runs/`
Expected: three ids listed with `seven-keys-both [combo: seven-keys-method+seven-keys-scorecard]`; scoreboard writes 630 cells; `git status` shows NO changes under `runs/` (a cell-less combo must not disturb the existing board).

- [ ] **Step 3: Commit anything outstanding**

If `git status` shows uncommitted work from earlier tasks, commit it with the matching task message. Otherwise nothing to do — the feature is complete. The first `/trader-bench` run after this will top up `seven-keys-both` across all traders and days (2 traders × 11 days × 5 runs = 110 new fable cells) — that run is the user's call, not part of this plan.

---

## Self-review notes (already applied)

- Spec coverage: declaration rules → Task 1; prompt resolution + placeholder rules + duplicate/retirement rules → Task 2; scoreboard → Task 3; first combo → Task 4; SKILL.md deliverables incl. escape-free substitution and "never combined" header fix → Task 5; generator-guard derivation → Task 6; no-era-disturbance → Tasks 4 & 7.
- The Task 2 plain-feature namespaced ban uses `.match()` not `.test()` deliberately: `NAMESPACED` has the `g` flag and a stateful `lastIndex` under `.test()` would skip alternate calls.
- `computeFeatureImpact`'s second parameter defaults to `[]`, so every pre-existing call site and test keeps compiling unchanged; `renderScoreboard` already receives `features` and now passes it through.
- Cell-schema keys in Task 5 Step 9 match the spec's schema section exactly (`combines`, `componentSha256s`, `staticDocSha256s`, `artifactSha256s`).
