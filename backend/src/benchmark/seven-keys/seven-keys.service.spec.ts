jest.mock('node:fs', () => ({ ...jest.requireActual('node:fs'), readFileSync: jest.fn() }));

import { Test } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { ConfigService } from '@nestjs/config';
import { SevenKeysService } from './seven-keys.service';
import { BenchmarkRepository } from '../benchmark.repository';
import { RepoInputsService } from '../repo-inputs.service';
import { DayArtifactsService } from '../day-artifacts.service';
import { FakeLlmProvider } from '../../llm/fake-llm.provider';
import { LLM_PROVIDER } from '../../llm/llm.constants';
import { CURRENT_SCHEMA, LOOKBACK_SCHEMA, SYNTH_SCHEMA, VERIFY_SCHEMA } from './schemas';

const DAY = {
  day: '07082026',
  date: '2026-07-08',
  prefix: '07082026',
  pdfPath: '/es/07082026/07082026_ES_TP.pdf',
  planPath: '/es/07082026/07082026_ES_TP.md',
  recapPath: '/es/07082026/07012026_ES_RECAP.md',
};

// Canned outputs keyed on the schema's required fields (mirrors the fake's
// call-order queue below).
const CURRENT_RESULT = { bias: 'b', environment: 'e', zones: [{ prices: '7500-7510', side: 'support', key3: 'a', key4: 'b', key5: 'c', key6: 'd', key7: 'e', grade: 'strong' }] };
const LOOKBACK_RESULT = { calibration: [{ day: '07012026', verdict: 'held' }], continuity: ['x'] };
const SYNTH_RESULT = { artifact: '# Seven Keys — ES 2026-07-08\n\n| row |' };
const VERIFY_RESULT = { pass: true, mismatches: [] };

function structuredFor(schema: any): any {
  const req: string[] = schema.required;
  if (req.includes('zones')) return CURRENT_RESULT;
  if (req.includes('calibration')) return LOOKBACK_RESULT;
  if (req.includes('artifact')) return SYNTH_RESULT;
  if (req.includes('pass')) return VERIFY_RESULT;
  return {};
}

// Queues canned structuredResponses in the order the fake will consume them.
// current-day and lookback are launched via Promise.all, but the fake shifts
// structuredResponses synchronously in invocation order (current-day is
// constructed first in the source, so its promise executor runs first), so
// the queue order is [current, lookback, synth, verify]. When there is no
// lookback set (bootstrap), only [current, synth, verify] are consumed.
function queueGenerationRun(fake: FakeLlmProvider, opts?: { lookback?: boolean }) {
  fake.structuredResponses.push(CURRENT_RESULT);
  if (opts?.lookback !== false) fake.structuredResponses.push(LOOKBACK_RESULT);
  fake.structuredResponses.push(SYNTH_RESULT);
  fake.structuredResponses.push(VERIFY_RESULT);
}

function findCall(fake: FakeLlmProvider, schema: any) {
  return fake.structuredCalls.find((c) => c.req.schema === schema)!;
}

function makeDeps() {
  const fake = new FakeLlmProvider();
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
  return { fake, repo, inputs, dayArtifacts };
}

async function build(deps: ReturnType<typeof makeDeps>) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      SevenKeysService,
      { provide: LLM_PROVIDER, useValue: deps.fake },
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
    queueGenerationRun(deps.fake, { lookback: false });
    const svc = await build(deps);
    const out = await svc.generate(DAY as any);
    const schemas = deps.fake.structuredCalls.map((c) => c.req.schema);
    expect(schemas).toContain(CURRENT_SCHEMA);
    expect(schemas).toContain(SYNTH_SCHEMA);
    expect(schemas).toContain(VERIFY_SCHEMA);
    expect(schemas).not.toContain(LOOKBACK_SCHEMA); // no prior KEYS -> bootstrap
    // Current-day is explicitly pinned to Fable and carries the PDF via envelope.
    const currentCall = findCall(deps.fake, CURRENT_SCHEMA);
    expect(currentCall.req.model).toBe('claude-fable-5');
    expect(currentCall.req.effort).toBe('high');
    expect(currentCall.req.maxTokens).toBe(32000);
    expect(currentCall.req.envelope?.tiers).toContainEqual(
      expect.objectContaining({ blocks: expect.arrayContaining([{ type: 'file', fileId: 'file_1' }]) }),
    );
    // Verify also carries the PDF via envelope (pdfContext), mirroring current-day.
    const verifyCall = findCall(deps.fake, VERIFY_SCHEMA);
    expect(verifyCall.req.envelope?.tiers).toContainEqual(
      expect.objectContaining({ blocks: expect.arrayContaining([{ type: 'file', fileId: 'file_1' }]) }),
    );
    expect(out).toEqual({ verified: true, mismatches: [], artifact: '# Seven Keys — ES 2026-07-08\n\n| row |', lookbackSources: [], lookbackMissing: [] });
  });

  it('runs the lookback agent oldest-first when prior KEYS exist, and reports sources oldest-first', async () => {
    const deps = makeDeps();
    queueGenerationRun(deps.fake);
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
    const lookbackCall = findCall(deps.fake, LOOKBACK_SCHEMA);
    expect(lookbackCall.req.prompt.indexOf('07012026')).toBeLessThan(lookbackCall.req.prompt.indexOf('07022026'));
    expect(out.lookbackSources).toEqual(['07012026_ES_KEYS.md', '07022026_ES_KEYS.md']);
  });

  it('caps the lookback set to the 3 most recent prior KEYS days (still oldest-first)', async () => {
    const deps = makeDeps();
    queueGenerationRun(deps.fake);
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
    jest.spyOn(deps.fake, 'messageStructured').mockImplementation(async (req: any, attribution: any) => {
      deps.fake.structuredCalls.push({ req, attribution });
      return req.schema === VERIFY_SCHEMA ? { pass: false, mismatches: ['invented 7999'] } : structuredFor(req.schema);
    });
    const svc = await build(deps);
    const out = await svc.generate(DAY as any);
    expect(out.verified).toBe(false);
    expect(out.mismatches).toEqual(['invented 7999']);
  });

  it('verify runs after synth and embeds the synthesized artifact', async () => {
    const deps = makeDeps();
    queueGenerationRun(deps.fake, { lookback: false });
    const svc = await build(deps);
    await svc.generate(DAY as any);
    const calls = deps.fake.structuredCalls;
    const synthIdx = calls.findIndex((c) => c.req.schema === SYNTH_SCHEMA);
    const verifyIdx = calls.findIndex((c) => c.req.schema === VERIFY_SCHEMA);
    expect(synthIdx).toBeLessThan(verifyIdx);
    expect(calls[verifyIdx].req.prompt).toContain('# Seven Keys — ES 2026-07-08');
  });

  it('retries a transient upstream failure (503) on the verify step, then succeeds', async () => {
    const deps = makeDeps();
    let verifyCalls = 0;
    jest.spyOn(deps.fake, 'messageStructured').mockImplementation(async (req: any, attribution: any) => {
      deps.fake.structuredCalls.push({ req, attribution });
      if (req.schema === VERIFY_SCHEMA) {
        verifyCalls++;
        if (verifyCalls === 1) throw new HttpException({ statusCode: 503, error: 'upstream' }, 503);
        return VERIFY_RESULT;
      }
      return structuredFor(req.schema);
    });
    const svc = await build(deps);
    const out = await svc.generate(DAY as any);
    expect(verifyCalls).toBe(2); // one transient failure + one success
    expect(out.verified).toBe(true);
  });

  it('gives up after MAX_ATTEMPTS transient failures and rethrows the last error', async () => {
    const deps = makeDeps();
    let verifyCalls = 0;
    jest.spyOn(deps.fake, 'messageStructured').mockImplementation(async (req: any, attribution: any) => {
      deps.fake.structuredCalls.push({ req, attribution });
      if (req.schema === VERIFY_SCHEMA) {
        verifyCalls++;
        throw new HttpException({ statusCode: 503, error: 'upstream' }, 503);
      }
      return structuredFor(req.schema);
    });
    const svc = await build(deps);
    await expect(svc.generate(DAY as any)).rejects.toBeInstanceOf(HttpException);
    expect(verifyCalls).toBe(3); // bounded at MAX_ATTEMPTS — no unbounded retry
  });

  it('does NOT retry a 422 refusal — it propagates so ensureKeys can skip the day', async () => {
    const deps = makeDeps();
    let currentCalls = 0;
    jest.spyOn(deps.fake, 'messageStructured').mockImplementation(async (req: any, attribution: any) => {
      deps.fake.structuredCalls.push({ req, attribution });
      if (req.schema === CURRENT_SCHEMA) {
        currentCalls++;
        throw new HttpException({ statusCode: 422, error: 'refused' }, 422);
      }
      return structuredFor(req.schema);
    });
    const svc = await build(deps);
    await expect(svc.generate(DAY as any)).rejects.toBeInstanceOf(HttpException);
    expect(currentCalls).toBe(1); // refusal is deterministic — no retry
  });

  it('reports lookbackMissing for a recent prior complete day that has no KEYS', async () => {
    const deps = makeDeps();
    queueGenerationRun(deps.fake);
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

describe('SevenKeysService.ensureKeys', () => {
  // computeInputsHash reads the day's files; give readFileSync a stable impl here
  // too (the generate describe's beforeEach doesn't apply to this block).
  beforeEach(() => {
    (readFileSync as jest.Mock).mockImplementation((p: string) => (String(p).includes('RECAP') ? 'RECAP' : 'TP'));
  });

  it('is immutable once benchmarked: reuses stored KEYS, never regenerates, even on force', async () => {
    const deps = makeDeps();
    const existing = { contentHash: 'kh', gcsPath: 'p', content: '# stored', uploadedAt: 't', verified: true } as any;
    deps.repo.getDayArtifact.mockImplementation(async (_d: string, kind: string) => (kind === 'keys' ? existing : null));
    deps.repo.hasScorecardCells.mockResolvedValue(true); // a scorecard cell pinned this artifact
    const svc = await build(deps);
    const genSpy = jest.spyOn(svc, 'generate');
    expect(await svc.ensureKeys(DAY as any)).toBe(existing);
    expect(await svc.ensureKeys(DAY as any, { force: true })).toBe(existing); // force cannot override immutability
    expect(genSpy).not.toHaveBeenCalled();
  });

  it('benchmarked anomaly: refuses to regenerate (returns null) when cells exist but the KEYS artifact is missing', async () => {
    const deps = makeDeps();
    deps.repo.hasScorecardCells.mockResolvedValue(true); // day is benchmarked
    deps.repo.getDayArtifact.mockImplementation(async () => null); // but the KEYS doc is gone
    const svc = await build(deps);
    const genSpy = jest.spyOn(svc, 'generate');
    const out = await svc.ensureKeys(DAY as any);
    expect(out).toBeNull();
    expect(genSpy).not.toHaveBeenCalled(); // never regenerate — would break pinned artifactSha256
    expect(deps.repo.saveDayArtifact).not.toHaveBeenCalled();
  });

  it('reuses a verified artifact when the generation inputs are unchanged (not yet benchmarked)', async () => {
    const deps = makeDeps();
    deps.repo.hasScorecardCells.mockResolvedValue(false);
    const svc = await build(deps);
    const inputsHash = (svc as any).computeInputsHash(DAY); // same inputs the impl will hash
    const existing = { contentHash: 'kh', gcsPath: 'p', content: '# stored', uploadedAt: 't', verified: true, inputsHash } as any;
    deps.repo.getDayArtifact.mockImplementation(async (_d: string, kind: string) => (kind === 'keys' ? existing : null));
    const genSpy = jest.spyOn(svc, 'generate');
    expect(await svc.ensureKeys(DAY as any)).toBe(existing);
    expect(genSpy).not.toHaveBeenCalled();
  });

  it('regenerates when the trade plan changed (inputsHash drift) on a not-yet-benchmarked day', async () => {
    const deps = makeDeps();
    deps.repo.hasScorecardCells.mockResolvedValue(false);
    const existing = { contentHash: 'kh', gcsPath: 'p', content: '# stale', uploadedAt: 't', verified: true, inputsHash: 'OLD' } as any;
    deps.repo.getDayArtifact.mockImplementation(async (_d: string, kind: string) => (kind === 'keys' ? existing : null));
    const svc = await build(deps);
    jest.spyOn(svc, 'generate').mockResolvedValue({ verified: true, artifact: '# fresh', mismatches: [], lookbackSources: [], lookbackMissing: [] });
    const out = await svc.ensureKeys(DAY as any);
    expect(deps.repo.saveDayArtifact).toHaveBeenCalled();
    expect(out!.content).toContain('# fresh');
  });

  it('regenerates a not-yet-benchmarked day when force is set even if inputs are unchanged', async () => {
    const deps = makeDeps();
    deps.repo.hasScorecardCells.mockResolvedValue(false);
    const svc = await build(deps);
    const inputsHash = (svc as any).computeInputsHash(DAY);
    const existing = { contentHash: 'kh', gcsPath: 'p', content: '# stored', uploadedAt: 't', verified: true, inputsHash } as any;
    deps.repo.getDayArtifact.mockImplementation(async (_d: string, kind: string) => (kind === 'keys' ? existing : null));
    jest.spyOn(svc, 'generate').mockResolvedValue({ verified: true, artifact: '# forced', mismatches: [], lookbackSources: [], lookbackMissing: [] });
    const out = await svc.ensureKeys(DAY as any, { force: true });
    expect(out!.content).toContain('# forced');
  });

  it('generates + persists a verified artifact with frontmatter provenance + inputsHash', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    jest.spyOn(svc, 'generate').mockResolvedValue({
      verified: true,
      artifact: '# Seven Keys — ES 2026-07-08\n\n| row |',
      mismatches: [],
      lookbackSources: ['07012026_ES_KEYS.md'],
      lookbackMissing: [],
    });
    const out = await svc.ensureKeys(DAY as any);
    expect(deps.repo.saveDayArtifact).toHaveBeenCalledWith('07082026', 'keys', expect.objectContaining({
      generatedBy: 'claude-fable-5',
      verified: true,
      lookbackSources: ['07012026_ES_KEYS.md'],
    }));
    const doc = deps.repo.saveDayArtifact.mock.calls[0][2];
    expect(doc.content).toContain('generatedBy: claude-fable-5');
    expect(doc.content).toContain('lookbackSources: [07012026_ES_KEYS.md]');
    expect(doc.content).toContain('# Seven Keys — ES 2026-07-08');
    expect(doc.contentHash).toHaveLength(64);
    expect(doc.inputsHash).toHaveLength(64);
    expect(out).toBe(doc);
  });

  it('surfaces a reduced lookback (logs) but still persists when lookbackMissing is non-empty', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    jest.spyOn(svc, 'generate').mockResolvedValue({ verified: true, artifact: '# k', mismatches: [], lookbackSources: [], lookbackMissing: ['07022026'] });
    const warn = jest.spyOn((svc as any).logger, 'warn');
    const out = await svc.ensureKeys(DAY as any);
    expect(out).not.toBeNull();
    expect(out!.lookbackMissing).toEqual(['07022026']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('07022026'));
  });

  it('returns null and does NOT persist when the verifier fails', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    jest.spyOn(svc, 'generate').mockResolvedValue({ verified: false, artifact: 'x', mismatches: ['bad'], lookbackSources: [], lookbackMissing: [] });
    const out = await svc.ensureKeys(DAY as any);
    expect(out).toBeNull();
    expect(deps.repo.saveDayArtifact).not.toHaveBeenCalled();
  });

  it('returns null and does NOT persist when generation throws (e.g. Fable refusal)', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    jest.spyOn(svc, 'generate').mockRejectedValue(new Error('refused'));
    const out = await svc.ensureKeys(DAY as any);
    expect(out).toBeNull();
    expect(deps.repo.saveDayArtifact).not.toHaveBeenCalled();
  });

  it('is immutable when pinned by in-flight cells: reuses stored KEYS, never regenerates, even under force and inputsHash drift', async () => {
    const deps = makeDeps();
    deps.repo.hasScorecardCells.mockResolvedValue(false); // NOT yet persisted-benchmarked
    // Existing verified doc whose inputsHash no longer matches (would normally force
    // regeneration on the not-benchmarked path) — pinned must still freeze it.
    const existing = { contentHash: 'kh', gcsPath: 'p', content: '# stored', uploadedAt: 't', verified: true, inputsHash: 'OLD' } as any;
    deps.repo.getDayArtifact.mockImplementation(async (_d: string, kind: string) => (kind === 'keys' ? existing : null));
    const svc = await build(deps);
    const genSpy = jest.spyOn(svc, 'generate');
    expect(await svc.ensureKeys(DAY as any, { pinned: true })).toBe(existing);
    expect(await svc.ensureKeys(DAY as any, { force: true, pinned: true })).toBe(existing);
    expect(genSpy).not.toHaveBeenCalled(); // in-flight cells pinned this hash — never regenerate
    expect(deps.repo.saveDayArtifact).not.toHaveBeenCalled();
  });

  it('pinned anomaly: refuses to regenerate (returns null) when pinned but the KEYS artifact is missing', async () => {
    const deps = makeDeps();
    deps.repo.hasScorecardCells.mockResolvedValue(false); // no persisted cells
    deps.repo.getDayArtifact.mockImplementation(async () => null); // but the KEYS doc is gone
    const svc = await build(deps);
    const genSpy = jest.spyOn(svc, 'generate');
    const out = await svc.ensureKeys(DAY as any, { pinned: true });
    expect(out).toBeNull();
    expect(genSpy).not.toHaveBeenCalled(); // never regenerate — would break in-flight artifactSha256
    expect(deps.repo.saveDayArtifact).not.toHaveBeenCalled();
  });
});
