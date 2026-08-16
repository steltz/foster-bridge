// The SDK mock must be declared before importing AppModule.
const setup = (side: string) =>
  JSON.stringify({ side, entry: 100, stopLoss: 95, takeProfit: 110, rationale: 'r', primaryZone: 'z', confidence: 3 });

// Seven-keys agents: canned structured output keyed on the schema's required fields.
function structuredFor(schema: any) {
  const req: string[] = schema?.required ?? [];
  if (req.includes('zones'))
    return { bias: 'b', environment: 'e', zones: [{ prices: '7500-7510', side: 'support', key3: 'a', key4: 'b', key5: 'c', key6: 'd', key7: 'e', grade: 'strong' }] };
  if (req.includes('calibration')) return { calibration: [], continuity: [] };
  if (req.includes('artifact')) return { artifact: '# Seven Keys — ES 2026-07-01\n\n## Zone scorecard (Keys 3-7)\n| 7500-7510 | support | a | b | c | d | e | strong |' };
  if (req.includes('pass')) return { pass: true, mismatches: [] };
  return {};
}

const batchState: { status: string } = { status: 'ended' };

class FakeAPIError extends Error {
  status?: number;
  constructor(status: number | undefined, message: string) {
    super(message);
    this.status = status;
  }
}

jest.mock('@anthropic-ai/sdk', () => {
  // messages.create serves BOTH the max_tokens:0 cache warms (no output_config)
  // and the seven-keys structured calls (output_config.format.schema present).
  const messageCreate = jest.fn(async (params: any) => {
    const schema = params?.output_config?.format?.schema;
    if (schema) {
      return { model: 'claude-fable-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(structuredFor(schema)) }], usage: {} };
    }
    return { model: 'claude-fable-5', stop_reason: 'end_turn', content: [], usage: { cache_creation_input_tokens: 10, cache_read_input_tokens: 0 } };
  });
  const batchesCreate = jest.fn().mockResolvedValue({ id: 'batch_sc', processing_status: 'in_progress' });
  const batchesRetrieve = jest.fn(async () => ({ id: 'batch_sc', processing_status: batchState.status, request_counts: {} }));
  const batchesResults = jest.fn(async () => {
    async function* gen() {
      // base + scorecard both run so the scoreboard has a base to compute Δ against.
      for (const variant of ['base', 'seven-keys-scorecard']) {
        yield {
          custom_id: `context-trader__fable__07012026__${variant}__run1`,
          result: { type: 'succeeded', message: { stop_reason: 'end_turn', usage: { cache_read_input_tokens: 10 }, content: [{ type: 'text', text: setup('long') }] } },
        };
      }
    }
    return gen();
  });
  const filesUpload = jest.fn().mockResolvedValue({ id: 'file_sc' });
  const batches = { create: batchesCreate, retrieve: batchesRetrieve, results: batchesResults };
  const ctor: any = function () {
    return {
      messages: { create: messageCreate, batches },
      beta: { messages: { create: messageCreate, batches }, files: { upload: filesUpload } },
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
    process.env.ANTHROPIC_API_KEY = 'test-key';
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
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(async () => { if (app) await app.close(); });

  it('generates + stores KEYS, persists a scorecard cell with artifactSha256, and shows a scorecard group', async () => {
    batchState.status = 'ended';
    const moduleRef = await boot();
    await request(app.getHttpServer()).post('/markets/ESU26/min-1/candles').attach('file', Buffer.from(fullCsv), 'es.csv').expect(201);

    const runRes = await request(app.getHttpServer())
      .post('/benchmark/run')
      .send({ model: 'fable', runCount: 1, variants: ['base', 'seven-keys-scorecard'] })
      .expect(201);
    expect(runRes.body.batchesSubmitted).toBe(1);
    expect(runRes.body.cellsQueued).toBe(2); // base + scorecard

    const repo = moduleRef.get(BenchmarkRepository);

    // KEYS were generated + stored (capstone: this fails if generation did not
    // persist). KEYS live under the flagship's lineage-scoped id, so read them
    // through the lineage-aware accessor.
    const keys = await repo.getKeysArtifact('07012026', 'fable');
    expect(keys).not.toBeNull();
    expect(keys!.content).toContain('# Seven Keys — ES 2026-07-01');
    expect(keys!.verified).toBe(true);
    expect(keys!.contentHash).toHaveLength(64);

    await moduleRef.get(BatchReconciler).reconcile();

    // The scorecard cell persisted with a real backtest status + the KEYS hash;
    // the base cell carries no artifactSha256.
    const cells = await repo.listCells('fable');
    expect(cells).toHaveLength(2);
    const cell = cells.find((c) => c.variant === 'seven-keys-scorecard')!;
    expect(cell.result.status).toBe('SL'); // long entry 100 / SL 95 / TP 110 on flat 90-120 bars
    expect(cell.artifactSha256).toBe(keys!.contentHash);
    expect(cell.artifactSha256!.length).toBeGreaterThan(0);
    const baseCell = cells.find((c) => c.variant === 'base')!;
    expect(baseCell.artifactSha256).toBeUndefined();

    // The scoreboard shows both groups AND the base-vs-scorecard feature-impact
    // delta — the metric the whole variant exists to produce (Δ(scorecard)).
    await moduleRef.get(ScoreboardService).generate('fable');
    const sb = await request(app.getHttpServer()).get('/benchmark/scoreboard?model=fable').expect(200);
    expect(sb.body.markdown).toContain('## context-trader @ fable [seven-keys-scorecard]');
    expect(sb.body.markdown).toContain('## Feature Impact');
    // Impact heading uses the feature's display name (from the feature frontmatter).
    expect(sb.body.markdown).toContain('### Seven-Keys precomputed scorecard');
    expect(sb.body.markdown).toMatch(/Overall Δ for Seven-Keys precomputed scorecard/);
    const variants = ((sb.body.json as any).groups as any[]).map((g) => g.variant).sort();
    expect(variants).toEqual(['base', 'seven-keys-scorecard']);
  });
});
