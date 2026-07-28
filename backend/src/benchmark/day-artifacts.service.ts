import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { STORAGE_BUCKET } from '../firebase/firebase.constants';
import { AnthropicLlmProvider } from '../anthropic/anthropic.service';
import { BenchmarkRepository, DayArtifactKind } from './benchmark.repository';

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
  anthropicFileId: string;
  contentHash: string;
}

@Injectable()
export class DayArtifactsService {
  constructor(
    @Inject(STORAGE_BUCKET) private readonly bucket: StorageBucketLike,
    private readonly anthropic: AnthropicLlmProvider,
    private readonly repo: BenchmarkRepository,
  ) {}

  private hash(bytes: Buffer | string): string {
    return createHash('sha256').update(bytes).digest('hex');
  }

  /**
   * Firebase Storage is the durable origin; the Anthropic Files copy is the
   * serving copy. When the stored content hash matches and the file_id is live,
   * reuse it. When the hash matches but the file_id is gone (Anthropic GC'd it),
   * re-upload from the GCS origin — never from the passed bytes / a repo
   * checkout. Only genuinely new/changed content writes GCS.
   */
  async ensurePdf(day: string, prefix: string, bytes: Buffer): Promise<PdfArtifact> {
    const contentHash = this.hash(bytes);
    const existing = await this.repo.getDayArtifact(day, 'pdfFile');
    if (existing && existing.contentHash === contentHash) {
      if (existing.anthropicFileId) {
        return { gcsPath: existing.gcsPath, anthropicFileId: existing.anthropicFileId, contentHash };
      }
      const anthropicFileId = await this.reuploadFromGcs(existing.gcsPath);
      await this.repo.saveDayArtifact(day, 'pdfFile', {
        ...existing,
        anthropicFileId,
        uploadedAt: new Date().toISOString(),
      });
      return { gcsPath: existing.gcsPath, anthropicFileId, contentHash };
    }
    const gcsPath = `benchmark/es/${day}/${prefix}_ES_TP.pdf`;
    await this.bucket.file(gcsPath).save(bytes);
    const anthropicFileId = await this.anthropic.uploadFile(bytes, `${prefix}_ES_TP.pdf`, 'application/pdf');
    await this.repo.saveDayArtifact(day, 'pdfFile', {
      contentHash,
      gcsPath,
      anthropicFileId,
      uploadedAt: new Date().toISOString(),
    });
    return { gcsPath, anthropicFileId, contentHash };
  }

  /**
   * A LIVE Anthropic file_id for a day's PDF. Returns the stored id when present;
   * otherwise re-uploads from the GCS copy (never repo bytes) and persists it.
   * Used by the cache warmer to keep long-running batches serviceable.
   */
  async ensureFileId(day: string): Promise<string> {
    const existing = await this.repo.getDayArtifact(day, 'pdfFile');
    if (!existing) throw new Error(`No pdfFile artifact recorded for day ${day}`);
    if (existing.anthropicFileId) return existing.anthropicFileId;
    const anthropicFileId = await this.reuploadFromGcs(existing.gcsPath);
    await this.repo.saveDayArtifact(day, 'pdfFile', {
      ...existing,
      anthropicFileId,
      uploadedAt: new Date().toISOString(),
    });
    return anthropicFileId;
  }

  private async reuploadFromGcs(gcsPath: string): Promise<string> {
    const [buf] = await this.bucket.file(gcsPath).download();
    const filename = gcsPath.split('/').pop() as string;
    return this.anthropic.uploadFile(buf, filename, 'application/pdf');
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
