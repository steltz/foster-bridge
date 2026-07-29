import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { CostRepository, ListFilters } from './cost.repository';
import { priceUsage, cacheReadDiscountFactor } from './pricing';
import { CostRecord, UsageEvent } from './cost.types';

export type GroupBy = 'tier' | 'operation' | 'model' | 'day' | 'trader' | 'variant' | 'date';

export interface SummaryQuery extends ListFilters {
  groupBy: GroupBy;
}

export interface SummaryGroup {
  key: string;
  records: number;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export interface Summary {
  groupBy: GroupBy;
  totalUsd: number;
  totalRecords: number;
  // Gross read discount: the 0.9x-of-full saved on cacheRead tokens (paid 0.1x).
  grossCacheReadDiscountUsd: number;
  // Net cache benefit: uncached-input-equivalent minus what was actually paid on
  // the input side (input + cacheRead + cacheCreate). NEGATIVE when 1h write
  // premiums outweigh read savings on low-reuse prefixes.
  netCacheBenefitUsd: number;
  groups: SummaryGroup[];
}

@Injectable()
export class CostService {
  private readonly logger = new Logger(CostService.name);

  constructor(private readonly repo: CostRepository) {}

  // Event listener. Fire-and-forget from the emitter's perspective: any failure
  // is logged and swallowed so a pricing/persist error never affects the request.
  @OnEvent('llm.usage')
  async onUsage(event: UsageEvent): Promise<void> {
    try {
      const priced = priceUsage(event.tokens, event.modelId, event.serviceTier, event.timestamp);
      const alias = event.attribution.benchmark?.modelAlias ?? event.modelId;
      const record: CostRecord = {
        id: event.id,
        timestamp: event.timestamp,
        model: { alias, id: event.modelId },
        serviceTier: event.serviceTier,
        operation: event.attribution.operation,
        ...(event.attribution.benchmark ? { benchmark: event.attribution.benchmark } : {}),
        tokens: event.tokens,
        cost: priced ? priced.cost : null,
        pricingVersion: priced ? priced.version : null,
        source: event.source,
        ...(event.batchId ? { batchId: event.batchId } : {}),
        ...(priced ? {} : { note: `unpriced model: ${event.modelId}` }),
      };
      await this.repo.save(record);
    } catch (err) {
      this.logger.error(`Cost capture failed for ${event.id}: ${(err as Error).message}`);
    }
  }

  async summarize(query: SummaryQuery): Promise<Summary> {
    const { groupBy, ...filters } = query;
    const records = await this.repo.list(filters);
    const keyOf = (r: CostRecord): string => {
      switch (groupBy) {
        case 'tier':
          return r.serviceTier;
        case 'operation':
          return r.operation;
        case 'model':
          return r.model.alias;
        case 'day':
          return r.benchmark?.day ?? '(none)';
        case 'trader':
          return r.benchmark?.trader ?? '(none)';
        case 'variant':
          return r.benchmark?.variant ?? '(none)';
        case 'date':
          return r.timestamp.slice(0, 10); // request calendar date (UTC)
      }
    };

    const byKey = new Map<string, SummaryGroup>();
    let totalUsd = 0;
    let grossCacheReadDiscountUsd = 0;
    let netCacheBenefitUsd = 0;
    for (const r of records) {
      const usd = r.cost?.total ?? 0;
      totalUsd += usd;
      // Gross read discount vs full input price (factor derived per-model).
      grossCacheReadDiscountUsd += (r.cost?.cacheRead ?? 0) * cacheReadDiscountFactor(r.model.id, r.timestamp);
      // Net = uncached-input-equivalent - actual input-side cost paid (input+read+create).
      if (r.cost) {
        netCacheBenefitUsd += r.cost.uncachedInputEquiv - (r.cost.input + r.cost.cacheRead + r.cost.cacheCreate);
      }
      const key = keyOf(r);
      const g =
        byKey.get(key) ??
        { key, records: 0, usd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
      g.records += 1;
      g.usd += usd;
      g.inputTokens += r.tokens.input;
      g.outputTokens += r.tokens.output;
      g.cacheReadTokens += r.tokens.cacheRead;
      g.cacheCreateTokens += r.tokens.cacheCreate5m + r.tokens.cacheCreate1h;
      byKey.set(key, g);
    }
    const round = (n: number) => Math.round(n * 1e8) / 1e8;
    // For 'date' keep chronological order; otherwise sort by spend descending.
    const groups = [...byKey.values()].map((g) => ({ ...g, usd: round(g.usd) }));
    groups.sort((a, b) => (groupBy === 'date' ? a.key.localeCompare(b.key) : b.usd - a.usd));
    return {
      groupBy,
      totalUsd: round(totalUsd),
      totalRecords: records.length,
      grossCacheReadDiscountUsd: round(grossCacheReadDiscountUsd),
      netCacheBenefitUsd: round(netCacheBenefitUsd),
      groups,
    };
  }

  async list(filters: ListFilters): Promise<CostRecord[]> {
    return this.repo.list(filters);
  }
}
