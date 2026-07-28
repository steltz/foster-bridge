jest.mock('node:fs', () => ({ ...jest.requireActual('node:fs'), readFileSync: jest.fn() }));

import { Test } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { ConfigService } from '@nestjs/config';
import { SevenKeysService } from './seven-keys.service';
import { BenchmarkRepository } from '../benchmark.repository';
import { RepoInputsService } from '../repo-inputs.service';
import { DayArtifactsService } from '../day-artifacts.service';
import { AnthropicLlmProvider } from '../../anthropic/anthropic.service';
import { CURRENT_SCHEMA, LOOKBACK_SCHEMA, SYNTH_SCHEMA, VERIFY_SCHEMA } from './schemas';

const DAY = {
  day: '07082026',
  date: '2026-07-08',
  prefix: '07082026',
  pdfPath: '/es/07082026/07082026_ES_TP.pdf',
  planPath: '/es/07082026/07082026_ES_TP.md',
  recapPath: '/es/07082026/07012026_ES_RECAP.md',
};

// messageStructuredLegacy stub: canned output keyed on the schema's required fields.
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
  const anthropic = { messageStructuredLegacy: jest.fn(async (_i: any, _attr: any, opts: any) => structuredFor(opts.outputSchema)) };
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
      { provide: AnthropicLlmProvider, useValue: deps.anthropic },
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
    const schemas = deps.anthropic.messageStructuredLegacy.mock.calls.map((c) => c[2].outputSchema);
    expect(schemas).toContain(CURRENT_SCHEMA);
    expect(schemas).toContain(SYNTH_SCHEMA);
    expect(schemas).toContain(VERIFY_SCHEMA);
    expect(schemas).not.toContain(LOOKBACK_SCHEMA); // no prior KEYS -> bootstrap
    // Current-day is explicitly pinned to Fable and carries the PDF (files:true).
    const currentCall = deps.anthropic.messageStructuredLegacy.mock.calls.find((c) => c[2].outputSchema === CURRENT_SCHEMA)!;
    expect(currentCall[2].model).toBe('claude-fable-5');
    expect(currentCall[2].files).toBe(true);
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
    const lookbackCall = deps.anthropic.messageStructuredLegacy.mock.calls.find((c) => c[2].outputSchema === LOOKBACK_SCHEMA)!;
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
    deps.anthropic.messageStructuredLegacy.mockImplementation(async (_i: any, _attr: any, opts: any) =>
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
    const calls = deps.anthropic.messageStructuredLegacy.mock.calls;
    const synthIdx = calls.findIndex((c) => c[2].outputSchema === SYNTH_SCHEMA);
    const verifyIdx = calls.findIndex((c) => c[2].outputSchema === VERIFY_SCHEMA);
    expect(synthIdx).toBeLessThan(verifyIdx);
    expect(calls[verifyIdx][0].prompt).toContain('# Seven Keys — ES 2026-07-08');
  });

  it('retries a transient upstream failure (503) on the verify step, then succeeds', async () => {
    const deps = makeDeps();
    let verifyCalls = 0;
    deps.anthropic.messageStructuredLegacy.mockImplementation(async (_i: any, _attr: any, opts: any) => {
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
    deps.anthropic.messageStructuredLegacy.mockImplementation(async (_i: any, _attr: any, opts: any) => {
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
    deps.anthropic.messageStructuredLegacy.mockImplementation(async (_i: any, _attr: any, opts: any) => {
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
