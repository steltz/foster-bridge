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

describe('configuration benchmark defaults', () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.BENCHMARK_MODEL;
    delete process.env.BENCHMARK_REPO_ROOT;
    delete process.env.BENCHMARK_RUN_COUNT;
    delete process.env.BENCHMARK_MAX_TOKENS;
    delete process.env.BENCHMARK_EFFORT;
  });
  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('defaults the benchmark model to claude-fable-5', () => {
    expect(configuration().benchmark.model).toBe('claude-fable-5');
  });

  it('defaults defaultRunCount to 5, repoRoot absolute, maxTokens 32000, effort high', () => {
    const cfg = configuration();
    expect(cfg.benchmark.defaultRunCount).toBe(5);
    expect(cfg.benchmark.repoRoot.length).toBeGreaterThan(0);
    expect(cfg.benchmark.repoRoot.startsWith('/')).toBe(true);
    expect(cfg.benchmark.maxTokens).toBe(32000);
    expect(cfg.benchmark.effort).toBe('high');
  });

  it('honours env overrides', () => {
    process.env.BENCHMARK_MODEL = 'claude-opus-4-8';
    process.env.BENCHMARK_REPO_ROOT = '/tmp/fixture';
    process.env.BENCHMARK_RUN_COUNT = '3';
    process.env.BENCHMARK_MAX_TOKENS = '8000';
    process.env.BENCHMARK_EFFORT = 'medium';
    const cfg = configuration();
    expect(cfg.benchmark).toEqual({
      model: 'claude-opus-4-8',
      repoRoot: '/tmp/fixture',
      defaultRunCount: 3,
      maxTokens: 8000,
      effort: 'medium',
    });
  });
});
