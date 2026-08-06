import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHash } from 'node:crypto';
import { MOONSHOT_CLIENT, MoonshotClientFactory, DEFAULT_MAX_COMPLETION_TOKENS, numericConfig } from './moonshot.constants';
import { MoonshotEnvelopeBuilder } from './moonshot.envelope';
import { MoonshotBatchStore, EmulatedBatchItem, EmulatedBatchDoc, isUnfinished } from './moonshot.batch-store';
import { MoonshotChatBody, toChatResult, mapEffort, jsonSchemaFormat, createChatWithFallback } from './moonshot.chat';
import { UsageTokens } from '../cost/cost.types';

const MAX_ATTEMPTS = 4;
// D5 item-claim lease. Generous on purpose: one item can burn 4 attempts × up to 2
// API calls each (the strict json_schema → json_object fallback) at high/max effort
// with a 32k-token ceiling, and a lease that lapses mid-flight lets another drainer
// reclaim and re-run the item — paying twice, with the two terminal writes racing
// (last write wins; both results are valid, so no corruption, just waste). The real
// fix is a fencing token issued by claimItem and compared transactionally at the
// terminal write; that is a Task 7 store change and is deliberately deferred.
//
// COUPLED to the @Cron(EVERY_30_MINUTES) tick below — deliberately, not
// coincidentally, the same 30 min. resumeAll() (run by that tick) is the only
// thing that re-kicks a batch whose claim-holder died mid-lease, so a crashed
// claim isn't noticed until BOTH this lease lapses AND the next maintenance
// pass runs; matching the two intervals keeps that detection gap to about one
// lease lifetime instead of stacking on top of it. Changing the tick interval
// without changing this (or vice versa) silently changes the recovery budget:
// maintain()'s docstring below counts on "~6 recovery passes" per batch before
// its 3h expiry (D6) force-terminates it — doubling the tick to 60 min halves
// that to ~3, giving a stuck batch far fewer chances to self-heal before it's
// errored out and re-queued.
const LEASE_MS = 30 * 60 * 1000;
const GC_TTL_DEFAULT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CONCURRENCY = 8;
// The result write happens AFTER a paid API call, so a transient Firestore throw
// must never discard it — a few quick retries before giving up on the item.
const PERSIST_ATTEMPTS = 3;
const PERSIST_BACKOFF_MS = 100;
// Grace period before the `total` invariant is enforced: createBatch writes the
// batch doc first and its item docs after, so a batch observed seconds after
// creation can legitimately have fewer item docs than `total`.
const TOTAL_MISMATCH_GRACE_MS = 60 * 1000;

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
 * any process. One global item is primed first (shared cross-group prefix), then
 * one item per prefix group, before fanning out (D7). A
 * batch past its deadline is force-terminated (D6). content_filter → refusal
 * (permanent), whether it arrives as a thrown 400 or in-band as a 200 with
 * finish_reason 'content_filter'; finish_reason 'length' → errored (truncated
 * output would never parse); 429/5xx/network → retry then errored (transient →
 * reconciler re-queues).
 */
@Injectable()
export class MoonshotBatchWorker implements OnApplicationBootstrap {
  private readonly logger = new Logger(MoonshotBatchWorker.name);
  private readonly active = new Set<string>(); // batchIds draining in THIS process
  private readonly schedulerEnabled: boolean;

  constructor(
    @Inject(MOONSHOT_CLIENT) private readonly clientFactory: MoonshotClientFactory,
    private readonly envelopes: MoonshotEnvelopeBuilder,
    private readonly store: MoonshotBatchStore,
    private readonly config: ConfigService,
  ) {
    this.schedulerEnabled = config.get<boolean>('benchmark.schedulerEnabled') ?? false;
  }

  private get concurrency(): number {
    return this.config.get<number>('moonshot.batchConcurrency') ?? DEFAULT_CONCURRENCY;
  }

  // Gates the SCHEDULED/BOOT entry points only. Two conditions: MoonshotModule is
  // always imported but there is nothing to drain under Anthropic, and the repo's
  // scheduler flag is OFF under jest (so specs never touch Firestore at boot) and
  // per-instance in prod so only a dedicated worker runs crons. kick()/drainBatch()
  // stay UNGATED — the instance that submitted a batch must always drain it.
  private get schedulingEnabled(): boolean {
    return this.schedulerEnabled && (this.config.get<string>('llm.provider') ?? 'anthropic') === 'moonshot';
  }

  // Fire-and-forget kick from submitBatch. Never throws to the caller.
  kick(batchId: string): void {
    void this.drainBatch(batchId).catch((e) => this.logger.error(`drain ${batchId} failed: ${e}`));
  }

  onApplicationBootstrap(): void {
    if (!this.schedulingEnabled) return;
    void this.resumeAll().catch((e) => this.logger.error(`resume failed: ${e}`));
  }

  // Thin scheduled trigger — gated by config so only a dedicated worker runs the
  // cron, and `void` + catch so a rejection never escapes the Nest scheduler. The
  // maintain() core below stays public/ungated for tests + manual runs.
  // COUPLED to LEASE_MS above (see that comment) — keep the two in sync.
  @Cron(CronExpression.EVERY_30_MINUTES)
  scheduledMaintenance(): void {
    if (!this.schedulingEnabled) return;
    void this.maintain().catch((e) => this.logger.error(`scheduled maintenance failed: ${e}`));
  }

  /**
   * Periodic maintenance core. resumeAll() is the ONLY re-drain trigger for a batch
   * that stalled without a live kick — a drainer that crashed, lost its claims to a
   * lease, or raced another drainer such that neither observed the batch fully
   * drained (each read while the other's last item was still 'running', so nobody
   * ended it). Every 30 min gives a batch ~6 recovery passes before its 3h expiry
   * force-terminates it. The two halves are isolated so a failing resume still lets
   * GC run, and vice versa.
   */
  async maintain(): Promise<void> {
    try {
      await this.resumeAll();
    } catch (err) {
      this.logger.error(`resume failed: ${(err as Error).message}`);
    }
    try {
      await this.gc();
    } catch (err) {
      this.logger.error(`gc failed: ${(err as Error).message}`);
    }
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
      const unfinished = await this.store.listUnfinishedItems(batchId);
      // D6: past the deadline with work left → force-terminate now, leaving the
      // items untouched so the reconciler re-queues them. An already-drained
      // expired batch falls through to the completion check below instead: its
      // results are paid for and complete, so it deserves 'ended', not 'errored'.
      if (unfinished.length && new Date().toISOString() > batch.expiresAt) {
        await this.store.setBatchStatus(batchId, 'errored', new Date().toISOString());
        return;
      }
      const groups = this.groupByPrefix(unfinished, batch);
      // The prime→fan-out barriers are INTRA-PROCESS only: a second drainer whose
      // early-phase claims all lost proceeds straight to its fan-out, so siblings
      // can hit the API before the prefix is cached. Cost-only — results are
      // unaffected.
      const heads = groups.map((g) => g[0]);
      // Phase 0: ONE global prime. Distinct groups still share the bulk of their
      // rendered prefix (general docs + day bundle differ only from the persona
      // tier on), and Moonshot caches by byte prefix — so heads run concurrently
      // would each pay a full miss on that shared portion. One item completing
      // first writes it once; the other heads then hit cache for it. When groups
      // share nothing the cost is one item's latency of serialization, not money.
      await this.runPool(heads.slice(0, 1), (item) => this.claimAndRun(batchId, item, batch));
      // Phase 1: prime the remaining group heads (warms each distinct cell prefix).
      await this.runPool(heads.slice(1), (item) => this.claimAndRun(batchId, item, batch));
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
        // …but only once createBatch has had time to finish: a resume that lands
        // mid-create sees a short-but-growing item set, and erroring there would
        // kill a legitimately in-flight batch. Inside the grace window leave the
        // status alone; the next kick/cron pass re-evaluates.
        if (!this.pastTotalGrace(batch)) return;
        this.logger.error(`batch ${batchId} has ${items.length} item docs but total=${batch.total} — marking errored`);
        await this.store.setBatchStatus(batchId, 'errored', new Date().toISOString());
        return;
      }
      await this.store.setBatchStatus(batchId, 'ended', new Date().toISOString());
    } finally {
      this.active.delete(batchId);
    }
  }

  // A missing/unparseable createdAt cannot be inside the grace window — such a doc
  // is malformed, and 'errored' (re-queue) is the right outcome for it anyway.
  private pastTotalGrace(batch: EmulatedBatchDoc): boolean {
    const createdMs = Date.parse(batch.createdAt ?? '');
    return !Number.isFinite(createdMs) || Date.now() - createdMs > TOTAL_MISMATCH_GRACE_MS;
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
    try {
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
    } catch (err) {
      // Named context (which batch, which item) that runPool's generic catch
      // below can't provide. warn, not error: a claim/store hiccup here
      // self-heals — the item stays unclaimed (or its lease eventually lapses)
      // and the next kick/resume picks it up — rather than losing a paid unit
      // of work, matching batch-reconciler.ts's per-item isolation log level.
      // Rethrown so runPool's per-item isolation still applies unchanged.
      this.logger.warn(`batch ${batchId} item ${item.customId}: ${(err as Error).message}`);
      throw err;
    }
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
          this.logger.error(`persisting ${batchId}/${customId} failed after ${PERSIST_ATTEMPTS} attempts: ${(err as Error).message}`);
          return;
        }
        await this.sleep(PERSIST_BACKOFF_MS * attempt);
      }
    }
  }

  // One item = one sync chat call (with the strict→json_object fallback).
  private async runOne(item: EmulatedBatchItem, batch: EmulatedBatchDoc): Promise<RunOutcome> {
    let body: MoonshotChatBody;
    try {
      const built = await this.envelopes.buildRequest(item.envelope ?? batch.batchEnvelope, item.prompt);
      body = {
        model: batch.model,
        messages: built.messages,
        // submitBatch resolves maxTokens (caller → moonshot.maxTokens config) into the
        // batch doc, so this fallback only covers a doc written before that resolution
        // existed — kept rather than dropped so an old in-flight doc still drains.
        max_completion_tokens: batch.opts.maxTokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
        reasoning_effort: mapEffort(batch.opts.effort),
        // Optional field: an envelope with no stable prefix has nothing to key a
        // shared cache on, so omit it rather than send a meaningless key.
        ...(built.promptCacheKey ? { prompt_cache_key: built.promptCacheKey } : {}),
        ...(batch.opts.schema ? { response_format: jsonSchemaFormat(batch.opts.schema) } : {}),
      };
    } catch (err) {
      // Rendering can fail permanently for ONE item (e.g. an envelope block whose
      // extracted text is gone). Record it as that item's failure instead of
      // rejecting — an escaping throw would wedge the drain for every sibling.
      return { status: 'errored', error: `request build failed: ${(err as Error).message}` };
    }
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const resp = await createChatWithFallback(this.clientFactory.get(), body);
        const r = toChatResult(resp);
        // MIRRORS moonshot.service.ts toItemResult (the native-batch path) — keep the
        // two in sync. A 200 is not automatically a result: Moonshot delivers a
        // refusal as 200 + finish_reason 'content_filter' (empty content) and a
        // truncation as 200 + 'length'. This is the ONLY path that serves kimi-k3
        // batches, so calling either 'succeeded' hands the reconciler unparseable
        // text → a permanent write-once INVALID cell that no top-up can re-run.
        // A refusal is billed and IS a real result to the reconciler (NO_SETUP), so
        // it keeps usage — the emulated results mapper passes usage/cacheReadTokens
        // straight through, exactly like the native path's row usage.
        if (r.finishReason === 'content_filter') return { status: 'refusal', usage: r.usage, cacheReadTokens: r.usage.cacheRead };
        // Truncation is 'errored' so the cell stays MISSING and retryable. That
        // forfeits this item's usage emit (the reconciler skips non-result items) —
        // the same trade the native path makes, and far cheaper than baking a
        // truncated setup into the benchmark permanently.
        if (r.finishReason === 'length') return { status: 'errored', error: 'output truncated (finish_reason=length)' };
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
    // A misconfigured MOONSHOT_BATCH_CONCURRENCY ('' / 'abc' → parseInt NaN) must not
    // silently stall the drain: Array.from({length: NaN}) builds ZERO runners, so
    // every item would be skipped with no error at all. numericConfig's default
    // min of 1 rejects anything below one runner; floor keeps a fractional value usable.
    const limit = Math.floor(numericConfig(this.concurrency, DEFAULT_CONCURRENCY));
    let cursor = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const item = items[cursor++];
        try {
          await fn(item);
        } catch (err) {
          // Per-item isolation: one poisoned item (a rejected claim, an unexpected
          // store throw) must not abort its runner and strand every item behind it.
          // debug, not warn: on every path that exists today, `fn` is claimAndRun,
          // which already logs this exact failure at warn WITH batch/item identity
          // before rethrowing — logging it again here at the same level would just
          // duplicate that line with less context. This stays as a backstop for a
          // future `fn` that doesn't self-log, so it's never silent, just quieter
          // than the identified log it currently shadows.
          this.logger.debug(`batch item task failed: ${(err as Error).message}`);
        }
      }
    });
    await Promise.all(runners);
  }

  // Ungated GC core (the scheduled trigger above owns the gating): drop terminal
  // batches whose results are older than the TTL.
  async gc(): Promise<void> {
    const cutoff = new Date(Date.now() - this.gcTtlMs()).toISOString();
    const stale = await this.store.listTerminalBatchesOlderThan(cutoff);
    let removed = 0;
    for (const id of stale) {
      try {
        await this.store.deleteBatch(id);
        removed++;
      } catch (err) {
        // Per-id isolation: a partially deleted batch is retried next pass (it stays
        // terminal and older than the cutoff), and one failure never skips the rest.
        this.logger.error(`GC of batch ${id} failed: ${(err as Error).message}`);
      }
    }
    if (removed) this.logger.log(`GC removed ${removed} terminal emulated batches`);
  }

  // Guarded because a blank/garbage MOONSHOT_BATCH_GC_TTL_MS reaches config as
  // parseInt('') === NaN, and new Date(Date.now() - NaN).toISOString() throws
  // RangeError — which would otherwise break every GC pass, forever. min 0 because
  // a TTL of 0 is a legitimate setting: collect as soon as a batch is terminal.
  private gcTtlMs(): number {
    return numericConfig(this.config.get<number>('moonshot.batchGcTtlMs'), GC_TTL_DEFAULT_MS, 0);
  }
}
