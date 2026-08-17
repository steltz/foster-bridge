import { ConfigService } from '@nestjs/config';
import { KeysBackfillService } from './keys-backfill.service';
import { BenchmarkRunLock } from './run-lock';
import type { DayListing } from './cloud-inputs.service';

function listing(day: string, date: string): DayListing {
  return { day, date, prefix: day, recapDate: day, fileSha256: { tradePlanMd: 'a', tradePlanPdf: 'b', recap: 'c' } };
}

const DAYS = [
  listing('01022025', '2025-01-02'),
  listing('01032025', '2025-01-03'),
  listing('01062025', '2025-01-06'),
];

function build(
  overrides: {
    days?: DayListing[];
    methodsDoc?: string | null;
    ensureKeys?: jest.Mock;
    getKeysArtifact?: jest.Mock;
    loadDay?: jest.Mock;
  } = {},
) {
  const inputs = {
    snapshot: jest.fn(() =>
      Promise.resolve({
        traders: [],
        features: [],
        general: { files: [], concatenated: 'GEN', sha256: 'g' },
        methodsDoc: overrides.methodsDoc === undefined ? 'METHODS' : overrides.methodsDoc,
        days: overrides.days ?? DAYS,
        issues: [],
      }),
    ),
    loadDay:
      overrides.loadDay ??
      jest.fn((l: DayListing) =>
        Promise.resolve({
          ...l,
          pdf: Buffer.from('p'),
          tpTranscript: 't',
          recapTranscript: 'r',
          recapFileName: `${l.recapDate}_ES_RECAP.md`,
        }),
      ),
  };
  const dayArtifacts = {
    ensureDayRecorded: jest.fn(() => Promise.resolve({ providerFileId: 'f', gcsPath: 'g', contentHash: 'h' })),
  };
  const sevenKeys = {
    lineageAlias: 'k3',
    ensureKeys: overrides.ensureKeys ?? jest.fn(() => Promise.resolve({ contentHash: 'kh', verified: true, lookbackMissing: [] })),
  };
  const repo = { getKeysArtifact: overrides.getKeysArtifact ?? jest.fn(() => Promise.resolve(null)) };
  const lock = new BenchmarkRunLock();
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'benchmark.keysBackfillDayTimeoutMs') return 60_000;
      if (key === 'benchmark.keysBackfillRetryDelaysMs') return [10, 20];
      return undefined;
    }),
  } as unknown as ConfigService;

  const service = new KeysBackfillService(
    inputs as never,
    dayArtifacts as never,
    sevenKeys as never,
    repo as never,
    lock,
    config,
  );
  const seams = service as never as { sleep: (ms: number) => Promise<void>; loopPromise: Promise<void> };
  const sleep = jest.spyOn(seams, 'sleep').mockResolvedValue(undefined);
  return { service, inputs, dayArtifacts, sevenKeys, repo, lock, sleep };
}

/** Await the detached loop. */
async function settle(service: KeysBackfillService): Promise<void> {
  await (service as never as { loopPromise: Promise<void> }).loopPromise;
}

const daysPassedTo = (m: jest.Mock) => m.mock.calls.map((c: unknown[]) => (c[0] as DayListing).day);

describe('KeysBackfillService', () => {
  it('generates every day oldest-first and finishes done', async () => {
    const { service, sevenKeys } = build();
    service.start({});
    await settle(service);

    expect(daysPassedTo(sevenKeys.ensureKeys)).toEqual(['01022025', '01032025', '01062025']);
    const job = service.status()!;
    expect(job.state).toBe('done');
    expect(job.counts).toMatchObject({ candidates: 3, processed: 3, generated: 3, reused: 0, failed: 0 });
    expect(job.flagshipAlias).toBe('k3');
    expect(job.from).toBe('01022025');
    expect(job.to).toBe('01062025');
    expect(job.reducedLookback).toEqual([]);
  });

  it('reuses a verified artifact with empty lookbackMissing without loading the day', async () => {
    const getKeysArtifact = jest.fn((day: string) =>
      Promise.resolve(day === '01032025' ? { contentHash: 'kh', verified: true, lookbackMissing: [] } : null),
    );
    const { service, sevenKeys, inputs } = build({ getKeysArtifact });
    service.start({});
    await settle(service);

    expect(daysPassedTo(sevenKeys.ensureKeys)).toEqual(['01022025', '01062025']);
    expect(inputs.loadDay).toHaveBeenCalledTimes(2);
    expect(service.status()!.counts).toMatchObject({ generated: 2, reused: 1, processed: 3 });
  });

  it('REGENERATES a verified artifact that has a non-empty lookbackMissing', async () => {
    const getKeysArtifact = jest.fn(() =>
      Promise.resolve({ contentHash: 'kh', verified: true, lookbackMissing: ['01012025'] }),
    );
    const { service, sevenKeys } = build({ getKeysArtifact });
    service.start({});
    await settle(service);

    expect(sevenKeys.ensureKeys).toHaveBeenCalledTimes(3);
    expect(service.status()!.counts).toMatchObject({ generated: 3, reused: 0 });
  });

  it('records a generated day that still has reduced lookback', async () => {
    const ensureKeys = jest.fn(() => Promise.resolve({ contentHash: 'kh', verified: true, lookbackMissing: ['12312024'] }));
    const { service } = build({ days: [listing('01022025', '2025-01-02')], ensureKeys });
    service.start({});
    await settle(service);

    expect(service.status()!.reducedLookback).toEqual([{ day: '01022025', missing: ['12312024'] }]);
    expect(service.status()!.state).toBe('done');
  });

  it('honours a from/to window when the priors already have KEYS', async () => {
    const getKeysArtifact = jest.fn((day: string) =>
      Promise.resolve(day === '01022025' ? { contentHash: 'kh', verified: true, lookbackMissing: [] } : null),
    );
    const { service, sevenKeys } = build({ getKeysArtifact });
    service.start({ from: '01032025', to: '01032025' });
    await settle(service);

    expect(daysPassedTo(sevenKeys.ensureKeys)).toEqual(['01032025']);
    expect(service.status()!.counts.candidates).toBe(1);
  });

  it('refuses a from whose priors have no KEYS', async () => {
    const { service, sevenKeys } = build();
    service.start({ from: '01062025' });
    await settle(service);

    const job = service.status()!;
    expect(job.state).toBe('failed');
    expect(job.error).toContain('01022025');
    expect(job.error).toContain('01032025');
    expect(sevenKeys.ensureKeys).not.toHaveBeenCalled();
  });

  it('passes a falsy force to ensureKeys for clean days (no existing artifact)', async () => {
    const { service, sevenKeys } = build();
    service.start({});
    await settle(service);
    expect(sevenKeys.ensureKeys.mock.calls.length).toBeGreaterThan(0);
    for (const call of sevenKeys.ensureKeys.mock.calls) {
      expect((call[2] as { force?: boolean } | undefined)?.force).toBeFalsy();
    }
  });

  it('passes force: true when regenerating a verified-but-degraded artifact', async () => {
    const getKeysArtifact = jest.fn(() =>
      Promise.resolve({ contentHash: 'kh', verified: true, lookbackMissing: ['01012025'] }),
    );
    const { service, sevenKeys } = build({ getKeysArtifact });
    service.start({});
    await settle(service);
    expect(sevenKeys.ensureKeys.mock.calls.length).toBeGreaterThan(0);
    for (const call of sevenKeys.ensureKeys.mock.calls) {
      expect((call[2] as { force?: boolean }).force).toBe(true);
    }
  });

  it('refuses a windowed start when a prior has only a degraded KEYS artifact', async () => {
    const getKeysArtifact = jest.fn((day: string) =>
      Promise.resolve(day === '01022025' ? { contentHash: 'kh', verified: true, lookbackMissing: ['01012025'] } : null),
    );
    const { service, sevenKeys } = build({ getKeysArtifact });
    service.start({ from: '01032025' });
    await settle(service);

    const job = service.status()!;
    expect(job.state).toBe('failed');
    expect(job.error).toContain('01022025');
    expect(sevenKeys.ensureKeys).not.toHaveBeenCalled();
  });

  it('holds the lock while running and releases it when done', async () => {
    const { service, lock } = build();
    service.start({});
    expect(lock.heldBy).toBe('keys-backfill');
    await settle(service);
    expect(lock.heldBy).toBeNull();
  });

  it('throws when the lock is held and creates no job', () => {
    const { service, lock } = build();
    lock.acquire('benchmark-run');
    expect(() => service.start({})).toThrow('a benchmark run is already in progress');
    expect(service.status()).toBeNull();
  });

  it('fails the job when the corpus scan throws, and releases the lock', async () => {
    const { service, inputs, lock } = build();
    inputs.snapshot.mockRejectedValueOnce(new Error('bucket down'));
    service.start({});
    await settle(service);
    expect(service.status()!.state).toBe('failed');
    expect(service.status()!.error).toContain('bucket down');
    expect(lock.heldBy).toBeNull();
  });

  it('fails the job when the corpus scan returns zero days', async () => {
    const { service } = build({ days: [] });
    service.start({});
    await settle(service);
    expect(service.status()!.state).toBe('failed');
    expect(service.status()!.error).toMatch(/no committed days/i);
  });

  it('fails the job when the methods doc is missing', async () => {
    const { service } = build({ methodsDoc: null });
    service.start({});
    await settle(service);
    expect(service.status()!.state).toBe('failed');
    expect(service.status()!.error).toMatch(/methods doc/i);
  });

  it('status is null before the first start', () => {
    expect(build().service.status()).toBeNull();
  });

  it('retries a failed day with backoff and continues to the next day on success', async () => {
    let calls = 0;
    const ensureKeys = jest.fn((_d: unknown, _s: unknown, opts: { onFailure: (f: unknown) => void }) => {
      calls += 1;
      if (calls <= 2) {
        opts.onFailure({ kind: 'unverified', message: `attempt ${calls}`, mismatches: [`m${calls}`] });
        return Promise.resolve(null);
      }
      return Promise.resolve({ contentHash: 'kh', verified: true, lookbackMissing: [] });
    });
    const { service, sleep } = build({
      days: [listing('01022025', '2025-01-02'), listing('01032025', '2025-01-03')],
      ensureKeys,
    });
    service.start({});
    await settle(service);

    const job = service.status()!;
    expect(sleep).toHaveBeenCalledTimes(2); // backoff before attempts 2 and 3
    expect(daysPassedTo(ensureKeys)).toEqual(['01022025', '01022025', '01022025', '01032025']);
    expect(job.state).toBe('done');
    expect(job.counts).toMatchObject({ generated: 2, failed: 0, processed: 2 });
    expect(job.failures).toEqual([]);
  });

  it('stops the whole job after three failed attempts and records diagnostics', async () => {
    const ensureKeys = jest.fn((_d: unknown, _s: unknown, opts: { onFailure: (f: unknown) => void }) => {
      opts.onFailure({ kind: 'unverified', message: 'verifier rejected the artifact: side mismatch', mismatches: ['5777.75-5781.75: side mismatch'] });
      return Promise.resolve(null);
    });
    const { service } = build({ ensureKeys });
    service.start({});
    await settle(service);

    const job = service.status()!;
    expect(ensureKeys).toHaveBeenCalledTimes(3); // first day only — day 2 never attempted
    expect(job.state).toBe('failed');
    expect(job.counts.failed).toBe(1);
    expect(job.error).toContain('01022025');
    expect(job.failures[0]).toMatchObject({
      day: '01022025',
      attempts: 3,
      kind: 'unverified',
      mismatches: ['5777.75-5781.75: side mismatch'],
    });
  });

  it('classifies a generation error as kind "error", not unverified', async () => {
    const ensureKeys = jest.fn((_d: unknown, _s: unknown, opts: { onFailure: (f: unknown) => void }) => {
      opts.onFailure({ kind: 'error', message: 'moonshot 529 rate limited', mismatches: [] });
      return Promise.resolve(null);
    });
    const { service } = build({ ensureKeys });
    service.start({});
    await settle(service);

    const job = service.status()!;
    expect(ensureKeys).toHaveBeenCalledTimes(3);
    expect(job.failures[0]).toMatchObject({ kind: 'error', attempts: 3 });
    expect(job.failures[0].message).toContain('moonshot 529');
  });

  it('does NOT retry a refused pin anomaly', async () => {
    const ensureKeys = jest.fn((_d: unknown, _s: unknown, opts: { onFailure: (f: unknown) => void }) => {
      opts.onFailure({ kind: 'refused', message: 'pinned KEYS hash matches no stored artifact', mismatches: [] });
      return Promise.resolve(null);
    });
    const { service, sleep } = build({ ensureKeys });
    service.start({});
    await settle(service);

    const job = service.status()!;
    expect(ensureKeys).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(job.state).toBe('failed');
    expect(job.failures[0]).toMatchObject({ kind: 'refused', attempts: 1 });
  });

  it('does NOT retry a per-day timeout, and stops the job', async () => {
    jest.useFakeTimers();
    try {
      const ensureKeys = jest.fn(() => new Promise(() => undefined));
      const { service } = build({ days: [listing('01022025', '2025-01-02')], ensureKeys });
      service.start({});
      await jest.advanceTimersByTimeAsync(60_001);
      await settle(service);

      const job = service.status()!;
      expect(ensureKeys).toHaveBeenCalledTimes(1);
      expect(job.state).toBe('failed');
      expect(job.failures[0]).toMatchObject({ kind: 'timeout', attempts: 1 });
      expect(job.failures[0].message).toMatch(/timeout/i);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops immediately when the corpus changed under the snapshot', async () => {
    const loadDay = jest.fn(() => Promise.reject(new Error('day 01022025 changed since the run snapshot (tradePlanPdf no longer match)')));
    const { service } = build({ loadDay });
    service.start({});
    await settle(service);

    const job = service.status()!;
    expect(job.state).toBe('failed');
    expect(job.failures[0].attempts).toBe(1);
    expect(job.failures[0].message).toMatch(/re-POST to re-snapshot/i);
  });

  it('retries a transient Firestore error on the classification read', async () => {
    let reads = 0;
    const getKeysArtifact = jest.fn(() => {
      reads += 1;
      if (reads === 1) return Promise.reject(new Error('DEADLINE_EXCEEDED'));
      return Promise.resolve(null);
    });
    const { service } = build({ days: [listing('01022025', '2025-01-02')], getKeysArtifact });
    service.start({});
    await settle(service);

    expect(service.status()!.state).toBe('done');
    expect(service.status()!.counts.generated).toBe(1);
  });
});
