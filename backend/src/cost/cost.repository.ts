import { Inject, Injectable } from '@nestjs/common';
import type { Firestore } from 'firebase-admin/firestore';
import { FIRESTORE } from '../firebase/firebase.constants';
import { CostRecord } from './cost.types';

const COLLECTION = 'costRecords';

export interface ListFilters {
  model?: string; // matches model.alias
  from?: string; // ISO lower bound (inclusive) on timestamp
  to?: string; // ISO upper bound (exclusive) on timestamp
}

@Injectable()
export class CostRepository {
  constructor(@Inject(FIRESTORE) private readonly db: Firestore) {}

  // Write-once via create(): a duplicate id (a re-reconciled batch item keyed
  // `${batchId}:${customId}`) is swallowed so nothing is double-counted.
  async save(record: CostRecord): Promise<void> {
    try {
      await this.db.collection(COLLECTION).doc(record.id).create(record as any);
    } catch (err) {
      if ((err as { code?: number }).code === 6) return; // ALREADY_EXISTS
      throw err;
    }
  }

  // In-memory filter after a full-collection read. Adequate at this scale; swap
  // to Firestore where() queries if the collection grows large.
  async list(filters: ListFilters = {}): Promise<CostRecord[]> {
    const snap = await this.db.collection(COLLECTION).get();
    let rows = snap.docs.map((d) => d.data() as CostRecord);
    if (filters.model) rows = rows.filter((r) => r.model.alias === filters.model);
    if (filters.from) rows = rows.filter((r) => r.timestamp >= filters.from!);
    if (filters.to) rows = rows.filter((r) => r.timestamp < filters.to!);
    return rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }
}
