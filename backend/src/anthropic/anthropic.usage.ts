import { ServiceTier, UsageTokens } from '../cost/cost.types';

// Pull token counts from an Anthropic SDK `usage` object (beta or non-beta).
// The detailed cache_creation TTL split is used when present; otherwise a flat
// cache_creation_input_tokens is attributed to 1h, because every cached path in
// this app uses ONE_HOUR_CACHE_CONTROL. A future 5m path must surface its TTL.
export function tokensFromUsage(usage: any): UsageTokens {
  const cc = usage?.cache_creation;
  const has5m = typeof cc?.ephemeral_5m_input_tokens === 'number';
  const has1h = typeof cc?.ephemeral_1h_input_tokens === 'number';
  const hasSplit = has5m || has1h;
  const flat = usage?.cache_creation_input_tokens ?? 0;
  return {
    input: usage?.input_tokens ?? 0,
    cacheRead: usage?.cache_read_input_tokens ?? 0,
    cacheCreate5m: hasSplit ? (has5m ? cc.ephemeral_5m_input_tokens : 0) : 0,
    cacheCreate1h: hasSplit ? (has1h ? cc.ephemeral_1h_input_tokens : 0) : flat,
    output: usage?.output_tokens ?? 0,
  };
}

export function serviceTierFromUsage(usage: any, fallback: ServiceTier): ServiceTier {
  const t = usage?.service_tier;
  return t === 'standard' || t === 'batch' || t === 'priority' ? t : fallback;
}
