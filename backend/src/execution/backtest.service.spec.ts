import { UnprocessableEntityException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BacktestService } from './backtest.service';
import { ExecutionEngine } from './execution-engine';
import { ContractsService } from '../contracts/contracts.service';
import { MarketDataService } from '../market-data/market-data.service';

// A full RTH 5-min day for 2026-07-14 (78 bars, flat candles).
const OPEN = Math.floor(Date.UTC(2026, 6, 14, 13, 30, 0) / 1000);
const fullDay = Array.from({ length: 78 }, (_, i) => ({ time: OPEN + i * 300, open: 100, high: 101, low: 99, close: 100 }));

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
  it('runs the engine on a complete day and uses the contract pointValue', async () => {
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
});
