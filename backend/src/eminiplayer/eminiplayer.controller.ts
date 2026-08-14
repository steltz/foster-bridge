import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Post,
  Query,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditReport, EminiplayerAuditService } from './eminiplayer-audit.service';
import { EminiplayerIngestService, IngestResult } from './eminiplayer-ingest.service';
import {
  BackfillAlreadyRunningError,
  BackfillJobSnapshot,
  EminiplayerBackfillService,
} from './eminiplayer-backfill.service';
import { IngestStageError, IngestValidationError } from './eminiplayer-ingest.errors';
import { ArchiveNotFoundError } from './eminiplayer.constants';
import { parseMmddyyyy } from './eminiplayer-validation';

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

/**
 * Today as MMDDYYYY in America/New_York — the site's trading-date timezone.
 * (Server-local time on a host west of ET would compute yesterday around
 * midnight and silently exclude today's trade plan from the default range.)
 */
function todayMmddyyyy(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('month')}${get('day')}${get('year')}`;
}

@Controller('eminiplayer')
export class EminiplayerController {
  constructor(
    private readonly ingestService: EminiplayerIngestService,
    private readonly auditService: EminiplayerAuditService,
    private readonly backfillService: EminiplayerBackfillService,
    private readonly config: ConfigService,
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

  /** 401 unless the configured token (if any) matches. GET stays unguarded. */
  private assertBackfillToken(token: string | undefined): void {
    const required = this.config.get<string>('eminiplayer.backfillToken');
    if (required && token !== required) {
      throw new UnauthorizedException('x-backfill-token header required');
    }
  }

  @Post('backfill')
  @HttpCode(202) // job accepted; completion is observed via GET
  startBackfill(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Headers('x-backfill-token') token: string | undefined,
  ): BackfillJobSnapshot {
    this.assertBackfillToken(token);
    if (!from || !isValidMmddyyyy(from)) {
      throw new BadRequestException('Query param "from" (MMDDYYYY) is required');
    }
    const resolvedTo = to ?? todayMmddyyyy();
    if (!isValidMmddyyyy(resolvedTo)) {
      throw new BadRequestException('Query param "to" must be MMDDYYYY when present');
    }
    if (parseMmddyyyy(from).getTime() > parseMmddyyyy(resolvedTo).getTime()) {
      throw new BadRequestException('"from" must be on or before "to"');
    }
    try {
      return this.backfillService.start(from, resolvedTo);
    } catch (err) {
      if (err instanceof BackfillAlreadyRunningError) {
        throw new ConflictException({
          message: err.message,
          job: this.backfillService.status(),
        });
      }
      throw err;
    }
  }

  @Get('backfill')
  backfillStatus(): BackfillJobSnapshot {
    const job = this.backfillService.status();
    if (!job) throw new NotFoundException('no backfill job has run since boot');
    return job;
  }

  @Delete('backfill')
  cancelBackfill(@Headers('x-backfill-token') token: string | undefined): BackfillJobSnapshot {
    this.assertBackfillToken(token);
    const job = this.backfillService.cancel();
    if (!job) throw new NotFoundException('no backfill job has run since boot');
    return job;
  }
}
