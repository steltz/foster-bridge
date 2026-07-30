import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import request from 'supertest';
import { FIRESTORE } from '../src/firebase/firebase.constants';
import { CostController } from '../src/cost/cost.controller';
import { CostService } from '../src/cost/cost.service';
import { CostRepository } from '../src/cost/cost.repository';
import { ReportBuilder } from '../src/cost/report-builder.provider';
import { fakeFirestore } from './fake-firestore';
import { UsageEvent } from '../src/cost/cost.types';

describe('Cost (e2e)', () => {
  let app: INestApplication;
  let emitter: EventEmitter2;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      controllers: [CostController],
      providers: [
        CostService,
        CostRepository,
        ReportBuilder,
        { provide: FIRESTORE, useValue: fakeFirestore() },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    emitter = app.get(EventEmitter2);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('captures emitted usage and serves aggregation + report', async () => {
    const ev = (over: Partial<UsageEvent>): UsageEvent => ({
      id: 'x',
      timestamp: '2026-07-27T13:00:00.000Z',
      modelId: 'claude-fable-5',
      serviceTier: 'standard',
      attribution: { operation: 'warm', benchmark: { modelAlias: 'fable', day: '07222026' } },
      tokens: { input: 1_000_000, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0, output: 0 },
      source: 'sync',
      ...over,
    });

    // emitAsync awaits the @OnEvent listener so the write completes before we query.
    await emitter.emitAsync('llm.usage', ev({ id: 'warm-1' }));
    await emitter.emitAsync('llm.usage', ev({ id: 'setup-1', serviceTier: 'batch', attribution: { operation: 'setup', benchmark: { modelAlias: 'fable', day: '07222026' } } }));

    const summary = await request(app.getHttpServer()).get('/costs/summary?groupBy=operation').expect(200);
    expect(summary.body.totalRecords).toBe(2);
    const ops = summary.body.groups.map((g: any) => g.key).sort();
    expect(ops).toEqual(['setup', 'warm']);
    expect(summary.body.totalUsd).toBeGreaterThan(0);

    const records = await request(app.getHttpServer()).get('/costs/records').expect(200);
    expect(records.body.total).toBe(2);

    const report = await request(app.getHttpServer()).get('/costs/report').expect(200);
    expect(report.headers['content-type']).toMatch(/text\/html/);
    expect(report.text.startsWith('<!doctype html>')).toBe(true);
  });
});
