import { ConfigService } from '@nestjs/config';
import {
  BackfillAlreadyRunningError,
  EminiplayerBackfillService,
} from './eminiplayer-backfill.service';
import { RawArchiveRow } from './eminiplayer-archive';
import { IngestResult } from './eminiplayer-ingest.service';
import { IngestValidationError } from './eminiplayer-ingest.errors';

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
  overrides: { ingest?: jest.Mock; rows?: RawArchiveRow[]; nowMs?: number; dayTimeoutMs?: number } = {},
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
