import {
  Global,
  Module,
  Provider,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_CLIENT, AnthropicClientFactory } from './anthropic.constants';
import { AnthropicService } from './anthropic.service';

// The SDK client-level `timeout` gates its own non-streaming max_tokens guard:
// with no client timeout configured, a non-streaming call whose max_tokens could
// plausibly take >10 min to generate throws outright rather than sending the
// request (see https://github.com/anthropics/anthropic-sdk-typescript#long-requests).
// High-effort structured calls (Fable's always-on thinking) need a large
// max_tokens ceiling without ever actually running this long, so raise the
// client's default timeout instead of switching every call site to streaming.
const CLIENT_TIMEOUT_MS = 30 * 60 * 1000;

const anthropicClientProvider: Provider = {
  provide: ANTHROPIC_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): AnthropicClientFactory => {
    let client: Anthropic | undefined;
    return {
      get(): Anthropic {
        if (!client) {
          const apiKey = config.get<string>('anthropic.apiKey');
          if (!apiKey) {
            // Constructing `new Anthropic()` with no key throws; surface a
            // clean 401 instead. Also keeps module init from ever constructing.
            throw new UnauthorizedException(
              'ANTHROPIC_API_KEY is not configured',
            );
          }
          client = new Anthropic({ apiKey, timeout: CLIENT_TIMEOUT_MS });
        }
        return client;
      },
    };
  },
};

@Global()
@Module({
  providers: [anthropicClientProvider, AnthropicService],
  exports: [ANTHROPIC_CLIENT, AnthropicService],
})
export class AnthropicModule {}
