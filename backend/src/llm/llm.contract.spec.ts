import { AnthropicLlmProvider } from '../anthropic/anthropic.service';
import { LlmProvider } from './llm.provider';

describe('AnthropicLlmProvider satisfies the LlmProvider contract', () => {
  it('exposes every port method and full capabilities', () => {
    // Construct with stub deps in the real constructor arg order
    // (clientFactory, ConfigService, EventEmitter2). The client factory is
    // unused until a call is made, so it can throw here.
    const svc = new AnthropicLlmProvider(
      { get: () => { throw new Error('unused'); } } as any,
      { get: () => undefined } as any, // ConfigService
      { emit: () => true } as any,     // EventEmitter2
    );
    const port: LlmProvider = svc; // compile-time contract assertion
    expect(typeof port.messageStructured).toBe('function');
    expect(typeof port.uploadFile).toBe('function');
    expect(typeof port.submitBatch).toBe('function');
    expect(typeof port.getBatch).toBe('function');
    expect(typeof port.getBatchResults).toBe('function');
    expect(port.capabilities).toEqual({ batch: true, fileUpload: true, promptCaching: true, structuredOutput: true });
  });
});
