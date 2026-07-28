import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { AnthropicService, CachedContext } from '../../anthropic/anthropic.service';
import { BenchmarkRepository, DayArtifactDoc } from '../benchmark.repository';
import { RepoInputsService, DayInput } from '../repo-inputs.service';
import { DayArtifactsService } from '../day-artifacts.service';
import { CURRENT_SCHEMA, LOOKBACK_SCHEMA, SYNTH_SCHEMA, VERIFY_SCHEMA } from './schemas';
import { currentDayPrompt, generalAndMethodsBlock, lookbackPrompt, synthesizePrompt, verifyPrompt, LookbackEntry } from './prompts';

// All four agents run on Fable; the current-day analyst is a distinct hard pin
// (a blind comparison found it more methodology-faithful than Sonnet for grading).
const SEVEN_KEYS_MODEL = 'claude-fable-5';
const CURRENT_DAY_MODEL = 'claude-fable-5';

export interface KeysArtifact {
  verified: boolean;
  artifact: string; // synthesizer markdown body (no frontmatter)
  mismatches: string[];
  lookbackSources: string[]; // '<day>_ES_KEYS.md', oldest-first (or [])
  lookbackMissing: string[]; // recent prior complete day(s) with no KEYS (reduced-lookback signal; [] normally)
}

@Injectable()
export class SevenKeysService {
  private readonly logger = new Logger(SevenKeysService.name);

  constructor(
    private readonly anthropic: AnthropicService,
    private readonly repo: BenchmarkRepository,
    private readonly inputs: RepoInputsService,
    private readonly dayArtifacts: DayArtifactsService,
    private readonly config: ConfigService,
  ) {}

  private get effort(): string {
    return this.config.get<string>('benchmark.effort') ?? 'high';
  }

  // messageStructured falls back to the generic anthropic.maxTokens demo default
  // (4096) when omitted — too low for Fable's always-on thinking at high effort,
  // which silently truncates every structured call mid-JSON. Every seven-keys
  // call must use the benchmark ceiling instead.
  private get maxTokens(): number {
    return this.config.get<number>('benchmark.maxTokens') ?? 32000;
  }

  private pdfContext(fileId: string): CachedContext {
    return { userTiers: [{ blocks: [{ type: 'document', source: { type: 'file', file_id: fileId } } as any] }] };
  }

  // Current-day gets TWO cache tiers: the general-docs+methodology tier (stable
  // across every day of a benchmark run, so it stays first — most-stable content
  // must precede the per-day PDF tier for the prefix match to keep holding), then
  // the PDF. Previously generalDocs/methodsDoc were inlined into the uncached
  // trailing prompt text on every call — full price, every day, no reuse (see the
  // Fable-cost pressure test). This is the only call that needs generalDocs.
  private currentDayContext(fileId: string, generalDocs: string, methodsDoc: string): CachedContext {
    return {
      userTiers: [
        { blocks: [{ type: 'text', text: generalAndMethodsBlock(generalDocs, methodsDoc) }] },
        { blocks: [{ type: 'document', source: { type: 'file', file_id: fileId } } as any] },
      ],
    };
  }

  /** Runs current-day ∥ lookback -> synthesize -> verify on Fable. Never persists. */
  async generate(day: DayInput): Promise<KeysArtifact> {
    const methodsDoc = this.inputs.readMethodsDoc();
    if (!methodsDoc) throw new Error(`Seven-keys methods doc missing (day ${day.day})`);
    const general = this.inputs.collectGeneralDocs();
    const tpTranscript = readFileSync(day.planPath, 'utf8');
    const recapTranscript = readFileSync(day.recapPath, 'utf8');
    const fileId = await this.dayArtifacts.ensureFileId(day.day);

    // Lookback set: up-to-3 most recent prior complete days that already have KEYS,
    // oldest-first. Oldest-first generation upstream guarantees they exist. Any of
    // the 3 most recent complete days WITHOUT a KEYS artifact is recorded in
    // lookbackMissing so a mid-run failure's silent calibration degradation on the
    // later days is observable.
    const prior = this.inputs.priorCompleteDays(day.day);
    const haveKeys = new Set<string>();
    const withKeys: LookbackEntry[] = [];
    for (const p of prior) {
      const doc = await this.repo.getDayArtifact(p.day, 'keys');
      if (!doc?.content) continue;
      haveKeys.add(p.day);
      const recapPath = this.inputs.outcomeRecapPathForDay(p.day);
      withKeys.push({
        day: p.day,
        keysContent: doc.content,
        outcomeRecap: recapPath ? readFileSync(recapPath, 'utf8') : null,
      });
    }
    const lookbackSet = withKeys.slice(-3); // 3 most recent, still oldest-first
    const lookbackSources = lookbackSet.map((l) => `${l.day}_ES_KEYS.md`);
    const lookbackMissing = prior.slice(-3).filter((p) => !haveKeys.has(p.day)).map((p) => p.day);

    // Each call is retried on a transient upstream failure so one flaky step does
    // not throw away the prior Fable calls (a 422 refusal is NOT retried).
    const currentPromise = this.withRetry('current-day', () =>
      this.anthropic.messageStructured<Record<string, unknown>>(
        { prompt: currentDayPrompt({ date: day.date, tpTranscript, recapTranscript }) },
        { operation: 'keys-generation', benchmark: { modelAlias: 'fable', day: day.day } },
        {
          model: CURRENT_DAY_MODEL,
          outputSchema: CURRENT_SCHEMA,
          files: true,
          effort: this.effort,
          maxTokens: this.maxTokens,
          context: this.currentDayContext(fileId, general.concatenated, methodsDoc),
        },
      ),
    );
    const lookbackPromise: Promise<Record<string, unknown> | null> = lookbackSet.length
      ? this.withRetry('lookback', () =>
          this.anthropic.messageStructured<Record<string, unknown>>(
            { prompt: lookbackPrompt(day.date, lookbackSet) },
            { operation: 'keys-generation', benchmark: { modelAlias: 'fable', day: day.day } },
            { model: SEVEN_KEYS_MODEL, outputSchema: LOOKBACK_SCHEMA, effort: this.effort, maxTokens: this.maxTokens },
          ),
        )
      : Promise.resolve(null);
    const [current, lookback] = await Promise.all([currentPromise, lookbackPromise]);

    const sources = lookbackSet.length ? lookbackSources.join(' · ') : 'none — bootstrap';
    const synth = await this.withRetry('synthesize', () =>
      this.anthropic.messageStructured<{ artifact: string }>(
        { prompt: synthesizePrompt(day.date, current, lookback, sources) },
        { operation: 'keys-generation', benchmark: { modelAlias: 'fable', day: day.day } },
        { model: SEVEN_KEYS_MODEL, outputSchema: SYNTH_SCHEMA, effort: this.effort, maxTokens: this.maxTokens },
      ),
    );

    const verdict = await this.withRetry('verify', () =>
      this.anthropic.messageStructured<{ pass: boolean; mismatches: string[] }>(
        { prompt: verifyPrompt(day.date, tpTranscript, synth.artifact) },
        { operation: 'keys-generation', benchmark: { modelAlias: 'fable', day: day.day } },
        { model: SEVEN_KEYS_MODEL, outputSchema: VERIFY_SCHEMA, files: true, effort: this.effort, maxTokens: this.maxTokens, context: this.pdfContext(fileId) },
      ),
    );

    return { verified: verdict.pass, mismatches: verdict.mismatches, artifact: synth.artifact, lookbackSources, lookbackMissing };
  }

  /**
   * Idempotent KEYS resolution with a two-level freeze:
   * - Immutable once the day's KEYS are pinned by a scorecard cell — either
   *   persisted (`hasScorecardCells`) or in-flight (`opts.pinned`, a
   *   submitted-but-unreconciled batch). The stored artifact is reused
   *   unconditionally, even under `opts.force`, so a recorded `artifactSha256`
   *   never dangles; a missing artifact in this state is refused (null), not
   *   silently regenerated.
   * - Refreshable until then: reuse a stored artifact only while it is verified
   *   and its `inputsHash` is unchanged; a corrected trade plan (inputsHash drift),
   *   an unverified leftover, or `opts.force` triggers regeneration.
   * Otherwise generates + verifies + persists. Returns the persisted doc, or null
   * (logged) when generation/verification fails so the caller skips the scorecard
   * variant for the day.
   */
  async ensureKeys(day: DayInput, opts?: { force?: boolean; pinned?: boolean }): Promise<DayArtifactDoc | null> {
    const existing = await this.repo.getDayArtifact(day.day, 'keys');
    const benchmarked = await this.repo.hasScorecardCells(day.day);
    // (1) Immutable when benchmarked OR pinned: a scorecard cell recorded this KEYS
    // content's hash (artifactSha256), so the artifact must never change for
    // reproducibility — reuse unconditionally, even when force is set. `pinned`
    // covers in-flight (submitted-but-unreconciled) scorecard cells that have already
    // pinned this KEYS hash but whose batch has not yet persisted its cells, so
    // hasScorecardCells does not yet see them.
    if (benchmarked || opts?.pinned === true) {
      if (existing) return existing;
      // Anomaly: immutable but the KEYS artifact is missing. Regenerating would
      // break the artifactSha256 already pinned on those scorecard cells, so refuse
      // rather than silently overwrite.
      this.logger.error(
        `Seven-keys for ${day.day}: scorecard cells exist but the KEYS artifact is missing; refusing to regenerate (would break cell provenance).`,
      );
      return null;
    }
    // (2) Refreshable until benchmarked: reuse only a VERIFIED artifact whose
    // generation inputs are unchanged. A corrected trade plan (inputsHash drift), an
    // unverified leftover, or an explicit force all fall through to (re)generation.
    const inputsHash = this.computeInputsHash(day);
    if (!opts?.force && existing?.verified && existing.inputsHash === inputsHash) return existing;

    let result: KeysArtifact;
    try {
      result = await this.generate(day);
    } catch (err) {
      this.logger.error(`Seven-keys generation failed for ${day.day}: ${(err as Error).message}`);
      return null;
    }
    if (!result.verified) {
      this.logger.warn(`Seven-keys verifier failed for ${day.day}: ${result.mismatches.join('; ')}`);
      return null;
    }
    if (result.lookbackMissing.length) {
      // Surface silent calibration degradation: an oldest-first run that failed on
      // an earlier day leaves the later days with a reduced lookback set.
      this.logger.warn(
        `Seven-keys for ${day.day} generated with a reduced lookback — recent prior day(s) without KEYS: ${result.lookbackMissing.join(', ')}`,
      );
    }
    const generatedAt = new Date().toISOString();
    const content = this.composeKeysMarkdown(result.artifact, generatedAt, result.lookbackSources);
    const doc: DayArtifactDoc = {
      contentHash: createHash('sha256').update(content).digest('hex'),
      gcsPath: `benchmark/es/${day.day}/${day.prefix}_ES_KEYS.md`, // inline-stored; path is a stable marker
      content,
      uploadedAt: generatedAt,
      generatedBy: CURRENT_DAY_MODEL,
      generatedAt,
      lookbackSources: result.lookbackSources,
      lookbackMissing: result.lookbackMissing,
      verified: true,
      inputsHash,
    };
    await this.repo.saveDayArtifact(day.day, 'keys', doc);
    return doc;
  }

  // sha256 over the exact generation inputs (PDF bytes + both transcripts + the
  // methodology doc). ensureKeys reuses a not-yet-benchmarked artifact only while
  // this is unchanged, so a corrected trade plan regenerates instead of serving
  // stale KEYS. (Only read on the non-immutable path — a benchmarked day returns
  // before this is called.)
  private computeInputsHash(day: DayInput): string {
    const pdf = readFileSync(day.pdfPath);
    const tp = readFileSync(day.planPath, 'utf8');
    const recap = readFileSync(day.recapPath, 'utf8');
    const methods = this.inputs.readMethodsDoc() ?? '';
    return createHash('sha256').update(pdf).update('\x00').update(tp).update('\x00').update(recap).update('\x00').update(methods).digest('hex');
  }

  // Faithful port of the skill's committed KEYS file: YAML frontmatter + body.
  private composeKeysMarkdown(artifactBody: string, generatedAt: string, lookbackSources: string[]): string {
    return [
      '---',
      `generatedBy: ${CURRENT_DAY_MODEL}`,
      `generatedAt: ${generatedAt}`,
      `lookbackSources: [${lookbackSources.join(', ')}]`,
      'verified: true',
      '---',
      '',
      artifactBody.trim(),
      '',
    ].join('\n');
  }

  // Bounded retry for the generation chain. Retries only transient upstream
  // failures (HTTP 429 / 5xx, or a raw non-HttpException error) so one flaky call
  // doesn't discard the prior Fable calls; a 422 refusal — a deterministic content
  // decision — is NOT retried and propagates to ensureKeys as a day skip.
  private async withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const MAX_ATTEMPTS = 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (attempt === MAX_ATTEMPTS || !this.isTransient(err)) throw err;
        this.logger.warn(
          `Seven-keys ${label} attempt ${attempt} failed transiently (${(err as Error).name}): ${(err as Error).message}; retrying`,
        );
      }
    }
    throw lastErr;
  }

  private isTransient(err: unknown): boolean {
    if (err instanceof HttpException) {
      const status = err.getStatus();
      return status === HttpStatus.TOO_MANY_REQUESTS || status >= 500;
    }
    return true; // socket hang-up / DNS / other non-HTTP error — worth another try
  }
}
