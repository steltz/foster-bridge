import { createHash } from 'node:crypto';
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

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const manifest = (date: string, recapDate: string, files: { tp: string; pdf: string; recap: string }) =>
  JSON.stringify({
    date,
    recapDate,
    files: {
      tradePlanMd: { sha256: sha(files.tp) },
      tradePlanPdf: { sha256: sha(files.pdf) },
      recap: { sha256: sha(files.recap) },
    },
  });

function seededBucket() {
  return fakeBucket({
    'knowledge-base/general/a.md': 'AAA',
    'knowledge-base/general/b.md': 'BBB',
    'knowledge-base/methods/seven-keys.md': 'METHODS',
    'knowledge-base/es/07012026/manifest.json': manifest('07012026', '06302026', { tp: 'PLAN1', pdf: 'PDF1', recap: 'RECAP0630' }),
    'knowledge-base/es/07012026/07012026_ES_TP.md': 'PLAN1',
    'knowledge-base/es/07012026/07012026_ES_TP.pdf': 'PDF1',
    'knowledge-base/es/07012026/06302026_ES_RECAP.md': 'RECAP0630',
    'knowledge-base/es/07022026/manifest.json': manifest('07022026', '07012026', { tp: 'PLAN2', pdf: 'PDF2', recap: 'RECAP0701' }),
    'knowledge-base/es/07022026/07022026_ES_TP.md': 'PLAN2',
    'knowledge-base/es/07022026/07022026_ES_TP.pdf': 'PDF2',
    'knowledge-base/es/07022026/07012026_ES_RECAP.md': 'RECAP0701',
    // committed manifest but missing artifacts -> issue, not a day
    'knowledge-base/es/07062026/manifest.json': manifest('07062026', '07022026', { tp: 'PLAN3', pdf: 'PDF3', recap: 'RECAP0702' }),
    'knowledge-base/es/07062026/07062026_ES_TP.md': 'PLAN3',
    // an ORPHAN recap in an uncommitted folder — must NOT satisfy outcomeRecapForDay
    'knowledge-base/es/07072026/07022026_ES_RECAP.md': 'ORPHAN RECAP',
  });
}

describe('CloudInputsService (bucket half + snapshot)', () => {
  const build = (bucket = seededBucket()) =>
    new CloudInputsService(
      fakeDb({
        traders: [{ name: 'context-trader', content: ROOT_TRADER_MD }],
        features: [{ id: 'seven-keys-scorecard', content: FEATURE_MD }],
      }),
      bucket,
    );

  it('snapshot() assembles everything in one call; features carry the live methods doc', async () => {
    const snap = await build().snapshot();
    expect(snap.general.concatenated).toBe('AAABBB');
    expect(snap.methodsDoc).toBe('METHODS');
    expect(snap.traders).toHaveLength(1);
    expect(snap.features[0].staticDocContent).toBe('METHODS');
    expect(snap.days.map((d) => d.day)).toEqual(['07012026', '07022026']);
    expect(snap.days[0]).toMatchObject({ date: '2026-07-01', prefix: '07012026', recapDate: '06302026' });
    expect(snap.days[0].fileSha256.tradePlanMd).toBe(sha('PLAN1'));
    expect(snap.issues).toEqual([
      { day: '07062026', missing: expect.arrayContaining([expect.stringContaining('_ES_TP.pdf'), expect.stringContaining('_ES_RECAP.md')]) },
    ]);
  });

  it('empty general prefix hashes to the zero sentinel; missing methods doc is null', async () => {
    const snap = await new CloudInputsService(fakeDb({}), fakeBucket()).snapshot();
    expect(snap.general.sha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(snap.methodsDoc).toBeNull();
    expect(snap.days).toEqual([]);
  });

  it('loadDay downloads and VERIFIES all three artifacts against the manifest hashes', async () => {
    const svc = build();
    const snap = await svc.snapshot();
    const day = await svc.loadDay(snap.days[0]);
    expect(day.pdf.toString()).toBe('PDF1');
    expect(day.tpTranscript).toBe('PLAN1');
    expect(day.recapTranscript).toBe('RECAP0630');
    expect(day.recapFileName).toBe('06302026_ES_RECAP.md');
  });

  it('loadDay throws when an artifact no longer matches its manifest hash (force-rerun mid-run)', async () => {
    const bucket = seededBucket();
    const svc = build(bucket);
    const snap = await svc.snapshot();
    // simulate an eminiplayer force-rerun overwriting the plan after the snapshot
    const tampered = fakeBucket({
      ...Object.fromEntries([['knowledge-base/es/07012026/07012026_ES_TP.md', 'TAMPERED PLAN']]),
      'knowledge-base/es/07012026/07012026_ES_TP.pdf': 'PDF1',
      'knowledge-base/es/07012026/06302026_ES_RECAP.md': 'RECAP0630',
    });
    const svc2 = new CloudInputsService(fakeDb({}), tampered);
    await expect(svc2.loadDay(snap.days[0])).rejects.toThrow(/07012026 changed/);
  });

  it('priorCompleteDays is a pure filter over the snapshot', async () => {
    const svc = build();
    const snap = await svc.snapshot();
    expect(svc.priorCompleteDays('07022026', snap).map((d) => d.day)).toEqual(['07012026']);
  });

  it('outcomeRecapForDay resolves through committed listings only — orphan folders never satisfy it', async () => {
    const svc = build();
    const snap = await svc.snapshot();
    expect(await svc.outcomeRecapForDay('07012026', snap)).toBe('RECAP0701'); // via committed 07022026
    // 07022026's outcome recap exists ONLY in the uncommitted 07072026 folder -> null
    expect(await svc.outcomeRecapForDay('07022026', snap)).toBeNull();
  });
});

describe('CloudInputsService.listDays', () => {
  it('returns the day scan without reading traders, features, or general docs', async () => {
    const svc = new CloudInputsService(fakeDb({}), fakeBucket());
    const scan = { listings: [{ day: '07012026', date: '2026-07-01', prefix: '07012026', recapDate: '06302026', fileSha256: { tradePlanMd: 'a', tradePlanPdf: 'b', recap: 'c' } }], issues: [] };
    const scanSpy = jest.spyOn(svc as any, 'scanDays').mockResolvedValue(scan);
    const tradersSpy = jest.spyOn(svc, 'collectTraders');
    expect(await svc.listDays()).toEqual(scan);
    expect(scanSpy).toHaveBeenCalledTimes(1);
    expect(tradersSpy).not.toHaveBeenCalled();
  });
});
