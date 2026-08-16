// The SDK mock must be declared before importing AppModule.
const setupJson = (side: string) =>
  JSON.stringify({ side, entry: 100, stopLoss: 95, takeProfit: 110, rationale: 'r', primaryZone: 'z', confidence: 3 });

// Moonshot native batch status ('completed' -> lifecycle 'ended').
const batchState: { status: string } = { status: 'completed' };

class FakeAPIError extends Error {
  status?: number;
  constructor(status: number | undefined, message: string) {
    super(message);
    this.status = status;
  }
}

jest.mock('openai', () => {
  // Shared mock fns so every constructed (memoized) client sees the SAME state.
  //
  // Two batch surfaces are in play under the moonshot provider:
  // - POST /benchmark/run with model 'k3' resolves to kimi-k3, which is NOT
  //   native-batchable (moonshot.constants BATCHABLE_MODELS), so submitBatch
  //   takes the EMULATED path: MoonshotBatchWorker drains each cell as a sync
  //   chat.completions.create call. The drain is pure microtask work against
  //   the fake Firestore and this mock, so it completes before the /benchmark/run
  //   HTTP response even reaches supertest — reconcile() then sees 'ended'.
  //   Test 1's two cells consume the side queue below in run order (run1, run2).
  // - The startup-recovery test pre-seeds a batch id WITHOUT the emulated msb_
  //   prefix ('batch_e2e'), so getBatch/getBatchResults route to the NATIVE
  //   surface: batches.retrieve + files.content('out_e2e') JSONL rows.
  //
  // files.create/content/del also serve uploadFile's PDF-extract path
  // (purpose 'file-extract': upload -> read extracted text -> delete remote).
  const setupSides = ['long', 'short'];
  const chatCreate = jest.fn(async (body: any) => {
    // Structured (json_schema) calls are benchmark cells; anything else must
    // still return content starting with '{' (moonshot.chat.ts's brace-repair
    // would mangle non-JSON).
    const structured = (body?.response_format as any)?.type === 'json_schema';
    let content = '{}';
    if (structured) {
      const side = setupSides.shift();
      if (side === undefined) {
        throw new Error(
          'benchmark.e2e-spec chatCreate mock: setupSides queue exhausted — ' +
            'an unexpected extra structured (json_schema) call was made',
        );
      }
      content = setupJson(side);
    }
    return {
      model: 'kimi-k3',
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, cached_tokens: 10 },
    };
  });
  // One native output-file JSONL row (toItemResult needs status_code 200 + body;
  // toChatResult reads choices[0].message.content / finish_reason).
  const row = (customId: string, side: string) =>
    JSON.stringify({
      custom_id: customId,
      response: {
        status_code: 200,
        body: {
          choices: [{ message: { content: setupJson(side) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, cached_tokens: 10 },
        },
      },
    });
  const filesCreate = jest.fn(async ({ purpose }: any) =>
    purpose === 'batch' ? { id: 'file_e2e' } : { id: 'file_extract_e2e' });
  const filesContent = jest.fn(async (fileId: string) => ({
    text: async () =>
      fileId === 'out_e2e'
        ? [
            row('context-trader__k3__07012026__base__run1', 'long'),
            row('context-trader__k3__07012026__base__run2', 'short'),
          ].join('\n')
        : 'EXTRACTED PDF TEXT', // uploadFile's extract read; folded into envelopes
  }));
  const filesDel = jest.fn().mockResolvedValue({});
  const batchesCreate = jest.fn().mockResolvedValue({ id: 'batch_e2e', status: 'validating' });
  const batchesRetrieve = jest.fn(async (batchId: string) => ({
    id: batchId,
    status: batchState.status,
    request_counts: {},
    output_file_id: 'out_e2e',
    // no input_file_id: nativeResults only GCs the input file when it is set.
  }));
  const ctor: any = function () {
    return {
      chat: { completions: { create: chatCreate } },
      files: { create: filesCreate, content: filesContent, del: filesDel },
      batches: { create: batchesCreate, retrieve: batchesRetrieve },
    };
  };
  ctor.APIError = FakeAPIError;
  return {
    __esModule: true,
    default: ctor,
    toFile: jest.fn(async (bytes: Buffer, filename: string, o?: any) => ({ bytes, filename, type: o?.type })),
  };
});

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { FIRESTORE, STORAGE_BUCKET } from '../src/firebase/firebase.constants';
import { fakeFirestore } from './fake-firestore';
import { BatchReconciler } from '../src/benchmark/batch-reconciler';
import { ScoreboardService } from '../src/benchmark/scoreboard.service';
import { BenchmarkRepository } from '../src/benchmark/benchmark.repository';
import { CloudInputsService } from '../src/benchmark/cloud-inputs.service';

function fakeBucket() {
  const saved: Record<string, Buffer> = {};
  return {
    saved,
    file: (path: string) => ({
      save: (b: Buffer) => { saved[path] = b; return Promise.resolve(); },
      exists: () => Promise.resolve([path in saved] as [boolean]),
      download: () => Promise.resolve([saved[path]] as [Buffer]),
    }),
    getFiles: ({ prefix }: { prefix: string }) =>
      Promise.resolve([Object.keys(saved).filter((n) => n.startsWith(prefix)).map((name) => ({ name }))] as [
        { name: string }[],
      ]),
  };
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// Held at module scope so seedCloud() and the tests can reach into the same
// instances the app runs against; recreated per boot() for per-test isolation.
let db: any;
let bucket: ReturnType<typeof fakeBucket>;

function seedCloud() {
  // Same content strings the old temp-repo seed wrote (context-trader is a
  // root persona — no lineage lines) so content-derived assertions keep meaning.
  db.collection('traders').doc('context-trader').set({
    name: 'context-trader',
    content: '---\nname: context-trader\n---\nbody',
  });
  // The old repo seed had an EMPTY features/ dir; BenchmarkService.run() now
  // refuses (422) on zero features, so seed one (this suite only runs 'base').
  db.collection('features').doc('seven-keys-scorecard').set({
    id: 'seven-keys-scorecard',
    content: '---\nid: seven-keys-scorecard\nname: Seven Keys Scorecard\nstaticDoc: knowledge-base/methods/seven-keys.md\nartifactSuffix: _ES_KEYS.md\n---\nblock',
  });
  bucket.saved['knowledge-base/general/g.md'] = Buffer.from('GEN');
  bucket.saved['knowledge-base/methods/seven-keys.md'] = Buffer.from('METHODS');
  // Day listing requires a manifest whose FileRecord hashes match the artifact
  // bytes exactly — loadDay verifies downloads against them.
  bucket.saved['knowledge-base/es/07012026/manifest.json'] = Buffer.from(JSON.stringify({
    date: '07012026',
    recapDate: '06302026',
    files: {
      tradePlanMd: { sha256: sha('PLAN') },
      tradePlanPdf: { sha256: sha('PDF') },
      recap: { sha256: sha('RECAP') },
    },
  }));
  bucket.saved['knowledge-base/es/07012026/07012026_ES_TP.pdf'] = Buffer.from('PDF');
  bucket.saved['knowledge-base/es/07012026/07012026_ES_TP.md'] = Buffer.from('PLAN');
  bucket.saved['knowledge-base/es/07012026/06302026_ES_RECAP.md'] = Buffer.from('RECAP');
}

describe('Benchmark (e2e)', () => {
  let app: INestApplication;
  // 09:30 ET 2026-07-01, 390 one-minute bars = a complete RTH session.
  const OPEN = Math.floor(Date.UTC(2026, 6, 1, 13, 30, 0) / 1000);
  const fullCsv = ['time,open,high,low,close', ...Array.from({ length: 390 }, (_, i) => `${OPEN + i * 60},100,120,90,110`)].join('\n');

  async function boot(preSeed?: (db: any) => Promise<void>) {
    // Null it first so an early throw here never leaves afterEach double-closing
    // the PREVIOUS test's app (which was already closed by its own afterEach).
    app = undefined as any;
    db = fakeFirestore();
    bucket = fakeBucket();
    seedCloud();
    if (preSeed) await preSeed(db);
    // LLM_PROVIDER=moonshot + MOONSHOT_API_KEY are pinned in set-test-env.ts
    // (jest setupFiles), so the app boots the Moonshot provider against the
    // mocked openai client above — nothing to set here.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(FIRESTORE).useValue(db)
      .overrideProvider(STORAGE_BUCKET).useValue(bucket)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    return moduleRef;
  }

  afterEach(async () => {
    if (app) await app.close();
  });

  it('runs -> submits -> reconciles -> persists cells -> renders scoreboard', async () => {
    batchState.status = 'completed';
    const moduleRef = await boot();
    // Ingest candles for the day so the backtest can score. 2026-07-01 resolves
    // to the ESU26 quarterly, which is where the backtest reads them from.
    await request(app.getHttpServer()).post('/markets/ESU26/min-1/candles').attach('file', Buffer.from(fullCsv), 'es.csv').expect(201);

    const runRes = await request(app.getHttpServer())
      .post('/benchmark/run')
      .send({ model: 'k3', runCount: 2, variants: ['base'] })
      .expect(201);
    expect(runRes.body.batchesSubmitted).toBe(1);
    expect(runRes.body.cellsQueued).toBe(2);

    // Drive reconciliation directly. The @Cron would do this every minute, but
    // the scheduler is gated OFF under test (benchmark.schedulerEnabled=false
    // when NODE_ENV==='test'), so the cron never fires — call reconcile() itself.
    // kimi-k3 batches are emulated: the worker already drained both items (see
    // the mock block's timing note), so reconcile() finds the batch 'ended'.
    await moduleRef.get(BatchReconciler).reconcile();

    // Assert the cells actually persisted (this is the capstone guarantee — a
    // no-op createCell must fail here). run1 (long, entry 100 / SL 95 / TP 110)
    // fills and stops out -> SL; run2 (short with inverted SL<entry<TP geometry)
    // is rejected by order normalization -> INVALID.
    const cells = await moduleRef.get(BenchmarkRepository).listCells('k3');
    expect(cells).toHaveLength(2);
    expect(cells.map((c) => c.result.status).sort()).toEqual(['INVALID', 'SL']);
    // Threaded CellMeta provenance is persisted end-to-end (discovery -> batch
    // -> reconciler -> cell). The base variant carries persona + general hashes.
    expect(typeof cells[0].personaSha256).toBe('string');
    expect(cells[0].personaSha256.length).toBeGreaterThan(0);
    expect(cells[0].generalSha256.length).toBeGreaterThan(0);

    // reconcile() already regenerates the scoreboard for each reconciled alias;
    // calling generate() again is idempotent and keeps the assertion explicit.
    await moduleRef.get(ScoreboardService).generate('k3');
    const sb = await request(app.getHttpServer()).get('/benchmark/scoreboard?model=k3').expect(200);
    expect(sb.body.markdown).toContain('# Trader Scoreboard');
    // Per-group heading only rendered when groups.length > 0 (cells exist); the
    // Lineage section's bare 'context-trader' would pass with zero cells.
    expect(sb.body.markdown).toContain('## context-trader @ k3 [base]');
    // And the JSON groups reflect the two persisted cells.
    expect((sb.body.json as any).groups).toHaveLength(1);
    expect((sb.body.json as any).groups[0].cellCount).toBe(2);

    // Status now shows the batch reconciled (terminal -> not listed).
    const status = await request(app.getHttpServer()).get('/benchmark/status').expect(200);
    expect(status.body.batches).toHaveLength(0);
  });

  it('startup reconciliation drains a batch that ended while offline', async () => {
    batchState.status = 'completed';
    // Pre-seed a non-terminal batch + candles BEFORE boot. In production
    // onApplicationBootstrap would drain it; under test the scheduler is gated
    // OFF, so we drive the same recovery path via a direct reconcile() below.
    // The id has no msb_ prefix, so getBatch/getBatchResults take the NATIVE
    // Moonshot branch (batches.retrieve + files.content JSONL in the mock).
    const moduleRef = await boot(async (db) => {
      await db.collection('benchmarkBatches').doc('batch_e2e').set({
        batchId: 'batch_e2e', day: '07012026', date: '2026-07-01', pdfPrefix: '07012026',
        model: { alias: 'k3', id: 'kimi-k3' }, status: 'submitted',
        customIdToCell: {
          'context-trader__k3__07012026__base__run1': { date: '2026-07-01', personaSha256: 'psha', generalSha256: 'gsha' },
          'context-trader__k3__07012026__base__run2': { date: '2026-07-01', personaSha256: 'psha', generalSha256: 'gsha' },
        },
        submittedAt: 't',
      });
      // Candles must exist before the reconcile runs the backtest.
      await db.collection('markets/ESU26/min-1').doc('2026-07-01').set({
        candles: Array.from({ length: 390 }, (_, i) => ({ t: OPEN + i * 60, o: 100, h: 120, l: 90, c: 110 })),
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
    const cells = await moduleRef.get(BenchmarkRepository).listCells('k3');
    expect(cells).toHaveLength(2);
    expect(cells.map((c) => c.result.status).sort()).toEqual(['INVALID', 'SL']);
    // Provenance threaded from the pre-seeded CellMeta onto every cell.
    expect(cells[0].personaSha256).toBe('psha');
    expect(cells[0].generalSha256).toBe('gsha');

    // Confirm cells landed by generating + serving the scoreboard — the
    // per-group heading only renders when groups (cells) exist.
    await moduleRef.get(ScoreboardService).generate('k3');
    const sb = await request(app.getHttpServer()).get('/benchmark/scoreboard?model=k3').expect(200);
    expect(sb.body.markdown).toContain('## context-trader @ k3 [base]');
    expect((sb.body.json as any).groups[0].cellCount).toBe(2);
  });

  describe('content-drift guard', () => {
    // A cell recording a persona hash that the seeded traders/context-trader
    // doc cannot produce — i.e. the persona was edited after this cell was
    // benchmarked.
    const staleCell = {
      trader: 'context-trader', model: { alias: 'k3', id: 'kimi-k3' }, modelAlias: 'k3',
      day: '07012026', date: '2026-07-01', variant: 'base', runIndex: 1,
      personaSha256: 'sha-from-a-since-edited-persona',
      result: { status: 'TP' }, createdAt: '2026-07-01T00:00:00.000Z',
    };

    /**
     * Boot, then seed a cell that differs from the seeded cloud inputs ONLY in
     * its persona hash — its generalSha256 is the real one, read from the
     * running app. A synthetic general hash would drift too and the assertions
     * could not tell the two findings apart.
     */
    async function bootWithStaleCell() {
      const moduleRef = await boot();
      const generalSha256 = (await moduleRef.get(CloudInputsService).snapshot()).general.sha256;
      await db.collection('benchmarkRuns')
        .doc('context-trader__k3__07012026__base__run1')
        .set({ ...staleCell, generalSha256 });
      return moduleRef;
    }

    it('rejects POST /benchmark/run with 409 and submits nothing', async () => {
      batchState.status = 'completed';
      const moduleRef = await bootWithStaleCell();
      await request(app.getHttpServer()).post('/markets/ESU26/min-1/candles').attach('file', Buffer.from(fullCsv), 'es.csv').expect(201);

      const res = await request(app.getHttpServer())
        .post('/benchmark/run')
        .send({ model: 'k3', runCount: 2, variants: ['base'] })
        .expect(409);
      expect(res.body.message).toContain('context-trader');
      expect(res.body.drift.findings[0]).toMatchObject({ family: 'persona', kind: 'file-drift' });

      // Nothing queued: the only cell in the collection is still the seeded one,
      // and no batch was created.
      const status = await request(app.getHttpServer()).get('/benchmark/status').expect(200);
      expect(status.body.batches).toHaveLength(0);
      expect(await moduleRef.get(BenchmarkRepository).listCells('k3')).toHaveLength(1);
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

  it('samples: create over HTTP, list, get, 404/400/409 semantics', async () => {
    await boot();
    // Complete candles for the one committed day -> pool of exactly 1.
    await request(app.getHttpServer()).post('/markets/ESU26/min-1/candles').attach('file', Buffer.from(fullCsv), 'es.csv').expect(201);

    const created = await request(app.getHttpServer()).post('/benchmark/samples').send({ name: 's1', count: 1 }).expect(201);
    expect(created.body.days).toEqual(['07012026']);
    expect(created.body.poolSize).toBe(1);

    const listed = await request(app.getHttpServer()).get('/benchmark/samples').expect(200);
    expect(listed.body).toEqual([expect.objectContaining({ name: 's1', count: 1 })]);

    const fetched = await request(app.getHttpServer()).get('/benchmark/samples/s1').expect(200);
    expect(fetched.body.days).toEqual(['07012026']);

    await request(app.getHttpServer()).get('/benchmark/samples/nope').expect(404);
    await request(app.getHttpServer()).post('/benchmark/samples').send({ name: 'Bad Name!' }).expect(400);
    await request(app.getHttpServer()).post('/benchmark/samples').send({ name: 's1', count: 1 }).expect(409);
    await request(app.getHttpServer()).post('/benchmark/samples').send({ name: 's2', count: 5 }).expect(422);
  });
});
