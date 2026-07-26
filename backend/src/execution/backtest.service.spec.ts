import { BadRequestException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BacktestService } from './backtest.service';
import { ExecutionEngine } from './execution-engine';
import { ContractsService } from '../contracts/contracts.service';
import { MarketDataService } from '../market-data/market-data.service';

// A full RTH 5-min day for 2026-07-14 (78 bars, flat candles).
const OPEN = Math.floor(Date.UTC(2026, 6, 14, 13, 30, 0) / 1000);
const fullDay = Array.from({ length: 78 }, (_, i) => ({ time: OPEN + i * 300, open: 100, high: 101, low: 99, close: 100 }));

// Entry fills at 100 (first eligible bar >= 10:00, index 6), then bar index
// 20 (well after fill, well before the 14:00 cutoff) tags TP=110.
const winningDay = fullDay.map((c, i) => (i === 20 ? { ...c, high: 110 } : c));

async function build(getDay: any) {
  const marketData = { getDay: jest.fn(getDay) };
  const moduleRef = await Test.createTestingModule({
    providers: [
      BacktestService,
      ExecutionEngine,
      ContractsService,
      { provide: MarketDataService, useValue: marketData },
    ],
  }).compile();
  return { service: moduleRef.get(BacktestService), marketData };
}

const req = {
  symbol: 'MES', interval: 'min-5' as const, date: '2026-07-14', session: 'rth' as const,
  orders: [{ side: 'long' as const, entry: 100, stopLoss: 95, takeProfit: 110 }],
};

describe('BacktestService', () => {
  it('runs the engine on a complete day', async () => {
    const { service } = await build(() => Promise.resolve(fullDay));
    const result = await service.run(req);
    expect(result.summary.orders).toBe(1);
    expect(result.coverage.complete).toBe(true);
  });

  it('returns 404 when the day has no stored candles', async () => {
    const { service } = await build(() => Promise.resolve(null));
    await expect(service.run(req)).rejects.toThrow(/no.*data|not found/i);
  });

  it('refuses (422) an incomplete session unless allowIncomplete', async () => {
    const { service } = await build(() => Promise.resolve(fullDay.slice(0, -1))); // missing close bar
    await expect(service.run(req)).rejects.toThrow(UnprocessableEntityException);

    const { service: s2 } = await build(() => Promise.resolve(fullDay.slice(0, -1)));
    const forced = await s2.run({ ...req, allowIncomplete: true });
    expect(forced.coverage.complete).toBe(false);
  });

  it('applies the contract pointValue to P&L (MES=5)', async () => {
    const { service } = await build(() => Promise.resolve(winningDay));
    const r = await service.run(req); // MES, pointValue 5
    expect(r.results[0].points).toBe(10);
    expect(r.results[0].dollars).toBe(50);
  });

  it('uses a different contract pointValue (ES=50)', async () => {
    const { service } = await build(() => Promise.resolve(winningDay));
    const r = await service.run({ ...req, symbol: 'ES' }); // pointValue 50
    expect(r.results[0].points).toBe(10);
    expect(r.results[0].dollars).toBe(500);
  });

  it('runs a full session without gating (coverage still returned)', async () => {
    const { service } = await build(() => Promise.resolve(fullDay.slice(0, -1))); // incomplete
    const r = await service.run({ ...req, session: 'full' });
    expect(r.session).toBe('full');
    expect(r.coverage.complete).toBe(false); // computed but not gated
  });

  it('rejects an unknown symbol with 404 (distinct from no-data)', async () => {
    const { service } = await build(() => Promise.resolve(fullDay));
    await expect(service.run({ ...req, symbol: 'XYZ' })).rejects.toThrow(NotFoundException);
  });

  it('rejects malformed orders with 400', async () => {
    const { service } = await build(() => Promise.resolve(fullDay));
    await expect(service.run({ ...req, orders: [{ side: 'long', entry: 100, stopLoss: 110, takeProfit: 120 } as any] }))
      .rejects.toThrow(BadRequestException);
  });

  it('rejects a bad entryCutoff with 400', async () => {
    const { service } = await build(() => Promise.resolve(fullDay));
    await expect(service.run({ ...req, entryCutoff: '25:99' })).rejects.toThrow(BadRequestException);
  });

  it('rejects a negative openBuffer with 400', async () => {
    const { service } = await build(() => Promise.resolve(fullDay));
    await expect(service.run({ ...req, openBuffer: -30 })).rejects.toThrow(BadRequestException);
  });

  it('rejects a malformed date with 400', async () => {
    const { service } = await build(() => Promise.resolve(fullDay));
    await expect(service.run({ ...req, date: '07-14-2026' })).rejects.toThrow(BadRequestException);
  });

  it('rejects an invalid session with 400', async () => {
    const { service } = await build(() => Promise.resolve(fullDay));
    await expect(service.run({ ...req, session: 'bogus' as any })).rejects.toThrow(BadRequestException);
  });
});
