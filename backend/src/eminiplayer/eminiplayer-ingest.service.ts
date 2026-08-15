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
  DayEntries,
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
  /**
   * True only when a committed manifest answered the whole day (the
   * short-circuit) — the bulk backfill keys its skipped-count and its
   * politeness delay on this, NOT on per-file statuses, because a
   * fill-and-skip day (artifacts existed, manifest didn't) reports all files
   * 'skipped' while still doing page loads, re-verification, and a commit.
   */
  fromManifest: boolean;
  files: {
    recap: IngestFileReport;
    tradePlanMd: IngestFileReport;
    tradePlanPdf: IngestFileReport;
  };
}

type Artifact = 'recap' | 'tradePlanMd' | 'tradePlanPdf';
type Stage = 'plan' | 'resolve' | 'transcribe' | 'download' | 'verify' | 'upload' | 'commit';

interface ProducedTranscript {
  artifact: 'recap' | 'tradePlanMd';
  storagePath: string;
  markdown: string;
  videoId: string;
  title: string;
  verdict: TranscriptVerdict;
  /** Reloaded from the bucket rather than transcribed — already at rest, nothing to upload. */
  existed: boolean;
  record: FileRecord;
}

interface ProducedPdf {
  storagePath: string;
  buf: Buffer;
  existed: boolean;
  record: FileRecord;
}

/**
 * Orchestrates one day's document group: resolve archive entries, gate and
 * cross-check everything (see the spec's verification decision), transcribe
 * the two videos, download the TP pdf, LLM-verify both transcripts, and only
 * once every artifact is produced AND verified upload them and commit the day
 * via its manifest.
 *
 * The day is ALL-OR-NOTHING: nothing is uploaded until everything has passed,
 * and any failure after the first upload discards the day's artifacts. The
 * invariant consumers rely on is `artifacts exist <=> the day is committed` —
 * a half-written day would otherwise be indistinguishable from a good one to
 * anything that lists the folder rather than reading the manifest.
 *
 * Skip skips production, never verification — a resumed run reloads existing
 * artifacts and re-verifies them, because the previous run may have died
 * between upload and commit. Concurrent requests for the same date coalesce
 * onto one in-flight run.
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

  async ingest(date: string, force = false, resolvedEntries?: DayEntries): Promise<IngestResult> {
    const existing = this.inflight.get(date);
    if (existing) {
      // Coalesce same-flag calls (and non-force onto anything). A force call
      // finding a NON-force run must not be silently dropped: wait the
      // in-flight run out, then run the forced regeneration.
      if (!force || existing.force) return existing.run;
      await existing.run.catch(() => undefined);
      return this.ingest(date, true, resolvedEntries);
    }
    const run = this.run(date, force, resolvedEntries).finally(() => this.inflight.delete(date));
    this.inflight.set(date, { force, run });
    return run;
  }

  private async run(date: string, force: boolean, resolvedEntries?: DayEntries): Promise<IngestResult> {
    // Resolution always runs unless the caller (bulk backfill) already derived
    // the entries from its own single listing scrape — the recap filename
    // embeds the recap date, which only the archive listing knows. Contract on
    // resolvedEntries: derived from a scrape no older than RECAP_LOOKBACK_DAYS
    // before `date` (the backfill resolves frontier days fresh for this reason).
    const entries =
      resolvedEntries ??
      (await this.stage('resolve', 'archive', () => this.eminiplayer.findDayEntries(date)));
    const recapDate = entries.recap.date;
    assertDayInvariants(date, recapDate);
    // Consumer-side guard on the scraper contract: the trade-plan entry is the
    // one thing resolution is asked for BY date, and every path below (paths,
    // title gate, verification date) assumes it came back for `date`. A
    // selector change that returned the neighbouring day would otherwise
    // commit that day's plan under this date.
    if (entries.tradePlan.date !== date) {
      throw new IngestValidationError(
        `archive returned a trade-plan entry dated ${entries.tradePlan.date} for ${date}`,
      );
    }

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
          fromManifest: true,
          files: {
            recap: { storagePath: committed.files.recap.storagePath, status: 'skipped' },
            tradePlanMd: { storagePath: committed.files.tradePlanMd.storagePath, status: 'skipped' },
            tradePlanPdf: { storagePath: committed.files.tradePlanPdf.storagePath, status: 'skipped' },
          },
        };
      }
    }

    // Past this point the day is known-uncommitted, so it owns the
    // all-or-nothing invariant: any failure must leave it with no artifacts.
    // The committed-day guards above must stay OUTSIDE this try — their 422
    // describes a day whose files are legitimately at rest.
    try {
      return await this.produceUploadCommit(date, recapDate, paths, force, entries);
    } catch (err) {
      await this.discardArtifacts(paths);
      throw err;
    }
  }

  private async produceUploadCommit(
    date: string,
    recapDate: string,
    paths: ReturnType<typeof dayPaths>,
    force: boolean,
    entries: DayEntries,
  ): Promise<IngestResult> {
    const staleRecapsRemoved = await this.removeStaleRecaps(paths.dir, paths.recap);

    // Produce AND verify everything before a single byte is uploaded. Each
    // artifact verifies as soon as it is produced so a bad recap costs no pdf
    // download, but no upload happens until all three have passed.
    const recap = await this.produceTranscript('recap', paths.recap, force, entries.recap, recapDate);
    const tradePlanMd = await this.produceTranscript(
      'tradePlanMd',
      paths.tradePlanMd,
      force,
      entries.tradePlan,
      date,
    );
    const tradePlanPdf = await this.producePdf(paths.tradePlanPdf, force, entries.tradePlan);

    const recapReport = await this.uploadTranscript(recap);
    const tradePlanMdReport = await this.uploadTranscript(tradePlanMd);
    const tradePlanPdfReport = await this.uploadPdf(tradePlanPdf);

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
      fromManifest: false,
      files: {
        recap: recapReport,
        tradePlanMd: tradePlanMdReport,
        tradePlanPdf: tradePlanPdfReport,
      },
    };
  }

  /**
   * Best-effort removal of the day's three artifacts, restoring the
   * all-or-nothing invariant after a failed run. Never throws: it runs inside a
   * catch and must not mask the failure that brought us here. A process killed
   * mid-run still orphans files — that residue is what the prune endpoint
   * sweeps.
   */
  private async discardArtifacts(paths: ReturnType<typeof dayPaths>): Promise<void> {
    for (const storagePath of [paths.recap, paths.tradePlanMd, paths.tradePlanPdf]) {
      try {
        await this.bucket.file(storagePath).delete({ ignoreNotFound: true });
      } catch (err) {
        this.logger.warn(`failed to discard ${storagePath}: ${(err as Error).message}`);
      }
    }
  }

  private async uploadTranscript(produced: ProducedTranscript): Promise<IngestFileReport> {
    const { storagePath, artifact } = produced;
    if (produced.existed) return { storagePath, status: 'skipped' };
    await this.stage('upload', artifact, () =>
      this.bucket.file(storagePath).save(produced.markdown, { contentType: 'text/markdown' }),
    );
    this.logger.log(`uploaded ${storagePath}`);
    return { storagePath, status: 'uploaded' };
  }

  private async uploadPdf(produced: ProducedPdf): Promise<IngestFileReport> {
    const { storagePath } = produced;
    if (produced.existed) return { storagePath, status: 'skipped' };
    await this.stage('upload', 'tradePlanPdf', () =>
      this.bucket.file(storagePath).save(produced.buf, { contentType: 'application/pdf' }),
    );
    this.logger.log(`uploaded ${storagePath}`);
    return { storagePath, status: 'uploaded' };
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
    const [exists] = force
      ? [false]
      : await this.stage('plan', artifact, () => file.exists());
    if (exists) {
      const [buf] = await this.stage('plan', artifact, () => file.download());
      markdown = buf.toString('utf8');
      assertTranscriptMarkdown(markdown, artifact);
    } else {
      // Pass the extracted ID, not the page's raw embed URL — youtube-transcript
      // cannot parse /embed/ URLs with query params and misreports them as
      // "Transcript is disabled" (hit on the first live ingest).
      const segments = await this.stage('transcribe', artifact, () =>
        this.transcript.fetchSegments(videoId),
      );
      markdown = transcriptToMarkdown(segments);
      assertTranscriptMarkdown(markdown, artifact);
    }
    const verdict = await this.stage('verify', artifact, () =>
      this.verify.verifyTranscript(markdown, { flavor, date: expectedDate }),
    );
    return {
      artifact,
      storagePath,
      markdown,
      videoId,
      title,
      verdict,
      existed: exists,
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
  ): Promise<ProducedPdf> {
    const file = this.bucket.file(storagePath);
    let buf: Buffer;
    const [exists] = force
      ? [false]
      : await this.stage('plan', 'tradePlanPdf', () => file.exists());
    if (exists) {
      [buf] = await this.stage('plan', 'tradePlanPdf', () => file.download());
      assertPdfBuffer(buf, 'tradePlanPdf');
    } else {
      buf = await this.stage('download', 'tradePlanPdf', () =>
        this.eminiplayer.downloadTradePlanPdf(entry.pageUrl),
      );
      assertPdfBuffer(buf, 'tradePlanPdf');
    }
    return {
      storagePath,
      buf,
      existed: exists,
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
        // Listed-then-vanished (a concurrent run deleted it first) is the goal
        // already achieved, not a 502.
        await f.delete({ ignoreNotFound: true });
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
