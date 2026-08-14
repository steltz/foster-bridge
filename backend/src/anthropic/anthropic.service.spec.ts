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
import { EventEmitter2 } from '@nestjs/event-emitter';
import { HttpException } from '@nestjs/common';
import { AnthropicLlmProvider } from './anthropic.service';
import { ANTHROPIC_CLIENT } from './anthropic.constants';

// One shared outer describe: the full client (with beta batches) is set up here.
// Batches and structured calls run through the neutral port surface, which always
// routes batches through the beta/files client.
describe('AnthropicLlmProvider', () => {
  const CC = { type: 'ephemeral', ttl: '1h' };
  const FILES_BETA = ['files-api-2025-04-14'];

  let create: jest.Mock;
  let batchesCreate: jest.Mock;
  let batchesRetrieve: jest.Mock;
  let batchesResults: jest.Mock;
  let betaCreate: jest.Mock;
  let betaBatchesCreate: jest.Mock;
  let betaBatchesRetrieve: jest.Mock;
  let betaBatchesResults: jest.Mock;
  let filesUpload: jest.Mock;
  let service: AnthropicLlmProvider;

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
        AnthropicLlmProvider,
        { provide: ANTHROPIC_CLIENT, useValue: { get: () => fakeClient } },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
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
    service = moduleRef.get(AnthropicLlmProvider);
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
    const result = await service.message({ prompt: 'hi', attribution: { operation: 'other' } });
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
      attribution: { operation: 'other' },
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
    const result = await service.message({ prompt: 'x', attribution: { operation: 'other' } });
    expect(result.text).toBeNull();
    expect(result.stopReason).toBe('refusal');
  });

  it('maps an SDK APIError to an HttpException with the same status', async () => {
    const Anthropic = require('@anthropic-ai/sdk').default;
    create.mockRejectedValue(new Anthropic.APIError(429, 'rate limited'));
    let caught: unknown;
    try {
      await service.message({ prompt: 'x', attribution: { operation: 'other' } });
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
      await service.message({ prompt: 'x', attribution: { operation: 'other' } });
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

  // Batches always run on the beta/files path (uniform beta), so every batch
  // assertion targets the beta client mocks.
  describe('submitBatch', () => {
    it('maps requests (default + custom ids) onto the beta path and returns a neutral handle', async () => {
      betaBatchesCreate.mockResolvedValue({ id: 'batch_1', processing_status: 'in_progress' });
      const handle = await service.submitBatch(
        [{ prompt: 'a' }, { customId: 'c2', prompt: 'b' }],
        undefined,
        {},
      );
      expect(batchesCreate).not.toHaveBeenCalled();
      expect(betaBatchesCreate).toHaveBeenCalledWith({
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
        betas: FILES_BETA,
      });
      expect(handle).toEqual({ batchId: 'batch_1', status: 'in_progress' });
    });

    it('carries model/maxTokens and output_config (format + effort) onto each request', async () => {
      betaBatchesCreate.mockResolvedValue({ id: 'b', processing_status: 'in_progress' });
      const schema = { type: 'object' } as any;
      await service.submitBatch([{ customId: 'k1', prompt: 'go' }], undefined, {
        model: 'claude-fable-5',
        schema,
        maxTokens: 32000,
        effort: 'high',
      });
      const arg = betaBatchesCreate.mock.calls[0][0];
      expect(arg.betas).toEqual(FILES_BETA);
      expect(arg.requests[0].params.model).toBe('claude-fable-5');
      expect(arg.requests[0].params.max_tokens).toBe(32000);
      expect(arg.requests[0].params.output_config).toEqual({
        format: { type: 'json_schema', schema },
        effort: 'high',
      });
    });

    it('renders a file block as a beta document with a 1h breakpoint', async () => {
      betaBatchesCreate.mockResolvedValue({ id: 'b', processing_status: 'in_progress' });
      await service.submitBatch(
        [{ customId: 'k1', prompt: 'go' }],
        { tiers: [{ blocks: [{ type: 'file', fileId: 'file_9' }, { type: 'text', text: 'plan' }] }] },
        { model: 'claude-fable-5' },
      );
      const content = betaBatchesCreate.mock.calls[0][0].requests[0].params.messages[0].content;
      expect(content[0]).toEqual({ type: 'document', source: { type: 'file', file_id: 'file_9' } });
      // The tier's LAST block carries the breakpoint; the prompt is appended uncached.
      expect(content[1]).toEqual({ type: 'text', text: 'plan', cache_control: CC });
      expect(content[2]).toEqual({ type: 'text', text: 'go' });
    });

    it('lets a per-request envelope override the batch-level envelope', async () => {
      betaBatchesCreate.mockResolvedValue({ id: 'b', processing_status: 'in_progress' });
      await service.submitBatch(
        [{ customId: 'k1', prompt: 'go', envelope: { tiers: [{ blocks: [{ type: 'text', text: 'PER' }] }] } }],
        { tiers: [{ blocks: [{ type: 'text', text: 'BATCH' }] }] },
        { model: 'claude-fable-5' },
      );
      const content = betaBatchesCreate.mock.calls[0][0].requests[0].params.messages[0].content;
      expect(content[0]).toEqual({ type: 'text', text: 'PER', cache_control: CC });
    });
  });

  describe('getBatch', () => {
    it('reads the beta endpoint and maps processing_status to a neutral lifecycle', async () => {
      betaBatchesRetrieve.mockResolvedValue({
        id: 'batch_1',
        processing_status: 'ended',
        request_counts: { succeeded: 1, errored: 1 },
      });
      const handle = await service.getBatch('batch_1');
      expect(betaBatchesRetrieve).toHaveBeenCalledWith('batch_1', { betas: FILES_BETA });
      expect(handle).toEqual({
        batchId: 'batch_1',
        status: 'ended',
        requestCounts: { succeeded: 1, errored: 1 },
      });
    });
  });

  describe('getBatchResults', () => {
    it('shapes succeeded and errored results keyed by custom_id (beta endpoint)', async () => {
      async function* gen() {
        yield {
          custom_id: 'a',
          result: { type: 'succeeded', message: { content: [{ type: 'text', text: 'ok' }] } },
        };
        yield {
          custom_id: 'b',
          result: { type: 'errored', error: { type: 'invalid_request', message: 'bad' } },
        };
      }
      betaBatchesResults.mockResolvedValue(gen());
      const results = await service.getBatchResults('batch_1');
      expect(betaBatchesResults).toHaveBeenCalledWith('batch_1', { betas: FILES_BETA });
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
      betaBatchesResults.mockResolvedValue(gen());
      const results = await service.getBatchResults('batch_1');
      expect(results).toEqual([
        { customId: 'a', type: 'canceled', error: 'canceled' },
        { customId: 'b', type: 'expired', error: 'expired' },
      ]);
    });

    it('surfaces cacheReadTokens and neutral usage for succeeded items', async () => {
      async function* gen() {
        yield {
          custom_id: 'a',
          result: {
            type: 'succeeded',
            message: {
              content: [{ type: 'text', text: 'ok' }],
              usage: { input_tokens: 3, cache_read_input_tokens: 2048, output_tokens: 1 },
            },
          },
        };
      }
      betaBatchesResults.mockResolvedValue(gen());
      const results = await service.getBatchResults('batch_1');
      expect(results).toEqual([
        {
          customId: 'a',
          type: 'succeeded',
          text: 'ok',
          usage: { input: 3, cacheRead: 2048, cacheCreate5m: 0, cacheCreate1h: 0, output: 1 },
          cacheReadTokens: 2048,
        },
      ]);
    });

    it('maps a refusal stop_reason to a neutral refusal item with usage', async () => {
      async function* gen() {
        yield { custom_id: 'k', result: { type: 'succeeded', message: { stop_reason: 'refusal', content: [], usage: {} } } };
      }
      betaBatchesResults.mockResolvedValue(gen());
      const results = await service.getBatchResults('b');
      expect(results[0]).toEqual({
        customId: 'k',
        type: 'refusal',
        usage: { input: 0, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0, output: 0 },
      });
    });
  });

  describe('messageStructured', () => {
    it('non-files: sends output_config.format and parses the JSON text', async () => {
      create.mockResolvedValue({
        model: 'claude-fable-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '{"pass":true,"mismatches":[]}' }],
        usage: {},
      });
      const schema = { type: 'object', required: ['pass'] } as any;
      const out = await service.messageStructured<{ pass: boolean; mismatches: string[] }>(
        { prompt: 'verify', model: 'claude-fable-5', schema, effort: 'high' },
        { operation: 'other' },
      );
      expect(betaCreate).not.toHaveBeenCalled();
      const arg = create.mock.calls[0][0];
      expect(arg.model).toBe('claude-fable-5');
      expect(arg.output_config).toEqual({ format: { type: 'json_schema', schema }, effort: 'high' });
      expect(arg.messages).toEqual([{ role: 'user', content: 'verify' }]);
      expect(out).toEqual({ pass: true, mismatches: [] });
    });

    it("normalizes effort 'none' to 'low' — the Claude API's floor (it has no 'none' level)", async () => {
      create.mockResolvedValue({
        model: 'claude-fable-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '{}' }],
        usage: {},
      });
      await service.messageStructured(
        { prompt: 'verify', schema: { type: 'object' } as any, effort: 'none' },
        { operation: 'other' },
      );
      expect(create.mock.calls[0][0].output_config.effort).toBe('low');
    });

    it('routes to the beta client with the files beta header and a cached document tier when the envelope has a file', async () => {
      betaCreate.mockResolvedValue({
        model: 'claude-fable-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '{"bias":"b"}' }],
        usage: {},
      });
      await service.messageStructured(
        {
          prompt: 'analyze',
          model: 'claude-fable-5',
          schema: { type: 'object' } as any,
          envelope: { tiers: [{ blocks: [{ type: 'file', fileId: 'file_1' }] }] },
        },
        { operation: 'other' },
      );
      expect(create).not.toHaveBeenCalled();
      const arg = betaCreate.mock.calls[0][0];
      expect(arg.betas).toEqual(FILES_BETA);
      // The document tier is cached (last-block breakpoint) and the prompt is appended uncached.
      expect(arg.messages[0].content[0]).toMatchObject({ type: 'document', source: { type: 'file', file_id: 'file_1' } });
      expect(arg.messages[0].content[arg.messages[0].content.length - 1]).toEqual({ type: 'text', text: 'analyze' });
    });

    it('stamps one 1h breakpoint on each tier last block with no system breakpoint', async () => {
      create.mockResolvedValue({
        model: 'claude-fable-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '{}' }],
        usage: {},
      });
      await service.messageStructured(
        {
          prompt: 'go',
          model: 'claude-fable-5',
          envelope: {
            tiers: [
              { blocks: [{ type: 'text', text: 'general' }] },
              { blocks: [{ type: 'text', text: 'day-a' }, { type: 'text', text: 'day-b' }] },
              { blocks: [{ type: 'text', text: 'persona' }] },
            ],
          },
        },
        { operation: 'other' },
      );
      const arg = create.mock.calls[0][0];
      expect(arg.messages[0].content).toEqual([
        { type: 'text', text: 'general', cache_control: CC },
        { type: 'text', text: 'day-a' },
        { type: 'text', text: 'day-b', cache_control: CC },
        { type: 'text', text: 'persona', cache_control: CC },
        { type: 'text', text: 'go' },
      ]);
      // The whole cached prefix lives in messages: no system breakpoint.
      expect(arg.system).toBeUndefined();
    });

    it('throws 400 when breakpoints exceed 4 (5 tiers, no system)', async () => {
      let caught: unknown;
      try {
        await service.messageStructured(
          {
            prompt: 'x',
            envelope: {
              tiers: [
                { blocks: [{ type: 'text', text: '1' }] },
                { blocks: [{ type: 'text', text: '2' }] },
                { blocks: [{ type: 'text', text: '3' }] },
                { blocks: [{ type: 'text', text: '4' }] },
                { blocks: [{ type: 'text', text: '5' }] },
              ],
            },
          },
          { operation: 'other' },
        );
      } catch (e) {
        caught = e;
      }
      expect((caught as HttpException).getStatus()).toBe(400);
      expect(create).not.toHaveBeenCalled();
      expect(betaCreate).not.toHaveBeenCalled();
    });

    it('throws a 422 when the model refuses (stop_reason refusal)', async () => {
      create.mockResolvedValue({ model: 'claude-fable-5', stop_reason: 'refusal', content: [], usage: {} });
      let caught: unknown;
      try {
        await service.messageStructured({ prompt: 'x', schema: { type: 'object' } as any }, { operation: 'other' });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(HttpException);
      expect((caught as HttpException).getStatus()).toBe(422);
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
        await service.messageStructured({ prompt: 'x', schema: { type: 'object' } as any }, { operation: 'other' });
      } catch (e) {
        caught = e;
      }
      expect((caught as HttpException).getStatus()).toBe(502);
    });

    it('sends req.system when the envelope carries no system of its own', async () => {
      create.mockResolvedValue({
        model: 'claude-fable-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '{}' }],
        usage: {},
      });
      await service.messageStructured({ prompt: 'go', system: 'be terse' }, { operation: 'other' });
      const arg = create.mock.calls[0][0];
      expect(arg.system).toBe('be terse');
    });

    it('prefers the envelope system over req.system when both are set', async () => {
      create.mockResolvedValue({
        model: 'claude-fable-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '{}' }],
        usage: {},
      });
      await service.messageStructured(
        { prompt: 'go', system: 'be terse', envelope: { system: 'context system' } },
        { operation: 'other' },
      );
      const arg = create.mock.calls[0][0];
      expect(arg.system).toEqual([{ type: 'text', text: 'context system', cache_control: CC }]);
    });
  });

  describe('uploadFile', () => {
    it('posts to the beta Files API in a single-arg call and returns the id', async () => {
      filesUpload.mockResolvedValue({ id: 'file_123' });
      const id = await service.uploadFile(Buffer.from('PDF'), 'x.pdf', 'application/pdf');
      expect(id).toBe('file_123');
      expect(filesUpload).toHaveBeenCalledWith({
        file: expect.objectContaining({ __uploadable: true, filename: 'x.pdf', type: 'application/pdf' }),
        betas: FILES_BETA,
      });
    });
  });
}); // describe('AnthropicLlmProvider')

describe('AnthropicLlmProvider usage emission', () => {
  function build() {
    const emit = jest.fn();
    const create = jest.fn().mockResolvedValue({
      model: 'claude-fable-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 0, service_tier: 'standard' },
    });
    const config = { get: (k: string) => (k === 'anthropic.model' ? 'claude-fable-5' : 4096) };
    const clientFactory = { get: () => ({ messages: { create }, beta: { messages: { create } } }) };
    const svc = new (require('./anthropic.service').AnthropicLlmProvider)(clientFactory, config, { emit });
    return { svc, emit, create };
  }

  it('message() emits an llm.usage event with the caller-supplied attribution', async () => {
    const { svc, emit } = build();
    await svc.message({ prompt: 'x', attribution: { operation: 'demo' } });
    expect(emit).toHaveBeenCalledWith('llm.usage', expect.objectContaining({
      modelId: 'claude-fable-5',
      serviceTier: 'standard',
      source: 'sync',
      attribution: { operation: 'demo' },
      tokens: expect.objectContaining({ input: 10, output: 3 }),
    }));
  });

  it('emits the attribution verbatim — there is no silent default', async () => {
    const { svc, emit } = build();
    await svc.message({ prompt: 'x', attribution: { operation: 'message' } });
    expect(emit).toHaveBeenCalledWith('llm.usage', expect.objectContaining({ attribution: { operation: 'message' } }));
  });

  it('messageStructured emits usage even on a refusal (refusals are still billed)', async () => {
    const { svc, emit, create } = build();
    create.mockResolvedValue({ model: 'claude-fable-5', stop_reason: 'refusal', content: [], usage: { input_tokens: 50, output_tokens: 2 } });
    await expect(svc.messageStructured({ prompt: 'x' }, { operation: 'keys-generation' })).rejects.toBeDefined();
    expect(emit).toHaveBeenCalledWith('llm.usage', expect.objectContaining({
      attribution: { operation: 'keys-generation' },
      tokens: expect.objectContaining({ input: 50, output: 2 }),
    }));
  });
});

describe('AnthropicLlmProvider port surface', () => {
  // Build a provider with a stub SDK client. Only the methods a given test
  // exercises are provided; `clientFactory.get()` returns this stub.
  const build = (client: any) => {
    const clientFactory = { get: () => client };
    const config = { get: () => undefined };            // falls back to default model/maxTokens
    const emit = jest.fn();
    return new AnthropicLlmProvider(clientFactory as any, config as any, { emit } as any);
  };

  it('declares full capabilities', () => {
    const svc = build({});
    expect(svc.capabilities).toEqual({ batch: true, fileUpload: true, promptCaching: true, structuredOutput: true });
  });

  it('submitBatch renders a neutral file block as a beta document and always uses the beta path', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'batch_1', processing_status: 'in_progress' });
    const svc = build({ beta: { messages: { batches: { create } } } });
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

  it('submitBatch uses the beta path even for a fileless batch (uniform beta)', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'batch_2', processing_status: 'in_progress' });
    const svc = build({ beta: { messages: { batches: { create } } } });
    await svc.submitBatch([{ customId: 'k1', prompt: 'go' }], undefined, { model: 'm' });
    expect(create.mock.calls[0][0].betas).toContain('files-api-2025-04-14');
  });

  it('getBatch maps processing_status to a neutral lifecycle', async () => {
    const retrieve = jest.fn().mockResolvedValue({ id: 'b', processing_status: 'ended', request_counts: {} });
    const svc = build({ beta: { messages: { batches: { retrieve } } } });
    await expect(svc.getBatch('b')).resolves.toEqual({ batchId: 'b', status: 'ended', requestCounts: {} });
  });

  it('getBatchResults returns neutral UsageTokens, not raw usage', async () => {
    async function* results() {
      yield { custom_id: 'k1', result: { type: 'succeeded', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 3, cache_read_input_tokens: 2, output_tokens: 1 } } } };
    }
    const svc = build({ beta: { messages: { batches: { results: jest.fn().mockResolvedValue(results()) } } } });
    const [item] = await svc.getBatchResults('b');
    expect(item.usage).toEqual({ input: 3, cacheRead: 2, cacheCreate5m: 0, cacheCreate1h: 0, output: 1 });
    expect(item.cacheReadTokens).toBe(2);
  });
});
