import { ConflictException, Controller, Get, HttpCode, Post, UnprocessableEntityException } from '@nestjs/common';
import {
  ContractIngestAlreadyRunningError,
  ContractIngestNoFilesError,
  ContractIngestService,
} from './contract-ingest.service';

@Controller('markets')
export class ContractIngestController {
  constructor(private readonly ingest: ContractIngestService) {}

  @Post('ingest-contracts')
  @HttpCode(202)
  start() {
    try {
      return this.ingest.start();
    } catch (err) {
      if (err instanceof ContractIngestAlreadyRunningError) throw new ConflictException(err.message);
      if (err instanceof ContractIngestNoFilesError) throw new UnprocessableEntityException(err.message);
      throw err;
    }
  }

  @Get('ingest-contracts')
  status() {
    return this.ingest.snapshot() ?? { state: 'idle' };
  }
}
