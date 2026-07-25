import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import {
  ANTHROPIC_CLIENT,
  AnthropicClientFactory,
  ONE_HOUR_CACHE_CONTROL,
} from './anthropic.constants';

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
   * The one place a cache breakpoint is placed. The warm-up and batch items all
   * call this so they emit a byte-identical cached prefix at the same breakpoint.
   */
  private buildCachedRequest(
    context: CachedContext,
    prompt: string,
  ): {
    system?: Anthropic.TextBlockParam[];
    messages: Anthropic.MessageParam[];
  } {
    const system = context.system
      ? [
          {
            type: 'text' as const,
            text: context.system,
            cache_control: ONE_HOUR_CACHE_CONTROL,
          },
        ]
      : undefined;

    const messages: Anthropic.MessageParam[] = context.prefix
      ? [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: context.prefix,
                cache_control: ONE_HOUR_CACHE_CONTROL,
              },
              { type: 'text', text: prompt },
            ],
          },
        ]
      : [{ role: 'user', content: prompt }];

    return system ? { system, messages } : { messages };
  }

  private toVerification(resp: Anthropic.Message): CacheVerification {
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
   * Pre-warms the 1h cache for a shared prefix with a max_tokens:0 request (which
   * writes the cache but bills no output tokens). Standalone by necessity —
   * max_tokens:0 is rejected inside a Batches request. Returns usage-derived
   * verification; with { strict: true }, a second probe must read the cache or
   * this throws.
   */
  async warmCache(
    context: CachedContext,
    opts?: { model?: string; strict?: boolean },
  ): Promise<CacheVerification> {
    if (!context.system && !context.prefix) {
      throw new HttpException(
        { statusCode: 400, error: 'CachedContext requires system or prefix' },
        HttpStatus.BAD_REQUEST,
      );
    }
    const client = this.clientFactory.get();
    const model = opts?.model ?? this.defaultModel;
    const built = this.buildCachedRequest(context, 'warmup');
    try {
      const first = await client.messages.create({
        model,
        max_tokens: 0,
        ...built,
      });
      let verification = this.toVerification(first);
      if (opts?.strict) {
        const probe = await client.messages.create({
          model,
          max_tokens: 0,
          ...built,
        });
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
  ): Promise<BatchSummary> {
    const client = this.clientFactory.get();
    const model = this.defaultModel;
    const maxTokens = this.defaultMaxTokens;
    try {
      const batch = await client.messages.batches.create({
        requests: requests.map((r, i) => {
          const built = context
            ? this.buildCachedRequest(context, r.prompt)
            : { messages: [{ role: 'user' as const, content: r.prompt }] };
          return {
            custom_id: r.customId ?? `request-${i}`,
            params: {
              model,
              max_tokens: maxTokens,
              ...built,
            },
          };
        }),
      });
      return { batchId: batch.id, processingStatus: batch.processing_status };
    } catch (err) {
      this.rethrow(err);
    }
  }

  async getBatch(id: string): Promise<BatchSummary> {
    const client = this.clientFactory.get();
    try {
      const batch = await client.messages.batches.retrieve(id);
      return {
        batchId: batch.id,
        processingStatus: batch.processing_status,
        requestCounts: batch.request_counts,
      };
    } catch (err) {
      this.rethrow(err);
    }
  }

  async getBatchResults(id: string): Promise<BatchResultItem[]> {
    const client = this.clientFactory.get();
    try {
      const items: BatchResultItem[] = [];
      for await (const entry of await client.messages.batches.results(id)) {
        const customId = entry.custom_id;
        const result = entry.result;
        if (result.type === 'succeeded') {
          let text = '';
          for (const block of result.message.content) {
            if (block.type === 'text') {
              text += block.text;
            }
          }
          const item: BatchResultItem = { customId, type: 'succeeded', text };
          const read = result.message.usage?.cache_read_input_tokens;
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
