# Anthropic Prompt Caching (1h TTL) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add extendable 1-hour-TTL prompt caching to `AnthropicService` — a shared cache-control request builder, a `max_tokens: 0` pre-warm with report/strict verification, and cache-aware Batch API submission.

**Architecture:** One private `buildCachedRequest` primitive places the `cache_control` breakpoint in exactly one spot, so the warm-up and every batch item render a byte-identical prefix (the invariant prompt caching requires). `warmCache` writes the entry standalone (a `max_tokens: 0` request is rejected inside a batch) and verifies it via `usage`; `createBatch` gains an optional `context` arg so batch items read the warmed entry.

**Tech Stack:** NestJS, TypeScript, `@anthropic-ai/sdk`, Jest.

---

## File structure

- `backend/src/anthropic/anthropic.constants.ts` — add the reusable `ONE_HOUR_CACHE_CONTROL` breakpoint constant.
- `backend/src/anthropic/anthropic.service.ts` — add `CachedContext` / `CacheVerification` types, the private `buildCachedRequest` + `toVerification` helpers, public `warmCache`, cache-aware `createBatch`, and the `cacheReadInputTokens` field on `BatchResultItem`.
- `backend/src/anthropic/anthropic.service.spec.ts` — append a `caching` describe block (reuses the shared `create`/`batchesCreate`/`batchesResults` mocks and `service`).

All commands run from `backend/`.

---

### Task 1: Cache-control constant, types, primitive, and `warmCache` (report mode)

**Files:**
- Modify: `backend/src/anthropic/anthropic.constants.ts`
- Modify: `backend/src/anthropic/anthropic.service.ts`
- Test: `backend/src/anthropic/anthropic.service.spec.ts`

- [ ] **Step 1: Write the failing tests**

Append this block **inside** the outer `describe('AnthropicService', ...)`, immediately before its closing `}); // describe('AnthropicService')` line (so it reuses `create` and `service`):

```typescript
  describe('caching', () => {
  const CC = { type: 'ephemeral', ttl: '1h' };

  it('warmCache caches a system prompt with a 1h breakpoint and max_tokens 0', async () => {
    create.mockResolvedValue({
      model: 'claude-sonnet-5',
      usage: { cache_creation_input_tokens: 2048, cache_read_input_tokens: 0 },
    });
    const result = await service.warmCache({ system: 'big shared prompt' });
    expect(create).toHaveBeenCalledWith({
      model: 'claude-sonnet-5',
      max_tokens: 0,
      system: [{ type: 'text', text: 'big shared prompt', cache_control: CC }],
      messages: [{ role: 'user', content: 'warmup' }],
    });
    expect(result).toEqual({
      model: 'claude-sonnet-5',
      cacheCreationInputTokens: 2048,
      cacheReadInputTokens: 0,
      cached: true,
    });
  });

  it('warmCache caches a leading message prefix (no system key)', async () => {
    create.mockResolvedValue({
      model: 'claude-sonnet-5',
      usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 4096 },
    });
    const result = await service.warmCache({ prefix: 'shared context' });
    expect(create).toHaveBeenCalledWith({
      model: 'claude-sonnet-5',
      max_tokens: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'shared context', cache_control: CC },
            { type: 'text', text: 'warmup' },
          ],
        },
      ],
    });
    // read > 0 also counts as cached; creation 0 means the entry pre-existed.
    expect(result.cached).toBe(true);
    expect(result.cacheReadInputTokens).toBe(4096);
  });

  it('warmCache reports cached=false when nothing was written or read', async () => {
    create.mockResolvedValue({ model: 'claude-sonnet-5', usage: {} });
    const result = await service.warmCache({ system: 'too short' });
    expect(result).toEqual({
      model: 'claude-sonnet-5',
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cached: false,
    });
  });

  it('warmCache honours a model override', async () => {
    create.mockResolvedValue({ model: 'claude-opus-5', usage: {} });
    await service.warmCache({ system: 's' }, { model: 'claude-opus-5' });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-opus-5', max_tokens: 0 }),
    );
  });
  }); // describe('caching')
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest anthropic.service --silent 2>&1 | tail -20`
Expected: FAIL — `service.warmCache is not a function` (or a TS compile error that `warmCache` does not exist).

- [ ] **Step 3: Add the cache-control constant**

In `backend/src/anthropic/anthropic.constants.ts`, append after the `AnthropicClientFactory` interface:

```typescript
/**
 * 1-hour ephemeral cache breakpoint. A single frozen object reused across the
 * warm-up and every batch item so the rendered prefix stays byte-identical —
 * any drift in the prefix silently invalidates the cache.
 */
export const ONE_HOUR_CACHE_CONTROL = { type: 'ephemeral', ttl: '1h' } as const;
```

- [ ] **Step 4: Add types, primitive, verification helper, and `warmCache`**

In `backend/src/anthropic/anthropic.service.ts`:

Update the import line to pull in the new constant:

```typescript
import {
  ANTHROPIC_CLIENT,
  AnthropicClientFactory,
  ONE_HOUR_CACHE_CONTROL,
} from './anthropic.constants';
```

Add these interfaces after the existing `MessageResult` interface:

```typescript
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
  /** True when this call wrote OR read a cache entry. */
  cached: boolean;
}
```

Add these methods inside the `AnthropicService` class, after the `message` method:

```typescript
  /**
   * The one place a cache breakpoint is placed. The warm-up and batch items all
   * call this so they emit a byte-identical cached prefix at the same breakpoint.
   */
  private buildCachedRequest(
    context: CachedContext,
    prompt: string,
  ): {
    system?: Anthropic.TextBlockParam[];
    messages: Anthropic.MessageParam[];
  } {
    const system = context.system
      ? [
          {
            type: 'text' as const,
            text: context.system,
            cache_control: ONE_HOUR_CACHE_CONTROL,
          },
        ]
      : undefined;

    const messages: Anthropic.MessageParam[] = context.prefix
      ? [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: context.prefix,
                cache_control: ONE_HOUR_CACHE_CONTROL,
              },
              { type: 'text', text: prompt },
            ],
          },
        ]
      : [{ role: 'user', content: prompt }];

    return system ? { system, messages } : { messages };
  }

  private toVerification(resp: Anthropic.Message): CacheVerification {
    const creation = resp.usage?.cache_creation_input_tokens ?? 0;
    const read = resp.usage?.cache_read_input_tokens ?? 0;
    return {
      model: resp.model,
      cacheCreationInputTokens: creation,
      cacheReadInputTokens: read,
      cached: creation > 0 || read > 0,
    };
  }

  /**
   * Pre-warms the 1h cache for a shared prefix with a max_tokens:0 request (which
   * writes the cache but bills no output tokens). Standalone by necessity —
   * max_tokens:0 is rejected inside a Batches request. Returns usage-derived
   * verification; with { strict: true }, a second probe must read the cache or
   * this throws.
   */
  async warmCache(
    context: CachedContext,
    opts?: { model?: string; strict?: boolean },
  ): Promise<CacheVerification> {
    if (!context.system && !context.prefix) {
      throw new HttpException(
        { statusCode: 400, error: 'CachedContext requires system or prefix' },
        HttpStatus.BAD_REQUEST,
      );
    }
    const client = this.clientFactory.get();
    const model = opts?.model ?? this.defaultModel;
    const built = this.buildCachedRequest(context, 'warmup');
    try {
      const first = await client.messages.create({
        model,
        max_tokens: 0,
        ...built,
      });
      let verification = this.toVerification(first);
      if (opts?.strict) {
        const probe = await client.messages.create({
          model,
          max_tokens: 0,
          ...built,
        });
        verification = this.toVerification(probe);
        if (verification.cacheReadInputTokens <= 0) {
          throw new HttpException(
            { statusCode: 502, error: 'Prompt cache was not written' },
            HttpStatus.BAD_GATEWAY,
          );
        }
      }
      return verification;
    } catch (err) {
      this.rethrow(err);
    }
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest anthropic.service --silent 2>&1 | tail -20`
Expected: PASS — all `caching` tests plus the pre-existing `message`/`batches` tests green.

- [ ] **Step 6: Commit**

```bash
git add src/anthropic/anthropic.constants.ts src/anthropic/anthropic.service.ts src/anthropic/anthropic.service.spec.ts
git commit -m "feat(backend): add warmCache with 1h-TTL prompt caching primitive"
```

---

### Task 2: `warmCache` strict verification and empty-context guard

**Files:**
- Test: `backend/src/anthropic/anthropic.service.spec.ts`
- (No new production code — this task verifies behavior already implemented in Task 1.)

- [ ] **Step 1: Write the failing tests**

Add these `it` blocks inside the `describe('caching', ...)` block from Task 1 (before its closing line):

```typescript
  it('warmCache strict fires a verify probe and returns its read stats', async () => {
    create
      .mockResolvedValueOnce({
        model: 'claude-sonnet-5',
        usage: { cache_creation_input_tokens: 2048, cache_read_input_tokens: 0 },
      })
      .mockResolvedValueOnce({
        model: 'claude-sonnet-5',
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 2048 },
      });
    const result = await service.warmCache(
      { system: 'big shared prompt' },
      { strict: true },
    );
    expect(create).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      model: 'claude-sonnet-5',
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 2048,
      cached: true,
    });
  });

  it('warmCache strict throws 502 when the probe never reads the cache', async () => {
    create.mockResolvedValue({
      model: 'claude-sonnet-5',
      usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    let caught: unknown;
    try {
      await service.warmCache({ system: 'too short' }, { strict: true });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(502);
    expect((caught as HttpException).getResponse()).toEqual({
      statusCode: 502,
      error: 'Prompt cache was not written',
    });
  });

  it('warmCache throws 400 when the context has nothing to cache', async () => {
    let caught: unknown;
    try {
      await service.warmCache({});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `npx jest anthropic.service --silent 2>&1 | tail -20`
Expected: PASS — the strict and guard behavior implemented in Task 1 is now covered.

(If any fail, the fix is in Task 1's `warmCache`, not the test — re-check the strict branch and the empty-context guard.)

- [ ] **Step 3: Commit**

```bash
git add src/anthropic/anthropic.service.spec.ts
git commit -m "test(backend): cover warmCache strict verification and empty-context guard"
```

---

### Task 3: Cache-aware `createBatch`

**Files:**
- Modify: `backend/src/anthropic/anthropic.service.ts` (the `createBatch` method)
- Test: `backend/src/anthropic/anthropic.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Add this `it` block inside the `describe('caching', ...)` block:

```typescript
  it('createBatch stamps the cached prefix on every request when given a context', async () => {
    batchesCreate.mockResolvedValue({
      id: 'batch_9',
      processing_status: 'in_progress',
    });
    await service.createBatch(
      [{ prompt: 'a' }, { customId: 'c2', prompt: 'b' }],
      { system: 'shared sys', prefix: 'shared ctx' },
    );
    expect(batchesCreate).toHaveBeenCalledWith({
      requests: [
        {
          custom_id: 'request-0',
          params: {
            model: 'claude-sonnet-5',
            max_tokens: 4096,
            system: [{ type: 'text', text: 'shared sys', cache_control: CC }],
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: 'shared ctx', cache_control: CC },
                  { type: 'text', text: 'a' },
                ],
              },
            ],
          },
        },
        {
          custom_id: 'c2',
          params: {
            model: 'claude-sonnet-5',
            max_tokens: 4096,
            system: [{ type: 'text', text: 'shared sys', cache_control: CC }],
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: 'shared ctx', cache_control: CC },
                  { type: 'text', text: 'b' },
                ],
              },
            ],
          },
        },
      ],
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest anthropic.service -t "stamps the cached prefix" 2>&1 | tail -20`
Expected: FAIL — `createBatch` ignores the second argument, so `params` has no `system`/cached `messages` and the `toHaveBeenCalledWith` assertion mismatches. (The pre-existing no-context `createBatch` test still passes.)

- [ ] **Step 3: Update `createBatch` to accept an optional context**

In `backend/src/anthropic/anthropic.service.ts`, replace the entire `createBatch` method with:

```typescript
  async createBatch(
    requests: BatchRequestInput[],
    context?: CachedContext,
  ): Promise<BatchSummary> {
    const client = this.clientFactory.get();
    const model = this.defaultModel;
    const maxTokens = this.defaultMaxTokens;
    try {
      const batch = await client.messages.batches.create({
        requests: requests.map((r, i) => {
          const built = context
            ? this.buildCachedRequest(context, r.prompt)
            : { messages: [{ role: 'user' as const, content: r.prompt }] };
          return {
            custom_id: r.customId ?? `request-${i}`,
            params: {
              model,
              max_tokens: maxTokens,
              ...built,
            },
          };
        }),
      });
      return { batchId: batch.id, processingStatus: batch.processing_status };
    } catch (err) {
      this.rethrow(err);
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest anthropic.service --silent 2>&1 | tail -20`
Expected: PASS — the new context test plus the pre-existing no-context `createBatch` test (which asserts the exact `messages`-only params shape) both green.

- [ ] **Step 5: Commit**

```bash
git add src/anthropic/anthropic.service.ts src/anthropic/anthropic.service.spec.ts
git commit -m "feat(backend): cache-aware createBatch reuses the warmed prefix"
```

---

### Task 4: Surface cache-read tokens in batch results

**Files:**
- Modify: `backend/src/anthropic/anthropic.service.ts` (`BatchResultItem` + `getBatchResults`)
- Test: `backend/src/anthropic/anthropic.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Add this `it` block inside the `describe('caching', ...)` block:

```typescript
  it('getBatchResults surfaces cacheReadInputTokens for succeeded items', async () => {
    async function* gen() {
      yield {
        custom_id: 'a',
        result: {
          type: 'succeeded',
          message: {
            content: [{ type: 'text', text: 'ok' }],
            usage: { cache_read_input_tokens: 2048 },
          },
        },
      };
    }
    batchesResults.mockResolvedValue(gen());
    const results = await service.getBatchResults('batch_1');
    expect(results).toEqual([
      { customId: 'a', type: 'succeeded', text: 'ok', cacheReadInputTokens: 2048 },
    ]);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest anthropic.service -t "surfaces cacheReadInputTokens" 2>&1 | tail -20`
Expected: FAIL — the result lacks `cacheReadInputTokens`, so the `toEqual` mismatches.

- [ ] **Step 3: Add the field and populate it**

In `backend/src/anthropic/anthropic.service.ts`, add the optional field to `BatchResultItem`:

```typescript
export interface BatchResultItem {
  customId: string;
  type: string;
  text?: string;
  error?: string;
  /** Cache-read tokens for a succeeded item; lets callers confirm cache hits. */
  cacheReadInputTokens?: number;
}
```

Then, in `getBatchResults`, replace the `if (result.type === 'succeeded')` branch with:

```typescript
        if (result.type === 'succeeded') {
          let text = '';
          for (const block of result.message.content) {
            if (block.type === 'text') {
              text += block.text;
            }
          }
          const item: BatchResultItem = { customId, type: 'succeeded', text };
          const read = result.message.usage?.cache_read_input_tokens;
          // Only attach when present so existing (usage-less) results are unchanged.
          if (typeof read === 'number') {
            item.cacheReadInputTokens = read;
          }
          items.push(item);
        } else if (result.type === 'errored') {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest anthropic.service --silent 2>&1 | tail -20`
Expected: PASS — the new test green, and the pre-existing `getBatchResults` tests (whose mocks carry no `usage`, so the field stays omitted) still green.

- [ ] **Step 5: Commit**

```bash
git add src/anthropic/anthropic.service.ts src/anthropic/anthropic.service.spec.ts
git commit -m "feat(backend): expose cacheReadInputTokens in batch results"
```

---

### Task 5: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full anthropic suite**

Run: `npx jest anthropic 2>&1 | tail -25`
Expected: PASS — every spec in `src/anthropic/` (service, module, and the demo controller) green, no failures.

- [ ] **Step 2: Typecheck the build**

Run: `npm run build`
Expected: `tsc` completes with no errors (the new `cache_control` shapes and `CachedContext`/`CacheVerification` types compile).

- [ ] **Step 3: Lint the changed files**

Run: `npx eslint src/anthropic/anthropic.service.ts src/anthropic/anthropic.constants.ts src/anthropic/anthropic.service.spec.ts`
Expected: no errors.

- [ ] **Step 4: Final commit if anything changed**

If build/lint required fixes:

```bash
git add -A
git commit -m "chore(backend): fix build/lint for prompt-caching feature"
```

Otherwise nothing to commit — the feature is complete.

---

## Notes for the implementer

- **Byte-identical prefix is load-bearing.** Do not inline `{ type: 'ephemeral', ttl: '1h' }` at call sites — always use `ONE_HOUR_CACHE_CONTROL`, and route all breakpoint placement through `buildCachedRequest`. A differing prefix between warm-up and batch means zero cache reads.
- **`max_tokens: 0`** returns immediately with empty content and bills no output tokens; the cache write still occurs at the breakpoint. It is rejected inside a Batches request, which is why `warmCache` is a standalone `messages.create`.
- **Minimum cacheable prefix is model-dependent** (512 tokens on Opus 5 / Fable 5; 1024 on Sonnet 5 / Opus 4.8; up to 4096 on Opus 4.6 / Haiku 4.5). A prefix under the minimum yields `cached: false` (report mode) or a 502 (strict) — that is expected feedback that the prefix is too short, not a bug.
- **`rethrow` already re-throws `HttpException` as-is**, so the 400 guard and 502 strict-failure surface with their intended status even though they are thrown inside the `try`.
