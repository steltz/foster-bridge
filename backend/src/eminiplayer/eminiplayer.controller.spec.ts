import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { EminiplayerController } from './eminiplayer.controller';
import { EminiplayerAuditService } from './eminiplayer-audit.service';
import { EminiplayerIngestService } from './eminiplayer-ingest.service';
import {
  BackfillAlreadyRunningError,
  EminiplayerBackfillService,
} from './eminiplayer-backfill.service';
import { IngestStageError, IngestValidationError } from './eminiplayer-ingest.errors';
import { ArchiveNotFoundError } from './eminiplayer.constants';

const RESULT = {
  date: '07012026',
  recapDate: '06302026',
  staleRecapsRemoved: [],
  manifestPath: 'knowledge-base/es/07012026/manifest.json',
  fromManifest: false,
  files: {
    recap: { storagePath: 'knowledge-base/es/07012026/06302026_ES_RECAP.md', status: 'uploaded' },
    tradePlanMd: { storagePath: 'knowledge-base/es/07012026/07012026_ES_TP.md', status: 'uploaded' },
    tradePlanPdf: { storagePath: 'knowledge-base/es/07012026/07012026_ES_TP.pdf', status: 'uploaded' },
  },
};

async function build(cfg: Record<string, unknown> = {}) {
  const ingest = { ingest: jest.fn((_date: string, _force: boolean) => Promise.resolve(RESULT)) };
  const audit = {
    audit: jest.fn(() =>
      Promise.resolve({ daysChecked: 0, ok: 0, deep: false, anomalies: [], uncommittedDays: [] }),
    ),
  };
  const JOB = {
    state: 'running',
    from: '08112026',
    to: '08132026',
    startedAt: '2026-08-14T00:00:00.000Z',
    finishedAt: null,
    currentDate: null,
    cancelRequested: false,
    counts: { candidates: null, processed: 0, uploaded: 0, skipped: 0, failed: 0 },
    failures: [],
    error: null,
  };
  // loosely typed on purpose: arg capture + mockReturnValue(null) must compile
  const backfill = {
    JOB,
    start: jest.fn() as jest.Mock,
    status: jest.fn() as jest.Mock,
    cancel: jest.fn() as jest.Mock,
  };
  backfill.start.mockReturnValue(JOB);
  backfill.status.mockReturnValue(JOB);
  backfill.cancel.mockReturnValue(JOB);
  const config = { get: jest.fn((key: string) => cfg[key]) };
  const moduleRef = await Test.createTestingModule({
    controllers: [EminiplayerController],
    providers: [
      { provide: EminiplayerIngestService, useValue: ingest },
      { provide: EminiplayerAuditService, useValue: audit },
      { provide: EminiplayerBackfillService, useValue: backfill },
      { provide: ConfigService, useValue: config },
    ],
  }).compile();
  return { controller: moduleRef.get(EminiplayerController), ingest, audit, backfill };
}

describe('POST /eminiplayer/ingest', () => {
  it('delegates with parsed args and returns the result', async () => {
    const { controller, ingest } = await build();
    await expect(controller.ingest('07012026', 'true')).resolves.toEqual(RESULT);
    expect(ingest.ingest).toHaveBeenCalledWith('07012026', true);
  });

  it('defaults force to false when the query param is absent', async () => {
    const { controller, ingest } = await build();
    await controller.ingest('07012026', undefined);
    expect(ingest.ingest).toHaveBeenCalledWith('07012026', false);
  });

  it.each([
    [undefined, 'missing'],
    ['2026-07-01', 'wrong format'],
    ['07012026x', 'trailing junk'],
    ['13012026', 'month 13'],
    ['02302026', 'Feb 30'],
  ])('rejects date %p (%s) with 400 before touching the service', async (bad, _why) => {
    const { controller, ingest } = await build();
    await expect(controller.ingest(bad as string | undefined, undefined)).rejects.toThrow(
      BadRequestException,
    );
    expect(ingest.ingest).not.toHaveBeenCalled();
  });

  it('maps ArchiveNotFoundError to 404', async () => {
    const { controller, ingest } = await build();
    ingest.ingest.mockRejectedValue(new ArchiveNotFoundError('no TP for 07012026'));
    await expect(controller.ingest('07012026', undefined)).rejects.toThrow(NotFoundException);
  });

  it('maps IngestValidationError to 422', async () => {
    const { controller, ingest } = await build();
    ingest.ingest.mockRejectedValue(new IngestValidationError('gate failed'));
    await expect(controller.ingest('07012026', undefined)).rejects.toThrow(
      UnprocessableEntityException,
    );
  });

  it('maps IngestStageError to 502', async () => {
    const { controller, ingest } = await build();
    ingest.ingest.mockRejectedValue(
      new IngestStageError('resolve', 'archive', new Error('archive listing unreachable')),
    );
    await expect(controller.ingest('07012026', undefined)).rejects.toThrow(BadGatewayException);
  });

  it('lets unknown errors propagate untouched', async () => {
    const { controller, ingest } = await build();
    ingest.ingest.mockRejectedValue(new TypeError('bug'));
    await expect(controller.ingest('07012026', undefined)).rejects.toThrow(TypeError);
  });
});

describe('GET /eminiplayer/audit', () => {
  it('returns the audit report, passing parsed options', async () => {
    const { controller, audit } = await build();
    await expect(controller.audit('07012026', '07312026', 'true')).resolves.toEqual({
      daysChecked: 0, ok: 0, deep: false, anomalies: [], uncommittedDays: [],
    });
    expect(audit.audit).toHaveBeenCalledWith({ from: '07012026', to: '07312026', deep: true });
  });

  it('rejects a malformed range param with 400', async () => {
    const { controller, audit } = await build();
    await expect(controller.audit('2026-07-01', undefined, undefined)).rejects.toThrow(
      BadRequestException,
    );
    expect(audit.audit).not.toHaveBeenCalled();
  });
});

describe('/eminiplayer/backfill', () => {
  it('POST starts the job with the given range', async () => {
    const { controller, backfill } = await build();
    const out = controller.startBackfill('01012018', '08132026', undefined);
    expect(backfill.start).toHaveBeenCalledWith('01012018', '08132026');
    expect(out).toBe(backfill.JOB);
  });

  it('POST defaults a missing "to" to today in America/New_York (MMDDYYYY)', async () => {
    const { controller, backfill } = await build();
    controller.startBackfill('01012018', undefined, undefined);
    const to = backfill.start.mock.calls[0][1] as string;
    expect(to).toMatch(/^\d{8}$/);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const get = (t: string) => parts.find((p) => p.type === t)!.value;
    expect(to).toBe(`${get('month')}${get('day')}${get('year')}`);
  });

  it.each([
    [undefined, '08132026'],
    ['13012026', '08132026'], // not a real date
    ['01012018', '02302026'], // invalid "to"
  ])('POST rejects bad ranges (%s..%s) with 400', async (from, to) => {
    const { controller } = await build();
    expect(() => controller.startBackfill(from as string | undefined, to, undefined)).toThrow(
      BadRequestException,
    );
  });

  it('POST rejects a reversed range with 400', async () => {
    const { controller } = await build();
    expect(() => controller.startBackfill('08132026', '08112026', undefined)).toThrow(
      BadRequestException,
    );
  });

  it('POST maps an already-running job to 409', async () => {
    const { controller, backfill } = await build();
    backfill.start.mockImplementation(() => {
      throw new BackfillAlreadyRunningError();
    });
    expect(() => controller.startBackfill('01012018', '08132026', undefined)).toThrow(
      ConflictException,
    );
  });

  it('token guard: when configured, POST and DELETE require the matching header; GET stays open', async () => {
    const { controller, backfill } = await build({ 'eminiplayer.backfillToken': 's3cret' });
    expect(() => controller.startBackfill('01012018', '08132026', undefined)).toThrow(
      UnauthorizedException,
    );
    expect(() => controller.startBackfill('01012018', '08132026', 'wrong')).toThrow(
      UnauthorizedException,
    );
    expect(() => controller.cancelBackfill(undefined)).toThrow(UnauthorizedException);
    expect(controller.startBackfill('01012018', '08132026', 's3cret')).toBe(backfill.JOB);
    expect(controller.backfillStatus()).toBe(backfill.JOB); // GET unguarded
  });

  it('GET returns the snapshot, or 404 when no job has run', async () => {
    const { controller, backfill } = await build();
    expect(controller.backfillStatus()).toBe(backfill.JOB);
    backfill.status.mockReturnValue(null);
    expect(() => controller.backfillStatus()).toThrow(NotFoundException);
  });

  it('DELETE cancels, or 404 when no job has run', async () => {
    const { controller, backfill } = await build();
    expect(controller.cancelBackfill(undefined)).toBe(backfill.JOB);
    expect(backfill.cancel).toHaveBeenCalled();
    backfill.cancel.mockReturnValue(null);
    expect(() => controller.cancelBackfill(undefined)).toThrow(NotFoundException);
  });
});
