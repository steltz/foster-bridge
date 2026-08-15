import { Test } from '@nestjs/testing';
import { EminiplayerIngestService } from './eminiplayer-ingest.service';
import { EminiplayerService } from './eminiplayer.service';
import { TranscriptService } from '../transcript/transcript.service';
import { EminiplayerVerifyService } from './eminiplayer-verify.service';
import { EminiplayerManifestService, type DayManifest } from './eminiplayer-manifest.service';
import { STORAGE_BUCKET } from '../firebase/firebase.constants';
import { IngestStageError, IngestValidationError } from './eminiplayer-ingest.errors';
import { ArchiveNotFoundError, type DayEntries } from './eminiplayer.constants';
import { VideoUnavailableError } from '../transcript/transcript.service';

const DATE = '07012026'; // Wednesday
const RECAP_DATE = '06302026'; // Tuesday
const DIR = `knowledge-base/es/${DATE}`;
const RECAP_PATH = `${DIR}/${RECAP_DATE}_ES_RECAP.md`;
const TP_MD_PATH = `${DIR}/${DATE}_ES_TP.md`;
const TP_PDF_PATH = `${DIR}/${DATE}_ES_TP.pdf`;
const MANIFEST_PATH = `${DIR}/manifest.json`;

const ENTRIES: DayEntries = {
  tradePlan: {
    date: DATE,
    pageUrl: 'https://www.eminiplayer.net/post/tp.aspx',
    title: 'ES Key Zones and Trade Plan for Wed. 07/01/2026',
  },
  recap: {
    date: RECAP_DATE,
    pageUrl: 'https://www.eminiplayer.net/post/recap.aspx',
    title: 'ES Recap/Video Lesson for Tuesday 06/30/2026',
  },
};

/** 60 lines, 4s apart — passes the transcript gate. */
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

function plausibleSegments(label: string) {
  return Array.from({ length: 60 }, (_, i) => ({
    text: `${label} segment ${i} with enough words to count`,
    offset: i * 4,
  }));
}

function plausiblePdf(): Buffer {
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n'),
    Buffer.alloc(12000, 0x20),
    Buffer.from('\n%%EOF\n'),
  ]);
}

type FakeFile = {
  name: string;
  exists: jest.Mock;
  save: jest.Mock;
  delete: jest.Mock;
  download: jest.Mock;
};

function makeBucket(existing: Record<string, string | Buffer> = {}) {
  const files = new Map<string, FakeFile>();
  const get = (path: string): FakeFile => {
    if (!files.has(path)) {
      const content = existing[path];
      files.set(path, {
        name: path,
        exists: jest.fn(() => Promise.resolve([content !== undefined])),
        save: jest.fn(() => Promise.resolve()),
        delete: jest.fn(() => Promise.resolve()),
        download: jest.fn(() =>
          Promise.resolve([Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''))]),
        ),
      });
    }
    return files.get(path)!;
  };
  return {
    files,
    file: jest.fn(get),
    getFiles: jest.fn(({ prefix }: { prefix: string }) =>
      Promise.resolve([
        Object.keys(existing)
          .filter((p) => p.startsWith(prefix))
          .map(get),
      ]),
    ),
  };
}

/** Every storage path that received a save() — sorted, for all-or-nothing assertions. */
function written(bucket: ReturnType<typeof makeBucket>): string[] {
  return [...bucket.files.values()]
    .filter((f) => f.save.mock.calls.length > 0)
    .map((f) => f.name)
    .sort();
}

/** Every storage path that received a delete(). */
function deleted(bucket: ReturnType<typeof makeBucket>): string[] {
  return [...bucket.files.values()]
    .filter((f) => f.delete.mock.calls.length > 0)
    .map((f) => f.name)
    .sort();
}

const ALL_ARTIFACTS = [RECAP_PATH, TP_MD_PATH, TP_PDF_PATH].sort();

/** A minimal committed manifest for short-circuit tests. */
function committedManifest(recapDate = RECAP_DATE) {
  const dir = `knowledge-base/es/${DATE}`;
  return {
    version: 1,
    date: DATE,
    recapDate,
    createdAt: '2026-07-01T13:00:00.000Z',
    sources: {
      recapPageUrl: ENTRIES.recap.pageUrl,
      tradePlanPageUrl: ENTRIES.tradePlan.pageUrl,
      recapVideoId: 'recapVid0001',
      tradePlanVideoId: 'tpVid0000001',
    },
    files: {
      recap: { storagePath: `${dir}/${recapDate}_ES_RECAP.md`, sha256: 'a'.repeat(64), md5: 'a=', bytes: 1 },
      tradePlanMd: { storagePath: TP_MD_PATH, sha256: 'b'.repeat(64), md5: 'b=', bytes: 1 },
      tradePlanPdf: { storagePath: TP_PDF_PATH, sha256: 'c'.repeat(64), md5: 'c=', bytes: 1 },
    },
    evidence: {
      recapVideoTitle: 'x', tradePlanVideoTitle: 'y',
      recapVerdict: { docType: 'recap', isEsContent: true, referencedWeekday: 'none', confidence: 'high' },
      tradePlanVerdict: { docType: 'tradePlan', isEsContent: true, referencedWeekday: 'none', confidence: 'high' },
    },
  };
}

async function build({
  bucket = makeBucket(),
  entries = ENTRIES,
  committed = null as ReturnType<typeof committedManifest> | null,
}: {
  bucket?: ReturnType<typeof makeBucket>;
  entries?: DayEntries;
  committed?: ReturnType<typeof committedManifest> | null;
} = {}) {
  const eminiplayer = {
    findDayEntries: jest.fn(() => Promise.resolve(entries)),
    getYoutubeUrl: jest.fn((pageUrl: string) =>
      Promise.resolve(
        pageUrl.includes('recap')
          ? 'https://youtu.be/recapVid0001'
          : 'https://youtu.be/tpVid0000001',
      ),
    ),
    downloadTradePlanPdf: jest.fn(() => Promise.resolve(plausiblePdf())),
  };
  const transcript = {
    fetchSegments: jest.fn((url: string) =>
      Promise.resolve(plausibleSegments(url.includes('recap') ? 'recap' : 'tp')),
    ),
    fetchVideoTitle: jest.fn((videoId: string) =>
      Promise.resolve(
        videoId === 'recapVid0001'
          ? 'ES Recap/Video Lesson for Tuesday 06/30/2026'
          : 'ES Key Zones and Trade Plan for Wed. 07/01/2026',
      ),
    ),
  };
  const verify = {
    verifyTranscript: jest.fn((_md: string, expected: { flavor: string }) =>
      Promise.resolve({
        docType: expected.flavor,
        isEsContent: true,
        referencedWeekday: 'none',
        confidence: 'high',
      }),
    ),
  };
  const manifest = {
    path: jest.fn((date: string) => `knowledge-base/es/${date}/manifest.json`),
    read: jest.fn(() => Promise.resolve(committed)),
    exists: jest.fn(() => Promise.resolve(committed !== null)),
    delete: jest.fn(() => Promise.resolve()),
    commit: jest.fn((_manifest: DayManifest) => Promise.resolve()),
    findClaimConflict: jest.fn(() => Promise.resolve<string | null>(null)),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      EminiplayerIngestService,
      { provide: EminiplayerService, useValue: eminiplayer },
      { provide: TranscriptService, useValue: transcript },
      { provide: EminiplayerVerifyService, useValue: verify },
      { provide: EminiplayerManifestService, useValue: manifest },
      { provide: STORAGE_BUCKET, useValue: bucket },
    ],
  }).compile();
  return {
    service: moduleRef.get(EminiplayerIngestService),
    eminiplayer,
    transcript,
    verify,
    manifest,
    bucket,
  };
}

describe('EminiplayerIngestService.ingest', () => {
  it('produces, verifies, uploads all three artifacts and commits a manifest', async () => {
    const { service, bucket, verify, manifest, transcript } = await build();
    const result = await service.ingest(DATE);

    expect(result).toEqual({
      date: DATE,
      recapDate: RECAP_DATE,
      staleRecapsRemoved: [],
      manifestPath: MANIFEST_PATH,
      fromManifest: false,
      files: {
        recap: { storagePath: RECAP_PATH, status: 'uploaded' },
        tradePlanMd: { storagePath: TP_MD_PATH, status: 'uploaded' },
        tradePlanPdf: { storagePath: TP_PDF_PATH, status: 'uploaded' },
      },
    });

    expect(bucket.files.get(RECAP_PATH)!.save).toHaveBeenCalledWith(
      expect.stringContaining('# Transcript'),
      { contentType: 'text/markdown' },
    );
    expect(bucket.files.get(TP_PDF_PATH)!.save).toHaveBeenCalledWith(
      expect.any(Buffer),
      { contentType: 'application/pdf' },
    );
    // fetchSegments must get the extracted video ID, never the page's raw
    // embed URL — youtube-transcript chokes on /embed/ URLs with query params
    // (misreported as "Transcript is disabled"; hit on the first live ingest).
    expect(transcript.fetchSegments).toHaveBeenCalledWith('recapVid0001');
    expect(transcript.fetchSegments).toHaveBeenCalledWith('tpVid0000001');
    expect(verify.verifyTranscript).toHaveBeenCalledTimes(2);
    expect(verify.verifyTranscript).toHaveBeenCalledWith(expect.any(String), {
      flavor: 'recap',
      date: RECAP_DATE,
    });
    expect(verify.verifyTranscript).toHaveBeenCalledWith(expect.any(String), {
      flavor: 'tradePlan',
      date: DATE,
    });

    const written = manifest.commit.mock.calls[0][0];
    expect(written.date).toBe(DATE);
    expect(written.sources.recapVideoId).toBe('recapVid0001');
    expect(written.sources.tradePlanVideoId).toBe('tpVid0000001');
    expect(written.files.recap.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(written.files.recap.md5).toMatch(/=$/); // base64
    // evidence recorded, not booleans: titles + verdicts
    expect(written.evidence.recapVideoTitle).toContain('Recap');
    expect(written.evidence.tradePlanVideoTitle).toContain('Trade Plan');
    expect(written.evidence.recapVerdict.docType).toBe('recap');
    expect(written.evidence.tradePlanVerdict.docType).toBe('tradePlan');
  });

  it('manifest short-circuit: committed day + matching recapDate reports all-skipped from the MANIFEST paths', async () => {
    const { service, eminiplayer, transcript } = await build({ committed: committedManifest() });
    const result = await service.ingest(DATE);
    expect(result.recapDate).toBe(RECAP_DATE); // from the manifest
    expect(result.files.recap).toEqual({ storagePath: RECAP_PATH, status: 'skipped' });
    expect(result.files.tradePlanMd.status).toBe('skipped');
    expect(result.files.tradePlanPdf.status).toBe('skipped');
    expect(eminiplayer.findDayEntries).toHaveBeenCalled(); // resolve still runs
    expect(eminiplayer.getYoutubeUrl).not.toHaveBeenCalled();
    expect(transcript.fetchSegments).not.toHaveBeenCalled();
  });

  it('manifest short-circuit: committed recap STALER than the fresh resolution → 422, never silent success', async () => {
    // day committed early with 06/29's recap; the archive now resolves 06/30
    const { service, manifest } = await build({ committed: committedManifest('06292026') });
    const err = await service.ingest(DATE).catch((e) => e);
    expect(err).toBeInstanceOf(IngestValidationError);
    expect(err.message).toContain('06292026');
    expect(err.message).toContain('force');
    expect(manifest.commit).not.toHaveBeenCalled();
  });

  it('unmanifested existing artifacts are reloaded and fully re-verified (skip production, never verification)', async () => {
    const bucket = makeBucket({
      [RECAP_PATH]: plausibleMarkdown('recap'),
      [TP_PDF_PATH]: plausiblePdf(),
    });
    const { service, transcript, verify, manifest } = await build({ bucket });
    const result = await service.ingest(DATE);

    expect(result.files.recap.status).toBe('skipped');
    expect(result.files.tradePlanMd.status).toBe('uploaded');
    expect(result.files.tradePlanPdf.status).toBe('skipped');
    // recap transcription skipped, but its verification still ran
    expect(transcript.fetchSegments).toHaveBeenCalledTimes(1);
    expect(verify.verifyTranscript).toHaveBeenCalledTimes(2);
    expect(manifest.commit).toHaveBeenCalled();
  });

  it('force=true deletes the manifest first and regenerates everything', async () => {
    const bucket = makeBucket({
      [RECAP_PATH]: plausibleMarkdown('recap'),
      [TP_MD_PATH]: plausibleMarkdown('tp'),
      [TP_PDF_PATH]: plausiblePdf(),
    });
    const { service, manifest } = await build({ bucket, committed: committedManifest() });
    const result = await service.ingest(DATE, true);
    expect(manifest.delete).toHaveBeenCalledWith(DATE);
    expect(result.files.recap.status).toBe('uploaded');
    expect(result.files.tradePlanMd.status).toBe('uploaded');
    expect(result.files.tradePlanPdf.status).toBe('uploaded');
  });

  it('removes stale recap files, never the currently-resolved one', async () => {
    // resumed run: both the stale recap AND the current recap are present —
    // the exclusion filter must delete exactly one of them
    const stalePath = `${DIR}/06292026_ES_RECAP.md`;
    const bucket = makeBucket({
      [stalePath]: plausibleMarkdown('stale'),
      [RECAP_PATH]: plausibleMarkdown('recap'),
    });
    const { service, verify } = await build({ bucket });
    const result = await service.ingest(DATE);
    expect(result.staleRecapsRemoved).toEqual([stalePath]);
    expect(bucket.files.get(stalePath)!.delete).toHaveBeenCalled();
    expect(bucket.files.get(RECAP_PATH)!.delete).not.toHaveBeenCalled();
    expect(result.files.recap.status).toBe('skipped'); // reloaded, not re-produced
    expect(verify.verifyTranscript).toHaveBeenCalledTimes(2); // still verified
  });

  it('propagates ArchiveNotFoundError untouched (404 path)', async () => {
    const { service, eminiplayer } = await build();
    eminiplayer.findDayEntries.mockRejectedValue(new ArchiveNotFoundError('no TP entry'));
    await expect(service.ingest(DATE)).rejects.toThrow(ArchiveNotFoundError);
  });

  it('propagates IngestValidationError untouched and never commits (422 path)', async () => {
    const { service, transcript, manifest } = await build();
    // wrong-flavor video title in the recap slot
    transcript.fetchVideoTitle.mockResolvedValue(
      'ES Key Zones and Trade Plan for Wed. 07/01/2026',
    );
    await expect(service.ingest(DATE)).rejects.toThrow(IngestValidationError);
    expect(manifest.commit).not.toHaveBeenCalled();
  });

  it('a failing transcript gate blocks upload and commit', async () => {
    const { service, transcript, manifest, bucket } = await build();
    transcript.fetchSegments.mockResolvedValue([{ text: 'too short', offset: 0 }]);
    await expect(service.ingest(DATE)).rejects.toThrow(IngestValidationError);
    // the file HANDLE exists (the exists-check needs it before the gate runs);
    // what must never have happened is the save
    expect(bucket.files.get(RECAP_PATH)!.save).not.toHaveBeenCalled();
    expect(manifest.commit).not.toHaveBeenCalled();
  });

  it('an unavailable video (oEmbed 4xx) is a 422, not a retryable stage error', async () => {
    const { service, transcript, manifest } = await build();
    transcript.fetchVideoTitle.mockRejectedValue(new VideoUnavailableError('HTTP 404'));
    const err = await service.ingest(DATE).catch((e) => e);
    expect(err).toBeInstanceOf(IngestValidationError);
    expect(err.message).toContain('unavailable');
    expect(manifest.commit).not.toHaveBeenCalled();
  });

  it('an LLM verdict mismatch uploads nothing and never commits', async () => {
    const { service, verify, manifest, bucket } = await build();
    verify.verifyTranscript.mockRejectedValue(new IngestValidationError('llm verification: nope'));
    await expect(service.ingest(DATE)).rejects.toThrow(IngestValidationError);
    // Verification runs BEFORE any upload: a rejected transcript is never written.
    expect(written(bucket)).toEqual([]);
    expect(manifest.commit).not.toHaveBeenCalled();
  });

  it('a rejected trade-plan verdict leaves the already-produced recap unwritten', async () => {
    const { service, verify, bucket } = await build();
    verify.verifyTranscript.mockImplementation((_md: string, expected: { flavor: string }) =>
      expected.flavor === 'tradePlan'
        ? Promise.reject(new IngestValidationError('llm verification: nope'))
        : Promise.resolve({
            docType: 'recap',
            isEsContent: true,
            referencedWeekday: 'none',
            confidence: 'high',
          }),
    );
    await expect(service.ingest(DATE)).rejects.toThrow(IngestValidationError);
    expect(written(bucket)).toEqual([]);
  });

  it('wraps a resolve failure as IngestStageError(resolve, archive)', async () => {
    const { service, eminiplayer } = await build();
    eminiplayer.findDayEntries.mockRejectedValue(new Error('archive listing unreachable'));
    const err = await service.ingest(DATE).catch((e) => e);
    expect(err).toBeInstanceOf(IngestStageError);
    expect(err.stage).toBe('resolve');
    expect(err.artifact).toBe('archive');
  });

  it('wraps an LLM transport failure as IngestStageError(verify, <artifact>)', async () => {
    const { service, verify } = await build();
    verify.verifyTranscript.mockRejectedValueOnce(new Error('api down'));
    const err = await service.ingest(DATE).catch((e) => e);
    expect(err).toBeInstanceOf(IngestStageError);
    expect(err.stage).toBe('verify');
    expect(err.artifact).toBe('recap');
  });

  it('a mid-run failure uploads nothing — the day is all-or-nothing', async () => {
    const { service, eminiplayer, bucket } = await build();
    eminiplayer.getYoutubeUrl
      .mockImplementationOnce(() => Promise.resolve('https://youtu.be/recapVid0001'))
      .mockImplementationOnce(() => Promise.reject(new Error('tp page broke')));
    const err = await service.ingest(DATE).catch((e) => e);
    expect(err).toBeInstanceOf(IngestStageError);
    expect(err.artifact).toBe('tradePlanMd');
    expect(written(bucket)).toEqual([]);
  });

  it('a pdf download failure uploads nothing and never commits', async () => {
    const { service, eminiplayer, bucket, manifest } = await build();
    eminiplayer.downloadTradePlanPdf.mockRejectedValue(new Error('pdf 404'));
    await expect(service.ingest(DATE)).rejects.toThrow(IngestStageError);
    expect(written(bucket)).toEqual([]);
    expect(manifest.commit).not.toHaveBeenCalled();
  });

  it('a commit failure removes every artifact the run uploaded', async () => {
    const { service, manifest, bucket } = await build();
    manifest.commit.mockRejectedValue(
      new IngestValidationError('video tpVid0000001 is already claimed by 06302026/recap'),
    );
    await expect(service.ingest(DATE)).rejects.toThrow(IngestValidationError);
    // Uploads necessarily precede the commit, so cleanup is what restores the
    // invariant: an uncommitted day owns no artifacts.
    expect(written(bucket)).toEqual(ALL_ARTIFACTS);
    expect(deleted(bucket)).toEqual(ALL_ARTIFACTS);
  });

  it('a stale committed recap (422) never deletes the committed day\'s artifacts', async () => {
    // The day IS committed — its files are legitimately there. Cleanup must not
    // reach a failure raised by the committed-day guard.
    const { service, bucket } = await build({ committed: committedManifest('06292026') });
    await expect(service.ingest(DATE)).rejects.toThrow(IngestValidationError);
    expect(deleted(bucket)).toEqual([]);
  });

  it('coalesces concurrent ingests for the same date onto one run', async () => {
    const { service, eminiplayer } = await build();
    const [a, b] = await Promise.all([service.ingest(DATE), service.ingest(DATE)]);
    expect(a).toBe(b);
    expect(eminiplayer.findDayEntries).toHaveBeenCalledTimes(1);
    await service.ingest(DATE);
    expect(eminiplayer.findDayEntries).toHaveBeenCalledTimes(2);
  });

  it('re-asserts the resolved trade-plan date against the requested date (422, no commit)', async () => {
    // The scraper is contracted to return the TP entry FOR the requested date;
    // a selector change that returned the neighbouring day would otherwise
    // commit that day's plan under this date.
    const { service, manifest } = await build({
      entries: { ...ENTRIES, tradePlan: { ...ENTRIES.tradePlan, date: RECAP_DATE } },
    });
    const err = await service.ingest(DATE).catch((e) => e);
    expect(err).toBeInstanceOf(IngestValidationError);
    expect(err.message).toContain(RECAP_DATE);
    expect(manifest.commit).not.toHaveBeenCalled();
  });

  it('a failed run does not poison the date: the next ingest runs again', async () => {
    // The inflight entry must be cleared on REJECTION too. A `.finally` turned
    // into a `.then` would leave the failed promise parked in the map and
    // replay its rejection to every later caller, forever.
    const { service, eminiplayer } = await build();
    eminiplayer.findDayEntries.mockRejectedValueOnce(new Error('archive flaked'));
    await expect(service.ingest(DATE)).rejects.toThrow(IngestStageError);
    await expect(service.ingest(DATE)).resolves.toBeDefined();
    expect(eminiplayer.findDayEntries).toHaveBeenCalledTimes(2);
  });

  it('a reloaded recap that fails its gate blocks the commit (skip production, never verification)', async () => {
    const bucket = makeBucket({ [RECAP_PATH]: 'garbage' });
    const { service, manifest } = await build({ bucket });
    await expect(service.ingest(DATE)).rejects.toThrow(IngestValidationError);
    expect(manifest.commit).not.toHaveBeenCalled();
  });

  it('a reloaded pdf that fails its gate blocks the commit', async () => {
    const bucket = makeBucket({
      [RECAP_PATH]: plausibleMarkdown('recap'),
      [TP_MD_PATH]: plausibleMarkdown('tp'),
      [TP_PDF_PATH]: Buffer.from(`not a pdf at all${' '.repeat(12000)}`),
    });
    const { service, manifest } = await build({ bucket });
    await expect(service.ingest(DATE)).rejects.toThrow(IngestValidationError);
    expect(manifest.commit).not.toHaveBeenCalled();
  });

  it('force is never silently dropped: queued behind an in-flight non-force run, then actually runs', async () => {
    const { service, eminiplayer, manifest } = await build();
    const [normal, forced] = await Promise.all([
      service.ingest(DATE), // non-force run in flight...
      service.ingest(DATE, true), // ...force arrives, must not coalesce away
    ]);
    expect(normal).toBeDefined();
    expect(forced).toBeDefined();
    expect(eminiplayer.findDayEntries).toHaveBeenCalledTimes(2); // both runs happened
    expect(manifest.delete).toHaveBeenCalledWith(DATE); // the forced pass ran force semantics
  });

  it('with resolvedEntries: skips archive resolution and feeds the entries into the pipeline', async () => {
    const { service, eminiplayer, manifest } = await build();
    const result = await service.ingest(DATE, false, ENTRIES);
    expect(eminiplayer.findDayEntries).not.toHaveBeenCalled();
    expect(result.date).toBe(DATE);
    expect(result.recapDate).toBe(RECAP_DATE);
    expect(result.fromManifest).toBe(false);
    expect(manifest.commit).toHaveBeenCalledTimes(1);
  });

  it('reports fromManifest: true exactly on the committed-day short-circuit', async () => {
    const { service } = await build({ committed: committedManifest() });
    const result = await service.ingest(DATE);
    expect(result.fromManifest).toBe(true);
    expect(result.files.recap.status).toBe('skipped');
  });
});

describe('EminiplayerIngestService video-claim pre-check', () => {
  it('probes both resolved video ids before doing any expensive work', async () => {
    const { service, manifest, transcript } = await build();
    await service.ingest(DATE);
    expect(manifest.findClaimConflict).toHaveBeenCalledWith(DATE, [
      { videoId: 'recapVid0001', slot: 'recap' },
      { videoId: 'tpVid0000001', slot: 'tradePlan' },
    ]);
    // Resolution is cheap, transcription is not: the probe must come first.
    expect(manifest.findClaimConflict.mock.invocationCallOrder[0]).toBeLessThan(
      transcript.fetchSegments.mock.invocationCallOrder[0],
    );
  });

  it('a claimed video 422s before transcribing, downloading, or uploading anything', async () => {
    const { service, manifest, transcript, eminiplayer, bucket } = await build();
    manifest.findClaimConflict.mockResolvedValue(
      'video tpVid0000001 is already claimed by 06302026/recap — the same video cannot serve two day groups',
    );

    await expect(service.ingest(DATE)).rejects.toThrow(IngestValidationError);

    expect(transcript.fetchSegments).not.toHaveBeenCalled();
    expect(eminiplayer.downloadTradePlanPdf).not.toHaveBeenCalled();
    expect(written(bucket)).toEqual([]);
    expect(manifest.commit).not.toHaveBeenCalled();
  });

  it('surfaces the probe message verbatim so the failure reads identically either way', async () => {
    const { service, manifest } = await build();
    manifest.findClaimConflict.mockResolvedValue('video X is already claimed by 06302026/recap');
    const err = (await service.ingest(DATE).catch((e: Error) => e)) as Error;
    expect(err.message).toBe('video X is already claimed by 06302026/recap');
  });

  it('a clean probe is advisory only — commit still runs its own transactional claim', async () => {
    const { service, manifest } = await build();
    manifest.commit.mockRejectedValue(new IngestValidationError('raced: claimed after the probe'));
    await expect(service.ingest(DATE)).rejects.toThrow(/raced/);
    expect(manifest.commit).toHaveBeenCalled();
  });
});
