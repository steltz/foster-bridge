import { Body, Controller, Get, NotFoundException, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BenchmarkService, RunSummary } from './benchmark.service';
import { ScoreboardService } from './scoreboard.service';
import { BenchmarkRepository, ScoreboardDoc } from './benchmark.repository';
import { Variant, resolveModel } from './benchmark.types';

interface RunBody {
  model?: string;
  days?: string[];
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
  ) {}

  @Post('run')
  async run(@Body() body: RunBody): Promise<RunSummary> {
    return this.benchmark.run({
      model: body.model,
      days: body.days,
      runCount: body.runCount,
      variants: body.variants,
      regenerateKeys: body.regenerateKeys,
    });
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
}
