import { resolve } from 'node:path';

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
    delete process.env.BENCHMARK_SCHEDULER;
    // benchmark.model is now provider-aware (see configuration.ts); isolate
    // these defaults from an ambient LLM_PROVIDER=moonshot.
    delete process.env.LLM_PROVIDER;
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
      // jest sets NODE_ENV='test' -> scheduler defaults OFF.
      schedulerEnabled: false,
    });
  });
});

describe('configuration benchmark schedulerEnabled', () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.BENCHMARK_SCHEDULER;
  });
  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('exposes schedulerEnabled as a boolean by default', () => {
    expect(typeof configuration().benchmark.schedulerEnabled).toBe('boolean');
  });

  it('is false when BENCHMARK_SCHEDULER is "false"', () => {
    process.env.BENCHMARK_SCHEDULER = 'false';
    expect(configuration().benchmark.schedulerEnabled).toBe(false);
  });

  it('is true in production when BENCHMARK_SCHEDULER is unset', () => {
    const oldNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    delete process.env.BENCHMARK_SCHEDULER;
    try {
      expect(configuration().benchmark.schedulerEnabled).toBe(true);
    } finally {
      process.env.NODE_ENV = oldNodeEnv;
    }
  });
});

describe('configuration – moonshot', () => {
  const ENV = process.env;
  beforeEach(() => {
    process.env = { ...ENV };
    Object.keys(process.env)
      .filter((key) => key.startsWith('MOONSHOT_'))
      .forEach((key) => delete process.env[key]);
    delete process.env.LLM_PROVIDER;
    delete process.env.BENCHMARK_MODEL;
  });
  afterEach(() => {
    process.env = ENV;
  });

  it('defaults the moonshot block', () => {
    const cfg = configuration();
    expect(cfg.moonshot.baseUrl).toBe('https://api.moonshot.ai/v1');
    expect(cfg.moonshot.model).toBe('kimi-k3');
    expect(cfg.moonshot.maxTokens).toBe(32000);
    expect(cfg.moonshot.batchConcurrency).toBe(8);
    expect(cfg.moonshot.completionWindow).toBe('1d');
    expect(cfg.moonshot.batchMaxAgeMs).toBe(10800000);
    expect(cfg.moonshot.batchGcTtlMs).toBe(86400000);
    expect(cfg.moonshot.apiKey).toBeUndefined();
  });

  // A set-but-empty MOONSHOT_BASE_URL (e.g. a copied .env.example, or a
  // blanked deploy var) must fall back too: `||`, not `??`. An empty string
  // reaching the OpenAI SDK's constructor resolves to
  // https://api.openai.com/v1, silently sending the Moonshot key to OpenAI's
  // host — see moonshot.module.spec.ts for the matching guard on the other
  // (module-factory) `||` site.
  it('treats a set-but-empty MOONSHOT_BASE_URL as unset', () => {
    process.env.MOONSHOT_BASE_URL = '';
    expect(configuration().moonshot.baseUrl).toBe('https://api.moonshot.ai/v1');
  });

  it('reads env overrides', () => {
    process.env.MOONSHOT_API_KEY = 'sk-moon';
    process.env.MOONSHOT_BASE_URL = 'https://example.test/v1';
    process.env.MOONSHOT_MODEL = 'kimi-k2';
    process.env.MOONSHOT_MAX_TOKENS = '5000';
    process.env.MOONSHOT_BATCH_CONCURRENCY = '2';
    process.env.MOONSHOT_COMPLETION_WINDOW = '24h';
    process.env.MOONSHOT_BATCH_MAX_AGE_MS = '600000';
    process.env.MOONSHOT_BATCH_GC_TTL_MS = '1200000';
    const cfg = configuration();
    expect(cfg.moonshot).toEqual({
      apiKey: 'sk-moon',
      baseUrl: 'https://example.test/v1',
      model: 'kimi-k2',
      maxTokens: 5000,
      batchConcurrency: 2,
      completionWindow: '24h',
      batchMaxAgeMs: 600000,
      batchGcTtlMs: 1200000,
    });
  });

  it('defaults benchmark.model to kimi-k3 when LLM_PROVIDER=moonshot', () => {
    process.env.LLM_PROVIDER = 'moonshot';
    expect(configuration().benchmark.model).toBe('kimi-k3');
  });

  it('keeps benchmark.model as claude-fable-5 for anthropic', () => {
    expect(configuration().benchmark.model).toBe('claude-fable-5');
  });

  // A set-but-empty LLM_PROVIDER (copied .env.example, blanked deploy var)
  // must fall back too — `||`, not `??` — same convention as
  // MOONSHOT_BASE_URL above. Otherwise llm.provider and benchmark.model would
  // disagree on '': the seam throws `Unknown llm.provider: ""` while
  // benchmark.model quietly resolves to claude-fable-5.
  it('treats a set-but-empty LLM_PROVIDER as unset', () => {
    process.env.LLM_PROVIDER = '';
    expect(configuration().llm.provider).toBe('anthropic');
  });
});

describe('configuration (eminiplayer)', () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.EMINIPLAYER_USERNAME;
    delete process.env.EMINIPLAYER_PASSWORD;
    delete process.env.EMINIPLAYER_HEADLESS;
    delete process.env.EMINIPLAYER_SCREENSHOT_DIR;
    delete process.env.EMINIPLAYER_VERIFY_MODEL;
  });
  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('defaults: creds undefined, headless true, screenshotDir anchored to backend/', () => {
    const cfg = configuration();
    expect(cfg.eminiplayer.username).toBeUndefined();
    expect(cfg.eminiplayer.password).toBeUndefined();
    expect(cfg.eminiplayer.headless).toBe(true);
    // Both this spec and configuration.ts live in src/config, so __dirname
    // resolves identically: backend/artifacts/eminiplayer.
    expect(cfg.eminiplayer.screenshotDir).toBe(
      resolve(__dirname, '..', '..', 'artifacts', 'eminiplayer'),
    );
  });

  it('reads env overrides and EMINIPLAYER_HEADLESS=false', () => {
    process.env.EMINIPLAYER_USERNAME = 'user@example.com';
    process.env.EMINIPLAYER_PASSWORD = 'secret';
    process.env.EMINIPLAYER_HEADLESS = 'false';
    process.env.EMINIPLAYER_SCREENSHOT_DIR = '/tmp/shots';
    const cfg = configuration();
    expect(cfg.eminiplayer).toEqual({
      username: 'user@example.com',
      password: 'secret',
      headless: false,
      screenshotDir: '/tmp/shots',
      verifyModel: undefined,
    });
  });

  it('reads EMINIPLAYER_VERIFY_MODEL', () => {
    process.env.EMINIPLAYER_VERIFY_MODEL = 'claude-haiku-4-5';
    expect(configuration().eminiplayer.verifyModel).toBe('claude-haiku-4-5');
  });

  it('treats set-but-empty values as unset (copied .env.example)', () => {
    process.env.EMINIPLAYER_USERNAME = '';
    process.env.EMINIPLAYER_PASSWORD = '';
    process.env.EMINIPLAYER_SCREENSHOT_DIR = '';
    const cfg = configuration();
    expect(cfg.eminiplayer.username).toBeUndefined();
    expect(cfg.eminiplayer.password).toBeUndefined();
    expect(cfg.eminiplayer.screenshotDir).toBe(
      resolve(__dirname, '..', '..', 'artifacts', 'eminiplayer'),
    );
  });
});
