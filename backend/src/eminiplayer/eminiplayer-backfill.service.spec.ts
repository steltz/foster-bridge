import { ConfigService } from '@nestjs/config';
import {
  BackfillAlreadyRunningError,
  EminiplayerBackfillService,
} from './eminiplayer-backfill.service';
import { RawArchiveRow } from './eminiplayer-archive';
import { IngestResult } from './eminiplayer-ingest.service';
import { IngestStageError, IngestValidationError } from './eminiplayer-ingest.errors';
import { ArchiveNotFoundError } from './eminiplayer.constants';

const row = (dateText: string, href: string, title: string): RawArchiveRow => ({
  dateText,
  href,
  title,
});

// Three complete modern-era days (TP + prior recap each) — mirrors the
// captured listing. 08/11–08/13 2026 are Tue–Thu.
const ROWS: RawArchiveRow[] = [
  row('2026-08-13', '/post/r13.aspx', 'ES Recap (Video Lesson) for Thursday 08/13/2026'),
  row('2026-08-13', '/post/t13.aspx', 'ES Key Zones and Trade Plan for Thursday 08/13/2026'),
  row('2026-08-12', '/post/r12.aspx', 'ES Recap (Video Lesson) for Wed. 08/12/2026'),
  row('2026-08-12', '/post/t12.aspx', 'ES Key Zones and Trade Plan for Wed. 08/12/2026'),
  row('2026-08-11', '/post/r11.aspx', 'ES Recap (Video Lesson) for Tuesday 08/11/2026'),
  row('2026-08-11', '/post/t11.aspx', 'ES Key Zones and Trade Plan for Tuesday 08/11/2026'),
  row('2026-08-10', '/post/r10.aspx', 'ES Recap (Video Lesson) for Monday 08/10/2026'),
];

function result(date: string, fromManifest = false): IngestResult {
  const status = fromManifest ? ('skipped' as const) : ('uploaded' as const);
  return {
    date,
    recapDate: 'irrelevant',
    staleRecapsRemoved: [],
    manifestPath: `knowledge-base/es/${date}/manifest.json`,
    fromManifest,
    files: {
      recap: { storagePath: 'r', status },
      tradePlanMd: { storagePath: 'm', status },
      tradePlanPdf: { storagePath: 'p', status },
    },
  };
}

// Default "now" is far past the fixture dates so no fixture day counts as
// frontier; the frontier test overrides it.
const FAR_FUTURE = new Date('2030-01-01T00:00:00Z').getTime();

function build(
  overrides: {
    ingest?: jest.Mock;
    rows?: RawArchiveRow[];
    nowMs?: number;
    dayTimeoutMs?: number;
    maxConsecutiveStageFailures?: number;
  } = {},
) {
  const eminiplayer = {
    fetchArchiveRows: jest.fn(() => Promise.resolve(overrides.rows ?? ROWS)),
    findDayEntries: jest.fn((date: string) => Promise.reject(new Error(`unexpected fresh resolve for ${date}`))),
  };
  const ingest = {
    ingest: overrides.ingest ?? jest.fn((date: string) => Promise.resolve(result(date))),
  };
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'eminiplayer.backfillDelayMs') return 5;
      if (key === 'eminiplayer.backfillDayTimeoutMs') return overrides.dayTimeoutMs ?? 60_000;
      if (key === 'eminiplayer.backfillMaxConsecutiveStageFailures') {
        return overrides.maxConsecutiveStageFailures ?? 20;
      }
      return undefined;
    }),
  } as unknown as ConfigService;
  const service = new EminiplayerBackfillService(
    eminiplayer as never,
    ingest as never,
    config,
  );
  const asSeams = service as never as {
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    loopPromise: Promise<void>;
  };
  const sleep = jest.spyOn(asSeams, 'sleep').mockResolvedValue(undefined);
  jest.spyOn(asSeams, 'now').mockReturnValue(overrides.nowMs ?? FAR_FUTURE);
  return { service, eminiplayer, ingest, sleep };
}

/** Await the detached loop. */
const settle = (service: EminiplayerBackfillService) =>
  (service as never as { loopPromise: Promise<void> }).loopPromise;

describe('EminiplayerBackfillService — core', () => {
  it('status() is null before any job has run', () => {
    const { service } = build();
    expect(service.status()).toBeNull();
  });

  it('start() validates the range itself (not just the controller)', () => {
    const { service } = build();
    expect(() => service.start('13012026', '08132026')).toThrow(IngestValidationError);
    expect(() => service.start('08132026', '08112026')).toThrow(/on or before/);
    expect(service.status()).toBeNull(); // nothing started
  });

  it('runs every candidate oldest-first with pre-resolved entries and finishes done', async () => {
    const { service, eminiplayer, ingest, sleep } = build();
    const snapshot = service.start('08112026', '08132026');
    expect(snapshot.state).toBe('running');
    await settle(service);

    expect(eminiplayer.fetchArchiveRows).toHaveBeenCalledTimes(1); // ONE scrape
    expect(ingest.ingest.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      '08112026',
      '08122026',
      '08132026',
    ]);
    // every call carries force=false and pre-resolved entries for that day
    // (nowMs is far-future, so nothing is frontier)
    for (const call of ingest.ingest.mock.calls) {
      expect(call[1]).toBe(false);
      expect((call[2] as { tradePlan: { date: string } }).tradePlan.date).toBe(call[0]);
    }
    const job = service.status()!;
    expect(job.state).toBe('done');
    expect(job.finishedAt).not.toBeNull();
    expect(job.currentDate).toBeNull();
    expect(job.counts).toEqual({ candidates: 3, processed: 3, uploaded: 3, skipped: 0, failed: 0 });
    expect(sleep).toHaveBeenCalledTimes(3); // delay after each network day
    expect(sleep).toHaveBeenCalledWith(5); // the configured delay
  });

  it('counts a fromManifest day as skipped and does NOT sleep after it', async () => {
    const ingestMock = jest.fn((date: string) =>
      Promise.resolve(result(date, date === '08122026')),
    );
    const { service, sleep } = build({ ingest: ingestMock });
    service.start('08112026', '08132026');
    await settle(service);
    const job = service.status()!;
    expect(job.counts).toEqual({ candidates: 3, processed: 3, uploaded: 2, skipped: 1, failed: 0 });
    expect(sleep).toHaveBeenCalledTimes(2); // no delay after the manifest-skip
  });

  it('counts a fill-and-skip day (all files skipped but fromManifest false) as uploaded, with delay', async () => {
    const fillAndSkip = { ...result('08122026', true), fromManifest: false };
    const ingestMock = jest.fn((date: string) =>
      Promise.resolve(date === '08122026' ? fillAndSkip : result(date)),
    );
    const { service, sleep } = build({ ingest: ingestMock });
    service.start('08112026', '08132026');
    await settle(service);
    expect(service.status()!.counts).toEqual({
      candidates: 3, processed: 3, uploaded: 3, skipped: 0, failed: 0,
    });
    expect(sleep).toHaveBeenCalledTimes(3); // fill-and-skip touched the network
  });

  it('snapshots returned from public methods are copies, not the live object', async () => {
    const { service } = build();
    const before = service.start('08112026', '08132026');
    await settle(service);
    expect(before.state).toBe('running'); // the copy did not mutate as the job ran
    const a = service.status()!;
    a.counts.processed = 999;
    expect(service.status()!.counts.processed).toBe(3); // internal state untouched
  });

  it('rejects a second start while running, then allows one after completion', async () => {
    let release!: (r: IngestResult) => void;
    const gated = new Promise<IngestResult>((r) => (release = r));
    const ingestMock = jest.fn((date: string) =>
      date === '08112026' ? gated : Promise.resolve(result(date)),
    );
    const { service } = build({ ingest: ingestMock });
    service.start('08112026', '08132026');
    expect(() => service.start('08112026', '08132026')).toThrow(BackfillAlreadyRunningError);
    release(result('08112026'));
    await settle(service);
    expect(service.status()!.state).toBe('done');
    expect(() => service.start('08112026', '08132026')).not.toThrow();
    await settle(service); // let the second job drain before the test ends
  });
});

describe('EminiplayerBackfillService — resilience', () => {
  it('records a per-day failure with its kind and continues with later days', async () => {
    const ingestMock = jest.fn((date: string) =>
      date === '08122026'
        ? Promise.reject(new IngestValidationError('title gate said no'))
        : Promise.resolve(result(date)),
    );
    const { service } = build({ ingest: ingestMock });
    service.start('08112026', '08132026');
    await settle(service);
    const job = service.status()!;
    expect(job.state).toBe('done'); // one bad day never fails the job
    expect(job.counts).toEqual({ candidates: 3, processed: 3, uploaded: 2, skipped: 0, failed: 1 });
    expect(job.failures).toEqual([
      { date: '08122026', kind: 'validation', message: 'title gate said no' },
    ]);
    expect(ingestMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    [new IngestStageError('transcribe', 'recap', new Error('youtube 429')), 'stage'],
    [new ArchiveNotFoundError('gone'), 'notFound'],
    [new TypeError('bug'), 'unknown'],
  ])('classifies %p as %s', async (error, kind) => {
    const ingestMock = jest.fn((date: string) =>
      date === '08112026' ? Promise.reject(error) : Promise.resolve(result(date)),
    );
    const { service } = build({ ingest: ingestMock });
    service.start('08112026', '08132026');
    await settle(service);
    expect(service.status()!.failures[0].kind).toBe(kind);
  });

  it('a day whose recap is missing from the listing lands in the ledger without calling ingest — and without sleeping', async () => {
    // TP with no recap anywhere near it: 09/15/2026 is a Tuesday
    const rows = [
      ...ROWS,
      row('2026-09-15', '/post/lone.aspx', 'ES Key Zones and Trade Plan for Tuesday 09/15/2026'),
    ];
    const { service, ingest, sleep } = build({ rows });
    service.start('08112026', '09152026');
    await settle(service);
    const job = service.status()!;
    expect(job.counts.failed).toBe(1);
    expect(job.failures[0]).toMatchObject({ date: '09152026', kind: 'notFound' });
    expect(ingest.ingest.mock.calls.map((c: unknown[]) => c[0])).not.toContain('09152026');
    expect(sleep).toHaveBeenCalledTimes(3); // only the 3 real days slept
  });

  it('a hung day hits the day timeout, is ledgered as stage, and the loop continues', async () => {
    const never = new Promise<IngestResult>(() => undefined); // hangs forever
    const ingestMock = jest.fn((date: string) =>
      date === '08122026' ? never : Promise.resolve(result(date)),
    );
    const { service } = build({ ingest: ingestMock, dayTimeoutMs: 20 });
    service.start('08112026', '08132026');
    await settle(service);
    const job = service.status()!;
    expect(job.state).toBe('done');
    expect(job.counts.failed).toBe(1);
    expect(job.failures[0]).toMatchObject({ date: '08122026', kind: 'stage' });
    expect(job.failures[0].message).toMatch(/day timeout/);
    expect(ingestMock).toHaveBeenCalledTimes(3); // later days still ran
  });

  it('frontier days (within the recap lookback of the scrape moment) resolve fresh — no pre-resolved entries', async () => {
    // "now" = the day after the newest fixture day, so all three are frontier
    const { service, ingest } = build({ nowMs: new Date('2026-08-14T12:00:00Z').getTime() });
    service.start('08112026', '08132026');
    await settle(service);
    expect(service.status()!.counts.uploaded).toBe(3);
    for (const call of ingest.ingest.mock.calls) {
      expect(call[2]).toBeUndefined(); // fresh resolve inside ingest instead
    }
  });

  it('aborts the job after N consecutive stage failures instead of burning the whole range', async () => {
    const ingestMock = jest.fn(() =>
      Promise.reject(new IngestStageError('transcribe', 'recap', new Error('youtube 429'))),
    );
    const { service } = build({ ingest: ingestMock, maxConsecutiveStageFailures: 2 });
    service.start('08112026', '08132026');
    await settle(service);
    const job = service.status()!;
    expect(job.state).toBe('failed');
    expect(job.error).toMatch(/consecutive stage failures/);
    expect(job.counts.failed).toBe(2); // breaker fired before day 3
    expect(ingestMock).toHaveBeenCalledTimes(2);
  });

  it('a non-stage success between stage failures resets the consecutive-failure counter', async () => {
    const ingestMock = jest.fn((date: string) => {
      if (date === '08122026') return Promise.resolve(result(date));
      return Promise.reject(new IngestStageError('transcribe', 'recap', new Error('youtube 429')));
    });
    const { service } = build({ ingest: ingestMock, maxConsecutiveStageFailures: 2 });
    service.start('08112026', '08132026');
    await settle(service);
    const job = service.status()!;
    expect(job.state).toBe('done'); // the counter reset on the 08/12 success
    expect(job.counts.failed).toBe(2);
    expect(ingestMock).toHaveBeenCalledTimes(3);
  });

  it('cancel during a day lets it finish, starts no further days, ends cancelled', async () => {
    let release!: (r: IngestResult) => void;
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    const gated = new Promise<IngestResult>((r) => (release = r));
    const ingestMock = jest.fn((date: string) => {
      if (date === '08112026') {
        started();
        return gated;
      }
      return Promise.resolve(result(date));
    });
    const { service } = build({ ingest: ingestMock });
    service.start('08112026', '08132026');
    await startedP; // day 1 is genuinely in flight before we cancel
    service.cancel();
    release(result('08112026'));
    await settle(service);
    const job = service.status()!;
    expect(job.state).toBe('cancelled');
    expect(job.counts.processed).toBe(1); // the in-flight day finished and counted
    expect(ingestMock).toHaveBeenCalledTimes(1); // nothing after it started
    expect(job.finishedAt).not.toBeNull();
  });

  it('cancel before the first day starts cancels with zero days processed', async () => {
    const { service, ingest } = build();
    service.start('08112026', '08132026');
    service.cancel(); // lands while the loop is still awaiting the scrape
    await settle(service);
    const job = service.status()!;
    expect(job.state).toBe('cancelled');
    expect(job.counts.processed).toBe(0);
    expect(ingest.ingest).not.toHaveBeenCalled();
  });

  it('onApplicationShutdown cancels a running job like DELETE would', async () => {
    const { service, ingest } = build();
    service.start('08112026', '08132026');
    service.onApplicationShutdown();
    await settle(service);
    expect(service.status()!.state).toBe('cancelled');
    expect(ingest.ingest).not.toHaveBeenCalled();
  });

  it('onModuleDestroy also cancels a running job (shutdown phase ordering)', async () => {
    const { service, ingest } = build();
    service.start('08112026', '08132026');
    service.onModuleDestroy();
    await settle(service);
    expect(service.status()!.state).toBe('cancelled');
    expect(ingest.ingest).not.toHaveBeenCalled();
  });

  it('a listing-scrape failure fails the JOB with the error recorded', async () => {
    const { service, eminiplayer } = build();
    eminiplayer.fetchArchiveRows.mockRejectedValue(new Error('login failed'));
    service.start('08112026', '08132026');
    await settle(service);
    const job = service.status()!;
    expect(job.state).toBe('failed');
    expect(job.error).toBe('login failed');
    expect(job.finishedAt).not.toBeNull();
  });

  it('zero classifiable TP rows across the scrape trips the drift tripwire (failed, not done)', async () => {
    const { service } = build({ rows: [row('2026-08-13', '/post/r.aspx', 'Some Redesigned Title 08/13/2026')] });
    service.start('08112026', '08132026');
    await settle(service);
    const job = service.status()!;
    expect(job.state).toBe('failed');
    expect(job.error).toMatch(/selector drift/);
  });

  it('an empty RANGE with a healthy archive completes done with candidates 0', async () => {
    const { service } = build();
    service.start('08152026', '08162026'); // Sat–Sun: no TP days
    await settle(service);
    const job = service.status()!;
    expect(job.state).toBe('done');
    expect(job.counts.candidates).toBe(0);
  });

  it('cancel() is a no-op on a finished job and null before any job', async () => {
    const fresh = build();
    expect(fresh.service.cancel()).toBeNull();
    fresh.service.start('08112026', '08132026');
    await settle(fresh.service);
    const snap = fresh.service.cancel();
    expect(snap!.state).toBe('done'); // not flipped to cancelled
  });
});
