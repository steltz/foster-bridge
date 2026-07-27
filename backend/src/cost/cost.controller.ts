import { BadRequestException, Controller, Get, Header, Query } from '@nestjs/common';
import { CostService, GroupBy, Summary } from './cost.service';
import { ReportBuilder } from './report-builder.provider';
import { CostRecord } from './cost.types';

const GROUP_BYS: GroupBy[] = ['tier', 'operation', 'model', 'day', 'trader', 'variant', 'date'];

@Controller('costs')
export class CostController {
  constructor(
    private readonly cost: CostService,
    private readonly reportBuilder: ReportBuilder,
  ) {}

  @Get('summary')
  async summary(
    @Query('groupBy') groupBy: GroupBy | undefined,
    @Query('model') model: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
  ): Promise<Summary> {
    const gb = groupBy ?? 'operation';
    if (!GROUP_BYS.includes(gb)) {
      throw new BadRequestException(`groupBy must be one of: ${GROUP_BYS.join(', ')}`);
    }
    return this.cost.summarize({ groupBy: gb, model, from, to });
  }

  @Get('records')
  async records(
    @Query('model') model: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
  ): Promise<{ total: number; records: CostRecord[] }> {
    const all = await this.cost.list({ model, from, to });
    const off = Math.max(0, parseInt(offset ?? '0', 10) || 0);
    const lim = Math.max(1, Math.min(1000, parseInt(limit ?? '100', 10) || 100));
    return { total: all.length, records: all.slice(off, off + lim) };
  }

  @Get('report')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async report(
    @Query('model') model: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
  ): Promise<string> {
    const records = await this.cost.list({ model, from, to });
    return this.reportBuilder.build(records);
  }
}
