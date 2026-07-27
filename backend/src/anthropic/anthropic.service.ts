import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic, { toFile } from '@anthropic-ai/sdk';
import {
  ANTHROPIC_CLIENT,
  AnthropicClientFactory,
  ONE_HOUR_CACHE_CONTROL,
} from './anthropic.constants';

const FILES_BETA = ['files-api-2025-04-14'];

// A structured warm (one carrying output_config.format) cannot use max_tokens:0
// — the API rejects `output_config.format` at max_tokens:0 — so it bills a tiny
// non-zero budget. The generated text is discarded; only the cache write matters.
const WARM_STRUCTURED_MAX_TOKENS = 16;

export interface MessageInput {
  prompt: string;
  system?: string;
  model?: string;
  maxTokens?: number;
}

export interface MessageResult {
  model: string;
  text: string | null;
  // Indexed-access types keep the SDK's real shapes without naming fragile
  // block types (StopReason union; Usage object) — a precise client contract.
  stopReason: Anthropic.Message['stop_reason'];
  usage: Anthropic.Message['usage'];
}

export interface CachedContext {
  /** Cached (1h TTL) system prompt shared across requests. */
  system?: string;
  /** Cached (1h TTL) leading user-message block shared across requests. */
  prefix?: string;
  /**
   * Ordered cache tiers rendered into one user message. Each tier's LAST block
   * gets a 1h breakpoint; the trailing prompt is appended uncached. Total
   * breakpoints (system + tiers) must be <= 4.
   *
   * Each tier contributes exactly ONE cache breakpoint (stamped automatically on
   * the tier's last block). Callers must NOT pre-stamp `cache_control` on tier
   * blocks, and must not pass empty tiers — the <=4-breakpoint guard counts one
   * per tier.
   *
   * Typed against the BETA content-block param: an uploaded-file document
   * (`{ type: 'document', source: { type: 'file', file_id } }`) is only valid on
   * the beta path — SDK 0.115.0's non-beta `DocumentBlockParam.source` has no
   * `file` variant, so `Anthropic.ContentBlockParam` cannot hold a file document.
   */
  userTiers?: Array<{ blocks: Anthropic.Beta.BetaContentBlockParam[] }>;
}

export interface CacheVerification {
  model: string;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** True when this call wrote OR read a cache entry. */
  cached: boolean;
}

export interface BatchRequestInput {
  customId?: string;
  prompt: string;
  /** Per-request cached envelope; overrides the batch-level context when set. */
  context?: CachedContext;
}

export interface BatchSummary {
  batchId: string;
  processingStatus: string;
  requestCounts?: unknown;
}

export interface BatchResultItem {
  customId: string;
  type: string;
  text?: string;
  error?: string;
  /** Cache-read tokens for a succeeded item; lets callers confirm cache hits. */
  cacheReadInputTokens?: number;
  /** Present so a `refusal` stop_reason is detectable by the reconciler. */
  stopReason?: string;
}

@Injectable()
export class AnthropicService {
  private readonly logger = new Logger(AnthropicService.name);

  constructor(
    @Inject(ANTHROPIC_CLIENT)
    private readonly clientFactory: AnthropicClientFactory,
    private readonly config: ConfigService,
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

  /**
   * One synchronous structured-output message (NOT a batch). Applies
   * output_config.format when an outputSchema is given, routes through the
   * beta/files client when `files` is set, reuses the cached-prefix builder for
   * an optional CachedContext, and returns the parsed JSON. A refusal throws.
   */
  async messageStructured<T = unknown>(
    input: { prompt: string; system?: string },
    opts?: {
      model?: string;
      outputSchema?: unknown;
      context?: CachedContext;
      files?: boolean;
      effort?: string;
      maxTokens?: number;
    },
  ): Promise<T> {
    const client = this.clientFactory.get();
    const model = opts?.model ?? this.defaultModel;
    const maxTokens = opts?.maxTokens ?? this.defaultMaxTokens;
    const files = opts?.files === true;
    const outputConfig = {
      ...(opts?.outputSchema ? { format: { type: 'json_schema', schema: opts.outputSchema } } : {}),
      ...(opts?.effort ? { effort: opts.effort } : {}),
    };
    const built = opts?.context
      ? this.buildCachedRequest(opts.context, input.prompt)
      : { messages: [{ role: 'user' as const, content: input.prompt }] };
    const params: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      // System only when not already carried by the cached context.
      ...(input.system && !opts?.context?.system ? { system: input.system } : {}),
      ...built,
      ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
    };
    try {
      const resp = files
        ? await client.beta.messages.create({ ...params, betas: FILES_BETA } as any)
        : await client.messages.create(params as any);
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

  /**
   * The one place cache breakpoints are placed. The warm-up and batch items all
   * call this so they emit a byte-identical cached prefix at the same breakpoints.
   */
  private buildCachedRequest(
    context: CachedContext,
    prompt: string,
  ): {
    system?: Anthropic.TextBlockParam[];
    // Widened to the beta message param so a userTiers file document can be
    // rendered; callers cast to the concrete (beta / non-beta) create shape.
    messages: Anthropic.Beta.BetaMessageParam[];
  } {
    const system = context.system
      ? [{ type: 'text' as const, text: context.system, cache_control: ONE_HOUR_CACHE_CONTROL }]
      : undefined;

    let messages: Anthropic.Beta.BetaMessageParam[];
    if (context.userTiers && context.userTiers.length) {
      const breakpoints = (system ? 1 : 0) + context.userTiers.length;
      if (breakpoints > 4) {
        throw new HttpException(
          { statusCode: 400, error: `Too many cache breakpoints: ${breakpoints} (max 4)` },
          HttpStatus.BAD_REQUEST,
        );
      }
      const content: Anthropic.Beta.BetaContentBlockParam[] = [];
      for (const tier of context.userTiers) {
        // One breakpoint per tier, stamped here on the tier's last block. Callers
        // must not pre-stamp cache_control or pass empty tiers (the guard above
        // counts one breakpoint per tier regardless of contents).
        const blocks = tier.blocks.map((b) => ({ ...b }));
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
    } else if (context.prefix) {
      messages = [
        {
          role: 'user',
          content: [
            { type: 'text', text: context.prefix, cache_control: ONE_HOUR_CACHE_CONTROL },
            { type: 'text', text: prompt },
          ],
        },
      ];
    } else {
      messages = [{ role: 'user', content: prompt }];
    }

    return system ? { system, messages } : { messages };
  }

  // Accepts either message shape: the file-bearing warm routes through the beta
  // client (BetaMessage), the plain warm through the non-beta client (Message).
  // Only `model` and `usage.cache_*` are read, which both shapes share.
  private toVerification(
    resp: Anthropic.Message | Anthropic.Beta.BetaMessage,
  ): CacheVerification {
    const creation = resp.usage?.cache_creation_input_tokens ?? 0;
    const read = resp.usage?.cache_read_input_tokens ?? 0;
    return {
      model: resp.model,
      cacheCreationInputTokens: creation,
      cacheReadInputTokens: read,
      cached: creation > 0 || read > 0,
    };
  }

  /**
   * Pre-warms the 1h cache for a shared prefix. A plain warm uses a max_tokens:0
   * request (writes the cache, bills no output). A STRUCTURED warm — pass
   * `outputSchema` (and matching `effort`) — sends the SAME `output_config` the
   * batch/messageStructured call will use; without this the format is part of the
   * cache key, so the warmed entry and the real request hash differently and the
   * real request never reads the warm (it re-writes its own cache instead).
   * `output_config.format` is rejected at max_tokens:0, so a structured warm bills
   * WARM_STRUCTURED_MAX_TOKENS (discarded). Standalone by necessity — max_tokens:0
   * is rejected inside a Batches request. Returns usage-derived verification; with
   * { strict: true }, a second probe must read the cache or this throws.
   */
  async warmCache(
    context: CachedContext,
    opts?: { model?: string; strict?: boolean; files?: boolean; effort?: string; outputSchema?: unknown; maxTokens?: number },
  ): Promise<CacheVerification> {
    if (!context.system && !context.prefix && !(context.userTiers && context.userTiers.length)) {
      throw new HttpException(
        { statusCode: 400, error: 'CachedContext requires system, prefix or userTiers' },
        HttpStatus.BAD_REQUEST,
      );
    }
    const client = this.clientFactory.get();
    const model = opts?.model ?? this.defaultModel;
    const files = opts?.files === true;
    const built = this.buildCachedRequest(context, 'warmup');
    // Mirror createBatch's output_config EXACTLY when a schema is given, so the
    // warmed prefix and the real request share a cache key. effort tags along only
    // inside a structured warm; a schema-less warm ignores it (not cache-relevant)
    // and stays a pure max_tokens:0 write.
    const outputConfig = opts?.outputSchema
      ? {
          format: { type: 'json_schema' as const, schema: opts.outputSchema },
          ...(opts?.effort ? { effort: opts.effort } : {}),
        }
      : undefined;
    const params: Record<string, unknown> = {
      model,
      max_tokens: outputConfig ? (opts?.maxTokens ?? WARM_STRUCTURED_MAX_TOKENS) : 0,
      ...built,
      ...(outputConfig ? { output_config: outputConfig } : {}),
    };
    const call = () =>
      files
        ? client.beta.messages.create({ ...params, betas: FILES_BETA } as any)
        : client.messages.create(params as any);
    try {
      const first = await call();
      let verification = this.toVerification(first);
      if (opts?.strict) {
        const probe = await call();
        // Return the probe's stats: it reads the entry the first call wrote, so
        // cacheReadInputTokens > 0 confirms the cache. (cacheCreationInputTokens
        // reads 0 here — the write happened on the first call.)
        verification = this.toVerification(probe);
        if (verification.cacheReadInputTokens <= 0) {
          throw new HttpException(
            { statusCode: 502, error: 'Prompt cache was not written' },
            HttpStatus.BAD_GATEWAY,
          );
        }
      }
      return verification;
    } catch (err) {
      this.rethrow(err);
    }
  }

  async createBatch(
    requests: BatchRequestInput[],
    context?: CachedContext,
    opts?: { model?: string; outputSchema?: unknown; maxTokens?: number; effort?: string; files?: boolean },
  ): Promise<BatchSummary> {
    const client = this.clientFactory.get();
    // Caches are model-scoped: to read a warmed entry, pass the SAME model here
    // that was given to warmCache.
    const model = opts?.model ?? this.defaultModel;
    const maxTokens = opts?.maxTokens ?? this.defaultMaxTokens;
    const files = opts?.files === true;
    const outputConfig = {
      ...(opts?.outputSchema ? { format: { type: 'json_schema', schema: opts.outputSchema } } : {}),
      ...(opts?.effort ? { effort: opts.effort } : {}),
    };
    try {
      const body = {
        requests: requests.map((r, i) => {
          const ctx = r.context ?? context;
          const built = ctx
            ? this.buildCachedRequest(ctx, r.prompt)
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
      const batch = files
        ? await client.beta.messages.batches.create({ ...body, betas: FILES_BETA } as any)
        : await client.messages.batches.create(body as any);
      return { batchId: batch.id, processingStatus: batch.processing_status };
    } catch (err) {
      this.rethrow(err);
    }
  }

  async getBatch(id: string, opts?: { files?: boolean }): Promise<BatchSummary> {
    const client = this.clientFactory.get();
    try {
      const batch = opts?.files
        ? await client.beta.messages.batches.retrieve(id, { betas: FILES_BETA } as any)
        : await client.messages.batches.retrieve(id);
      return {
        batchId: batch.id,
        processingStatus: batch.processing_status,
        requestCounts: batch.request_counts,
      };
    } catch (err) {
      this.rethrow(err);
    }
  }

  async getBatchResults(id: string, opts?: { files?: boolean }): Promise<BatchResultItem[]> {
    const client = this.clientFactory.get();
    try {
      const items: BatchResultItem[] = [];
      const stream = opts?.files
        ? await client.beta.messages.batches.results(id, { betas: FILES_BETA } as any)
        : await client.messages.batches.results(id);
      for await (const entry of stream) {
        const customId = entry.custom_id;
        const result = entry.result;
        if (result.type === 'succeeded') {
          const msg = result.message;
          if (msg.stop_reason === 'refusal') {
            items.push({ customId, type: 'refusal', stopReason: 'refusal' });
            continue;
          }
          let text = '';
          for (const block of msg.content) {
            if (block.type === 'text') {
              text += block.text;
            }
          }
          const item: BatchResultItem = { customId, type: 'succeeded', text };
          const read = msg.usage?.cache_read_input_tokens;
          // Only attach when present so existing (usage-less) results are unchanged.
          if (typeof read === 'number') {
            item.cacheReadInputTokens = read;
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
