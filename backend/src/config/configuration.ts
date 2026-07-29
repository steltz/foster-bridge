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
    baseUrl: process.env.MOONSHOT_BASE_URL ?? 'https://api.moonshot.ai/v1',
    model: process.env.MOONSHOT_MODEL ?? 'kimi-k3',
    batchConcurrency: parseInt(process.env.MOONSHOT_BATCH_CONCURRENCY ?? '8', 10),
    completionWindow: process.env.MOONSHOT_COMPLETION_WINDOW ?? '1d',
    // D6: emulated-batch expiry (3h) and D5/D6 GC TTL from endedAt (24h).
    batchMaxAgeMs: parseInt(process.env.MOONSHOT_BATCH_MAX_AGE_MS ?? '10800000', 10),
    batchGcTtlMs: parseInt(process.env.MOONSHOT_BATCH_GC_TTL_MS ?? '86400000', 10),
  },
  llm: {
    provider: process.env.LLM_PROVIDER ?? 'anthropic',
  },
  benchmark: {
    // Flagship benchmark model is provider-aware: Fable on Anthropic, Kimi K3 on
    // Moonshot. An explicit BENCHMARK_MODEL always wins.
    model:
      process.env.BENCHMARK_MODEL ??
      ((process.env.LLM_PROVIDER ?? 'anthropic') === 'moonshot' ? 'kimi-k3' : 'claude-fable-5'),
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
});
