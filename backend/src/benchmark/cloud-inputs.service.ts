import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { FIRESTORE, STORAGE_BUCKET } from '../firebase/firebase.constants';
import { parseFrontmatter, extractBlock } from '../common/markdown-frontmatter';

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
}
