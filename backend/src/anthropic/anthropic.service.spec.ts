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
  toFile: jest.fn(async (bytes: Buffer, filename: string, opts?: { type?: string }) => ({
    __uploadable: true,
    filename,
    bytes,
    type: opts?.type,
  })),
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
  let betaCreate: jest.Mock;
  let betaBatchesCreate: jest.Mock;
  let betaBatchesRetrieve: jest.Mock;
  let betaBatchesResults: jest.Mock;
  let filesUpload: jest.Mock;
  let service: AnthropicService;

  beforeEach(async () => {
    create = jest.fn();
    batchesCreate = jest.fn();
    batchesRetrieve = jest.fn();
    batchesResults = jest.fn();
    betaCreate = jest.fn();
    betaBatchesCreate = jest.fn();
    betaBatchesRetrieve = jest.fn();
    betaBatchesResults = jest.fn();
    filesUpload = jest.fn();
    const fakeClient = {
      messages: {
        create,
        batches: {
          create: batchesCreate,
          retrieve: batchesRetrieve,
          results: batchesResults,
        },
      },
      beta: {
        messages: {
          create: betaCreate,
          batches: {
            create: betaBatchesCreate,
            retrieve: betaBatchesRetrieve,
            results: betaBatchesResults,
          },
        },
        files: { upload: filesUpload },
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
    // 4xx keeps the (safe) upstream message.
    expect((caught as HttpException).getResponse()).toEqual({
      statusCode: 429,
      error: 'rate limited',
    });
  });

  it('defaults an APIError with no status to a sanitized 502', async () => {
    const Anthropic = require('@anthropic-ai/sdk').default;
    create.mockRejectedValue(new Anthropic.APIError(undefined, 'connection'));
    let caught: unknown;
    try {
      await service.message({ prompt: 'x' });
    } catch (e) {
      caught = e;
    }
    expect((caught as HttpException).getStatus()).toBe(502);
    // 5xx is sanitized — the upstream message is NOT leaked to the client.
    expect((caught as HttpException).getResponse()).toEqual({
      statusCode: 502,
      error: 'Upstream Anthropic API error',
    });
  });
  }); // describe('message')

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

  it('shapes canceled and expired results via the fallback branch', async () => {
    async function* gen() {
      yield { custom_id: 'a', result: { type: 'canceled' } };
      yield { custom_id: 'b', result: { type: 'expired' } };
    }
    batchesResults.mockResolvedValue(gen());
    const results = await service.getBatchResults('batch_1');
    expect(results).toEqual([
      { customId: 'a', type: 'canceled', error: 'canceled' },
      { customId: 'b', type: 'expired', error: 'expired' },
    ]);
  });
});

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
  it('createBatch honours a model override so it can match the warmed cache', async () => {
    batchesCreate.mockResolvedValue({
      id: 'batch_m',
      processing_status: 'in_progress',
    });
    await service.createBatch([{ prompt: 'a' }], { system: 's' }, {
      model: 'claude-opus-5',
    });
    expect(batchesCreate).toHaveBeenCalledWith({
      requests: [
        {
          custom_id: 'request-0',
          params: {
            model: 'claude-opus-5',
            max_tokens: 4096,
            system: [{ type: 'text', text: 's', cache_control: CC }],
            messages: [{ role: 'user', content: 'a' }],
          },
        },
      ],
    });
  });
  }); // describe('caching')

  describe('tiers + files + structured output', () => {
    const CC = { type: 'ephemeral', ttl: '1h' };
    const FILES_BETA = ['files-api-2025-04-14'];

    it('warmCache renders userTiers with NO system breakpoint and stamps each tier last block', async () => {
      create.mockResolvedValue({ model: 'claude-fable-5', usage: { cache_creation_input_tokens: 10, cache_read_input_tokens: 0 } });
      await service.warmCache(
        {
          userTiers: [
            { blocks: [{ type: 'text', text: 'general' }] },
            { blocks: [{ type: 'text', text: 'day-a' }, { type: 'text', text: 'day-b' }] },
            { blocks: [{ type: 'text', text: 'persona' }] },
          ],
        },
        { model: 'claude-fable-5' },
      );
      expect(create).toHaveBeenCalledWith({
        model: 'claude-fable-5',
        max_tokens: 0,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'general', cache_control: CC },
              { type: 'text', text: 'day-a' },
              { type: 'text', text: 'day-b', cache_control: CC },
              { type: 'text', text: 'persona', cache_control: CC },
              { type: 'text', text: 'warmup' },
            ],
          },
        ],
      });
      // The whole cached prefix lives in messages (M4): no system breakpoint.
      expect(create.mock.calls[0][0].system).toBeUndefined();
    });

    it('warmCache with files:true routes to the beta client with the files beta header and shares effort', async () => {
      betaCreate.mockResolvedValue({ model: 'claude-fable-5', usage: { cache_creation_input_tokens: 100, cache_read_input_tokens: 0 } });
      await service.warmCache(
        { userTiers: [{ blocks: [{ type: 'document', source: { type: 'file', file_id: 'file_1' } }] }] },
        { model: 'claude-fable-5', files: true, effort: 'high' },
      );
      expect(create).not.toHaveBeenCalled();
      const arg = betaCreate.mock.calls[0][0];
      expect(arg.betas).toEqual(FILES_BETA);
      expect(arg.max_tokens).toBe(0);
      // A 0-token warm generates nothing, so no output_config is sent — effort is
      // irrelevant to a cache write and max_tokens:0 + output_config could 400.
      expect(arg).not.toHaveProperty('output_config');
    });

    it('warmCache with outputSchema sends the batch output_config (format+effort) and a non-zero max_tokens', async () => {
      betaCreate.mockResolvedValue({ model: 'claude-fable-5', usage: { cache_creation_input_tokens: 100, cache_read_input_tokens: 0 } });
      const schema = { type: 'object', properties: { side: { type: 'string' } } };
      await service.warmCache(
        { userTiers: [{ blocks: [{ type: 'document', source: { type: 'file', file_id: 'file_1' } }] }] },
        { model: 'claude-fable-5', files: true, effort: 'high', outputSchema: schema },
      );
      const arg = betaCreate.mock.calls[0][0];
      expect(arg.betas).toEqual(FILES_BETA);
      // output_config.format is rejected at max_tokens:0, so a structured warm must
      // bill a small non-zero budget — and it must mirror the batch's output_config
      // exactly or the batch reads 0 cache.
      expect(arg.max_tokens).toBe(16);
      expect(arg.output_config).toEqual({ format: { type: 'json_schema', schema }, effort: 'high' });
    });

    it('warmCache with outputSchema honours an explicit maxTokens override', async () => {
      create.mockResolvedValue({ model: 'claude-fable-5', usage: { cache_creation_input_tokens: 100, cache_read_input_tokens: 0 } });
      await service.warmCache(
        { userTiers: [{ blocks: [{ type: 'text', text: 'big' }] }] },
        { model: 'claude-fable-5', outputSchema: { type: 'object' }, maxTokens: 32 },
      );
      expect(create.mock.calls[0][0].max_tokens).toBe(32);
    });

    it('throws 400 when breakpoints exceed 4 (5 user tiers, no system)', async () => {
      let caught: unknown;
      try {
        await service.warmCache({
          userTiers: [
            { blocks: [{ type: 'text', text: '1' }] },
            { blocks: [{ type: 'text', text: '2' }] },
            { blocks: [{ type: 'text', text: '3' }] },
            { blocks: [{ type: 'text', text: '4' }] },
            { blocks: [{ type: 'text', text: '5' }] },
          ],
        });
      } catch (e) {
        caught = e;
      }
      expect((caught as HttpException).getStatus()).toBe(400);
      expect(create).not.toHaveBeenCalled();
      expect(betaCreate).not.toHaveBeenCalled();
    });

    it('createBatch with files routes to beta batches with betas, output_config (format+effort) and maxTokens', async () => {
      betaBatchesCreate.mockResolvedValue({ id: 'b', processing_status: 'in_progress' });
      const schema = { type: 'object' } as any;
      await service.createBatch(
        [{ customId: 'k1', prompt: 'go', context: { userTiers: [{ blocks: [{ type: 'document', source: { type: 'file', file_id: 'f' } }] }] } }],
        undefined,
        { model: 'claude-fable-5', outputSchema: schema, maxTokens: 32000, effort: 'high', files: true },
      );
      expect(batchesCreate).not.toHaveBeenCalled();
      const arg = betaBatchesCreate.mock.calls[0][0];
      expect(arg.betas).toEqual(FILES_BETA);
      expect(arg.requests[0].params.max_tokens).toBe(32000);
      expect(arg.requests[0].params.output_config).toEqual({ format: { type: 'json_schema', schema }, effort: 'high' });
    });

    it('createBatch non-files keeps the non-beta path and honours per-request context', async () => {
      batchesCreate.mockResolvedValue({ id: 'b', processing_status: 'in_progress' });
      await service.createBatch(
        [
          { customId: 'k1', prompt: 'go', context: { prefix: 'S1' } },
          { customId: 'k2', prompt: 'go', context: { prefix: 'S2' } },
        ],
        undefined,
        { model: 'claude-fable-5' },
      );
      expect(betaBatchesCreate).not.toHaveBeenCalled();
      const arg = batchesCreate.mock.calls[0][0];
      expect(arg.requests[0].params.messages[0].content[0].text).toBe('S1');
      expect(arg.requests[1].params.messages[0].content[0].text).toBe('S2');
    });

    it('uploadFile posts to the beta Files API in a single-arg call and returns the id', async () => {
      filesUpload.mockResolvedValue({ id: 'file_123' });
      const id = await service.uploadFile(Buffer.from('PDF'), 'x.pdf', 'application/pdf');
      expect(id).toBe('file_123');
      expect(filesUpload).toHaveBeenCalledWith({
        file: expect.objectContaining({ __uploadable: true, filename: 'x.pdf', type: 'application/pdf' }),
        betas: FILES_BETA,
      });
    });

    it('getBatch/getBatchResults with files:true read the beta batch endpoints; refusal detected', async () => {
      betaBatchesRetrieve.mockResolvedValue({ id: 'b', processing_status: 'ended', request_counts: {} });
      async function* gen() {
        yield { custom_id: 'k', result: { type: 'succeeded', message: { stop_reason: 'refusal', content: [], usage: {} } } };
      }
      betaBatchesResults.mockResolvedValue(gen());
      const summary = await service.getBatch('b', { files: true });
      expect(betaBatchesRetrieve).toHaveBeenCalledWith('b', { betas: FILES_BETA });
      expect(summary.processingStatus).toBe('ended');
      const results = await service.getBatchResults('b', { files: true });
      expect(betaBatchesResults).toHaveBeenCalledWith('b', { betas: FILES_BETA });
      expect(results[0]).toMatchObject({ customId: 'k', type: 'refusal', stopReason: 'refusal' });
    });
  });

  describe('messageStructured', () => {
    const FILES_BETA = ['files-api-2025-04-14'];

    it('non-files: sends output_config.format and parses the JSON text', async () => {
      create.mockResolvedValue({
        model: 'claude-fable-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '{"pass":true,"mismatches":[]}' }],
        usage: {},
      });
      const schema = { type: 'object', required: ['pass'] } as any;
      const out = await service.messageStructured<{ pass: boolean; mismatches: string[] }>(
        { prompt: 'verify' },
        { model: 'claude-fable-5', outputSchema: schema, effort: 'high' },
      );
      expect(betaCreate).not.toHaveBeenCalled();
      const arg = create.mock.calls[0][0];
      expect(arg.model).toBe('claude-fable-5');
      expect(arg.output_config).toEqual({ format: { type: 'json_schema', schema }, effort: 'high' });
      expect(arg.messages).toEqual([{ role: 'user', content: 'verify' }]);
      expect(out).toEqual({ pass: true, mismatches: [] });
    });

    it('files:true routes to the beta client with the files beta header and a cached document tier', async () => {
      betaCreate.mockResolvedValue({
        model: 'claude-fable-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '{"bias":"b"}' }],
        usage: {},
      });
      await service.messageStructured(
        { prompt: 'analyze' },
        {
          model: 'claude-fable-5',
          outputSchema: { type: 'object' } as any,
          files: true,
          context: { userTiers: [{ blocks: [{ type: 'document', source: { type: 'file', file_id: 'file_1' } }] }] },
        },
      );
      expect(create).not.toHaveBeenCalled();
      const arg = betaCreate.mock.calls[0][0];
      expect(arg.betas).toEqual(FILES_BETA);
      // The document tier is cached (last-block breakpoint) and the prompt is appended uncached.
      expect(arg.messages[0].content[0]).toMatchObject({ type: 'document', source: { type: 'file', file_id: 'file_1' } });
      expect(arg.messages[0].content[arg.messages[0].content.length - 1]).toEqual({ type: 'text', text: 'analyze' });
    });

    it('throws when the model refuses (stop_reason refusal)', async () => {
      create.mockResolvedValue({ model: 'claude-fable-5', stop_reason: 'refusal', content: [], usage: {} });
      await expect(
        service.messageStructured({ prompt: 'x' }, { outputSchema: { type: 'object' } as any }),
      ).rejects.toBeInstanceOf(HttpException);
    });

    it('throws a 502 when the structured output is not valid JSON', async () => {
      create.mockResolvedValue({
        model: 'claude-fable-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'not json' }],
        usage: {},
      });
      let caught: unknown;
      try {
        await service.messageStructured({ prompt: 'x' }, { outputSchema: { type: 'object' } as any });
      } catch (e) {
        caught = e;
      }
      expect((caught as HttpException).getStatus()).toBe(502);
    });

    it('sends input.system when the context carries no system of its own', async () => {
      create.mockResolvedValue({
        model: 'claude-fable-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '{}' }],
        usage: {},
      });
      await service.messageStructured(
        { prompt: 'go', system: 'be terse' },
        { context: { prefix: 'shared ctx' } },
      );
      const arg = create.mock.calls[0][0];
      expect(arg.system).toBe('be terse');
    });

    it('prefers the cached context system over input.system when both are set', async () => {
      create.mockResolvedValue({
        model: 'claude-fable-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '{}' }],
        usage: {},
      });
      await service.messageStructured(
        { prompt: 'go', system: 'be terse' },
        { context: { system: 'context system' } },
      );
      const arg = create.mock.calls[0][0];
      expect(arg.system).toEqual([
        { type: 'text', text: 'context system', cache_control: { type: 'ephemeral', ttl: '1h' } },
      ]);
    });
  });
}); // describe('AnthropicService')
