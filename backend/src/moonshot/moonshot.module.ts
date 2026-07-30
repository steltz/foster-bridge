import { Global, Module, Provider, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { MOONSHOT_CLIENT, MoonshotClientFactory } from './moonshot.constants';
import { MoonshotLlmProvider } from './moonshot.service';
import { MoonshotEnvelopeBuilder } from './moonshot.envelope';
import { MoonshotExtractStore } from './moonshot.extract-store';
import { MoonshotBatchStore } from './moonshot.batch-store';
import { MoonshotBatchWorker } from './moonshot.batch-worker';

// Kimi K3's always-on reasoning at a high max_completion_tokens ceiling can run
// long; give the client a generous timeout so a legitimate slow call is not
// aborted early (mirrors the Anthropic module's rationale).
const CLIENT_TIMEOUT_MS = 30 * 60 * 1000;

const moonshotClientProvider: Provider = {
  provide: MOONSHOT_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): MoonshotClientFactory => {
    let client: OpenAI | undefined;
    return {
      get(): OpenAI {
        if (!client) {
          const apiKey = config.get<string>('moonshot.apiKey');
          if (!apiKey) {
            // Constructing `new OpenAI()` with no key throws; surface a clean
            // 401 instead. Also keeps module init from ever constructing.
            throw new UnauthorizedException('MOONSHOT_API_KEY is not configured');
          }
          const baseURL = config.get<string>('moonshot.baseUrl') ?? 'https://api.moonshot.ai/v1';
          client = new OpenAI({ apiKey, baseURL, timeout: CLIENT_TIMEOUT_MS });
        }
        return client;
      },
    };
  },
};

@Global()
@Module({
  providers: [
    moonshotClientProvider,
    MoonshotExtractStore,
    MoonshotEnvelopeBuilder,
    MoonshotBatchStore,
    MoonshotBatchWorker,
    MoonshotLlmProvider,
  ],
  exports: [MOONSHOT_CLIENT, MoonshotLlmProvider],
})
export class MoonshotModule {}
