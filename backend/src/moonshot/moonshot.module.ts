import { Global, Module, Provider, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { MOONSHOT_CLIENT, MoonshotClientFactory } from './moonshot.constants';
import { MoonshotLlmProvider } from './moonshot.service';
import { MoonshotEnvelopeBuilder } from './moonshot.envelope';
import { MoonshotExtractStore } from './moonshot.extract-store';
import { MoonshotBatchStore } from './moonshot.batch-store';
import { MoonshotBatchWorker } from './moonshot.batch-worker';
import { FirebaseModule } from '../firebase/firebase.module';

// Same 30-minute value as the Anthropic module, but for a different reason:
// openai v4 has no non-streaming max_tokens precondition to satisfy (that's
// an Anthropic SDK guard). Kimi K3's always-on reasoning at a high
// max_completion_tokens ceiling can still run long, so the client gets a
// generous timeout so a legitimate slow call is not aborted early.
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
          // `||`, not `??`: a MOONSHOT_BASE_URL that is SET BUT EMPTY (a routine
          // deploy state — a copied .env.example, a blanked-out var) must also
          // fall back. openai v4's own constructor does `baseURL || 'https://
          // api.openai.com/v1'`, so an empty string reaching it would silently
          // send the Moonshot API key to OpenAI's host instead of erroring. The
          // default here duplicates configuration.ts's own `||` fallback —
          // belt-and-braces, not load-bearing on its own.
          const baseURL = config.get<string>('moonshot.baseUrl') || 'https://api.moonshot.ai/v1';
          client = new OpenAI({ apiKey, baseURL, timeout: CLIENT_TIMEOUT_MS });
        }
        return client;
      },
    };
  },
};

@Global()
@Module({
  // MoonshotExtractStore and MoonshotBatchStore each @Inject(FIRESTORE), an
  // undeclared hard dependency that today only resolves because FirebaseModule
  // happens to be @Global() elsewhere in the app graph. Declaring the import
  // here documents that coupling explicitly; Nest dedupes a module imported
  // from multiple places in the graph, so this costs nothing in production.
  imports: [FirebaseModule],
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
