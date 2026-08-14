import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID, createHash } from 'node:crypto';
import type OpenAI from 'openai';
import { toFile } from 'openai';
import { Attribution, UsageEvent } from '../cost/cost.types';
import { LlmProvider, LlmCapabilities } from '../llm/llm.provider';
import {
  StructuredRequest,
  BatchItemRequest,
  BatchSubmitOptions,
  BatchHandle,
  BatchItemResult,
  BatchLifecycle,
  PromptEnvelope,
} from '../llm/llm.types';
import {
  MOONSHOT_CLIENT,
  MoonshotClientFactory,
  MOONSHOT_EXTRACT_ID_PREFIX,
  DEFAULT_MAX_COMPLETION_TOKENS,
  isBatchable,
  numericConfig,
} from './moonshot.constants';
import { MoonshotEnvelopeBuilder } from './moonshot.envelope';
import { MoonshotExtractStore } from './moonshot.extract-store';
import { MoonshotBatchStore } from './moonshot.batch-store';
import { MoonshotBatchWorker } from './moonshot.batch-worker';
import { MoonshotChatBody, toChatResult, effortParams, jsonSchemaFormat, createChatWithFallback, createJsonObjectFallback } from './moonshot.chat';

/** True when `text` is parseable JSON — the cheap half of the degenerate-output check. */
function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
import { tokensFromUsage } from './moonshot.usage';

// D6: emulated batches expire this long after creation (mirrors configuration.ts).
const DEFAULT_BATCH_MAX_AGE_MS = 10_800_000; // 3h
/** Synthetic batch-id prefix for client-side emulated batches; nothing else parses it. */
const EMULATED_BATCH_ID_PREFIX = 'msb_';

/** One row of a native batch output/error JSONL file. */
interface NativeResultRow {
  custom_id: string;
  response?: { status_code?: number; body?: any };
  error?: { type?: string; message?: string } | null;
}

@Injectable()
export class MoonshotLlmProvider implements LlmProvider {
  readonly capabilities: LlmCapabilities = {
    batch: true,
    fileUpload: true,
    promptCaching: true,
    structuredOutput: true,
  };
  private readonly logger = new Logger(MoonshotLlmProvider.name);

  constructor(
    @Inject(MOONSHOT_CLIENT) private readonly clientFactory: MoonshotClientFactory,
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
    private readonly envelopes: MoonshotEnvelopeBuilder,
    private readonly extracts: MoonshotExtractStore,
    private readonly batchStore: MoonshotBatchStore,
    private readonly worker: MoonshotBatchWorker,
  ) {}

  private get defaultModel(): string {
    return this.config.get<string>('moonshot.model') ?? 'kimi-k3';
  }

  /** Output ceiling applied when the caller passes no explicit maxTokens. */
  private get defaultMaxTokens(): number {
    return numericConfig(this.config.get<number>('moonshot.maxTokens'), DEFAULT_MAX_COMPLETION_TOKENS);
  }

  async messageStructured<T = unknown>(req: StructuredRequest, attribution: Attribution): Promise<T> {
    const model = req.model ?? this.defaultModel;
    try {
      // Inside the try for the same reason as uploadFile's store read: buildRequest
      // can throw (an unresolvable file-block id). Behaviorally a no-op today —
      // that throw is a plain Error and rethrow passes it through unchanged — but
      // it keeps every failure on this path funnelled through one mapping point.
      const built = await this.envelopes.buildRequest(req.envelope, req.prompt, req.system);
      const body: MoonshotChatBody = {
        model,
        messages: built.messages,
        max_completion_tokens: req.maxTokens ?? this.defaultMaxTokens,
        ...effortParams(req.effort),
        // Spread conditionally: promptCacheKey is `string | undefined` (undefined when
        // the envelope has no stable prefix), and an explicit `prompt_cache_key:
        // undefined` key would still be an own property on the request body.
        ...(built.promptCacheKey ? { prompt_cache_key: built.promptCacheKey } : {}),
        ...(req.schema ? { response_format: jsonSchemaFormat(req.schema) } : {}),
      };
      // A schema Moonshot permanently rejects costs ONE wasted 400 per process,
      // not per request: createChatWithFallback latches the (model, schema-hash)
      // pair on first rejection and skips straight to json_object afterwards.
      const resp = await createChatWithFallback(this.clientFactory.get(), body);
      let r = toChatResult(resp);
      // Capture usage BEFORE any refusal/parse throw — a refusal is still billed.
      this.emitUsage(r.rawUsage, (resp as any).model ?? model, attribution);
      // A degenerate strict-schema response (kimi constrained decoding can loop
      // whitespace before the final enum until finish_reason=length — see
      // effortParams) gets ONE retry through the schema-instructed json_object
      // fallback before the failure maps below. The retry is billed too.
      const degenerate = () => r.finishReason === 'length' || !parses(r.text);
      if (req.schema && r.finishReason !== 'content_filter' && degenerate()) {
        const retryResp = await createJsonObjectFallback(this.clientFactory.get(), body);
        r = toChatResult(retryResp);
        this.emitUsage(r.rawUsage, (retryResp as any).model ?? model, attribution);
      }
      // A refusal can arrive as a 200 with finish_reason 'content_filter' and empty
      // content, not only as a thrown 400 (see rethrow) — map both to the same 422
      // so a refusal never masquerades as a malformed-JSON 502.
      if (r.finishReason === 'content_filter') {
        throw new HttpException(
          { statusCode: 422, error: 'Structured message refused (content_filter)' },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      if (r.finishReason === 'length') {
        throw new HttpException({ statusCode: 502, error: 'Structured output truncated (finish_reason=length)' }, HttpStatus.BAD_GATEWAY);
      }
      try {
        return JSON.parse(r.text) as T;
      } catch {
        throw new HttpException({ statusCode: 502, error: 'Structured output was not valid JSON' }, HttpStatus.BAD_GATEWAY);
      }
    } catch (err) {
      this.rethrow(err);
    }
  }

  /**
   * Upload → extract text → cache durably by content hash → delete the remote file
   * (respects the 1,000-file cap) → return a synthetic id resolving to that text.
   * Idempotent: an identical byte payload short-circuits on the content hash.
   */
  async uploadFile(bytes: Buffer, filename: string, mediaType: string): Promise<string> {
    const hash = createHash('sha256').update(bytes).digest('hex');
    const client = this.clientFactory.get();
    try {
      // Inside the try on purpose: getByHash can throw (a torn chunked doc), and
      // that must flow through the same rethrow mapping as the upload path rather
      // than escaping unmapped.
      const cached = await this.extracts.getByHash(hash);
      if (cached != null) return `${MOONSHOT_EXTRACT_ID_PREFIX}${hash}`;
      const file = await toFile(bytes, filename, { type: mediaType });
      const uploaded = await client.files.create({ file, purpose: 'file-extract' as any });
      // Everything after a successful create runs under a `finally` that always
      // attempts the delete: this is the ONLY caller of files.del in the codebase,
      // and Moonshot caps an account at 1,000 files, so a content-read or
      // extract-store failure sequenced BEFORE the delete would leak the remote
      // file permanently. Losing the remote copy on a failed attempt costs
      // nothing — a retry re-uploads. `return` still evaluates after `put`
      // resolves, so the success path keeps its put-before-return ordering.
      try {
        const text = await (await client.files.content(uploaded.id)).text();
        await this.extracts.put(hash, text, { filename, mediaType });
        return `${MOONSHOT_EXTRACT_ID_PREFIX}${hash}`;
      } finally {
        // "uploaded", not "extracted": this finally also runs when the content read
        // itself failed, in which case nothing was ever extracted.
        await this.deleteFileQuietly(client, uploaded.id, 'uploaded but not deleted');
      }
    } catch (err) {
      this.rethrow(err);
    }
  }

  // ---- batch methods ----
  // Hybrid: a batchable model goes to Moonshot's native OpenAI-compatible Batch
  // API; kimi-k3 (not batchable upstream) goes to durable client-side emulation.
  // Which path a batch took is encoded in the id it returns — only emulated ids
  // carry the msb_ prefix — so getBatch/getBatchResults route on the id alone and
  // callers (the reconciler) never have to remember the model.
  async submitBatch(
    requests: BatchItemRequest[],
    envelope: PromptEnvelope | undefined,
    opts: BatchSubmitOptions,
  ): Promise<BatchHandle> {
    // Both guards fail here rather than downstream, where the symptoms are opaque:
    // an empty request list uploads a 0-byte JSONL file (upstream 400 with no
    // context) or creates an emulated batch that is instantly "ended" with no
    // results; a duplicate customId collapses two item docs into one while `total`
    // still counts both, so the worker's total-mismatch check errors the WHOLE batch
    // with a log that never names the real cause. Native results are matched by
    // custom_id too, so duplicates are wrong on that path as well.
    if (!requests.length) {
      throw new HttpException({ statusCode: 400, error: 'submitBatch called with no requests' }, HttpStatus.BAD_REQUEST);
    }
    const customIds = requests.map((r, i) => r.customId ?? `request-${i}`);
    const duplicate = customIds.find((id, i) => customIds.indexOf(id) !== i);
    if (duplicate !== undefined) {
      throw new HttpException({ statusCode: 400, error: `Duplicate batch customId "${duplicate}"` }, HttpStatus.BAD_REQUEST);
    }
    const model = opts.model ?? this.defaultModel;
    return isBatchable(model)
      ? this.submitNativeBatch(requests, envelope, opts, model)
      : this.submitEmulatedBatch(requests, envelope, opts, model);
  }

  // kimi-k3: durable emulation. Persist batch + item docs, kick the worker, return
  // immediately. The reconciler polls getBatch/getBatchResults across ticks.
  private async submitEmulatedBatch(
    requests: BatchItemRequest[],
    envelope: PromptEnvelope | undefined,
    opts: BatchSubmitOptions,
    model: string,
  ): Promise<BatchHandle> {
    const batchId = `${EMULATED_BATCH_ID_PREFIX}${randomUUID()}`;
    const nowMs = Date.now();
    const maxAge = numericConfig(this.config.get<number>('moonshot.batchMaxAgeMs'), DEFAULT_BATCH_MAX_AGE_MS);
    const items = requests.map((r, i) => ({
      customId: r.customId ?? `request-${i}`,
      prompt: r.prompt,
      ...(r.envelope ? { envelope: r.envelope } : {}),
      status: 'pending' as const,
      attempts: 0,
    }));
    await this.batchStore.createBatch(
      {
        batchId,
        model,
        // maxTokens is resolved HERE, not in the worker, so the drain uses the
        // ceiling configured on the submitting instance. `schema`/`effort` may be
        // undefined; the store's createBatch strips undefined fields before the
        // Firestore write (which rejects them), so this doesn't strip its own.
        opts: { schema: opts.schema, maxTokens: opts.maxTokens ?? this.defaultMaxTokens, effort: opts.effort },
        ...(envelope ? { batchEnvelope: envelope } : {}),
        status: 'in_progress',
        total: items.length,
        createdAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + maxAge).toISOString(), // D6
      },
      items,
    );
    this.worker.kick(batchId);
    return { batchId, status: 'submitted' };
  }

  // batchable models: native OpenAI-compatible Batch API.
  private async submitNativeBatch(
    requests: BatchItemRequest[],
    envelope: PromptEnvelope | undefined,
    opts: BatchSubmitOptions,
    model: string,
  ): Promise<BatchHandle> {
    const client = this.clientFactory.get();
    const window = this.config.get<string>('moonshot.completionWindow') ?? '1d';
    try {
      const lines: string[] = [];
      for (let i = 0; i < requests.length; i++) {
        const r = requests[i];
        const built = await this.envelopes.buildRequest(r.envelope ?? envelope, r.prompt);
        // NOTE: no temperature/top_p — Moonshot fixes them and rejects batches that set them.
        const body: MoonshotChatBody = {
          model,
          messages: built.messages,
          max_completion_tokens: opts.maxTokens ?? this.defaultMaxTokens,
          ...effortParams(opts.effort),
          // Spread conditionally for parity with the sync path: promptCacheKey is
          // undefined when the envelope has no stable prefix, and an explicit
          // `prompt_cache_key: undefined` would be an own property of the body.
          ...(built.promptCacheKey ? { prompt_cache_key: built.promptCacheKey } : {}),
          ...(opts.schema ? { response_format: jsonSchemaFormat(opts.schema) } : {}),
        };
        // Same opt-in dump as the sync/emulated paths (see moonshot.chat.ts's
        // logPayloadIfDebug) — native batch never calls createChatWithFallback, so
        // it needs its own guard right where each item's body is assembled.
        if (process.env.MOONSHOT_DEBUG_PAYLOAD === 'true') {
          this.logger.log(`Moonshot batch item ${r.customId ?? `request-${i}`} payload:\n${JSON.stringify(body, null, 2)}`);
        }
        lines.push(JSON.stringify({ custom_id: r.customId ?? `request-${i}`, method: 'POST', url: '/v1/chat/completions', body }));
      }
      const payload = Buffer.from(lines.join('\n'), 'utf8');
      const file = await toFile(payload, 'batch.jsonl', { type: 'application/jsonl' });
      const input = await client.files.create({ file, purpose: 'batch' });
      // Logged because a batch input file has a hard 100MB upstream cap and a
      // benchmark batch grows with every cell — this is the only place the payload
      // size is knowable before Moonshot rejects it.
      this.logger.log(`Moonshot batch input ${input.id}: ${requests.length} requests, ${payload.byteLength} bytes`);
      try {
        const batch = await client.batches.create({
          input_file_id: input.id,
          endpoint: '/v1/chat/completions',
          // The SDK types completion_window as the literal '24h' (OpenAI's only
          // value); Moonshot takes its own windows ('1d' by default). Cast just this
          // field so input_file_id/endpoint stay type-checked.
          completion_window: window as '24h',
        });
        return { batchId: batch.id, status: this.toLifecycle(batch.status) };
      } catch (createErr) {
        // An input file with no batch referencing it is pure leak against Moonshot's
        // 1,000-file account cap, and nothing else would ever collect it. Best
        // effort, and never in place of the real error: rethrow what the caller needs.
        await this.deleteFileQuietly(client, input.id, 'orphaned after batches.create failed');
        throw createErr;
      }
    } catch (err) {
      this.rethrow(err);
    }
  }

  async getBatch(batchId: string): Promise<BatchHandle> {
    if (batchId.startsWith(EMULATED_BATCH_ID_PREFIX)) {
      const doc = await this.batchStore.getBatch(batchId);
      if (!doc) throw new HttpException({ statusCode: 404, error: `Unknown batch ${batchId}` }, HttpStatus.NOT_FOUND);
      const status = doc.status === 'ended' ? 'ended' : doc.status === 'errored' ? 'errored' : 'in_progress';
      // More than a status read: two concurrent drainers can each observe the
      // OTHER's last item still 'running' and both return without marking the
      // batch 'ended', leaving it in_progress with nothing scheduled to finish
      // it. The reconciler polls getBatch every minute, so kicking here converges
      // such a stranded batch within a minute instead of letting the 3h expiry
      // (D6) discard results that were already paid for. kick() is
      // fire-and-forget and drainBatch() no-ops on a batch already active in this
      // process or no longer in_progress, so the extra call is cheap.
      if (status === 'in_progress') this.worker.kick(batchId);
      return { batchId, status };
    }
    try {
      const batch = await this.clientFactory.get().batches.retrieve(batchId);
      return { batchId: batch.id, status: this.toLifecycle(batch.status), requestCounts: batch.request_counts };
    } catch (err) {
      this.rethrow(err);
    }
  }

  async getBatchResults(batchId: string): Promise<BatchItemResult[]> {
    return batchId.startsWith(EMULATED_BATCH_ID_PREFIX)
      ? this.emulatedResults(batchId)
      : this.nativeResults(batchId);
  }

  private async emulatedResults(batchId: string): Promise<BatchItemResult[]> {
    const items = await this.batchStore.listItems(batchId);
    return items
      .filter((i) => i.status !== 'pending' && i.status !== 'running') // terminal items only
      .map((i) => ({
        customId: i.customId,
        type: i.status,
        ...(i.text !== undefined ? { text: i.text } : {}),
        ...(i.error !== undefined ? { error: i.error } : {}),
        ...(i.usage !== undefined ? { usage: i.usage } : {}),
        ...(i.cacheReadTokens !== undefined ? { cacheReadTokens: i.cacheReadTokens } : {}),
      }));
  }

  private async nativeResults(batchId: string): Promise<BatchItemResult[]> {
    const client = this.clientFactory.get();
    try {
      const batch = await client.batches.retrieve(batchId);
      const items: BatchItemResult[] = [];
      if (batch.output_file_id) {
        const text = await (await client.files.content(batch.output_file_id)).text();
        for (const row of this.parseJsonlRows(text, `batch ${batchId} output file`)) {
          items.push(this.toItemResult(row));
        }
      }
      if (batch.error_file_id) {
        const text = await (await client.files.content(batch.error_file_id)).text();
        for (const row of this.parseJsonlRows(text, `batch ${batchId} error file`)) {
          items.push({ customId: row.custom_id, type: 'errored', error: JSON.stringify(row.error ?? row) });
        }
      }
      // The input file has done its job once a TERMINAL batch's results are read,
      // and nothing else in this codebase deletes batch files (1,000-file cap).
      // Output/error files are left to Moonshot's own retention — and inputs of
      // batches nobody ever reconciles (the cache warmer's, a crashed run's) still
      // leak, so a sweeping GC over stale batch files is a ledgered follow-up.
      const lifecycle = this.toLifecycle(batch.status);
      if (batch.input_file_id && lifecycle !== 'in_progress' && lifecycle !== 'submitted') {
        await this.deleteFileQuietly(client, batch.input_file_id, `left behind by terminal batch ${batchId}`);
      }
      return items;
    } catch (err) {
      this.rethrow(err);
    }
  }

  /**
   * One output-file row → one item result. Ordering is deliberate: an in-band
   * `error` is checked BEFORE the 200 arm, because a row can carry both a 200
   * `status_code` and an error object, and testing the status first would record
   * that row as a success with empty text.
   */
  private toItemResult(row: NativeResultRow): BatchItemResult {
    const customId = row.custom_id;
    const status = row.response?.status_code;
    const body = row.response?.body;
    const error = row.error ?? body?.error;
    // Computed above the error branch on purpose: a row that reports an error can
    // still report usage, and a content_filter refusal IS billed — dropping its usage
    // there would have the reconciler emit zeros for an item we paid for. Only what
    // the row actually reported is attached; the reconciler substitutes zeros when
    // usage is absent.
    const usage = body?.usage
      ? { usage: tokensFromUsage(body.usage), cacheReadTokens: body.usage.cached_tokens ?? 0 }
      : {};
    if (error) {
      return error.type === 'content_filter'
        ? { customId, type: 'refusal', ...usage }
        : { customId, type: 'errored', error: JSON.stringify(error) };
    }
    // `status 200 with no response body` would otherwise read as a nonsense error.
    if (status !== 200 || !body) return { customId, type: 'errored', error: `status ${status}${body ? '' : ' with no response body'}` };
    // A 200 is not automatically a result. Batch rows carry the SAME in-band
    // failures messageStructured maps on the sync path: finish_reason
    // 'content_filter' (refused, empty content) or 'length' (truncated, so the JSON
    // never parses). Calling either 'succeeded' makes the reconciler write a
    // permanent INVALID cell — cells are write-once, so no top-up re-runs that slot.
    const r = toChatResult(body);
    // A refusal is billed and IS a real result to the reconciler, so it keeps usage.
    if (r.finishReason === 'content_filter') return { customId, type: 'refusal', ...usage };
    // Truncation is 'errored' so the cell stays retryable. That forfeits this item's
    // usage emit (the reconciler skips non-result items) — the same gap every errored
    // item has, and far cheaper than baking a truncated setup into the benchmark
    // permanently.
    if (r.finishReason === 'length') return { customId, type: 'errored', error: 'output truncated (finish_reason=length)' };
    return { customId, type: 'succeeded', text: r.text, ...usage };
  }

  /**
   * Delete a remote file, swallowing failure. Moonshot caps an account at 1,000
   * files so every file this provider creates must be collected, but a failed
   * delete must never fail the operation that triggered it.
   */
  private async deleteFileQuietly(client: OpenAI, fileId: string, context: string): Promise<void> {
    try {
      await client.files.del(fileId);
    } catch (err) {
      this.logger.warn(`Moonshot file ${fileId} ${context}: ${(err as Error)?.message}`);
    }
  }

  // Parse a results JSONL blob line by line, DROPPING (with a log) any line that
  // won't parse rather than rejecting the whole read: one truncated line would
  // otherwise throw away every sibling result in the file, all of them paid for.
  // A dropped line is preferable to a synthetic `{customId: 'unknown'}` row too —
  // results are matched by custom_id, so a placeholder matches no cell in the
  // reconciler's map and only produces noise, whereas an absent item leaves that
  // run-index MISSING, which is exactly what makes the next top-up re-submit it.
  private parseJsonlRows(text: string, source: string): NativeResultRow[] {
    const rows: NativeResultRow[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch (err) {
        this.logger.error(`Skipping unparseable line in ${source}: ${(err as Error)?.message}`);
      }
    }
    return rows;
  }

  // Map Moonshot native batch status → neutral lifecycle.
  private toLifecycle(status: string): BatchLifecycle {
    switch (status) {
      case 'completed':
        return 'ended';
      case 'failed':
        return 'errored';
      case 'expired':
        return 'expired';
      case 'cancelling':
      case 'cancelled':
        return 'canceled';
      case 'validating':
      case 'in_progress':
      case 'finalizing':
        return 'in_progress';
      default:
        return 'submitted';
    }
  }

  private emitUsage(rawUsage: unknown, modelId: string, attribution: Attribution): void {
    try {
      // Typed against UsageEvent so the payload can't drift from what CostService
      // consumes. serviceTier is always 'standard': an OpenAI-compatible usage
      // object carries no tier signal, and Moonshot's sync API has one tier.
      const event: UsageEvent = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        modelId,
        serviceTier: 'standard',
        attribution,
        tokens: tokensFromUsage(rawUsage),
        source: 'sync',
      };
      this.events.emit('llm.usage', event);
    } catch (err) {
      // Capture must never affect the request path — but swallowing silently means
      // cost tracking drops records with no trace, so log it. Optional chain for the
      // same reason as rethrow's `?.status`: a thrown null/undefined must not turn
      // this warn into a TypeError that escapes the catch it was meant to contain.
      this.logger.warn(`llm.usage emit failed for ${modelId}: ${(err as Error)?.message}`);
    }
  }

  /** Maps OpenAI/Moonshot SDK errors to Nest HttpExceptions; passes others through. */
  protected rethrow(err: unknown): never {
    if (err instanceof HttpException) throw err;
    // Optional chain: a thrown null/undefined must fall through to the
    // normalization below, not TypeError on the member access.
    const status = (err as { status?: number })?.status;
    const type = (err as any)?.error?.type ?? (err as any)?.code;
    if (typeof status === 'number') {
      if (status === 400 && type === 'content_filter') {
        throw new HttpException({ statusCode: 422, error: 'Structured message refused (content_filter)' }, HttpStatus.UNPROCESSABLE_ENTITY);
      }
      if (status >= 500) {
        this.logger.error(`Moonshot API error ${status}: ${(err as Error).message}`);
        throw new HttpException({ statusCode: status, error: 'Upstream Moonshot API error' }, status);
      }
      throw new HttpException({ statusCode: status, error: (err as Error).message }, status);
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}
