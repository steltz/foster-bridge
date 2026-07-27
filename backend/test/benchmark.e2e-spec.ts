// The SDK mock must be declared before importing AppModule.
const succeeded = (side: string) => ({
  type: 'succeeded',
  message: {
    stop_reason: 'end_turn',
    usage: { cache_read_input_tokens: 10 },
    content: [{ type: 'text', text: JSON.stringify({ side, entry: 100, stopLoss: 95, takeProfit: 110, rationale: 'r', primaryZone: 'z', confidence: 3 }) }],
  },
});

const batchState: { status: string } = { status: 'ended' };

class FakeAPIError extends Error {
  status?: number;
  constructor(status: number | undefined, message: string) {
    super(message);
    this.status = status;
  }
}

jest.mock('@anthropic-ai/sdk', () => {
  // Shared mock fns so the (memoized) client exposes the SAME batch across the
  // non-beta and beta surfaces. Bench uses the BETA surface for warm/create/
  // retrieve/results/files; the non-beta surface stays for the demo controller.
  const messageCreate = jest.fn().mockResolvedValue({ model: 'claude-fable-5', usage: { cache_creation_input_tokens: 100, cache_read_input_tokens: 0 } });
  const batchesCreate = jest.fn().mockResolvedValue({ id: 'batch_e2e', processing_status: 'in_progress' });
  const batchesRetrieve = jest.fn(async () => ({ id: 'batch_e2e', processing_status: batchState.status, request_counts: {} }));
  const batchesResults = jest.fn(async () => {
    async function* gen() {
      // Two cells for one trader x base x runCount 2.
      yield { custom_id: 'context-trader__fable__07012026__base__run1', result: succeeded('long') };
      yield { custom_id: 'context-trader__fable__07012026__base__run2', result: succeeded('short') };
    }
    return gen();
  });
  const filesUpload = jest.fn().mockResolvedValue({ id: 'file_e2e' });
  const batches = { create: batchesCreate, retrieve: batchesRetrieve, results: batchesResults };
  const ctor: any = function () {
    return {
      messages: { create: messageCreate, batches },
      beta: {
        messages: { create: messageCreate, batches },
        files: { upload: filesUpload },
      },
    };
  };
  ctor.APIError = FakeAPIError;
  return { __esModule: true, default: ctor, toFile: jest.fn(async (bytes: Buffer, filename: string, o?: any) => ({ bytes, filename, type: o?.type })) };
});

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppModule } from '../src/app.module';
import { FIRESTORE, STORAGE_BUCKET } from '../src/firebase/firebase.constants';
import { fakeFirestore } from './fake-firestore';
import { BatchReconciler } from '../src/benchmark/batch-reconciler';
import { ScoreboardService } from '../src/benchmark/scoreboard.service';

function fakeBucket() {
  const saved: Record<string, Buffer> = {};
  return {
    saved,
    file: (path: string) => ({
      save: (b: Buffer) => { saved[path] = b; return Promise.resolve(); },
      exists: () => Promise.resolve([path in saved] as [boolean]),
      download: () => Promise.resolve([saved[path]] as [Buffer]),
    }),
  };
}

function seedRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bench-e2e-'));
  mkdirSync(join(dir, 'traders'), { recursive: true });
  writeFileSync(join(dir, 'traders', 'context-trader.md'), '---\nname: context-trader\n---\nbody');
  mkdirSync(join(dir, 'features'), { recursive: true });
  mkdirSync(join(dir, 'knowledge-base', 'general'), { recursive: true });
  writeFileSync(join(dir, 'knowledge-base', 'general', 'g.md'), 'GEN');
  const day = join(dir, 'knowledge-base', 'es', '07012026');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, '07012026_ES_TP.pdf'), 'PDF');
  writeFileSync(join(day, '07012026_ES_TP.md'), 'PLAN');
  writeFileSync(join(day, '06302026_ES_RECAP.md'), 'RECAP');
  return dir;
}

describe('Benchmark (e2e)', () => {
  let app: INestApplication;
  let repoRoot: string;
  // 09:30 ET 2026-07-01, 78 five-minute bars = a complete RTH session.
  const OPEN = Math.floor(Date.UTC(2026, 6, 1, 13, 30, 0) / 1000);
  const fullCsv = ['time,open,high,low,close', ...Array.from({ length: 78 }, (_, i) => `${OPEN + i * 300},100,120,90,110`)].join('\n');

  async function boot(preSeed?: (db: any) => Promise<void>) {
    const db = fakeFirestore();
    if (preSeed) await preSeed(db);
    process.env.BENCHMARK_REPO_ROOT = repoRoot;
    // The Anthropic client factory throws a 401 unless a key is configured; the
    // SDK itself is mocked, so any non-empty value unlocks the (fake) client.
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(FIRESTORE).useValue(db)
      .overrideProvider(STORAGE_BUCKET).useValue(fakeBucket())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    return moduleRef;
  }

  beforeAll(() => {
    repoRoot = seedRepo();
  });
  afterAll(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    delete process.env.BENCHMARK_REPO_ROOT;
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it('runs -> submits -> reconciles -> persists cells -> renders scoreboard', async () => {
    batchState.status = 'ended';
    const moduleRef = await boot();
    // Ingest candles for the day so the backtest can score.
    await request(app.getHttpServer()).post('/markets/MES/min-5/candles').attach('file', Buffer.from(fullCsv), 'mes.csv').expect(201);

    const runRes = await request(app.getHttpServer())
      .post('/benchmark/run')
      .send({ model: 'fable', runCount: 2, variants: ['base'] })
      .expect(201);
    expect(runRes.body.batchesSubmitted).toBe(1);
    expect(runRes.body.cellsQueued).toBe(2);

    // Drive reconciliation directly. The @Cron would do this every minute, but
    // the scheduler is gated OFF under test (benchmark.schedulerEnabled=false
    // when NODE_ENV==='test'), so the cron never fires — call reconcile() itself.
    await moduleRef.get(BatchReconciler).reconcile();

    // reconcile() already regenerates the scoreboard for each reconciled alias;
    // calling generate() again is idempotent and keeps the assertion explicit.
    await moduleRef.get(ScoreboardService).generate('fable');
    const sb = await request(app.getHttpServer()).get('/benchmark/scoreboard?model=fable').expect(200);
    expect(sb.body.markdown).toContain('# Trader Scoreboard');
    expect(sb.body.markdown).toContain('context-trader');

    // Status now shows the batch reconciled (terminal -> not listed).
    const status = await request(app.getHttpServer()).get('/benchmark/status').expect(200);
    expect(status.body.batches).toHaveLength(0);
  });

  it('startup reconciliation drains a batch that ended while offline', async () => {
    batchState.status = 'ended';
    // Pre-seed a non-terminal batch + candles BEFORE boot. In production
    // onApplicationBootstrap would drain it; under test the scheduler is gated
    // OFF, so we drive the same recovery path via a direct reconcile() below.
    const moduleRef = await boot(async (db) => {
      await db.collection('benchmarkBatches').doc('batch_e2e').set({
        batchId: 'batch_e2e', day: '07012026', date: '2026-07-01', pdfPrefix: '07012026',
        model: { alias: 'fable', id: 'claude-fable-5' }, status: 'submitted',
        customIdToCell: {
          'context-trader__fable__07012026__base__run1': { date: '2026-07-01', personaSha256: 'psha', generalSha256: 'gsha' },
          'context-trader__fable__07012026__base__run2': { date: '2026-07-01', personaSha256: 'psha', generalSha256: 'gsha' },
        },
        submittedAt: 't',
      });
      // Candles must exist before the reconcile runs the backtest.
      await db.collection('markets/MES/min-5').doc('2026-07-01').set({
        candles: Array.from({ length: 78 }, (_, i) => ({ t: OPEN + i * 300, o: 100, h: 120, l: 90, c: 110 })),
      });
    });

    // Startup recovery: the boot-time reconcile is scheduler-gated off under
    // test, so drive the identical drain path directly.
    await moduleRef.get(BatchReconciler).reconcile();

    // The pre-seeded batch should now be terminal (reconciled) -> not listed.
    const status = await request(app.getHttpServer()).get('/benchmark/status').expect(200);
    expect(status.body.batches).toHaveLength(0);
    // Confirm cells landed by generating + serving the scoreboard.
    await moduleRef.get(ScoreboardService).generate('fable');
    const sb = await request(app.getHttpServer()).get('/benchmark/scoreboard?model=fable').expect(200);
    expect(sb.body.markdown).toContain('context-trader');
  });
});
