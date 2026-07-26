import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { FIRESTORE } from '../src/firebase/firebase.constants';
import { fakeFirestore } from './fake-firestore';

describe('Market data (e2e)', () => {
  let app: INestApplication;
  const OPEN = Math.floor(Date.UTC(2026, 6, 14, 13, 30, 0) / 1000);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(FIRESTORE)
      .useValue(fakeFirestore())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it('uploads a CSV and lists the ingested day', async () => {
    const csv = ['time,open,high,low,close', `${OPEN},1,2,0,1`, `${OPEN + 300},2,3,1,2`].join('\n');
    const res = await request(app.getHttpServer())
      .post('/markets/MES/min-5/candles')
      .attach('file', Buffer.from(csv), 'mes.csv')
      .expect(201);
    expect(res.body.totalRows).toBe(2);
    expect(res.body.days[0].date).toBe('2026-07-14');

    const days = await request(app.getHttpServer()).get('/markets/MES/min-5/days').expect(200);
    expect(days.body.map((d: any) => d.date)).toContain('2026-07-14');
  });

  it('rejects an unknown symbol with 404', async () => {
    await request(app.getHttpServer())
      .post('/markets/XYZ/min-5/candles')
      .attach('file', Buffer.from('time,open,high,low,close\n1,1,1,1,1'), 'x.csv')
      .expect(404);
  });
});
