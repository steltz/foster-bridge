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
