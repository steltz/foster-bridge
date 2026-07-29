import { fakeFirestore } from '../../test/fake-firestore';
import { MoonshotExtractStore, EXTRACT_CHUNK_SIZE, LRU_MAX } from './moonshot.extract-store';

// Mirrors the store's internal (unexported) Firestore collection name, so a
// handful of tests below can assert on the raw doc/chunk structure rather
// than only round-trip output.
const EXTRACTS_COLLECTION = 'moonshotExtracts';

describe('MoonshotExtractStore', () => {
  it('stores and resolves small text by hash and by id', async () => {
    const store = new MoonshotExtractStore(fakeFirestore());
    await store.put('abc', 'hello world', { filename: 'f.pdf', mediaType: 'application/pdf' });
    expect(await store.getByHash('abc')).toBe('hello world');
    expect(await store.getById('moonshot-extract:abc')).toBe('hello world');
    expect(await store.getByHash('missing')).toBeNull();
  });

  it('resolves getById given a bare hash (no moonshot-extract: prefix)', async () => {
    const store = new MoonshotExtractStore(fakeFirestore());
    await store.put('bare-hash', 'plain text');
    expect(await store.getById('bare-hash')).toBe('plain text');
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

  it('keeps text at exactly the chunk size inline; one unit over splits into two chunks', async () => {
    const db = fakeFirestore();
    const store = new MoonshotExtractStore(db);

    const exact = 'a'.repeat(EXTRACT_CHUNK_SIZE);
    await store.put('exact', exact);
    const exactSnap = await db.collection(EXTRACTS_COLLECTION).doc('exact').get();
    expect(exactSnap.data().chunked).toBe(false);
    expect(await store.getByHash('exact')).toBe(exact);

    const overBy1 = 'b'.repeat(EXTRACT_CHUNK_SIZE) + 'c';
    await store.put('over', overBy1);
    const overSnap = await db.collection(EXTRACTS_COLLECTION).doc('over').get();
    expect(overSnap.data().chunked).toBe(true);
    expect(overSnap.data().chunks).toBe(2);
    const chunk1Snap = await db.collection(EXTRACTS_COLLECTION).doc('over').collection('chunks').doc('1').get();
    expect(chunk1Snap.data().text).toBe('c');

    // Fresh reader forces reassembly through the chunk-read path.
    const reader = new MoonshotExtractStore(db);
    expect(await reader.getByHash('over')).toBe(overBy1);
  });

  it('backs off a chunk boundary that would split a surrogate pair', async () => {
    const db = fakeFirestore();
    const writer = new MoonshotExtractStore(db);
    const prefix = 'x'.repeat(EXTRACT_CHUNK_SIZE - 1);
    const astral = '😀'; // surrogate pair whose high half lands right at the naive boundary
    const suffix = 'y'.repeat(50);
    const big = prefix + astral + suffix;

    await writer.put('astral', big);

    const chunksSnap = await db.collection(EXTRACTS_COLLECTION).doc('astral').collection('chunks').get();
    expect(chunksSnap.docs.length).toBe(2);
    for (const chunkDoc of chunksSnap.docs) {
      const text: string = chunkDoc.data().text;
      const lastUnit = text.charCodeAt(text.length - 1);
      expect(lastUnit >= 0xd800 && lastUnit <= 0xdbff).toBe(false); // no chunk ends in a lone high surrogate
    }

    const reader = new MoonshotExtractStore(db);
    expect(await reader.getByHash('astral')).toBe(big);
  });

  it('evicts the least-recently-used entry past LRU_MAX, while a recently-touched entry stays cached', async () => {
    const db = fakeFirestore();
    const store = new MoonshotExtractStore(db);

    for (let i = 0; i < LRU_MAX; i++) {
      await store.put(`k${i}`, `text-${i}`);
    }
    // Touch k0 so it becomes most-recently-used; the next put must evict k1
    // (now the true least-recently-used), not k0.
    await store.getByHash('k0');
    await store.put(`k${LRU_MAX}`, `text-${LRU_MAX}`);

    // Pull the rug out from under every key so only the LRU can answer.
    for (let i = 0; i <= LRU_MAX; i++) {
      await db.collection(EXTRACTS_COLLECTION).doc(`k${i}`).delete();
    }

    expect(await store.getByHash('k0')).toBe('text-0'); // still cached, survives the deleted doc
    expect(await store.getByHash('k1')).toBeNull(); // evicted -> falls through to the now-deleted doc
  });

  it('throws on a torn chunked doc (parent declares more chunks than are present)', async () => {
    const db = fakeFirestore();
    const store = new MoonshotExtractStore(db);
    // Simulate a crash mid-write: parent doc landed but not every chunk did
    // (or, pre-fix, the reverse ordering left the same shape). A structurally
    // inconsistent doc must fail loudly, never silently read back as truncated text.
    await db.collection(EXTRACTS_COLLECTION).doc('torn').set({ chunked: true, chunks: 2 });
    await db.collection(EXTRACTS_COLLECTION).doc('torn').collection('chunks').doc('0').set({ text: 'only-half' });

    await expect(store.getByHash('torn')).rejects.toThrow('doc "torn" declares 2 chunks but 1 are present');
  });
});
