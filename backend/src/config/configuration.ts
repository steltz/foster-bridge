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
  benchmark: {
    model: string;
    repoRoot: string;
    defaultRunCount: number;
    maxTokens: number;
    effort: string;
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
  benchmark: {
    // Benchmark model is independent of the global ANTHROPIC_MODEL; Fable by default.
    model: process.env.BENCHMARK_MODEL ?? 'claude-fable-5',
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
  },
});
