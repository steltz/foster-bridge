import { UsageTokens } from '../cost/cost.types';
import { tokensFromUsage } from './moonshot.usage';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** A fully-rendered Moonshot chat request body (sampling params intentionally omitted). */
export interface MoonshotChatBody {
  model: string;
  messages: ChatMessage[];
  max_completion_tokens: number;
  reasoning_effort: string;
  prompt_cache_key?: string;
  response_format?: unknown;
}

export interface MoonshotChatResult {
  text: string;
  finishReason: string | null;
  usage: UsageTokens;
  rawUsage: any;
}

// Map benchmark/seven-keys effort strings onto Moonshot's low|high|max set.
export function mapEffort(effort?: string): string {
  switch (effort) {
    case 'low':
    case 'high':
    case 'max':
      return effort;
    default:
      return 'high';
  }
}

// D8: shape a JSON schema for Moonshot strict json_schema. OpenAI-strict semantics
// forbid optional properties (every `properties` key must be in `required`), unlike
// the Anthropic validator SETUP_SCHEMA was written for — so add all keys to
// `required` and make originally-optional ones nullable. The reconciler already
// tolerates a null/missing optional (e.g. rejectedAlternative), so nulling is safe.
export function toMoonshotSchema(schema: any): any {
  if (!schema || schema.type !== 'object' || !schema.properties) return schema;
  const props = schema.properties as Record<string, any>;
  const required = new Set<string>(schema.required ?? []);
  const shaped: Record<string, any> = {};
  for (const [key, def] of Object.entries(props)) {
    shaped[key] = required.has(key) ? def : nullable(def);
  }
  return { ...schema, properties: shaped, required: Object.keys(props), additionalProperties: false };
}

function nullable(def: any): any {
  if (def && Array.isArray(def.type)) return def.type.includes('null') ? def : { ...def, type: [...def.type, 'null'] };
  if (def && typeof def.type === 'string') return { ...def, type: [def.type, 'null'] };
  return { anyOf: [def, { type: 'null' }] }; // enum / $ref / anyOf, etc.
}

export function jsonSchemaFormat(schema: unknown): unknown {
  return { type: 'json_schema', json_schema: { name: 'setup', strict: true, schema: toMoonshotSchema(schema) } };
}

// True when an error looks like Moonshot rejecting the json_schema / response_format.
export function isSchemaRejection(err: any): boolean {
  if (err?.status !== 400) return false;
  const type = err?.error?.type ?? err?.code;
  const blob = `${err?.message ?? ''} ${JSON.stringify(err?.error ?? {})}`;
  return type === 'invalid_request_error' || /schema|response_format|json_schema/i.test(blob);
}

// D8 fallback: issue a chat call; if a strict json_schema body is rejected, retry
// once in json_object mode with a '{' partial prefill and repair the leading brace.
export async function createChatWithFallback(client: any, body: MoonshotChatBody): Promise<any> {
  try {
    return await client.chat.completions.create(body);
  } catch (err) {
    const isJsonSchema = (body.response_format as any)?.type === 'json_schema';
    if (!isJsonSchema || !isSchemaRejection(err)) throw err;
    const fallback = {
      ...body,
      response_format: { type: 'json_object' },
      messages: [...body.messages, { role: 'assistant', content: '{', partial: true }],
    };
    const resp = await client.chat.completions.create(fallback);
    const content = resp?.choices?.[0]?.message?.content ?? '';
    // Partial mode does not echo the '{' prefill; repair it. A json_object response
    // that ignored the prefill already leads with '{', so guard on it.
    if (resp?.choices?.[0]?.message && !content.trimStart().startsWith('{')) {
      resp.choices[0].message.content = '{' + content;
    }
    return resp;
  }
}

// Extract text/finish-reason/usage from an OpenAI-compatible chat response.
export function toChatResult(resp: any): MoonshotChatResult {
  const choice = resp?.choices?.[0];
  const rawUsage = resp?.usage;
  return {
    text: choice?.message?.content ?? '',
    finishReason: choice?.finish_reason ?? null,
    usage: tokensFromUsage(rawUsage),
    rawUsage,
  };
}
