import { Attribution, UsageTokens } from '../cost/cost.types';

// Re-exported so consumers of the port can import attribution/usage from one place.
export { Attribution, UsageTokens };

/**
 * Provider-neutral content block. Replaces the raw Anthropic
 * `Anthropic.Beta.BetaContentBlockParam` shapes that previously leaked into the
 * benchmark. A `file` block references a provider-uploaded file by its neutral id;
 * the adapter maps it to the provider's concrete document/file shape.
 */
export type LlmContentBlock =
  | { type: 'text'; text: string }
  | { type: 'file'; fileId: string };

/** One cache tier — the adapter places exactly one cache breakpoint per tier. */
export interface LlmCacheTier {
  blocks: LlmContentBlock[];
}

/**
 * Provider-neutral cached context. Replaces `CachedContext`. `tiers` are ordered
 * shared/cacheable context rendered ahead of the per-request prompt; `system` is
 * an optional cached system prompt.
 */
export interface PromptEnvelope {
  system?: string;
  tiers?: LlmCacheTier[];
}

/** A single synchronous structured-output request. */
export interface StructuredRequest {
  prompt: string;
  system?: string;
  envelope?: PromptEnvelope;
  schema?: unknown; // JSON schema
  model?: string;
  effort?: string;
  maxTokens?: number;
}

/** One item in a batch submission. Replaces `BatchRequestInput`. */
export interface BatchItemRequest {
  customId?: string;
  prompt: string;
  /** Per-item envelope; overrides the batch-level envelope when set. */
  envelope?: PromptEnvelope;
}

export interface BatchSubmitOptions {
  model?: string;
  schema?: unknown;
  maxTokens?: number;
  effort?: string;
}

/** Neutral batch lifecycle. Replaces provider `processing_status` strings. */
export type BatchLifecycle =
  | 'submitted'
  | 'in_progress'
  | 'ended'
  | 'canceled'
  | 'expired'
  | 'errored';

export interface BatchHandle {
  batchId: string;
  status: BatchLifecycle;
  requestCounts?: unknown;
}

/**
 * One reconciled batch item. Replaces `BatchResultItem`. `usage` is the neutral,
 * adapter-parsed `UsageTokens` (never a raw SDK usage object).
 */
export interface BatchItemResult {
  customId: string;
  type: 'succeeded' | 'refusal' | 'errored' | 'canceled' | 'expired' | string;
  text?: string;
  error?: string;
  cacheReadTokens?: number;
  usage?: UsageTokens;
}
