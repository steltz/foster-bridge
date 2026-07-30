import { MoonshotLlmProvider } from './moonshot.service';
import { LlmProvider } from '../llm/llm.provider';

describe('MoonshotLlmProvider satisfies the LlmProvider contract', () => {
  it('exposes every port method and full capabilities', () => {
    const svc = new MoonshotLlmProvider(
      { get: () => { throw new Error('unused'); } } as any, // client factory
      { get: () => undefined } as any, // ConfigService
      { emit: () => true } as any, // EventEmitter2
      { buildRequest: async () => ({ messages: [], promptCacheKey: '' }) } as any, // envelope builder
      { getById: async () => null, getByHash: async () => null, put: async () => {} } as any, // extract store
      {} as any, // batch store
      { kick: () => {} } as any, // worker
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
