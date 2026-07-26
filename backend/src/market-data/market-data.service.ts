import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { Firestore } from 'firebase-admin/firestore';
import { FIRESTORE } from '../firebase/firebase.constants';
import { ContractsService } from '../contracts/contracts.service';
import { Candle, Interval, StoredCandle, fromStored, isInterval } from './candle';

export interface StoredDay {
  date: string;
  count: number;
  complete: boolean;
}

@Injectable()
export class MarketDataService {
  constructor(
    @Inject(FIRESTORE) private readonly firestore: Firestore,
    private readonly contracts: ContractsService,
  ) {}

  private dayCollection(symbol: string, interval: Interval) {
    // markets/{symbol}/{interval} — a single slash-delimited collection path.
    // Firestore collection references accept multi-segment paths directly
    // (any odd segment count is a valid collection ref), so this is one real
    // `.collection()` call rather than a chained collection().doc().collection().
    return this.firestore.collection(`markets/${symbol}/${interval}`);
  }

  private validate(symbol: string, interval: string): asserts interval is Interval {
    this.contracts.get(symbol); // throws NotFoundException on unknown symbol
    if (!isInterval(interval)) throw new BadRequestException(`Unsupported interval: ${interval}`);
  }

  async getDay(symbol: string, interval: Interval, date: string): Promise<Candle[] | null> {
    this.validate(symbol, interval);
    const snap = await this.dayCollection(symbol, interval).doc(date).get();
    if (!snap.exists) return null;
    const stored = (snap.data()?.candles ?? []) as StoredCandle[];
    return stored.map(fromStored);
  }

  async listStoredDays(symbol: string, interval: Interval): Promise<StoredDay[]> {
    this.validate(symbol, interval);
    const snap = await this.dayCollection(symbol, interval).get();
    return snap.docs
      .map((d) => {
        const data = d.data() as any;
        return { date: d.id, count: data.count ?? 0, complete: data.coverage?.rthComplete ?? false };
      })
      .sort((a, b) => a.date.localeCompare(b.date));
  }
}
