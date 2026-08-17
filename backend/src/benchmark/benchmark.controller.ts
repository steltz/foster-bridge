import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KeysBackfillService, KeysBackfillSnapshot } from './keys-backfill.service';
import { LockHeldError } from './run-lock';
import { isValidMmddyyyy, parseMmddyyyy } from '../eminiplayer/eminiplayer-validation';
import { BenchmarkService, RunSummary } from './benchmark.service';
import { ScoreboardService } from './scoreboard.service';
import { BenchmarkRepository, ScoreboardDoc, SampleDoc } from './benchmark.repository';
import { SamplesService, CreateSampleOptions, SampleSummary } from './samples.service';
import { Variant, resolveModel } from './benchmark.types';
import { BenchmarkDriftError } from './benchmark.errors';
import { DriftReport } from './drift';

interface RunBody {
  model?: string;
  days?: string[];
  sample?: string;
  runCount?: number;
  variants?: Variant[];
  regenerateKeys?: boolean;
}

@Controller('benchmark')
export class BenchmarkController {
  constructor(
    private readonly benchmark: BenchmarkService,
    // injected for a future ?refresh=true live-recompute endpoint; the read path serves the materialized scoreboard from the repository
    private readonly scoreboardService: ScoreboardService,
    private readonly repo: BenchmarkRepository,
    private readonly config: ConfigService,
    private readonly samples: SamplesService,
    private readonly keysBackfill: KeysBackfillService,
  ) {}

  @Post('run')
  async run(@Body() body: RunBody): Promise<RunSummary> {
    try {
      return await this.benchmark.run({
        model: body.model,
        days: body.days,
        sample: body.sample,
        runCount: body.runCount,
        variants: body.variants,
        regenerateKeys: body.regenerateKeys,
      });
    } catch (err) {
      // 409: a benchmarked input file changed. Nothing was submitted; the fix
      // is a new file (or reverting the edit), never a retry.
      if (err instanceof BenchmarkDriftError) {
        throw new ConflictException({ message: err.message, drift: err.report });
      }
      throw err;
    }
  }

  /** Read-only: does the current tree disagree with what existing cells recorded? */
  @Get('drift')
  async drift(): Promise<DriftReport> {
    return this.benchmark.checkDrift();
  }

  @Get('status')
  async status(): Promise<{ batches: { batchId: string; day: string; status: string; cellCount: number }[] }> {
    const batches = await this.repo.nonTerminalBatches();
    return {
      batches: batches.map((b) => ({
        batchId: b.batchId,
        day: b.day,
        status: b.status,
        cellCount: Object.keys(b.customIdToCell ?? {}).length,
      })),
    };
  }

  @Get('scoreboard')
  async scoreboard(@Query('model') model: string | undefined): Promise<ScoreboardDoc> {
    const raw = model ?? this.config.get<string>('benchmark.model');
    const alias = resolveModel(raw as string).alias;
    const saved = await this.repo.getScoreboard(alias);
    if (saved) return saved;
    throw new NotFoundException(`No scoreboard for model ${alias}; run the benchmark first`);
  }

  @Post('samples')
  async createSample(@Body() body: CreateSampleOptions): Promise<SampleDoc> {
    return this.samples.create(body);
  }

  @Get('samples')
  async listSamples(): Promise<SampleSummary[]> {
    return this.samples.list();
  }

  @Get('samples/:name')
  async getSample(@Param('name') name: string): Promise<SampleDoc> {
    return this.samples.get(name);
  }

  /**
   * Corpus-wide seven-keys generation: sequential, oldest-first, so every day
   * gets a full 3-day lookback. Omit from/to to build the whole committed
   * corpus. Detached — poll GET; expect 20-40 hours for a cold corpus.
   */
  @Post('keys-backfill')
  @HttpCode(202)
  startKeysBackfill(
    @Query('confirm') confirm: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
  ): KeysBackfillSnapshot {
    // A bare POST commits ~$130 and 40 hours; the already-running 409 only
    // guards a SECOND start, not the first accidental one.
    if (confirm !== 'true') {
      throw new BadRequestException('confirm=true is required — this starts a ~$130, 20-40 hour job');
    }
    for (const [name, value] of [['from', from], ['to', to]] as const) {
      if (value !== undefined && !isValidMmddyyyy(value)) {
        throw new BadRequestException(`Query param "${name}" must be MMDDYYYY when present`);
      }
    }
    if (from && to && parseMmddyyyy(from).getTime() > parseMmddyyyy(to).getTime()) {
      throw new BadRequestException('"from" must be on or before "to"');
    }
    try {
      return this.keysBackfill.start({ from, to });
    } catch (err) {
      if (err instanceof LockHeldError) {
        throw new ConflictException({ message: err.message, holder: err.holder });
      }
      throw err;
    }
  }

  @Get('keys-backfill')
  keysBackfillStatus(): KeysBackfillSnapshot {
    const job = this.keysBackfill.status();
    if (!job) throw new NotFoundException('no keys-backfill job has run since boot');
    return job;
  }

  /** startedAt must match, so a stale tab or blind curl cannot kill a 29-hour run. */
  @Delete('keys-backfill')
  cancelKeysBackfill(@Query('startedAt') startedAt: string | undefined): KeysBackfillSnapshot {
    const job = this.keysBackfill.status();
    if (!job) throw new NotFoundException('no keys-backfill job has run since boot');
    if (startedAt !== job.startedAt) {
      throw new ConflictException(`startedAt does not match the current job (${job.startedAt}) — pass ?startedAt=<that value> to confirm`);
    }
    return this.keysBackfill.cancel() as KeysBackfillSnapshot;
  }
}
