import { Module } from '@nestjs/common';
import { TranscriptModule } from '../transcript/transcript.module';
import { PlaywrightService } from './playwright.service';
import { EminiplayerService } from './eminiplayer.service';
import { EminiplayerVerifyService } from './eminiplayer-verify.service';
import { EminiplayerManifestService } from './eminiplayer-manifest.service';
import { EminiplayerIngestService } from './eminiplayer-ingest.service';
import { EminiplayerAuditService } from './eminiplayer-audit.service';
import { EminiplayerBackfillService } from './eminiplayer-backfill.service';
import { EminiplayerPruneService } from './eminiplayer-prune.service';

@Module({
  imports: [TranscriptModule],
  providers: [
    PlaywrightService,
    EminiplayerService,
    EminiplayerVerifyService,
    EminiplayerManifestService,
    EminiplayerIngestService,
    EminiplayerAuditService,
    EminiplayerBackfillService,
    EminiplayerPruneService,
  ],
  // PlaywrightService is deliberately NOT exported: the shared page has a
  // single owner and all access must go through EminiplayerService.
  exports: [
    EminiplayerService,
    EminiplayerIngestService,
    EminiplayerAuditService,
    EminiplayerBackfillService,
    EminiplayerPruneService,
  ],
})
export class EminiplayerModule {}
