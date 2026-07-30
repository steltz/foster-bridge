import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID, createHash } from 'node:crypto';
import { toFile } from 'openai';
import { Attribution, UsageEvent } from '../cost/cost.types';
import { LlmProvider, LlmCapabilities } from '../llm/llm.provider';
import {
  StructuredRequest,
  BatchItemRequest,
  BatchSubmitOptions,
  BatchHandle,
  BatchItemResult,
  PromptEnvelope,
} from '../llm/llm.types';
import { MOONSHOT_CLIENT, MoonshotClientFactory, MOONSHOT_EXTRACT_ID_PREFIX } from './moonshot.constants';
import { MoonshotEnvelopeBuilder } from './moonshot.envelope';
import { MoonshotExtractStore } from './moonshot.extract-store';
import { MoonshotBatchStore } from './moonshot.batch-store';
import { MoonshotBatchWorker } from './moonshot.batch-worker';
import { MoonshotChatBody, toChatResult, mapEffort, jsonSchemaFormat, createChatWithFallback } from './moonshot.chat';
import { tokensFromUsage } from './moonshot.usage';

const DEFAULT_MAX_COMPLETION_TOKENS = 32000;

@Injectable()
export class MoonshotLlmProvider implements LlmProvider {
  readonly capabilities: LlmCapabilities = {
    batch: true,
    fileUpload: true,
    promptCaching: true,
    structuredOutput: true,
  };
  private readonly logger = new Logger(MoonshotLlmProvider.name);

  constructor(
    @Inject(MOONSHOT_CLIENT) private readonly clientFactory: MoonshotClientFactory,
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
    private readonly envelopes: MoonshotEnvelopeBuilder,
    private readonly extracts: MoonshotExtractStore,
    private readonly batchStore: MoonshotBatchStore,
    private readonly worker: MoonshotBatchWorker,
  ) {}

  private get defaultModel(): string {
    return this.config.get<string>('moonshot.model') ?? 'kimi-k3';
  }

  async messageStructured<T = unknown>(req: StructuredRequest, attribution: Attribution): Promise<T> {
    const model = req.model ?? this.defaultModel;
    try {
      // Inside the try for the same reason as uploadFile's store read: buildRequest
      // can throw (an unresolvable file-block id). Behaviorally a no-op today —
      // that throw is a plain Error and rethrow passes it through unchanged — but
      // it keeps every failure on this path funnelled through one mapping point.
      const built = await this.envelopes.buildRequest(req.envelope, req.prompt, req.system);
      const body: MoonshotChatBody = {
        model,
        messages: built.messages,
        max_completion_tokens: req.maxTokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
        reasoning_effort: mapEffort(req.effort),
        // Spread conditionally: promptCacheKey is `string | undefined` (undefined when
        // the envelope has no stable prefix), and an explicit `prompt_cache_key:
        // undefined` key would still be an own property on the request body.
        ...(built.promptCacheKey ? { prompt_cache_key: built.promptCacheKey } : {}),
        ...(req.schema ? { response_format: jsonSchemaFormat(req.schema) as any } : {}),
      };
      // Known cost, deliberately unmemoized: createChatWithFallback re-probes
      // strict json_schema on EVERY call, so a schema Moonshot permanently rejects
      // burns one wasted 400 per request. If that shows up in practice, the fix is
      // a per-(model, schema-hash) latch that skips straight to json_object.
      const resp = await createChatWithFallback(this.clientFactory.get(), body);
      const r = toChatResult(resp);
      // Capture usage BEFORE any refusal/parse throw — a refusal is still billed.
      this.emitUsage(r.rawUsage, (resp as any).model ?? model, attribution);
      // A refusal can arrive as a 200 with finish_reason 'content_filter' and empty
      // content, not only as a thrown 400 (see rethrow) — map both to the same 422
      // so a refusal never masquerades as a malformed-JSON 502.
      if (r.finishReason === 'content_filter') {
        throw new HttpException(
          { statusCode: 422, error: 'Structured message refused (content_filter)' },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      if (r.finishReason === 'length') {
        throw new HttpException({ statusCode: 502, error: 'Structured output truncated (finish_reason=length)' }, HttpStatus.BAD_GATEWAY);
      }
      try {
        return JSON.parse(r.text) as T;
      } catch {
        throw new HttpException({ statusCode: 502, error: 'Structured output was not valid JSON' }, HttpStatus.BAD_GATEWAY);
      }
    } catch (err) {
      this.rethrow(err);
    }
  }

  /**
   * Upload → extract text → cache durably by content hash → delete the remote file
   * (respects the 1,000-file cap) → return a synthetic id resolving to that text.
   * Idempotent: an identical byte payload short-circuits on the content hash.
   */
  async uploadFile(bytes: Buffer, filename: string, mediaType: string): Promise<string> {
    const hash = createHash('sha256').update(bytes).digest('hex');
    const client = this.clientFactory.get();
    try {
      // Inside the try on purpose: getByHash can throw (a torn chunked doc), and
      // that must flow through the same rethrow mapping as the upload path rather
      // than escaping unmapped.
      const cached = await this.extracts.getByHash(hash);
      if (cached != null) return `${MOONSHOT_EXTRACT_ID_PREFIX}${hash}`;
      const file = await toFile(bytes, filename, { type: mediaType });
      const uploaded = await client.files.create({ file, purpose: 'file-extract' as any });
      // Everything after a successful create runs under a `finally` that always
      // attempts the delete: this is the ONLY caller of files.del in the codebase,
      // and Moonshot caps an account at 1,000 files, so a content-read or
      // extract-store failure sequenced BEFORE the delete would leak the remote
      // file permanently. Losing the remote copy on a failed attempt costs
      // nothing — a retry re-uploads. `return` still evaluates after `put`
      // resolves, so the success path keeps its put-before-return ordering.
      try {
        const text = await (await client.files.content(uploaded.id)).text();
        await this.extracts.put(hash, text, { filename, mediaType });
        return `${MOONSHOT_EXTRACT_ID_PREFIX}${hash}`;
      } finally {
        try {
          await (client.files as any).del(uploaded.id);
        } catch (delErr) {
          this.logger.warn(`Moonshot file ${uploaded.id} extracted but not deleted: ${(delErr as Error).message}`);
        }
      }
    } catch (err) {
      this.rethrow(err);
    }
  }

  // ---- batch methods ----
  // Throwing stubs so the class fully implements LlmProvider (and therefore
  // type-checks) in this task. Task 10 replaces these three bodies with the real
  // hybrid batch implementation.
  async submitBatch(_requests: BatchItemRequest[], _envelope: PromptEnvelope | undefined, _opts: BatchSubmitOptions): Promise<BatchHandle> {
    throw new Error('submitBatch: implemented in Task 10');
  }

  async getBatch(_batchId: string): Promise<BatchHandle> {
    throw new Error('getBatch: implemented in Task 10');
  }

  async getBatchResults(_batchId: string): Promise<BatchItemResult[]> {
    throw new Error('getBatchResults: implemented in Task 10');
  }

  private emitUsage(rawUsage: unknown, modelId: string, attribution: Attribution): void {
    try {
      // Typed against UsageEvent so the payload can't drift from what CostService
      // consumes. serviceTier is always 'standard': an OpenAI-compatible usage
      // object carries no tier signal, and Moonshot's sync API has one tier.
      const event: UsageEvent = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        modelId,
        serviceTier: 'standard',
        attribution,
        tokens: tokensFromUsage(rawUsage),
        source: 'sync',
      };
      this.events.emit('llm.usage', event);
    } catch (err) {
      // Capture must never affect the request path — but swallowing silently means
      // cost tracking drops records with no trace, so log it.
      this.logger.warn(`llm.usage emit failed for ${modelId}: ${(err as Error).message}`);
    }
  }

  /** Maps OpenAI/Moonshot SDK errors to Nest HttpExceptions; passes others through. */
  protected rethrow(err: unknown): never {
    if (err instanceof HttpException) throw err;
    // Optional chain: a thrown null/undefined must fall through to the
    // normalization below, not TypeError on the member access.
    const status = (err as { status?: number })?.status;
    const type = (err as any)?.error?.type ?? (err as any)?.code;
    if (typeof status === 'number') {
      if (status === 400 && type === 'content_filter') {
        throw new HttpException({ statusCode: 422, error: 'Structured message refused (content_filter)' }, HttpStatus.UNPROCESSABLE_ENTITY);
      }
      if (status >= 500) {
        this.logger.error(`Moonshot API error ${status}: ${(err as Error).message}`);
        throw new HttpException({ statusCode: status, error: 'Upstream Moonshot API error' }, status);
      }
      throw new HttpException({ statusCode: status, error: (err as Error).message }, status);
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}
