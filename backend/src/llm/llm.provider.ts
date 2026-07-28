import {
  Attribution,
  BatchHandle,
  BatchItemRequest,
  BatchItemResult,
  BatchSubmitOptions,
  PromptEnvelope,
  StructuredRequest,
} from './llm.types';

export interface LlmCapabilities {
  batch: boolean;
  fileUpload: boolean;
  promptCaching: boolean;
  structuredOutput: boolean;
}

/**
 * Provider-neutral LLM port the benchmark depends on. The Anthropic adapter is
 * the only implementation today; a future provider implements this same surface.
 * `message()` and `warmCache()` are deliberately NOT on the port — they are
 * demo-only / unused-by-benchmark and stay on the concrete adapter.
 */
export interface LlmProvider {
  readonly capabilities: LlmCapabilities;

  /** One synchronous structured-output call; returns parsed JSON. Refusal throws. */
  messageStructured<T = unknown>(req: StructuredRequest, attribution: Attribution): Promise<T>;

  /** Uploads bytes to the provider and returns a neutral file id. */
  uploadFile(bytes: Buffer, filename: string, mediaType: string): Promise<string>;

  submitBatch(
    requests: BatchItemRequest[],
    envelope: PromptEnvelope | undefined,
    opts: BatchSubmitOptions,
  ): Promise<BatchHandle>;
  getBatch(batchId: string): Promise<BatchHandle>;
  getBatchResults(batchId: string): Promise<BatchItemResult[]>;
}
