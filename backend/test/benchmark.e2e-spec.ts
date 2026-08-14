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
import { BenchmarkRepository } from '../src/benchmark/benchmark.repository';
import { RepoInputsService } from '../src/benchmark/repo-inputs.service';

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
    // Null it first so an early throw here never leaves afterEach double-closing
    // the PREVIOUS test's app (which was already closed by its own afterEach).
    app = undefined as any;
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

    // Assert the cells actually persisted (this is the capstone guarantee — a
    // no-op createCell must fail here). run1 (long, entry 100 / SL 95 / TP 110)
    // fills and stops out -> SL; run2 (short with inverted SL<entry<TP geometry)
    // is rejected by order normalization -> INVALID.
    const cells = await moduleRef.get(BenchmarkRepository).listCells('fable');
    expect(cells).toHaveLength(2);
    expect(cells.map((c) => c.result.status).sort()).toEqual(['INVALID', 'SL']);
    // Threaded CellMeta provenance is persisted end-to-end (discovery -> batch
    // -> reconciler -> cell). The base variant carries persona + general hashes.
    expect(typeof cells[0].personaSha256).toBe('string');
    expect(cells[0].personaSha256.length).toBeGreaterThan(0);
    expect(cells[0].generalSha256.length).toBeGreaterThan(0);

    // reconcile() already regenerates the scoreboard for each reconciled alias;
    // calling generate() again is idempotent and keeps the assertion explicit.
    await moduleRef.get(ScoreboardService).generate('fable');
    const sb = await request(app.getHttpServer()).get('/benchmark/scoreboard?model=fable').expect(200);
    expect(sb.body.markdown).toContain('# Trader Scoreboard');
    // Per-group heading only rendered when groups.length > 0 (cells exist); the
    // Lineage section's bare 'context-trader' would pass with zero cells.
    expect(sb.body.markdown).toContain('## context-trader @ fable [base]');
    // And the JSON groups reflect the two persisted cells.
    expect((sb.body.json as any).groups).toHaveLength(1);
    expect((sb.body.json as any).groups[0].cellCount).toBe(2);

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

    // The recovered batch's two cells must have been written (a no-op createCell
    // must fail here). Same setups/candles as test 1 -> SL + INVALID.
    const cells = await moduleRef.get(BenchmarkRepository).listCells('fable');
    expect(cells).toHaveLength(2);
    expect(cells.map((c) => c.result.status).sort()).toEqual(['INVALID', 'SL']);
    // Provenance threaded from the pre-seeded CellMeta onto every cell.
    expect(cells[0].personaSha256).toBe('psha');
    expect(cells[0].generalSha256).toBe('gsha');

    // Confirm cells landed by generating + serving the scoreboard — the
    // per-group heading only renders when groups (cells) exist.
    await moduleRef.get(ScoreboardService).generate('fable');
    const sb = await request(app.getHttpServer()).get('/benchmark/scoreboard?model=fable').expect(200);
    expect(sb.body.markdown).toContain('## context-trader @ fable [base]');
    expect((sb.body.json as any).groups[0].cellCount).toBe(2);
  });

  describe('content-drift guard', () => {
    // A cell recording a persona hash that the seeded traders/context-trader.md
    // cannot produce — i.e. the file was edited after this cell was benchmarked.
    const staleCell = {
      trader: 'context-trader', model: { alias: 'fable', id: 'claude-fable-5' }, modelAlias: 'fable',
      day: '07012026', date: '2026-07-01', variant: 'base', runIndex: 1,
      personaSha256: 'sha-from-a-since-edited-persona',
      result: { status: 'TP' }, createdAt: '2026-07-01T00:00:00.000Z',
    };

    /**
     * Boot, then seed a cell that differs from the seeded repo ONLY in its
     * persona hash — its generalSha256 is the real one, read from the running
     * app. A synthetic general hash would drift too and the assertions could
     * not tell the two findings apart.
     */
    async function bootWithStaleCell() {
      let db: any;
      const moduleRef = await boot(async (d) => { db = d; });
      const generalSha256 = moduleRef.get(RepoInputsService).collectGeneralDocs().sha256;
      await db.collection('benchmarkRuns')
        .doc('context-trader__fable__07012026__base__run1')
        .set({ ...staleCell, generalSha256 });
      return moduleRef;
    }

    it('rejects POST /benchmark/run with 409 and submits nothing', async () => {
      batchState.status = 'ended';
      const moduleRef = await bootWithStaleCell();
      await request(app.getHttpServer()).post('/markets/MES/min-5/candles').attach('file', Buffer.from(fullCsv), 'mes.csv').expect(201);

      const res = await request(app.getHttpServer())
        .post('/benchmark/run')
        .send({ model: 'fable', runCount: 2, variants: ['base'] })
        .expect(409);
      expect(res.body.message).toContain('context-trader');
      expect(res.body.drift.findings[0]).toMatchObject({ family: 'persona', kind: 'file-drift' });

      // Nothing queued: the only cell in the collection is still the seeded one,
      // and no batch was created.
      const status = await request(app.getHttpServer()).get('/benchmark/status').expect(200);
      expect(status.body.batches).toHaveLength(0);
      expect(await moduleRef.get(BenchmarkRepository).listCells('fable')).toHaveLength(1);
    });

    it('reports the same drift read-only via GET /benchmark/drift', async () => {
      await bootWithStaleCell();
      const res = await request(app.getHttpServer()).get('/benchmark/drift').expect(200);
      expect(res.body.cellsExamined).toBe(1);
      expect(res.body.findings).toHaveLength(1);
      expect(res.body.findings[0]).toMatchObject({
        family: 'persona',
        identity: 'context-trader',
        recorded: [{ sha256: 'sha-from-a-since-edited-persona', cellCount: 1 }],
      });
    });

    it('reports no drift on a clean tree', async () => {
      await boot();
      const res = await request(app.getHttpServer()).get('/benchmark/drift').expect(200);
      expect(res.body.findings).toEqual([]);
      expect(res.body.cellsExamined).toBe(0);
    });
  });
});
