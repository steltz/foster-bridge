const AnthropicCtor = jest.fn().mockImplementation(() => ({ __client: true }));
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: AnthropicCtor,
}));

import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { AnthropicModule } from './anthropic.module';
import { ANTHROPIC_CLIENT, AnthropicClientFactory } from './anthropic.constants';
import configuration from '../config/configuration';

describe('AnthropicModule client factory', () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    AnthropicCtor.mockClear();
    process.env = { ...OLD_ENV };
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterAll(() => {
    process.env = OLD_ENV;
  });

  async function buildFactory(): Promise<AnthropicClientFactory> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
        AnthropicModule,
      ],
    }).compile();
    return moduleRef.get<AnthropicClientFactory>(ANTHROPIC_CLIENT);
  }

  it('does not construct the SDK client at module init (lazy)', async () => {
    await buildFactory();
    expect(AnthropicCtor).not.toHaveBeenCalled();
  });

  it('throws UnauthorizedException from get() when no API key is set', async () => {
    const factory = await buildFactory();
    expect(() => factory.get()).toThrow(UnauthorizedException);
    expect(AnthropicCtor).not.toHaveBeenCalled();
  });

  it('constructs once and memoizes when the key is set', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const factory = await buildFactory();
    const a = factory.get();
    const b = factory.get();
    expect(a).toBe(b);
    expect(AnthropicCtor).toHaveBeenCalledTimes(1);
    expect(AnthropicCtor).toHaveBeenCalledWith({ apiKey: 'sk-test' });
  });
});
