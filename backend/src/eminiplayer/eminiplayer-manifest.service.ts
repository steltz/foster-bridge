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
    // Unreadable OR structurally broken: still remove the manifest, because a
    // day that cannot be uncommitted cannot be force-rerun. Ids we can't read
    // are left claimed for the audit to flag as orphans — the file removal is
    // never held hostage to a malformed `sources`.
    const manifest = await this.read(date).catch(() => null);
    const videoIds = [manifest?.sources?.recapVideoId, manifest?.sources?.tradePlanVideoId].filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );
    if (videoIds.length > 0) await this.release(videoIds, date);
    await this.bucket.file(this.path(date)).delete({ ignoreNotFound: true });
  }

  /** Claims both video ids, then writes the manifest — the LAST step of a run. */
  async commit(manifest: DayManifest): Promise<void> {
    const { recapVideoId, tradePlanVideoId } = manifest.sources;
    // Checked before the transaction: inside one, both slots would target the
    // same document — the second write would silently win, and the conflict
    // check would report the day as conflicting with itself.
    if (recapVideoId === tradePlanVideoId) {
      throw new IngestValidationError(
        `recap and trade-plan videos resolve to the same id ${recapVideoId} — a single video cannot serve both slots`,
      );
    }
    await this.claim(manifest.date, [
      { videoId: recapVideoId, slot: 'recap' },
      { videoId: tradePlanVideoId, slot: 'tradePlan' },
    ]);
    await this.bucket
      .file(this.path(manifest.date))
      .save(JSON.stringify(manifest, null, 2), { contentType: 'application/json' });
  }

  /**
   * Claims every id in ONE transaction: a conflict on the second id must not
   * leave the first one claimed, because `delete` reads the ids to release
   * FROM the manifest — and on a failed commit no manifest exists, so a
   * half-written claim would be unreleasable by any automated path and would
   * 422 the day that video really belongs to, forever.
   */
  private async claim(
    date: string,
    entries: ReadonlyArray<{ videoId: string; slot: 'recap' | 'tradePlan' }>,
  ): Promise<void> {
    const collection = this.firestore.collection(VIDEO_IDS_COLLECTION);
    const refs = entries.map((entry) => ({ ...entry, ref: collection.doc(entry.videoId) }));
    await this.firestore.runTransaction(async (tx) => {
      // Firestore requires ALL reads before ANY write, so the snapshots and
      // the conflict checks both complete before the first `tx.set`.
      const snaps = await Promise.all(refs.map(({ ref }) => tx.get(ref)));
      const toWrite = refs.filter(({ videoId, slot }, i) => {
        const snap = snaps[i];
        if (!snap.exists) return true;
        const owner = snap.data() as { date: string; slot: string };
        if (owner.date === date && owner.slot === slot) return false; // idempotent re-claim
        throw new IngestValidationError(
          `video ${videoId} is already claimed by ${owner.date}/${owner.slot} — the same video cannot serve two day groups`,
        );
      });
      const claimedAt = new Date().toISOString();
      for (const { ref, slot } of toWrite) tx.set(ref, { date, slot, claimedAt });
    });
  }

  /**
   * Releases the day's claims in ONE transaction (reads first, then deletes),
   * so an uncommit can never half-release. Deletes a claim only when this
   * date owns it — never a foreign day's claim.
   */
  private async release(videoIds: readonly string[], date: string): Promise<void> {
    const collection = this.firestore.collection(VIDEO_IDS_COLLECTION);
    const refs = [...new Set(videoIds)].map((videoId) => collection.doc(videoId));
    await this.firestore.runTransaction(async (tx) => {
      const snaps = await Promise.all(refs.map((ref) => tx.get(ref)));
      refs.forEach((ref, i) => {
        const snap = snaps[i];
        if (snap.exists && (snap.data() as { date: string }).date === date) tx.delete(ref);
      });
    });
  }
}
