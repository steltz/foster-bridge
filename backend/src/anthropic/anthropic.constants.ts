import type Anthropic from '@anthropic-ai/sdk';

export const ANTHROPIC_CLIENT = Symbol('ANTHROPIC_CLIENT');

/**
 * Lazily constructs and memoizes the Anthropic SDK client. `get()` throws an
 * UnauthorizedException when no API key is configured, and never constructs
 * the client at module init — so the app boots without a key.
 */
export interface AnthropicClientFactory {
  get(): Anthropic;
}

/**
 * 1-hour ephemeral cache breakpoint. A single frozen object reused across the
 * warm-up and every batch item so the rendered prefix stays byte-identical —
 * any drift in the prefix silently invalidates the cache.
 */
export const ONE_HOUR_CACHE_CONTROL = { type: 'ephemeral', ttl: '1h' } as const;
