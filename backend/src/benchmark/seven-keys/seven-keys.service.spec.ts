import { Test } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { KeysFailure, SevenKeysService } from './seven-keys.service';
import { BenchmarkRepository } from '../benchmark.repository';
import { CloudInputsService, DayInput, InputsSnapshot } from '../cloud-inputs.service';
import { DayArtifactsService } from '../day-artifacts.service';
import { FakeLlmProvider } from '../../llm/fake-llm.provider';
import { LLM_PROVIDER } from '../../llm/llm.constants';
import { CURRENT_SCHEMA, LOOKBACK_SCHEMA, SYNTH_SCHEMA, VERIFY_SCHEMA } from './schemas';

// Content-bearing day: generation and hashing consume these in-memory values —
// no filesystem reads anywhere.
const DAY: DayInput = {
  day: '07082026',
  date: '2026-07-08',
  prefix: '07082026',
  recapDate: '07012026',
  fileSha256: { tradePlanMd: 'x', tradePlanPdf: 'y', recap: 'z' },
  pdf: Buffer.from('PDF'),
  tpTranscript: 'TP',
  recapTranscript: 'RECAP',
  recapFileName: '07012026_ES_RECAP.md',
};

const SNAP: InputsSnapshot = {
  traders: [],
  features: [],
  general: { files: [], concatenated: 'GEN', sha256: 'g' },
  methodsDoc: 'METHODS',
  days: [],
  issues: [],
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
    // Per-flagship keys lineage reads/writes (getKeysArtifact applies the legacy
    // `${day}__keys` fallback internally in the real repo).
    getKeysArtifact: jest.fn().mockResolvedValue(null),
    saveKeysArtifact: jest.fn().mockResolvedValue(undefined),
    // artifactSha256 values pinned by the day's scorecard cells (any model).
    pinnedKeysHashes: jest.fn().mockResolvedValue(new Set<string>()),
    // Legacy unscoped doc, read directly only by the orphaned-pin anomaly check.
    getDayArtifact: jest.fn().mockResolvedValue(null),
  };
  const inputs = {
    priorCompleteDays: jest.fn().mockReturnValue([]), // sync + pure over the snapshot
    outcomeRecapForDay: jest.fn().mockResolvedValue(null),
  };
  const dayArtifacts = { ensureFileId: jest.fn().mockResolvedValue('file_1') };
  return { fake, repo, inputs, dayArtifacts };
}

// configOverrides layers on top of the { 'benchmark.effort': 'high' } default so
// individual tests can pin e.g. 'benchmark.model' without hand-rolling a new
// ConfigService stub each time.
async function build(deps: ReturnType<typeof makeDeps>, configOverrides: Record<string, unknown> = {}) {
  const config: Record<string, unknown> = { 'benchmark.effort': 'high', ...configOverrides };
  const moduleRef = await Test.createTestingModule({
    providers: [
      SevenKeysService,
      { provide: LLM_PROVIDER, useValue: deps.fake },
      { provide: BenchmarkRepository, useValue: deps.repo },
      { provide: CloudInputsService, useValue: deps.inputs },
      { provide: DayArtifactsService, useValue: deps.dayArtifacts },
      { provide: ConfigService, useValue: { get: (k: string) => config[k] } },
    ],
  }).compile();
  return moduleRef.get(SevenKeysService);
}

describe('SevenKeysService.generate', () => {
  it('bootstrap: skips the lookback agent and runs current(config-derived flagship) -> synth -> verify', async () => {
    const deps = makeDeps();
    queueGenerationRun(deps.fake, { lookback: false });
    const svc = await build(deps);
    const out = await svc.generate(DAY, SNAP);
    const schemas = deps.fake.structuredCalls.map((c) => c.req.schema);
    expect(schemas).toContain(CURRENT_SCHEMA);
    expect(schemas).toContain(SYNTH_SCHEMA);
    expect(schemas).toContain(VERIFY_SCHEMA);
    expect(schemas).not.toContain(LOOKBACK_SCHEMA); // no prior KEYS -> bootstrap
    // Prior days are filtered from the run snapshot — sync, no I/O.
    expect(deps.inputs.priorCompleteDays).toHaveBeenCalledWith(DAY.day, SNAP);
    // Current-day runs on the config-derived flagship (default: claude-fable-5) and carries the PDF via envelope.
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

  it('rejects when the snapshot has no methods doc', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    await expect(svc.generate(DAY, { ...SNAP, methodsDoc: null })).rejects.toThrow(
      `Seven-keys methods doc missing (day ${DAY.day})`,
    );
    expect(deps.fake.structuredCalls).toHaveLength(0); // fails before any flagship spend
  });

  it('threads benchmark.model through resolveModel to every call, including lookback (config -> model wiring)', async () => {
    const deps = makeDeps();
    queueGenerationRun(deps.fake); // includes lookback
    deps.inputs.priorCompleteDays.mockReturnValue([{ day: '07012026', date: '2026-07-01' }]);
    deps.repo.getKeysArtifact.mockImplementation(async (d: string) => ({ content: `KEYS-${d}` }));
    const svc = await build(deps, { 'benchmark.model': 'k3' });
    await svc.generate(DAY, SNAP);
    expect(deps.fake.structuredCalls.length).toBe(4); // current, lookback, synth, verify
    for (const call of deps.fake.structuredCalls) {
      expect(call.req.model).toBe('kimi-k3');
      expect(call.attribution.benchmark?.modelAlias).toBe('k3');
    }
  });

  it('runs the lookback agent oldest-first when prior KEYS exist, and reports sources oldest-first', async () => {
    const deps = makeDeps();
    queueGenerationRun(deps.fake);
    deps.inputs.priorCompleteDays.mockReturnValue([
      { day: '07012026', date: '2026-07-01' },
      { day: '07022026', date: '2026-07-02' },
    ]);
    deps.repo.getKeysArtifact.mockImplementation(async (d: string) => ({ content: `KEYS-${d}` }));
    deps.inputs.outcomeRecapForDay.mockResolvedValue('OUTCOME-RECAP');
    const svc = await build(deps);
    const out = await svc.generate(DAY, SNAP);
    const lookbackCall = findCall(deps.fake, LOOKBACK_SCHEMA);
    expect(lookbackCall.req.prompt.indexOf('07012026')).toBeLessThan(lookbackCall.req.prompt.indexOf('07022026'));
    // Outcome recaps resolve through the snapshot (committed listings only).
    expect(deps.inputs.outcomeRecapForDay).toHaveBeenCalledWith('07012026', SNAP);
    expect(lookbackCall.req.prompt).toContain('OUTCOME-RECAP');
    expect(out.lookbackSources).toEqual(['07012026_ES_KEYS.md', '07022026_ES_KEYS.md']);
    // Lookback reads the SAME lineage the flagship writes — Kimi never
    // calibrates against Fable's prior assessments.
    expect(deps.repo.getKeysArtifact).toHaveBeenCalledWith('07012026', 'fable');
  });

  it('caps the lookback set to the 3 most recent prior KEYS days (still oldest-first)', async () => {
    const deps = makeDeps();
    queueGenerationRun(deps.fake);
    deps.inputs.priorCompleteDays.mockReturnValue(
      ['07012026', '07022026', '07032026', '07042026'].map((day) => ({ day, date: `2026-07-0${day[1]}` })),
    );
    deps.repo.getKeysArtifact.mockImplementation(async (d: string) => ({ content: `K-${d}` }));
    const svc = await build(deps);
    const out = await svc.generate(DAY, SNAP);
    expect(out.lookbackSources).toEqual(['07022026_ES_KEYS.md', '07032026_ES_KEYS.md', '07042026_ES_KEYS.md']);
  });

  it('verifier fail -> verified:false with mismatches, no persistence attempted here', async () => {
    const deps = makeDeps();
    jest.spyOn(deps.fake, 'messageStructured').mockImplementation(async (req: any, attribution: any) => {
      deps.fake.structuredCalls.push({ req, attribution });
      return req.schema === VERIFY_SCHEMA ? { pass: false, mismatches: ['invented 7999'] } : structuredFor(req.schema);
    });
    const svc = await build(deps);
    const out = await svc.generate(DAY, SNAP);
    expect(out.verified).toBe(false);
    expect(out.mismatches).toEqual(['invented 7999']);
  });

  it('verify runs after synth and embeds the synthesized artifact', async () => {
    const deps = makeDeps();
    queueGenerationRun(deps.fake, { lookback: false });
    const svc = await build(deps);
    await svc.generate(DAY, SNAP);
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
    const out = await svc.generate(DAY, SNAP);
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
    await expect(svc.generate(DAY, SNAP)).rejects.toBeInstanceOf(HttpException);
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
    await expect(svc.generate(DAY, SNAP)).rejects.toBeInstanceOf(HttpException);
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
    deps.repo.getKeysArtifact.mockImplementation(async (d: string) =>
      d !== '07022026' ? { content: `K-${d}` } : null,
    );
    const svc = await build(deps);
    const out = await svc.generate(DAY, SNAP);
    expect(out.lookbackMissing).toEqual(['07022026']);
    expect(out.lookbackSources).toEqual(['07012026_ES_KEYS.md', '07032026_ES_KEYS.md']);
  });
});

describe('SevenKeysService.ensureKeys', () => {
  it('is immutable once benchmarked: reuses stored KEYS when a cell pinned ITS hash, never regenerates, even on force', async () => {
    const deps = makeDeps();
    const existing = { contentHash: 'kh', gcsPath: 'p', content: '# stored', uploadedAt: 't', verified: true } as any;
    deps.repo.getKeysArtifact.mockResolvedValue(existing);
    deps.repo.pinnedKeysHashes.mockResolvedValue(new Set(['kh'])); // a scorecard cell pinned this artifact
    const svc = await build(deps);
    const genSpy = jest.spyOn(svc, 'generate');
    expect(await svc.ensureKeys(DAY, SNAP)).toBe(existing);
    expect(await svc.ensureKeys(DAY, SNAP, { force: true })).toBe(existing); // force cannot override immutability
    expect(genSpy).not.toHaveBeenCalled();
  });

  it('generates a fresh lineage when the day was benchmarked only by ANOTHER flagship', async () => {
    const deps = makeDeps();
    // Fable's legacy doc exists and is pinned by Fable-era cells; the Kimi
    // lineage has no artifact yet. Kimi must generate its own, not reuse or refuse.
    deps.repo.getKeysArtifact.mockResolvedValue(null); // no doc for alias k3
    deps.repo.getDayArtifact.mockResolvedValue({ contentHash: 'fable-kh', content: '# fable', generatedBy: 'claude-fable-5' });
    deps.repo.pinnedKeysHashes.mockResolvedValue(new Set(['fable-kh'])); // pins all accounted for by the legacy doc
    const svc = await build(deps, { 'benchmark.model': 'kimi-k3' });
    jest.spyOn(svc, 'generate').mockResolvedValue({ verified: true, artifact: '# kimi fresh', mismatches: [], lookbackSources: [], lookbackMissing: [] });
    const out = await svc.ensureKeys(DAY, SNAP);
    expect(out).not.toBeNull();
    expect(out!.generatedBy).toBe('kimi-k3');
    // persisted under the k3 lineage, never the legacy id
    expect(deps.repo.saveKeysArtifact).toHaveBeenCalledWith(DAY.day, 'k3', expect.objectContaining({ generatedBy: 'kimi-k3' }));
    expect(out!.gcsPath).toContain('_ES_KEYS.k3.md');
  });

  it('orphaned-pin anomaly: refuses to generate when cells pinned a hash no stored doc accounts for', async () => {
    const deps = makeDeps();
    deps.repo.getKeysArtifact.mockResolvedValue(null); // our lineage's doc is gone
    deps.repo.getDayArtifact.mockResolvedValue(null); // and no legacy doc explains the pin
    deps.repo.pinnedKeysHashes.mockResolvedValue(new Set(['dangling-kh']));
    const svc = await build(deps);
    const genSpy = jest.spyOn(svc, 'generate');
    const out = await svc.ensureKeys(DAY, SNAP);
    expect(out).toBeNull();
    expect(genSpy).not.toHaveBeenCalled(); // never regenerate — would bury the broken provenance
    expect(deps.repo.saveKeysArtifact).not.toHaveBeenCalled();
  });

  it('computeInputsHash: NUL-separated sha256 over the SAME in-memory values generation consumes', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    const SEP = String.fromCharCode(0);
    const expected = createHash('sha256')
      .update(DAY.pdf)
      .update(SEP)
      .update(DAY.tpTranscript)
      .update(SEP)
      .update(DAY.recapTranscript)
      .update(SEP)
      .update('METHODS')
      .digest('hex');
    expect((svc as any).computeInputsHash(DAY, 'METHODS')).toBe(expected);
    // Pure: methods doc is a parameter, so a different doc changes the hash.
    expect((svc as any).computeInputsHash(DAY, 'OTHER')).not.toBe(expected);
  });

  it('reuses a verified artifact when the generation inputs are unchanged (not yet benchmarked)', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    const inputsHash = (svc as any).computeInputsHash(DAY, 'METHODS'); // same inputs the impl will hash
    const existing = { contentHash: 'kh', gcsPath: 'p', content: '# stored', uploadedAt: 't', verified: true, inputsHash } as any;
    deps.repo.getKeysArtifact.mockResolvedValue(existing);
    const genSpy = jest.spyOn(svc, 'generate');
    expect(await svc.ensureKeys(DAY, SNAP)).toBe(existing);
    expect(genSpy).not.toHaveBeenCalled();
  });

  it('regenerates when the trade plan changed (inputsHash drift) on a not-yet-benchmarked day', async () => {
    const deps = makeDeps();
    const existing = { contentHash: 'kh', gcsPath: 'p', content: '# stale', uploadedAt: 't', verified: true, inputsHash: 'OLD' } as any;
    deps.repo.getKeysArtifact.mockResolvedValue(existing);
    const svc = await build(deps);
    jest.spyOn(svc, 'generate').mockResolvedValue({ verified: true, artifact: '# fresh', mismatches: [], lookbackSources: [], lookbackMissing: [] });
    const out = await svc.ensureKeys(DAY, SNAP);
    expect(deps.repo.saveKeysArtifact).toHaveBeenCalledWith(DAY.day, 'fable', expect.anything());
    expect(out!.content).toContain('# fresh');
  });

  it('regenerates a not-yet-benchmarked day when force is set even if inputs are unchanged', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    const inputsHash = (svc as any).computeInputsHash(DAY, 'METHODS');
    const existing = { contentHash: 'kh', gcsPath: 'p', content: '# stored', uploadedAt: 't', verified: true, inputsHash } as any;
    deps.repo.getKeysArtifact.mockResolvedValue(existing);
    jest.spyOn(svc, 'generate').mockResolvedValue({ verified: true, artifact: '# forced', mismatches: [], lookbackSources: [], lookbackMissing: [] });
    const out = await svc.ensureKeys(DAY, SNAP, { force: true });
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
    const out = await svc.ensureKeys(DAY, SNAP);
    expect(deps.repo.saveKeysArtifact).toHaveBeenCalledWith('07082026', 'fable', expect.objectContaining({
      generatedBy: 'claude-fable-5',
      verified: true,
      lookbackSources: ['07012026_ES_KEYS.md'],
    }));
    const doc = deps.repo.saveKeysArtifact.mock.calls[0][2];
    expect(doc.content).toContain('generatedBy: claude-fable-5');
    expect(doc.content).toContain('lookbackSources: [07012026_ES_KEYS.md]');
    expect(doc.content).toContain('# Seven Keys — ES 2026-07-08');
    expect(doc.gcsPath).toContain('_ES_KEYS.fable.md'); // lineage-marked path
    expect(doc.contentHash).toHaveLength(64);
    expect(doc.inputsHash).toHaveLength(64);
    // The persisted inputsHash is the pure hash over the day's in-memory values +
    // the snapshot's methods doc — never a second fetch.
    expect(doc.inputsHash).toBe((svc as any).computeInputsHash(DAY, 'METHODS'));
    expect(out).toBe(doc);
  });

  it('surfaces a reduced lookback (logs) but still persists when lookbackMissing is non-empty', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    jest.spyOn(svc, 'generate').mockResolvedValue({ verified: true, artifact: '# k', mismatches: [], lookbackSources: [], lookbackMissing: ['07022026'] });
    const warn = jest.spyOn((svc as any).logger, 'warn');
    const out = await svc.ensureKeys(DAY, SNAP);
    expect(out).not.toBeNull();
    expect(out!.lookbackMissing).toEqual(['07022026']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('07022026'));
  });

  it('returns null and does NOT persist when the verifier fails', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    jest.spyOn(svc, 'generate').mockResolvedValue({ verified: false, artifact: 'x', mismatches: ['bad'], lookbackSources: [], lookbackMissing: [] });
    const out = await svc.ensureKeys(DAY, SNAP);
    expect(out).toBeNull();
    expect(deps.repo.saveKeysArtifact).not.toHaveBeenCalled();
  });

  it('returns null and does NOT persist when generation throws (e.g. Fable refusal)', async () => {
    const deps = makeDeps();
    const svc = await build(deps);
    jest.spyOn(svc, 'generate').mockRejectedValue(new Error('refused'));
    const out = await svc.ensureKeys(DAY, SNAP);
    expect(out).toBeNull();
    expect(deps.repo.saveKeysArtifact).not.toHaveBeenCalled();
  });

  it('is immutable when pinned by in-flight cells: reuses stored KEYS, never regenerates, even under force and inputsHash drift', async () => {
    const deps = makeDeps();
    // NOT yet persisted-benchmarked (no pinned hashes); existing verified doc whose
    // inputsHash no longer matches (would normally force regeneration on the
    // not-benchmarked path) — pinned must still freeze it.
    const existing = { contentHash: 'kh', gcsPath: 'p', content: '# stored', uploadedAt: 't', verified: true, inputsHash: 'OLD' } as any;
    deps.repo.getKeysArtifact.mockResolvedValue(existing);
    const svc = await build(deps);
    const genSpy = jest.spyOn(svc, 'generate');
    expect(await svc.ensureKeys(DAY, SNAP, { pinned: true })).toBe(existing);
    expect(await svc.ensureKeys(DAY, SNAP, { force: true, pinned: true })).toBe(existing);
    expect(genSpy).not.toHaveBeenCalled(); // in-flight cells pinned this hash — never regenerate
    expect(deps.repo.saveKeysArtifact).not.toHaveBeenCalled();
  });

  it('pinned anomaly: refuses to regenerate (returns null) when pinned but the KEYS artifact is missing', async () => {
    const deps = makeDeps();
    deps.repo.getKeysArtifact.mockResolvedValue(null); // the lineage's KEYS doc is gone
    const svc = await build(deps);
    const genSpy = jest.spyOn(svc, 'generate');
    const out = await svc.ensureKeys(DAY, SNAP, { pinned: true });
    expect(out).toBeNull();
    expect(genSpy).not.toHaveBeenCalled(); // never regenerate — would break in-flight artifactSha256
    expect(deps.repo.saveKeysArtifact).not.toHaveBeenCalled();
  });

  it('exposes the flagship lineage alias from config', async () => {
    const svc = await build(makeDeps(), { 'benchmark.model': 'kimi-k3' });
    expect(svc.lineageAlias).toBe('k3');
  });

  it('defaults the lineage alias to the anthropic flagship', async () => {
    const svc = await build(makeDeps());
    expect(svc.lineageAlias).toBe('fable');
  });

  it('reports a verifier rejection through onFailure as kind "unverified"', async () => {
    const svc = await build(makeDeps());
    jest.spyOn(svc, 'generate').mockResolvedValue({
      verified: false,
      mismatches: ['7495.25-7502.75: side mismatch'],
      artifact: '# x',
      lookbackSources: [],
      lookbackMissing: [],
    });
    const seen: KeysFailure[] = [];
    const doc = await svc.ensureKeys(DAY, SNAP, { onFailure: (f) => seen.push(f) });
    expect(doc).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'unverified', mismatches: ['7495.25-7502.75: side mismatch'] });
  });

  it('reports a generation throw through onFailure as kind "error"', async () => {
    const svc = await build(makeDeps());
    jest.spyOn(svc, 'generate').mockRejectedValue(new Error('moonshot 529 rate limited'));
    const seen: KeysFailure[] = [];
    const doc = await svc.ensureKeys(DAY, SNAP, { onFailure: (f) => seen.push(f) });
    expect(doc).toBeNull();
    expect(seen[0].kind).toBe('error');
    expect(seen[0].message).toContain('moonshot 529 rate limited');
  });

  it('reports an orphaned-pin anomaly through onFailure as kind "refused"', async () => {
    const deps = makeDeps();
    deps.repo.getKeysArtifact.mockResolvedValue(null);
    deps.repo.pinnedKeysHashes.mockResolvedValue(new Set(['dangling-kh']));
    const svc = await build(deps);
    const seen: KeysFailure[] = [];
    const doc = await svc.ensureKeys(DAY, SNAP, { onFailure: (f) => seen.push(f) });
    expect(doc).toBeNull();
    expect(seen[0].kind).toBe('refused');
    expect(seen[0].message).toContain('dangling-kh');
  });

  it('does not call onFailure when the artifact verifies', async () => {
    const deps = makeDeps();
    queueGenerationRun(deps.fake, { lookback: false });
    const svc = await build(deps);
    const onFailure = jest.fn();
    await svc.ensureKeys(DAY, SNAP, { onFailure });
    expect(onFailure).not.toHaveBeenCalled();
  });
});
