// The SDK mock must be declared before importing AppModule.
const setup = (side: string) =>
  JSON.stringify({ side, entry: 100, stopLoss: 95, takeProfit: 110, rationale: 'r', primaryZone: 'z', confidence: 3 });

// Canned structured output keyed on the schema's required fields. Moonshot's
// toMoonshotSchema rewrites `required` to ALL property keys, so every branch
// keys on a property name unique to its schema at the TOP level: zones ->
// seven-keys current-day, calibration -> lookback, artifact -> synthesizer,
// pass -> verifier, side -> the benchmark SETUP schema (the emulated-batch
// cells). An unrecognized schema throws — a silent {} fallback would let a
// routing regression surface only as a mysterious downstream failure.
function structuredFor(schema: any) {
  const req: string[] = schema?.required ?? [];
  if (req.includes('zones'))
    return { bias: 'b', environment: 'e', zones: [{ prices: '7500-7510', side: 'support', key3: 'a', key4: 'b', key5: 'c', key6: 'd', key7: 'e', grade: 'strong' }] };
  if (req.includes('calibration')) return { calibration: [], continuity: [] };
  if (req.includes('artifact')) return { artifact: '# Seven Keys — ES 2026-07-01\n\n## Zone scorecard (Keys 3-7)\n| 7500-7510 | support | a | b | c | d | e | strong |' };
  if (req.includes('pass')) return { pass: true, mismatches: [] };
  if (req.includes('side')) return JSON.parse(setup('long'));
  throw new Error(`structuredFor: unrecognized schema (required: ${JSON.stringify(req)})`);
}

// Moonshot native batch status ('completed' -> lifecycle 'ended'). This suite's
// live run never reads it — kimi-k3 batches are EMULATED (see the mock block) —
// it only feeds the shape-correct native surface kept below.
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
  // chat.completions.create serves BOTH call families this suite exercises:
  // - Seven-keys KEYS generation: sync messageStructured calls whose
  //   response_format carries each agent schema (jsonSchemaFormat nesting:
  //   response_format.json_schema.schema). One day with no prior KEYS days
  //   means current-day + synthesize + verify (no lookback).
  // - The benchmark cells themselves: POST /benchmark/run with model 'k3'
  //   resolves to kimi-k3, which is NOT native-batchable (moonshot.constants
  //   BATCHABLE_MODELS), so submitBatch takes the EMULATED path —
  //   MoonshotBatchWorker drains each cell as a sync chat call carrying the
  //   SETUP schema (prime-then-fan-out: the first item completes before the
  //   rest start). The drain is pure microtask work against the fake Firestore
  //   and this mock, so it finishes before the /benchmark/run HTTP response
  //   even reaches supertest — reconcile() then sees 'ended'.
  // Anything without a response_format schema (cache warms) must still return
  // content starting with '{' (moonshot.chat.ts's brace-repair would mangle
  // non-JSON).
  //
  // files.create/content/del also serve uploadFile's PDF-extract path
  // (purpose 'file-extract': upload -> read extracted text -> delete remote).
  // The NATIVE batch surface (batches.create/retrieve + the out_sc JSONL) is
  // never hit by this suite's emulated run; it is kept shape-correct so a
  // routing change fails on assertions, not on a missing mock method.
  const chatCreate = jest.fn(async (body: any) => {
    const rf = body?.response_format as any;
    const schema = rf?.type === 'json_schema' ? rf?.json_schema?.schema : undefined;
    const content = schema ? JSON.stringify(structuredFor(schema)) : '{}';
    return {
      model: 'kimi-k3',
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, cached_tokens: 10 },
    };
  });
  // One native output-file JSONL row (toItemResult needs status_code 200 + body;
  // toChatResult reads choices[0].message.content / finish_reason).
  const row = (customId: string) =>
    JSON.stringify({
      custom_id: customId,
      response: {
        status_code: 200,
        body: {
          choices: [{ message: { content: setup('long') }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, cached_tokens: 10 },
        },
      },
    });
  const filesCreate = jest.fn(async ({ purpose }: any) =>
    // 'batch' arm unused in this suite — k3 submits are emulated.
    purpose === 'batch' ? { id: 'file_sc' } : { id: 'file_extract_sc' });
  const filesContent = jest.fn(async (fileId: string) => ({
    text: async () =>
      fileId === 'out_sc'
        ? [
            // base + scorecard both run so the scoreboard has a base to compute Δ against.
            row('context-trader__k3__07012026__base__run1'),
            row('context-trader__k3__07012026__seven-keys-scorecard__run1'),
          ].join('\n')
        : 'EXTRACTED PDF TEXT', // uploadFile's extract read; folded into envelopes
  }));
  const filesDel = jest.fn().mockResolvedValue({});
  // (unused in this suite — k3 submits are emulated)
  const batchesCreate = jest.fn().mockResolvedValue({ id: 'batch_sc', status: 'validating' });
  const batchesRetrieve = jest.fn(async (batchId: string) => ({
    id: batchId,
    status: batchState.status,
    request_counts: {},
    output_file_id: 'out_sc',
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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppModule } from '../src/app.module';
import { FIRESTORE, STORAGE_BUCKET } from '../src/firebase/firebase.constants';
import { fakeFirestore } from './fake-firestore';
import { BatchReconciler } from '../src/benchmark/batch-reconciler';
import { ScoreboardService } from '../src/benchmark/scoreboard.service';
import { BenchmarkRepository } from '../src/benchmark/benchmark.repository';

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
  const dir = mkdtempSync(join(tmpdir(), 'bench-sc-e2e-'));
  mkdirSync(join(dir, 'traders'), { recursive: true });
  writeFileSync(join(dir, 'traders', 'context-trader.md'), '---\nname: context-trader\n---\nbody');
  mkdirSync(join(dir, 'features'), { recursive: true });
  writeFileSync(
    join(dir, 'features', 'seven-keys-scorecard.md'),
    '---\nid: seven-keys-scorecard\nname: Seven-Keys precomputed scorecard\nstaticDoc: knowledge-base/methods/seven-keys.md\nartifactSuffix: _ES_KEYS.md\n---\nRead ${DOC} then adopt ${ARTIFACT}.',
  );
  mkdirSync(join(dir, 'knowledge-base', 'methods'), { recursive: true });
  writeFileSync(join(dir, 'knowledge-base', 'methods', 'seven-keys.md'), 'METHODS DOC');
  mkdirSync(join(dir, 'knowledge-base', 'general'), { recursive: true });
  writeFileSync(join(dir, 'knowledge-base', 'general', 'g.md'), 'GEN');
  const day = join(dir, 'knowledge-base', 'es', '07012026');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, '07012026_ES_TP.pdf'), 'PDF');
  writeFileSync(join(day, '07012026_ES_TP.md'), 'PLAN');
  writeFileSync(join(day, '06302026_ES_RECAP.md'), 'RECAP');
  return dir;
}

describe('Benchmark scorecard (e2e)', () => {
  let app: INestApplication;
  let repoRoot: string;
  const OPEN = Math.floor(Date.UTC(2026, 6, 1, 13, 30, 0) / 1000);
  const fullCsv = ['time,open,high,low,close', ...Array.from({ length: 390 }, (_, i) => `${OPEN + i * 60},100,120,90,110`)].join('\n');

  async function boot() {
    app = undefined as any;
    const db = fakeFirestore();
    process.env.BENCHMARK_REPO_ROOT = repoRoot;
    // LLM_PROVIDER=moonshot + MOONSHOT_API_KEY are pinned in set-test-env.ts
    // (jest setupFiles), so the app boots the Moonshot provider against the
    // mocked openai client above — nothing to set here.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(FIRESTORE).useValue(db)
      .overrideProvider(STORAGE_BUCKET).useValue(fakeBucket())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    return moduleRef;
  }

  beforeAll(() => { repoRoot = seedRepo(); });
  afterAll(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    delete process.env.BENCHMARK_REPO_ROOT;
  });
  afterEach(async () => { if (app) await app.close(); });

  it('generates + stores KEYS, persists a scorecard cell with artifactSha256, and shows a scorecard group', async () => {
    batchState.status = 'completed';
    const moduleRef = await boot();
    await request(app.getHttpServer()).post('/markets/ESU26/min-1/candles').attach('file', Buffer.from(fullCsv), 'es.csv').expect(201);

    const runRes = await request(app.getHttpServer())
      .post('/benchmark/run')
      .send({ model: 'k3', runCount: 1, variants: ['base', 'seven-keys-scorecard'] })
      .expect(201);
    expect(runRes.body.batchesSubmitted).toBe(1);
    expect(runRes.body.cellsQueued).toBe(2); // base + scorecard

    const repo = moduleRef.get(BenchmarkRepository);

    // KEYS were generated + stored (capstone: this fails if generation did not
    // persist). KEYS live under the flagship's lineage-scoped id, so read them
    // through the lineage-aware accessor.
    const keys = await repo.getKeysArtifact('07012026', 'k3');
    expect(keys).not.toBeNull();
    expect(keys!.content).toContain('# Seven Keys — ES 2026-07-01');
    expect(keys!.verified).toBe(true);
    expect(keys!.contentHash).toHaveLength(64);

    // kimi-k3 batches are emulated: the worker already drained both cells (see
    // the mock block's timing note), so reconcile() finds the batch 'ended'.
    await moduleRef.get(BatchReconciler).reconcile();

    // The scorecard cell persisted with a real backtest status + the KEYS hash;
    // the base cell carries no artifactSha256.
    const cells = await repo.listCells('k3');
    expect(cells).toHaveLength(2);
    const cell = cells.find((c) => c.variant === 'seven-keys-scorecard')!;
    expect(cell.result.status).toBe('SL'); // long entry 100 / SL 95 / TP 110 on flat 90-120 bars
    expect(cell.artifactSha256).toBe(keys!.contentHash);
    expect(cell.artifactSha256!.length).toBeGreaterThan(0);
    const baseCell = cells.find((c) => c.variant === 'base')!;
    expect(baseCell.artifactSha256).toBeUndefined();

    // The scoreboard shows both groups AND the base-vs-scorecard feature-impact
    // delta — the metric the whole variant exists to produce (Δ(scorecard)).
    await moduleRef.get(ScoreboardService).generate('k3');
    const sb = await request(app.getHttpServer()).get('/benchmark/scoreboard?model=k3').expect(200);
    expect(sb.body.markdown).toContain('## context-trader @ k3 [seven-keys-scorecard]');
    expect(sb.body.markdown).toContain('## Feature Impact');
    // Impact heading uses the feature's display name (from the feature frontmatter).
    expect(sb.body.markdown).toContain('### Seven-Keys precomputed scorecard');
    expect(sb.body.markdown).toMatch(/Overall Δ for Seven-Keys precomputed scorecard/);
    const variants = ((sb.body.json as any).groups as any[]).map((g) => g.variant).sort();
    expect(variants).toEqual(['base', 'seven-keys-scorecard']);
  });
});
