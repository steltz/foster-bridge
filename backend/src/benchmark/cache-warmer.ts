import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { BenchmarkRepository } from './benchmark.repository';
import { CloudInputsService } from './cloud-inputs.service';
import { DayArtifactsService } from './day-artifacts.service';
import { EnvelopeBuilder } from './envelope.builder';
import { LLM_PROVIDER } from '../llm/llm.constants';
import { LlmProvider } from '../llm/llm.provider';
import { requireCapabilities } from '../llm/require-capabilities';
import { parseCellKey, SETUP_SCHEMA } from './benchmark.types';

// 55 minutes < the 1h ephemeral TTL. @Interval fires every fixed span from
// boot; a cron minute field cannot express "every 55 minutes" (see plan note).
const WARM_INTERVAL_MS = 55 * 60 * 1000;

@Injectable()
export class CacheWarmer {
  private readonly logger = new Logger(CacheWarmer.name);
  private readonly schedulerEnabled: boolean;

  constructor(
    private readonly repo: BenchmarkRepository,
    private readonly inputs: CloudInputsService,
    private readonly dayArtifacts: DayArtifactsService,
    private readonly envelopes: EnvelopeBuilder,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly config: ConfigService,
  ) {
    this.schedulerEnabled = config.get<boolean>('benchmark.schedulerEnabled') ?? false;
  }

  // Thin scheduled trigger — gated so only a dedicated worker runs the interval.
  // The core warm() below stays public/ungated for tests + manual runs.
  @Interval('bench-cache-warm', WARM_INTERVAL_MS)
  scheduledWarm(): void {
    if (!this.schedulerEnabled) return;
    void this.warm().catch((e) => this.logger.error(`scheduled cache warm failed: ${e}`));
  }

  async warm(): Promise<void> {
    // Moonshot needs no warming: its implicit cache has no write surcharge and
    // no fixed TTL to beat, so a warm pre-pays the exact miss the first real
    // request would pay anyway — while the throwaway completion still reasons
    // at full output price (kimi-k3 cannot disable thinking), untracked by cost
    // capture. Concurrent same-prefix misses are already prevented by the batch
    // worker's prime phases. The 55-min interval below is tuned to Anthropic's
    // 1h ephemeral TTL and is meaningless for Moonshot's system-managed cache.
    if ((this.config.get<string>('llm.provider') ?? 'anthropic') === 'moonshot') return;
    requireCapabilities(this.llm, ['batch', 'fileUpload']);
    const batches = await this.repo.nonTerminalBatches();
    if (!batches.length) return;
    const snap = await this.inputs.snapshot();
    const general = snap.general.concatenated;
    const traders = new Map(snap.traders.map((t) => [t.name, t]));
    const features = new Map(snap.features.map((f) => [f.id, f]));
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
          fileId,
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
          try {
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
            // Fire-and-forget BATCH submission — NOT a sync warmCache() call.
            // Cache entries are scoped per service tier: a standard-tier warm
            // is never visible to a batch-tier request (confirmed empirically —
            // a single-item batch reusing an identical, freshly-read
            // standard-tier cache prefix still wrote its own fresh entry
            // instead of reading it). Re-warming for BatchReconciler's batches
            // therefore has to happen AS a tiny batch so the write lands in the
            // same cache pool those batches read from. We don't poll or
            // reconcile this throwaway request — its cost is untracked, same
            // as any other fire-and-forget submission.
            // Carries SETUP_SCHEMA + effort identically to the real batch's
            // requests (see submitBatch) — a mismatched output_config hashes
            // to a different cache key, so the batch could never read it.
            await this.llm.submitBatch(
              [{ prompt: 'Cache warm — ignore this request.' }],
              envelope,
              { model: batch.model.id, effort, schema: SETUP_SCHEMA },
            );
          } catch (err) {
            // Isolate one flaky warm (e.g. transient API error) so it doesn't
            // drop the other distinct (trader,variant) pairs of this batch.
            this.logger.warn(
              `Re-warm for ${traderName}/${variant} (day ${batch.day}) failed: ${(err as Error).message}`,
            );
          }
        }
      } catch (err) {
        this.logger.error(`Re-warm for day ${batch.day} failed: ${(err as Error).message}`);
      }
    }
  }
}
