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
