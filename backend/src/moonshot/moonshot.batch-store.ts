import { Inject, Injectable } from '@nestjs/common';
import type { Firestore } from 'firebase-admin/firestore';
import { FIRESTORE } from '../firebase/firebase.constants';
import { PromptEnvelope, BatchSubmitOptions, UsageTokens } from '../llm/llm.types';

const BATCHES = 'moonshotBatches';

export type EmulatedBatchStatus = 'in_progress' | 'ended' | 'errored';
export type EmulatedItemStatus = 'pending' | 'running' | 'succeeded' | 'refusal' | 'errored';

export interface EmulatedBatchDoc {
  batchId: string;
  model: string;
  opts: BatchSubmitOptions; // schema / maxTokens / effort (model duplicated above)
  batchEnvelope?: PromptEnvelope; // batch-level fallback envelope
  status: EmulatedBatchStatus;
  total: number;
  createdAt: string;
  expiresAt: string; // D6: past this, a non-drained batch is marked errored
  endedAt?: string;
}

export interface EmulatedBatchItem {
  customId: string;
  prompt: string;
  envelope?: PromptEnvelope; // per-item; overrides batchEnvelope
  status: EmulatedItemStatus;
  attempts?: number; // D5: incremented on each claim
  leaseUntil?: string; // D5: ISO; a running item is reclaimable once this passes
  text?: string;
  error?: string;
  cacheReadTokens?: number;
  usage?: UsageTokens;
}

/** Firestore-durable store for client-side emulated batches (kimi-k3). */
@Injectable()
export class MoonshotBatchStore {
  constructor(@Inject(FIRESTORE) private readonly db: Firestore) {}

  private batchRef(id: string) { return this.db.collection(BATCHES).doc(id); }
  private itemRef(batchId: string, customId: string) { return this.batchRef(batchId).collection('items').doc(customId); }

  async createBatch(doc: EmulatedBatchDoc, items: EmulatedBatchItem[]): Promise<void> {
    await this.batchRef(doc.batchId).set(doc as any);
    for (const item of items) await this.itemRef(doc.batchId, item.customId).set(item as any);
  }

  async getBatch(batchId: string): Promise<EmulatedBatchDoc | null> {
    const snap = await this.batchRef(batchId).get();
    return snap.exists ? (snap.data() as EmulatedBatchDoc) : null;
  }

  async listItems(batchId: string): Promise<EmulatedBatchItem[]> {
    const snap = await this.batchRef(batchId).collection('items').get();
    return snap.docs.map((d) => d.data() as EmulatedBatchItem);
  }

  // Items not yet terminal (pending OR running) — the worker's work set.
  async listUnfinishedItems(batchId: string): Promise<EmulatedBatchItem[]> {
    const all = await this.listItems(batchId);
    return all.filter((i) => i.status === 'pending' || i.status === 'running');
  }

  // D5: transactional claim. Flip pending→running, or reclaim a running item whose
  // lease has expired. Returns true only to the winner, who then runs the call. This
  // is what makes concurrent kick()/bootstrap-resume across processes single-run.
  //
  // Uses tx.set() with the full item (read via tx.get() moments earlier) rather than
  // tx.update() with a partial patch: the repo's shared Firestore transaction fake
  // (backend/test/fake-firestore.ts) only implements get/set on its tx object (no
  // update), matching the pattern already used in
  // src/market-data/market-data.service.ts. Firestore's real Transaction.set()
  // defaults to a full-document overwrite (no merge), which is safe here because we
  // already hold every field from the just-read snapshot.
  async claimItem(batchId: string, customId: string, leaseMs: number): Promise<boolean> {
    const ref = this.itemRef(batchId, customId);
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const leaseUntil = new Date(nowMs + leaseMs).toISOString();
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const item = snap.data() as EmulatedBatchItem;
      const claimable = item.status === 'pending' || (item.status === 'running' && (item.leaseUntil ?? '') < nowIso);
      if (!claimable) return false;
      // No await between this claimability check and the write below: the check
      // and the write must happen inside a single transaction attempt with no
      // interleaving point, or two concurrent claimers could both read
      // "claimable" before either writes.
      tx.set(ref, { ...item, status: 'running', leaseUntil, attempts: (item.attempts ?? 0) + 1 } as any);
      return true;
    });
  }

  async updateItem(batchId: string, customId: string, patch: Partial<EmulatedBatchItem>): Promise<void> {
    await this.itemRef(batchId, customId).update(patch as any);
  }

  async setBatchStatus(batchId: string, status: EmulatedBatchStatus, endedAt?: string): Promise<void> {
    await this.batchRef(batchId).update({ status, ...(endedAt ? { endedAt } : {}) } as any);
  }

  async listInProgressBatches(): Promise<EmulatedBatchDoc[]> {
    const snap = await this.db.collection(BATCHES).where('status', '==', 'in_progress').get();
    return snap.docs.map((d) => d.data() as EmulatedBatchDoc);
  }

  // Terminal batches whose TERMINAL time (endedAt, or createdAt as a fallback) is
  // older than the cutoff. Keyed off endedAt so a lagging reconciler never has
  // results GC'd before it reads them. Filtered in memory to avoid a composite index.
  async listTerminalBatchesOlderThan(cutoffIso: string): Promise<string[]> {
    const out: string[] = [];
    for (const status of ['ended', 'errored'] as const) {
      const snap = await this.db.collection(BATCHES).where('status', '==', status).get();
      for (const d of snap.docs) {
        const doc = d.data() as EmulatedBatchDoc;
        if ((doc.endedAt ?? doc.createdAt) < cutoffIso) out.push(doc.batchId);
      }
    }
    return out;
  }

  async deleteBatch(batchId: string): Promise<void> {
    // Deletes by re-deriving each item's doc ref from its id rather than using a
    // `.ref` property on the listed row: the shared Firestore fake's collection
    // `.get()` rows expose only `{ id, data() }` (no `ref`), unlike the plan's
    // original local fake.
    const items = await this.batchRef(batchId).collection('items').get();
    for (const d of items.docs) await this.itemRef(batchId, d.id).delete();
    await this.batchRef(batchId).delete();
  }
}
