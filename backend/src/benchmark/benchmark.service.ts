import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { BenchmarkRepository, CellMeta, DayArtifactDoc } from './benchmark.repository';
import { RepoInputsService, DayInput, TraderInput, FeatureInput } from './repo-inputs.service';
import { DayArtifactsService } from './day-artifacts.service';
import { EnvelopeBuilder, DayBundle, TRAILING_PROMPT } from './envelope.builder';
import { LLM_PROVIDER } from '../llm/llm.constants';
import { LlmProvider } from '../llm/llm.provider';
import { BatchItemRequest } from '../llm/llm.types';
import { MarketDataService } from '../market-data/market-data.service';
import { ContractsService } from '../contracts/contracts.service';
import { analyzeCoverage } from '../market-data/coverage';
import { intervalToSeconds } from '../market-data/candle';
import { hhmmToMinutes } from '../common/session-time';
import { ALL_VARIANTS, SCORECARD_VARIANT, resolveModel, cellKey, parseCellKey, SETUP_SCHEMA, Variant } from './benchmark.types';
import { SevenKeysService } from './seven-keys/seven-keys.service';

// Symbol/interval the benchmark backtests against (see design §7).
const SYMBOL = 'MES';
const INTERVAL = 'min-5' as const;

export interface RunOptions {
  model?: string;
  days?: string[]; // MMDDYYYY filter
  runCount?: number;
  variants?: Variant[];
  // Force seven-keys regeneration for not-yet-benchmarked scorecard days (a
  // corrected trade plan). Never overrides immutability once a day is benchmarked.
  regenerateKeys?: boolean;
}

export interface RunSummary {
  model: { alias: string; id: string };
  batchesSubmitted: number;
  cellsQueued: number;
  daysSkipped: { day: string; reason: string }[];
}

@Injectable()
export class BenchmarkService {
  private readonly logger = new Logger(BenchmarkService.name);

  constructor(
    private readonly repo: BenchmarkRepository,
    private readonly inputs: RepoInputsService,
    private readonly dayArtifacts: DayArtifactsService,
    private readonly envelopes: EnvelopeBuilder,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly marketData: MarketDataService,
    // ContractsModule is @Global, so ContractsService injects without an import.
    private readonly contracts: ContractsService,
    private readonly sevenKeys: SevenKeysService,
    private readonly config: ConfigService,
  ) {}

  async run(opts: RunOptions = {}): Promise<RunSummary> {
    const model = resolveModel(opts.model ?? (this.config.get<string>('benchmark.model') as string));
    const runCount = opts.runCount ?? this.config.get<number>('benchmark.defaultRunCount') ?? 5;
    const maxTokens = this.config.get<number>('benchmark.maxTokens') ?? 32000;
    const effort = this.config.get<string>('benchmark.effort') ?? 'high';
    const variants = (opts.variants ?? ALL_VARIANTS).filter((v) => ALL_VARIANTS.includes(v));

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
      // FIX 1: compute the missing cells FIRST — this uses only existingRunIndices
      // + the in-flight `queued` set (no disk IO, no upload). A steady-state run
      // on an already-complete day must not read candles, assemble artifacts, or
      // re-upload the PDF.
      const dayCells: {
        trader: TraderInput;
        variant: Variant;
        feature?: FeatureInput;
        missing: number[];
      }[] = [];
      for (const trader of traders) {
        for (const variant of variants) {
          const feature = variant === 'base' ? undefined : featureById.get(variant);
          // A non-base variant with no matching feature file cannot build an
          // envelope — skip it rather than throwing later.
          if (variant !== 'base' && !feature) continue;
          const existing = await this.repo.existingRunIndices(trader.name, model.alias, day.day, variant);
          const already = queued.get(`${trader.name}|${model.alias}|${day.day}|${variant}`) ?? new Set<number>();
          const missing = Array.from({ length: runCount }, (_, i) => i + 1).filter(
            (n) => !existing.includes(n) && !already.has(n),
          );
          if (!missing.length) continue;
          dayCells.push({ trader, variant, feature, missing });
        }
      }
      // Nothing to do for this day — not a skip, just no work. No IO spent.
      if (!dayCells.length) continue;

      // FIX 2: per-day error isolation. One bad day (missing bytes, upload/API
      // failure, Firestore error) must not abort the whole run — report and move on.
      try {
        // Candle prerequisite: a day without ingested OHLC cannot be backtested.
        const candles = await this.marketData.getDay(SYMBOL, INTERVAL, day.date);
        if (!candles || candles.length === 0) {
          summary.daysSkipped.push({ day: day.day, reason: 'no candles' });
          continue;
        }
        // FIX 6: skip an incomplete RTH session before spending on assembly/warm/batch.
        if (!analyzeCoverage(candles, rthWindow).complete) {
          summary.daysSkipped.push({ day: day.day, reason: 'incomplete session' });
          continue;
        }

        // Only now (real work confirmed) do the disk reads + PDF upload.
        const bundle = await this.assembleDay(day);

        // Seven-keys generation for the scorecard variant. assembleDay recorded the
        // PDF artifact, so ensureKeys can resolve a live file_id. Days are already
        // walked oldest-first (collectDays sorts asc), so a day's prior-KEYS
        // lookback dependency is generated before it is needed.
        let keysContent: string | undefined;
        let keysSha: string | undefined;
        if (dayCells.some((c) => c.variant === SCORECARD_VARIANT)) {
          // `regenerateKeys` is the escape hatch for a corrected trade plan on a
          // not-yet-benchmarked day; ensureKeys still refuses to regenerate a day
          // that already has scorecard cells (immutable once benchmarked).
          // Freeze the day fully immutable if it already has IN-FLIGHT scorecard
          // cells (a submitted-but-unreconciled batch whose customIdToCell pinned this
          // KEYS content's artifactSha256). Otherwise a force-regenerate with a raised
          // runCount could overwrite the stored KEYS, orphaning those cells' provenance
          // once their batch reconciles.
          const scorecardInFlight = traders.some(
            (t) => (queued.get(`${t.name}|${model.alias}|${day.day}|${SCORECARD_VARIANT}`)?.size ?? 0) > 0,
          );
          let keysDoc: DayArtifactDoc | null = null;
          try {
            keysDoc = await this.sevenKeys.ensureKeys(day, { force: opts.regenerateKeys === true, pinned: scorecardInFlight });
          } catch (err) {
            // A scorecard/KEYS infra failure must not abort this day's base/method cells —
            // treat a throw the same as a null (skip only the scorecard variant, retry next run).
            this.logger.error(`Seven-keys ensureKeys threw for ${day.day}: ${(err as Error).message}`);
            keysDoc = null;
          }
          if (!keysDoc) {
            summary.daysSkipped.push({ day: day.day, reason: 'keys generation failed' });
            // Drop ONLY the scorecard cells; base/method still run for this day.
            for (let i = dayCells.length - 1; i >= 0; i--) {
              if (dayCells[i].variant === SCORECARD_VARIANT) dayCells.splice(i, 1);
            }
            if (!dayCells.length) continue; // scorecard was the only work
          } else {
            keysContent = keysDoc.content;
            keysSha = keysDoc.contentHash;
          }
        }

        const requests: BatchItemRequest[] = [];
        const customIdToCell: Record<string, CellMeta> = {};

        for (const { trader, variant, feature, missing } of dayCells) {
          const envelope = this.envelopes.fullEnvelope(general.concatenated, bundle.dayBundle, trader.content, {
            variant,
            featureBlock: feature?.block,
            methodsDoc: feature?.staticDocContent ?? undefined,
            artifact: variant === SCORECARD_VARIANT ? keysContent : undefined,
          });
          // Provenance threaded to the batch so the reconciler persists real
          // content hashes on every cell (design §4). base omits feature/doc hashes.
          const meta: CellMeta = {
            date: day.date,
            personaSha256: trader.sha256,
            generalSha256: general.sha256,
            ...(feature ? { featureSha256: feature.sha256 } : {}),
            ...(feature?.staticDocSha256 ? { staticDocSha256: feature.staticDocSha256 } : {}),
            ...(variant === SCORECARD_VARIANT && keysSha ? { artifactSha256: keysSha } : {}),
          };
          for (const runIndex of missing) {
            const key = cellKey({ trader: trader.name, modelAlias: model.alias, day: day.day, variant, runIndex });
            requests.push({ customId: key, prompt: TRAILING_PROMPT, envelope });
            customIdToCell[key] = meta;
          }
        }

        // No pre-batch warm here (previously a "two-stage warm" via a
        // provider-side warmCache — day-bundle prefix, then per-envelope). Cross-tier
        // cache sharing does not hold: a batch-tier request never reads a cache
        // entry written by a prior standard-tier call, confirmed empirically
        // (a single-item batch reusing an identical, freshly-read standard-tier
        // prefix still wrote its own fresh entry). That pre-warm was pure wasted
        // spend. The batch below still benefits from cache reuse WITHIN itself —
        // requests sharing an envelope prefix are written once and read cheaply
        // by the rest, which is confirmed to work.
        const batch = await this.llm.submitBatch(requests, undefined, {
          model: model.id,
          schema: SETUP_SCHEMA,
          maxTokens,
          effort,
        });
        // The submit->save window is inherently non-atomic. If saveBatch throws
        // AFTER submitBatch succeeded, the batch exists at the provider but no
        // BatchDoc will ever drain it — surface the orphan loudly (a full
        // idempotency-key fix is out of scope) before the day is recorded failed.
        try {
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
        } catch (saveErr) {
          this.logger.error(
            `Orphaned batch ${batch.batchId}: created at the provider but not persisted; reconciler will not drain it`,
          );
          throw saveErr;
        }
        summary.batchesSubmitted += 1;
        summary.cellsQueued += requests.length;
      } catch (err) {
        summary.daysSkipped.push({ day: day.day, reason: `error: ${(err as Error).message}` });
        continue;
      }
    }

    return summary;
  }

  // Store the PDF + transcripts, returning the assembled day bundle.
  private async assembleDay(day: DayInput): Promise<{ dayBundle: DayBundle }> {
    const pdf = await this.dayArtifacts.ensurePdf(day.day, day.prefix, readFileSync(day.pdfPath));
    const tpTranscript = readFileSync(day.planPath, 'utf8');
    const recapTranscript = readFileSync(day.recapPath, 'utf8');
    await this.dayArtifacts.ensureTranscript(day.day, 'tpTranscript', `${day.prefix}_ES_TP.md`, tpTranscript);
    await this.dayArtifacts.ensureTranscript(day.day, 'recapTranscript', `${day.recapPath.split('/').pop()}`, recapTranscript);
    return {
      dayBundle: {
        date: day.date,
        fileId: pdf.providerFileId,
        tpTranscript,
        recapTranscript,
      },
    };
  }
}
