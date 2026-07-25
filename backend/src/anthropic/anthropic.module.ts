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
          client = new Anthropic({ apiKey });
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
