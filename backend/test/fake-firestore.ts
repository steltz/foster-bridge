// In-memory Firestore fake. Supports the access patterns the app uses:
//   collection(path).doc(id).get() / .create(data) / .set(data)
//   collection(path).get()
//   collection(path).select(...).get()
//   collection(path).where(field, op, value)[.where(...)].get()  (op '==' | 'in')
//   runTransaction(fn) -> fn({ get, set })
// Keyed by full doc path, e.g. 'markets/MES/min-5/2026-07-14'.
export function fakeFirestore() {
  const docs = new Map<string, any>();

  function docRef(path: string) {
    return {
      id: path.split('/').pop() as string,
      path,
      get: () => Promise.resolve({ exists: docs.has(path), data: () => docs.get(path) }),
      // Firestore create() is write-once: a second create rejects with the
      // ALREADY_EXISTS gRPC code (6). Callers that want idempotency swallow it.
      create: (data: any) =>
        docs.has(path)
          ? Promise.reject(Object.assign(new Error(`ALREADY_EXISTS: ${path}`), { code: 6 }))
          : Promise.resolve(void docs.set(path, data)),
      set: (data: any) => Promise.resolve(void docs.set(path, data)),
    };
  }

  function collectionRef(base: string) {
    const listDocs = () =>
      [...docs.entries()]
        .filter(([k]) => k.startsWith(base + '/') && !k.slice(base.length + 1).includes('/'))
        .map(([k, v]) => ({ id: k.split('/').pop() as string, data: () => v }));

    type Filter = { field: string; op: '==' | 'in'; value: any };
    const matches = (row: { data: () => any }, filters: Filter[]) =>
      filters.every((f) => {
        const v = row.data()[f.field];
        if (f.op === '==') return v === f.value;
        if (f.op === 'in') return Array.isArray(f.value) && f.value.includes(v);
        return false;
      });
    const query = (filters: Filter[]) => ({
      where: (field: string, op: '==' | 'in', value: any) => query([...filters, { field, op, value }]),
      get: () => Promise.resolve({ docs: listDocs().filter((r) => matches(r, filters)) }),
    });

    return {
      doc: (id: string) => docRef(`${base}/${id}`),
      get: () => Promise.resolve({ docs: listDocs() }),
      // Real Firestore's .select(...) projects fields server-side; the fake has
      // no wire transfer to shrink, so a no-op projection is sufficient.
      select: (..._fields: string[]) => ({ get: () => Promise.resolve({ docs: listDocs() }) }),
      where: (field: string, op: '==' | 'in', value: any) => query([{ field, op, value }]),
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
