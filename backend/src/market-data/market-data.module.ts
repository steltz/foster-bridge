import { Module } from '@nestjs/common';
import { MarketDataService } from './market-data.service';
import { ContractIngestService } from './contract-ingest.service';

@Module({
  providers: [MarketDataService, ContractIngestService],
  exports: [MarketDataService, ContractIngestService],
})
export class MarketDataModule {}
