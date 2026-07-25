# Anthropic Prompt Caching (1h TTL) — Design Spec

Date: 2026-07-25
Status: Approved (brainstorming complete)

## Problem

`AnthropicService` submits Batch API jobs where every request shares a large,
identical prefix (system prompt and/or leading context). Today that prefix is
re-processed at full input-token price on every batch item. We want to:

1. Add **extendable** prompt-caching logic that stamps a **1-hour TTL** cache
   breakpoint onto shared content.
2. **Pre-warm** the cache with a `max_tokens: 0` request so the entry is written
   before the batch runs.
3. Provide a **verification** mechanism to confirm the cache was written/read.
4. Reuse the same primitive for **Batch API** requests so batch items read the
   warmed cache.

## Key constraints (from the Anthropic prompt-caching contract)

- **Prefix match.** Caching keys off the exact bytes of the rendered prompt up to
  each `cache_control` breakpoint. Any byte change anywhere in the prefix
  invalidates everything after it. The warm-up and the batch requests must render
  a **byte-identical** prefix at the **same** breakpoint — hence a single shared
  builder.
- **`max_tokens: 0` is rejected inside a Message Batches request.** The warm-up
  must therefore be a standalone `messages.create` call, not a batch item.
- **A cache entry becomes readable only after the first response begins.** A
  sequential warm → verify probe reads the entry the warm-up just wrote.
- **Minimum cacheable prefix is model-dependent** (512 tokens on Opus 5 / Fable 5;
  1024 on Sonnet 5 / Opus 4.8; up to 4096 on Opus 4.6 / Haiku 4.5). A prefix below
  the minimum silently does not cache (`cache_creation_input_tokens: 0`, no error).
- **1h TTL costs a 2× write premium** (vs 1.25× for the 5-minute default), breaking
  even at ~3 reads. Appropriate here because a batch has many reads against one
  write and may run with gaps longer than 5 minutes.
- **Verify with `usage`.** `cache_creation_input_tokens` (tokens written this
  request) and `cache_read_input_tokens` (tokens served from cache) are the source
  of truth. Zero reads across identical-prefix requests means a silent invalidator.

## Architecture

One private request-builder primitive, reused by the warm-up, single messages
(future), and the batch. All new code lives in the existing
`backend/src/anthropic/` module — no new service class.

```
buildCachedRequest(context, prompt)   ← the one place breakpoints are placed
        │
        ├── warmCache()      (standalone messages.create, max_tokens: 0)
        └── createBatch()    (each batch item renders the same cached prefix)
```

### Constant (`anthropic.constants.ts`)

```ts
// 1-hour ephemeral cache breakpoint. Byte-stable object reused everywhere so the
// rendered prefix never drifts.
export const ONE_HOUR_CACHE_CONTROL = { type: 'ephemeral', ttl: '1h' } as const;
```

### Types (`anthropic.service.ts`)

```ts
export interface CachedContext {
  /** Cached (1h TTL) system prompt shared across requests. */
  system?: string;
  /** Cached (1h TTL) leading user-message block shared across requests. */
  prefix?: string;
}

export interface CacheVerification {
  model: string;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** True when this call wrote OR read a cache entry (creation > 0 || read > 0). */
  cached: boolean;
}
```

Both `system` and `prefix` are optional and independently cacheable ("both,
configurable"). A context with neither field is a caller error.

### The extendable primitive

```ts
private buildCachedRequest(
  context: CachedContext,
  prompt: string,
): { system?: Anthropic.TextBlockParam[]; messages: Anthropic.MessageParam[] }
```

- When `context.system` is set: `system` is a one-element array of a text block
  carrying `cache_control: ONE_HOUR_CACHE_CONTROL` on the (last) block.
- When `context.prefix` is set: the user message content is
  `[{ type: 'text', text: prefix, cache_control: ONE_HOUR_CACHE_CONTROL },
    { type: 'text', text: prompt }]` — breakpoint on the shared prefix, varying
  `prompt` after it (uncached).
- When `context.prefix` is absent: the user message content is the plain `prompt`
  string.
- Breakpoint placement lives **only** here, so every caller emits an identical
  prefix. This is the invariant caching depends on.

### `warmCache` — pre-warm + verify

```ts
async warmCache(
  context: CachedContext,
  opts?: { model?: string; strict?: boolean },
): Promise<CacheVerification>
```

Behavior:
1. Throw `HttpException(400)` if `context` has neither `system` nor `prefix`
   (nothing to warm).
2. Build the request via `buildCachedRequest(context, 'warmup')` — `'warmup'` is a
   non-whitespace placeholder user turn (read during prefill, never answered).
3. Call `messages.create` with `max_tokens: 0`, the built `system`/`messages`, and
   the resolved model. `max_tokens: 0` returns immediately with empty content and
   bills zero output tokens; the cache write still happens at the breakpoint.
4. Read `usage.cache_creation_input_tokens` / `cache_read_input_tokens` (defaulting
   nullish to 0) into a `CacheVerification`.
5. If `opts.strict`: fire a **second** identical warm request (also `max_tokens: 0`)
   and require `cache_read_input_tokens > 0`; otherwise throw
   `HttpException(502, 'Prompt cache was not written')`. Return the second probe's
   verification (which shows the read). The sequential ordering guarantees the
   entry written by step 3 is readable by step 5.
6. Non-strict: return step 3's verification. `cached: false` (too-short prefix or
   silent invalidator) is reported, not thrown.

Errors flow through the existing `rethrow` mapper (SDK errors → Nest
`HttpException`, 5xx sanitized).

### `createBatch` — cache-aware batch

```ts
async createBatch(
  requests: BatchRequestInput[],
  context?: CachedContext,
): Promise<BatchSummary>
```

- Backward compatible: `context` is optional; the existing demo controller caller
  (no second arg) is unchanged and produces the same uncached requests as today.
- When `context` is provided, each request's `params` is built with
  `buildCachedRequest(context, r.prompt)` so every item renders the same cached
  prefix and reads the warmed entry.
- Model/max-tokens defaults unchanged.

### Batch-side verification

Extend the result shape so callers can confirm the batch actually hit the cache:

```ts
export interface BatchResultItem {
  customId: string;
  type: string;
  text?: string;
  error?: string;
  cacheReadInputTokens?: number; // from succeeded result usage
}
```

`getBatchResults` reads `result.message.usage.cache_read_input_tokens` for
succeeded items. Existing callers ignore the new optional field.

## Data flow (batch usage)

```
1. warmCache(context, { strict: true })     → writes 1h cache entry, verifies read
2. createBatch(requests, context)           → submits batch; items read the entry
3. getBatch(id) / getBatchResults(id)       → poll; per-item cacheReadInputTokens
                                               confirms cache hits
```

## Testing (TDD)

Unit tests against a mocked SDK client (`anthropic.service.spec.ts`):

- `buildCachedRequest` (exercised through public methods): system-only, prefix-only,
  and both produce a 1h-TTL `cache_control` on the correct (last shared) block; a
  plain string when no prefix.
- `warmCache` sends `max_tokens: 0` and returns usage-derived `CacheVerification`
  with `cached` computed from creation/read.
- `warmCache({ strict: true })` throws when the verify probe reports zero cache
  reads; succeeds when it reports > 0.
- `warmCache` throws 400 on an empty `CachedContext`.
- `createBatch(requests, context)` stamps `cache_control` on every request's params;
  `createBatch(requests)` (no context) is byte-for-byte the current behavior.
- `getBatchResults` surfaces `cacheReadInputTokens` for succeeded items.

## Out of scope

- Wiring cache warming into the demo controller endpoints (this spec adds the
  service capability; endpoint wiring, if wanted, is a follow-up).
- 5-minute-TTL caching and top-level automatic caching (fixed at 1h per the
  requirement).
- Cross-model cache reuse (caches are model-scoped; the caller passes one model).
