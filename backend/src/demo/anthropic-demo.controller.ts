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
  AnthropicService,
  BatchRequestInput,
  MessageInput,
} from '../anthropic/anthropic.service';

@Controller('ai')
export class AnthropicDemoController {
  constructor(
    private readonly anthropic: AnthropicService,
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
  createBatch(@Body() body: { requests: BatchRequestInput[] }) {
    return this.anthropic.createBatch(body.requests ?? []);
  }

  @Get('batch/:id')
  getBatch(@Param('id') id: string) {
    return this.anthropic.getBatch(id);
  }

  @Get('batch/:id/results')
  async getBatchResults(@Param('id') id: string) {
    const batch = await this.anthropic.getBatch(id);
    if (batch.processingStatus !== 'ended') {
      throw new ConflictException(
        `Batch ${id} has not ended (status: ${batch.processingStatus})`,
      );
    }
    return this.anthropic.getBatchResults(id);
  }
}
