import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import configuration from './config/configuration';
import { FirebaseModule } from './firebase/firebase.module';
import { AnthropicModule } from './anthropic/anthropic.module';
import { ContractsModule } from './contracts/contracts.module';
import { MarketDataModule } from './market-data/market-data.module';
import { ExecutionModule } from './execution/execution.module';
import { BenchmarkModule } from './benchmark/benchmark.module';
import { GoogleErrorFilter } from './common/google-error.filter';
import { HealthController } from './health/health.controller';
import { FirestoreDemoController } from './demo/firestore-demo.controller';
import { StorageDemoController } from './demo/storage-demo.controller';
import { AnthropicDemoController } from './demo/anthropic-demo.controller';
import { MarketDataController } from './market-data/market-data.controller';
import { BacktestController } from './execution/backtest.controller';
import { BenchmarkController } from './benchmark/benchmark.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    ScheduleModule.forRoot(),
    FirebaseModule,
    AnthropicModule,
    ContractsModule,
    MarketDataModule,
    ExecutionModule,
    BenchmarkModule,
  ],
  controllers: [
    HealthController,
    FirestoreDemoController,
    StorageDemoController,
    AnthropicDemoController,
    MarketDataController,
    BacktestController,
    BenchmarkController,
  ],
  providers: [{ provide: APP_FILTER, useClass: GoogleErrorFilter }],
})
export class AppModule {}
