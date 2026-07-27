import { CostBreakdown, ServiceTier, UsageTokens } from './cost.types';

interface RateEntry {
  id: string; // model id, matching the id recorded by resolveModel
  inputPerMTok: number;
  outputPerMTok: number;
  effectiveFrom: string; // inclusive ISO date/datetime lower bound
  effectiveTo?: string; // exclusive upper bound; omitted = open-ended
  version: string;
}

const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2.0;
const CACHE_READ = 0.1;

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
];

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
  const entry = RATE_TABLE.find(
    (r) => r.id === modelId && r.effectiveFrom <= timestamp && (!r.effectiveTo || timestamp < r.effectiveTo),
  );
  if (!entry) return null;

  const inRate = entry.inputPerMTok / 1_000_000;
  const outRate = entry.outputPerMTok / 1_000_000;
  const mult = TIER_MULTIPLIER[tier];
  const round = (n: number) => Math.round(n * mult * 1e8) / 1e8; // apply tier, then 8-dp round

  const input = tokens.input * inRate;
  const cacheRead = tokens.cacheRead * inRate * CACHE_READ;
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
