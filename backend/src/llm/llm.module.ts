import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AnthropicModule } from '../anthropic/anthropic.module';
import { AnthropicLlmProvider } from '../anthropic/anthropic.service';
import { MoonshotModule } from '../moonshot/moonshot.module';
import { MoonshotLlmProvider } from '../moonshot/moonshot.service';
import { LLM_PROVIDER } from './llm.constants';
import { LlmProvider } from './llm.provider';

// Single swap seam: selects the active provider by config. Add new adapters here.
@Global()
@Module({
  imports: [AnthropicModule, MoonshotModule],
  providers: [
    {
      provide: LLM_PROVIDER,
      inject: [ConfigService, AnthropicLlmProvider, MoonshotLlmProvider],
      useFactory: (
        cfg: ConfigService,
        anthropic: AnthropicLlmProvider,
        moonshot: MoonshotLlmProvider,
      ): LlmProvider => {
        const provider = cfg.get<string>('llm.provider') ?? 'anthropic';
        switch (provider) {
          case 'anthropic':
            return anthropic;
          case 'moonshot':
            return moonshot;
          default:
            // Quoted so a blank/whitespace value renders visibly instead of
            // producing a message that looks truncated after the colon.
            throw new Error(`Unknown llm.provider: "${provider}"`);
        }
      },
    },
  ],
  exports: [LLM_PROVIDER],
})
export class LlmModule {}
