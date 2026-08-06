import { Test } from '@nestjs/testing';
import { STORAGE_BUCKET, FIRESTORE } from '../firebase/firebase.constants';
import { EminiplayerAuditService } from './eminiplayer-audit.service';
import { dayPaths, manifestPath, md5Base64, sha256Hex } from './eminiplayer-validation';
import type { DayManifest } from './eminiplayer-manifest.service';
import type { TranscriptVerdict } from './eminiplayer-verify.service';

function plausibleMarkdown(label: string): string {
  const rows: string[] = [];
  for (let i = 0; i < 60; i++) {
    const t = i * 4;
    const mm = String(Math.floor(t / 60)).padStart(2, '0');
    const ss = String(t % 60).padStart(2, '0');
    rows.push(`**${mm}:${ss}** ${label} segment ${i} with enough words to count`);
  }
  return `# Transcript\n\n${rows.join('\n')}\n`;
}

function plausiblePdf(): Buffer {
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n'),
    Buffer.alloc(12000, 0x20),
    Buffer.from('\n%%EOF\n'),
  ]);
}

const VERDICT: TranscriptVerdict = {
  docType: 'recap', isEsContent: true, referencedWeekday: 'none', confidence: 'high',
};

/**
 * A complete, self-consistent day. `objects` maps path -> content; metadata
 * (md5/size) is derived from content, mirroring what GCS reports. Individual
 * tests corrupt content or metadata to trip specific checks.
 *
 * Paths come from `dayPaths`/`manifestPath` — the same helpers the writer and
 * the audit use — NOT from literals. That is deliberate: it keeps the fixture
 * and the service in lockstep across a layout rename, so a service that
 * re-derived a path inline would disagree with the fixture and fail loudly
 * here. The literal strings those helpers produce are pinned once, in
 * eminiplayer-validation.spec.ts.
 */
function makeDay(date: string, recapDate: string, videoSuffix: string) {
  const paths = dayPaths(date, recapDate);
  const recapMd = plausibleMarkdown('recap');
  const tpMd = plausibleMarkdown('tp');
  const pdf = plausiblePdf();
  const record = (storagePath: string, content: Buffer) => ({
    storagePath,
    sha256: sha256Hex(content),
    md5: md5Base64(content),
    bytes: content.length,
  });
  const recapBuf = Buffer.from(recapMd);
  const tpBuf = Buffer.from(tpMd);
  const manifest: DayManifest = {
    version: 1,
    date,
    recapDate,
    createdAt: '2026-07-01T13:00:00.000Z',
    sources: {
      recapPageUrl: `https://www.eminiplayer.net/post/recap-${date}.aspx`,
      tradePlanPageUrl: `https://www.eminiplayer.net/post/tp-${date}.aspx`,
      recapVideoId: `recap${videoSuffix}`,
      tradePlanVideoId: `tp${videoSuffix}`,
    },
    files: {
      recap: record(paths.recap, recapBuf),
      tradePlanMd: record(paths.tradePlanMd, tpBuf),
      tradePlanPdf: record(paths.tradePlanPdf, pdf),
    },
    evidence: {
      recapVideoTitle: 't1', tradePlanVideoTitle: 't2',
      recapVerdict: VERDICT,
      tradePlanVerdict: { ...VERDICT, docType: 'tradePlan' },
    },
  };
  return {
    [paths.manifest]: Buffer.from(JSON.stringify(manifest)),
    [paths.recap]: recapBuf,
    [paths.tradePlanMd]: tpBuf,
    [paths.tradePlanPdf]: pdf,
  };
}

/** Claims that exactly mirror a makeDay(videoSuffix) manifest. */
function claimsFor(date: string, videoSuffix: string) {
  return {
    [`recap${videoSuffix}`]: { date, slot: 'recap' },
    [`tp${videoSuffix}`]: { date, slot: 'tradePlan' },
  };
}

function makeBucket(objects: Record<string, Buffer>) {
  const get = (path: string) => ({
    name: path,
    metadata: {
      md5Hash: objects[path] !== undefined ? md5Base64(objects[path]) : undefined,
      size: objects[path] !== undefined ? String(objects[path].length) : undefined,
    },
    download: jest.fn(() =>
      objects[path] !== undefined
        ? Promise.resolve([objects[path]])
        : Promise.reject(new Error('No such object')),
    ),
  });
  const files = new Map<string, ReturnType<typeof get>>();
  const memo = (path: string) => {
    if (!files.has(path)) files.set(path, get(path));
    return files.get(path)!;
  };
  return {
    files,
    file: jest.fn(memo),
    getFiles: jest.fn(({ prefix }: { prefix: string }) =>
      Promise.resolve([Object.keys(objects).filter((p) => p.startsWith(prefix)).map(memo)]),
    ),
  };
}

function makeFirestore(claims: Record<string, { date: string; slot: string }> = {}) {
  return {
    collection: jest.fn(() => ({
      get: jest.fn(() =>
        Promise.resolve({
          docs: Object.entries(claims).map(([id, data]) => ({ id, data: () => data })),
        }),
      ),
    })),
  };
}

async function build(
  objects: Record<string, Buffer>,
  claims: Record<string, { date: string; slot: string }> = {},
) {
  const bucket = makeBucket(objects);
  const moduleRef = await Test.createTestingModule({
    providers: [
      EminiplayerAuditService,
      { provide: STORAGE_BUCKET, useValue: bucket },
      { provide: FIRESTORE, useValue: makeFirestore(claims) },
    ],
  }).compile();
  return { service: moduleRef.get(EminiplayerAuditService), bucket };
}

describe('EminiplayerAuditService.audit', () => {
  it('reports a clean corpus (shallow: no artifact downloads, metadata only)', async () => {
    const objects = { ...makeDay('07012026', '06302026', 'Vid0000001') };
    const { service, bucket } = await build(objects, claimsFor('07012026', 'Vid0000001'));
    const report = await service.audit();
    expect(report).toEqual({ daysChecked: 1, ok: 1, deep: false, anomalies: [], uncommittedDays: [] });
    // shallow mode downloaded ONLY the manifest
    const downloaded = [...bucket.files.entries()]
      .filter(([, f]) => f.download.mock.calls.length > 0)
      .map(([p]) => p);
    expect(downloaded).toEqual([manifestPath('07012026')]);
  });

  it('flags a metadata hash mismatch without downloading (stored object changed after commit)', async () => {
    const objects = { ...makeDay('07012026', '06302026', 'Vid0000001') };
    objects[dayPaths('07012026', '06302026').tradePlanMd] = Buffer.from(plausibleMarkdown('tampered'));
    const { service } = await build(objects, claimsFor('07012026', 'Vid0000001'));
    const report = await service.audit();
    expect(report.ok).toBe(0);
    expect(report.anomalies).toEqual([
      expect.objectContaining({ date: '07012026', problem: expect.stringContaining('md5 mismatch') }),
    ]);
  });

  it('flags a missing file referenced by a manifest', async () => {
    const objects = { ...makeDay('07012026', '06302026', 'Vid0000001') };
    delete objects[dayPaths('07012026', '06302026').tradePlanPdf];
    const { service } = await build(objects, claimsFor('07012026', 'Vid0000001'));
    const report = await service.audit();
    expect(report.anomalies.some((a) => a.problem.includes('missing'))).toBe(true);
  });

  it('deep mode re-runs gates: a hash-consistent but gate-failing artifact is caught only there', async () => {
    const objects = { ...makeDay('07012026', '06302026', 'Vid0000001') };
    // corrupt the CONTENT and rewrite the manifest records to match it, so
    // every hash/size check passes and only the structural gate can object
    const bad = Buffer.from('# Transcript\n\n**00:00** way too short\n');
    const paths = dayPaths('07012026', '06302026');
    const manifest = JSON.parse(objects[paths.manifest].toString('utf8')) as DayManifest;
    manifest.files.tradePlanMd = {
      storagePath: paths.tradePlanMd,
      sha256: sha256Hex(bad), md5: md5Base64(bad), bytes: bad.length,
    };
    objects[paths.tradePlanMd] = bad;
    objects[paths.manifest] = Buffer.from(JSON.stringify(manifest));
    const claims = claimsFor('07012026', 'Vid0000001');

    const { service: shallow } = await build({ ...objects }, claims);
    expect((await shallow.audit()).anomalies).toEqual([]);

    const { service: deep } = await build({ ...objects }, claims);
    const report = await deep.audit({ deep: true });
    expect(report.deep).toBe(true);
    expect(report.anomalies.some((a) => a.problem.includes('fails its gate'))).toBe(true);
  });

  it('deep mode attributes a per-file transport failure to the artifact, not the manifest', async () => {
    const objects = { ...makeDay('07012026', '06302026', 'Vid0000001') };
    const { service, bucket } = await build(objects, claimsFor('07012026', 'Vid0000001'));
    bucket.file(dayPaths('07012026', '06302026').tradePlanPdf).download.mockRejectedValue(
      new Error('socket hang up'),
    );
    const report = await service.audit({ deep: true });
    expect(report.anomalies.some((a) => a.problem.includes('tradePlanPdf unreadable'))).toBe(true);
    expect(report.anomalies.some((a) => a.problem.includes('manifest unreadable'))).toBe(false);
  });

  it('flags duplicate video ids across manifests', async () => {
    const objects = {
      ...makeDay('07012026', '06302026', 'Vid0000001'),
      ...makeDay('07022026', '07012026', 'Vid0000001'), // same video ids as day 1
    };
    const { service } = await build(objects, claimsFor('07012026', 'Vid0000001'));
    const report = await service.audit();
    expect(report.anomalies.some((a) => a.problem.includes('also used by'))).toBe(true);
  });

  it('lists unmanifested day folders without failing them', async () => {
    const objects = { ...makeDay('07012026', '06302026', 'Vid0000001') };
    objects[dayPaths('07022026', '07012026').tradePlanMd] = Buffer.from(plausibleMarkdown('tp'));
    const { service } = await build(objects, claimsFor('07012026', 'Vid0000001'));
    const report = await service.audit();
    expect(report.uncommittedDays).toEqual(['07022026']);
    expect(report.daysChecked).toBe(2);
    expect(report.ok).toBe(1);
  });

  it('flags an orphaned in-range claim (no manifest references it)', async () => {
    const objects = { ...makeDay('07012026', '06302026', 'Vid0000001') };
    const { service } = await build(objects, {
      ...claimsFor('07012026', 'Vid0000001'),
      ghostVideo001: { date: '07012026', slot: 'recap' },
    });
    const report = await service.audit();
    expect(report.anomalies.some((a) => a.problem.includes('orphaned'))).toBe(true);
  });

  it('flags a manifested video id whose claim is missing (uniqueness unenforced)', async () => {
    const objects = { ...makeDay('07012026', '06302026', 'Vid0000001') };
    const claims = claimsFor('07012026', 'Vid0000001');
    delete claims['recapVid0000001'];
    const { service } = await build(objects, claims);
    const report = await service.audit();
    expect(report.anomalies.some((a) => a.problem.includes('no video-id claim'))).toBe(true);
  });

  it('range params scope which days are audited', async () => {
    const objects = {
      ...makeDay('07012026', '06302026', 'Vid0000001'),
      ...makeDay('07152026', '07142026', 'Vid0000002'),
    };
    const claims = { ...claimsFor('07012026', 'Vid0000001'), ...claimsFor('07152026', 'Vid0000002') };
    const { service } = await build(objects, claims);
    const report = await service.audit({ from: '07102026', to: '07312026' });
    expect(report.daysChecked).toBe(1);
    expect(report.ok).toBe(1);
    expect(report.anomalies).toEqual([]); // day 07012026's claims are out of range, not orphans
  });

  it('locates a committed manifest via the manifestPath helper, not a re-derived literal', async () => {
    // Drift guard for the storage-layout constraint. The fixture keys its
    // manifest with manifestPath(), so a rename inside that helper moves the
    // fixture and the service together — but a service that re-derived the
    // path inline would keep looking at the OLD path, miss the manifest, and
    // silently file the day as uncommitted. That failure is invisible in
    // production (the report is a clean `anomalies: []` having verified
    // nothing), so it has to be caught here.
    const objects = { ...makeDay('07012026', '06302026', 'Vid0000001') };
    expect(Object.keys(objects)).toContain(manifestPath('07012026'));

    const { service } = await build(objects, claimsFor('07012026', 'Vid0000001'));
    const report = await service.audit();
    expect(report.uncommittedDays).toEqual([]); // the tell: a missed manifest lands here
    expect(report.daysChecked).toBe(1);
    expect(report.ok).toBe(1);
  });

  // ---- hardening: untrusted dates must never abort the whole sweep ----
  // Folder names and Firestore claim dates are inputs the audit does not
  // control; `\d{8}` guards the SHAPE but not calendar validity, and
  // parseMmddyyyy throws on both. Each must degrade to a per-item anomaly.

  it('reports a folder whose name is not a real calendar date instead of aborting', async () => {
    const objects = { ...makeDay('07012026', '06302026', 'Vid0000001') };
    // 8 digits, so it passes the day regex, but month 13 does not exist
    objects[manifestPath('13012026')] = Buffer.from('{}');
    const { service } = await build(objects, claimsFor('07012026', 'Vid0000001'));
    const report = await service.audit();
    expect(report.daysChecked).toBe(1);
    expect(report.ok).toBe(1);
    expect(
      report.anomalies.some(
        (a) => a.date === '13012026' && a.problem.includes('not a real calendar date'),
      ),
    ).toBe(true);
  });

  it('reports a claim whose date is unparseable instead of rejecting the sweep', async () => {
    const objects = { ...makeDay('07012026', '06302026', 'Vid0000001') };
    const { service } = await build(objects, {
      ...claimsFor('07012026', 'Vid0000001'),
      brokenVideo01: { date: 'garbage', slot: 'recap' },
    });
    const report = await service.audit();
    expect(report.ok).toBe(1);
    expect(
      report.anomalies.some((a) => a.problem.includes('brokenVideo01 has an unparseable date')),
    ).toBe(true);
  });

  it('reports an unanticipated manifest shape as a day-level abort and keeps sweeping', async () => {
    // `files` is present (so the structural guard passes) but one record is
    // null — reaching `record.storagePath` throws a raw TypeError. Without the
    // generic backstop that escapes the sweep and 500s the whole endpoint with
    // zero anomalies, contradicting "the audit never aborts on one bad item".
    const objects = {
      ...makeDay('07012026', '06302026', 'Vid0000001'),
      ...makeDay('07022026', '07012026', 'Vid0000002'),
    };
    const badManifest = JSON.parse(
      objects[manifestPath('07022026')].toString('utf8'),
    ) as DayManifest;
    (badManifest.files as unknown as Record<string, null>).recap = null;
    objects[manifestPath('07022026')] = Buffer.from(JSON.stringify(badManifest));

    const { service } = await build(objects, claimsFor('07012026', 'Vid0000001'));
    const report = await service.audit(); // resolves; does not reject
    expect(report.daysChecked).toBe(2);
    expect(
      report.anomalies.some(
        (a) => a.date === '07022026' && a.problem.startsWith('day check aborted:'),
      ),
    ).toBe(true);
    expect(report.ok).toBe(1); // the aborted day is not counted ok...
    // ...and the OTHER day was still fully checked
    expect(report.anomalies.some((a) => a.date === '07012026')).toBe(false);
  });

  it('reports a structurally invalid manifest instead of aborting the sweep', async () => {
    const objects = { ...makeDay('07012026', '06302026', 'Vid0000001') };
    // parses as JSON, but has no `files`/`sources` to walk
    objects[manifestPath('07022026')] = Buffer.from('{"version":1}');
    const { service } = await build(objects, claimsFor('07012026', 'Vid0000001'));
    const report = await service.audit();
    expect(report.daysChecked).toBe(2);
    expect(report.ok).toBe(1);
    expect(
      report.anomalies.some(
        (a) => a.date === '07022026' && a.problem.includes('structurally invalid'),
      ),
    ).toBe(true);
  });
});
