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
 * final `user` message. prompt_cache_key = sha256 of the SHARED prefix — the
 * system message plus at most the first two tiers (general docs + day bundle in
 * benchmark envelopes), NOT the full prefix. The key is only a routing hint;
 * matching stays byte-prefix-based, so a coarser key cannot cause a wrong hit —
 * it groups every persona/feature variant of the same day into one cache
 * bucket, making cross-variant hits on the shared tiers possible where
 * per-full-prefix keys could route them to different cache shards. When there
 * is no stable prefix at all (no system, no tiers), there is nothing to key a
 * shared cache on, so promptCacheKey is left undefined rather than sending
 * sha256('') — which would otherwise route every envelope-less request into one
 * shared cache bucket.
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

    // System message (0 or 1) + at most the first two tier messages — the
    // shared-prefix boundary described in the class docstring.
    const systemCount = messages.length - (envelope?.tiers?.length ?? 0);
    const keyed = messages.slice(0, systemCount + 2);
    const promptCacheKey = keyed.length === 0
      ? undefined
      : createHash('sha256')
          .update(keyed.map((m) => `${m.role}\n${m.content}`).join('\n\x00\n'))
          .digest('hex');
    messages.push({ role: 'user', content: prompt });
    return { messages, promptCacheKey };
  }
}
