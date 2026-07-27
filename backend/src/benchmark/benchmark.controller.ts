import { Body, Controller, Get, NotFoundException, Post, Query } from '@nestjs/common';
import { BenchmarkService, RunSummary } from './benchmark.service';
import { ScoreboardService } from './scoreboard.service';
import { BenchmarkRepository, ScoreboardDoc } from './benchmark.repository';
import { Variant } from './benchmark.types';

interface RunBody {
  model?: string;
  days?: string[];
  runCount?: number;
  variants?: Variant[];
}

@Controller('benchmark')
export class BenchmarkController {
  constructor(
    private readonly benchmark: BenchmarkService,
    private readonly scoreboardService: ScoreboardService,
    private readonly repo: BenchmarkRepository,
  ) {}

  @Post('run')
  async run(@Body() body: RunBody): Promise<RunSummary> {
    return this.benchmark.run({
      model: body.model,
      days: body.days,
      runCount: body.runCount,
      variants: body.variants,
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
  async scoreboard(@Query('model') model: string): Promise<ScoreboardDoc> {
    const saved = await this.repo.getScoreboard(model);
    if (saved) return saved;
    throw new NotFoundException(`No scoreboard for model ${model}; run the benchmark first`);
  }
}
