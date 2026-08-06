import { Logger } from '@nestjs/common';
import { UsageTokens } from '../cost/cost.types';
import { tokensFromUsage } from './moonshot.usage';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  partial?: boolean;
}

/** Minimal structural shape of an OpenAI-compatible chat client — just enough to
 *  call createChatWithFallback without importing the real SDK's types here. */
export interface MoonshotChatClient {
  chat: {
    completions: {
      create(body: unknown): Promise<any>;
    };
  };
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

const logger = new Logger('MoonshotChat');
// Distinct unrecognized effort strings already warned about, so a misconfigured
// caller (e.g. a benchmark variant passing 'medium') logs once per distinct
// value rather than once per request.
const warnedEfforts = new Set<string>();

// Map benchmark/seven-keys effort strings onto Moonshot's low|high|max set.
// Anything else silently upgrades to 'high' — but only after a one-time warning
// per distinct unrecognized value, since a real misconfigured value (e.g.
// 'medium') upgrading silently would otherwise skew benchmark comparability.
export function mapEffort(effort?: string): string {
  switch (effort) {
    case 'low':
    case 'high':
    case 'max':
      return effort;
    default:
      if (effort !== undefined && !warnedEfforts.has(effort)) {
        warnedEfforts.add(effort);
        logger.warn(`Unrecognized reasoning effort "${effort}" — mapping to "high"`);
      }
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
    const typed = withEnumType(def);
    shaped[key] = required.has(key) ? typed : nullable(typed);
  }
  return { ...schema, properties: shaped, required: Object.keys(props), additionalProperties: false };
}

// Moonshot's MFJS validator rejects any property whose schema has no `type`
// — including a bare `{enum: [...]}` — with a hard 400 ("type is not
// defined"). Unlike OpenAI's/Anthropic's validators, which tolerate an
// enum-only property, MFJS does not; the request then fails, and
// createChatWithFallback silently retries in unconstrained json_object mode,
// so the schema stops being enforced at all with no visible error. Infer
// `type` from the enum's own values so a schema author forgetting to repeat
// it can't quietly degrade every request this way.
function withEnumType(def: any): any {
  if (!def || def.type !== undefined || !Array.isArray(def.enum)) return def;
  const sample = def.enum.find((v: any) => v !== null);
  const type = typeof sample;
  if (type !== 'string' && type !== 'number' && type !== 'boolean') return def;
  return { ...def, type };
}

function nullable(def: any): any {
  if (def && Array.isArray(def.type)) {
    const type = def.type.includes('null') ? def.type : [...def.type, 'null'];
    return { ...def, type, ...withNullEnum(def) };
  }
  if (def && typeof def.type === 'string') {
    return { ...def, type: [def.type, 'null'], ...withNullEnum(def) };
  }
  return { anyOf: [def, { type: 'null' }] }; // enum-only / $ref / anyOf, etc.
}

// Appends `null` to `def.enum` when present, so a nullable-typed enum property
// actually permits the null its widened `type` array claims to allow.
function withNullEnum(def: any): { enum?: any[] } {
  if (!Array.isArray(def?.enum)) return {};
  return { enum: def.enum.includes(null) ? def.enum : [...def.enum, null] };
}

export function jsonSchemaFormat(schema: unknown): unknown {
  return { type: 'json_schema', json_schema: { name: 'setup', strict: true, schema: toMoonshotSchema(schema) } };
}

// True when an error looks like Moonshot rejecting the json_schema / response_format.
export function isSchemaRejection(err: any): boolean {
  if (err?.status !== 400) return false;
  const type = err?.error?.type ?? err?.code;
  const blob = `${err?.message ?? ''} ${JSON.stringify(err?.error ?? {})}`;
  // A context-length / token-limit 400 is not a schema rejection — retrying in
  // json_object mode appends a fallback message, which only enlarges an
  // already-too-large request, so don't burn a retry on it.
  if (/context.?length|max_completion_tokens|too many tokens/i.test(blob)) return false;
  return type === 'invalid_request_error' || /schema|response_format|json_schema/i.test(blob);
}

// D8 fallback: issue a chat call; if a strict json_schema body is rejected, retry
// once in json_object mode with a '{' partial prefill and repair the leading brace.
export async function createChatWithFallback(client: MoonshotChatClient, body: MoonshotChatBody): Promise<any> {
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
