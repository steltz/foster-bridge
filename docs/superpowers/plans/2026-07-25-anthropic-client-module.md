# Anthropic API Client Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `AnthropicModule` to the existing `backend/` NestJS app that wraps `@anthropic-ai/sdk` as a Claude client, with demo endpoints for a single message and the Message Batches API — building and testing green now, before an `ANTHROPIC_API_KEY` exists.

**Architecture:** A global `AnthropicModule` exposes a **lazy** `ANTHROPIC_CLIENT` factory (constructs `new Anthropic()` on first use, never at boot, so a missing key doesn't break startup) and an `AnthropicService` wrapping `messages.create` and `messages.batches.*`. A demo controller exposes `/ai/*` routes. SDK errors are caught and rethrown as Nest `HttpException`s, which the existing global `GoogleErrorFilter` passes through untouched.

**Tech Stack:** NestJS 10, TypeScript 5, `@anthropic-ai/sdk` ^0.115.0, `@nestjs/config`, Jest + Supertest, pnpm, Node ≥ 20. Default model `claude-sonnet-5`.

---

## File Structure

```
backend/
  package.json                              # add @anthropic-ai/sdk
  src/
    config/
      configuration.ts                      # + anthropic config block
      configuration.spec.ts                 # unit: anthropic defaults (new)
    anthropic/
      anthropic.constants.ts                # ANTHROPIC_CLIENT token + types
      anthropic.module.ts                   # global: lazy client factory
      anthropic.module.spec.ts              # unit: lazy + memoized + no-key throw
      anthropic.service.ts                  # message + batch methods
      anthropic.service.spec.ts             # unit: shaping, refusal, error map, batch
    demo/
      anthropic-demo.controller.ts          # /ai routes
      anthropic-demo.controller.spec.ts     # unit: route wiring
    app.module.ts                           # import AnthropicModule + controller
  test/
    anthropic-ready.e2e-spec.ts             # e2e: GET /ai/ready -> 200 {configured:false}
  .env.example                              # + ANTHROPIC_* vars
  README.md                                 # + Anthropic section
```

---

## Task 1: Add the SDK dependency and Anthropic config

**Files:**
- Modify: `backend/package.json`
- Modify: `backend/src/config/configuration.ts`
- Test: `backend/src/config/configuration.spec.ts`

- [ ] **Step 1: Add `@anthropic-ai/sdk` to `backend/package.json` dependencies**

Run: `cd backend && pnpm add "@anthropic-ai/sdk@^0.115.0"`
Expected: `package.json` gains `"@anthropic-ai/sdk": "^0.115.0"` and `pnpm-lock.yaml` updates.

- [ ] **Step 2: Write the failing test `backend/src/config/configuration.spec.ts`**

```ts
import configuration from './configuration';

describe('configuration (anthropic)', () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.ANTHROPIC_MAX_TOKENS;
  });
  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('defaults model to claude-sonnet-5 and max tokens to 4096, apiKey undefined', () => {
    const config = configuration();
    expect(config.anthropic.model).toBe('claude-sonnet-5');
    expect(config.anthropic.maxTokens).toBe(4096);
    expect(config.anthropic.apiKey).toBeUndefined();
  });

  it('reads env overrides', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.ANTHROPIC_MODEL = 'claude-opus-5';
    process.env.ANTHROPIC_MAX_TOKENS = '8192';
    const config = configuration();
    expect(config.anthropic).toEqual({
      apiKey: 'sk-test',
      model: 'claude-opus-5',
      maxTokens: 8192,
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd backend && pnpm test configuration`
Expected: FAIL — `config.anthropic` is undefined.

- [ ] **Step 4: Update `backend/src/config/configuration.ts`**

Replace the file contents with:

```ts
export interface AppConfig {
  port: number;
  firebase: {
    projectId: string;
    storageBucket: string;
  };
  anthropic: {
    apiKey?: string;
    model: string;
    maxTokens: number;
  };
}

export default (): AppConfig => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  firebase: {
    projectId:
      process.env.FIREBASE_PROJECT_ID ??
      process.env.GCLOUD_PROJECT ??
      'app-foster-bridge',
    storageBucket:
      process.env.FIREBASE_STORAGE_BUCKET ??
      'app-foster-bridge.firebasestorage.app',
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5',
    maxTokens: parseInt(process.env.ANTHROPIC_MAX_TOKENS ?? '4096', 10),
  },
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && pnpm test configuration`
Expected: PASS — both tests green.

- [ ] **Step 6: Verify the build compiles**

Run: `cd backend && pnpm build`
Expected: no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add backend/package.json backend/pnpm-lock.yaml backend/src/config
git commit -m "feat(backend): add @anthropic-ai/sdk dependency and anthropic config"
```

---

## Task 2: AnthropicModule with a lazy, memoized client factory

**Files:**
- Create: `backend/src/anthropic/anthropic.constants.ts`
- Create: `backend/src/anthropic/anthropic.module.ts`
- Test: `backend/src/anthropic/anthropic.module.spec.ts`

Note: `AnthropicModule` (below) imports `AnthropicService`, which is created in Task 3. To keep Task 2 self-contained and compilable, create a **minimal placeholder** `anthropic.service.ts` in this task (Step 4), then flesh it out in Task 3.

- [ ] **Step 1: Create `backend/src/anthropic/anthropic.constants.ts`**

```ts
import type Anthropic from '@anthropic-ai/sdk';

export const ANTHROPIC_CLIENT = Symbol('ANTHROPIC_CLIENT');

/**
 * Lazily constructs and memoizes the Anthropic SDK client. `get()` throws an
 * UnauthorizedException when no API key is configured, and never constructs
 * the client at module init — so the app boots without a key.
 */
export interface AnthropicClientFactory {
  get(): Anthropic;
}
```

- [ ] **Step 2: Write the failing test `backend/src/anthropic/anthropic.module.spec.ts`**

Mocks the SDK default export so no real client is constructed and construction can be counted.

```ts
// `default` must be the jest.fn itself (not an arrow wrapper) — the module
// does `new Anthropic(...)`, and arrow functions are not constructable.
const AnthropicCtor = jest.fn().mockImplementation(() => ({ __client: true }));
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: AnthropicCtor,
}));

import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { AnthropicModule } from './anthropic.module';
import { ANTHROPIC_CLIENT, AnthropicClientFactory } from './anthropic.constants';
import configuration from '../config/configuration';

describe('AnthropicModule client factory', () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    AnthropicCtor.mockClear();
    process.env = { ...OLD_ENV };
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterAll(() => {
    process.env = OLD_ENV;
  });

  async function buildFactory(): Promise<AnthropicClientFactory> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
        AnthropicModule,
      ],
    }).compile();
    return moduleRef.get<AnthropicClientFactory>(ANTHROPIC_CLIENT);
  }

  it('does not construct the SDK client at module init (lazy)', async () => {
    await buildFactory();
    expect(AnthropicCtor).not.toHaveBeenCalled();
  });

  it('throws UnauthorizedException from get() when no API key is set', async () => {
    const factory = await buildFactory();
    expect(() => factory.get()).toThrow(UnauthorizedException);
    expect(AnthropicCtor).not.toHaveBeenCalled();
  });

  it('constructs once and memoizes when the key is set', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const factory = await buildFactory();
    const a = factory.get();
    const b = factory.get();
    expect(a).toBe(b);
    expect(AnthropicCtor).toHaveBeenCalledTimes(1);
    expect(AnthropicCtor).toHaveBeenCalledWith({ apiKey: 'sk-test' });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd backend && pnpm test anthropic.module`
Expected: FAIL — cannot find module `./anthropic.module`.

- [ ] **Step 4: Create a placeholder `backend/src/anthropic/anthropic.service.ts`**

Minimal for now; Task 3 replaces it fully.

```ts
import { Injectable } from '@nestjs/common';

@Injectable()
export class AnthropicService {}
```

- [ ] **Step 5: Create `backend/src/anthropic/anthropic.module.ts`**

```ts
import {
  Global,
  Module,
  Provider,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_CLIENT, AnthropicClientFactory } from './anthropic.constants';
import { AnthropicService } from './anthropic.service';

const anthropicClientProvider: Provider = {
  provide: ANTHROPIC_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): AnthropicClientFactory => {
    let client: Anthropic | undefined;
    return {
      get(): Anthropic {
        if (!client) {
          const apiKey = config.get<string>('anthropic.apiKey');
          if (!apiKey) {
            // Constructing `new Anthropic()` with no key throws; surface a
            // clean 401 instead. Also keeps module init from ever constructing.
            throw new UnauthorizedException(
              'ANTHROPIC_API_KEY is not configured',
            );
          }
          client = new Anthropic({ apiKey });
        }
        return client;
      },
    };
  },
};

@Global()
@Module({
  providers: [anthropicClientProvider, AnthropicService],
  exports: [ANTHROPIC_CLIENT, AnthropicService],
})
export class AnthropicModule {}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd backend && pnpm test anthropic.module`
Expected: PASS — all three tests green.

- [ ] **Step 7: Verify the build compiles**

Run: `cd backend && pnpm build`
Expected: no TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add backend/src/anthropic
git commit -m "feat(backend): add AnthropicModule with lazy client factory"
```

---

## Task 3: AnthropicService.message (shaping, refusal, error mapping)

**Files:**
- Create/replace: `backend/src/anthropic/anthropic.service.ts`
- Test: `backend/src/anthropic/anthropic.service.spec.ts`

- [ ] **Step 1: Write the failing test `backend/src/anthropic/anthropic.service.spec.ts`**

The SDK is mocked so `Anthropic.APIError` is a controllable class and no real client is constructed. The client is injected via the `ANTHROPIC_CLIENT` token as a stub.

```ts
class FakeAPIError extends Error {
  status?: number;
  constructor(status: number | undefined, message: string) {
    super(message);
    this.status = status;
  }
}

jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: Object.assign(function () {}, { APIError: FakeAPIError }),
}));

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpException } from '@nestjs/common';
import { AnthropicService } from './anthropic.service';
import { ANTHROPIC_CLIENT } from './anthropic.constants';

// One shared outer describe so Task 4 can append a `batches` block that reuses
// `service` and the batch mocks — the full client (with batches) is set up here.
describe('AnthropicService', () => {
  let create: jest.Mock;
  let batchesCreate: jest.Mock;
  let batchesRetrieve: jest.Mock;
  let batchesResults: jest.Mock;
  let service: AnthropicService;

  beforeEach(async () => {
    create = jest.fn();
    batchesCreate = jest.fn();
    batchesRetrieve = jest.fn();
    batchesResults = jest.fn();
    const fakeClient = {
      messages: {
        create,
        batches: {
          create: batchesCreate,
          retrieve: batchesRetrieve,
          results: batchesResults,
        },
      },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AnthropicService,
        { provide: ANTHROPIC_CLIENT, useValue: { get: () => fakeClient } },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'anthropic.model'
                ? 'claude-sonnet-5'
                : key === 'anthropic.maxTokens'
                  ? 4096
                  : undefined,
          },
        },
      ],
    }).compile();
    service = moduleRef.get(AnthropicService);
  });

  describe('message', () => {
  it('returns concatenated text and passes model + max_tokens + user message', async () => {
    create.mockResolvedValue({
      model: 'claude-sonnet-5',
      stop_reason: 'end_turn',
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'text', text: ' world' },
      ],
      usage: { input_tokens: 3, output_tokens: 2 },
    });
    const result = await service.message({ prompt: 'hi' });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-sonnet-5',
        max_tokens: 4096,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(result).toEqual({
      model: 'claude-sonnet-5',
      text: 'Hello world',
      stopReason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 2 },
    });
  });

  it('includes system when provided and honours model/maxTokens overrides', async () => {
    create.mockResolvedValue({
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      content: [],
      usage: {},
    });
    await service.message({
      prompt: 'hi',
      system: 'be terse',
      model: 'claude-opus-5',
      maxTokens: 100,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-opus-5',
        max_tokens: 100,
        system: 'be terse',
      }),
    );
  });

  it('returns null text on a refusal stop_reason', async () => {
    create.mockResolvedValue({
      model: 'claude-sonnet-5',
      stop_reason: 'refusal',
      content: [],
      usage: {},
    });
    const result = await service.message({ prompt: 'x' });
    expect(result.text).toBeNull();
    expect(result.stopReason).toBe('refusal');
  });

  it('maps an SDK APIError to an HttpException with the same status', async () => {
    const Anthropic = require('@anthropic-ai/sdk').default;
    create.mockRejectedValue(new Anthropic.APIError(429, 'rate limited'));
    let caught: unknown;
    try {
      await service.message({ prompt: 'x' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(429);
  });

  it('defaults an APIError with no status to 502', async () => {
    const Anthropic = require('@anthropic-ai/sdk').default;
    create.mockRejectedValue(new Anthropic.APIError(undefined, 'connection'));
    let caught: unknown;
    try {
      await service.message({ prompt: 'x' });
    } catch (e) {
      caught = e;
    }
    expect((caught as HttpException).getStatus()).toBe(502);
  });
  }); // describe('message')
}); // describe('AnthropicService')
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && pnpm test anthropic.service`
Expected: FAIL — `service.message is not a function`.

- [ ] **Step 3: Replace `backend/src/anthropic/anthropic.service.ts`**

```ts
import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_CLIENT, AnthropicClientFactory } from './anthropic.constants';

export interface MessageInput {
  prompt: string;
  system?: string;
  model?: string;
  maxTokens?: number;
}

export interface MessageResult {
  model: string;
  text: string | null;
  stopReason: string | null;
  usage: unknown;
}

@Injectable()
export class AnthropicService {
  constructor(
    @Inject(ANTHROPIC_CLIENT)
    private readonly clientFactory: AnthropicClientFactory,
    private readonly config: ConfigService,
  ) {}

  private get defaultModel(): string {
    return this.config.get<string>('anthropic.model') ?? 'claude-sonnet-5';
  }

  private get defaultMaxTokens(): number {
    return this.config.get<number>('anthropic.maxTokens') ?? 4096;
  }

  async message(input: MessageInput): Promise<MessageResult> {
    const client = this.clientFactory.get();
    try {
      const response = await client.messages.create({
        model: input.model ?? this.defaultModel,
        max_tokens: input.maxTokens ?? this.defaultMaxTokens,
        ...(input.system ? { system: input.system } : {}),
        messages: [{ role: 'user', content: input.prompt }],
      });

      let text: string | null = '';
      for (const block of response.content) {
        if (block.type === 'text') {
          text += block.text;
        }
      }
      if (response.stop_reason === 'refusal') {
        text = null;
      }

      return {
        model: response.model,
        text,
        stopReason: response.stop_reason,
        usage: response.usage,
      };
    } catch (err) {
      this.rethrow(err);
    }
  }

  /** Maps Anthropic SDK errors to Nest HttpExceptions; passes others through. */
  protected rethrow(err: unknown): never {
    if (err instanceof HttpException) {
      throw err;
    }
    if (err instanceof Anthropic.APIError) {
      const status =
        typeof err.status === 'number' ? err.status : HttpStatus.BAD_GATEWAY;
      throw new HttpException({ statusCode: status, error: err.message }, status);
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && pnpm test anthropic.service`
Expected: PASS — all five tests green.

- [ ] **Step 5: Verify the build compiles**

Run: `cd backend && pnpm build`
Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/anthropic
git commit -m "feat(backend): add AnthropicService.message with refusal + error handling"
```

---

## Task 4: AnthropicService batch methods

**Files:**
- Modify: `backend/src/anthropic/anthropic.service.ts`
- Modify: `backend/src/anthropic/anthropic.service.spec.ts`

- [ ] **Step 1: Add the failing batch tests to `backend/src/anthropic/anthropic.service.spec.ts`**

The Task 3 spec already declares the batch mocks (`batchesCreate` / `batchesRetrieve` / `batchesResults`) and wires them into the shared `fakeClient` in the outer `AnthropicService` describe's `beforeEach`. **No `beforeEach` changes are needed.** Insert this `describe('batches')` block **inside** the outer `describe('AnthropicService', ...)`, immediately before its closing `}); // describe('AnthropicService')` line (i.e. right after the `}); // describe('message')` line):

```ts
  describe('batches', () => {
  it('createBatch maps requests (default + custom ids) and returns a summary', async () => {
    batchesCreate.mockResolvedValue({
      id: 'batch_1',
      processing_status: 'in_progress',
    });
    const summary = await service.createBatch([
      { prompt: 'a' },
      { customId: 'c2', prompt: 'b' },
    ]);
    expect(batchesCreate).toHaveBeenCalledWith({
      requests: [
        {
          custom_id: 'request-0',
          params: {
            model: 'claude-sonnet-5',
            max_tokens: 4096,
            messages: [{ role: 'user', content: 'a' }],
          },
        },
        {
          custom_id: 'c2',
          params: {
            model: 'claude-sonnet-5',
            max_tokens: 4096,
            messages: [{ role: 'user', content: 'b' }],
          },
        },
      ],
    });
    expect(summary).toEqual({
      batchId: 'batch_1',
      processingStatus: 'in_progress',
    });
  });

  it('getBatch returns status and counts', async () => {
    batchesRetrieve.mockResolvedValue({
      id: 'batch_1',
      processing_status: 'ended',
      request_counts: { succeeded: 1, errored: 1 },
    });
    const summary = await service.getBatch('batch_1');
    expect(batchesRetrieve).toHaveBeenCalledWith('batch_1');
    expect(summary).toEqual({
      batchId: 'batch_1',
      processingStatus: 'ended',
      requestCounts: { succeeded: 1, errored: 1 },
    });
  });

  it('getBatchResults shapes succeeded and errored results keyed by custom_id', async () => {
    async function* gen() {
      yield {
        custom_id: 'a',
        result: {
          type: 'succeeded',
          message: { content: [{ type: 'text', text: 'ok' }] },
        },
      };
      yield {
        custom_id: 'b',
        result: {
          type: 'errored',
          error: { type: 'invalid_request', message: 'bad' },
        },
      };
    }
    batchesResults.mockResolvedValue(gen());
    const results = await service.getBatchResults('batch_1');
    expect(batchesResults).toHaveBeenCalledWith('batch_1');
    expect(results).toEqual([
      { customId: 'a', type: 'succeeded', text: 'ok' },
      {
        customId: 'b',
        type: 'errored',
        error: JSON.stringify({ type: 'invalid_request', message: 'bad' }),
      },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify the batch block fails**

Run: `cd backend && pnpm test anthropic.service`
Expected: FAIL — `service.createBatch is not a function`.

- [ ] **Step 3: Add batch methods and types to `backend/src/anthropic/anthropic.service.ts`**

Add these interfaces after `MessageResult`:

```ts
export interface BatchRequestInput {
  customId?: string;
  prompt: string;
}

export interface BatchSummary {
  batchId: string;
  processingStatus: string;
  requestCounts?: unknown;
}

export interface BatchResultItem {
  customId: string;
  type: string;
  text?: string;
  error?: string;
}
```

Add these methods to the `AnthropicService` class (after `message`, before `rethrow`):

```ts
  async createBatch(requests: BatchRequestInput[]): Promise<BatchSummary> {
    const client = this.clientFactory.get();
    const model = this.defaultModel;
    const maxTokens = this.defaultMaxTokens;
    try {
      const batch = await client.messages.batches.create({
        requests: requests.map((r, i) => ({
          custom_id: r.customId ?? `request-${i}`,
          params: {
            model,
            max_tokens: maxTokens,
            messages: [{ role: 'user', content: r.prompt }],
          },
        })),
      });
      return { batchId: batch.id, processingStatus: batch.processing_status };
    } catch (err) {
      this.rethrow(err);
    }
  }

  async getBatch(id: string): Promise<BatchSummary> {
    const client = this.clientFactory.get();
    try {
      const batch = await client.messages.batches.retrieve(id);
      return {
        batchId: batch.id,
        processingStatus: batch.processing_status,
        requestCounts: batch.request_counts,
      };
    } catch (err) {
      this.rethrow(err);
    }
  }

  async getBatchResults(id: string): Promise<BatchResultItem[]> {
    const client = this.clientFactory.get();
    try {
      const items: BatchResultItem[] = [];
      for await (const entry of await client.messages.batches.results(id)) {
        const customId = entry.custom_id;
        const result = entry.result;
        if (result.type === 'succeeded') {
          let text = '';
          for (const block of result.message.content) {
            if (block.type === 'text') {
              text += block.text;
            }
          }
          items.push({ customId, type: 'succeeded', text });
        } else if (result.type === 'errored') {
          items.push({
            customId,
            type: 'errored',
            error: JSON.stringify(result.error),
          });
        } else {
          items.push({ customId, type: result.type, error: result.type });
        }
      }
      return items;
    } catch (err) {
      this.rethrow(err);
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && pnpm test anthropic.service`
Expected: PASS — the message tests (5) and batch tests (3) all green.

- [ ] **Step 5: Verify the build compiles**

Run: `cd backend && pnpm build`
Expected: no TypeScript errors.

Note: if TypeScript flags the discriminated union on `entry.result` (e.g. `result.error` not narrowing) or the batch-request `messages` role type, cast the role literal explicitly (`role: 'user' as const`) — do not loosen types to `any`. If a genuine SDK-type mismatch persists, STOP and report it rather than working around it.

- [ ] **Step 6: Commit**

```bash
git add backend/src/anthropic
git commit -m "feat(backend): add Batch API methods to AnthropicService"
```

---

## Task 5: AnthropicDemoController and route wiring

**Files:**
- Create: `backend/src/demo/anthropic-demo.controller.ts`
- Modify: `backend/src/app.module.ts`
- Test: `backend/src/demo/anthropic-demo.controller.spec.ts`
- Test: `backend/test/anthropic-ready.e2e-spec.ts`

- [ ] **Step 1: Write the failing unit test `backend/src/demo/anthropic-demo.controller.spec.ts`**

```ts
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import { AnthropicDemoController } from './anthropic-demo.controller';
import { AnthropicService } from '../anthropic/anthropic.service';

describe('AnthropicDemoController', () => {
  let controller: AnthropicDemoController;
  const anthropic = {
    message: jest.fn(),
    createBatch: jest.fn(),
    getBatch: jest.fn(),
    getBatchResults: jest.fn(),
  };
  let apiKey: string | undefined;

  beforeEach(async () => {
    jest.clearAllMocks();
    apiKey = undefined;
    const moduleRef = await Test.createTestingModule({
      controllers: [AnthropicDemoController],
      providers: [
        { provide: AnthropicService, useValue: anthropic },
        {
          provide: ConfigService,
          useValue: { get: (k: string) => (k === 'anthropic.apiKey' ? apiKey : undefined) },
        },
      ],
    }).compile();
    controller = moduleRef.get(AnthropicDemoController);
  });

  it('ready reports configured=false when no key', () => {
    expect(controller.ready()).toEqual({ configured: false });
  });

  it('ready reports configured=true when a key is set', async () => {
    apiKey = 'sk-test';
    const moduleRef = await Test.createTestingModule({
      controllers: [AnthropicDemoController],
      providers: [
        { provide: AnthropicService, useValue: anthropic },
        {
          provide: ConfigService,
          useValue: { get: (k: string) => (k === 'anthropic.apiKey' ? apiKey : undefined) },
        },
      ],
    }).compile();
    const c = moduleRef.get(AnthropicDemoController);
    expect(c.ready()).toEqual({ configured: true });
  });

  it('message delegates to the service', async () => {
    anthropic.message.mockResolvedValue({ text: 'hi' });
    await controller.message({ prompt: 'yo' });
    expect(anthropic.message).toHaveBeenCalledWith({ prompt: 'yo' });
  });

  it('createBatch delegates the requests array (defaulting to [])', async () => {
    anthropic.createBatch.mockResolvedValue({ batchId: 'b1', processingStatus: 'in_progress' });
    await controller.createBatch({ requests: [{ prompt: 'a' }] });
    expect(anthropic.createBatch).toHaveBeenCalledWith([{ prompt: 'a' }]);
    await controller.createBatch({} as { requests: [] });
    expect(anthropic.createBatch).toHaveBeenCalledWith([]);
  });

  it('getBatch delegates to the service', async () => {
    anthropic.getBatch.mockResolvedValue({ batchId: 'b1', processingStatus: 'ended' });
    await controller.getBatch('b1');
    expect(anthropic.getBatch).toHaveBeenCalledWith('b1');
  });

  it('getBatchResults returns results when the batch has ended', async () => {
    anthropic.getBatch.mockResolvedValue({ batchId: 'b1', processingStatus: 'ended' });
    anthropic.getBatchResults.mockResolvedValue([{ customId: 'a', type: 'succeeded', text: 'ok' }]);
    const results = await controller.getBatchResults('b1');
    expect(results).toEqual([{ customId: 'a', type: 'succeeded', text: 'ok' }]);
  });

  it('getBatchResults throws 409 when the batch has not ended', async () => {
    anthropic.getBatch.mockResolvedValue({ batchId: 'b1', processingStatus: 'in_progress' });
    await expect(controller.getBatchResults('b1')).rejects.toBeInstanceOf(ConflictException);
    expect(anthropic.getBatchResults).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && pnpm test anthropic-demo`
Expected: FAIL — cannot find module `./anthropic-demo.controller`.

- [ ] **Step 3: Create `backend/src/demo/anthropic-demo.controller.ts`**

```ts
import {
  Body,
  ConflictException,
  Controller,
  Get,
  Param,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AnthropicService,
  BatchRequestInput,
  MessageInput,
} from '../anthropic/anthropic.service';

@Controller('ai')
export class AnthropicDemoController {
  constructor(
    private readonly anthropic: AnthropicService,
    private readonly config: ConfigService,
  ) {}

  @Get('ready')
  ready() {
    return { configured: Boolean(this.config.get<string>('anthropic.apiKey')) };
  }

  @Post('message')
  message(@Body() body: MessageInput) {
    return this.anthropic.message(body);
  }

  @Post('batch')
  createBatch(@Body() body: { requests: BatchRequestInput[] }) {
    return this.anthropic.createBatch(body.requests ?? []);
  }

  @Get('batch/:id')
  getBatch(@Param('id') id: string) {
    return this.anthropic.getBatch(id);
  }

  @Get('batch/:id/results')
  async getBatchResults(@Param('id') id: string) {
    const batch = await this.anthropic.getBatch(id);
    if (batch.processingStatus !== 'ended') {
      throw new ConflictException(
        `Batch ${id} has not ended (status: ${batch.processingStatus})`,
      );
    }
    return this.anthropic.getBatchResults(id);
  }
}
```

- [ ] **Step 4: Register in `backend/src/app.module.ts`**

Replace the file contents with:

```ts
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { FirebaseModule } from './firebase/firebase.module';
import { AnthropicModule } from './anthropic/anthropic.module';
import { GoogleErrorFilter } from './common/google-error.filter';
import { HealthController } from './health/health.controller';
import { FirestoreDemoController } from './demo/firestore-demo.controller';
import { StorageDemoController } from './demo/storage-demo.controller';
import { AnthropicDemoController } from './demo/anthropic-demo.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    FirebaseModule,
    AnthropicModule,
  ],
  controllers: [
    HealthController,
    FirestoreDemoController,
    StorageDemoController,
    AnthropicDemoController,
  ],
  providers: [{ provide: APP_FILTER, useClass: GoogleErrorFilter }],
})
export class AppModule {}
```

- [ ] **Step 5: Run the unit test to verify it passes**

Run: `cd backend && pnpm test anthropic-demo`
Expected: PASS — all controller tests green.

- [ ] **Step 6: Write the e2e test `backend/test/anthropic-ready.e2e-spec.ts`**

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Anthropic readiness (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /ai/ready -> 200 { configured: false } with no key (app boots keyless)', () => {
    return request(app.getHttpServer())
      .get('/ai/ready')
      .expect(200)
      .expect({ configured: false });
  });
});
```

- [ ] **Step 7: Run the e2e suite to verify it passes**

Run: `cd backend && pnpm test:e2e`
Expected: PASS — both `Health (e2e)`, the error-filter e2e, and the new `Anthropic readiness (e2e)` green. Booting `AppModule` with `AnthropicModule` does not construct the SDK client (lazy), so no key is required.

- [ ] **Step 8: Verify the build compiles**

Run: `cd backend && pnpm build`
Expected: no TypeScript errors.

- [ ] **Step 9: Commit**

```bash
git add backend/src backend/test
git commit -m "feat(backend): add /ai demo endpoints and register AnthropicModule"
```

---

## Task 6: Documentation

**Files:**
- Modify: `backend/.env.example`
- Modify: `backend/README.md`

- [ ] **Step 1: Append the Anthropic vars to `backend/.env.example`**

Add these lines at the end of the file:

```dotenv
# --- Anthropic / Claude API ---
# API key is read by the SDK. NOT committed; add it here when you have one.
# Until then the app boots fine and GET /ai/ready reports { "configured": false }.
ANTHROPIC_API_KEY=

# Default model (env-overridable). See the claude-api guidance for options.
ANTHROPIC_MODEL=claude-sonnet-5

# Default max output tokens per request. 4096 is a demo-friendly value; the API
# guidance is ~16000 for real non-streaming workloads.
ANTHROPIC_MAX_TOKENS=4096
```

- [ ] **Step 2: Add an Anthropic section to `backend/README.md`**

Append this section at the end of the README:

````markdown
## Claude (Anthropic) client

An `AnthropicModule` wraps `@anthropic-ai/sdk` and exposes demo endpoints under
`/ai`. The SDK client is constructed **lazily** on first use, so the app boots
and all tests pass without an API key.

### Configuration

| Var | Default |
| --- | --- |
| `ANTHROPIC_API_KEY` | *(unset)* — add when you have one |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` |
| `ANTHROPIC_MAX_TOKENS` | `4096` |

### Endpoints

```bash
# Config check — no live call; works before a key is added
curl localhost:3000/ai/ready
# -> { "configured": false }   (true once ANTHROPIC_API_KEY is set)

# Single message
curl -X POST localhost:3000/ai/message \
  -H 'content-type: application/json' \
  -d '{"prompt":"Say hi in one word"}'

# Batch: submit, poll, fetch results
curl -X POST localhost:3000/ai/batch \
  -H 'content-type: application/json' \
  -d '{"requests":[{"prompt":"1+1?"},{"customId":"q2","prompt":"2+2?"}]}'
curl localhost:3000/ai/batch/<batchId>
curl localhost:3000/ai/batch/<batchId>/results   # 409 until the batch has ended
```

The Message Batches API processes requests asynchronously at 50% of standard
price; most batches finish within an hour. Results are keyed by `customId` and
arrive in any order.

### Smoke-test with a real key

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pnpm start:dev
curl -X POST localhost:3000/ai/message -H 'content-type: application/json' \
  -d '{"prompt":"Say hi"}'
```

Without a key, `/ai/message` and the batch routes return `401` (from
`ANTHROPIC_API_KEY is not configured`); `/ai/ready` still returns 200.
````

- [ ] **Step 3: Commit**

```bash
git add backend/.env.example backend/README.md
git commit -m "docs(backend): document the Anthropic client module and /ai endpoints"
```

---

## Task 7: Final verification

- [ ] **Step 1: Run the full unit suite**

Run: `cd backend && pnpm test`
Expected: all spec files PASS (existing Firebase/health/filter suites plus the new configuration, anthropic.module, anthropic.service, and anthropic-demo suites).

- [ ] **Step 2: Run the e2e suite**

Run: `cd backend && pnpm test:e2e`
Expected: `Health`, error-filter, and `Anthropic readiness` e2e suites all PASS.

- [ ] **Step 3: Verify the production build**

Run: `cd backend && pnpm build`
Expected: compiles to `dist/` with no errors.

- [ ] **Step 4: (Manual, optional) Live smoke test**

Run:
```bash
export ANTHROPIC_API_KEY=sk-ant-...
cd backend && pnpm start:dev
# in another shell:
curl localhost:3000/ai/ready   # { "configured": true }
curl -X POST localhost:3000/ai/message -H 'content-type: application/json' -d '{"prompt":"Say hi"}'
```
Expected: a Claude response in the `text` field.

- [ ] **Step 5: Final commit if anything is outstanding**

```bash
git status
# commit any remaining changes with an appropriate semantic message
```
