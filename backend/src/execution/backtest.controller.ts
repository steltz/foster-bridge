import { Body, Controller, Post } from '@nestjs/common';
import { BacktestRequest, BacktestResult, BacktestService } from './backtest.service';

@Controller('backtest')
export class BacktestController {
  constructor(private readonly backtest: BacktestService) {}

  @Post()
  async run(@Body() body: BacktestRequest): Promise<BacktestResult> {
    return this.backtest.run(body);
  }
}
