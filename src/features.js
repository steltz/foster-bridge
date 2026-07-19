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
