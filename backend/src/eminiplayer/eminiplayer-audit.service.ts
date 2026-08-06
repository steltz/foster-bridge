import { Inject, Injectable } from '@nestjs/common';
import type { Bucket, File } from '@google-cloud/storage';
import type { Firestore } from 'firebase-admin/firestore';
import { FIRESTORE, STORAGE_BUCKET } from '../firebase/firebase.constants';
import { DayManifest, VIDEO_IDS_COLLECTION } from './eminiplayer-manifest.service';
import {
  assertDayInvariants,
  assertPdfBuffer,
  assertTranscriptMarkdown,
  ES_STORAGE_PREFIX,
  parseMmddyyyy,
  sha256Hex,
} from './eminiplayer-validation';

export interface AuditAnomaly {
  date: string;
  problem: string;
}

export interface AuditOptions {
  from?: string; // MMDDYYYY inclusive
  to?: string; // MMDDYYYY inclusive
  deep?: boolean;
}

export interface AuditReport {
  daysChecked: number;
  ok: number;
  deep: boolean;
  anomalies: AuditAnomaly[];
  uncommittedDays: string[];
}

interface VideoClaim {
  date: string;
  slot: string;
}

/**
 * Epoch ms for a MMDDYYYY date, or null when it is not a real calendar date.
 * `parseMmddyyyy` THROWS by design (an ingest must fail loudly on a bad date),
 * but the audit feeds it two kinds of input it does not control — bucket
 * folder names and Firestore claim dates — where a single bad value must
 * degrade to one anomaly, not abort the sweep over every other day.
 */
function dayTime(date: string): number | null {
  try {
    return parseMmddyyyy(date).getTime();
  } catch {
    return null;
  }
}

/**
 * Read-only re-verification — the "spot check everything" button, sized for
 * a multi-year corpus. Shallow mode (default) downloads only manifests and
 * compares each artifact's md5/size against the GCS LISTING METADATA — no
 * content downloads, so a full-corpus shallow audit is one listing plus one
 * small download per day. `deep=true` additionally downloads content,
 * re-computes sha256, and re-runs the structural gates (use ranges for deep
 * runs). Does NOT re-run LLM verification (each manifest records the verdicts
 * as evidence; re-judging history costs money without new information).
 */
@Injectable()
export class EminiplayerAuditService {
  constructor(
    @Inject(STORAGE_BUCKET) private readonly bucket: Bucket,
    @Inject(FIRESTORE) private readonly firestore: Firestore,
  ) {}

  async audit(opts: AuditOptions = {}): Promise<AuditReport> {
    const deep = opts.deep ?? false;
    // The RANGE is the caller's own input (the controller 400s a malformed
    // one first), so a bad from/to still throws rather than silently auditing
    // everything — unlike the corpus data below.
    const fromT = opts.from ? parseMmddyyyy(opts.from).getTime() : -Infinity;
    const toT = opts.to ? parseMmddyyyy(opts.to).getTime() : Infinity;
    const inRange = (t: number) => t >= fromT && t <= toT;

    const anomalies: AuditAnomaly[] = [];
    const uncommittedDays: string[] = [];

    const [files] = await this.bucket.getFiles({ prefix: ES_STORAGE_PREFIX });
    const dayRegex = new RegExp(`^${ES_STORAGE_PREFIX}(\\d{8})/`);
    const byDay = new Map<string, Map<string, File>>(); // date -> path -> listed File
    const badFolders = new Set<string>();
    for (const f of files) {
      const m = dayRegex.exec(f.name);
      if (!m) continue;
      // `\d{8}` guards the SHAPE only: '13012026' matches and is not a date.
      // Such a folder is itself the anomaly — it can't be range-filtered
      // (it has no position on the calendar), so it is always reported once.
      const t = dayTime(m[1]);
      if (t === null) {
        if (!badFolders.has(m[1])) {
          badFolders.add(m[1]);
          anomalies.push({
            date: m[1],
            problem: `day folder "${m[1]}" is not a real calendar date — not audited`,
          });
        }
        continue;
      }
      if (!inRange(t)) continue;
      if (!byDay.has(m[1])) byDay.set(m[1], new Map());
      byDay.get(m[1])!.set(f.name, f);
    }

    const videoOwners = new Map<string, string>(); // videoId -> date
    const manifestedIds = new Map<string, { date: string; slot: string }>();
    let ok = 0;

    for (const [date, dayFiles] of [...byDay.entries()].sort()) {
      const manifestFile = dayFiles.get(`${ES_STORAGE_PREFIX}${date}/manifest.json`);
      if (!manifestFile) {
        uncommittedDays.push(date);
        continue;
      }
      const before = anomalies.length;

      // The unreadable-manifest catch covers ONLY the manifest download+parse;
      // per-file failures below get attributed to their artifact.
      let manifest: DayManifest;
      try {
        const [buf] = await manifestFile.download();
        manifest = JSON.parse(buf.toString('utf8')) as DayManifest;
      } catch (err) {
        anomalies.push({ date, problem: `manifest unreadable: ${(err as Error).message}` });
        continue;
      }

      // Valid JSON is not a valid manifest: without `files`/`sources` the
      // walks below would throw and take the whole sweep down with them.
      if (!manifest || typeof manifest !== 'object' || !manifest.files || !manifest.sources) {
        anomalies.push({
          date,
          problem: 'manifest is structurally invalid — no files/sources to verify',
        });
        continue;
      }

      try {
        assertDayInvariants(manifest.date, manifest.recapDate);
      } catch (err) {
        anomalies.push({ date, problem: `invariants: ${(err as Error).message}` });
      }

      for (const [artifact, record] of Object.entries(manifest.files)) {
        const stored = dayFiles.get(record.storagePath);
        if (!stored) {
          anomalies.push({ date, problem: `${artifact} missing at ${record.storagePath}` });
          continue;
        }
        // Shallow integrity: the GCS listing already carries md5Hash/size.
        if (stored.metadata.md5Hash !== record.md5) {
          anomalies.push({
            date,
            problem: `${artifact} md5 mismatch — stored object differs from manifest`,
          });
        } else if (Number(stored.metadata.size) !== record.bytes) {
          anomalies.push({ date, problem: `${artifact} size mismatch` });
        }
        if (!deep) continue;
        let content: Buffer;
        try {
          [content] = await stored.download();
        } catch (err) {
          anomalies.push({ date, problem: `${artifact} unreadable: ${(err as Error).message}` });
          continue;
        }
        if (sha256Hex(content) !== record.sha256) {
          anomalies.push({ date, problem: `${artifact} sha256 mismatch` });
        }
        try {
          if (artifact === 'tradePlanPdf') assertPdfBuffer(content, artifact);
          else assertTranscriptMarkdown(content.toString('utf8'), artifact);
        } catch (err) {
          anomalies.push({ date, problem: `${artifact} fails its gate: ${(err as Error).message}` });
        }
      }

      for (const [slot, videoId] of [
        ['recap', manifest.sources.recapVideoId],
        ['tradePlan', manifest.sources.tradePlanVideoId],
      ] as const) {
        const owner = videoOwners.get(videoId);
        if (owner && owner !== date) {
          anomalies.push({ date, problem: `video ${videoId} (${slot}) also used by ${owner}` });
        }
        videoOwners.set(videoId, date);
        manifestedIds.set(videoId, { date, slot });
      }

      if (anomalies.length === before) ok += 1;
    }

    // Claims, both directions. Orphans are only judged inside the audited
    // range — an out-of-range manifest legitimately holds its claims.
    const claims = await this.firestore.collection(VIDEO_IDS_COLLECTION).get();
    const claimById = new Map<string, VideoClaim>(
      claims.docs.map((d) => [d.id, d.data() as VideoClaim] as const),
    );
    for (const [id, claim] of claimById) {
      // Claim documents are stored data, not validated input: an unparseable
      // date can't be placed in or out of range, so it is its own anomaly.
      const claimT = typeof claim?.date === 'string' ? dayTime(claim.date) : null;
      if (claimT === null) {
        anomalies.push({
          date: typeof claim?.date === 'string' ? claim.date : '(unknown)',
          problem: `video-id claim ${id} has an unparseable date — cannot be reconciled`,
        });
        continue;
      }
      if (inRange(claimT) && !manifestedIds.has(id)) {
        anomalies.push({
          date: claim.date,
          problem: `orphaned video-id claim ${id} (no manifest references it)`,
        });
      }
    }
    for (const [id, want] of manifestedIds) {
      const claim = claimById.get(id);
      if (!claim || claim.date !== want.date || claim.slot !== want.slot) {
        anomalies.push({
          date: want.date,
          problem: `no video-id claim matching ${id} (${want.slot}) — uniqueness is unenforced for this video`,
        });
      }
    }

    return { daysChecked: byDay.size, ok, deep, anomalies, uncommittedDays };
  }
}
