import { Test } from '@nestjs/testing';
import { STORAGE_BUCKET, FIRESTORE } from '../firebase/firebase.constants';
import {
  DayManifest,
  EminiplayerManifestService,
  VIDEO_IDS_COLLECTION,
} from './eminiplayer-manifest.service';
import { IngestValidationError } from './eminiplayer-ingest.errors';
import type { TranscriptVerdict } from './eminiplayer-verify.service';

const VERDICT: TranscriptVerdict = {
  docType: 'recap',
  isEsContent: true,
  referencedWeekday: 'Tuesday',
  confidence: 'high',
};

const MANIFEST: DayManifest = {
  version: 1,
  date: '07012026',
  recapDate: '06302026',
  createdAt: '2026-07-01T13:00:00.000Z',
  sources: {
    recapPageUrl: 'https://www.eminiplayer.net/post/recap.aspx',
    tradePlanPageUrl: 'https://www.eminiplayer.net/post/tp.aspx',
    recapVideoId: 'recapVid0001',
    tradePlanVideoId: 'tpVid0000001',
  },
  files: {
    recap: { storagePath: 'knowledge-base/es/07012026/06302026_ES_RECAP.md', sha256: 'a'.repeat(64), md5: 'aaa=', bytes: 1000 },
    tradePlanMd: { storagePath: 'knowledge-base/es/07012026/07012026_ES_TP.md', sha256: 'b'.repeat(64), md5: 'bbb=', bytes: 1100 },
    tradePlanPdf: { storagePath: 'knowledge-base/es/07012026/07012026_ES_TP.pdf', sha256: 'c'.repeat(64), md5: 'ccc=', bytes: 50000 },
  },
  evidence: {
    recapVideoTitle: 'ES Recap/Video Lesson for Tuesday 06/30/2026',
    tradePlanVideoTitle: 'ES Key Zones and Trade Plan for Wednesday 07/01/2026',
    recapVerdict: VERDICT,
    tradePlanVerdict: { ...VERDICT, docType: 'tradePlan', referencedWeekday: 'Wednesday' },
  },
};

function makeFakes(
  claims: Record<string, { date: string; slot: string }> = {},
  // `Partial` so a test can store a structurally-broken manifest: one that
  // parses as JSON but has no `sources`.
  storedManifest: DayManifest | Partial<DayManifest> | null = null,
) {
  const file = {
    exists: jest.fn(() => Promise.resolve([storedManifest !== null])),
    save: jest.fn((_payload: string, _opts: { contentType: string }) => Promise.resolve()),
    delete: jest.fn(() => Promise.resolve()),
    download: jest.fn(() =>
      Promise.resolve([Buffer.from(JSON.stringify(storedManifest ?? {}))]),
    ),
  };
  const bucket = { file: jest.fn(() => file) };
  const docRefs = new Map<string, { id: string }>();
  const txSets: Array<[string, unknown]> = [];
  const txDeletes: string[] = [];
  const snapOf = (ref: { id: string }) =>
    claims[ref.id]
      ? { exists: true, data: () => claims[ref.id] }
      : { exists: false, data: () => undefined };
  const firestore = {
    collection: jest.fn(() => ({
      doc: jest.fn((id: string) => {
        if (!docRefs.has(id)) docRefs.set(id, { id });
        return docRefs.get(id);
      }),
    })),
    getAll: jest.fn((...refs: Array<{ id: string }>) => Promise.resolve(refs.map(snapOf))),
    runTransaction: jest.fn(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        get: jest.fn((ref: { id: string }) =>
          Promise.resolve(
            claims[ref.id]
              ? { exists: true, data: () => claims[ref.id] }
              : { exists: false, data: () => undefined },
          ),
        ),
        set: jest.fn((ref: { id: string }, data: unknown) => {
          txSets.push([ref.id, data]);
        }),
        delete: jest.fn((ref: { id: string }) => {
          txDeletes.push(ref.id);
        }),
      };
      await fn(tx);
    }),
  };
  return { bucket, file, firestore, txSets, txDeletes };
}

async function build(fakes = makeFakes()) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      EminiplayerManifestService,
      { provide: STORAGE_BUCKET, useValue: fakes.bucket },
      { provide: FIRESTORE, useValue: fakes.firestore },
    ],
  }).compile();
  return { service: moduleRef.get(EminiplayerManifestService), ...fakes };
}

describe('EminiplayerManifestService', () => {
  it('computes the manifest path', async () => {
    const { service } = await build();
    expect(service.path('07012026')).toBe('knowledge-base/es/07012026/manifest.json');
  });

  it('commit claims both video ids then writes the manifest', async () => {
    const { service, bucket, file, txSets, firestore } = await build();
    await service.commit(MANIFEST);
    expect(firestore.collection).toHaveBeenCalledWith(VIDEO_IDS_COLLECTION);
    expect(txSets.map(([id]) => id)).toEqual(['recapVid0001', 'tpVid0000001']);
    expect(bucket.file).toHaveBeenCalledWith('knowledge-base/es/07012026/manifest.json');
    const [payload, opts] = file.save.mock.calls[0];
    expect(JSON.parse(payload)).toEqual(MANIFEST);
    expect(opts).toEqual({ contentType: 'application/json' });
    // claims happen BEFORE the manifest write
    expect(firestore.runTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      file.save.mock.invocationCallOrder[0],
    );
  });

  it('claims both video ids in a SINGLE transaction (a conflict can never half-claim)', async () => {
    const { service, firestore } = await build();
    await service.commit(MANIFEST);
    expect(firestore.runTransaction).toHaveBeenCalledTimes(1);
  });

  it('a conflict on the SECOND id leaves NO claim written for the first', async () => {
    // The regression that matters: with one transaction per id, recapVid0001
    // would already be claimed when tpVid0000001 conflicts — and since delete()
    // reads the ids to release FROM the manifest (which is never written here),
    // that orphan claim could never be released by any automated path.
    const fakes = makeFakes({ tpVid0000001: { date: '06152026', slot: 'tradePlan' } });
    const { service, file, txSets } = await build(fakes);
    await expect(service.commit(MANIFEST)).rejects.toThrow(IngestValidationError);
    expect(txSets).toEqual([]);
    expect(file.save).not.toHaveBeenCalled();
  });

  it('rejects a day whose two slots resolve to the same video id', async () => {
    const { service, file, firestore } = await build();
    const sameVideo: DayManifest = {
      ...MANIFEST,
      sources: { ...MANIFEST.sources, tradePlanVideoId: MANIFEST.sources.recapVideoId },
    };
    await expect(service.commit(sameVideo)).rejects.toThrow(IngestValidationError);
    await expect(service.commit(sameVideo)).rejects.toThrow(
      /same id recapVid0001 — a single video cannot serve both slots/,
    );
    expect(firestore.runTransaction).not.toHaveBeenCalled();
    expect(file.save).not.toHaveBeenCalled();
  });

  it('re-claim by the same date+slot is idempotent', async () => {
    const fakes = makeFakes({ recapVid0001: { date: '07012026', slot: 'recap' } });
    const { service, file } = await build(fakes);
    await service.commit(MANIFEST);
    expect(file.save).toHaveBeenCalled();
  });

  it('a claim held by another day throws IngestValidationError and never writes the manifest', async () => {
    const fakes = makeFakes({ recapVid0001: { date: '06152026', slot: 'recap' } });
    const { service, file } = await build(fakes);
    await expect(service.commit(MANIFEST)).rejects.toThrow(IngestValidationError);
    expect(file.save).not.toHaveBeenCalled();
  });

  it('read parses the stored manifest, or returns null when absent', async () => {
    const { service: withManifest } = await build(makeFakes({}, MANIFEST));
    await expect(withManifest.read('07012026')).resolves.toEqual(MANIFEST);
    const { service: without } = await build(makeFakes({}, null));
    await expect(without.read('07012026')).resolves.toBeNull();
  });

  it('delete releases the day-owned claims BEFORE removing the manifest (symmetric uncommit)', async () => {
    const fakes = makeFakes(
      {
        recapVid0001: { date: '07012026', slot: 'recap' },
        tpVid0000001: { date: '07012026', slot: 'tradePlan' },
      },
      MANIFEST,
    );
    const { service, file, txDeletes, firestore } = await build(fakes);
    await service.delete('07012026');
    expect(txDeletes.sort()).toEqual(['recapVid0001', 'tpVid0000001']);
    expect(file.delete).toHaveBeenCalledWith({ ignoreNotFound: true });
    // ORDER, not just membership: the release must precede the manifest
    // removal, so hoisting file.delete above it fails this test.
    const order = firestore.runTransaction.mock.invocationCallOrder;
    expect(order).toHaveLength(1); // one transaction releases both claims
    expect(order[order.length - 1]).toBeLessThan(file.delete.mock.invocationCallOrder[0]);
  });

  it('delete never touches a claim owned by a different date', async () => {
    // the manifest names recapVid0001, but another day now owns that claim
    const fakes = makeFakes({ recapVid0001: { date: '07152026', slot: 'recap' } }, MANIFEST);
    const { service, txDeletes, file } = await build(fakes);
    await service.delete('07012026');
    expect(txDeletes).toEqual([]);
    expect(file.delete).toHaveBeenCalledWith({ ignoreNotFound: true });
  });

  it('delete with no stored manifest just removes the (absent) file', async () => {
    const fakes = makeFakes({}, null);
    const { service, txDeletes, file } = await build(fakes);
    await service.delete('07012026');
    expect(txDeletes).toEqual([]);
    expect(file.delete).toHaveBeenCalledWith({ ignoreNotFound: true });
  });

  it('delete still removes a structurally-broken manifest (parses, but no sources)', async () => {
    // A manifest that can't be uncommitted can't be force-rerun — the file
    // removal must not depend on `sources` being well-formed.
    const fakes = makeFakes({}, {});
    const { service, txDeletes, file } = await build(fakes);
    await expect(service.delete('07012026')).resolves.toBeUndefined();
    expect(txDeletes).toEqual([]);
    expect(file.delete).toHaveBeenCalledWith({ ignoreNotFound: true });
  });

  it('exists reflects the bucket', async () => {
    const fakes = makeFakes({}, MANIFEST);
    const { service } = await build(fakes);
    await expect(service.exists('07012026')).resolves.toBe(true);
  });
});

describe('EminiplayerManifestService.findClaimConflict', () => {
  const CLAIMS = [
    { videoId: 'recapVid0001', slot: 'recap' as const },
    { videoId: 'tpVid0000001', slot: 'tradePlan' as const },
  ];

  it('returns null when neither video is claimed', async () => {
    const { service } = await build();
    await expect(service.findClaimConflict('07012026', CLAIMS)).resolves.toBeNull();
  });

  it('returns null for this day\'s own idempotent re-claim', async () => {
    const { service } = await build(
      makeFakes({
        recapVid0001: { date: '07012026', slot: 'recap' },
        tpVid0000001: { date: '07012026', slot: 'tradePlan' },
      }),
    );
    await expect(service.findClaimConflict('07012026', CLAIMS)).resolves.toBeNull();
  });

  it('reports the SAME message commit would raise when another day owns the video', async () => {
    const owned = { tpVid0000001: { date: '06302026', slot: 'recap' } };
    const { service } = await build(makeFakes(owned));

    const conflict = await service.findClaimConflict('07012026', CLAIMS);

    // The pre-check exists to fail early with the identical diagnosis, so the
    // two paths must never drift into describing the same state differently.
    const fromCommit = await service.commit(MANIFEST).catch((e: Error) => e.message);
    expect(conflict).toBe(
      'video tpVid0000001 is already claimed by 06302026/recap — the same video cannot serve two day groups',
    );
    expect(conflict).toBe(fromCommit);
  });

  it('never writes a claim — it is a read-only probe', async () => {
    const { service, txSets } = await build();
    await service.findClaimConflict('07012026', CLAIMS);
    expect(txSets).toEqual([]);
  });
});
