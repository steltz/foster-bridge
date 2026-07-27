import { Module } from '@nestjs/common';
import { CostService } from './cost.service';
import { CostRepository } from './cost.repository';
import { CostController } from './cost.controller';
import { ReportBuilder } from './report-builder.provider';

// FirebaseModule is @Global, so FIRESTORE injects without importing it here.
@Module({
  controllers: [CostController],
  providers: [CostService, CostRepository, ReportBuilder],
  exports: [CostService],
})
export class CostModule {}
