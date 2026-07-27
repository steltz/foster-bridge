import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { BenchmarkRepository } from './benchmark.repository';
import { RepoInputsService } from './repo-inputs.service';
import { DayArtifactsService } from './day-artifacts.service';
import { EnvelopeBuilder } from './envelope.builder';
import { AnthropicService } from '../anthropic/anthropic.service';
import { parseCellKey } from './benchmark.types';

// 55 minutes < the 1h ephemeral TTL. @Interval fires every fixed span from
// boot; a cron minute field cannot express "every 55 minutes" (see plan note).
const WARM_INTERVAL_MS = 55 * 60 * 1000;

@Injectable()
export class CacheWarmer {
  private readonly logger = new Logger(CacheWarmer.name);

  constructor(
    private readonly repo: BenchmarkRepository,
    private readonly inputs: RepoInputsService,
    private readonly dayArtifacts: DayArtifactsService,
    private readonly envelopes: EnvelopeBuilder,
    private readonly anthropic: AnthropicService,
    private readonly config: ConfigService,
  ) {}

  @Interval('bench-cache-warm', WARM_INTERVAL_MS)
  async warm(): Promise<void> {
    const batches = await this.repo.nonTerminalBatches();
    if (!batches.length) return;
    const general = this.inputs.collectGeneralDocs().concatenated;
    const traders = new Map(this.inputs.collectTraders().map((t) => [t.name, t]));
    const features = new Map(this.inputs.collectFeatures().map((f) => [f.id, f]));
    const effort = this.config.get<string>('benchmark.effort') ?? 'high';
    // Avoid re-warming the same (model, day, trader, variant) twice this pass.
    const seen = new Set<string>();

    for (const batch of batches) {
      try {
        // Live file_id — re-derived from the GCS origin if Anthropic GC'd it.
        const fileId = await this.dayArtifacts.ensureFileId(batch.day);
        const tp = await this.repo.getDayArtifact(batch.day, 'tpTranscript');
        const recap = await this.repo.getDayArtifact(batch.day, 'recapTranscript');
        const bundle = {
          date: batch.date,
          anthropicFileId: fileId,
          tpTranscript: tp?.content ?? '',
          recapTranscript: recap?.content ?? '',
        };
        const distinct = new Set<string>();
        for (const id of Object.keys(batch.customIdToCell ?? {})) {
          const p = parseCellKey(id);
          distinct.add(`${p.trader}::${p.variant}`);
        }
        for (const key of distinct) {
          const dedup = `${batch.model.id}|${batch.day}|${key}`;
          if (seen.has(dedup)) continue;
          seen.add(dedup);
          const [traderName, variant] = key.split('::');
          const trader = traders.get(traderName);
          if (!trader) continue;
          const feature = variant === 'base' ? undefined : features.get(variant);
          // Re-warm the FULL envelope so persona + feature tiers stay hot for
          // long-running batches — not just the shared day-bundle tier.
          const envelope = this.envelopes.fullEnvelope(general, bundle, trader.content, {
            variant,
            featureBlock: feature?.block,
            methodsDoc: feature?.staticDocContent ?? undefined,
          });
          await this.anthropic.warmCache(envelope, { model: batch.model.id, files: true, effort });
        }
      } catch (err) {
        this.logger.error(`Re-warm for day ${batch.day} failed: ${(err as Error).message}`);
      }
    }
  }
}
