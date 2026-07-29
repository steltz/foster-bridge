import { Inject, Injectable } from '@nestjs/common';
import type { Firestore } from 'firebase-admin/firestore';
import { FIRESTORE } from '../firebase/firebase.constants';
import { MOONSHOT_EXTRACT_ID_PREFIX } from './moonshot.constants';

const EXTRACTS = 'moonshotExtracts';
// ~900 KB per chunk keeps each Firestore doc safely under the 1 MiB limit.
export const EXTRACT_CHUNK_SIZE = 900_000;
const LRU_MAX = 32;

interface ExtractDoc {
  filename?: string;
  mediaType?: string;
  chunked: boolean;
  chunks: number; // 1 when inline
  text?: string; // present only when !chunked
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
    this.lru.set(hash, text);
    if (this.lru.size > LRU_MAX) this.lru.delete(this.lru.keys().next().value);
  }

  async put(hash: string, text: string, meta?: { filename?: string; mediaType?: string }): Promise<void> {
    const ref = this.db.collection(EXTRACTS).doc(hash);
    if (text.length <= EXTRACT_CHUNK_SIZE) {
      const doc: ExtractDoc = { chunked: false, chunks: 1, text, ...meta };
      await ref.set(doc as any);
    } else {
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += EXTRACT_CHUNK_SIZE) chunks.push(text.slice(i, i + EXTRACT_CHUNK_SIZE));
      const doc: ExtractDoc = { chunked: true, chunks: chunks.length, ...meta };
      await ref.set(doc as any);
      for (let i = 0; i < chunks.length; i++) {
        await ref.collection('chunks').doc(String(i)).set({ text: chunks[i] } as any);
      }
    }
    this.lruSet(hash, text);
  }

  async getByHash(hash: string): Promise<string | null> {
    const cached = this.lruGet(hash);
    if (cached !== undefined) return cached;
    const snap = await this.db.collection(EXTRACTS).doc(hash).get();
    if (!snap.exists) return null;
    const doc = snap.data() as ExtractDoc;
    let text: string;
    if (!doc.chunked) {
      text = doc.text ?? '';
    } else {
      const parts: string[] = [];
      for (let i = 0; i < doc.chunks; i++) {
        const c = await this.db.collection(EXTRACTS).doc(hash).collection('chunks').doc(String(i)).get();
        parts.push((c.data() as { text: string } | undefined)?.text ?? '');
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
