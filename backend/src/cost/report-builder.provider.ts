import { Injectable } from '@nestjs/common';
import { buildReport } from './report.builder';
import { CostRecord } from './cost.types';

@Injectable()
export class ReportBuilder {
  build(records: CostRecord[]): string {
    return buildReport(records);
  }
}
