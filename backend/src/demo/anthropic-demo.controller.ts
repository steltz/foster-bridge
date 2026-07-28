import {
  Body,
  ConflictException,
  Controller,
  Get,
  Param,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AnthropicLlmProvider,
  MessageInput,
} from '../anthropic/anthropic.service';
import { BatchItemRequest } from '../llm/llm.types';

@Controller('ai')
export class AnthropicDemoController {
  constructor(
    private readonly anthropic: AnthropicLlmProvider,
    private readonly config: ConfigService,
  ) {}

  @Get('ready')
  ready() {
    return { configured: Boolean(this.config.get<string>('anthropic.apiKey')) };
  }

  @Post('message')
  message(@Body() body: Omit<MessageInput, 'attribution'>) {
    return this.anthropic.message({ ...body, attribution: { operation: 'demo' } });
  }

  @Post('batch')
  createBatch(@Body() body: { requests: BatchItemRequest[] }) {
    return this.anthropic.submitBatch(
      (body.requests ?? []).map((r) => ({ customId: r.customId, prompt: r.prompt })),
      undefined,
      {},
    );
  }

  @Get('batch/:id')
  getBatch(@Param('id') id: string) {
    return this.anthropic.getBatch(id);
  }

  @Get('batch/:id/results')
  async getBatchResults(@Param('id') id: string) {
    const batch = await this.anthropic.getBatch(id);
    if (batch.status !== 'ended') {
      throw new ConflictException(
        `Batch ${id} has not ended (status: ${batch.status})`,
      );
    }
    return this.anthropic.getBatchResults(id);
  }
}
