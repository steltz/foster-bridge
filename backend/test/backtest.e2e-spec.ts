import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { FIRESTORE } from '../src/firebase/firebase.constants';
import { fakeFirestore } from './fake-firestore';

describe('Backtest (e2e)', () => {
  let app: INestApplication;
  const OPEN = Math.floor(Date.UTC(2026, 6, 14, 13, 30, 0) / 1000);
  const fullCsv = ['time,open,high,low,close', ...Array.from({ length: 78 }, (_, i) => `${OPEN + i * 300},100,101,99,100`)].join('\n');
  const shortCsv = ['time,open,high,low,close', ...Array.from({ length: 77 }, (_, i) => `${OPEN + i * 300},100,101,99,100`)].join('\n');

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(FIRESTORE)
      .useValue(fakeFirestore())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterEach(async () => {
    await app.close();
  });

  it('backtests a complete day', async () => {
    await request(app.getHttpServer()).post('/markets/MES/min-5/candles').attach('file', Buffer.from(fullCsv), 'mes.csv').expect(201);
    const res = await request(app.getHttpServer())
      .post('/backtest')
      .send({ symbol: 'MES', interval: 'min-5', date: '2026-07-14', session: 'rth', orders: [{ side: 'long', entry: 100, stopLoss: 95, takeProfit: 110 }] })
      .expect(201);
    expect(res.body.coverage.complete).toBe(true);
    expect(res.body.summary.orders).toBe(1);
  });

  it('refuses an incomplete day with 422', async () => {
    await request(app.getHttpServer()).post('/markets/NQ/min-5/candles').attach('file', Buffer.from(shortCsv), 'nq.csv').expect(201);
    const res = await request(app.getHttpServer())
      .post('/backtest')
      .send({ symbol: 'NQ', interval: 'min-5', date: '2026-07-14', orders: [{ side: 'long', entry: 100, stopLoss: 95, takeProfit: 110 }] })
      .expect(422);
    expect(res.body.error).toBe('incomplete-session');
  });
});
