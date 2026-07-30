import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { STORAGE_BUCKET } from '../firebase/firebase.constants';
import { LLM_PROVIDER } from '../llm/llm.constants';
import { LlmProvider } from '../llm/llm.provider';
import { BenchmarkRepository, DayArtifactDoc, DayArtifactKind } from './benchmark.repository';

// The GCS-backed Bucket surface this service uses (kept minimal so a fake bucket
// satisfies it in tests). `download()` returns GCS's [Buffer] tuple.
export interface StorageBucketLike {
  file(path: string): {
    save(buf: Buffer): Promise<unknown>;
    exists(): Promise<[boolean]>;
    download(): Promise<[Buffer]>;
  };
}

export interface PdfArtifact {
  gcsPath: string;
  providerFileId: string;
  contentHash: string;
}

@Injectable()
export class DayArtifactsService {
  private readonly logger = new Logger(DayArtifactsService.name);

  constructor(
    @Inject(STORAGE_BUCKET) private readonly bucket: StorageBucketLike,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly repo: BenchmarkRepository,
    private readonly config: ConfigService,
  ) {}

  private hash(bytes: Buffer | string): string {
    return createHash('sha256').update(bytes).digest('hex');
  }

  /** The provider LLM_PROVIDER currently resolves to (mirrors LlmModule's default). */
  private get activeProvider(): string {
    return this.config.get<string>('llm.provider') ?? 'anthropic';
  }

  /**
   * The stored file id, but ONLY if the active provider can actually use it.
   *
   * A file id is provider-scoped: Anthropic's `file_…` ids mean nothing to
   * Moonshot (whose ids are synthetic `moonshot-extract:<hash>` handles into its
   * extract store) and vice versa. Handing the wrong provider a foreign id fails
   * at request-build time for every cell of the day, so the reconciler writes
   * nothing and the next run re-submits identically — a permanent wedge, because
   * the re-upload path below only fires on a MISSING id. Treating a foreign id as
   * missing routes it into that same re-upload path, which self-heals on the
   * first run after a provider switch.
   *
   * Legacy inference, deliberately minimal: a doc with no `fileProvider` predates
   * this field, and every such doc was written while Anthropic was the only
   * provider (this field ships with the Moonshot provider itself), so an untagged
   * id is an Anthropic id.
   */
  private usableFileId(doc: DayArtifactDoc): string | undefined {
    const fileId = doc.providerFileId ?? doc.anthropicFileId;
    if (!fileId) return undefined;
    const storedProvider = doc.fileProvider ?? 'anthropic';
    if (storedProvider === this.activeProvider) return fileId;
    // The old provider's id is DISCARDED rather than kept alongside the new one:
    // switching back re-uploads from the GCS origin, which for Moonshot is
    // content-hash idempotent (same id, no new remote file) and for Anthropic
    // costs exactly one re-upload per day. Keeping a per-provider id map would
    // avoid that, at the price of a schema every consumer has to understand.
    this.logger.log(`Day artifact file id was minted by "${storedProvider}", active provider is "${this.activeProvider}" — re-uploading`);
    return undefined;
  }

  /**
   * Firebase Storage is the durable origin; the provider Files copy is the
   * serving copy. When the stored content hash matches and the file_id is live,
   * reuse it. When the hash matches but the file_id is gone (provider GC'd it),
   * re-upload from the GCS origin — never from the passed bytes / a repo
   * checkout. Only genuinely new/changed content writes GCS.
   */
  async ensurePdf(day: string, prefix: string, bytes: Buffer): Promise<PdfArtifact> {
    const contentHash = this.hash(bytes);
    const existing = await this.repo.getDayArtifact(day, 'pdfFile');
    if (existing && existing.contentHash === contentHash) {
      const fileId = this.usableFileId(existing);
      if (fileId) {
        return { gcsPath: existing.gcsPath, providerFileId: fileId, contentHash };
      }
      const providerFileId = await this.reuploadFromGcs(existing.gcsPath);
      await this.repo.saveDayArtifact(day, 'pdfFile', {
        ...existing,
        providerFileId,
        fileProvider: this.activeProvider,
        uploadedAt: new Date().toISOString(),
      });
      return { gcsPath: existing.gcsPath, providerFileId, contentHash };
    }
    const gcsPath = `benchmark/es/${day}/${prefix}_ES_TP.pdf`;
    await this.bucket.file(gcsPath).save(bytes);
    const providerFileId = await this.llm.uploadFile(bytes, `${prefix}_ES_TP.pdf`, 'application/pdf');
    await this.repo.saveDayArtifact(day, 'pdfFile', {
      contentHash,
      gcsPath,
      providerFileId,
      fileProvider: this.activeProvider,
      uploadedAt: new Date().toISOString(),
    });
    return { gcsPath, providerFileId, contentHash };
  }

  /**
   * A LIVE provider file_id for a day's PDF, usable by the ACTIVE provider.
   * Returns the stored id when present and provider-matched; otherwise re-uploads
   * from the GCS copy (never repo bytes) and persists it. Used by the cache warmer
   * and seven-keys, both of which go through here rather than reading the artifact
   * doc themselves, so this is the single place the provider guard has to live.
   */
  async ensureFileId(day: string): Promise<string> {
    const existing = await this.repo.getDayArtifact(day, 'pdfFile');
    if (!existing) throw new Error(`No pdfFile artifact recorded for day ${day}`);
    const fileId = this.usableFileId(existing);
    if (fileId) return fileId;
    const providerFileId = await this.reuploadFromGcs(existing.gcsPath);
    await this.repo.saveDayArtifact(day, 'pdfFile', {
      ...existing,
      providerFileId,
      fileProvider: this.activeProvider,
      uploadedAt: new Date().toISOString(),
    });
    return providerFileId;
  }

  private async reuploadFromGcs(gcsPath: string): Promise<string> {
    const [buf] = await this.bucket.file(gcsPath).download();
    const filename = gcsPath.split('/').pop() as string;
    return this.llm.uploadFile(buf, filename, 'application/pdf');
  }

  /** Mirrors a small text doc (TP / RECAP transcript) to GCS + Firestore. */
  async ensureTranscript(day: string, kind: DayArtifactKind, filename: string, text: string): Promise<void> {
    const contentHash = this.hash(text);
    const existing = await this.repo.getDayArtifact(day, kind);
    if (existing && existing.contentHash === contentHash) return;
    const gcsPath = `benchmark/es/${day}/${filename}`;
    await this.bucket.file(gcsPath).save(Buffer.from(text, 'utf8'));
    await this.repo.saveDayArtifact(day, kind, {
      contentHash,
      gcsPath,
      content: text,
      uploadedAt: new Date().toISOString(),
    });
  }
}
