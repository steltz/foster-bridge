# LLM Provider Abstraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the benchmark module depend on a provider-neutral `LlmProvider` port instead of the Anthropic SDK, with Anthropic as one adapter behind a single config-driven swap seam.

**Architecture:** A new `backend/src/llm/` module owns neutral domain types, the `LlmProvider` interface, and a `LLM_PROVIDER` DI token bound by a factory in `LlmModule`. `AnthropicService` becomes `AnthropicLlmProvider implements LlmProvider` — the only file importing `@anthropic-ai/sdk`. Benchmark providers inject `LLM_PROVIDER`. Migration keeps every commit green by adding neutral methods additively and using temporary `*Legacy` aliases for the three methods whose names collide during signature changes; a final cleanup task deletes the legacy shims and dead types.

**Tech Stack:** NestJS, TypeScript, Jest (`pnpm test` from `backend/`), `@anthropic-ai/sdk`, `@nestjs/event-emitter`, `@nestjs/config`.

**Reference spec:** `docs/superpowers/specs/2026-07-28-llm-provider-abstraction-design.md`

**Working directory:** all paths are under `backend/`. Run tests from `backend/`: `pnpm test`.

---

## File Structure

**Created:**
- `backend/src/llm/llm.types.ts` — neutral domain types (envelope, blocks, batch, capabilities).
- `backend/src/llm/llm.provider.ts` — `LlmProvider` interface + `LlmCapabilities`.
- `backend/src/llm/llm.constants.ts` — `LLM_PROVIDER` injection token.
- `backend/src/llm/llm.module.ts` — `@Global` module binding `LLM_PROVIDER` via factory.
- `backend/src/llm/llm.types.spec.ts` — locks the neutral type shapes.
- `backend/src/llm/fake-llm.provider.ts` — in-memory `LlmProvider` test double.
- `backend/src/llm/llm.contract.spec.ts` — asserts `AnthropicLlmProvider` satisfies the port.

**Modified:**
- `backend/src/anthropic/anthropic.service.ts` — becomes `AnthropicLlmProvider`, the sole SDK adapter.
- `backend/src/anthropic/anthropic.module.ts` — provide/export `AnthropicLlmProvider`.
- `backend/src/anthropic/anthropic.service.spec.ts` — updated for neutral signatures.
- `backend/src/config/configuration.ts` — add `llm.provider`.
- `backend/src/app.module.ts` — register `LlmModule`.
- `backend/src/benchmark/*` — envelope.builder, benchmark.service, batch-reconciler, cache-warmer, seven-keys, day-artifacts, benchmark.module (inject `LLM_PROVIDER`, neutral types).
- `backend/src/cost/cost.types.ts` — `tokensFromUsage`/`serviceTierFromUsage` move out (Task 9).
- `backend/src/cost/cost.service.ts` — `@OnEvent('llm.usage')`.
- `backend/src/demo/anthropic-demo.controller.ts` — use neutral `submitBatch`/`getBatch`.

---

## Task 1: Neutral port foundation (types, interface, token)

**Files:**
- Create: `backend/src/llm/llm.types.ts`
- Create: `backend/src/llm/llm.provider.ts`
- Create: `backend/src/llm/llm.constants.ts`
- Test: `backend/src/llm/llm.types.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/llm/llm.types.spec.ts`:

```ts
import { LlmProvider, LlmCapabilities } from './llm.provider';
import { LLM_PROVIDER } from './llm.constants';
import {
  LlmContentBlock,
  LlmCacheTier,
  PromptEnvelope,
  StructuredRequest,
  BatchItemRequest,
  BatchSubmitOptions,
  BatchLifecycle,
  BatchHandle,
  BatchItemResult,
} from './llm.types';

describe('llm neutral types', () => {
  it('models a file-bearing prompt envelope with cache tiers', () => {
    const fileBlock: LlmContentBlock = { type: 'file', fileId: 'file_123' };
    const textBlock: LlmContentBlock = { type: 'text', text: 'hello' };
    const tier: LlmCacheTier = { blocks: [textBlock, fileBlock] };
    const envelope: PromptEnvelope = { system: 'sys', tiers: [tier] };
    expect(envelope.tiers?.[0].blocks).toHaveLength(2);
  });

  it('models a structured request and batch request/result', () => {
    const req: StructuredRequest = {
      prompt: 'go',
      schema: { type: 'object' },
      model: 'claude-fable-5',
      effort: 'high',
      maxTokens: 32000,
      envelope: { tiers: [{ blocks: [{ type: 'text', text: 'ctx' }] }] },
    };
    const item: BatchItemRequest = { customId: 'k', prompt: 'go' };
    const opts: BatchSubmitOptions = { model: 'm', schema: {}, maxTokens: 1, effort: 'high' };
    const status: BatchLifecycle = 'ended';
    const handle: BatchHandle = { batchId: 'b', status };
    const result: BatchItemResult = {
      customId: 'k',
      type: 'succeeded',
      text: '{}',
      cacheReadTokens: 5,
      usage: { input: 1, cacheRead: 2, cacheCreate5m: 0, cacheCreate1h: 3, output: 4 },
    };
    expect([req.prompt, item.prompt, opts.model, handle.batchId, result.type]).toEqual([
      'go', 'go', 'm', 'b', 'succeeded',
    ]);
  });

  it('exposes a capability flag set and an injection token', () => {
    const caps: LlmCapabilities = { batch: true, fileUpload: true, promptCaching: true, structuredOutput: true };
    expect(Object.values(caps).every((v) => typeof v === 'boolean')).toBe(true);
    expect(typeof LLM_PROVIDER).toBe('symbol');
    const _typecheck: LlmProvider | null = null; // compile-time only
    expect(_typecheck).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pnpm test -- llm.types.spec`
Expected: FAIL — cannot find modules `./llm.provider`, `./llm.constants`, `./llm.types`.

- [ ] **Step 3: Create the neutral types**

Create `backend/src/llm/llm.types.ts`:

```ts
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
```

- [ ] **Step 4: Create the port interface**

Create `backend/src/llm/llm.provider.ts`:

```ts
import {
  Attribution,
  BatchHandle,
  BatchItemRequest,
  BatchItemResult,
  BatchSubmitOptions,
  PromptEnvelope,
  StructuredRequest,
} from './llm.types';

export interface LlmCapabilities {
  batch: boolean;
  fileUpload: boolean;
  promptCaching: boolean;
  structuredOutput: boolean;
}

/**
 * Provider-neutral LLM port the benchmark depends on. The Anthropic adapter is
 * the only implementation today; a future provider implements this same surface.
 * `message()` and `warmCache()` are deliberately NOT on the port — they are
 * demo-only / unused-by-benchmark and stay on the concrete adapter.
 */
export interface LlmProvider {
  readonly capabilities: LlmCapabilities;

  /** One synchronous structured-output call; returns parsed JSON. Refusal throws. */
  messageStructured<T = unknown>(req: StructuredRequest, attribution: Attribution): Promise<T>;

  /** Uploads bytes to the provider and returns a neutral file id. */
  uploadFile(bytes: Buffer, filename: string, mediaType: string): Promise<string>;

  submitBatch(
    requests: BatchItemRequest[],
    envelope: PromptEnvelope | undefined,
    opts: BatchSubmitOptions,
  ): Promise<BatchHandle>;
  getBatch(batchId: string): Promise<BatchHandle>;
  getBatchResults(batchId: string): Promise<BatchItemResult[]>;
}
```

- [ ] **Step 5: Create the injection token**

Create `backend/src/llm/llm.constants.ts`:

```ts
/** DI token for the active LlmProvider implementation. */
export const LLM_PROVIDER = Symbol('LLM_PROVIDER');
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd backend && pnpm test -- llm.types.spec`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add backend/src/llm/llm.types.ts backend/src/llm/llm.provider.ts backend/src/llm/llm.constants.ts backend/src/llm/llm.types.spec.ts
git commit -m "feat(llm): neutral provider port types, interface, token"
```

---

## Task 2: FakeLlmProvider test double

**Files:**
- Create: `backend/src/llm/fake-llm.provider.ts`
- Test: (covered by Task 1 interface; a focused spec below)
- Test: `backend/src/llm/fake-llm.provider.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/llm/fake-llm.provider.spec.ts`:

```ts
import { FakeLlmProvider } from './fake-llm.provider';

describe('FakeLlmProvider', () => {
  it('records batch submissions and returns them by id', async () => {
    const fake = new FakeLlmProvider();
    const handle = await fake.submitBatch(
      [{ customId: 'k1', prompt: 'go' }],
      { tiers: [{ blocks: [{ type: 'text', text: 'ctx' }] }] },
      { model: 'm', schema: {}, maxTokens: 10, effort: 'high' },
    );
    expect(handle.batchId).toBeDefined();
    expect(handle.status).toBe('submitted');
    expect(fake.submittedBatches).toHaveLength(1);
    expect(fake.submittedBatches[0].requests[0].customId).toBe('k1');
  });

  it('serves canned structured responses and uploads', async () => {
    const fake = new FakeLlmProvider();
    fake.structuredResponses.push({ ok: true });
    const out = await fake.messageStructured<{ ok: boolean }>({ prompt: 'p' }, { operation: 'demo' });
    expect(out.ok).toBe(true);
    const id = await fake.uploadFile(Buffer.from('x'), 'f.pdf', 'application/pdf');
    expect(id).toMatch(/^fake-file-/);
  });

  it('returns queued batch results and a settable batch status', async () => {
    const fake = new FakeLlmProvider();
    fake.batchStatus = 'ended';
    fake.batchResults = [{ customId: 'k1', type: 'succeeded', text: '{}', usage: { input: 1, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0, output: 1 } }];
    const handle = await fake.getBatch('b1');
    expect(handle.status).toBe('ended');
    const results = await fake.getBatchResults('b1');
    expect(results[0].customId).toBe('k1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pnpm test -- fake-llm.provider.spec`
Expected: FAIL — cannot find module `./fake-llm.provider`.

- [ ] **Step 3: Implement the fake**

Create `backend/src/llm/fake-llm.provider.ts`:

```ts
import { LlmCapabilities, LlmProvider } from './llm.provider';
import {
  Attribution,
  BatchHandle,
  BatchItemRequest,
  BatchItemResult,
  BatchLifecycle,
  BatchSubmitOptions,
  PromptEnvelope,
  StructuredRequest,
} from './llm.types';

interface RecordedBatch {
  batchId: string;
  requests: BatchItemRequest[];
  envelope?: PromptEnvelope;
  opts: BatchSubmitOptions;
}

/**
 * In-memory LlmProvider double for benchmark unit tests. Callers push canned
 * structured responses / batch results and read back what was submitted. Proves
 * the benchmark is provider-agnostic — no Anthropic SDK involved.
 */
export class FakeLlmProvider implements LlmProvider {
  readonly capabilities: LlmCapabilities = {
    batch: true,
    fileUpload: true,
    promptCaching: true,
    structuredOutput: true,
  };

  submittedBatches: RecordedBatch[] = [];
  structuredResponses: unknown[] = [];
  structuredCalls: { req: StructuredRequest; attribution: Attribution }[] = [];
  uploads: { filename: string; mediaType: string }[] = [];
  batchStatus: BatchLifecycle = 'submitted';
  batchResults: BatchItemResult[] = [];

  private seq = 0;

  async messageStructured<T = unknown>(req: StructuredRequest, attribution: Attribution): Promise<T> {
    this.structuredCalls.push({ req, attribution });
    if (!this.structuredResponses.length) {
      throw new Error('FakeLlmProvider: no canned structuredResponses queued');
    }
    return this.structuredResponses.shift() as T;
  }

  async uploadFile(_bytes: Buffer, filename: string, mediaType: string): Promise<string> {
    this.uploads.push({ filename, mediaType });
    return `fake-file-${++this.seq}`;
  }

  async submitBatch(
    requests: BatchItemRequest[],
    envelope: PromptEnvelope | undefined,
    opts: BatchSubmitOptions,
  ): Promise<BatchHandle> {
    const batchId = `fake-batch-${++this.seq}`;
    this.submittedBatches.push({ batchId, requests, envelope, opts });
    return { batchId, status: 'submitted' };
  }

  async getBatch(batchId: string): Promise<BatchHandle> {
    return { batchId, status: this.batchStatus };
  }

  async getBatchResults(_batchId: string): Promise<BatchItemResult[]> {
    return this.batchResults;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pnpm test -- fake-llm.provider.spec`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/llm/fake-llm.provider.ts backend/src/llm/fake-llm.provider.spec.ts
git commit -m "test(llm): in-memory FakeLlmProvider double"
```

---

## Task 3: Anthropic adapter implements the port (additive + legacy shims)

The adapter gains all neutral port methods. Because `getBatch`, `getBatchResults`, and `messageStructured` keep their names but change signatures, their **current** forms are renamed to `*Legacy` and their existing callers are pointed at the legacy name in this task (keeps green). `createBatch` stays (new `submitBatch` is added alongside it). Later tasks migrate callers to the neutral methods; Task 9 deletes the shims.

**Files:**
- Modify: `backend/src/anthropic/anthropic.service.ts`
- Modify: `backend/src/anthropic/anthropic.module.ts`
- Modify: `backend/src/demo/anthropic-demo.controller.ts`
- Modify: `backend/src/benchmark/batch-reconciler.ts` (point at `getBatchLegacy`/`getBatchResultsLegacy` temporarily)
- Modify: `backend/src/benchmark/seven-keys/seven-keys.service.ts` (point at `messageStructuredLegacy` temporarily)
- Test: `backend/src/anthropic/anthropic.service.spec.ts`

- [ ] **Step 1: Write the failing adapter tests (neutral methods)**

Add to `backend/src/anthropic/anthropic.service.spec.ts` a new describe block (keep existing tests; adjust class name in imports to `AnthropicLlmProvider`):

```ts
// NOTE: rename the imported symbol at the top of the file:
//   import { AnthropicLlmProvider } from './anthropic.service';
// and every `new AnthropicService(...)` / provider ref becomes AnthropicLlmProvider.

describe('AnthropicLlmProvider port surface', () => {
  it('declares full capabilities', () => {
    const svc = makeService(); // existing spec helper that constructs the provider
    expect(svc.capabilities).toEqual({ batch: true, fileUpload: true, promptCaching: true, structuredOutput: true });
  });

  it('submitBatch renders a neutral file block as a beta document and infers the files path', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'batch_1', processing_status: 'in_progress' });
    const svc = makeServiceWithBetaBatchesCreate(create); // helper: client.beta.messages.batches.create = create
    const handle = await svc.submitBatch(
      [{ customId: 'k1', prompt: 'go' }],
      { tiers: [{ blocks: [{ type: 'file', fileId: 'file_9' }, { type: 'text', text: 'plan' }] }] },
      { model: 'm', schema: { type: 'object' }, maxTokens: 10, effort: 'high' },
    );
    expect(handle).toEqual({ batchId: 'batch_1', status: 'in_progress' });
    const body = create.mock.calls[0][0];
    const content = body.requests[0].params.messages[0].content;
    expect(content[0]).toMatchObject({ type: 'document', source: { type: 'file', file_id: 'file_9' } });
    expect(body.betas).toContain('files-api-2025-04-14');
  });

  it('getBatch maps processing_status to a neutral lifecycle', async () => {
    const retrieve = jest.fn().mockResolvedValue({ id: 'b', processing_status: 'ended', request_counts: {} });
    const svc = makeServiceWithBetaBatchesRetrieve(retrieve);
    await expect(svc.getBatch('b')).resolves.toEqual({ batchId: 'b', status: 'ended', requestCounts: {} });
  });

  it('getBatchResults returns neutral UsageTokens, not raw usage', async () => {
    const svc = makeServiceWithBetaBatchResults([
      { custom_id: 'k1', result: { type: 'succeeded', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 3, cache_read_input_tokens: 2, output_tokens: 1 } } } },
    ]);
    const [item] = await svc.getBatchResults('b');
    expect(item.usage).toEqual({ input: 3, cacheRead: 2, cacheCreate5m: 0, cacheCreate1h: 0, output: 1 });
    expect(item.cacheReadTokens).toBe(2);
  });
});
```

> Implementation note for the worker: the existing spec already mocks the SDK client. Reuse its client-mock factory; the `makeServiceWith*` names above are shorthand for "construct the provider with the client method stubbed." Match the existing spec's construction style rather than introducing new helpers if they already exist.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && pnpm test -- anthropic.service.spec`
Expected: FAIL — `AnthropicLlmProvider` not exported; `submitBatch`/`capabilities` undefined.

- [ ] **Step 3: Rename the class and add the port surface**

In `backend/src/anthropic/anthropic.service.ts`:

Add the import and implement the interface:

```ts
import { LlmProvider, LlmCapabilities } from '../llm/llm.provider';
import {
  PromptEnvelope,
  LlmContentBlock,
  StructuredRequest,
  BatchItemRequest,
  BatchSubmitOptions,
  BatchHandle,
  BatchItemResult,
  BatchLifecycle,
} from '../llm/llm.types';
```

Change the class declaration:

```ts
@Injectable()
export class AnthropicLlmProvider implements LlmProvider {
  readonly capabilities: LlmCapabilities = {
    batch: true,
    fileUpload: true,
    promptCaching: true,
    structuredOutput: true,
  };
  // ...existing constructor, logger, getters unchanged...
```

Add a neutral envelope→SDK builder and a files-inference helper (place near `buildCachedRequest`):

```ts
  /** True when any tier block references an uploaded file (routes to the beta/files path). */
  private envelopeHasFile(envelope?: PromptEnvelope): boolean {
    return !!envelope?.tiers?.some((t) => t.blocks.some((b) => b.type === 'file'));
  }

  /** Map neutral blocks to Anthropic beta content-block params. */
  private toBetaBlocks(blocks: LlmContentBlock[]): Anthropic.Beta.BetaContentBlockParam[] {
    return blocks.map((b) =>
      b.type === 'file'
        ? ({ type: 'document', source: { type: 'file', file_id: b.fileId } } as Anthropic.Beta.BetaContentBlockParam)
        : ({ type: 'text', text: b.text } as Anthropic.Beta.BetaContentBlockParam),
    );
  }

  /** Neutral-envelope variant of buildCachedRequest — one 1h breakpoint per tier. */
  private buildEnvelopeRequest(
    envelope: PromptEnvelope,
    prompt: string,
  ): { system?: Anthropic.TextBlockParam[]; messages: Anthropic.Beta.BetaMessageParam[] } {
    const system = envelope.system
      ? [{ type: 'text' as const, text: envelope.system, cache_control: ONE_HOUR_CACHE_CONTROL }]
      : undefined;

    let messages: Anthropic.Beta.BetaMessageParam[];
    const tiers = envelope.tiers ?? [];
    if (tiers.length) {
      const breakpoints = (system ? 1 : 0) + tiers.length;
      if (breakpoints > 4) {
        throw new HttpException(
          { statusCode: 400, error: `Too many cache breakpoints: ${breakpoints} (max 4)` },
          HttpStatus.BAD_REQUEST,
        );
      }
      const content: Anthropic.Beta.BetaContentBlockParam[] = [];
      for (const tier of tiers) {
        const blocks = this.toBetaBlocks(tier.blocks);
        if (blocks.length) {
          blocks[blocks.length - 1] = {
            ...blocks[blocks.length - 1],
            cache_control: ONE_HOUR_CACHE_CONTROL,
          } as Anthropic.Beta.BetaContentBlockParam;
        }
        content.push(...blocks);
      }
      content.push({ type: 'text', text: prompt });
      messages = [{ role: 'user', content }];
    } else {
      messages = [{ role: 'user', content: prompt }];
    }
    return system ? { system, messages } : { messages };
  }

  private toLifecycle(status: string): BatchLifecycle {
    switch (status) {
      case 'in_progress':
      case 'ended':
      case 'canceled':
      case 'expired':
      case 'errored':
        return status;
      default:
        return 'submitted';
    }
  }
```

Add the neutral port methods:

```ts
  async submitBatch(
    requests: BatchItemRequest[],
    envelope: PromptEnvelope | undefined,
    opts: BatchSubmitOptions,
  ): Promise<BatchHandle> {
    const client = this.clientFactory.get();
    const model = opts.model ?? this.defaultModel;
    const maxTokens = opts.maxTokens ?? this.defaultMaxTokens;
    const outputConfig = {
      ...(opts.schema ? { format: { type: 'json_schema', schema: opts.schema } } : {}),
      ...(opts.effort ? { effort: opts.effort } : {}),
    };
    const useFiles = this.envelopeHasFile(envelope) || requests.some((r) => this.envelopeHasFile(r.envelope));
    try {
      const body = {
        requests: requests.map((r, i) => {
          const env = r.envelope ?? envelope;
          const built = env
            ? this.buildEnvelopeRequest(env, r.prompt)
            : { messages: [{ role: 'user' as const, content: r.prompt }] };
          return {
            custom_id: r.customId ?? `request-${i}`,
            params: {
              model,
              max_tokens: maxTokens,
              ...built,
              ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
            },
          };
        }),
      };
      const batch = useFiles
        ? await client.beta.messages.batches.create({ ...body, betas: FILES_BETA } as any)
        : await client.messages.batches.create(body as any);
      return { batchId: batch.id, status: this.toLifecycle(batch.processing_status) };
    } catch (err) {
      this.rethrow(err);
    }
  }

  async getBatch(id: string): Promise<BatchHandle> {
    const legacy = await this.getBatchLegacy(id, { files: true });
    return {
      batchId: legacy.batchId,
      status: this.toLifecycle(legacy.processingStatus),
      requestCounts: legacy.requestCounts,
    };
  }

  async getBatchResults(id: string): Promise<BatchItemResult[]> {
    const legacy = await this.getBatchResultsLegacy(id, { files: true });
    return legacy.map((item) => {
      const out: BatchItemResult = { customId: item.customId, type: item.type };
      if (item.text !== undefined) out.text = item.text;
      if (item.error !== undefined) out.error = item.error;
      if (item.cacheReadInputTokens !== undefined) out.cacheReadTokens = item.cacheReadInputTokens;
      if (item.usage !== undefined) out.usage = tokensFromUsage(item.usage);
      return out;
    });
  }
```

> `tokensFromUsage` is still imported from `../cost/cost.types` here; Task 9 moves it into the adapter. Keep the existing `import { ..., tokensFromUsage } from '../cost/cost.types'` line.

- [ ] **Step 4: Rename the three colliding methods to `*Legacy`**

In `anthropic.service.ts`, rename the EXISTING methods (bodies unchanged):
- `async messageStructured<T>(...)` → `async messageStructuredLegacy<T>(...)`
- `async getBatch(id, opts?)` → `async getBatchLegacy(id, opts?)`
- `async getBatchResults(id, opts?)` → `async getBatchResultsLegacy(id, opts?)`

(Leave `createBatch`, `message`, `warmCache`, `uploadFile`, `buildCachedRequest`, `toVerification`, `emitUsage`, `rethrow` exactly as they are.)

- [ ] **Step 5: Add the neutral `messageStructured` port method**

Add (distinct from the renamed legacy one):

```ts
  async messageStructured<T = unknown>(req: StructuredRequest, attribution: Attribution): Promise<T> {
    const client = this.clientFactory.get();
    const model = req.model ?? this.defaultModel;
    const maxTokens = req.maxTokens ?? this.defaultMaxTokens;
    const useFiles = this.envelopeHasFile(req.envelope);
    const outputConfig = {
      ...(req.schema ? { format: { type: 'json_schema', schema: req.schema } } : {}),
      ...(req.effort ? { effort: req.effort } : {}),
    };
    const built = req.envelope
      ? this.buildEnvelopeRequest(req.envelope, req.prompt)
      : { messages: [{ role: 'user' as const, content: req.prompt }] };
    const params: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      ...(req.system && !req.envelope?.system ? { system: req.system } : {}),
      ...built,
      ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
    };
    try {
      const resp = useFiles
        ? await client.beta.messages.create({ ...params, betas: FILES_BETA } as any)
        : await client.messages.create(params as any);
      this.emitUsage((resp as any).usage, (resp as any).model ?? model, attribution);
      if (resp.stop_reason === 'refusal') {
        throw new HttpException(
          { statusCode: 422, error: 'Structured message refused' },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      let text = '';
      for (const block of resp.content) {
        if (block.type === 'text') text += block.text;
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new HttpException(
          { statusCode: 502, error: 'Structured output was not valid JSON' },
          HttpStatus.BAD_GATEWAY,
        );
      }
    } catch (err) {
      this.rethrow(err);
    }
  }
```

Add the `Attribution` import if not present: `import { Attribution } from '../cost/cost.types';` (the file already imports from `../cost/cost.types`; add `Attribution` to that import list — it is already imported today).

- [ ] **Step 6: Update the module and the three temporary callers**

`backend/src/anthropic/anthropic.module.ts` — replace `AnthropicService` with `AnthropicLlmProvider`:

```ts
import { AnthropicLlmProvider } from './anthropic.service';
// ...
  providers: [anthropicClientProvider, AnthropicLlmProvider],
  exports: [ANTHROPIC_CLIENT, AnthropicLlmProvider],
```

`backend/src/demo/anthropic-demo.controller.ts` — update import + injected type to `AnthropicLlmProvider`; migrate its batch calls to the neutral API now (demo is fully controlled):
- `this.anthropic.createBatch(body.requests ?? [])` → `this.anthropic.submitBatch((body.requests ?? []).map((r: any) => ({ customId: r.customId, prompt: r.prompt })), undefined, {})`
- `this.anthropic.getBatch(id)` → `this.anthropic.getBatch(id)` (now returns `BatchHandle`; update any `.processingStatus` reads to `.status`).
- `this.anthropic.message(...)` stays.

`backend/src/benchmark/batch-reconciler.ts` — TEMPORARY: point at legacy so it stays green (migrated to neutral in Task 5). Change the two calls:
- `await this.anthropic.getBatch(batch.batchId, { files: true })` → `await this.anthropic.getBatchLegacy(batch.batchId, { files: true })`
- `await this.anthropic.getBatchResults(batch.batchId, { files: true })` → `await this.anthropic.getBatchResultsLegacy(batch.batchId, { files: true })`

Also update its import + injected field type from `AnthropicService` to `AnthropicLlmProvider` (still the concrete class here; token injection lands in Task 5).

`backend/src/benchmark/seven-keys/seven-keys.service.ts` — TEMPORARY: rename its 4 `this.anthropic.messageStructured(` calls to `this.anthropic.messageStructuredLegacy(` and update import/field type to `AnthropicLlmProvider` (migrated to neutral in Task 6).

`backend/src/benchmark/benchmark.service.ts`, `cache-warmer.ts`, `day-artifacts.service.ts` — update import + field type `AnthropicService` → `AnthropicLlmProvider` (they still call `createBatch`/`uploadFile`, which are unchanged; migrated in Tasks 4/7).

- [ ] **Step 7: Run the full suite**

Run: `cd backend && pnpm test`
Expected: PASS — new adapter port tests pass; all existing tests still green (callers use legacy shims / unchanged methods).

- [ ] **Step 8: Commit**

```bash
git add backend/src/anthropic backend/src/demo/anthropic-demo.controller.ts backend/src/benchmark
git commit -m "feat(anthropic): implement LlmProvider port on the adapter (legacy shims retained)"
```

---

## Task 4: LlmModule swap seam + config, migrate batch producers

Introduce the `LLM_PROVIDER` binding and migrate the two batch-producing benchmark consumers (`benchmark.service`, `cache-warmer`) and the `envelope.builder` to neutral types + `submitBatch`.

**Files:**
- Create: `backend/src/llm/llm.module.ts`
- Modify: `backend/src/config/configuration.ts`
- Modify: `backend/src/app.module.ts`
- Modify: `backend/src/benchmark/benchmark.module.ts`
- Modify: `backend/src/benchmark/envelope.builder.ts`
- Modify: `backend/src/benchmark/benchmark.service.ts`
- Modify: `backend/src/benchmark/cache-warmer.ts`
- Test: `backend/src/benchmark/envelope.builder.spec.ts`, `benchmark.service.spec.ts`, `cache-warmer.spec.ts`

- [ ] **Step 1: Add `llm.provider` config**

`backend/src/config/configuration.ts` — add to `AppConfig`:

```ts
  llm: {
    provider: string;
  };
```

and to the returned object (near the `anthropic:` block):

```ts
  llm: {
    provider: process.env.LLM_PROVIDER ?? 'anthropic',
  },
```

- [ ] **Step 2: Create LlmModule**

Create `backend/src/llm/llm.module.ts`:

```ts
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AnthropicModule } from '../anthropic/anthropic.module';
import { AnthropicLlmProvider } from '../anthropic/anthropic.service';
import { LLM_PROVIDER } from './llm.constants';
import { LlmProvider } from './llm.provider';

// Single swap seam: selects the active provider by config. Add new adapters here.
@Global()
@Module({
  imports: [AnthropicModule],
  providers: [
    {
      provide: LLM_PROVIDER,
      inject: [ConfigService, AnthropicLlmProvider],
      useFactory: (cfg: ConfigService, anthropic: AnthropicLlmProvider): LlmProvider => {
        const provider = cfg.get<string>('llm.provider') ?? 'anthropic';
        switch (provider) {
          case 'anthropic':
            return anthropic;
          default:
            throw new Error(`Unknown llm.provider: ${provider}`);
        }
      },
    },
  ],
  exports: [LLM_PROVIDER],
})
export class LlmModule {}
```

- [ ] **Step 3: Register LlmModule in app.module**

`backend/src/app.module.ts` — add import and to `imports` array (after `AnthropicModule`):

```ts
import { LlmModule } from './llm/llm.module';
// ...
    AnthropicModule,
    LlmModule,
```

- [ ] **Step 4: Write the failing envelope.builder test (neutral output)**

Update `backend/src/benchmark/envelope.builder.spec.ts` expectations to the neutral shape. Add:

```ts
it('emits neutral content blocks with a file block for the day PDF', () => {
  const builder = new EnvelopeBuilder();
  const env = builder.fullEnvelope('GENERAL', { date: '2026-07-01', fileId: 'file_7', tpTranscript: 'tp', recapTranscript: 're' }, 'PERSONA', { variant: 'base' });
  expect(env.tiers).toHaveLength(3);
  const dayBlocks = env.tiers![1].blocks;
  expect(dayBlocks[0]).toEqual({ type: 'file', fileId: 'file_7' });
  expect(dayBlocks[1]).toMatchObject({ type: 'text' });
});
```

(Adjust existing assertions in this spec that referenced `userTiers`/`anthropicFileId`/`document` to `tiers`/`fileId`/`{type:'file'}`.)

- [ ] **Step 5: Migrate envelope.builder to neutral types**

`backend/src/benchmark/envelope.builder.ts`:
- Remove `import type Anthropic from '@anthropic-ai/sdk';` and `import { CachedContext } from '../anthropic/anthropic.service';`.
- Add `import { PromptEnvelope, LlmCacheTier } from '../llm/llm.types';`.
- Change `DayBundle.anthropicFileId` → `fileId`.
- Replace the tier helpers and return types:

```ts
  private generalTier(generalDocs: string): LlmCacheTier {
    return { blocks: [{ type: 'text', text: this.generalText(generalDocs) }] };
  }

  private dayTier(bundle: DayBundle): LlmCacheTier {
    return {
      blocks: [
        { type: 'file', fileId: bundle.fileId },
        { type: 'text', text: `Trade plan video transcript for the ${bundle.date} ES session:\n${bundle.tpTranscript}` },
        { type: 'text', text: `Prior-session recap transcript:\n${bundle.recapTranscript}` },
      ],
    };
  }

  dayBundleContext(generalDocs: string, bundle: DayBundle): PromptEnvelope {
    return { tiers: [this.generalTier(generalDocs), this.dayTier(bundle)] };
  }

  fullEnvelope(generalDocs: string, bundle: DayBundle, persona: string, spec: VariantSpec): PromptEnvelope {
    const tiers: LlmCacheTier[] = [
      this.generalTier(generalDocs),
      this.dayTier(bundle),
      { blocks: [{ type: 'text', text: `Adopt this trading persona fully:\n${persona}` }] },
    ];
    // ...unchanged scorecard/feature substitution logic, but push { blocks: [{ type: 'text', text: featureText }] } ...
    return { tiers };
  }
```

- [ ] **Step 6: Migrate benchmark.service + cache-warmer**

`backend/src/benchmark/benchmark.service.ts`:
- Replace `import { AnthropicService, BatchRequestInput } from '../anthropic/anthropic.service';` with:
  ```ts
  import { Inject } from '@nestjs/common';
  import { LLM_PROVIDER } from '../llm/llm.constants';
  import { LlmProvider } from '../llm/llm.provider';
  import { BatchItemRequest } from '../llm/llm.types';
  ```
- Constructor: `private readonly anthropic: AnthropicService` → `@Inject(LLM_PROVIDER) private readonly llm: LlmProvider`.
- `const requests: BatchRequestInput[] = []` → `const requests: BatchItemRequest[] = []`.
- `requests.push({ customId: key, prompt: TRAILING_PROMPT, context: envelope })` → `requests.push({ customId: key, prompt: TRAILING_PROMPT, envelope })`.
- The submit call:
  ```ts
  const batch = await this.llm.submitBatch(requests, undefined, {
    model: model.id,
    schema: SETUP_SCHEMA,
    maxTokens,
    effort,
  });
  ```
- `batch.batchId` unchanged (BatchHandle has it). Update `assembleDay` return + `DayBundle`: `anthropicFileId: pdf.anthropicFileId` → `fileId: pdf.providerFileId` (field lands in Task 7; until then keep `pdf.anthropicFileId` and the `fileId` bundle key — reconcile in Task 7). Set bundle key to `fileId`.

> To keep this task green before Task 7's field rename, read the file id via the existing `PdfArtifact.anthropicFileId` and assign it to the bundle's `fileId`.

`backend/src/benchmark/cache-warmer.ts`:
- Same import/inject swap (`LLM_PROVIDER` / `LlmProvider`).
- Bundle: `anthropicFileId: fileId` → `fileId`.
- `await this.anthropic.createBatch([{ prompt: 'Cache warm — ignore this request.' }], envelope, { model: batch.model.id, files: true, effort, outputSchema: SETUP_SCHEMA })` →
  ```ts
  await this.llm.submitBatch(
    [{ prompt: 'Cache warm — ignore this request.' }],
    envelope,
    { model: batch.model.id, effort, schema: SETUP_SCHEMA },
  );
  ```

`backend/src/benchmark/benchmark.module.ts`:
- Remove `import { AnthropicModule } from '../anthropic/anthropic.module';` and its entry in `imports` (LLM_PROVIDER is global via LlmModule).

- [ ] **Step 7: Update benchmark.service + cache-warmer specs to FakeLlmProvider**

Replace the mocked `AnthropicService` with `FakeLlmProvider` in `benchmark.service.spec.ts` and `cache-warmer.spec.ts`. Provide it under the `LLM_PROVIDER` token:

```ts
import { FakeLlmProvider } from '../llm/fake-llm.provider';
import { LLM_PROVIDER } from '../llm/llm.constants';
// in the Test.createTestingModule providers:
{ provide: LLM_PROVIDER, useValue: fake },
```

Assert against `fake.submittedBatches` instead of a `createBatch` mock (e.g. `expect(fake.submittedBatches[0].opts.schema).toBe(SETUP_SCHEMA)`).

- [ ] **Step 8: Run the full suite**

Run: `cd backend && pnpm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/src/llm/llm.module.ts backend/src/config/configuration.ts backend/src/app.module.ts backend/src/benchmark/envelope.builder.ts backend/src/benchmark/benchmark.service.ts backend/src/benchmark/cache-warmer.ts backend/src/benchmark/benchmark.module.ts backend/src/benchmark/envelope.builder.spec.ts backend/src/benchmark/benchmark.service.spec.ts backend/src/benchmark/cache-warmer.spec.ts
git commit -m "feat(benchmark): route batch producers through LLM_PROVIDER port"
```

---

## Task 5: Migrate batch-reconciler to neutral getBatch/getBatchResults

**Files:**
- Modify: `backend/src/benchmark/batch-reconciler.ts`
- Test: `backend/src/benchmark/batch-reconciler.spec.ts`

- [ ] **Step 1: Update the reconciler spec to the fake + neutral results**

In `batch-reconciler.spec.ts`, provide `FakeLlmProvider` under `LLM_PROVIDER`, set `fake.batchStatus = 'ended'` and `fake.batchResults = [{ customId, type: 'succeeded', text, usage: { input, cacheRead, cacheCreate5m, cacheCreate1h, output } }]`. Keep the existing assertion that a `llm.usage` event is emitted — but note the event name changes in Task 8; for now it still asserts `'anthropic.usage'`. The reconciler no longer calls `tokensFromUsage` (usage arrives neutral), so the emitted `tokens` should equal `item.usage` directly.

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && pnpm test -- batch-reconciler.spec`
Expected: FAIL — reconciler still injects the concrete adapter / calls `*Legacy`.

- [ ] **Step 3: Migrate the reconciler**

`backend/src/benchmark/batch-reconciler.ts`:
- Replace `import { AnthropicLlmProvider, BatchResultItem } from '../anthropic/anthropic.service';` with:
  ```ts
  import { Inject } from '@nestjs/common';
  import { LLM_PROVIDER } from '../llm/llm.constants';
  import { LlmProvider } from '../llm/llm.provider';
  import { BatchItemResult } from '../llm/llm.types';
  ```
- Remove `import { tokensFromUsage } from '../cost/cost.types';`.
- Constructor field → `@Inject(LLM_PROVIDER) private readonly llm: LlmProvider`.
- `this.anthropic.getBatchLegacy(batch.batchId, { files: true })` → `this.llm.getBatch(batch.batchId)`; read `.status` (already the neutral lifecycle — the string comparisons `'in_progress'|'ended'|...` are unchanged).
- `this.anthropic.getBatchResultsLegacy(batch.batchId, { files: true })` → `this.llm.getBatchResults(batch.batchId)`.
- In the usage emit, replace `tokens: tokensFromUsage(item.usage)` with `tokens: item.usage` (already `UsageTokens`). Type `item` as `BatchItemResult`.

- [ ] **Step 4: Run the full suite**

Run: `cd backend && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/benchmark/batch-reconciler.ts backend/src/benchmark/batch-reconciler.spec.ts
git commit -m "feat(benchmark): reconcile batches through the neutral LlmProvider port"
```

---

## Task 6: Migrate seven-keys to neutral messageStructured + PromptEnvelope

**Files:**
- Modify: `backend/src/benchmark/seven-keys/seven-keys.service.ts`
- Test: `backend/src/benchmark/seven-keys/seven-keys.service.spec.ts`

- [ ] **Step 1: Update the seven-keys spec to the fake**

Provide `FakeLlmProvider` under `LLM_PROVIDER`; queue four `fake.structuredResponses` (current, lookback, synth `{ artifact }`, verify `{ pass, mismatches }`). Assert `fake.structuredCalls[i].req` carries the expected `model`, `schema`, `effort`, `maxTokens`, and (for current/verify) an `envelope` whose tiers contain a `{ type: 'file', fileId }` block.

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && pnpm test -- seven-keys.service.spec`
Expected: FAIL — still injects concrete adapter / calls `messageStructuredLegacy`.

- [ ] **Step 3: Migrate seven-keys**

`backend/src/benchmark/seven-keys/seven-keys.service.ts`:
- Replace `import { AnthropicLlmProvider, CachedContext } from '../../anthropic/anthropic.service';` with:
  ```ts
  import { Inject } from '@nestjs/common';
  import { LLM_PROVIDER } from '../../llm/llm.constants';
  import { LlmProvider } from '../../llm/llm.provider';
  import { PromptEnvelope } from '../../llm/llm.types';
  ```
- Constructor field → `@Inject(LLM_PROVIDER) private readonly llm: LlmProvider`.
- `pdfContext`/`currentDayContext` return `PromptEnvelope` with neutral blocks:
  ```ts
  private pdfContext(fileId: string): PromptEnvelope {
    return { tiers: [{ blocks: [{ type: 'file', fileId }] }] };
  }
  private currentDayContext(fileId: string, generalDocs: string, methodsDoc: string): PromptEnvelope {
    return {
      tiers: [
        { blocks: [{ type: 'text', text: generalAndMethodsBlock(generalDocs, methodsDoc) }] },
        { blocks: [{ type: 'file', fileId }] },
      ],
    };
  }
  ```
- Convert each of the four calls from `messageStructuredLegacy({ prompt }, attribution, { model, outputSchema, files, effort, maxTokens, context })` to the neutral `messageStructured`:
  ```ts
  this.llm.messageStructured<Record<string, unknown>>(
    {
      prompt: currentDayPrompt({ date: day.date, tpTranscript, recapTranscript }),
      model: CURRENT_DAY_MODEL,
      schema: CURRENT_SCHEMA,
      effort: this.effort,
      maxTokens: this.maxTokens,
      envelope: this.currentDayContext(fileId, general.concatenated, methodsDoc),
    },
    { operation: 'keys-generation', benchmark: { modelAlias: 'fable', day: day.day } },
  )
  ```
  Apply the same transform to the lookback (no envelope, no files), synth (no envelope), and verify (`envelope: this.pdfContext(fileId)`) calls. `outputSchema` → `schema`; drop `files` (inferred); `context` → `envelope`.

- [ ] **Step 4: Run the full suite**

Run: `cd backend && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/benchmark/seven-keys/seven-keys.service.ts backend/src/benchmark/seven-keys/seven-keys.service.spec.ts
git commit -m "feat(benchmark): run seven-keys through the neutral LlmProvider port"
```

---

## Task 7: Migrate day-artifacts + persisted `providerFileId` rename

**Files:**
- Modify: `backend/src/benchmark/day-artifacts.service.ts`
- Modify: `backend/src/benchmark/benchmark.repository.ts`
- Modify: `backend/src/benchmark/benchmark.service.ts` (bundle `fileId` from `providerFileId`)
- Modify: `backend/src/benchmark/cache-warmer.ts` (`ensureFileId` unchanged; verify field)
- Test: `backend/src/benchmark/day-artifacts.service.spec.ts`

- [ ] **Step 1: Write the failing read-compat test**

In `day-artifacts.service.spec.ts`, add a case: a stored doc with only the legacy `anthropicFileId` (no `providerFileId`) is still resolved by `ensureFileId`/`ensurePdf`:

```ts
it('reads a legacy anthropicFileId when providerFileId is absent', async () => {
  repo.getDayArtifact.mockResolvedValue({ contentHash: 'h', gcsPath: 'g', anthropicFileId: 'legacy_id', uploadedAt: 't' });
  const id = await service.ensureFileId('07012026');
  expect(id).toBe('legacy_id');
});
```

Also update existing assertions that read `.anthropicFileId` on returned `PdfArtifact` to `.providerFileId`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && pnpm test -- day-artifacts.service.spec`
Expected: FAIL — `providerFileId` not present; `ensureFileId` reads only `anthropicFileId`.

- [ ] **Step 3: Rename the persisted field with a read shim**

`backend/src/benchmark/benchmark.repository.ts` — in `DayArtifactDoc`:

```ts
  providerFileId?: string; // pdfFile only (neutral provider file id)
  /** @deprecated legacy Anthropic-named field; read-compat only. */
  anthropicFileId?: string;
```

`backend/src/benchmark/day-artifacts.service.ts`:
- Import the port: `import { Inject } from '@nestjs/common'; import { LLM_PROVIDER } from '../llm/llm.constants'; import { LlmProvider } from '../llm/llm.provider';` and drop the `AnthropicLlmProvider` import.
- Constructor field → `@Inject(LLM_PROVIDER) private readonly llm: LlmProvider`.
- `PdfArtifact.anthropicFileId` → `providerFileId`.
- Everywhere a stored id is READ, use `const fileId = existing.providerFileId ?? existing.anthropicFileId;` and branch on `fileId`.
- Everywhere a stored id is WRITTEN, write `providerFileId` (stop writing `anthropicFileId`).
- `this.anthropic.uploadFile(...)` → `this.llm.uploadFile(...)`.

`backend/src/benchmark/benchmark.service.ts` — `assembleDay`: `fileId: pdf.providerFileId`.

`backend/src/benchmark/cache-warmer.ts` — `ensureFileId` still returns a string; the `bundle.fileId = fileId` assignment is unchanged. No field read of the doc here.

- [ ] **Step 4: Run the full suite**

Run: `cd backend && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/benchmark/day-artifacts.service.ts backend/src/benchmark/benchmark.repository.ts backend/src/benchmark/benchmark.service.ts backend/src/benchmark/cache-warmer.ts backend/src/benchmark/day-artifacts.service.spec.ts
git commit -m "refactor(benchmark): neutral providerFileId with legacy read-compat"
```

---

## Task 8: Rename usage event `anthropic.usage` → `llm.usage`

**Files:**
- Modify: `backend/src/anthropic/anthropic.service.ts` (sync emit)
- Modify: `backend/src/benchmark/batch-reconciler.ts` (batch emit)
- Modify: `backend/src/cost/cost.service.ts` (`@OnEvent`)
- Modify: `backend/src/cost/cost.types.ts` (comment)
- Test: `backend/src/anthropic/anthropic.service.spec.ts`, `batch-reconciler.spec.ts`

- [ ] **Step 1: Update the specs to the new event name**

In `anthropic.service.spec.ts` and `batch-reconciler.spec.ts`, replace every `'anthropic.usage'` literal with `'llm.usage'`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && pnpm test -- anthropic.service.spec batch-reconciler.spec`
Expected: FAIL — emitters still emit `'anthropic.usage'`.

- [ ] **Step 3: Rename at all emit/listen sites**

- `anthropic.service.ts` `emitUsage`: `this.events.emit('anthropic.usage', {...})` → `this.events.emit('llm.usage', {...})`.
- `batch-reconciler.ts`: `this.events.emit('anthropic.usage', {...})` → `this.events.emit('llm.usage', {...})`.
- `cost.service.ts`: `@OnEvent('anthropic.usage')` → `@OnEvent('llm.usage')`.
- `cost.types.ts`: update the comment `// Emitted on the 'anthropic.usage' event ...` → `'llm.usage'`.

- [ ] **Step 4: Run the full suite**

Run: `cd backend && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/anthropic/anthropic.service.ts backend/src/benchmark/batch-reconciler.ts backend/src/cost/cost.service.ts backend/src/cost/cost.types.ts backend/src/anthropic/anthropic.service.spec.ts backend/src/benchmark/batch-reconciler.spec.ts
git commit -m "refactor(cost): rename usage event to provider-neutral llm.usage"
```

---

## Task 9: Cleanup — delete legacy shims, dead types, move usage parsers, contract test

**Files:**
- Modify: `backend/src/anthropic/anthropic.service.ts`
- Create: `backend/src/anthropic/anthropic.usage.ts`
- Modify: `backend/src/cost/cost.types.ts`
- Create: `backend/src/llm/llm.contract.spec.ts`

- [ ] **Step 1: Delete the legacy shims and dead types**

In `anthropic.service.ts`, delete now-unused members and types:
- Delete `messageStructuredLegacy`, `getBatchLegacy`, `getBatchResultsLegacy`, and the old `createBatch` (all callers migrated).
- Delete the old `buildCachedRequest` (CachedContext variant) — only `buildEnvelopeRequest` remains. Delete `CachedContext`, `BatchRequestInput`, `BatchResultItem`, `BatchSummary` interface exports.
- Keep `MessageInput`/`MessageResult` (used by `message()` for the demo), `message`, `warmCache` (verify `warmCache` compiles — convert its `CachedContext` parameter to `PromptEnvelope` and its `buildCachedRequest` call to `buildEnvelopeRequest`, since it has no production caller but retains a spec).
- Keep `CacheVerification` (returned by `warmCache`).

> Run a search to confirm no remaining references: `grep -rn "CachedContext\|BatchRequestInput\|BatchResultItem\|createBatch\|messageStructuredLegacy\|getBatchLegacy\|getBatchResultsLegacy" backend/src` returns only definitions being deleted.

- [ ] **Step 2: Move the Anthropic usage parsers into the adapter package**

Create `backend/src/anthropic/anthropic.usage.ts` and move `tokensFromUsage` + `serviceTierFromUsage` from `cost/cost.types.ts` verbatim (they parse Anthropic SDK usage shapes):

```ts
import { ServiceTier, UsageTokens } from '../cost/cost.types';

export function tokensFromUsage(usage: any): UsageTokens { /* moved body */ }
export function serviceTierFromUsage(usage: any, fallback: ServiceTier): ServiceTier { /* moved body */ }
```

- In `cost/cost.types.ts`, delete the two moved functions (keep `UsageTokens`, `ServiceTier`, `Attribution`, `UsageEvent`, `CostRecord`, `CostBreakdown`, etc.).
- In `anthropic.service.ts`, import them from `./anthropic.usage` instead of `../cost/cost.types` (keep importing `Attribution`, `ServiceTier` from `../cost/cost.types`).
- Confirm no other file imports `tokensFromUsage`/`serviceTierFromUsage` from `cost.types` (the reconciler stopped in Task 5): `grep -rn "tokensFromUsage\|serviceTierFromUsage" backend/src`.

- [ ] **Step 3: Write the contract test**

Create `backend/src/llm/llm.contract.spec.ts`:

```ts
import { AnthropicLlmProvider } from '../anthropic/anthropic.service';
import { LlmProvider } from './llm.provider';

describe('AnthropicLlmProvider satisfies the LlmProvider contract', () => {
  it('exposes every port method and full capabilities', () => {
    // Construct with stub deps (client factory unused until a call is made).
    const svc = new AnthropicLlmProvider(
      { get: () => { throw new Error('unused'); } } as any,
      { get: () => undefined } as any, // ConfigService
      { emit: () => true } as any,     // EventEmitter2
    );
    const port: LlmProvider = svc; // compile-time contract assertion
    expect(typeof port.messageStructured).toBe('function');
    expect(typeof port.uploadFile).toBe('function');
    expect(typeof port.submitBatch).toBe('function');
    expect(typeof port.getBatch).toBe('function');
    expect(typeof port.getBatchResults).toBe('function');
    expect(port.capabilities).toEqual({ batch: true, fileUpload: true, promptCaching: true, structuredOutput: true });
  });
});
```

> Match the real `AnthropicLlmProvider` constructor argument order when writing the stubs.

- [ ] **Step 4: Run the full suite**

Run: `cd backend && pnpm test`
Expected: PASS.

- [ ] **Step 5: Verify no Anthropic references leak into the benchmark**

Run: `grep -rn "@anthropic-ai/sdk\|AnthropicLlmProvider\|anthropic/anthropic.service\|anthropic.usage" backend/src/benchmark`
Expected: no matches (benchmark depends only on `llm/`).

- [ ] **Step 6: Commit**

```bash
git add backend/src/anthropic backend/src/cost/cost.types.ts backend/src/llm/llm.contract.spec.ts
git commit -m "refactor(llm): remove legacy shims, isolate Anthropic usage parsers, add contract test"
```

---

## Self-Review

**Spec coverage:**
- New `llm/` port module (types, interface, token, module) → Tasks 1, 4. ✔
- Anthropic adapter is sole SDK file → Tasks 3, 9 (envelope builder + benchmark stop importing the SDK; verified in Task 9 Step 5). ✔
- Single swap seam (LlmModule factory + `llm.provider` config) → Task 4. ✔
- Neutral types replace `CachedContext`/`BatchRequestInput`/`BatchResultItem`/raw beta blocks → Tasks 1, 4, 5, 6; deleted in 9. ✔
- `files: true` flag removed from benchmark view (adapter infers) → Tasks 3–6. ✔
- Capability flags exposed (no fallback paths built) → Tasks 1–3. ✔
- Cost/usage neutralization: neutral usage in results + event rename → Tasks 5, 8; parser move → 9. ✔
- `anthropicFileId` → `providerFileId` read-compat → Task 7. ✔
- Testing: FakeLlmProvider + per-consumer migration + contract test → Tasks 2, 4–7, 9. ✔
- Demo controller stays on concrete adapter → Task 3. ✔

**Placeholder scan:** No TBD/TODO; every code step shows real code or an exact edit. The two "match existing spec helper" notes reference existing test infrastructure the worker will see, not undefined behavior.

**Type consistency:** `PromptEnvelope.tiers`, `LlmCacheTier.blocks`, `LlmContentBlock` (`text`/`file`+`fileId`), `submitBatch(requests, envelope, opts)`, `BatchHandle.status`, `BatchItemResult.usage: UsageTokens`, `providerFileId`, `llm.usage`, `LLM_PROVIDER` are used consistently across all tasks. `messageStructured(req, attribution)` signature matches port and all call sites in Task 6.

**Risks (from spec) addressed:** faithful envelope translation asserted in Task 3 Step 1 (document shape + breakpoints via `buildEnvelopeRequest`); read-compat asserted in Task 7 Step 1; event rename coordinated in Task 8; global module wiring in Task 4.
