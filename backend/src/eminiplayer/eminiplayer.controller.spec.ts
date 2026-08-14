import {
  BadGatewayException,
  BadRequestException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EminiplayerController } from './eminiplayer.controller';
import { EminiplayerAuditService } from './eminiplayer-audit.service';
import { EminiplayerIngestService } from './eminiplayer-ingest.service';
import { IngestStageError, IngestValidationError } from './eminiplayer-ingest.errors';
import { ArchiveNotFoundError } from './eminiplayer.constants';

const RESULT = {
  date: '07012026',
  recapDate: '06302026',
  staleRecapsRemoved: [],
  manifestPath: 'knowledge-base/es/07012026/manifest.json',
  files: {
    recap: { storagePath: 'knowledge-base/es/07012026/06302026_ES_RECAP.md', status: 'uploaded' },
    tradePlanMd: { storagePath: 'knowledge-base/es/07012026/07012026_ES_TP.md', status: 'uploaded' },
    tradePlanPdf: { storagePath: 'knowledge-base/es/07012026/07012026_ES_TP.pdf', status: 'uploaded' },
  },
};

async function build() {
  const ingest = { ingest: jest.fn((_date: string, _force: boolean) => Promise.resolve(RESULT)) };
  const audit = {
    audit: jest.fn(() =>
      Promise.resolve({ daysChecked: 0, ok: 0, deep: false, anomalies: [], uncommittedDays: [] }),
    ),
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [EminiplayerController],
    providers: [
      { provide: EminiplayerIngestService, useValue: ingest },
      { provide: EminiplayerAuditService, useValue: audit },
    ],
  }).compile();
  return { controller: moduleRef.get(EminiplayerController), ingest, audit };
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
