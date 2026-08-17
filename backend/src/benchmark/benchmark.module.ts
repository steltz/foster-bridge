import { Module } from '@nestjs/common';
import { MarketDataModule } from '../market-data/market-data.module';
import { ExecutionModule } from '../execution/execution.module';
import { BenchmarkRepository } from './benchmark.repository';
import { CloudInputsService } from './cloud-inputs.service';
import { DayArtifactsService } from './day-artifacts.service';
import { EnvelopeBuilder } from './envelope.builder';
import { SevenKeysService } from './seven-keys/seven-keys.service';
import { BenchmarkService } from './benchmark.service';
import { BatchReconciler } from './batch-reconciler';
import { CacheWarmer } from './cache-warmer';
import { ScoreboardService } from './scoreboard.service';
import { SamplesService } from './samples.service';
import { BenchmarkRunLock } from './run-lock';
import { KeysBackfillService } from './keys-backfill.service';

@Module({
  // LlmModule (LLM_PROVIDER) + FirebaseModule + ContractsModule are @Global
  // (ContractsService for BenchmarkService's coverage check, FIRESTORE/STORAGE_BUCKET
  // for the repo / day-artifacts); MarketData/Execution are not global so they're
  // imported. Intra-module deps: BatchReconciler -> ScoreboardService (regenerate on
  // reconcile); CacheWarmer -> DayArtifactsService (live file_id) + ConfigService.
  imports: [MarketDataModule, ExecutionModule],
  providers: [
    BenchmarkRepository,
    CloudInputsService,
    DayArtifactsService,
    EnvelopeBuilder,
    SevenKeysService,
    BenchmarkRunLock,
    BenchmarkService,
    BatchReconciler,
    CacheWarmer,
    ScoreboardService,
    SamplesService,
    KeysBackfillService,
  ],
  // KeysBackfillService MUST be exported: BenchmarkController is declared in
  // app.module.ts, not here, so it resolves constructor deps only through this
  // exports array — provider-only registration passes jest and fails at boot.
  exports: [BenchmarkService, ScoreboardService, BenchmarkRepository, SamplesService, BenchmarkRunLock, KeysBackfillService],
})
export class BenchmarkModule {}
