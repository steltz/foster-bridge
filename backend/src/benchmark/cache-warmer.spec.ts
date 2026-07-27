import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CacheWarmer } from './cache-warmer';
import { SETUP_SCHEMA } from './benchmark.types';
import { BenchmarkRepository } from './benchmark.repository';
import { RepoInputsService } from './repo-inputs.service';
import { DayArtifactsService } from './day-artifacts.service';
import { EnvelopeBuilder } from './envelope.builder';
import { AnthropicService } from '../anthropic/anthropic.service';

function makeDeps() {
  const repo = {
    nonTerminalBatches: jest.fn().mockResolvedValue([
      {
        batchId: 'b1', day: '07012026', date: '2026-07-01', pdfPrefix: '07012026',
        model: { alias: 'fable', id: 'claude-fable-5' }, status: 'submitted',
        customIdToCell: {
          // Two distinct (trader, variant): base and seven-keys-method (2 run
          // indices of base collapse to one distinct envelope).
          'context-trader__fable__07012026__base__run1': {},
          'context-trader__fable__07012026__base__run2': {},
          'context-trader__fable__07012026__seven-keys-method__run1': {},
        },
        submittedAt: 't',
      },
    ]),
    getDayArtifact: jest.fn(async (_day: string, kind: string) => ({
      contentHash: 'h', gcsPath: 'gs', content: kind === 'tpTranscript' ? 'TP' : 'RECAP', uploadedAt: 't',
    })),
  };
  const inputs = {
    collectGeneralDocs: jest.fn().mockReturnValue({ files: [], concatenated: 'GEN', sha256: 'g' }),
    collectTraders: jest.fn().mockReturnValue([{ name: 'context-trader', origin: null, mutation: null, file: 'context-trader.md', content: 'PERSONA', sha256: 'p' }]),
    collectFeatures: jest.fn().mockReturnValue([{ id: 'seven-keys-method', name: 'm', file: 'seven-keys-method.md', block: 'B', sha256: 'f', staticDoc: 'd', staticDocContent: 'METHODS', staticDocSha256: 'd' }]),
  };
  const dayArtifacts = { ensureFileId: jest.fn().mockResolvedValue('file_live') };
  const anthropic = { warmCache: jest.fn().mockResolvedValue({ cached: true }) };
  const config = {
    get: (k: string): any => {
      if (k === 'benchmark.effort') return 'high';
      if (k === 'benchmark.schedulerEnabled') return true;
      return undefined;
    },
  };
  return { repo, inputs, dayArtifacts, anthropic, config };
}

async function build(deps: ReturnType<typeof makeDeps>) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      CacheWarmer,
      EnvelopeBuilder,
      { provide: BenchmarkRepository, useValue: deps.repo },
      { provide: RepoInputsService, useValue: deps.inputs },
      { provide: DayArtifactsService, useValue: deps.dayArtifacts },
      { provide: AnthropicService, useValue: deps.anthropic },
      { provide: ConfigService, useValue: deps.config },
    ],
  }).compile();
  return moduleRef.get(CacheWarmer);
}

describe('CacheWarmer.warm', () => {
  it('re-warms a FULL envelope per distinct (trader,variant) of an in-flight batch (FIX 9)', async () => {
    const deps = makeDeps();
    const warmer = await build(deps);
    await warmer.warm();
    // base + seven-keys-method = 2 distinct envelopes (base run1/run2 collapse).
    expect(deps.anthropic.warmCache).toHaveBeenCalledTimes(2);
    // Uses a LIVE file_id (re-derivable from GCS) for the day-bundle tier.
    expect(deps.dayArtifacts.ensureFileId).toHaveBeenCalledWith('07012026');
    for (const [ctx, attribution, opts] of deps.anthropic.warmCache.mock.calls) {
      expect(attribution).toEqual({
        operation: 'warm',
        benchmark: expect.objectContaining({ modelAlias: 'fable', day: expect.any(String), variant: expect.any(String) }),
      });
      expect(opts).toEqual({ model: 'claude-fable-5', files: true, effort: 'high', outputSchema: SETUP_SCHEMA });
      // Tier 0 general, Tier 1 day-bundle document referencing the live file_id.
      expect(ctx.userTiers[1].blocks[0]).toMatchObject({ type: 'document', source: { file_id: 'file_live' } });
      expect((ctx.userTiers[2].blocks[0] as any).text).toContain('PERSONA');
    }
    // One of the two envelopes carries the 4th feature tier.
    const tierCounts = deps.anthropic.warmCache.mock.calls.map(([ctx]) => ctx.userTiers.length).sort();
    expect(tierCounts).toEqual([3, 4]);
  });

  it('no-ops when there are no in-flight batches', async () => {
    const deps = makeDeps();
    deps.repo.nonTerminalBatches.mockResolvedValue([]);
    const warmer = await build(deps);
    await warmer.warm();
    expect(deps.anthropic.warmCache).not.toHaveBeenCalled();
  });

  it('isolates a failed warm so the other distinct (trader,variant) pair still warms', async () => {
    const deps = makeDeps();
    deps.anthropic.warmCache
      .mockRejectedValueOnce(new Error('transient API error'))
      .mockResolvedValueOnce({ cached: true });
    const warmer = await build(deps);
    await expect(warmer.warm()).resolves.toBeUndefined();
    // Both distinct pairs were attempted — the first failure didn't skip the second.
    expect(deps.anthropic.warmCache).toHaveBeenCalledTimes(2);
  });
});

describe('CacheWarmer.scheduledWarm gating', () => {
  it('no-ops when the scheduler is disabled', async () => {
    const deps = makeDeps();
    deps.config.get = (k: string) => (k === 'benchmark.effort' ? 'high' : false);
    const warmer = await build(deps);
    const spy = jest.spyOn(warmer, 'warm');
    warmer.scheduledWarm();
    await new Promise((r) => setImmediate(r));
    expect(spy).not.toHaveBeenCalled();
    expect(deps.repo.nonTerminalBatches).not.toHaveBeenCalled();
  });

  it('invokes warm when the scheduler is enabled', async () => {
    const deps = makeDeps();
    const warmer = await build(deps);
    const spy = jest.spyOn(warmer, 'warm').mockResolvedValue(undefined);
    warmer.scheduledWarm();
    await new Promise((r) => setImmediate(r));
    expect(spy).toHaveBeenCalled();
  });
});
