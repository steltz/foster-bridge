import { CloudInputsService } from './cloud-inputs.service';

const ROOT_TRADER_MD = '---\nname: context-trader\nstyle: contextual\n---\nbody';
const CHILD_TRADER_MD = '---\nname: context-structured\norigin: context-trader\nmutation: adds structure\n---\nbody2';
const FEATURE_MD = '---\nid: seven-keys-scorecard\nname: Seven Keys Scorecard\nstaticDoc: knowledge-base/methods/seven-keys.md\nartifactSuffix: _ES_KEYS.md\n---\nblock text';
const PLAIN_FEATURE_MD = '---\nid: plain\nname: Plain\n---\nplain block';

function fakeDb(collections: Record<string, any[]>) {
  return {
    collection: (name: string) => ({
      get: () =>
        Promise.resolve({ docs: (collections[name] ?? []).map((data) => ({ data: () => data })) }),
    }),
  } as any;
}

function fakeBucket(objects: Record<string, string | Buffer> = {}) {
  return {
    getFiles: ({ prefix }: { prefix: string }) =>
      Promise.resolve([
        Object.keys(objects)
          .filter((n) => n.startsWith(prefix))
          .map((name) => ({ name })),
      ]),
    file: (path: string) => ({
      exists: () => Promise.resolve([path in objects] as [boolean]),
      download: () =>
        path in objects
          ? Promise.resolve([Buffer.from(objects[path])] as [Buffer])
          : Promise.reject(new Error(`No such object: ${path}`)),
    }),
  } as any;
}

describe('CloudInputsService (firestore half)', () => {
  it('collectTraders maps docs, accepts root personas without lineage, recomputes sha256, sorts by name', async () => {
    const svc = new CloudInputsService(
      fakeDb({ traders: [
        { name: 'context-trader', content: ROOT_TRADER_MD, sha256: 'stale-ignored' },
        { name: 'context-structured', content: CHILD_TRADER_MD, sha256: 'stale-ignored' },
      ] }),
      fakeBucket(),
    );
    const traders = await svc.collectTraders();
    expect(traders.map((t) => t.name)).toEqual(['context-structured', 'context-trader']);
    const root = traders.find((t) => t.name === 'context-trader')!;
    expect(root).toMatchObject({ origin: null, mutation: null, content: ROOT_TRADER_MD });
    expect(root.sha256).toBe(svc.sha256(ROOT_TRADER_MD)); // recomputed, never trusted
    const child = traders.find((t) => t.name === 'context-structured')!;
    expect(child).toMatchObject({ origin: 'context-trader', mutation: 'adds structure' });
  });

  it('collectFeatures resolves staticDocContent from the passed methods doc only when frontmatter has staticDoc', async () => {
    const svc = new CloudInputsService(
      fakeDb({ features: [
        { id: 'seven-keys-scorecard', content: FEATURE_MD },
        { id: 'plain', content: PLAIN_FEATURE_MD },
      ] }),
      fakeBucket(),
    );
    const features = await svc.collectFeatures('METHODS DOC');
    expect(features.map((f) => f.id)).toEqual(['plain', 'seven-keys-scorecard']);
    const scorecard = features.find((f) => f.id === 'seven-keys-scorecard')!;
    expect(scorecard).toMatchObject({
      name: 'Seven Keys Scorecard',
      block: 'block text',
      artifactSuffix: '_ES_KEYS.md',
      staticDocContent: 'METHODS DOC',
    });
    expect(scorecard.sha256).toBe(svc.sha256(FEATURE_MD));
    expect(scorecard.staticDocSha256).toBe(svc.sha256('METHODS DOC'));
    const plain = features.find((f) => f.id === 'plain')!;
    expect(plain.staticDocContent).toBeNull();
    expect(plain.staticDocSha256).toBeNull();
  });

  it('a feature with staticDoc but a null methods doc yields null staticDocContent (surfaced by run-time refusals, not a crash)', async () => {
    const svc = new CloudInputsService(fakeDb({ features: [{ id: 'seven-keys-scorecard', content: FEATURE_MD }] }), fakeBucket());
    const [f] = await svc.collectFeatures(null);
    expect(f.staticDocContent).toBeNull();
  });

  it('empty collections return []', async () => {
    const svc = new CloudInputsService(fakeDb({}), fakeBucket());
    expect(await svc.collectTraders()).toEqual([]);
    expect(await svc.collectFeatures(null)).toEqual([]);
  });

  it('a malformed doc (missing content) produces a NAMED error, not a TypeError', async () => {
    const svc = new CloudInputsService(fakeDb({ traders: [{ name: 'broken' }] }), fakeBucket());
    await expect(svc.collectTraders()).rejects.toThrow(/traders\/broken is malformed/);
  });

  it('wraps a rejecting firestore read in ServiceUnavailableException', async () => {
    const db = { collection: () => ({ get: () => Promise.reject(new Error('UNAVAILABLE')) }) } as any;
    const svc = new CloudInputsService(db, fakeBucket());
    await expect(svc.collectTraders()).rejects.toThrow('inputs unavailable');
  });
});
