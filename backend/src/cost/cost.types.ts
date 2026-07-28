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
