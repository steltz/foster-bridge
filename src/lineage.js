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
  // Assumes trader names are distinct (duplicates overwrite); the /trader-spawn skill enforces uniqueness.
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
