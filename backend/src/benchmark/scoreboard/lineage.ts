export interface TraderNode {
  name: string;
  origin: string | null;
  mutation: string | null;
  children: TraderNode[];
}

export interface TraderLike {
  name: string;
  origin: string | null;
  mutation: string | null;
}

export function buildLineage(traders: TraderLike[]): {
  roots: TraderNode[];
  unknownGroups: { origin: string; children: TraderNode[] }[];
  cycles: TraderNode[];
} {
  const nodes = new Map<string, TraderNode>(traders.map((t) => [t.name, { ...t, children: [] }]));
  const roots: TraderNode[] = [];
  const unknown = new Map<string, TraderNode[]>();
  for (const node of nodes.values()) {
    if (!node.origin) roots.push(node);
    else if (nodes.has(node.origin)) nodes.get(node.origin)!.children.push(node);
    else {
      if (!unknown.has(node.origin)) unknown.set(node.origin, []);
      unknown.get(node.origin)!.push(node);
    }
  }
  const byName = (a: TraderNode, b: TraderNode) => a.name.localeCompare(b.name, 'en');
  for (const node of nodes.values()) node.children.sort(byName);
  roots.sort(byName);
  const unknownGroups = [...unknown.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'en'))
    .map(([origin, children]) => ({ origin, children: children.sort(byName) }));
  const seen = new Set<string>();
  const visit = (n: TraderNode) => {
    if (seen.has(n.name)) return;
    seen.add(n.name);
    n.children.forEach(visit);
  };
  roots.forEach(visit);
  unknownGroups.forEach((g) => g.children.forEach(visit));
  const cycles = [...nodes.values()].filter((n) => !seen.has(n.name)).sort(byName);
  return { roots, unknownGroups, cycles };
}
