import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { BenchmarkRepository, CellMeta } from './benchmark.repository';
import { RepoInputsService, DayInput } from './repo-inputs.service';
import { DayArtifactsService } from './day-artifacts.service';
import { EnvelopeBuilder, DayBundle, TRAILING_PROMPT } from './envelope.builder';
import { AnthropicService, BatchRequestInput } from '../anthropic/anthropic.service';
import { MarketDataService } from '../market-data/market-data.service';
import { ContractsService } from '../contracts/contracts.service';
import { analyzeCoverage } from '../market-data/coverage';
import { intervalToSeconds } from '../market-data/candle';
import { hhmmToMinutes } from '../common/session-time';
import { CORE_VARIANTS, resolveModel, cellKey, parseCellKey, SETUP_SCHEMA, Variant } from './benchmark.types';

// Symbol/interval the benchmark backtests against (see design §7).
const SYMBOL = 'MES';
const INTERVAL = 'min-5' as const;

export interface RunOptions {
  model?: string;
  days?: string[]; // MMDDYYYY filter
  runCount?: number;
  variants?: Variant[];
}

export interface RunSummary {
  model: { alias: string; id: string };
  batchesSubmitted: number;
  cellsQueued: number;
  daysSkipped: { day: string; reason: string }[];
}

@Injectable()
export class BenchmarkService {
  constructor(
    private readonly repo: BenchmarkRepository,
    private readonly inputs: RepoInputsService,
    private readonly dayArtifacts: DayArtifactsService,
    private readonly envelopes: EnvelopeBuilder,
    private readonly anthropic: AnthropicService,
    private readonly marketData: MarketDataService,
    // ContractsModule is @Global, so ContractsService injects without an import.
    private readonly contracts: ContractsService,
    private readonly config: ConfigService,
  ) {}

  async run(opts: RunOptions = {}): Promise<RunSummary> {
    const model = resolveModel(opts.model ?? (this.config.get<string>('benchmark.model') as string));
    const runCount = opts.runCount ?? this.config.get<number>('benchmark.defaultRunCount') ?? 5;
    const maxTokens = this.config.get<number>('benchmark.maxTokens') ?? 32000;
    const effort = this.config.get<string>('benchmark.effort') ?? 'high';
    const variants = (opts.variants ?? CORE_VARIANTS).filter((v) => CORE_VARIANTS.includes(v));

    const traders = this.inputs.collectTraders();
    const features = this.inputs.collectFeatures();
    const general = this.inputs.collectGeneralDocs();
    const featureById = new Map(features.map((f) => [f.id, f]));

    let days = this.inputs.collectDays();
    if (opts.days?.length) days = days.filter((d) => opts.days!.includes(d.day));

    const summary: RunSummary = { model, batchesSubmitted: 0, cellsQueued: 0, daysSkipped: [] };

    // FIX 7: report day-folders dropped for missing docs.
    let issues = this.inputs.collectDayIssues();
    if (opts.days?.length) issues = issues.filter((i) => opts.days!.includes(i.day));
    for (const issue of issues) {
      summary.daysSkipped.push({ day: issue.day, reason: `missing docs: ${issue.missing.join(', ')}` });
    }

    // FIX 4: never re-submit a run-index already queued in an in-flight batch
    // (a submitted/in-progress/ended batch whose cells are not yet persisted).
    const inFlight = await this.repo.nonTerminalBatches();
    const queued = new Map<string, Set<number>>();
    for (const batch of inFlight) {
      for (const id of Object.keys(batch.customIdToCell ?? {})) {
        const p = parseCellKey(id);
        const k = `${p.trader}|${p.modelAlias}|${p.day}|${p.variant}`;
        if (!queued.has(k)) queued.set(k, new Set());
        queued.get(k)!.add(p.runIndex);
      }
    }

    const spec = this.contracts.get(SYMBOL);
    const rthWindow = {
      openMin: hhmmToMinutes(spec.rth.open),
      closeMin: hhmmToMinutes(spec.rth.close),
      intervalSec: intervalToSeconds(INTERVAL),
      tz: spec.timezone,
    };

    for (const day of days) {
      // Candle prerequisite: a day without ingested OHLC cannot be backtested.
      const candles = await this.marketData.getDay(SYMBOL, INTERVAL, day.date);
      if (!candles || candles.length === 0) {
        summary.daysSkipped.push({ day: day.day, reason: 'no candles' });
        continue;
      }
      // FIX 6: skip an incomplete RTH session before spending on warm/batch.
      if (!analyzeCoverage(candles, rthWindow).complete) {
        summary.daysSkipped.push({ day: day.day, reason: 'incomplete session' });
        continue;
      }

      // Compute the missing cells for this day across traders x variants.
      const requests: BatchRequestInput[] = [];
      const customIdToCell: Record<string, CellMeta> = {};
      const enveloped = new Map<string, ReturnType<EnvelopeBuilder['fullEnvelope']>>();

      const bundle = await this.assembleDay(day, general.concatenated);

      for (const trader of traders) {
        for (const variant of variants) {
          const feature = variant === 'base' ? undefined : featureById.get(variant);
          const envKey = `${trader.name}::${variant}`;
          const envelope = this.envelopes.fullEnvelope(general.concatenated, bundle.dayBundle, trader.content, {
            variant,
            featureBlock: feature?.block,
            methodsDoc: feature?.staticDocContent ?? undefined,
          });
          const existing = await this.repo.existingRunIndices(trader.name, model.alias, day.day, variant);
          const already = queued.get(`${trader.name}|${model.alias}|${day.day}|${variant}`) ?? new Set<number>();
          const missing = Array.from({ length: runCount }, (_, i) => i + 1).filter(
            (n) => !existing.includes(n) && !already.has(n),
          );
          if (!missing.length) continue;
          enveloped.set(envKey, envelope);
          // Provenance threaded to the batch so the reconciler persists real
          // content hashes on every cell (design §4). base omits feature/doc hashes.
          const meta: CellMeta = {
            date: day.date,
            personaSha256: trader.sha256,
            generalSha256: general.sha256,
            ...(feature ? { featureSha256: feature.sha256 } : {}),
            ...(feature?.staticDocSha256 ? { staticDocSha256: feature.staticDocSha256 } : {}),
          };
          for (const runIndex of missing) {
            const key = cellKey({ trader: trader.name, modelAlias: model.alias, day: day.day, variant, runIndex });
            requests.push({ customId: key, prompt: TRAILING_PROMPT, context: envelope });
            customIdToCell[key] = meta;
          }
        }
      }

      if (!requests.length) continue;

      // Two-stage warm on the beta/files path with matching effort so the
      // warm's cached prefix aligns with the batch requests.
      await this.anthropic.warmCache(this.envelopes.dayBundleContext(general.concatenated, bundle.dayBundle), {
        model: model.id,
        files: true,
        effort,
      });
      for (const envelope of enveloped.values()) {
        await this.anthropic.warmCache(envelope, { model: model.id, files: true, effort });
      }

      const batch = await this.anthropic.createBatch(requests, undefined, {
        model: model.id,
        outputSchema: SETUP_SCHEMA,
        maxTokens,
        effort,
        files: true,
      });
      await this.repo.saveBatch({
        batchId: batch.batchId,
        day: day.day,
        date: day.date,
        pdfPrefix: day.prefix,
        model,
        status: 'submitted',
        customIdToCell,
        submittedAt: new Date().toISOString(),
      });
      summary.batchesSubmitted += 1;
      summary.cellsQueued += requests.length;
    }

    return summary;
  }

  // Store the PDF + transcripts, returning the assembled day bundle.
  private async assembleDay(day: DayInput, _generalDocs: string): Promise<{ dayBundle: DayBundle }> {
    const pdf = await this.dayArtifacts.ensurePdf(day.day, day.prefix, readFileSync(day.pdfPath));
    const tpTranscript = readFileSync(day.planPath, 'utf8');
    const recapTranscript = readFileSync(day.recapPath, 'utf8');
    await this.dayArtifacts.ensureTranscript(day.day, 'tpTranscript', `${day.prefix}_ES_TP.md`, tpTranscript);
    await this.dayArtifacts.ensureTranscript(day.day, 'recapTranscript', `${day.recapPath.split('/').pop()}`, recapTranscript);
    return {
      dayBundle: {
        date: day.date,
        anthropicFileId: pdf.anthropicFileId,
        tpTranscript,
        recapTranscript,
      },
    };
  }
}
