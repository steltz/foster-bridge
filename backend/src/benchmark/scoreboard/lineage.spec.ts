import { buildLineage } from './lineage';

describe('buildLineage', () => {
  it('attaches children to parents and sorts everything', () => {
    const { roots, unknownGroups, cycles } = buildLineage([
      { name: 'b-root', origin: null, mutation: null },
      { name: 'a-root', origin: null, mutation: null },
      { name: 'a-child-2', origin: 'a-root', mutation: 'tweak 2' },
      { name: 'a-child-1', origin: 'a-root', mutation: 'tweak 1' },
      { name: 'a-grandchild', origin: 'a-child-1', mutation: 'tweak 3' },
    ]);
    expect(cycles).toEqual([]);
    expect(unknownGroups).toEqual([]);
    expect(roots.map((r) => r.name)).toEqual(['a-root', 'b-root']);
    expect(roots[0].children.map((c) => c.name)).toEqual(['a-child-1', 'a-child-2']);
    expect(roots[0].children[0].children.map((c) => c.name)).toEqual(['a-grandchild']);
  });

  it('groups orphans under their unknown origin', () => {
    const { roots, unknownGroups } = buildLineage([{ name: 'orphan', origin: 'deleted-trader', mutation: 'm' }]);
    expect(roots).toEqual([]);
    expect(unknownGroups).toHaveLength(1);
    expect(unknownGroups[0].origin).toBe('deleted-trader');
    expect(unknownGroups[0].children.map((c) => c.name)).toEqual(['orphan']);
  });

  it('reports origin cycles instead of dropping or looping', () => {
    const { roots, cycles } = buildLineage([
      { name: 'x', origin: 'y', mutation: 'm' },
      { name: 'y', origin: 'x', mutation: 'm' },
      { name: 'root', origin: null, mutation: null },
    ]);
    expect(roots.map((r) => r.name)).toEqual(['root']);
    expect(cycles.map((n) => n.name)).toEqual(['x', 'y']);
  });
});
