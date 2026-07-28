import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import { AnthropicDemoController } from './anthropic-demo.controller';
import { AnthropicLlmProvider } from '../anthropic/anthropic.service';

describe('AnthropicDemoController', () => {
  let controller: AnthropicDemoController;
  const anthropic = {
    message: jest.fn(),
    submitBatch: jest.fn(),
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
        { provide: AnthropicLlmProvider, useValue: anthropic },
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
        { provide: AnthropicLlmProvider, useValue: anthropic },
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
    expect(anthropic.message).toHaveBeenCalledWith({ prompt: 'yo', attribution: { operation: 'demo' } });
  });

  it('createBatch submits the mapped requests array (defaulting to [])', async () => {
    anthropic.submitBatch.mockResolvedValue({ batchId: 'b1', status: 'in_progress' });
    await controller.createBatch({ requests: [{ prompt: 'a' }] });
    expect(anthropic.submitBatch).toHaveBeenCalledWith([{ customId: undefined, prompt: 'a' }], undefined, {});
    await controller.createBatch({} as { requests: [] });
    expect(anthropic.submitBatch).toHaveBeenCalledWith([], undefined, {});
  });

  it('getBatch delegates to the service', async () => {
    anthropic.getBatch.mockResolvedValue({ batchId: 'b1', status: 'ended' });
    await controller.getBatch('b1');
    expect(anthropic.getBatch).toHaveBeenCalledWith('b1');
  });

  it('getBatchResults returns results when the batch has ended', async () => {
    anthropic.getBatch.mockResolvedValue({ batchId: 'b1', status: 'ended' });
    anthropic.getBatchResults.mockResolvedValue([{ customId: 'a', type: 'succeeded', text: 'ok' }]);
    const results = await controller.getBatchResults('b1');
    expect(results).toEqual([{ customId: 'a', type: 'succeeded', text: 'ok' }]);
  });

  it('getBatchResults throws 409 when the batch has not ended', async () => {
    anthropic.getBatch.mockResolvedValue({ batchId: 'b1', status: 'in_progress' });
    await expect(controller.getBatchResults('b1')).rejects.toBeInstanceOf(ConflictException);
    expect(anthropic.getBatchResults).not.toHaveBeenCalled();
  });
});
