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
}); // describe('AnthropicService')
