import { BadRequestException, Controller, Get, Inject, Param, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MarketDataService } from './market-data.service';
import { Interval } from './candle';

@Controller('markets/:symbol/:interval')
export class MarketDataController {
  constructor(@Inject(MarketDataService) private readonly marketData: MarketDataService) {}

  @Post('candles')
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @Param('symbol') symbol: string,
    @Param('interval') interval: string,
    @Query('replace') replace: string | undefined,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Missing multipart file field "file"');
    const csvText = file.buffer.toString('utf8');
    return this.marketData.ingestCsv(symbol, interval as Interval, csvText, { replace: replace === 'true' });
  }

  @Get('days')
  async days(@Param('symbol') symbol: string, @Param('interval') interval: string) {
    return this.marketData.listStoredDays(symbol, interval as Interval);
  }

  @Get('candles')
  async candles(@Param('symbol') symbol: string, @Param('interval') interval: string, @Query('date') date: string) {
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestException('Query param "date" (YYYY-MM-DD) is required');
    const candles = await this.marketData.getDay(symbol, interval as Interval, date);
    return { symbol, interval, date, candles: candles ?? [] };
  }
}
