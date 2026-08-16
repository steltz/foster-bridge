import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { SamplesService } from './samples.service';
import { BenchmarkRepository } from './benchmark.repository';
import { CloudInputsService } from './cloud-inputs.service';
import { MarketDataService } from '../market-data/market-data.service';
import { resolveContract } from '../contracts/contracts-roll';

// Ten committed days across 2025-2026 (MMDDYYYY keys, chronological order).
const DAYS = [
  ['01062025', '2025-01-06'], ['02032025', '2025-02-03'], ['03102025', '2025-03-10'],
  ['06022025', '2025-06-02'], ['09082025', '2025-09-08'], ['12012025', '2025-12-01'],
  ['01052026', '2026-01-05'], ['03022026', '2026-03-02'], ['06012026', '2026-06-01'],
  ['08032026', '2026-08-03'],
] as const;

function makeDeps() {
  const repo = {
    createSample: jest.fn().mockResolvedValue(undefined),
    getSample: jest.fn().mockResolvedValue(null),
    listSamples: jest.fn().mockResolvedValue([]),
  };
  const inputs = {
    listDays: jest.fn().mockResolvedValue({
      listings: DAYS.map(([day, date]) => ({ day, date, prefix: day, recapDate: day, fileSha256: { tradePlanMd: 'a', tradePlanPdf: 'b', recap: 'c' } })),
      issues: [],
    }),
  };
  // Every stored day complete by default; keyed per contract symbol on demand.
  const marketData = {
    listStoredDays: jest.fn(async (contract: string, _interval: string) =>
      DAYS.filter(([, date]) => resolveContract('ES', date) === contract).map(([, date]) => ({ date, count: 390, complete: true })),
    ),
  };
  return { repo, inputs, marketData };
}

async function build(deps: ReturnType<typeof makeDeps>) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      SamplesService,
      { provide: BenchmarkRepository, useValue: deps.repo },
      { provide: CloudInputsService, useValue: deps.inputs },
      { provide: MarketDataService, useValue: deps.marketData },
    ],
  }).compile();
  return moduleRef.get(SamplesService);
}

describe('SamplesService.create', () => {
  beforeEach(() => jest.clearAllMocks());

  it('draws count distinct pool days, sorted chronologically, and persists', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    const doc = await svc.create({ name: 's1', count: 4 });
    expect(doc.days).toHaveLength(4);
    expect(new Set(doc.days).size).toBe(4);
    const poolKeys = DAYS.map(([day]) => day);
    for (const d of doc.days) expect(poolKeys).toContain(d);
    // Chronological: the stored order matches the pool's own chronological order.
    expect(doc.days).toEqual(poolKeys.filter((d) => doc.days.includes(d)));
    expect(doc).toMatchObject({ name: 's1', requestedCount: 4, poolSize: 10, from: null, to: null });
    expect(deps.repo.createSample).toHaveBeenCalledWith(doc);
  });

  it('count defaults to 100 and 422s with diagnostics when it exceeds the pool', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    await expect(svc.create({ name: 's1' })).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(svc.create({ name: 's1' })).rejects.toThrow(/count 100 exceeds eligible pool of 10 days \(10 committed days in range, 10 with complete candles\)/);
  });

  it('excludes days whose stored coverage is missing or incomplete', async () => {
    const deps = makeDeps();
    deps.marketData.listStoredDays.mockImplementation(async (contract: string) =>
      DAYS.filter(([, date]) => resolveContract('ES', date) === contract)
        .filter(([, date]) => date !== '2025-01-06') // no stored day at all
        .map(([, date]) => ({ date, count: 390, complete: date !== '2025-02-03' })), // stored but incomplete
    );
    const svc = await build(deps);
    const doc = await svc.create({ name: 's1', count: 8 });
    expect(doc.poolSize).toBe(8);
    expect(doc.days).not.toContain('01062025');
    expect(doc.days).not.toContain('02032025');
  });

  it('queries listStoredDays once per resolved contract, not per day', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    await svc.create({ name: 's1', count: 4 });
    const contracts = new Set(DAYS.map(([, date]) => resolveContract('ES', date)));
    expect(deps.marketData.listStoredDays).toHaveBeenCalledTimes(contracts.size);
  });

  it('honours from/to bounds inclusively', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    const doc = await svc.create({ name: 's1', count: 3, from: '06022025', to: '01052026' });
    // Eligible window: 06022025, 09082025, 12012025, 01052026 -> poolSize 4.
    expect(doc.poolSize).toBe(4);
    for (const d of doc.days) expect(['06022025', '09082025', '12012025', '01052026']).toContain(d);
  });

  it('rejects bad names, counts, and ranges with 400 before any I/O', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    await expect(svc.create({ name: '' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create({ name: 'Bad Name!' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create({ name: 123 as any })).rejects.toBeInstanceOf(BadRequestException); // non-string, no TypeError
    await expect(svc.create({ name: 'x'.repeat(65) })).rejects.toBeInstanceOf(BadRequestException); // length cap
    await expect(svc.create({ name: 's1', count: 0 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create({ name: 's1', count: 2.5 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create({ name: 's1', count: '5' as any })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create({ name: 's1', count: 2, from: '2025-01-06' })).rejects.toBeInstanceOf(BadRequestException); // wrong shape
    await expect(svc.create({ name: 's1', count: 2, from: '20250101' })).rejects.toBeInstanceOf(BadRequestException); // YYYYMMDD
    await expect(svc.create({ name: 's1', count: 2, from: '13322025' })).rejects.toBeInstanceOf(BadRequestException); // not a real date
    await expect(svc.create({ name: 's1', count: 2, from: 1012025 as any })).rejects.toBeInstanceOf(BadRequestException); // non-string
    await expect(svc.create({ name: 's1', count: 2, from: '12312026', to: '01012025' })).rejects.toBeInstanceOf(BadRequestException); // inverted
    expect(deps.inputs.listDays).not.toHaveBeenCalled();
    expect(deps.repo.createSample).not.toHaveBeenCalled();
  });

  it('409s an existing name early, before computing the pool', async () => {
    const deps = makeDeps();
    deps.repo.getSample.mockResolvedValue({ name: 's1', days: ['01062025'], requestedCount: 1, poolSize: 1, from: null, to: null, createdAt: 't' });
    const svc = await build(deps);
    await expect(svc.create({ name: 's1', count: 2 })).rejects.toBeInstanceOf(ConflictException);
    expect(deps.inputs.listDays).not.toHaveBeenCalled();
  });

  it('maps a create-time duplicate race (code 6) to 409', async () => {
    const deps = makeDeps();
    deps.repo.createSample.mockRejectedValue(Object.assign(new Error('exists'), { code: 6 }));
    const svc = await build(deps);
    await expect(svc.create({ name: 's1', count: 2 })).rejects.toBeInstanceOf(ConflictException);
  });

  it('aborts the whole create when a pool query fails — nothing persisted', async () => {
    const deps = makeDeps();
    deps.marketData.listStoredDays.mockRejectedValue(new Error('firestore blip'));
    const svc = await build(deps);
    await expect(svc.create({ name: 's1', count: 2 })).rejects.toThrow('firestore blip');
    expect(deps.repo.createSample).not.toHaveBeenCalled();
  });

  it('is deterministic under a mocked Math.random', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    const rnd = jest.spyOn(Math, 'random').mockReturnValue(0); // j === i every swap -> first N pool days
    const doc = await svc.create({ name: 's1', count: 3 });
    expect(doc.days).toEqual(['01062025', '02032025', '03102025']);
    rnd.mockRestore();
  });
});

describe('SamplesService.list / get', () => {
  it('list returns summaries with first/last day', async () => {
    const deps = makeDeps();
    deps.repo.listSamples.mockResolvedValue([
      { name: 's1', days: ['01062025', '08032026'], requestedCount: 2, poolSize: 10, from: null, to: null, createdAt: 't' },
    ]);
    const svc = await build(deps);
    expect(await svc.list()).toEqual([
      { name: 's1', count: 2, poolSize: 10, firstDay: '01062025', lastDay: '08032026', createdAt: 't' },
    ]);
  });

  it('get returns the doc, 400s an invalid name, 404s an unknown name', async () => {
    const deps = makeDeps();
    const doc = { name: 's1', days: ['01062025'], requestedCount: 1, poolSize: 10, from: null, to: null, createdAt: 't' };
    deps.repo.getSample.mockImplementation(async (n: string) => (n === 's1' ? doc : null));
    const svc = await build(deps);
    expect(await svc.get('s1')).toEqual(doc);
    await expect(svc.get('nope')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.get('a/b')).rejects.toBeInstanceOf(BadRequestException); // never reaches Firestore as a doc id
    await expect(svc.get('..')).rejects.toBeInstanceOf(BadRequestException);
    expect(deps.repo.getSample).toHaveBeenCalledTimes(2); // only the two valid names
  });
});
