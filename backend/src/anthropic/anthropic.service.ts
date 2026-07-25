import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
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

@Injectable()
export class AnthropicService {
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

  /** Maps Anthropic SDK errors to Nest HttpExceptions; passes others through. */
  protected rethrow(err: unknown): never {
    if (err instanceof HttpException) {
      throw err;
    }
    if (err instanceof Anthropic.APIError) {
      const status =
        typeof err.status === 'number' ? err.status : HttpStatus.BAD_GATEWAY;
      throw new HttpException({ statusCode: status, error: err.message }, status);
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}
