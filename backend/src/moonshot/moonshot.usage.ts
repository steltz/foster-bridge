import { UsageTokens } from '../cost/cost.types';

// Pull token counts from a Moonshot (OpenAI-compatible) `usage` object. Moonshot
// returns `cached_tokens` at the TOP LEVEL (not nested under
// prompt_tokens_details like OpenAI). Uncached input = prompt_tokens - cached.
// Moonshot has no cache-write token concept, so both create tiers are always 0.
export function tokensFromUsage(usage: any): UsageTokens {
  const prompt = usage?.prompt_tokens ?? 0;
  const cached = usage?.cached_tokens ?? 0;
  return {
    input: Math.max(0, prompt - cached),
    cacheRead: cached,
    cacheCreate5m: 0,
    cacheCreate1h: 0,
    output: usage?.completion_tokens ?? 0,
  };
}
