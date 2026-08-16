import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { FIRESTORE, STORAGE_BUCKET } from '../firebase/firebase.constants';
import { parseFrontmatter, extractBlock } from '../common/markdown-frontmatter';
import { ES_STORAGE_PREFIX, dayPaths, manifestPath } from '../eminiplayer/eminiplayer-validation';

const ZERO_BYTES_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export const TRADERS_COLLECTION = 'traders';
export const FEATURES_COLLECTION = 'features';

// ---- single home of the general/methods storage contract (spec: a second
// definition anywhere is a defect; content.service.ts imports these) ----
export const GENERAL_PREFIX = 'knowledge-base/general/';
export function generalDocPath(name: string): string {
  return `${GENERAL_PREFIX}${name}.md`;
}
export const METHODS_PATH = 'knowledge-base/methods/seven-keys.md';

export interface TraderInput {
  name: string;
  origin: string | null; // null for root personas — no lineage required
  mutation: string | null;
  content: string;
  sha256: string;
}
export interface FeatureInput {
  id: string;
  name: string;
  block: string;
  sha256: string;
  staticDocContent: string | null; // resolved live from the bucket methods doc
  staticDocSha256: string | null;
  artifactSuffix: string | null;
}
export interface GeneralDocs {
  files: { path: string; content: string }[];
  concatenated: string;
  sha256: string;
}
export interface DayListing {
  day: string; // MMDDYYYY
  date: string; // YYYY-MM-DD
  prefix: string; // TP filename prefix (== day in the bucket layout)
  recapDate: string;
  /** Manifest FileRecord hashes — loadDay verifies downloads against these. */
  fileSha256: { tradePlanMd: string; tradePlanPdf: string; recap: string };
}
export interface DayInput extends DayListing {
  pdf: Buffer;
  tpTranscript: string;
  recapTranscript: string;
  recapFileName: string; // `${recapDate}_ES_RECAP.md`
}
export interface DayIssue {
  day: string;
  missing: string[];
}
export interface InputsSnapshot {
  traders: TraderInput[];
  features: FeatureInput[];
  general: GeneralDocs;
  methodsDoc: string | null;
  days: DayListing[];
  issues: DayIssue[];
}

/** Minimal bucket surface so specs can fake it (mirrors day-artifacts.service.ts). */
export interface InputsBucketLike {
  file(path: string): {
    exists(): Promise<[boolean]>;
    download(): Promise<[Buffer]>;
  };
  getFiles(opts: { prefix: string }): Promise<[{ name: string }[]]>;
}

@Injectable()
export class CloudInputsService {
  constructor(
    @Inject(FIRESTORE) private readonly db: Firestore,
    @Inject(STORAGE_BUCKET) private readonly bucket: InputsBucketLike,
  ) {}

  sha256(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  // Fail-closed for the run-start snapshot: an unreachable input store must
  // abort as a 503 before anything is uploaded or submitted. (Once batches
  // start submitting, loadDay failures fall to per-day isolation instead —
  // this wrap's promise is scoped to the up-front fetches.)
  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      throw new ServiceUnavailableException(`inputs unavailable: ${(err as Error).message}`);
    }
  }

  async collectTraders(): Promise<TraderInput[]> {
    const snap = await this.wrap(() => this.db.collection(TRADERS_COLLECTION).get());
    return snap.docs
      .map((d) => {
        const doc = d.data() as { name?: string; content?: string };
        // Malformed docs are only possible via out-of-band writes; name them
        // instead of letting sort()/parse throw a bare TypeError.
        if (typeof doc.name !== 'string' || typeof doc.content !== 'string') {
          throw new ServiceUnavailableException(`traders/${doc.name ?? '<unnamed>'} is malformed (missing name or content)`);
        }
        return doc as { name: string; content: string };
      })
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((doc) => {
        const fm = parseFrontmatter(doc.content);
        return {
          name: doc.name,
          origin: fm.origin || null,
          mutation: fm.mutation || null,
          content: doc.content,
          // Recomputed from content (never trusted from the stored doc) so an
          // out-of-band Firestore edit is visible to the drift guard.
          sha256: this.sha256(doc.content),
        };
      });
  }

  /**
   * methodsDoc is passed in (fetched once by snapshot()) and resolved into any
   * feature whose frontmatter carries a staticDoc key — the methods doc has
   * ONE copy, in the bucket, and prompts/drift both read these same bytes.
   */
  async collectFeatures(methodsDoc: string | null): Promise<FeatureInput[]> {
    const snap = await this.wrap(() => this.db.collection(FEATURES_COLLECTION).get());
    return snap.docs
      .map((d) => {
        const doc = d.data() as { id?: string; content?: string };
        if (typeof doc.id !== 'string' || typeof doc.content !== 'string') {
          throw new ServiceUnavailableException(`features/${doc.id ?? '<unnamed>'} is malformed (missing id or content)`);
        }
        return doc as { id: string; content: string };
      })
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((doc) => {
        const fm = parseFrontmatter(doc.content);
        const staticDocContent = fm.staticDoc ? methodsDoc : null;
        return {
          id: doc.id,
          name: fm.name || doc.id,
          block: extractBlock(doc.content),
          sha256: this.sha256(doc.content),
          staticDocContent,
          staticDocSha256: staticDocContent !== null ? this.sha256(staticDocContent) : null,
          artifactSuffix: fm.artifactSuffix || null,
        };
      });
  }

  private async download(path: string): Promise<Buffer> {
    const [buf] = await this.bucket.file(path).download();
    return buf;
  }

  private async collectGeneralDocs(): Promise<GeneralDocs> {
    const [objects] = await this.bucket.getFiles({ prefix: GENERAL_PREFIX });
    const paths = objects.map((o) => o.name).filter((n) => !n.endsWith('/')).sort();
    const files = await Promise.all(
      paths.map(async (path) => ({ path, content: (await this.download(path)).toString('utf8') })),
    );
    const concatenated = files.map((f) => f.content).join('');
    return { files, concatenated, sha256: concatenated ? this.sha256(concatenated) : ZERO_BYTES_SHA256 };
  }

  private async readMethodsDoc(): Promise<string | null> {
    const [exists] = await this.bucket.file(METHODS_PATH).exists();
    if (!exists) return null;
    return (await this.download(METHODS_PATH)).toString('utf8');
  }

  // One list over the ES prefix; manifests download in PARALLEL. The matcher is
  // built from manifestPath() so a prefix change can never silently zero the
  // corpus (Global Constraint: no hand-built day paths, regexes included).
  private async scanDays(): Promise<{ listings: DayListing[]; issues: DayIssue[] }> {
    const [objects] = await this.bucket.getFiles({ prefix: ES_STORAGE_PREFIX });
    const names = new Set(objects.map((o) => o.name));
    const dayFolders = [...names]
      .map((n) => {
        const rest = n.slice(ES_STORAGE_PREFIX.length);
        const day = rest.split('/')[0];
        return /^\d{8}$/.test(day) && n === manifestPath(day) ? day : null;
      })
      .filter((d): d is string => d !== null);

    const listings: DayListing[] = [];
    const issues: DayIssue[] = [];
    await Promise.all(
      dayFolders.map(async (day) => {
        let recapDate: string;
        let fileSha256: DayListing['fileSha256'];
        try {
          const m = JSON.parse((await this.download(manifestPath(day))).toString('utf8')) as {
            recapDate: string;
            files: { tradePlanMd: { sha256: string }; tradePlanPdf: { sha256: string }; recap: { sha256: string } };
          };
          recapDate = m.recapDate;
          if (!/^\d{8}$/.test(recapDate)) throw new Error(`bad recapDate ${recapDate}`);
          fileSha256 = {
            tradePlanMd: m.files.tradePlanMd.sha256,
            tradePlanPdf: m.files.tradePlanPdf.sha256,
            recap: m.files.recap.sha256,
          };
        } catch (err) {
          issues.push({ day, missing: [`unreadable manifest: ${(err as Error).message}`] });
          return;
        }
        const paths = dayPaths(day, recapDate);
        const missing = [paths.tradePlanMd, paths.tradePlanPdf, paths.recap].filter((p) => !names.has(p));
        if (missing.length) {
          issues.push({ day, missing });
          return;
        }
        listings.push({
          day,
          date: `${day.slice(4, 8)}-${day.slice(0, 2)}-${day.slice(2, 4)}`,
          prefix: day,
          recapDate,
          fileSha256,
        });
      }),
    );
    listings.sort((a, b) => a.date.localeCompare(b.date));
    issues.sort((a, b) => a.day.localeCompare(b.day));
    return { listings, issues };
  }

  /** The single per-run fetch: everything concurrent, one bucket list. */
  async snapshot(): Promise<InputsSnapshot> {
    return this.wrap(async () => {
      const [traders, general, methodsDoc, scan] = await Promise.all([
        this.collectTraders(),
        this.collectGeneralDocs(),
        this.readMethodsDoc(),
        this.scanDays(),
      ]);
      const features = await this.collectFeatures(methodsDoc);
      return { traders, features, general, methodsDoc, days: scan.listings, issues: scan.issues };
    });
  }

  /**
   * Downloads the three artifacts and verifies each against the manifest
   * FileRecord hashes captured in the listing. A mismatch means an eminiplayer
   * force-rerun overwrote the day after the snapshot — throw so the run's
   * per-day isolation records a daysSkipped instead of freezing torn inputs
   * into cell provenance.
   */
  async loadDay(listing: DayListing): Promise<DayInput> {
    const paths = dayPaths(listing.day, listing.recapDate);
    const [pdf, tp, recap] = await Promise.all([
      this.download(paths.tradePlanPdf),
      this.download(paths.tradePlanMd),
      this.download(paths.recap),
    ]);
    const mismatches = [
      ['tradePlanPdf', this.sha256Bytes(pdf), listing.fileSha256.tradePlanPdf],
      ['tradePlanMd', this.sha256Bytes(tp), listing.fileSha256.tradePlanMd],
      ['recap', this.sha256Bytes(recap), listing.fileSha256.recap],
    ].filter(([, actual, expected]) => actual !== expected);
    if (mismatches.length) {
      throw new Error(
        `day ${listing.day} changed since the run snapshot (${mismatches.map(([k]) => k).join(', ')} no longer match the manifest) — likely a force-rerun; skip and re-run`,
      );
    }
    return {
      ...listing,
      pdf,
      tpTranscript: tp.toString('utf8'),
      recapTranscript: recap.toString('utf8'),
      recapFileName: `${listing.recapDate}_ES_RECAP.md`,
    };
  }

  private sha256Bytes(buf: Buffer): string {
    return createHash('sha256').update(buf).digest('hex');
  }

  /** Pure filter — no I/O; days come from the run's snapshot. */
  priorCompleteDays(targetDay: string, snap: InputsSnapshot): DayListing[] {
    const targetDate = `${targetDay.slice(4, 8)}-${targetDay.slice(0, 2)}-${targetDay.slice(2, 4)}`;
    return snap.days.filter((d) => d.date < targetDate);
  }

  /**
   * A day's OUTCOME recap is `<day>_ES_RECAP.md` in the FOLLOWING day's folder.
   * Resolved through COMMITTED listings only (the listing whose recapDate is
   * this day), sha-verified — an orphan recap in an uncommitted folder never
   * satisfies this (spec deliberate choice 1).
   */
  async outcomeRecapForDay(day: string, snap: InputsSnapshot): Promise<string | null> {
    const host = snap.days.find((d) => d.recapDate === day);
    if (!host) return null;
    const buf = await this.download(dayPaths(host.day, day).recap);
    if (this.sha256Bytes(buf) !== host.fileSha256.recap) {
      throw new Error(`outcome recap for ${day} changed since the run snapshot — likely a force-rerun`);
    }
    return buf.toString('utf8');
  }
}
