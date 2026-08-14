import { resolve } from 'node:path';

export interface AppConfig {
  port: number;
  firebase: {
    projectId: string;
    storageBucket: string;
  };
  anthropic: {
    apiKey?: string;
    model: string;
    maxTokens: number;
  };
  moonshot: {
    apiKey?: string;
    baseUrl: string;
    model: string;
    maxTokens: number;
    batchConcurrency: number;
    completionWindow: string;
    batchMaxAgeMs: number;
    batchGcTtlMs: number;
  };
  llm: {
    provider: string;
  };
  benchmark: {
    model: string;
    repoRoot: string;
    defaultRunCount: number;
    maxTokens: number;
    effort: string;
    schedulerEnabled: boolean;
  };
  eminiplayer: {
    username?: string;
    password?: string;
    headless: boolean;
    screenshotDir: string;
    verifyModel?: string;
    backfillDelayMs: number;
    backfillDayTimeoutMs: number;
    backfillToken?: string;
  };
}

export default (): AppConfig => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  firebase: {
    projectId:
      process.env.FIREBASE_PROJECT_ID ??
      process.env.GCLOUD_PROJECT ??
      'app-foster-bridge',
    storageBucket:
      process.env.FIREBASE_STORAGE_BUCKET ??
      'app-foster-bridge.firebasestorage.app',
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5',
    maxTokens: parseInt(process.env.ANTHROPIC_MAX_TOKENS ?? '4096', 10),
  },
  moonshot: {
    apiKey: process.env.MOONSHOT_API_KEY,
    // `||`, not `??`: a set-but-empty MOONSHOT_BASE_URL must fall back too (see
    // moonshot.module.ts's client factory for why).
    baseUrl: process.env.MOONSHOT_BASE_URL || 'https://api.moonshot.ai/v1',
    model: process.env.MOONSHOT_MODEL ?? 'kimi-k3',
    // Default output ceiling for sync + batch requests. Much larger than
    // ANTHROPIC_MAX_TOKENS because Kimi reasoning models spend tokens on
    // thinking before the JSON payload.
    maxTokens: parseInt(process.env.MOONSHOT_MAX_TOKENS ?? '32000', 10),
    batchConcurrency: parseInt(process.env.MOONSHOT_BATCH_CONCURRENCY ?? '8', 10),
    completionWindow: process.env.MOONSHOT_COMPLETION_WINDOW ?? '1d',
    // D6: emulated-batch expiry (3h) and D5/D6 GC TTL from endedAt (24h).
    batchMaxAgeMs: parseInt(process.env.MOONSHOT_BATCH_MAX_AGE_MS ?? '10800000', 10),
    batchGcTtlMs: parseInt(process.env.MOONSHOT_BATCH_GC_TTL_MS ?? '86400000', 10),
  },
  llm: {
    // `||`, not `??`: a set-but-empty LLM_PROVIDER (a copied .env.example, a
    // blanked-out deploy var) must also fall back, same convention as
    // moonshot.baseUrl above — otherwise '' reaches llm.module.ts's switch and
    // throws `Unknown llm.provider: ""` instead of booting Anthropic.
    provider: process.env.LLM_PROVIDER || 'anthropic',
  },
  benchmark: {
    // Flagship benchmark model is provider-aware: Fable on Anthropic, Kimi K3 on
    // Moonshot. An explicit BENCHMARK_MODEL always wins.
    model:
      process.env.BENCHMARK_MODEL ??
      // `||`, not `??`, on this LLM_PROVIDER read too — must agree with
      // llm.provider above on a set-but-empty LLM_PROVIDER, or this resolves
      // 'claude-fable-5' while the seam crashes on the unfallback-ed ''.
      ((process.env.LLM_PROVIDER || 'anthropic') === 'moonshot' ? 'kimi-k3' : 'claude-fable-5'),
    // configuration.{ts,js} lives at backend/src/config (dist/config after build);
    // '../../..' lands on the repo root (parent of backend/) in both layouts.
    repoRoot: process.env.BENCHMARK_REPO_ROOT ?? resolve(__dirname, '..', '..', '..'),
    defaultRunCount: parseInt(process.env.BENCHMARK_RUN_COUNT ?? '5', 10),
    // effort is the QUALITY dial (default 'high'; set BENCHMARK_EFFORT='max' for the
    // hardest runs) — NOT a cost lever. Cost is controlled by prompt caching + the
    // Batch API + a deliberate minimal structured-JSON output. maxTokens is a generous
    // truncation-safety ceiling for Fable's always-on thinking (batch bills only tokens
    // actually generated, so a high ceiling costs nothing when unused); raise
    // BENCHMARK_MAX_TOKENS if high/max effort ever truncates a setup (stop_reason max_tokens).
    maxTokens: parseInt(process.env.BENCHMARK_MAX_TOKENS ?? '32000', 10),
    effort: process.env.BENCHMARK_EFFORT ?? 'high',
    // Gates the batch reconciler + cache-warmer schedulers (cron/interval and the
    // boot-time reconcile). ON by default; OFF under jest (NODE_ENV==='test') so
    // unrelated specs never hit real Firestore at boot, and per-instance in prod
    // (BENCHMARK_SCHEDULER='false') so only a dedicated worker runs the crons.
    schedulerEnabled: process.env.BENCHMARK_SCHEDULER !== 'false' && process.env.NODE_ENV !== 'test',
  },
  eminiplayer: {
    // `|| undefined`, not a bare read: .env.example ships these keys empty, so
    // the usual copy-to-.env flow sets them to ''. An empty string must read as
    // "not configured" rather than as a present-but-blank credential — same
    // convention as llm.provider / moonshot.baseUrl above.
    username: process.env.EMINIPLAYER_USERNAME || undefined,
    password: process.env.EMINIPLAYER_PASSWORD || undefined,
    // Headed mode is opt-in for local debugging: EMINIPLAYER_HEADLESS=false.
    headless: process.env.EMINIPLAYER_HEADLESS !== 'false',
    // Anchored to the module location like benchmark.repoRoot above — NOT cwd,
    // so screenshots of authenticated content can never land outside backend/
    // (src/config and dist/config are both two levels below backend/).
    // `||`, not `??`: a copied .env.example sets this to '', and '' would
    // otherwise survive as the screenshot dir and void that guarantee.
    screenshotDir:
      process.env.EMINIPLAYER_SCREENSHOT_DIR ||
      resolve(__dirname, '..', '..', 'artifacts', 'eminiplayer'),
    // Model for LLM transcript verification. `|| undefined` convention (see
    // username above): unset/empty means "use the provider's default model".
    // Set a cheap classifier (e.g. Haiku) to cut verification cost.
    verifyModel: process.env.EMINIPLAYER_VERIFY_MODEL || undefined,
    // Pause between backfill days that touched the network — politeness knob
    // for eminiplayer.net and YouTube during multi-hour bulk runs. `||`, not
    // `??`: a copied .env.example sets this to '' and parseInt('') is NaN.
    backfillDelayMs: parseInt(process.env.EMINIPLAYER_BACKFILL_DELAY_MS || '2000', 10),
    // Per-day ceiling: a hung external call becomes a 'stage' ledger entry
    // instead of wedging the singleton job forever.
    backfillDayTimeoutMs: parseInt(
      process.env.EMINIPLAYER_BACKFILL_DAY_TIMEOUT_MS || '600000',
      10,
    ),
    // When set, POST/DELETE /eminiplayer/backfill require a matching
    // x-backfill-token header (`|| undefined` convention: empty = unset).
    backfillToken: process.env.EMINIPLAYER_BACKFILL_TOKEN || undefined,
  },
});
