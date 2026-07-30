import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHash } from 'node:crypto';
import { MOONSHOT_CLIENT, MoonshotClientFactory } from './moonshot.constants';
import { MoonshotEnvelopeBuilder } from './moonshot.envelope';
import { MoonshotBatchStore, EmulatedBatchItem, EmulatedBatchDoc } from './moonshot.batch-store';
import { MoonshotChatBody, toChatResult, mapEffort, jsonSchemaFormat, createChatWithFallback } from './moonshot.chat';
import { UsageTokens } from '../cost/cost.types';

const MAX_ATTEMPTS = 4;
const LEASE_MS = 10 * 60 * 1000; // D5: item-claim lease
const GC_TTL_DEFAULT_MS = 24 * 60 * 60 * 1000;
// The result write happens AFTER a paid API call, so a transient Firestore throw
// must never discard it — a few quick retries before giving up on the item.
const PERSIST_ATTEMPTS = 3;
const PERSIST_BACKOFF_MS = 100;

interface RunOutcome {
  status: 'succeeded' | 'refusal' | 'errored';
  text?: string;
  error?: string;
  usage?: UsageTokens;
  cacheReadTokens?: number;
}

/**
 * Drains kimi-k3 emulated batches. Each item is a synchronous chat call, claimed
 * transactionally (D5) so concurrent kick()/bootstrap-resume across processes never
 * double-run an item; results persist durably so getBatch/getBatchResults work from
 * any process. Items are primed one-per-prefix-group before fanning out (D7). A
 * batch past its deadline is force-terminated (D6). content_filter → refusal
 * (permanent); 429/5xx/network → retry then errored (transient → reconciler re-queues).
 */
@Injectable()
export class MoonshotBatchWorker implements OnApplicationBootstrap {
  private readonly logger = new Logger(MoonshotBatchWorker.name);
  private readonly active = new Set<string>(); // batchIds draining in THIS process

  constructor(
    @Inject(MOONSHOT_CLIENT) private readonly clientFactory: MoonshotClientFactory,
    private readonly envelopes: MoonshotEnvelopeBuilder,
    private readonly store: MoonshotBatchStore,
    private readonly config: ConfigService,
  ) {}

  private get concurrency(): number {
    return this.config.get<number>('moonshot.batchConcurrency') ?? 8;
  }

  private get isMoonshotProvider(): boolean {
    return (this.config.get<string>('llm.provider') ?? 'anthropic') === 'moonshot';
  }

  // Fire-and-forget kick from submitBatch. Never throws to the caller.
  kick(batchId: string): void {
    void this.drainBatch(batchId).catch((e) => this.logger.error(`drain ${batchId} failed: ${e}`));
  }

  onApplicationBootstrap(): void {
    // MoonshotModule is always imported, but only resume/query Firestore when
    // Moonshot is the active provider — under Anthropic there is nothing to drain.
    if (!this.isMoonshotProvider) return;
    void this.resumeAll().catch((e) => this.logger.error(`resume failed: ${e}`));
  }

  async resumeAll(): Promise<void> {
    const batches = await this.store.listInProgressBatches();
    for (const b of batches) this.kick(b.batchId);
  }

  // Drain one emulated batch: expire if past deadline (D6), else claim+run each
  // unfinished item, priming one call per prefix group (D7) before fanning out.
  async drainBatch(batchId: string): Promise<void> {
    if (this.active.has(batchId)) return;
    this.active.add(batchId);
    try {
      const batch = await this.store.getBatch(batchId);
      if (!batch || batch.status !== 'in_progress') return;
      const unfinished = (await this.store.listItems(batchId)).filter(isUnfinished);
      // D6: past the deadline with work left → force-terminate now, leaving the
      // items untouched so the reconciler re-queues them. An already-drained
      // expired batch falls through to the completion check below instead: its
      // results are paid for and complete, so it deserves 'ended', not 'errored'.
      if (unfinished.length && new Date().toISOString() > batch.expiresAt) {
        await this.store.setBatchStatus(batchId, 'errored', new Date().toISOString());
        return;
      }
      const groups = this.groupByPrefix(unfinished, batch);
      // Phase 1: prime one item per group (warms each distinct cell prefix).
      await this.runPool(groups.map((g) => g[0]), (item) => this.claimAndRun(batchId, item, batch));
      // Phase 2: fan out the remaining items of every group (siblings hit cache).
      await this.runPool(groups.flatMap((g) => g.slice(1)), (item) => this.claimAndRun(batchId, item, batch));
      const items = await this.store.listItems(batchId);
      if (items.some(isUnfinished)) {
        if (new Date().toISOString() > batch.expiresAt) await this.store.setBatchStatus(batchId, 'errored', new Date().toISOString());
        return;
      }
      // Every item is terminal — but createBatch's batch-doc + item-doc writes are
      // not atomic, so a torn create leaves FEWER item docs than `total`. Ending
      // such a batch would hand the reconciler a silently short result set; mark it
      // errored instead so the whole batch is re-queued (Task 7's stated contract).
      if (items.length !== batch.total) {
        this.logger.error(`batch ${batchId} has ${items.length} item docs but total=${batch.total} — marking errored`);
        await this.store.setBatchStatus(batchId, 'errored', new Date().toISOString());
        return;
      }
      await this.store.setBatchStatus(batchId, 'ended', new Date().toISOString());
    } finally {
      this.active.delete(batchId);
    }
  }

  // D7: group by envelope hash, which approximates the prompt_cache_key partition
  // (that key hashes the RENDERED prefix; this hashes the envelope JSON, so two
  // distinct envelopes that render identically prime twice — harmless over-priming).
  // Each group's head is primed before its siblings fan out, so each distinct cell
  // prefix is written to Moonshot's implicit cache exactly once.
  private groupByPrefix(items: EmulatedBatchItem[], batch: EmulatedBatchDoc): EmulatedBatchItem[][] {
    const groups = new Map<string, EmulatedBatchItem[]>();
    for (const item of items) {
      const key = createHash('sha256').update(JSON.stringify(item.envelope ?? batch.batchEnvelope ?? null)).digest('hex');
      const g = groups.get(key);
      if (g) g.push(item); else groups.set(key, [item]);
    }
    return [...groups.values()];
  }

  // Claim (D5) then run one item. A lost claim (another process/tick owns it) is a no-op.
  // INVARIANT: claimItem is the ONLY writer of status 'running' — the store's
  // reclaim-a-stale-lease path fails open on a missing leaseUntil, which is only
  // safe while every 'running' item got there through a lease-granting claim.
  private async claimAndRun(batchId: string, item: EmulatedBatchItem, batch: EmulatedBatchDoc): Promise<void> {
    const claimed = await this.store.claimItem(batchId, item.customId, LEASE_MS);
    if (!claimed) return;
    const outcome = await this.runOne(item, batch);
    await this.persistOutcome(batchId, item.customId, {
      status: outcome.status,
      ...(outcome.text !== undefined ? { text: outcome.text } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
      ...(outcome.cacheReadTokens !== undefined ? { cacheReadTokens: outcome.cacheReadTokens } : {}),
    });
  }

  // Persist a terminal item result. This is a non-idempotent write that lands AFTER
  // a paid API call, so a transient Firestore error gets a few retries rather than
  // throwing the paid result away — and it never propagates, because rejecting here
  // would abort the whole drain pool over one item. A permanently failed write
  // leaves the item 'running' until its lease expires, then a later kick/resume
  // reclaims it (re-paying for that one item, which is the cheapest safe outcome).
  private async persistOutcome(batchId: string, customId: string, patch: Partial<EmulatedBatchItem>): Promise<void> {
    for (let attempt = 1; attempt <= PERSIST_ATTEMPTS; attempt++) {
      try {
        await this.store.updateItem(batchId, customId, patch);
        return;
      } catch (err) {
        if (attempt === PERSIST_ATTEMPTS) {
          this.logger.error(`persisting ${batchId}/${customId} failed after ${PERSIST_ATTEMPTS} attempts: ${err}`);
          return;
        }
        await this.sleep(PERSIST_BACKOFF_MS * attempt);
      }
    }
  }

  // One item = one sync chat call (with the strict→json_object fallback).
  async runOne(item: EmulatedBatchItem, batch: EmulatedBatchDoc): Promise<RunOutcome> {
    const built = await this.envelopes.buildRequest(item.envelope ?? batch.batchEnvelope, item.prompt);
    const body: MoonshotChatBody = {
      model: batch.model,
      messages: built.messages,
      max_completion_tokens: batch.opts.maxTokens ?? 32000,
      reasoning_effort: mapEffort(batch.opts.effort),
      // Omit the key entirely when the envelope has no stable prefix to cache on —
      // sending `undefined` would be rejected by Firestore-bound bodies and means
      // nothing to the API.
      ...(built.promptCacheKey ? { prompt_cache_key: built.promptCacheKey } : {}),
      ...(batch.opts.schema ? { response_format: jsonSchemaFormat(batch.opts.schema) } : {}),
    };
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const resp = await createChatWithFallback(this.clientFactory.get(), body);
        const r = toChatResult(resp);
        return { status: 'succeeded', text: r.text, usage: r.usage, cacheReadTokens: r.usage.cacheRead };
      } catch (err) {
        const status = (err as { status?: number }).status;
        const type = (err as any)?.error?.type ?? (err as any)?.code;
        if (status === 400 && type === 'content_filter') return { status: 'refusal' }; // permanent — recorded, not retried
        lastErr = err;
        if (attempt === MAX_ATTEMPTS || !this.isTransient(status)) break;
        await this.sleep(250 * 2 ** (attempt - 1));
      }
    }
    return { status: 'errored', error: (lastErr as Error)?.message ?? 'unknown error' };
  }

  private isTransient(status?: number): boolean {
    return status === undefined || status === 429 || (status >= 500 && status < 600);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  // Bounded-concurrency pool. Phase ordering (prime vs fan-out) is decided by the
  // caller (drainBatch); this just runs `items` at most `concurrency` at a time.
  private async runPool<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
    if (!items.length) return;
    let cursor = 0;
    const limit = Math.max(1, this.concurrency);
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) await fn(items[cursor++]);
    });
    await Promise.all(runners);
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async gc(): Promise<void> {
    if (!this.isMoonshotProvider) return;
    const ttl = this.config.get<number>('moonshot.batchGcTtlMs') ?? GC_TTL_DEFAULT_MS;
    const cutoff = new Date(Date.now() - ttl).toISOString();
    const stale = await this.store.listTerminalBatchesOlderThan(cutoff);
    for (const id of stale) await this.store.deleteBatch(id);
    if (stale.length) this.logger.log(`GC removed ${stale.length} terminal emulated batches`);
  }
}

function isUnfinished(item: EmulatedBatchItem): boolean {
  return item.status === 'pending' || item.status === 'running';
}
