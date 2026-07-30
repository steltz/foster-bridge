import type OpenAI from 'openai';

export const MOONSHOT_CLIENT = Symbol('MOONSHOT_CLIENT');

/**
 * Lazily constructs and memoizes the OpenAI-compatible Moonshot client. `get()`
 * throws an UnauthorizedException when no API key is configured and never
 * constructs at module init — so the app boots without a key (mirrors Anthropic).
 */
export interface MoonshotClientFactory {
  get(): OpenAI;
}

/** Synthetic file-id prefix returned by uploadFile; resolves to extracted text. */
export const MOONSHOT_EXTRACT_ID_PREFIX = 'moonshot-extract:';

/** Output ceiling when neither the caller nor `moonshot.maxTokens` supplies one. */
export const DEFAULT_MAX_COMPLETION_TOKENS = 32000;

/**
 * Guard for every numeric `moonshot.*` config value. They all arrive through
 * `parseInt(process.env…)`, so an env var that is SET BUT EMPTY reads back as
 * `NaN` — which downstream becomes `max_completion_tokens: null` in a request
 * body, a `RangeError` from `new Date(now + NaN).toISOString()`, or a drain pool
 * with zero runners that silently skips every item. Anything that is not a finite
 * number at or above `min` falls back.
 *
 * `min` defaults to 1 (token counts, millisecond spans and concurrency are all
 * meaningless below that); pass `0` where zero is a legitimate setting, e.g. a GC
 * TTL of 0 meaning "collect as soon as a batch is terminal".
 */
export function numericConfig(value: unknown, fallback: number, min = 1): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min ? value : fallback;
}

/**
 * Models that support Moonshot's native Batch API. Deliberately narrower than
 * Moonshot's batch-eligible docs: kimi-k3 is absent because the docs state it
 * is not batchable, so it routes to durable emulation instead. kimi-k2.5 is
 * also absent — it has no RATE_TABLE row or MODEL_ALIASES entry and is closed
 * to new users with full sunset 2026-08-31, so real native-batch spend would
 * record as unpriced $0. Unlisted models safely fall back to emulated batch,
 * so omitting it loses no capability.
 */
export const BATCHABLE_MODELS: ReadonlySet<string> = new Set([
  'kimi-k2.6',
  'kimi-k2.7-code',
]);

export function isBatchable(model: string): boolean {
  return BATCHABLE_MODELS.has(model);
}
