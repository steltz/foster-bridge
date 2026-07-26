import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { MarketDataService } from './market-data.service';
import { ContractsService } from '../contracts/contracts.service';
import { FIRESTORE } from '../firebase/firebase.constants';

function makeFirestore(dayDoc: any) {
  const doc = jest.fn(() => ({
    get: jest.fn(() => Promise.resolve({ exists: !!dayDoc, data: () => dayDoc })),
    collection: jest.fn(() => collection),
  }));
  const collection: any = jest.fn(() => ({ doc }));
  return { collection } as any;
}

async function build(firestore: any) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      MarketDataService,
      ContractsService,
      { provide: FIRESTORE, useValue: firestore },
    ],
  }).compile();
  return moduleRef.get(MarketDataService);
}

describe('MarketDataService reads', () => {
  it('getDay returns mapped candles for an existing day', async () => {
    const firestore = makeFirestore({ candles: [{ t: 100, o: 1, h: 2, l: 0, c: 1 }] });
    const service = await build(firestore);
    const candles = await service.getDay('MES', 'min-5', '2026-07-14');
    expect(candles).toEqual([{ time: 100, open: 1, high: 2, low: 0, close: 1 }]);
  });

  it('getDay returns null for a missing day', async () => {
    const service = await build(makeFirestore(null));
    expect(await service.getDay('MES', 'min-5', '2026-07-14')).toBeNull();
  });

  it('rejects an unknown symbol', async () => {
    const service = await build(makeFirestore(null));
    await expect(service.getDay('XYZ', 'min-5', '2026-07-14')).rejects.toThrow('Unknown contract');
  });

  it('rejects an invalid interval', async () => {
    const service = await build(makeFirestore(null));
    await expect(service.getDay('MES', 'min-3' as any, '2026-07-14')).rejects.toThrow('interval');
  });

  it('listStoredDays returns sorted day metadata', async () => {
    const firestore: any = {
      collection: jest.fn(() => ({
        select: jest.fn(() => ({
          get: jest.fn(() => Promise.resolve({ docs: [
            { id: '2026-07-15', data: () => ({ count: 78, coverage: { rthComplete: true } }) },
            { id: '2026-07-14', data: () => ({ count: 40, coverage: { rthComplete: false } }) },
          ] })),
        })),
      })),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [MarketDataService, ContractsService, { provide: FIRESTORE, useValue: firestore }],
    }).compile();
    const service = moduleRef.get(MarketDataService);
    const days = await service.listStoredDays('MES', 'min-5');
    expect(days).toEqual([
      { date: '2026-07-14', count: 40, complete: false },
      { date: '2026-07-15', count: 78, complete: true },
    ]);
    expect(firestore.collection).toHaveBeenCalledWith('markets/MES/min-5');
  });
});

// Fake Firestore supporting doc().get inside runTransaction and set capture.
function makeIngestFirestore(existingCandles: any[] | null) {
  const store: any = { candles: existingCandles };
  const docRef = { id: 'ref' };
  const set = jest.fn((_ref: any, data: any) => { store.written = data; });
  const tx = {
    get: jest.fn(() => Promise.resolve({ exists: existingCandles !== null, data: () => ({ candles: existingCandles }) })),
    set,
  };
  const doc = jest.fn(() => docRef);
  const collection = jest.fn(() => ({ doc }));
  const firestore = {
    collection: jest.fn(() => ({ doc: jest.fn(() => ({ collection })) })),
    runTransaction: jest.fn((fn: any) => fn(tx)),
  };
  return { firestore, tx, store };
}

describe('MarketDataService.ingestCsv', () => {
  // 09:30 ET 2026-07-14, then 09:35 — same day.
  const OPEN = Math.floor(Date.UTC(2026, 6, 14, 13, 30, 0) / 1000);
  const csv = (rows: number[][]) =>
    ['time,open,high,low,close', ...rows.map((r) => r.join(','))].join('\n');

  async function buildWith(firestore: any) {
    const moduleRef = await Test.createTestingModule({
      providers: [MarketDataService, ContractsService, { provide: FIRESTORE, useValue: firestore }],
    }).compile();
    return moduleRef.get(MarketDataService);
  }

  it('creates a new day and reports rows added', async () => {
    const { firestore, store } = makeIngestFirestore(null);
    const service = await buildWith(firestore);
    const summary = await service.ingestCsv('MES', 'min-5', csv([[OPEN, 1, 2, 0, 1], [OPEN + 300, 2, 3, 1, 2]]), {});
    expect(summary.totalRows).toBe(2);
    expect(summary.days[0]).toMatchObject({ date: '2026-07-14', added: 2, updated: 0, unchanged: false, totalAfter: 2 });
    expect(store.written.candles).toEqual([{ t: OPEN, o: 1, h: 2, l: 0, c: 1 }, { t: OPEN + 300, o: 2, h: 3, l: 1, c: 2 }]);
  });

  it('merges by timestamp: existing untouched, new appended, dup overwritten', async () => {
    const existing = [{ t: OPEN, o: 1, h: 1, l: 1, c: 1 }];
    const { firestore, store } = makeIngestFirestore(existing);
    const service = await buildWith(firestore);
    const summary = await service.ingestCsv('MES', 'min-5', csv([[OPEN, 9, 9, 9, 9], [OPEN + 300, 2, 3, 1, 2]]), {});
    expect(summary.days[0]).toMatchObject({ added: 1, updated: 1, unchanged: false, totalAfter: 2 });
    expect(store.written.candles).toEqual([{ t: OPEN, o: 9, h: 9, l: 9, c: 9 }, { t: OPEN + 300, o: 2, h: 3, l: 1, c: 2 }]);
  });

  it('skips the write when the merge changes nothing', async () => {
    const existing = [{ t: OPEN, o: 1, h: 2, l: 0, c: 1 }];
    const { firestore, tx } = makeIngestFirestore(existing);
    const service = await buildWith(firestore);
    const summary = await service.ingestCsv('MES', 'min-5', csv([[OPEN, 1, 2, 0, 1]]), {});
    expect(summary.days[0]).toMatchObject({ added: 0, updated: 0, unchanged: true });
    expect(tx.set).not.toHaveBeenCalled();
  });

  it('rejects candles whose timestamps do not align to the interval grid', async () => {
    const { firestore } = makeIngestFirestore(null);
    const service = await buildWith(firestore);
    // OPEN+60 is a 1-min offset — not a multiple of 300s, i.e. mislabeled data.
    await expect(
      service.ingestCsv('MES', 'min-5', csv([[OPEN, 1, 2, 0, 1], [OPEN + 60, 2, 3, 1, 2]]), {}),
    ).rejects.toThrow(/align|interval/i);
  });

  it('replace mode dedups duplicate timestamps in the CSV', async () => {
    const { firestore, store } = makeIngestFirestore(null);
    const service = await buildWith(firestore);
    await service.ingestCsv('MES', 'min-5', csv([[OPEN, 1, 2, 0, 1], [OPEN, 9, 9, 9, 9]]), { replace: true });
    expect(store.written.candles).toEqual([{ t: OPEN, o: 9, h: 9, l: 9, c: 9 }]); // last wins, length 1
    expect(store.written.count).toBe(1);
  });

  it('rejects a malformed CSV as a bad request', async () => {
    const { firestore } = makeIngestFirestore(null);
    const service = await buildWith(firestore);
    await expect(service.ingestCsv('MES', 'min-5', 'time,open,high,low\n1,2,3,4', {}))
      .rejects.toThrow(BadRequestException);
  });
});
