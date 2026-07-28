import { LlmCapabilities, LlmProvider } from './llm.provider';
import {
  Attribution,
  BatchHandle,
  BatchItemRequest,
  BatchItemResult,
  BatchLifecycle,
  BatchSubmitOptions,
  PromptEnvelope,
  StructuredRequest,
} from './llm.types';

interface RecordedBatch {
  batchId: string;
  requests: BatchItemRequest[];
  envelope?: PromptEnvelope;
  opts: BatchSubmitOptions;
}

/**
 * In-memory LlmProvider double for benchmark unit tests. Callers push canned
 * structured responses / batch results and read back what was submitted. Proves
 * the benchmark is provider-agnostic — no Anthropic SDK involved.
 */
export class FakeLlmProvider implements LlmProvider {
  capabilities: LlmCapabilities = {
    batch: true,
    fileUpload: true,
    promptCaching: true,
    structuredOutput: true,
  };

  submittedBatches: RecordedBatch[] = [];
  structuredResponses: unknown[] = [];
  structuredCalls: { req: StructuredRequest; attribution: Attribution }[] = [];
  uploads: { filename: string; mediaType: string }[] = [];
  batchStatus: BatchLifecycle = 'submitted';
  batchResults: BatchItemResult[] = [];

  private seq = 0;

  async messageStructured<T = unknown>(req: StructuredRequest, attribution: Attribution): Promise<T> {
    this.structuredCalls.push({ req, attribution });
    if (!this.structuredResponses.length) {
      throw new Error('FakeLlmProvider: no canned structuredResponses queued');
    }
    return this.structuredResponses.shift() as T;
  }

  async uploadFile(_bytes: Buffer, filename: string, mediaType: string): Promise<string> {
    this.uploads.push({ filename, mediaType });
    return `fake-file-${++this.seq}`;
  }

  async submitBatch(
    requests: BatchItemRequest[],
    envelope: PromptEnvelope | undefined,
    opts: BatchSubmitOptions,
  ): Promise<BatchHandle> {
    const batchId = `fake-batch-${++this.seq}`;
    this.submittedBatches.push({ batchId, requests, envelope, opts });
    return { batchId, status: 'submitted' };
  }

  async getBatch(batchId: string): Promise<BatchHandle> {
    return { batchId, status: this.batchStatus };
  }

  async getBatchResults(_batchId: string): Promise<BatchItemResult[]> {
    return this.batchResults;
  }
}
