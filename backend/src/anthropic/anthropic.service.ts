import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_CLIENT, AnthropicClientFactory } from './anthropic.constants';

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

  async createBatch(requests: BatchRequestInput[]): Promise<BatchSummary> {
    const client = this.clientFactory.get();
    const model = this.defaultModel;
    const maxTokens = this.defaultMaxTokens;
    try {
      const batch = await client.messages.batches.create({
        requests: requests.map((r, i) => ({
          custom_id: r.customId ?? `request-${i}`,
          params: {
            model,
            max_tokens: maxTokens,
            messages: [{ role: 'user', content: r.prompt }],
          },
        })),
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
          items.push({ customId, type: 'succeeded', text });
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
