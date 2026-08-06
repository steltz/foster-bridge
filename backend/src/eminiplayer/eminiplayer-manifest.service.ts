import { Inject, Injectable } from '@nestjs/common';
import type { Bucket } from '@google-cloud/storage';
import type { Firestore } from 'firebase-admin/firestore';
import { FIRESTORE, STORAGE_BUCKET } from '../firebase/firebase.constants';
import { IngestValidationError } from './eminiplayer-ingest.errors';
import { manifestPath } from './eminiplayer-validation';
import type { TranscriptVerdict } from './eminiplayer-verify.service';

export interface FileRecord {
  storagePath: string;
  sha256: string;
  /** base64 — comparable against GCS object metadata's `md5Hash`. */
  md5: string;
  bytes: number;
}

export interface DayManifest {
  version: number;
  date: string;
  recapDate: string;
  createdAt: string;
  sources: {
    recapPageUrl: string;
    tradePlanPageUrl: string;
    recapVideoId: string;
    tradePlanVideoId: string;
  };
  files: {
    recap: FileRecord;
    tradePlanMd: FileRecord;
    tradePlanPdf: FileRecord;
  };
  /**
   * Verification evidence, not booleans: a manifest can only exist if every
   * check passed, so what matters for a later-questioned day is WHAT the
   * checks saw — the video titles and the LLM verdicts.
   */
  evidence: {
    recapVideoTitle: string;
    tradePlanVideoTitle: string;
    recapVerdict: TranscriptVerdict;
    tradePlanVerdict: TranscriptVerdict;
  };
}

export const VIDEO_IDS_COLLECTION = 'eminiplayer-video-ids';

/**
 * The manifest is the day group's commit record and the consumers' trust
 * gate: written last, only after every check passed. The Firestore video-id
 * collection guarantees the same YouTube video can never serve two day
 * groups (wrong-entry selection across days shows up here as a conflict).
 * Uncommit (delete) is symmetric with commit: it releases the day's claims
 * before removing the manifest, so a force-rerun that resolves different
 * videos can never leave stale claims 422-blocking a neighboring day.
 */
@Injectable()
export class EminiplayerManifestService {
  constructor(
    @Inject(STORAGE_BUCKET) private readonly bucket: Bucket,
    @Inject(FIRESTORE) private readonly firestore: Firestore,
  ) {}

  path(date: string): string {
    return manifestPath(date);
  }

  async exists(date: string): Promise<boolean> {
    const [exists] = await this.bucket.file(this.path(date)).exists();
    return exists;
  }

  /** Parsed manifest, or null when the day is uncommitted. */
  async read(date: string): Promise<DayManifest | null> {
    const file = this.bucket.file(this.path(date));
    const [exists] = await file.exists();
    if (!exists) return null;
    const [buf] = await file.download();
    return JSON.parse(buf.toString('utf8')) as DayManifest;
  }

  /**
   * Uncommit a day (force-regeneration) — artifacts stay, trust is revoked,
   * and the day's video-id claims are released FIRST so they can't outlive
   * the manifest that justified them.
   */
  async delete(date: string): Promise<void> {
    const manifest = await this.read(date).catch(() => null); // unreadable: still remove; audit flags orphans
    if (manifest) {
      await this.release(manifest.sources.recapVideoId, date);
      await this.release(manifest.sources.tradePlanVideoId, date);
    }
    await this.bucket.file(this.path(date)).delete({ ignoreNotFound: true });
  }

  /** Claims both video ids, then writes the manifest — the LAST step of a run. */
  async commit(manifest: DayManifest): Promise<void> {
    await this.claim(manifest.sources.recapVideoId, manifest.date, 'recap');
    await this.claim(manifest.sources.tradePlanVideoId, manifest.date, 'tradePlan');
    await this.bucket
      .file(this.path(manifest.date))
      .save(JSON.stringify(manifest, null, 2), { contentType: 'application/json' });
  }

  private async claim(videoId: string, date: string, slot: 'recap' | 'tradePlan'): Promise<void> {
    const ref = this.firestore.collection(VIDEO_IDS_COLLECTION).doc(videoId);
    await this.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) {
        const owner = snap.data() as { date: string; slot: string };
        if (owner.date === date && owner.slot === slot) return; // idempotent re-claim
        throw new IngestValidationError(
          `video ${videoId} is already claimed by ${owner.date}/${owner.slot} — the same video cannot serve two day groups`,
        );
      }
      tx.set(ref, { date, slot, claimedAt: new Date().toISOString() });
    });
  }

  /** Deletes the claim only when this date owns it — never a foreign claim. */
  private async release(videoId: string, date: string): Promise<void> {
    const ref = this.firestore.collection(VIDEO_IDS_COLLECTION).doc(videoId);
    await this.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists && (snap.data() as { date: string }).date === date) {
        tx.delete(ref);
      }
    });
  }
}
