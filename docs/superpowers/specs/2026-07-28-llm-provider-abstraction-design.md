# Design: Abstract the LLM provider behind a neutral port

**Date:** 2026-07-28
**Status:** Approved (design)
**Scope:** Backend (`backend/src`)

## Problem

The benchmark module is hard-wired to Anthropic. Six benchmark providers inject
`AnthropicService`, import Anthropic-named types (`CachedContext`,
`BatchRequestInput`, `BatchResultItem`), and — worst — construct raw
`@anthropic-ai/sdk` content-block shapes (`Anthropic.Beta.BetaContentBlockParam`,
including Files-API `document`/`file_id` blocks) directly inside
`envelope.builder.ts` and `seven-keys.service.ts`. Anthropic-specific concepts
(the Batch API, the Files API `files: true` beta flag, explicit 1h prompt-cache
breakpoints, the `anthropic.usage` event) are threaded throughout.

This is pre-work before a second LLM provider is introduced. The goal: make the
benchmark module depend on a provider-neutral interface so a future provider can
be dropped in and run against the same benchmark, with a single swap point.

## Goals

- The benchmark module never imports `@anthropic-ai/sdk` or names Anthropic.
- Anthropic becomes one adapter behind a neutral `LlmProvider` port.
- Exactly one swap seam (a config-driven factory) selects the active provider.
- Capability flags exist for future providers to guard on — but no speculative
  capability-fallback execution paths are built now (YAGNI; there is no second
  provider to validate them against).
- Full backend test suite stays green; benchmark specs prove provider-agnosticism
  by running against a fake provider.

## Non-goals

- No new provider is implemented in this refactor.
- No capability-fallback paths (e.g. emulating batch via concurrent sync calls)
  for providers lacking batch/files/caching — deferred until a real provider lands.
- The demo controller (`demo/anthropic-demo.controller.ts`) stays on the concrete
  Anthropic adapter; it is a demo, not part of the benchmark.
- No pricing/cost-record changes; only the usage *event channel name* is renamed.

## Decisions (resolved during brainstorming)

- **Target provider:** unknown — design a capability-based, general interface.
- **Interface shape:** capability-based port (not a thin 1:1 mirror, not a
  batch-required interface).
- **Blast radius:** neutralize the seam fully — neutral usage tokens, rename the
  usage event, and read-compat rename the persisted `anthropicFileId`.
- **Architecture:** new `llm/` port module + Anthropic adapter (Approach A).
- **`message()` / `warmCache()`:** kept OFF the port (adapter-only). `message` is
  demo-only; `warmCache` has zero production callers (the benchmark warms via
  throwaway batches because Anthropic caches are per-service-tier) and encodes an
  Anthropic-specific cache concept.
- **Event rename `anthropic.usage` → `llm.usage`:** safe — it is an in-process
  EventEmitter2 channel with only internal emitters/listeners; no external
  consumer, no payload/data change.

## Architecture

### Module structure

New provider-neutral module `backend/src/llm/`:

```
llm/
  llm.types.ts        # neutral domain types
  llm.provider.ts     # LlmProvider interface (the port) + LlmCapabilities
  llm.constants.ts    # LLM_PROVIDER injection token
  llm.module.ts       # @Global; binds LLM_PROVIDER -> configured adapter via factory
```

The Anthropic adapter stays inside `anthropic/`:

- `anthropic.service.ts`: `AnthropicService` becomes `AnthropicLlmProvider
  implements LlmProvider`. It remains the ONLY file importing `@anthropic-ai/sdk`
  (besides `anthropic.module.ts` / `anthropic.constants.ts`, which build the
  client).
- `AnthropicModule` exports `AnthropicLlmProvider` (and keeps exporting the
  concrete class for the demo controller).

### DI wiring / the swap seam

`LlmModule` (`@Global`) imports `AnthropicModule` and provides:

```ts
{
  provide: LLM_PROVIDER,
  inject: [ConfigService, AnthropicLlmProvider],
  useFactory: (cfg: ConfigService, anthropic: AnthropicLlmProvider): LlmProvider => {
    switch (cfg.get<string>('llm.provider') ?? 'anthropic') {
      case 'anthropic':
        return anthropic;
      default:
        throw new Error(`Unknown llm.provider: ${cfg.get('llm.provider')}`);
    }
  },
}
```

Exports `LLM_PROVIDER`. This factory is the single swap point for future providers.

`benchmark.module.ts`: drop the `AnthropicModule` import; rely on `LlmModule`
(global) for `LLM_PROVIDER`. Every benchmark provider injects
`@Inject(LLM_PROVIDER) private readonly llm: LlmProvider`.

New config key `llm.provider` (default `'anthropic'`). Existing `anthropic.*`
config (apiKey, model, maxTokens) is unchanged and read by the adapter.

## Neutral type system (`llm.types.ts`)

```ts
// Replaces raw Anthropic.Beta.BetaContentBlockParam leaking into the benchmark.
export type LlmContentBlock =
  | { type: 'text'; text: string }
  | { type: 'file'; fileId: string };   // was { type:'document', source:{type:'file', file_id} }

export interface LlmCacheTier { blocks: LlmContentBlock[]; } // one cache breakpoint per tier

// Replaces CachedContext.
export interface PromptEnvelope {
  system?: string;
  tiers?: LlmCacheTier[];
}

export interface StructuredRequest {
  prompt: string;
  system?: string;
  envelope?: PromptEnvelope;
  schema?: unknown;   // JSON schema
  model?: string;
  effort?: string;
  maxTokens?: number;
}

// Replaces BatchRequestInput.
export interface BatchItemRequest {
  customId?: string;
  prompt: string;
  envelope?: PromptEnvelope;
}

export interface BatchSubmitOptions {
  model?: string;
  schema?: unknown;
  maxTokens?: number;
  effort?: string;
}

// Neutral batch lifecycle (was Anthropic processing_status strings).
export type BatchLifecycle =
  | 'submitted' | 'in_progress' | 'ended' | 'canceled' | 'expired' | 'errored';

export interface BatchHandle {
  batchId: string;
  status: BatchLifecycle;
  requestCounts?: unknown;
}

// Replaces BatchResultItem — usage is neutral UsageTokens, not raw SDK usage.
export interface BatchItemResult {
  customId: string;
  type: 'succeeded' | 'refusal' | 'errored' | 'canceled' | 'expired' | string;
  text?: string;
  error?: string;
  cacheReadTokens?: number;
  usage?: UsageTokens; // from cost/cost.types, adapter-parsed
}

export interface LlmCapabilities {
  batch: boolean;
  fileUpload: boolean;
  promptCaching: boolean;
  structuredOutput: boolean;
}
```

Effects: the `files: true` beta flag disappears from the benchmark's view (the
adapter infers the beta/files path when an envelope contains a `file` block); the
raw `document`/`file_id` shape is gone; batch statuses are a neutral union.

Type dependency direction: `llm/` imports the neutral `Attribution` and
`UsageTokens` types from `cost/cost.types.ts`. This is intentional — those types
are provider-neutral domain concepts. `cost/` imports nothing from `llm/`, so there
is no cycle (adapter and benchmark both depend on `llm/` and `cost/`).

## The `LlmProvider` interface (`llm.provider.ts`)

```ts
export interface LlmProvider {
  readonly capabilities: LlmCapabilities;

  messageStructured<T = unknown>(req: StructuredRequest, attribution: Attribution): Promise<T>;

  uploadFile(bytes: Buffer, filename: string, mediaType: string): Promise<string>; // neutral fileId

  submitBatch(
    requests: BatchItemRequest[],
    envelope: PromptEnvelope | undefined,
    opts: BatchSubmitOptions,
  ): Promise<BatchHandle>;
  getBatch(batchId: string): Promise<BatchHandle>;
  getBatchResults(batchId: string): Promise<BatchItemResult[]>;
}
```

- `message()` and `warmCache()` are NOT on the port. They remain public on
  `AnthropicLlmProvider` for the demo controller.
- `attribution` (from `cost/cost.types.ts`) stays a required argument; it is
  already a neutral type.

## Anthropic adapter responsibilities

`AnthropicLlmProvider` is the sole translation layer:

- `capabilities = { batch: true, fileUpload: true, promptCaching: true, structuredOutput: true }`.
- Owns `buildCachedRequest` (moved from today's service), now consuming
  `PromptEnvelope`/`LlmContentBlock`: maps `{type:'file', fileId}` →
  `{type:'document', source:{type:'file', file_id}}`; maps each `LlmCacheTier` to
  one 1h `cache_control` breakpoint on the tier's last block; keeps the
  ≤4-breakpoint guard.
- Infers the beta/files path itself: if any envelope block is `type:'file'`, route
  through `client.beta.messages.*` with `FILES_BETA`. The benchmark no longer
  passes `files: true` anywhere.
- Maps Anthropic `processing_status` → neutral `BatchLifecycle`; maps batch result
  entries → `BatchItemResult` with neutral `usage: tokensFromUsage(...)`.
- Keeps `rethrow` (SDK-error → `HttpException`) internal.
- Keeps `message()` and `warmCache()` public for the demo controller.
- `tokensFromUsage` / `serviceTierFromUsage` MOVE from `cost/cost.types.ts` into
  the adapter (they parse Anthropic SDK usage shapes). The neutral `UsageTokens`,
  `ServiceTier`, `Attribution`, `UsageEvent`, `CostRecord`, and pricing stay in
  `cost/`.

## Benchmark consumer rewiring

| File | Change |
|---|---|
| `benchmark.service.ts` | Inject `LLM_PROVIDER`; `BatchRequestInput`→`BatchItemRequest`; `createBatch(...)`→`submitBatch(...)`; drop `files:true`; neutral `BatchHandle`. |
| `batch-reconciler.ts` | Inject `LLM_PROVIDER`; `getBatch`/`getBatchResults` drop `{files:true}`; compare against neutral `BatchLifecycle`; stop importing `tokensFromUsage`; emit `llm.usage` with the neutral `item.usage`. |
| `cache-warmer.ts` | Inject `LLM_PROVIDER`; `createBatch`→`submitBatch`; drop `files:true`; build `PromptEnvelope`. |
| `day-artifacts.service.ts` | Inject `LLM_PROVIDER`; `uploadFile` signature unchanged (returns neutral fileId); persisted field rename (below). |
| `seven-keys.service.ts` | Inject `LLM_PROVIDER`; `CachedContext`→`PromptEnvelope`; build neutral `{type:'file', fileId}` blocks; move `messageStructured` opts into the `StructuredRequest` object. |
| `envelope.builder.ts` | Drop `import Anthropic`; return `PromptEnvelope` / `LlmCacheTier[]` of `LlmContentBlock`; the day-PDF block becomes `{type:'file', fileId: bundle.fileId}`. |

`DayBundle.anthropicFileId` → `fileId` (in-memory rename).

## Cost / usage neutralization

- Rename the event `'anthropic.usage'` → `'llm.usage'` at both emit sites
  (adapter sync path, reconciler batch path) and the `@OnEvent` in
  `cost.service.ts`.
- The reconciler emits `llm.usage` using the neutral `UsageTokens` the port
  returned — no SDK-shape parsing in the benchmark.
- `UsageEvent.source: 'sync' | 'batch'` and `ServiceTier` stay as-is (already
  generic). No pricing changes; the payload and persisted `CostRecord` are
  unchanged (only the channel name changes).

## Persisted field rename (`anthropicFileId` → `providerFileId`)

`DayArtifactDoc.anthropicFileId` (Firestore) → `providerFileId`. Because existing
docs hold `anthropicFileId`:

- Write `providerFileId` going forward.
- Read with a back-compat fallback: `doc.providerFileId ?? doc.anthropicFileId`.
- Keep `anthropicFileId?` in the type as `@deprecated` for the read shim. No data
  migration script; fields converge as artifacts are re-touched.

## Testing strategy

- New `FakeLlmProvider` test double implementing `LlmProvider` (in-memory batch
  store, canned structured responses, capability flags). Benchmark unit specs
  (`benchmark.service`, `batch-reconciler`, `cache-warmer`, `day-artifacts`,
  `seven-keys`, `envelope.builder`) switch from mocking `AnthropicService` to the
  fake — proving the benchmark is provider-agnostic.
- `anthropic.service.spec.ts` becomes the adapter spec (translation correctness:
  neutral envelope → SDK blocks, file-path inference, status/usage mapping). The
  SDK-mocking tests mostly carry over.
- A shared contract test asserts `AnthropicLlmProvider` satisfies the
  `LlmProvider` shape and capability flags — reusable by the next adapter.
- Full `pnpm test` (backend Jest) stays green; TDD per task.

## Risks / edge cases

- **Faithful envelope translation:** the neutral `LlmContentBlock`/`LlmCacheTier`
  types must reproduce today's exact cache-breakpoint placement (one per tier,
  last block) and the file-document shape, or cache reuse silently breaks. The
  adapter spec must assert byte/shape equivalence with today's `buildCachedRequest`
  output.
- **Persisted-field read compat:** any read path that consumed `anthropicFileId`
  must go through the `providerFileId ?? anthropicFileId` fallback, or already
  stored days lose their file reference and re-upload unnecessarily.
- **Event rename coordination:** emit sites and the single `@OnEvent` listener
  must change together, plus the specs asserting the event name; a missed site
  silently drops cost capture.
- **`benchmark.module` global wiring:** `LlmModule` must be initialized (global)
  before benchmark providers resolve `LLM_PROVIDER`; verify app bootstrap and the
  test module setups.
