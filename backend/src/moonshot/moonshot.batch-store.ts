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
  // D5: incremented on each claim. Observability only — no maxAttempts/retry-limit logic reads this (yet).
  attempts?: number;
  leaseUntil?: string; // D5: ISO; a running item is reclaimable once this passes
  text?: string;
  error?: string;
  cacheReadTokens?: number;
  usage?: UsageTokens;
}

/**
 * An item the batch still owes work on. Exported so the store's
 * listUnfinishedItems and the worker's drain-completion check share ONE
 * definition of "unfinished" — they must agree, or a drain could mark a batch
 * ended while the store still hands out work for it.
 */
export function isUnfinished(item: EmulatedBatchItem): boolean {
  return item.status === 'pending' || item.status === 'running';
}

// Firestore rejects explicit `undefined` field values (ignoreUndefinedProperties
// is not set on this app's Firestore instance — see moonshot.extract-store.ts),
// so strip them recursively before every write. Object keys with an undefined
// value are dropped; array elements are left in place (never filtered out, which
// would shift indices, and null/0/other falsy elements are kept as-is) except
// that an object element is itself recursed into.
//
// Contract: the input must be plain JSON-shaped data — objects, arrays,
// strings, numbers, booleans, null. Anything else (a Date, a Buffer, a future
// Firestore FieldValue sentinel such as FieldValue.increment()) is passed
// through unchanged rather than recursed into; see the prototype check below.
function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => (v !== null && typeof v === 'object' ? stripUndefined(v) : v)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    // Only recurse into plain objects (`{}` / `Object.create(null)`). A Date
    // or Buffer has a different prototype and would otherwise be silently
    // mangled by Object.entries — a Date into `{}`, a Buffer into a
    // byte-index map — and a future FieldValue sentinel would lose whatever
    // internal shape the SDK relies on.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = v !== null && typeof v === 'object' ? stripUndefined(v) : v;
    }
    return out as T;
  }
  return value;
}

/** Firestore-durable store for client-side emulated batches (kimi-k3). */
@Injectable()
export class MoonshotBatchStore {
  constructor(@Inject(FIRESTORE) private readonly db: Firestore) {}

  private batchRef(id: string) { return this.db.collection(BATCHES).doc(id); }
  private itemRef(batchId: string, customId: string) { return this.batchRef(batchId).collection('items').doc(customId); }

  // NOTE on `total`: these writes are non-atomic — the batch doc lands, then
  // each item doc separately. A crash partway through the item writes leaves
  // an in_progress batch whose item count is short of `total`. This store
  // does not (and, without a multi-doc transaction across an unbounded item
  // count, cannot) guarantee the two stay in sync — the WORKER (Task 8) owns
  // enforcing the invariant: before marking a drained batch 'ended', verify
  // `(await listItems(batchId)).length === total` and mark 'errored' instead
  // on a mismatch.
  //
  // Only createBatch strips undefined fields (see stripUndefined above).
  // updateItem/setBatchStatus deliberately don't: those patches are
  // internally constructed by this store's own callers (never raw
  // caller-supplied option bags), and stripping would recurse into and
  // mangle a future Firestore FieldValue sentinel (e.g. FieldValue.delete()
  // or .increment()) passed in a patch.
  async createBatch(doc: EmulatedBatchDoc, items: EmulatedBatchItem[]): Promise<void> {
    await this.batchRef(doc.batchId).set(stripUndefined(doc));
    for (const item of items) await this.itemRef(doc.batchId, item.customId).set(stripUndefined(item));
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
    return all.filter(isUnfinished);
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
    return this.db.runTransaction(async (tx) => {
      // Computed inside the callback, not once outside runTransaction: real
      // Firestore retries this callback on write contention, and a time
      // captured before the first attempt would go stale by the retry delay —
      // shortening the granted lease and comparing "expired" against a nowIso
      // that's no longer now.
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const leaseUntil = new Date(nowMs + leaseMs).toISOString();
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const item = snap.data() as EmulatedBatchItem;
      const claimable = item.status === 'pending' || (item.status === 'running' && (item.leaseUntil ?? '') < nowIso);
      if (!claimable) return false;
      // No await between this claimability check and the write below: the check
      // and the write must happen inside a single transaction attempt with no
      // interleaving point, or two concurrent claimers could both read
      // "claimable" before either writes.
      tx.set(ref, { ...item, status: 'running', leaseUntil, attempts: (item.attempts ?? 0) + 1 });
      return true;
    });
  }

  async updateItem(batchId: string, customId: string, patch: Partial<EmulatedBatchItem>): Promise<void> {
    await this.itemRef(batchId, customId).update(patch);
  }

  async setBatchStatus(batchId: string, status: EmulatedBatchStatus, endedAt?: string): Promise<void> {
    await this.batchRef(batchId).update({ status, ...(endedAt ? { endedAt } : {}) });
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
        if ((doc.endedAt ?? doc.createdAt) < cutoffIso) out.push(d.id); // doc id is the ref's source of truth
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
