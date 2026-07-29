import { CostBreakdown, ServiceTier, UsageTokens } from './cost.types';

interface RateEntry {
  id: string; // model id, matching the id recorded by resolveModel
  inputPerMTok: number;
  outputPerMTok: number;
  effectiveFrom: string; // inclusive ISO date/datetime lower bound
  effectiveTo?: string; // exclusive upper bound; omitted = open-ended
  version: string;
  // Optional per-model overrides for providers whose economics differ from the
  // Anthropic-shaped globals. When absent, the module-level constants apply.
  batchMultiplier?: number; // replaces TIER_MULTIPLIER.batch for this model
  cacheReadMultiplier?: number; // replaces CACHE_READ for this model
}

const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2.0;
export const CACHE_READ = 0.1;

// Batch = 50% of standard. Priority is stubbed at 1 (the app does not use it).
const TIER_MULTIPLIER: Record<ServiceTier, number> = { standard: 1, batch: 0.5, priority: 1 };

// Rates per MTok, sourced from the claude-api pricing reference (2026-07).
// Date-windowed so historical records reprice correctly across a rate change.
export const RATE_TABLE: RateEntry[] = [
  { id: 'claude-fable-5', inputPerMTok: 10, outputPerMTok: 50, effectiveFrom: '2000-01-01', version: 'fable-2026-07' },
  { id: 'claude-opus-4-8', inputPerMTok: 5, outputPerMTok: 25, effectiveFrom: '2000-01-01', version: 'opus48-2026-07' },
  // Sonnet 5 introductory pricing runs through 2026-08-31; standard from 2026-09-01.
  { id: 'claude-sonnet-5', inputPerMTok: 2, outputPerMTok: 10, effectiveFrom: '2000-01-01', effectiveTo: '2026-09-01', version: 'sonnet5-intro' },
  { id: 'claude-sonnet-5', inputPerMTok: 3, outputPerMTok: 15, effectiveFrom: '2026-09-01', version: 'sonnet5-standard' },
  { id: 'claude-haiku-4-5-20251001', inputPerMTok: 1, outputPerMTok: 5, effectiveFrom: '2000-01-01', version: 'haiku45-2026-07' },
  // Moonshot / Kimi. kimi-k3 is NOT batchable → its emulated-batch spend must be
  // priced at standard (batchMultiplier 1.0). k3 cache-read $0.30 = 0.1x miss, so
  // it matches the global CACHE_READ (no override). The batchable code models are
  // 40% off on batch, with their own cache-hit/miss ratios. Moonshot emits no
  // cache-create tokens, so the CACHE_WRITE_5M/1H globals never apply to these rows.
  { id: 'kimi-k3', inputPerMTok: 3.0, outputPerMTok: 15.0, effectiveFrom: '2000-01-01', version: 'kimi-k3-2026-07', batchMultiplier: 1.0 },
  { id: 'kimi-k2.6', inputPerMTok: 0.95, outputPerMTok: 4.0, effectiveFrom: '2000-01-01', version: 'kimi-k2.6-2026-07', batchMultiplier: 0.6, cacheReadMultiplier: 0.16 / 0.95 }, // $0.16 hit / $0.95 miss
  { id: 'kimi-k2.7-code', inputPerMTok: 0.95, outputPerMTok: 4.0, effectiveFrom: '2000-01-01', version: 'kimi-k2.7-code-2026-07', batchMultiplier: 0.6, cacheReadMultiplier: 0.19 / 0.95 }, // $0.19 hit / $0.95 miss
];

// Shared lookup: the date-windowed rate entry active for a model at a given
// timestamp, or undefined if no entry covers it (unknown model or out of range).
function findRate(modelId: string, timestamp: string): RateEntry | undefined {
  return RATE_TABLE.find(
    (r) => r.id === modelId && r.effectiveFrom <= timestamp && (!r.effectiveTo || timestamp < r.effectiveTo),
  );
}

// Gross read discount per paid cache-read dollar: full input (1x) minus what was
// paid (the cache-read multiplier x), divided by what was paid. Per-model, since
// providers like Moonshot have their own hit/miss ratio (e.g. kimi-k2.6 -> 4.9375);
// falls back to the global CACHE_READ (9) for models with no override.
export function cacheReadDiscountFactor(modelId: string, timestamp: string): number {
  const entry = findRate(modelId, timestamp);
  const m = entry?.cacheReadMultiplier ?? CACHE_READ;
  return (1 - m) / m;
}

export interface PriceResult {
  cost: CostBreakdown;
  version: string;
}

// Pure. Returns null (never throws) for an unpriceable model so cost capture can
// record it as "unpriced" without ever breaking the request path.
export function priceUsage(
  tokens: UsageTokens,
  modelId: string,
  tier: ServiceTier,
  timestamp: string,
): PriceResult | null {
  const entry = findRate(modelId, timestamp);
  if (!entry) return null;

  const inRate = entry.inputPerMTok / 1_000_000;
  const outRate = entry.outputPerMTok / 1_000_000;
  const mult = tier === 'batch' ? (entry.batchMultiplier ?? TIER_MULTIPLIER.batch) : TIER_MULTIPLIER[tier];
  const round = (n: number) => Math.round(n * mult * 1e8) / 1e8; // apply tier, then 8-dp round

  const input = tokens.input * inRate;
  const cacheRead = tokens.cacheRead * inRate * (entry.cacheReadMultiplier ?? CACHE_READ);
  const cacheCreate = tokens.cacheCreate5m * inRate * CACHE_WRITE_5M + tokens.cacheCreate1h * inRate * CACHE_WRITE_1H;
  const output = tokens.output * outRate;
  // Counterfactual: every input-side token as plain uncached input.
  const inputSideTokens = tokens.input + tokens.cacheRead + tokens.cacheCreate5m + tokens.cacheCreate1h;
  const uncachedInputEquiv = inputSideTokens * inRate;

  return {
    cost: {
      input: round(input),
      cacheRead: round(cacheRead),
      cacheCreate: round(cacheCreate),
      output: round(output),
      total: round(input + cacheRead + cacheCreate + output),
      uncachedInputEquiv: round(uncachedInputEquiv),
    },
    version: entry.version,
  };
}
