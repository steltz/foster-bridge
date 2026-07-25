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
