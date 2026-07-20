// Feature definitions: parse features/*.md frontmatter + prompt-block body.
// Mirrors traders/*.md discovery (src/lineage.js collectTraders) so adding a
// feature to the benchmark is authoring one new markdown file, nothing else.
// Discovery validates every definition (spec Guard #0) — an invalid feature
// file must never reach the bench or the scoreboard.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseFrontmatter } from './lineage.js';

const PLACEHOLDER = '${ARTIFACT}';
const DOC_PLACEHOLDER = '${DOC}';
// An id becomes a runs/ directory segment and a scoreboard label. Anything
// outside this shape either corrupts the path (quotes, slashes) or defeats
// the reserved-"base" guard on a case-insensitive filesystem ("Base").
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// parseFrontmatter returns "[a, b]" as a raw string; combos need the list.
function parseCombines(raw) {
  if (!raw) return null;
  const inner = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  return inner.split(',').map((s) => s.trim()).filter(Boolean);
}

// The id class excludes "$" and "{" so an unclosed ${DOC:x cannot greedily
// merge with the next placeholder into one bogus match — it stays behind as
// residue for the malformed-placeholder guard below.
const NAMESPACED = /\$\{(DOC|ARTIFACT):([^${}]+)\}/g;

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

function validateFeatures(features, repoRoot) {
  // Pass 1 — id/name rules for every feature, then plain-feature body rules.
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
    if (f.name.includes('|') || f.name.includes('\n')) {
      throw new Error(f.file + ': feature name "' + f.name + '" must not contain a pipe or newline — it is interpolated into a markdown table');
    }
    if (f.combines) continue; // combo-specific rules run in pass 2, below
    if (f.block.match(NAMESPACED)) {
      throw new Error(f.file + ': namespaced placeholders (${DOC:id} / ${ARTIFACT:id}) are only valid in combo bodies');
    }
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
  }

  // Pass 2 — combo structure and override-body placeholder rules.
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
      // Anything that looks namespaced but did not match NAMESPACED (empty id,
      // missing closing brace) would otherwise survive discovery — Guard #0
      // says invalid features never reach the bench.
      const residue = f.block.replaceAll(NAMESPACED, '');
      if (residue.includes('${DOC:') || residue.includes('${ARTIFACT:')) {
        throw new Error(f.file + ': malformed namespaced placeholder — every ${DOC:...}/${ARTIFACT:...} needs a non-empty component id and closing brace');
      }
      for (const id of f.combines) {
        const comp = byId.get(id);
        if (comp.artifactSuffix && !f.block.includes('${ARTIFACT:' + id + '}')) {
          throw new Error(f.file + ': artifact-backed component "' + id + '" is never referenced by the override body — an unused artifact means the combo is not actually combining it');
        }
      }
    }
  }

  // Pass 3 — two auto-concat combos with identical components and order are
  // the same variant in all but name.
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
}

export function collectFeatures(featuresDir) {
  if (!existsSync(featuresDir)) return [];
  // staticDoc is repo-relative, so existence is checked against the parent
  // of the features directory (i.e. the repo root) — not featuresDir itself
  // and not process.cwd(), which would drift from the caller's cwd.
  const repoRoot = dirname(resolve(featuresDir));
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
        staticDoc: fm.staticDoc || null,
        combines: parseCombines(fm.combines),
        block: extractBlock(text),
      };
    });
  validateFeatures(features, repoRoot);
  // Runs after validation: components can never be combos, so only unmutated
  // plain blocks are read. Resolved objects must not be re-validated —
  // auto-concat combos now have non-empty blocks and would be misread as
  // override bodies.
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
  return features;
}
