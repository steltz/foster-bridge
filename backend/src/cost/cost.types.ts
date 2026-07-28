export type ServiceTier = 'standard' | 'batch' | 'priority';

export type Operation = 'warm' | 'setup' | 'keys-generation' | 'demo' | 'message' | 'other';

export interface BenchmarkAttribution {
  modelAlias: string;
  day?: string; // MMDDYYYY
  trader?: string;
  variant?: string;
  runIndex?: number;
}

export interface Attribution {
  operation: Operation;
  benchmark?: BenchmarkAttribution;
}

// Raw token counts extracted from a response's `usage` object.
export interface UsageTokens {
  input: number; // uncached input tokens (full price)
  cacheRead: number; // cache_read_input_tokens
  cacheCreate5m: number; // 5-minute-TTL cache writes
  cacheCreate1h: number; // 1-hour-TTL cache writes
  output: number;
}

// Emitted on the 'llm.usage' event by every capture point.
export interface UsageEvent {
  id: string; // deterministic for batch (`${batchId}:${customId}`), uuid for sync
  timestamp: string; // ISO-8601 UTC
  modelId: string; // the model id used on the request (e.g. 'claude-fable-5')
  serviceTier: ServiceTier;
  attribution: Attribution;
  tokens: UsageTokens;
  source: 'sync' | 'batch';
  batchId?: string;
}

export interface CostBreakdown {
  input: number;
  cacheRead: number;
  cacheCreate: number;
  output: number;
  total: number; // USD
  // Counterfactual: what all input-side tokens (input + cacheRead + both cache
  // creation tiers) would cost as plain uncached input at this model's rate x tier.
  // Net cache benefit = uncachedInputEquiv - (input + cacheRead + cacheCreate).
  uncachedInputEquiv: number;
}

// Persisted, immutable, one per request.
export interface CostRecord {
  id: string;
  timestamp: string;
  model: { alias: string; id: string };
  serviceTier: ServiceTier;
  operation: Operation;
  benchmark?: BenchmarkAttribution;
  tokens: UsageTokens;
  cost: CostBreakdown | null; // null when the model is unpriced
  pricingVersion: string | null;
  source: 'sync' | 'batch';
  batchId?: string;
  note?: string;
}

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
