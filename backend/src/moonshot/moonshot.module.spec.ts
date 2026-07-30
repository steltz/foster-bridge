// Mirrors anthropic.module.spec.ts (lazy / 401 / memoize / baseURL override),
// plus a regression guard for the empty-string MOONSHOT_BASE_URL defect (see
// the last test below). MoonshotExtractStore + MoonshotBatchStore each
// @Inject(FIRESTORE); MoonshotModule declares `imports: [FirebaseModule]` to
// supply it, so this spec overrides that import with a @Global fake rather
// than let the real FirebaseModule initialize firebase-admin.
const OpenAICtor = jest.fn().mockImplementation(() => ({ __client: true }));
jest.mock('openai', () => ({ __esModule: true, default: OpenAICtor, toFile: jest.fn() }));

import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Global, Module, UnauthorizedException } from '@nestjs/common';
import { MoonshotModule } from './moonshot.module';
import { MOONSHOT_CLIENT, MoonshotClientFactory } from './moonshot.constants';
import { FIRESTORE } from '../firebase/firebase.constants';
import { FirebaseModule } from '../firebase/firebase.module';
import configuration from '../config/configuration';

// MoonshotExtractStore + MoonshotBatchStore inject FIRESTORE; the real
// FirebaseModule would initialize firebase-admin, so stand in a global fake.
@Global()
@Module({ providers: [{ provide: FIRESTORE, useValue: {} }], exports: [FIRESTORE] })
class FakeFirebaseModule {}

describe('MoonshotModule client factory', () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    OpenAICtor.mockClear();
    process.env = { ...OLD_ENV };
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.MOONSHOT_BASE_URL;
  });
  afterAll(() => {
    process.env = OLD_ENV;
  });

  async function buildFactory(): Promise<MoonshotClientFactory> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        // ignoreEnvFile keeps this hermetic: configuration is driven purely from
        // the process.env controlled in beforeEach, so a developer's real .env
        // MOONSHOT_API_KEY cannot mask the "no key set" case.
        ConfigModule.forRoot({ isGlobal: true, load: [configuration], ignoreEnvFile: true }),
        EventEmitterModule.forRoot(),
        MoonshotModule,
      ],
    })
      // MoonshotModule pulls in FirebaseModule via its own `imports: [FirebaseModule]`
      // (for FIRESTORE), so swap that nested import for the fake here rather than
      // sibling-import the fake at the top level — the latter would leave the
      // REAL FirebaseModule instantiated too (initializing firebase-admin) with
      // both providers racing to supply FIRESTORE globally. This override is the
      // only source of FIRESTORE in this test module.
      .overrideModule(FirebaseModule)
      .useModule(FakeFirebaseModule)
      .compile();
    return moduleRef.get<MoonshotClientFactory>(MOONSHOT_CLIENT);
  }

  it('does not construct the SDK client at module init (lazy)', async () => {
    await buildFactory();
    expect(OpenAICtor).not.toHaveBeenCalled();
  });

  it('throws UnauthorizedException from get() when no API key is set', async () => {
    const factory = await buildFactory();
    expect(() => factory.get()).toThrow(UnauthorizedException);
    expect(OpenAICtor).not.toHaveBeenCalled();
  });

  it('constructs once and memoizes when the key is set', async () => {
    process.env.MOONSHOT_API_KEY = 'sk-test';
    const factory = await buildFactory();
    const a = factory.get();
    const b = factory.get();
    expect(a).toBe(b);
    expect(OpenAICtor).toHaveBeenCalledTimes(1);
    expect(OpenAICtor).toHaveBeenCalledWith({
      apiKey: 'sk-test',
      baseURL: 'https://api.moonshot.ai/v1',
      timeout: 30 * 60 * 1000,
    });
  });

  it('honours a MOONSHOT_BASE_URL override', async () => {
    process.env.MOONSHOT_API_KEY = 'sk-test';
    process.env.MOONSHOT_BASE_URL = 'https://proxy.internal/v1';
    const factory = await buildFactory();
    factory.get();
    expect(OpenAICtor.mock.calls[0][0].baseURL).toBe('https://proxy.internal/v1');
  });

  // Regression guard for the empty-baseURL defect: an empty string reaching the
  // SDK resolves to https://api.openai.com/v1 (openai@4.104.0 index.js:81
  // `baseURL || 'https://api.openai.com/v1'`), silently sending the Moonshot key
  // to OpenAI's host. Each `||` (configuration.ts's and this module factory's)
  // independently guards against that, so this only FAILS if BOTH revert from
  // `||` back to `??` for the baseUrl read (defense in depth) — the config-layer
  // guard alone is pinned separately in configuration.spec.ts.
  it('falls back to the Moonshot host when MOONSHOT_BASE_URL is set but empty', async () => {
    process.env.MOONSHOT_API_KEY = 'sk-test';
    process.env.MOONSHOT_BASE_URL = '';
    const factory = await buildFactory();
    factory.get();
    expect(OpenAICtor.mock.calls[0][0].baseURL).toBe('https://api.moonshot.ai/v1');
  });
});
