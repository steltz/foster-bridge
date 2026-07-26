import { Test } from '@nestjs/testing';
import { MarketDataService } from './market-data.service';
import { ContractsService } from '../contracts/contracts.service';
import { FIRESTORE } from '../firebase/firebase.constants';

function makeFirestore(dayDoc: any) {
  const doc = jest.fn(() => ({
    get: jest.fn(() => Promise.resolve({ exists: !!dayDoc, data: () => dayDoc })),
    collection: jest.fn(() => collection),
  }));
  const listDocuments = jest.fn(() => Promise.resolve([{ id: '2026-07-14' }, { id: '2026-07-15' }]));
  const collection: any = jest.fn(() => ({ doc, listDocuments }));
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
});
