import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { LLM_PROVIDER } from '../../llm/llm.constants';
import { LlmProvider } from '../../llm/llm.provider';
import { PromptEnvelope } from '../../llm/llm.types';
import { BenchmarkRepository, DayArtifactDoc } from '../benchmark.repository';
import { CloudInputsService, DayInput, InputsSnapshot } from '../cloud-inputs.service';
import { DayArtifactsService } from '../day-artifacts.service';
import { resolveModel } from '../benchmark.types';
import { CURRENT_SCHEMA, LOOKBACK_SCHEMA, SYNTH_SCHEMA, VERIFY_SCHEMA } from './schemas';
import { currentDayPrompt, generalAndMethodsBlock, lookbackPrompt, synthesizePrompt, verifyPrompt, LookbackEntry } from './prompts';

export interface KeysArtifact {
  verified: boolean;
  artifact: string; // synthesizer markdown body (no frontmatter)
  mismatches: string[];
  lookbackSources: string[]; // '<day>_ES_KEYS.md', oldest-first (or [])
  lookbackMissing: string[]; // recent prior complete day(s) with no KEYS (reduced-lookback signal; [] normally)
}

export interface KeysFailure {
  kind: 'unverified' | 'error' | 'refused';
  message: string;
  mismatches: string[];
}

/** Prior days the lookback analyst calibrates against, newest-first then reversed. */
const LOOKBACK_DAYS = 3;

@Injectable()
export class SevenKeysService {
  private readonly logger = new Logger(SevenKeysService.name);

  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly repo: BenchmarkRepository,
    private readonly inputs: CloudInputsService,
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

  // Provider-aware flagship (Fable on Anthropic, Kimi K3 on Moonshot). All four
  // seven-keys agents run on it; on Anthropic a blind comparison found Fable
  // more methodology-faithful than Sonnet for grading; current-day is no
  // longer a separate pin.
  private get flagship(): { alias: string; id: string } {
    return resolveModel(this.config.get<string>('benchmark.model') ?? 'claude-fable-5');
  }

  private get flagshipModel(): string {
    return this.flagship.id;
  }

  private get flagshipAlias(): string {
    return this.flagship.alias;
  }

  /** The KEYS lineage this instance reads and writes (e.g. 'k3'). */
  get lineageAlias(): string {
    return this.flagshipAlias;
  }

  private pdfContext(fileId: string): PromptEnvelope {
    return { tiers: [{ blocks: [{ type: 'file', fileId }] }] };
  }

  // Current-day gets TWO cache tiers: the general-docs+methodology tier (stable
  // across every day of a benchmark run, so it stays first — most-stable content
  // must precede the per-day PDF tier for the prefix match to keep holding), then
  // the PDF. Previously generalDocs/methodsDoc were inlined into the uncached
  // trailing prompt text on every call — full price, every day, no reuse (see the
  // Fable-cost pressure test). This is the only call that needs generalDocs.
  private currentDayContext(fileId: string, generalDocs: string, methodsDoc: string): PromptEnvelope {
    return {
      tiers: [
        { blocks: [{ type: 'text', text: generalAndMethodsBlock(generalDocs, methodsDoc) }] },
        { blocks: [{ type: 'file', fileId }] },
      ],
    };
  }

  /** Runs current-day ∥ lookback -> synthesize -> verify on the flagship model. Never persists. */
  async generate(day: DayInput, snap: InputsSnapshot): Promise<KeysArtifact> {
    const methodsDoc = snap.methodsDoc;
    if (!methodsDoc) throw new Error(`Seven-keys methods doc missing (day ${day.day})`);
    const general = snap.general;
    const tpTranscript = day.tpTranscript;
    const recapTranscript = day.recapTranscript;
    const fileId = await this.dayArtifacts.ensureFileId(day.day);

    // Lookback set: up-to-3 most recent prior complete days that already have KEYS,
    // oldest-first. Oldest-first generation upstream guarantees they exist. Any of
    // the 3 most recent complete days WITHOUT a KEYS artifact is recorded in
    // lookbackMissing so a mid-run failure's silent calibration degradation on the
    // later days is observable.
    const prior = this.inputs.priorCompleteDays(day.day, snap);
    const haveKeys = new Set<string>();
    // Walk NEWEST-first and stop once LOOKBACK_DAYS are in hand. Scanning the
    // whole prior list and slicing the tail costs one Firestore read (plus a
    // recap download) per prior day and discards all but three — O(days²) over
    // a corpus-wide sequential build, where every prior day has KEYS.
    const newestFirst: LookbackEntry[] = [];
    for (let i = prior.length - 1; i >= 0 && newestFirst.length < LOOKBACK_DAYS; i--) {
      const p = prior[i];
      // Same-lineage lookback: a flagship calibrates only against its own prior
      // assessments — Kimi never reads Fable's keys (nor vice versa).
      const doc = await this.repo.getKeysArtifact(p.day, this.flagshipAlias);
      if (!doc?.content) continue;
      haveKeys.add(p.day);
      const outcomeRecap = await this.inputs.outcomeRecapForDay(p.day, snap);
      newestFirst.push({
        day: p.day,
        keysContent: doc.content,
        outcomeRecap,
      });
    }
    // The loop always reaches the most recent LOOKBACK_DAYS prior days before it
    // can stop, so haveKeys is authoritative for the lookbackMissing check below.
    const lookbackSet = newestFirst.reverse(); // oldest-first, as lookbackPrompt expects
    const lookbackSources = lookbackSet.map((l) => `${l.day}_ES_KEYS.md`);
    const lookbackMissing = prior
      .slice(-LOOKBACK_DAYS)
      .filter((p) => !haveKeys.has(p.day))
      .map((p) => p.day);

    // Each call is retried on a transient upstream failure so one flaky step does
    // not throw away the prior flagship calls (a 422 refusal is NOT retried).
    const currentPromise = this.withRetry('current-day', () =>
      this.llm.messageStructured<Record<string, unknown>>(
        {
          prompt: currentDayPrompt({ date: day.date, tpTranscript, recapTranscript }),
          model: this.flagshipModel,
          schema: CURRENT_SCHEMA,
          effort: this.effort,
          maxTokens: this.maxTokens,
          envelope: this.currentDayContext(fileId, general.concatenated, methodsDoc),
        },
        { operation: 'keys-generation', benchmark: { modelAlias: this.flagshipAlias, day: day.day } },
      ),
    );
    const lookbackPromise: Promise<Record<string, unknown> | null> = lookbackSet.length
      ? this.withRetry('lookback', () =>
          this.llm.messageStructured<Record<string, unknown>>(
            {
              prompt: lookbackPrompt(day.date, lookbackSet),
              model: this.flagshipModel,
              schema: LOOKBACK_SCHEMA,
              effort: this.effort,
              maxTokens: this.maxTokens,
            },
            { operation: 'keys-generation', benchmark: { modelAlias: this.flagshipAlias, day: day.day } },
          ),
        )
      : Promise.resolve(null);
    const [current, lookback] = await Promise.all([currentPromise, lookbackPromise]);

    const sources = lookbackSet.length ? lookbackSources.join(' · ') : 'none — bootstrap';
    const synth = await this.withRetry('synthesize', () =>
      this.llm.messageStructured<{ artifact: string }>(
        {
          prompt: synthesizePrompt(day.date, current, lookback, sources),
          model: this.flagshipModel,
          schema: SYNTH_SCHEMA,
          effort: this.effort,
          maxTokens: this.maxTokens,
        },
        { operation: 'keys-generation', benchmark: { modelAlias: this.flagshipAlias, day: day.day } },
      ),
    );

    const verdict = await this.withRetry('verify', () =>
      this.llm.messageStructured<{ pass: boolean; mismatches: string[] }>(
        {
          prompt: verifyPrompt(day.date, tpTranscript, synth.artifact),
          model: this.flagshipModel,
          schema: VERIFY_SCHEMA,
          effort: this.effort,
          maxTokens: this.maxTokens,
          envelope: this.pdfContext(fileId),
        },
        { operation: 'keys-generation', benchmark: { modelAlias: this.flagshipAlias, day: day.day } },
      ),
    );

    return { verified: verdict.pass, mismatches: verdict.mismatches, artifact: synth.artifact, lookbackSources, lookbackMissing };
  }

  /**
   * Idempotent KEYS resolution, scoped to the current flagship's lineage
   * (Fable's keys on Anthropic, Kimi's on Moonshot — a bench never consumes
   * another flagship's keys), with a two-level freeze:
   * - Immutable once THIS lineage's KEYS are pinned by a scorecard cell — either
   *   persisted (the doc's contentHash appears in `pinnedKeysHashes`) or in-flight
   *   (`opts.pinned`, a submitted-but-unreconciled batch). The stored artifact is
   *   reused unconditionally, even under `opts.force`, so a recorded
   *   `artifactSha256` never dangles; a missing artifact in this state is refused
   *   (null), not silently regenerated. Another lineage's pins never freeze this
   *   one — a Kimi bench generates fresh keys on a Fable-benchmarked day.
   * - Refreshable until then: reuse a stored artifact only while it is verified
   *   and its `inputsHash` is unchanged; a corrected trade plan (inputsHash drift),
   *   an unverified leftover, or `opts.force` triggers regeneration.
   * Otherwise generates + verifies + persists. Returns the persisted doc, or null
   * (logged) when generation/verification fails so the caller skips the scorecard
   * variant for the day.
   */
  async ensureKeys(
    day: DayInput,
    snap: InputsSnapshot,
    opts?: { force?: boolean; pinned?: boolean; onFailure?: (f: KeysFailure) => void },
  ): Promise<DayArtifactDoc | null> {
    const alias = this.flagshipAlias;
    const existing = await this.repo.getKeysArtifact(day.day, alias);
    const pinnedHashes = await this.repo.pinnedKeysHashes(day.day);
    // (1) Immutable when a persisted scorecard cell pinned THIS doc's hash, or when
    // in-flight cells did (`opts.pinned`, a submitted-but-unreconciled batch whose
    // pins pinnedKeysHashes does not yet see) — reuse unconditionally, even under
    // force, so a recorded artifactSha256 never dangles.
    const benchmarked = existing !== null && pinnedHashes.has(existing.contentHash);
    if (benchmarked || opts?.pinned === true) {
      if (existing) return existing;
      // Anomaly: in-flight cells pinned this lineage's KEYS but the artifact is
      // missing. Regenerating would break those pins, so refuse.
      const msg = `Seven-keys for ${day.day}: in-flight scorecard cells pinned this lineage's KEYS but the artifact is missing; refusing to regenerate (would break cell provenance).`;
      this.logger.error(msg);
      opts?.onFailure?.({ kind: 'refused', message: msg, mismatches: [] });
      return null;
    }
    // Orphaned-pin anomaly: this lineage has no artifact, yet the day carries pins
    // that no doc we can see accounts for. They may be this lineage's orphaned pins
    // (its doc was deleted), so generating here could bury broken provenance —
    // refuse and make a human look. Pins fully explained by another lineage's
    // legacy doc are fine: that is exactly the Kimi-on-a-Fable-day case.
    if (!existing && pinnedHashes.size > 0) {
      const legacy = await this.repo.getDayArtifact(day.day, 'keys');
      const orphaned = [...pinnedHashes].filter((h) => h !== legacy?.contentHash);
      if (orphaned.length > 0) {
        const msg = `Seven-keys for ${day.day}: scorecard cells pinned KEYS hash(es) ${orphaned.join(', ')} that match no stored artifact; refusing to generate for lineage ${alias} (possible deleted artifact).`;
        this.logger.error(msg);
        opts?.onFailure?.({ kind: 'refused', message: msg, mismatches: [] });
        return null;
      }
    }
    // (2) Refreshable until benchmarked: reuse only a VERIFIED artifact whose
    // generation inputs are unchanged. A corrected trade plan (inputsHash drift), an
    // unverified leftover, or an explicit force all fall through to (re)generation.
    const inputsHash = this.computeInputsHash(day, snap.methodsDoc ?? '');
    if (!opts?.force && existing?.verified && existing.inputsHash === inputsHash) return existing;

    let result: KeysArtifact;
    try {
      result = await this.generate(day, snap);
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`Seven-keys generation failed for ${day.day}: ${message}`);
      opts?.onFailure?.({ kind: 'error', message, mismatches: [] });
      return null;
    }
    if (!result.verified) {
      this.logger.warn(`Seven-keys verifier failed for ${day.day}: ${result.mismatches.join('; ')}`);
      opts?.onFailure?.({ kind: 'unverified', message: `verifier rejected the artifact: ${result.mismatches.join('; ')}`, mismatches: result.mismatches });
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
      // Inline-stored; path is a stable marker. Lineage-suffixed like the repo's
      // old *_ES_KEYS.fable.md convention so two flagships' keys never collide.
      gcsPath: `benchmark/es/${day.day}/${day.prefix}_ES_KEYS.${alias}.md`,
      content,
      uploadedAt: generatedAt,
      generatedBy: this.flagshipModel,
      generatedAt,
      lookbackSources: result.lookbackSources,
      lookbackMissing: result.lookbackMissing,
      verified: true,
      inputsHash,
    };
    await this.repo.saveKeysArtifact(day.day, alias, doc);
    return doc;
  }

  // sha256 over the exact generation inputs (PDF bytes + both transcripts + the
  // methodology doc). ensureKeys reuses a not-yet-benchmarked artifact only while
  // this is unchanged, so a corrected trade plan regenerates instead of serving
  // stale KEYS. Pure: hashes the SAME in-memory values generation consumes
  // (day.pdf, day.tpTranscript, day.recapTranscript, snap.methodsDoc) — never a
  // second fetch. (Only read on the non-immutable path — a benchmarked day
  // returns before this is called.)
  private computeInputsHash(day: DayInput, methodsDoc: string): string {
    return createHash('sha256')
      .update(day.pdf)
      .update('\x00')
      .update(day.tpTranscript)
      .update('\x00')
      .update(day.recapTranscript)
      .update('\x00')
      .update(methodsDoc)
      .digest('hex');
  }

  // Faithful port of the skill's committed KEYS file: YAML frontmatter + body.
  private composeKeysMarkdown(artifactBody: string, generatedAt: string, lookbackSources: string[]): string {
    return [
      '---',
      `generatedBy: ${this.flagshipModel}`,
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
  // doesn't discard the prior flagship calls; a 422 refusal — a deterministic content
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
