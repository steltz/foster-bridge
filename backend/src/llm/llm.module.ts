import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AnthropicModule } from '../anthropic/anthropic.module';
import { AnthropicLlmProvider } from '../anthropic/anthropic.service';
import { LLM_PROVIDER } from './llm.constants';
import { LlmProvider } from './llm.provider';

// Single swap seam: selects the active provider by config. Add new adapters here.
@Global()
@Module({
  imports: [AnthropicModule],
  providers: [
    {
      provide: LLM_PROVIDER,
      inject: [ConfigService, AnthropicLlmProvider],
      useFactory: (cfg: ConfigService, anthropic: AnthropicLlmProvider): LlmProvider => {
        const provider = cfg.get<string>('llm.provider') ?? 'anthropic';
        switch (provider) {
          case 'anthropic':
            return anthropic;
          default:
            throw new Error(`Unknown llm.provider: ${provider}`);
        }
      },
    },
  ],
  exports: [LLM_PROVIDER],
})
export class LlmModule {}
