import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { FIRESTORE } from '../firebase/firebase.constants';
import { ContractsService } from '../contracts/contracts.service';
import { Candle, Interval, StoredCandle, fromStored, isInterval, toStored, intervalToSeconds } from './candle';
import { parseCsv } from './csv-parser';
import { analyzeCoverage } from './coverage';
import { dateForTimestamp, hhmmToMinutes } from '../common/session-time';

export interface StoredDay {
  date: string;
  count: number;
  complete: boolean;
}

export interface DayIngestResult {
  date: string;
  added: number;
  updated: number;
  unchanged: boolean;
  totalAfter: number;
  complete: boolean;
}
export interface IngestSummary {
  symbol: string;
  interval: string;
  totalRows: number;
  days: DayIngestResult[];
}
export interface IngestOptions {
  replace?: boolean;
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
    const snap = await this.dayCollection(symbol, interval).select('count', 'coverage').get();
    return snap.docs
      .map((d) => {
        const data = d.data() as any;
        return { date: d.id, count: data.count ?? 0, complete: data.coverage?.rthComplete ?? false };
      })
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  async ingestCsv(symbol: string, interval: Interval, csvText: string, opts: IngestOptions): Promise<IngestSummary> {
    this.validate(symbol, interval);
    const spec = this.contracts.get(symbol);
    let candles: Candle[];
    try {
      candles = parseCsv(csvText);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }

    // Reject mislabeled uploads: every candle must sit on the interval grid.
    // A truncated/gappy day still aligns (gaps are whole multiples of the
    // interval); sub-interval spacing (e.g. 1-min data sent to min-5) does not.
    const intervalSec = intervalToSeconds(interval);
    const misaligned = candles.find((c) => c.time % intervalSec !== 0);
    if (misaligned) {
      throw new BadRequestException(
        `Candle time ${misaligned.time} is not aligned to the ${interval} interval ` +
          `(${intervalSec}s); the CSV does not match this interval`,
      );
    }

    // Group by ET calendar day.
    const byDay = new Map<string, Candle[]>();
    for (const c of candles) {
      const date = dateForTimestamp(c.time, spec.timezone);
      const list = byDay.get(date) ?? [];
      list.push(c);
      byDay.set(date, list);
    }

    const window = {
      openMin: hhmmToMinutes(spec.rth.open),
      closeMin: hhmmToMinutes(spec.rth.close),
      intervalSec,
      tz: spec.timezone,
    };

    const days: DayIngestResult[] = [];
    for (const [date, dayCandles] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      days.push(await this.upsertDay(symbol, interval, date, dayCandles.map(toStored), window, opts.replace === true));
    }
    return { symbol, interval, totalRows: candles.length, days };
  }

  private async upsertDay(
    symbol: string,
    interval: Interval,
    date: string,
    incoming: StoredCandle[],
    window: { openMin: number; closeMin: number; intervalSec: number; tz: string },
    replace: boolean,
  ): Promise<DayIngestResult> {
    const ref = this.dayCollection(symbol, interval).doc(date);
    return this.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const existing: StoredCandle[] = snap.exists ? ((snap.data()?.candles ?? []) as StoredCandle[]) : [];

      // Dedup the incoming batch by timestamp (last write wins) before doing
      // anything else, so a CSV with a repeated `t` can't inflate `count` or
      // the added/updated tallies, in either the replace or merge branch.
      const incomingDeduped = [...new Map(incoming.map((c) => [c.t, c])).values()];

      const existingByT = new Map(existing.map((c) => [c.t, c]));
      let added = 0;
      let updated = 0;
      let merged: StoredCandle[];
      if (replace) {
        merged = [...incomingDeduped].sort((a, b) => a.t - b.t);
      } else {
        const map = new Map(existingByT);
        for (const c of incomingDeduped) {
          const prev = map.get(c.t);
          if (prev === undefined) added += 1;
          else if (prev.o !== c.o || prev.h !== c.h || prev.l !== c.l || prev.c !== c.c) updated += 1;
          map.set(c.t, c);
        }
        merged = [...map.values()].sort((a, b) => a.t - b.t);
      }

      const unchanged =
        merged.length === existing.length &&
        merged.every((c, i) => {
          const e = existing[i];
          return e && e.t === c.t && e.o === c.o && e.h === c.h && e.l === c.l && e.c === c.c;
        });

      if (unchanged) {
        return { date, added: 0, updated: 0, unchanged: true, totalAfter: merged.length, complete: snap.data()?.coverage?.rthComplete ?? false };
      }

      const coverage = analyzeCoverage(merged.map((s) => ({ time: s.t, open: s.o, high: s.h, low: s.l, close: s.c })), window);
      tx.set(ref, {
        symbol,
        interval,
        date,
        candles: merged,
        count: merged.length,
        firstTime: merged[0]?.t ?? null,
        lastTime: merged[merged.length - 1]?.t ?? null,
        coverage: {
          rthComplete: coverage.complete,
          rthExpectedCount: coverage.expectedCount,
          rthPresentCount: coverage.presentCount,
          hasOpen: coverage.hasOpen,
          hasClose: coverage.hasClose,
        },
        updatedAt: FieldValue.serverTimestamp(),
      });

      return { date, added: replace ? merged.length : added, updated, unchanged: false, totalAfter: merged.length, complete: coverage.complete };
    });
  }
}
