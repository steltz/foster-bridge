import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Bucket } from '@google-cloud/storage';
import { STORAGE_BUCKET } from '../firebase/firebase.constants';
import {
  TranscriptService,
  VideoUnavailableError,
  transcriptToMarkdown,
} from '../transcript/transcript.service';
import { EminiplayerService } from './eminiplayer.service';
import {
  ArchiveEntry,
  ArchiveNotFoundError,
  INGEST_PIPELINE_VERSION,
} from './eminiplayer.constants';
import { IngestStageError, IngestValidationError } from './eminiplayer-ingest.errors';
import {
  assertDayInvariants,
  assertPdfBuffer,
  assertTranscriptMarkdown,
  assertVideoTitle,
  dayPaths,
  extractYoutubeVideoId,
  md5Base64,
  sha256Hex,
  VideoFlavor,
} from './eminiplayer-validation';
import { EminiplayerVerifyService, TranscriptVerdict } from './eminiplayer-verify.service';
import {
  DayManifest,
  EminiplayerManifestService,
  FileRecord,
} from './eminiplayer-manifest.service';

export interface IngestFileReport {
  storagePath: string;
  status: 'uploaded' | 'skipped';
}

export interface IngestResult {
  date: string;
  recapDate: string;
  /** Old *_ES_RECAP.md objects deleted because their date no longer matches. */
  staleRecapsRemoved: string[];
  manifestPath: string;
  files: {
    recap: IngestFileReport;
    tradePlanMd: IngestFileReport;
    tradePlanPdf: IngestFileReport;
  };
}

type Artifact = 'recap' | 'tradePlanMd' | 'tradePlanPdf';
type Stage = 'plan' | 'resolve' | 'transcribe' | 'download' | 'verify' | 'upload' | 'commit';

interface ProducedTranscript {
  report: IngestFileReport;
  videoId: string;
  title: string;
  verdict: TranscriptVerdict;
  record: FileRecord;
}

/**
 * Orchestrates one day's document group: resolve archive entries, gate and
 * cross-check everything (see the spec's verification decision), transcribe
 * the two videos, download the TP pdf, upload each artifact as soon as it is
 * produced, LLM-verify both transcripts, and only then commit the day via its
 * manifest. Skip skips production, never verification — a resumed run reloads
 * existing artifacts and re-verifies them, because the previous run may have
 * died between upload and verify. Concurrent requests for the same date
 * coalesce onto one in-flight run.
 */
@Injectable()
export class EminiplayerIngestService {
  private readonly logger = new Logger(EminiplayerIngestService.name);
  private readonly inflight = new Map<string, { force: boolean; run: Promise<IngestResult> }>();

  constructor(
    private readonly eminiplayer: EminiplayerService,
    private readonly transcript: TranscriptService,
    private readonly verify: EminiplayerVerifyService,
    private readonly manifest: EminiplayerManifestService,
    @Inject(STORAGE_BUCKET) private readonly bucket: Bucket,
  ) {}

  async ingest(date: string, force = false): Promise<IngestResult> {
    const existing = this.inflight.get(date);
    if (existing) {
      // Coalesce same-flag calls (and non-force onto anything). A force call
      // finding a NON-force run must not be silently dropped: wait the
      // in-flight run out, then run the forced regeneration.
      if (!force || existing.force) return existing.run;
      await existing.run.catch(() => undefined);
      return this.ingest(date, true);
    }
    const run = this.run(date, force).finally(() => this.inflight.delete(date));
    this.inflight.set(date, { force, run });
    return run;
  }

  private async run(date: string, force: boolean): Promise<IngestResult> {
    // Resolution always runs: the recap filename embeds the recap date,
    // which only the archive listing knows.
    const entries = await this.stage('resolve', 'archive', () =>
      this.eminiplayer.findDayEntries(date),
    );
    const recapDate = entries.recap.date;
    assertDayInvariants(date, recapDate);

    const paths = dayPaths(date, recapDate);

    if (force) {
      // Revoke trust before touching files (releases the day's video-id
      // claims too — see EminiplayerManifestService.delete). The day is
      // uncommitted while regeneration runs.
      await this.stage('plan', 'archive', () => this.manifest.delete(date));
    } else {
      const committed = await this.stage('plan', 'archive', () => this.manifest.read(date));
      if (committed) {
        // Committed day. The response must come from the MANIFEST (the fresh
        // resolve may reference paths that don't exist in the bucket), and a
        // recapDate drift means the day was committed before the real recap
        // was posted — frozen wrong data unless we refuse here.
        if (committed.recapDate !== recapDate) {
          throw new IngestValidationError(
            `committed manifest for ${date} references recap ${committed.recapDate} but the archive now resolves ${recapDate} — the committed recap is stale; rerun with force=true to regenerate`,
          );
        }
        return {
          date,
          recapDate: committed.recapDate,
          staleRecapsRemoved: [],
          manifestPath: paths.manifest,
          files: {
            recap: { storagePath: committed.files.recap.storagePath, status: 'skipped' },
            tradePlanMd: { storagePath: committed.files.tradePlanMd.storagePath, status: 'skipped' },
            tradePlanPdf: { storagePath: committed.files.tradePlanPdf.storagePath, status: 'skipped' },
          },
        };
      }
    }

    const staleRecapsRemoved = await this.removeStaleRecaps(paths.dir, paths.recap);

    const recap = await this.produceTranscript('recap', paths.recap, force, entries.recap, recapDate);
    const tradePlanMd = await this.produceTranscript(
      'tradePlanMd',
      paths.tradePlanMd,
      force,
      entries.tradePlan,
      date,
    );
    const tradePlanPdf = await this.producePdf(paths.tradePlanPdf, force, entries.tradePlan);

    const dayManifest: DayManifest = {
      version: INGEST_PIPELINE_VERSION,
      date,
      recapDate,
      createdAt: new Date().toISOString(),
      sources: {
        recapPageUrl: entries.recap.pageUrl,
        tradePlanPageUrl: entries.tradePlan.pageUrl,
        recapVideoId: recap.videoId,
        tradePlanVideoId: tradePlanMd.videoId,
      },
      files: {
        recap: recap.record,
        tradePlanMd: tradePlanMd.record,
        tradePlanPdf: tradePlanPdf.record,
      },
      evidence: {
        recapVideoTitle: recap.title,
        tradePlanVideoTitle: tradePlanMd.title,
        recapVerdict: recap.verdict,
        tradePlanVerdict: tradePlanMd.verdict,
      },
    };
    await this.stage('commit', 'archive', () => this.manifest.commit(dayManifest));
    this.logger.log(`committed ${paths.manifest}`);

    return {
      date,
      recapDate,
      staleRecapsRemoved,
      manifestPath: paths.manifest,
      files: {
        recap: recap.report,
        tradePlanMd: tradePlanMd.report,
        tradePlanPdf: tradePlanPdf.report,
      },
    };
  }

  private flavorOf(artifact: Artifact): VideoFlavor {
    return artifact === 'recap' ? 'recap' : 'tradePlan';
  }

  private async produceTranscript(
    artifact: 'recap' | 'tradePlanMd',
    storagePath: string,
    force: boolean,
    entry: ArchiveEntry,
    expectedDate: string,
  ): Promise<ProducedTranscript> {
    const flavor = this.flavorOf(artifact);
    const youtubeUrl = await this.stage('resolve', artifact, () =>
      this.eminiplayer.getYoutubeUrl(entry.pageUrl),
    );
    const videoId = extractYoutubeVideoId(youtubeUrl);
    let title: string;
    try {
      title = await this.transcript.fetchVideoTitle(videoId);
    } catch (err) {
      // A deleted/private video is a permanent data condition (422, human
      // must look), not a retryable transport failure.
      if (err instanceof VideoUnavailableError) {
        throw new IngestValidationError(
          `${artifact} video ${videoId} is unavailable on YouTube: ${err.message}`,
        );
      }
      throw new IngestStageError('verify', artifact, err as Error);
    }
    assertVideoTitle(title, expectedDate, flavor);

    const file = this.bucket.file(storagePath);
    let markdown: string;
    let status: 'uploaded' | 'skipped';
    const [exists] = force
      ? [false]
      : await this.stage('plan', artifact, () => file.exists());
    if (exists) {
      const [buf] = await this.stage('plan', artifact, () => file.download());
      markdown = buf.toString('utf8');
      assertTranscriptMarkdown(markdown, artifact);
      status = 'skipped';
    } else {
      const segments = await this.stage('transcribe', artifact, () =>
        this.transcript.fetchSegments(youtubeUrl),
      );
      markdown = transcriptToMarkdown(segments);
      assertTranscriptMarkdown(markdown, artifact);
      await this.stage('upload', artifact, () =>
        file.save(markdown, { contentType: 'text/markdown' }),
      );
      this.logger.log(`uploaded ${storagePath}`);
      status = 'uploaded';
    }
    const verdict = await this.stage('verify', artifact, () =>
      this.verify.verifyTranscript(markdown, { flavor, date: expectedDate }),
    );
    return {
      report: { storagePath, status },
      videoId,
      title,
      verdict,
      record: {
        storagePath,
        sha256: sha256Hex(markdown),
        md5: md5Base64(markdown),
        bytes: Buffer.byteLength(markdown),
      },
    };
  }

  private async producePdf(
    storagePath: string,
    force: boolean,
    entry: ArchiveEntry,
  ): Promise<{ report: IngestFileReport; record: FileRecord }> {
    const file = this.bucket.file(storagePath);
    let buf: Buffer;
    let status: 'uploaded' | 'skipped';
    const [exists] = force
      ? [false]
      : await this.stage('plan', 'tradePlanPdf', () => file.exists());
    if (exists) {
      [buf] = await this.stage('plan', 'tradePlanPdf', () => file.download());
      assertPdfBuffer(buf, 'tradePlanPdf');
      status = 'skipped';
    } else {
      buf = await this.stage('download', 'tradePlanPdf', () =>
        this.eminiplayer.downloadTradePlanPdf(entry.pageUrl),
      );
      assertPdfBuffer(buf, 'tradePlanPdf');
      await this.stage('upload', 'tradePlanPdf', () =>
        file.save(buf, { contentType: 'application/pdf' }),
      );
      this.logger.log(`uploaded ${storagePath}`);
      status = 'uploaded';
    }
    return {
      report: { storagePath, status },
      record: { storagePath, sha256: sha256Hex(buf), md5: md5Base64(buf), bytes: buf.length },
    };
  }

  /**
   * The recap filename embeds a date resolved fresh from the archive each
   * run. A run that happened before the previous session's recap was posted
   * resolved an older recap; its file is now stale, and fill-and-skip alone
   * would let a retry add a second recap beside it. Delete any *_ES_RECAP.md
   * in the day folder that isn't the currently-resolved path, so a day group
   * can never accumulate two recaps.
   */
  private async removeStaleRecaps(dir: string, recapPath: string): Promise<string[]> {
    return this.stage('plan', 'recap', async () => {
      const [files] = await this.bucket.getFiles({ prefix: `${dir}/` });
      const stale = files.filter(
        (f) => f.name.endsWith('_ES_RECAP.md') && f.name !== recapPath,
      );
      for (const f of stale) {
        this.logger.warn(`removing stale recap ${f.name}`);
        await f.delete();
      }
      return stale.map((f) => f.name);
    });
  }

  /** Wrap stage failures; ArchiveNotFoundError / IngestValidationError pass through. */
  private async stage<T>(
    stage: Stage,
    artifact: 'archive' | Artifact,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ArchiveNotFoundError || err instanceof IngestValidationError) throw err;
      throw new IngestStageError(stage, artifact, err as Error);
    }
  }
}
