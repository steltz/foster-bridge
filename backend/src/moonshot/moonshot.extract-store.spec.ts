import { MoonshotExtractStore, EXTRACT_CHUNK_SIZE } from './moonshot.extract-store';

// Minimal Firestore doc/collection fake (single collection + optional subcollection).
function fakeFirestore() {
  const docs = new Map<string, any>();
  const makeDoc = (path: string) => ({
    async get() { return { exists: docs.has(path), data: () => docs.get(path) }; },
    async set(v: any) { docs.set(path, v); },
    async delete() { docs.delete(path); },
    collection: (sub: string) => makeColl(`${path}/${sub}`),
  });
  const makeColl = (base: string) => ({
    doc: (id: string) => makeDoc(`${base}/${id}`),
    async get() {
      const prefix = `${base}/`;
      const rows = [...docs.entries()].filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'));
      return { docs: rows.map(([k, v]) => ({ id: k.slice(prefix.length), data: () => v })) };
    },
  });
  return { collection: (name: string) => makeColl(name) } as any;
}

describe('MoonshotExtractStore', () => {
  it('stores and resolves small text by hash and by id', async () => {
    const store = new MoonshotExtractStore(fakeFirestore());
    await store.put('abc', 'hello world', { filename: 'f.pdf', mediaType: 'application/pdf' });
    expect(await store.getByHash('abc')).toBe('hello world');
    expect(await store.getById('moonshot-extract:abc')).toBe('hello world');
    expect(await store.getByHash('missing')).toBeNull();
  });

  it('chunks and reassembles text larger than the chunk size (fresh instance → no LRU)', async () => {
    const db = fakeFirestore();
    const writer = new MoonshotExtractStore(db);
    const big = 'x'.repeat(EXTRACT_CHUNK_SIZE + 100) + 'END';
    await writer.put('big', big);
    // A second instance sharing the same DB has an empty LRU, forcing the
    // chunk-reassembly read path (the writer's LRU would otherwise short-circuit it).
    const reader = new MoonshotExtractStore(db);
    expect(await reader.getByHash('big')).toBe(big);
  });
});
