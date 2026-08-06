jest.mock('playwright', () => ({
  chromium: { launch: jest.fn() },
}));

import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import configuration from '../config/configuration';
import { EminiplayerModule } from './eminiplayer.module';
import { EminiplayerService } from './eminiplayer.service';
import { chromium } from 'playwright';

describe('EminiplayerModule', () => {
  it('compiles and resolves EminiplayerService without launching a browser', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [configuration],
        }),
        EminiplayerModule,
      ],
    }).compile();
    expect(moduleRef.get(EminiplayerService)).toBeInstanceOf(EminiplayerService);
    expect(chromium.launch).not.toHaveBeenCalled();
    await moduleRef.close();
  });
});
