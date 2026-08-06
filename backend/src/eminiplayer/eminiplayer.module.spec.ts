jest.mock('playwright', () => ({
  chromium: { launch: jest.fn() },
}));

import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import configuration from '../config/configuration';
import { EminiplayerModule } from './eminiplayer.module';
import { EminiplayerService } from './eminiplayer.service';
import { STORAGE_BUCKET, FIRESTORE } from '../firebase/firebase.constants';
import { LLM_PROVIDER } from '../llm/llm.constants';
import { chromium } from 'playwright';

/**
 * FirebaseModule and LlmModule are @Global(), but a global module's providers
 * only exist once that module is somewhere in the compiled graph. Importing
 * the real ones here would open a live bucket / LLM client, so this stub
 * supplies the same tokens. A root-level provider would NOT work: providers
 * passed to Test.createTestingModule aren't visible inside EminiplayerModule's
 * own DI context — a global module's exports are.
 */
@Global()
@Module({
  providers: [
    { provide: STORAGE_BUCKET, useValue: {} },
    { provide: FIRESTORE, useValue: {} },
    { provide: LLM_PROVIDER, useValue: {} },
  ],
  exports: [STORAGE_BUCKET, FIRESTORE, LLM_PROVIDER],
})
class FakeGlobalsModule {}

describe('EminiplayerModule', () => {
  it('compiles and resolves EminiplayerService without launching a browser', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [configuration],
        }),
        FakeGlobalsModule,
        EminiplayerModule,
      ],
    }).compile();
    expect(moduleRef.get(EminiplayerService)).toBeInstanceOf(EminiplayerService);
    expect(chromium.launch).not.toHaveBeenCalled();
    await moduleRef.close();
  });
});
