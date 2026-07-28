import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CacheWarmer } from './cache-warmer';
import { SETUP_SCHEMA } from './benchmark.types';
import { BenchmarkRepository } from './benchmark.repository';
import { RepoInputsService } from './repo-inputs.service';
import { DayArtifactsService } from './day-artifacts.service';
import { EnvelopeBuilder } from './envelope.builder';
import { FakeLlmProvider } from '../llm/fake-llm.provider';
import { LLM_PROVIDER } from '../llm/llm.constants';

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
  // Re-warming now submits a fire-and-forget BATCH request (same cache pool the
  // real BatchReconciler batches read from) instead of a sync/standard-tier
  // call — cross-tier cache sharing does not hold, so a standard-tier warm
  // never benefited the batches it was meant to serve. Routed through the
  // neutral LlmProvider port; read back via fake.submittedBatches.
  const fake = new FakeLlmProvider();
  const config = {
    get: (k: string): any => {
      if (k === 'benchmark.effort') return 'high';
      if (k === 'benchmark.schedulerEnabled') return true;
      return undefined;
    },
  };
  return { repo, inputs, dayArtifacts, fake, config };
}

async function build(deps: ReturnType<typeof makeDeps>) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      CacheWarmer,
      EnvelopeBuilder,
      { provide: BenchmarkRepository, useValue: deps.repo },
      { provide: RepoInputsService, useValue: deps.inputs },
      { provide: DayArtifactsService, useValue: deps.dayArtifacts },
      { provide: LLM_PROVIDER, useValue: deps.fake },
      { provide: ConfigService, useValue: deps.config },
    ],
  }).compile();
  return moduleRef.get(CacheWarmer);
}

describe('CacheWarmer.warm', () => {
  it('re-warms a FULL envelope per distinct (trader,variant) of an in-flight batch via a fire-and-forget batch submission (FIX 9)', async () => {
    const deps = makeDeps();
    const warmer = await build(deps);
    await warmer.warm();
    // base + seven-keys-method = 2 distinct envelopes (base run1/run2 collapse).
    expect(deps.fake.submittedBatches).toHaveLength(2);
    // Uses a LIVE file_id (re-derivable from GCS) for the day-bundle tier.
    expect(deps.dayArtifacts.ensureFileId).toHaveBeenCalledWith('07012026');
    for (const submitted of deps.fake.submittedBatches) {
      // A single throwaway request — the warm is fire-and-forget, never polled
      // or reconciled, so its cost is not attributed here (unlike the old
      // sync warmCache path, which emitted a cost event per call).
      expect(submitted.requests).toHaveLength(1);
      expect(typeof submitted.requests[0].prompt).toBe('string');
      expect(submitted.opts).toEqual({ model: 'claude-fable-5', effort: 'high', schema: SETUP_SCHEMA });
      // Tier 0 general, Tier 1 day-bundle file block referencing the live file id.
      expect(submitted.envelope!.tiers![1].blocks[0]).toEqual({ type: 'file', fileId: 'file_live' });
      expect((submitted.envelope!.tiers![2].blocks[0] as any).text).toContain('PERSONA');
    }
    // One of the two envelopes carries the 4th feature tier.
    const tierCounts = deps.fake.submittedBatches.map((b) => b.envelope!.tiers!.length).sort();
    expect(tierCounts).toEqual([3, 4]);
  });

  it('no-ops when there are no in-flight batches', async () => {
    const deps = makeDeps();
    deps.repo.nonTerminalBatches.mockResolvedValue([]);
    const warmer = await build(deps);
    await warmer.warm();
    expect(deps.fake.submittedBatches).toHaveLength(0);
  });

  it('isolates a failed warm so the other distinct (trader,variant) pair still warms', async () => {
    const deps = makeDeps();
    const submitSpy = jest
      .spyOn(deps.fake, 'submitBatch')
      .mockRejectedValueOnce(new Error('transient API error'))
      .mockResolvedValueOnce({ batchId: 'warm-batch', status: 'submitted' });
    const warmer = await build(deps);
    await expect(warmer.warm()).resolves.toBeUndefined();
    // Both distinct pairs were attempted — the first failure didn't skip the second.
    expect(submitSpy).toHaveBeenCalledTimes(2);
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
