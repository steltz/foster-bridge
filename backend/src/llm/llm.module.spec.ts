// The naive `.overrideProvider(FIRESTORE).useValue({})` from the plan does NOT
// work here: LlmModule -> MoonshotModule -> `imports: [FirebaseModule]`, and
// overriding just the FIRESTORE token still leaves the REAL FirebaseModule's
// other providers (FIREBASE_APP, STORAGE_BUCKET) eagerly instantiated — the
// storageBucketProvider factory throws ("Bucket name not specified") because
// the stubbed config below has no `firebase.storageBucket` key. So this spec
// swaps the whole FirebaseModule for a fake, mirroring moonshot.module.spec.ts.
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Global, Module } from '@nestjs/common';
import { LLM_PROVIDER } from './llm.constants';
import { LlmModule } from './llm.module';
import { MoonshotLlmProvider } from '../moonshot/moonshot.service';
import { AnthropicLlmProvider } from '../anthropic/anthropic.service';
import { FIRESTORE } from '../firebase/firebase.constants';
import { FirebaseModule } from '../firebase/firebase.module';

// MoonshotExtractStore + MoonshotBatchStore (pulled in via MoonshotModule)
// inject FIRESTORE; the real FirebaseModule would initialize firebase-admin,
// so stand in a global fake (same shape as moonshot.module.spec.ts's).
@Global()
@Module({ providers: [{ provide: FIRESTORE, useValue: {} }], exports: [FIRESTORE] })
class FakeFirebaseModule {}

// undefined => `{}`, so llm.provider is genuinely ABSENT from config (not just
// present-and-empty) — the only way to exercise llm.module.ts's own
// `?? 'anthropic'` fallback rather than a value this stub happened to supply.
// No `moonshot`/`anthropic` keys: verified unneeded — neither module's
// constructor path touches its config block, only the lazily-invoked client
// factories (never called by these tests), so stubbing them would only imply
// a boot dependency that doesn't exist.
async function providerFor(llmProvider?: string) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      EventEmitterModule.forRoot(),
      ConfigModule.forRoot({
        isGlobal: true,
        load: [() => (llmProvider === undefined ? {} : { llm: { provider: llmProvider } })],
      }),
      LlmModule,
    ],
  })
    .overrideModule(FirebaseModule)
    .useModule(FakeFirebaseModule)
    .compile();
  return moduleRef.get(LLM_PROVIDER);
}

describe('LlmModule swap seam', () => {
  it('selects Moonshot when llm.provider=moonshot', async () => {
    expect(await providerFor('moonshot')).toBeInstanceOf(MoonshotLlmProvider);
  });
  it('selects Anthropic when llm.provider=anthropic', async () => {
    expect(await providerFor('anthropic')).toBeInstanceOf(AnthropicLlmProvider);
  });
  it('defaults to Anthropic when llm.provider is unset', async () => {
    expect(await providerFor(undefined)).toBeInstanceOf(AnthropicLlmProvider);
  });
  it('throws on an unknown llm.provider', async () => {
    await expect(providerFor('moonshoot')).rejects.toThrow('Unknown llm.provider: "moonshoot"');
  });
});
