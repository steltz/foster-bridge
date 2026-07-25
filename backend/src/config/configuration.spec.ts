import configuration from './configuration';

describe('configuration (anthropic)', () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.ANTHROPIC_MAX_TOKENS;
  });
  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('defaults model to claude-sonnet-5 and max tokens to 4096, apiKey undefined', () => {
    const config = configuration();
    expect(config.anthropic.model).toBe('claude-sonnet-5');
    expect(config.anthropic.maxTokens).toBe(4096);
    expect(config.anthropic.apiKey).toBeUndefined();
  });

  it('reads env overrides', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.ANTHROPIC_MODEL = 'claude-opus-5';
    process.env.ANTHROPIC_MAX_TOKENS = '8192';
    const config = configuration();
    expect(config.anthropic).toEqual({
      apiKey: 'sk-test',
      model: 'claude-opus-5',
      maxTokens: 8192,
    });
  });
});
