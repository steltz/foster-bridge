import { Module } from '@nestjs/common';
import { AnthropicModule } from '../anthropic/anthropic.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { ExecutionModule } from '../execution/execution.module';
import { BenchmarkRepository } from './benchmark.repository';
import { RepoInputsService } from './repo-inputs.service';
import { DayArtifactsService } from './day-artifacts.service';
import { EnvelopeBuilder } from './envelope.builder';
import { SevenKeysService } from './seven-keys/seven-keys.service';
import { BenchmarkService } from './benchmark.service';
import { BatchReconciler } from './batch-reconciler';
import { CacheWarmer } from './cache-warmer';
import { ScoreboardService } from './scoreboard.service';

@Module({
  // AnthropicModule + FirebaseModule + ContractsModule are @Global (ContractsService
  // for BenchmarkService's coverage check, FIRESTORE/STORAGE_BUCKET for the repo /
  // day-artifacts); MarketData/Execution are not global so they're imported.
  // Intra-module deps: BatchReconciler -> ScoreboardService (regenerate on
  // reconcile); CacheWarmer -> DayArtifactsService (live file_id) + ConfigService.
  imports: [AnthropicModule, MarketDataModule, ExecutionModule],
  providers: [
    BenchmarkRepository,
    RepoInputsService,
    DayArtifactsService,
    EnvelopeBuilder,
    SevenKeysService,
    BenchmarkService,
    BatchReconciler,
    CacheWarmer,
    ScoreboardService,
  ],
  exports: [BenchmarkService, ScoreboardService, BenchmarkRepository],
})
export class BenchmarkModule {}
