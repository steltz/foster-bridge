import { Module } from '@nestjs/common';
import { PlaywrightService } from './playwright.service';
import { EminiplayerService } from './eminiplayer.service';

@Module({
  providers: [PlaywrightService, EminiplayerService],
  // PlaywrightService is deliberately NOT exported: the shared page has a
  // single owner and all access must go through EminiplayerService.
  exports: [EminiplayerService],
})
export class EminiplayerModule {}
