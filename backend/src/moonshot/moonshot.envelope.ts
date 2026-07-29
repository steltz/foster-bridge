import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PromptEnvelope } from '../llm/llm.types';
import { MoonshotExtractStore } from './moonshot.extract-store';
import { ChatMessage } from './moonshot.chat';

export interface BuiltRequest {
  messages: ChatMessage[];
  promptCacheKey: string | undefined;
}

/**
 * Renders a neutral PromptEnvelope into OpenAI-compatible messages for Moonshot.
 * Moonshot caches implicitly on a byte-identical prefix, so there are no cache
 * breakpoints: stable tiers become leading `system` messages (file blocks
 * resolved to their extracted text), and the variable per-request prompt is the
 * final `user` message. prompt_cache_key = sha256 of the stable prefix, so all
 * runs sharing a prefix route to the same cache. When there is no stable prefix
 * at all (no system, no tiers), there is nothing to key a shared cache on, so
 * promptCacheKey is left undefined rather than sending sha256('') — which would
 * otherwise route every envelope-less request into one shared cache bucket.
 */
@Injectable()
export class MoonshotEnvelopeBuilder {
  constructor(private readonly extracts: MoonshotExtractStore) {}

  async buildRequest(envelope: PromptEnvelope | undefined, prompt: string, system?: string): Promise<BuiltRequest> {
    const messages: ChatMessage[] = [];
    if (envelope?.system) messages.push({ role: 'system', content: envelope.system });
    else if (system) messages.push({ role: 'system', content: system });

    for (const tier of envelope?.tiers ?? []) {
      const parts: string[] = [];
      for (const block of tier.blocks) {
        if (block.type === 'text') {
          parts.push(block.text);
        } else {
          const text = await this.extracts.getById(block.fileId);
          if (text == null) {
            throw new Error(`Moonshot: no extracted text for file id ${block.fileId}`);
          }
          parts.push(text);
        }
      }
      messages.push({ role: 'system', content: parts.join('\n') });
    }

    const promptCacheKey = messages.length === 0
      ? undefined
      : createHash('sha256')
          .update(messages.map((m) => `${m.role}\n${m.content}`).join('\n\x00\n'))
          .digest('hex');
    messages.push({ role: 'user', content: prompt });
    return { messages, promptCacheKey };
  }
}
