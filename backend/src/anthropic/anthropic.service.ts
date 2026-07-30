import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';
import Anthropic, { toFile } from '@anthropic-ai/sdk';
import {
  ANTHROPIC_CLIENT,
  AnthropicClientFactory,
  ONE_HOUR_CACHE_CONTROL,
} from './anthropic.constants';
import { Attribution, ServiceTier, UsageEvent } from '../cost/cost.types';
import { serviceTierFromUsage, tokensFromUsage } from './anthropic.usage';
import { LlmProvider, LlmCapabilities } from '../llm/llm.provider';
import {
  PromptEnvelope,
  LlmContentBlock,
  StructuredRequest,
  BatchItemRequest,
  BatchSubmitOptions,
  BatchHandle,
  BatchItemResult,
  BatchLifecycle,
} from '../llm/llm.types';

const FILES_BETA = ['files-api-2025-04-14'];

export interface MessageInput {
  prompt: string;
  system?: string;
  model?: string;
  maxTokens?: number;
  attribution: Attribution;
}

export interface MessageResult {
  model: string;
  text: string | null;
  // Indexed-access types keep the SDK's real shapes without naming fragile
  // block types (StopReason union; Usage object) — a precise client contract.
  stopReason: Anthropic.Message['stop_reason'];
  usage: Anthropic.Message['usage'];
}

@Injectable()
export class AnthropicLlmProvider implements LlmProvider {
  readonly capabilities: LlmCapabilities = {
    batch: true,
    fileUpload: true,
    promptCaching: true,
    structuredOutput: true,
  };
  private readonly logger = new Logger(AnthropicLlmProvider.name);

  constructor(
    @Inject(ANTHROPIC_CLIENT)
    private readonly clientFactory: AnthropicClientFactory,
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
  ) {}

  private get defaultModel(): string {
    return this.config.get<string>('anthropic.model') ?? 'claude-sonnet-5';
  }

  private get defaultMaxTokens(): number {
    return this.config.get<number>('anthropic.maxTokens') ?? 4096;
  }

  async message(input: MessageInput): Promise<MessageResult> {
    const client = this.clientFactory.get();
    try {
      const response = await client.messages.create({
        model: input.model ?? this.defaultModel,
        max_tokens: input.maxTokens ?? this.defaultMaxTokens,
        ...(input.system ? { system: input.system } : {}),
        messages: [{ role: 'user', content: input.prompt }],
      });

      let text: string | null = '';
      for (const block of response.content) {
        if (block.type === 'text') {
          text += block.text;
        }
      }
      if (response.stop_reason === 'refusal') {
        text = null;
      }

      this.emitUsage(response.usage, response.model, input.attribution);

      return {
        model: response.model,
        text,
        stopReason: response.stop_reason,
        usage: response.usage,
      };
    } catch (err) {
      this.rethrow(err);
    }
  }

  /** Uploads bytes to the Anthropic Files API and returns the file_id. */
  async uploadFile(bytes: Buffer, filename: string, mediaType: string): Promise<string> {
    const client = this.clientFactory.get();
    try {
      const file = await toFile(bytes, filename, { type: mediaType });
      const uploaded = await client.beta.files.upload({ file, betas: FILES_BETA } as any);
      return uploaded.id;
    } catch (err) {
      this.rethrow(err);
    }
  }

  /** True when any tier block references an uploaded file (routes to the beta/files path). */
  private envelopeHasFile(envelope?: PromptEnvelope): boolean {
    return !!envelope?.tiers?.some((t) => t.blocks.some((b) => b.type === 'file'));
  }

  /** Map neutral blocks to Anthropic beta content-block params. */
  private toBetaBlocks(blocks: LlmContentBlock[]): Anthropic.Beta.BetaContentBlockParam[] {
    return blocks.map((b) =>
      b.type === 'file'
        ? ({ type: 'document', source: { type: 'file', file_id: b.fileId } } as Anthropic.Beta.BetaContentBlockParam)
        : ({ type: 'text', text: b.text } as Anthropic.Beta.BetaContentBlockParam),
    );
  }

  /**
   * The one place cache breakpoints are placed. Renders a neutral PromptEnvelope
   * into an SDK request: the optional system prompt gets a 1h breakpoint, each
   * tier's LAST block gets a 1h breakpoint, and the per-request prompt is appended
   * uncached. Total breakpoints (system + tiers) must be <= 4. Callers must NOT
   * pre-stamp cache_control on tier blocks, and must not pass empty tiers — the
   * guard counts one breakpoint per tier regardless of contents.
   */
  private buildEnvelopeRequest(
    envelope: PromptEnvelope,
    prompt: string,
  ): { system?: Anthropic.TextBlockParam[]; messages: Anthropic.Beta.BetaMessageParam[] } {
    const system = envelope.system
      ? [{ type: 'text' as const, text: envelope.system, cache_control: ONE_HOUR_CACHE_CONTROL }]
      : undefined;

    let messages: Anthropic.Beta.BetaMessageParam[];
    const tiers = envelope.tiers ?? [];
    if (tiers.length) {
      const breakpoints = (system ? 1 : 0) + tiers.length;
      if (breakpoints > 4) {
        throw new HttpException(
          { statusCode: 400, error: `Too many cache breakpoints: ${breakpoints} (max 4)` },
          HttpStatus.BAD_REQUEST,
        );
      }
      const content: Anthropic.Beta.BetaContentBlockParam[] = [];
      for (const tier of tiers) {
        const blocks = this.toBetaBlocks(tier.blocks);
        if (blocks.length) {
          // Cast: cache_control is valid on the cacheable block params (text,
          // document, image, ...) but the BetaContentBlockParam union also
          // includes variants (thinking) that forbid it, so the literal needs a
          // cast to assign back into the union-typed array.
          blocks[blocks.length - 1] = {
            ...blocks[blocks.length - 1],
            cache_control: ONE_HOUR_CACHE_CONTROL,
          } as Anthropic.Beta.BetaContentBlockParam;
        }
        content.push(...blocks);
      }
      content.push({ type: 'text', text: prompt });
      messages = [{ role: 'user', content }];
    } else {
      messages = [{ role: 'user', content: prompt }];
    }
    return system ? { system, messages } : { messages };
  }

  private toLifecycle(status: string): BatchLifecycle {
    switch (status) {
      case 'in_progress':
      case 'ended':
      case 'canceled':
      case 'expired':
      case 'errored':
        return status;
      default:
        return 'submitted';
    }
  }

  async messageStructured<T = unknown>(req: StructuredRequest, attribution: Attribution): Promise<T> {
    const client = this.clientFactory.get();
    const model = req.model ?? this.defaultModel;
    const maxTokens = req.maxTokens ?? this.defaultMaxTokens;
    const useFiles = this.envelopeHasFile(req.envelope);
    const outputConfig = {
      ...(req.schema ? { format: { type: 'json_schema', schema: req.schema } } : {}),
      ...(req.effort ? { effort: req.effort } : {}),
    };
    const built = req.envelope
      ? this.buildEnvelopeRequest(req.envelope, req.prompt)
      : { messages: [{ role: 'user' as const, content: req.prompt }] };
    const params: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      ...(req.system && !req.envelope?.system ? { system: req.system } : {}),
      ...built,
      ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
    };
    try {
      const resp = useFiles
        ? await client.beta.messages.create({ ...params, betas: FILES_BETA } as any)
        : await client.messages.create(params as any);
      // Capture usage BEFORE the refusal throw — a refusal is still billed, and
      // the sibling message()/batch paths both record refusal tokens.
      this.emitUsage((resp as any).usage, (resp as any).model ?? model, attribution);
      if (resp.stop_reason === 'refusal') {
        throw new HttpException(
          { statusCode: 422, error: 'Structured message refused' },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      let text = '';
      for (const block of resp.content) {
        if (block.type === 'text') text += block.text;
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new HttpException(
          { statusCode: 502, error: 'Structured output was not valid JSON' },
          HttpStatus.BAD_GATEWAY,
        );
      }
    } catch (err) {
      this.rethrow(err);
    }
  }

  async submitBatch(
    requests: BatchItemRequest[],
    envelope: PromptEnvelope | undefined,
    opts: BatchSubmitOptions,
  ): Promise<BatchHandle> {
    const client = this.clientFactory.get();
    const model = opts.model ?? this.defaultModel;
    const maxTokens = opts.maxTokens ?? this.defaultMaxTokens;
    const outputConfig = {
      ...(opts.schema ? { format: { type: 'json_schema', schema: opts.schema } } : {}),
      ...(opts.effort ? { effort: opts.effort } : {}),
    };
    // Batches ALWAYS use the beta/files path — submit and retrieve must agree on
    // beta-ness, and getBatch/getBatchResults cannot see the request to infer it.
    // The files-beta header is additive: harmless on a fileless batch.
    try {
      const body = {
        requests: requests.map((r, i) => {
          const env = r.envelope ?? envelope;
          const built = env
            ? this.buildEnvelopeRequest(env, r.prompt)
            : { messages: [{ role: 'user' as const, content: r.prompt }] };
          return {
            custom_id: r.customId ?? `request-${i}`,
            params: {
              model,
              max_tokens: maxTokens,
              ...built,
              ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
            },
          };
        }),
      };
      const batch = await client.beta.messages.batches.create({ ...body, betas: FILES_BETA } as any);
      return { batchId: batch.id, status: this.toLifecycle(batch.processing_status) };
    } catch (err) {
      this.rethrow(err);
    }
  }

  async getBatch(id: string): Promise<BatchHandle> {
    // Uniform beta: batches are always submitted on the beta/files path, so read
    // them there too (mirrors submitBatch — see its note).
    const client = this.clientFactory.get();
    try {
      const batch = await client.beta.messages.batches.retrieve(id, { betas: FILES_BETA } as any);
      return {
        batchId: batch.id,
        status: this.toLifecycle(batch.processing_status),
        requestCounts: batch.request_counts,
      };
    } catch (err) {
      this.rethrow(err);
    }
  }

  async getBatchResults(id: string): Promise<BatchItemResult[]> {
    // Uniform beta: batches are always submitted on the beta/files path, so read
    // them there too (mirrors submitBatch — see its note).
    const client = this.clientFactory.get();
    try {
      const items: BatchItemResult[] = [];
      const stream = await client.beta.messages.batches.results(id, { betas: FILES_BETA } as any);
      for await (const entry of stream) {
        const customId = entry.custom_id;
        const result = entry.result;
        if (result.type === 'succeeded') {
          const msg = result.message;
          if (msg.stop_reason === 'refusal') {
            const refusal: BatchItemResult = { customId, type: 'refusal' };
            if (msg.usage !== undefined) refusal.usage = tokensFromUsage(msg.usage);
            items.push(refusal);
            continue;
          }
          let text = '';
          for (const block of msg.content) {
            if (block.type === 'text') {
              text += block.text;
            }
          }
          const item: BatchItemResult = { customId, type: 'succeeded', text };
          if (msg.usage !== undefined) item.usage = tokensFromUsage(msg.usage);
          const read = msg.usage?.cache_read_input_tokens;
          // Only attach when present so existing (usage-less) results are unchanged.
          if (typeof read === 'number') {
            item.cacheReadTokens = read;
          }
          items.push(item);
        } else if (result.type === 'errored') {
          items.push({
            customId,
            type: 'errored',
            error: JSON.stringify(result.error),
          });
        } else {
          items.push({ customId, type: result.type, error: result.type });
        }
      }
      return items;
    } catch (err) {
      this.rethrow(err);
    }
  }

  // Emit a fire-and-forget usage event for a synchronous (standard-tier) call.
  // `attribution` is required by every caller — there is no default operation.
  private emitUsage(usage: unknown, modelId: string, attribution: Attribution): void {
    try {
      const tier: ServiceTier = serviceTierFromUsage(usage, 'standard');
      // Typed against UsageEvent so the payload can't drift from what CostService
      // consumes.
      const event: UsageEvent = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        modelId,
        serviceTier: tier,
        attribution,
        tokens: tokensFromUsage(usage),
        source: 'sync',
      };
      this.events.emit('llm.usage', event);
    } catch (err) {
      // Capture must never affect the request — but swallowing silently means cost
      // tracking drops records with no trace, so log it.
      this.logger.warn(`llm.usage emit failed for ${modelId}: ${(err as Error).message}`);
    }
  }

  /** Maps Anthropic SDK errors to Nest HttpExceptions; passes others through. */
  protected rethrow(err: unknown): never {
    if (err instanceof HttpException) {
      throw err;
    }
    if (err instanceof Anthropic.APIError) {
      const status =
        typeof err.status === 'number' ? err.status : HttpStatus.BAD_GATEWAY;
      if (status >= 500) {
        // Don't leak upstream 5xx detail to the client; log it server-side
        // instead — mirrors the global filter's 500-sanitization.
        this.logger.error(`Anthropic API error ${status}: ${err.message}`);
        throw new HttpException(
          { statusCode: status, error: 'Upstream Anthropic API error' },
          status,
        );
      }
      throw new HttpException({ statusCode: status, error: err.message }, status);
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}
