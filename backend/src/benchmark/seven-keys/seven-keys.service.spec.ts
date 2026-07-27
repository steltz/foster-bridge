jest.mock('node:fs', () => ({ ...jest.requireActual('node:fs'), readFileSync: jest.fn() }));

import { Test } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { ConfigService } from '@nestjs/config';
import { SevenKeysService } from './seven-keys.service';
import { BenchmarkRepository } from '../benchmark.repository';
import { RepoInputsService } from '../repo-inputs.service';
import { DayArtifactsService } from '../day-artifacts.service';
import { AnthropicService } from '../../anthropic/anthropic.service';
import { CURRENT_SCHEMA, LOOKBACK_SCHEMA, SYNTH_SCHEMA, VERIFY_SCHEMA } from './schemas';

const DAY = {
  day: '07082026',
  date: '2026-07-08',
  prefix: '07082026',
  pdfPath: '/es/07082026/07082026_ES_TP.pdf',
  planPath: '/es/07082026/07082026_ES_TP.md',
  recapPath: '/es/07082026/07012026_ES_RECAP.md',
};

// messageStructured stub: canned output keyed on the schema's required fields.
function structuredFor(schema: any): any {
  const req: string[] = schema.required;
  if (req.includes('zones'))
    return { bias: 'b', environment: 'e', zones: [{ prices: '7500-7510', side: 'support', key3: 'a', key4: 'b', key5: 'c', key6: 'd', key7: 'e', grade: 'strong' }] };
  if (req.includes('calibration')) return { calibration: [{ day: '07012026', verdict: 'held' }], continuity: ['x'] };
  if (req.includes('artifact')) return { artifact: '# Seven Keys — ES 2026-07-08\n\n| row |' };
  if (req.includes('pass')) return { pass: true, mismatches: [] };
  return {};
}

function makeDeps() {
  const anthropic = { messageStructured: jest.fn(async (_i: any, opts: any) => structuredFor(opts.outputSchema)) };
  const repo = {
    getDayArtifact: jest.fn().mockResolvedValue(null),
    saveDayArtifact: jest.fn().mockResolvedValue(undefined),
    hasScorecardCells: jest.fn().mockResolvedValue(false),
  };
  const inputs = {
    collectGeneralDocs: jest.fn().mockReturnValue({ concatenated: 'GEN', sha256: 'g' }),
    readMethodsDoc: jest.fn().mockReturnValue('METHODS'),
    priorCompleteDays: jest.fn().mockReturnValue([]),
    outcomeRecapPathForDay: jest.fn().mockReturnValue(null),
  };
  const dayArtifacts = { ensureFileId: jest.fn().mockResolvedValue('file_1') };
  return { anthropic, repo, inputs, dayArtifacts };
}

async function build(deps: ReturnType<typeof makeDeps>) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      SevenKeysService,
      { provide: AnthropicService, useValue: deps.anthropic },
      { provide: BenchmarkRepository, useValue: deps.repo },
      { provide: RepoInputsService, useValue: deps.inputs },
      { provide: DayArtifactsService, useValue: deps.dayArtifacts },
      { provide: ConfigService, useValue: { get: (k: string) => (k === 'benchmark.effort' ? 'high' : undefined) } },
    ],
  }).compile();
  return moduleRef.get(SevenKeysService);
}

describe('SevenKeysService.generate', () => {
  beforeEach(() => {
    (readFileSync as jest.Mock).mockImplementation((p: string) => (String(p).includes('RECAP') ? 'RECAP' : 'TP'));
  });

  it('bootstrap: skips the lookback agent and runs current(pinned fable) -> synth -> verify', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    const out = await svc.generate(DAY as any);
    const schemas = deps.anthropic.messageStructured.mock.calls.map((c) => c[1].outputSchema);
    expect(schemas).toContain(CURRENT_SCHEMA);
    expect(schemas).toContain(SYNTH_SCHEMA);
    expect(schemas).toContain(VERIFY_SCHEMA);
    expect(schemas).not.toContain(LOOKBACK_SCHEMA); // no prior KEYS -> bootstrap
    // Current-day is explicitly pinned to Fable and carries the PDF (files:true).
    const currentCall = deps.anthropic.messageStructured.mock.calls.find((c) => c[1].outputSchema === CURRENT_SCHEMA)!;
    expect(currentCall[1].model).toBe('claude-fable-5');
    expect(currentCall[1].files).toBe(true);
    expect(out).toEqual({ verified: true, mismatches: [], artifact: '# Seven Keys — ES 2026-07-08\n\n| row |', lookbackSources: [], lookbackMissing: [] });
  });

  it('runs the lookback agent oldest-first when prior KEYS exist, and reports sources oldest-first', async () => {
    const deps = makeDeps();
    deps.inputs.priorCompleteDays.mockReturnValue([
      { day: '07012026', date: '2026-07-01' },
      { day: '07022026', date: '2026-07-02' },
    ]);
    deps.repo.getDayArtifact.mockImplementation(async (d: string, kind: string) =>
      kind === 'keys' ? { content: `KEYS-${d}` } : null,
    );
    deps.inputs.outcomeRecapPathForDay.mockReturnValue('/es/next/x_ES_RECAP.md');
    const svc = await build(deps);
    const out = await svc.generate(DAY as any);
    const lookbackCall = deps.anthropic.messageStructured.mock.calls.find((c) => c[1].outputSchema === LOOKBACK_SCHEMA)!;
    expect(lookbackCall[0].prompt.indexOf('07012026')).toBeLessThan(lookbackCall[0].prompt.indexOf('07022026'));
    expect(out.lookbackSources).toEqual(['07012026_ES_KEYS.md', '07022026_ES_KEYS.md']);
  });

  it('caps the lookback set to the 3 most recent prior KEYS days (still oldest-first)', async () => {
    const deps = makeDeps();
    deps.inputs.priorCompleteDays.mockReturnValue(
      ['07012026', '07022026', '07032026', '07042026'].map((day) => ({ day, date: `2026-07-0${day[1]}` })),
    );
    deps.repo.getDayArtifact.mockImplementation(async (d: string, kind: string) => (kind === 'keys' ? { content: `K-${d}` } : null));
    const svc = await build(deps);
    const out = await svc.generate(DAY as any);
    expect(out.lookbackSources).toEqual(['07022026_ES_KEYS.md', '07032026_ES_KEYS.md', '07042026_ES_KEYS.md']);
  });

  it('verifier fail -> verified:false with mismatches, no persistence attempted here', async () => {
    const deps = makeDeps();
    deps.anthropic.messageStructured.mockImplementation(async (_i: any, opts: any) =>
      opts.outputSchema === VERIFY_SCHEMA ? { pass: false, mismatches: ['invented 7999'] } : structuredFor(opts.outputSchema),
    );
    const svc = await build(deps);
    const out = await svc.generate(DAY as any);
    expect(out.verified).toBe(false);
    expect(out.mismatches).toEqual(['invented 7999']);
  });

  it('verify runs after synth and embeds the synthesized artifact', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    await svc.generate(DAY as any);
    const calls = deps.anthropic.messageStructured.mock.calls;
    const synthIdx = calls.findIndex((c) => c[1].outputSchema === SYNTH_SCHEMA);
    const verifyIdx = calls.findIndex((c) => c[1].outputSchema === VERIFY_SCHEMA);
    expect(synthIdx).toBeLessThan(verifyIdx);
    expect(calls[verifyIdx][0].prompt).toContain('# Seven Keys — ES 2026-07-08');
  });

  it('retries a transient upstream failure (503) on the verify step, then succeeds', async () => {
    const deps = makeDeps();
    let verifyCalls = 0;
    deps.anthropic.messageStructured.mockImplementation(async (_i: any, opts: any) => {
      if (opts.outputSchema === VERIFY_SCHEMA) {
        verifyCalls++;
        if (verifyCalls === 1) throw new HttpException({ statusCode: 503, error: 'upstream' }, 503);
        return { pass: true, mismatches: [] };
      }
      return structuredFor(opts.outputSchema);
    });
    const svc = await build(deps);
    const out = await svc.generate(DAY as any);
    expect(verifyCalls).toBe(2); // one transient failure + one success
    expect(out.verified).toBe(true);
  });

  it('gives up after MAX_ATTEMPTS transient failures and rethrows the last error', async () => {
    const deps = makeDeps();
    let verifyCalls = 0;
    deps.anthropic.messageStructured.mockImplementation(async (_i: any, opts: any) => {
      if (opts.outputSchema === VERIFY_SCHEMA) {
        verifyCalls++;
        throw new HttpException({ statusCode: 503, error: 'upstream' }, 503);
      }
      return structuredFor(opts.outputSchema);
    });
    const svc = await build(deps);
    await expect(svc.generate(DAY as any)).rejects.toBeInstanceOf(HttpException);
    expect(verifyCalls).toBe(3); // bounded at MAX_ATTEMPTS — no unbounded retry
  });

  it('does NOT retry a 422 refusal — it propagates so ensureKeys can skip the day', async () => {
    const deps = makeDeps();
    let currentCalls = 0;
    deps.anthropic.messageStructured.mockImplementation(async (_i: any, opts: any) => {
      if (opts.outputSchema === CURRENT_SCHEMA) {
        currentCalls++;
        throw new HttpException({ statusCode: 422, error: 'refused' }, 422);
      }
      return structuredFor(opts.outputSchema);
    });
    const svc = await build(deps);
    await expect(svc.generate(DAY as any)).rejects.toBeInstanceOf(HttpException);
    expect(currentCalls).toBe(1); // refusal is deterministic — no retry
  });

  it('reports lookbackMissing for a recent prior complete day that has no KEYS', async () => {
    const deps = makeDeps();
    deps.inputs.priorCompleteDays.mockReturnValue([
      { day: '07012026', date: '2026-07-01' },
      { day: '07022026', date: '2026-07-02' },
      { day: '07032026', date: '2026-07-03' },
    ]);
    // 0702's generation failed earlier in the run, so it has no KEYS.
    deps.repo.getDayArtifact.mockImplementation(async (d: string, kind: string) =>
      kind === 'keys' && d !== '07022026' ? { content: `K-${d}` } : null,
    );
    const svc = await build(deps);
    const out = await svc.generate(DAY as any);
    expect(out.lookbackMissing).toEqual(['07022026']);
    expect(out.lookbackSources).toEqual(['07012026_ES_KEYS.md', '07032026_ES_KEYS.md']);
  });
});
