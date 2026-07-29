import { Inject, Injectable } from '@nestjs/common';
import type { Firestore } from 'firebase-admin/firestore';
import { FIRESTORE } from '../firebase/firebase.constants';
import { MOONSHOT_EXTRACT_ID_PREFIX } from './moonshot.constants';

const EXTRACTS = 'moonshotExtracts';
// 300k UTF-16 code units ≤ ~900KB UTF-8 (worst-case 3 bytes/unit), safely
// under Firestore's 1MiB doc limit (which counts UTF-8 bytes, not JS string
// length — a naive 900k-unit chunk of CJK text can be ~2.7MB and blow the cap).
// May only ever DECREASE without a data migration: re-putting the same hash
// at a LARGER size leaves stale higher-index chunk docs from the prior
// (larger) chunk count around, and the count-equality check in getByHash
// then rejects that doc forever.
export const EXTRACT_CHUNK_SIZE = 300_000;
export const LRU_MAX = 32;

interface ExtractDoc {
  filename?: string;
  mediaType?: string;
  chunked: boolean;
  chunks: number; // 1 when inline
  text?: string; // present only when !chunked
}

/**
 * Splits text into chunks of at most `size` UTF-16 code units. Backs off one
 * unit when a boundary would fall between the two halves of a surrogate pair
 * (an astral character) — otherwise the pair splits across two chunks and
 * reassembly reintroduces two lone, invalid surrogate units instead of the
 * original character.
 */
function splitIntoChunks(text: string, size: number): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + size, text.length);
    if (end < text.length) {
      const lastUnit = text.charCodeAt(end - 1);
      const isHighSurrogate = lastUnit >= 0xd800 && lastUnit <= 0xdbff;
      if (isHighSurrogate && end - 1 > i) end -= 1; // guard against a zero-length chunk at size 1
    }
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

/**
 * Durable content-hash → extracted-text store. Cross-process because uploadFile
 * (day-artifacts) and envelope-build (warmer / run) can run in different
 * processes. An in-memory LRU fronts Firestore for hot re-reads within a process.
 */
@Injectable()
export class MoonshotExtractStore {
  private readonly lru = new Map<string, string>();

  constructor(@Inject(FIRESTORE) private readonly db: Firestore) {}

  private lruGet(hash: string): string | undefined {
    const v = this.lru.get(hash);
    if (v !== undefined) {
      this.lru.delete(hash);
      this.lru.set(hash, v); // refresh recency
    }
    return v;
  }

  private lruSet(hash: string, text: string): void {
    this.lru.delete(hash); // drop any stale position so a re-put also refreshes recency
    this.lru.set(hash, text);
    if (this.lru.size > LRU_MAX) {
      const oldest = this.lru.keys().next().value;
      if (oldest !== undefined) this.lru.delete(oldest);
    }
  }

  async put(hash: string, text: string, meta?: { filename?: string; mediaType?: string }): Promise<void> {
    const ref = this.db.collection(EXTRACTS).doc(hash);
    // Firestore rejects undefined field values (ignoreUndefinedProperties is
    // not set on this app's Firestore instance), so drop any undefined meta.
    const cleanMeta = Object.fromEntries(Object.entries(meta ?? {}).filter(([, v]) => v !== undefined));
    if (text.length <= EXTRACT_CHUNK_SIZE) {
      const doc: ExtractDoc = { chunked: false, chunks: 1, text, ...cleanMeta };
      await ref.set(doc as any);
    } else {
      const chunks = splitIntoChunks(text, EXTRACT_CHUNK_SIZE);
      // Chunk docs are written first; the parent doc is the commit point,
      // written last. A crash between chunk writes and the parent write
      // leaves only orphaned, unreferenced chunk docs — invisible to readers
      // — rather than a parent doc that claims N chunks while some are still
      // missing (torn-write truncation that would silently read back short).
      // Not a WriteBatch: a batch's ~10MiB commit cap breaks at ~11 chunks;
      // ordering the individual writes is the tool here, not atomicity.
      for (let i = 0; i < chunks.length; i++) {
        await ref.collection('chunks').doc(String(i)).set({ text: chunks[i] } as any);
      }
      const doc: ExtractDoc = { chunked: true, chunks: chunks.length, ...cleanMeta };
      await ref.set(doc as any);
    }
    this.lruSet(hash, text);
  }

  async getByHash(hash: string): Promise<string | null> {
    const cached = this.lruGet(hash);
    if (cached !== undefined) return cached;
    const ref = this.db.collection(EXTRACTS).doc(hash);
    const snap = await ref.get();
    if (!snap.exists) return null;
    const doc = snap.data() as ExtractDoc;
    let text: string;
    if (!doc.chunked) {
      // A non-chunked doc missing text is structurally inconsistent — a bug,
      // not an empty extract. '' must only ever mean the extract really was
      // empty, so it is never used as a stand-in for "field absent".
      if (typeof doc.text !== 'string') {
        throw new Error(`moonshot extract store: doc "${hash}" is non-chunked but has no text field`);
      }
      text = doc.text;
    } else {
      if (!Number.isFinite(doc.chunks) || doc.chunks < 1) {
        throw new Error(`moonshot extract store: doc "${hash}" is chunked with invalid chunks count ${doc.chunks}`);
      }
      const chunksSnap = await ref.collection('chunks').get();
      if (chunksSnap.docs.length !== doc.chunks) {
        throw new Error(
          `moonshot extract store: doc "${hash}" declares ${doc.chunks} chunks but ${chunksSnap.docs.length} are present (torn write)`,
        );
      }
      const sorted = [...chunksSnap.docs].sort((a, b) => Number(a.id) - Number(b.id));
      const parts: string[] = [];
      for (const chunkDoc of sorted) {
        const data = chunkDoc.data() as { text?: string } | undefined;
        if (typeof data?.text !== 'string') {
          throw new Error(`moonshot extract store: doc "${hash}" chunk "${chunkDoc.id}" is missing text`);
        }
        parts.push(data.text);
      }
      text = parts.join('');
    }
    this.lruSet(hash, text);
    return text;
  }

  /** Resolves a synthetic `moonshot-extract:<hash>` id (or a bare hash) to text. */
  async getById(extractId: string): Promise<string | null> {
    const hash = extractId.startsWith(MOONSHOT_EXTRACT_ID_PREFIX)
      ? extractId.slice(MOONSHOT_EXTRACT_ID_PREFIX.length)
      : extractId;
    return this.getByHash(hash);
  }
}
