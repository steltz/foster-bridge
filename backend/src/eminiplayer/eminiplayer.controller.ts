import {
  BadGatewayException,
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Post,
  Query,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AuditReport, EminiplayerAuditService } from './eminiplayer-audit.service';
import { EminiplayerIngestService, IngestResult } from './eminiplayer-ingest.service';
import { IngestStageError, IngestValidationError } from './eminiplayer-ingest.errors';
import { ArchiveNotFoundError } from './eminiplayer.constants';

/** MMDDYYYY, and a real calendar date (rejects 13012026 and 02302026). */
function isValidMmddyyyy(date: string): boolean {
  if (!/^\d{8}$/.test(date)) return false;
  const mm = Number(date.slice(0, 2));
  const dd = Number(date.slice(2, 4));
  const yyyy = Number(date.slice(4));
  const parsed = new Date(Date.UTC(yyyy, mm - 1, dd));
  return (
    parsed.getUTCFullYear() === yyyy && parsed.getUTCMonth() === mm - 1 && parsed.getUTCDate() === dd
  );
}

@Controller('eminiplayer')
export class EminiplayerController {
  constructor(
    private readonly ingestService: EminiplayerIngestService,
    private readonly auditService: EminiplayerAuditService,
  ) {}

  @Post('ingest')
  @HttpCode(200) // idempotent-ish operator action, not resource creation
  async ingest(
    @Query('date') date: string | undefined,
    @Query('force') force: string | undefined,
  ): Promise<IngestResult> {
    if (!date || !isValidMmddyyyy(date)) {
      throw new BadRequestException('Query param "date" (MMDDYYYY) is required');
    }
    try {
      return await this.ingestService.ingest(date, force === 'true');
    } catch (err) {
      if (err instanceof ArchiveNotFoundError) throw new NotFoundException(err.message);
      if (err instanceof IngestValidationError) throw new UnprocessableEntityException(err.message);
      if (err instanceof IngestStageError) throw new BadGatewayException(err.message);
      throw err;
    }
  }

  @Get('audit')
  async audit(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('deep') deep: string | undefined,
  ): Promise<AuditReport> {
    for (const [name, value] of [['from', from], ['to', to]] as const) {
      if (value !== undefined && !isValidMmddyyyy(value)) {
        throw new BadRequestException(`Query param "${name}" must be MMDDYYYY when present`);
      }
    }
    return this.auditService.audit({ from, to, deep: deep === 'true' });
  }
}
