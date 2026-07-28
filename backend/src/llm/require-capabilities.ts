import { LlmProvider, LlmCapabilities } from './llm.provider';

/** Throws a clear error if the provider lacks any of the required capabilities. */
export function requireCapabilities(
  provider: LlmProvider,
  required: (keyof LlmCapabilities)[],
): void {
  const missing = required.filter((k) => !provider.capabilities[k]);
  if (missing.length) {
    throw new Error(`Configured LLM provider lacks required capabilities: ${missing.join(', ')}`);
  }
}
