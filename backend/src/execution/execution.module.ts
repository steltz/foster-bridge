import { Module } from '@nestjs/common';
import { MarketDataModule } from '../market-data/market-data.module';
import { ExecutionEngine } from './execution-engine';
import { BacktestService } from './backtest.service';

@Module({
  imports: [MarketDataModule],
  providers: [ExecutionEngine, BacktestService],
  exports: [ExecutionEngine, BacktestService],
})
export class ExecutionModule {}
