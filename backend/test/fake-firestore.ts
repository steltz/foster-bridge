// In-memory Firestore fake matching MarketDataService's access pattern:
//   firestore.collection('markets/{symbol}/{interval}').doc(date).get()
//   firestore.collection('markets/{symbol}/{interval}').select(...).get()
//   firestore.runTransaction(fn) -> fn({ get, set })
// Keyed by full doc path, e.g. 'markets/MES/min-5/2026-07-14'.
export function fakeFirestore() {
  const docs = new Map<string, any>();

  function docRef(path: string) {
    return {
      id: path.split('/').pop() as string,
      path,
      get: () => Promise.resolve({ exists: docs.has(path), data: () => docs.get(path) }),
    };
  }

  function collectionRef(base: string) {
    const listDocs = () =>
      [...docs.entries()]
        .filter(([k]) => k.startsWith(base + '/') && !k.slice(base.length + 1).includes('/'))
        .map(([k, v]) => ({ id: k.split('/').pop() as string, data: () => v }));
    return {
      doc: (id: string) => docRef(`${base}/${id}`),
      get: () => Promise.resolve({ docs: listDocs() }),
      // Real Firestore's .select(...) projects fields server-side; the fake
      // has no wire transfer to shrink, so a no-op projection returning the
      // same rows is sufficient to exercise the call chain.
      select: (..._fields: string[]) => ({ get: () => Promise.resolve({ docs: listDocs() }) }),
    };
  }

  return {
    collection: (path: string) => collectionRef(path),
    runTransaction: async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any) => {
          docs.set(ref.path, data);
        },
      }),
  } as any;
}
