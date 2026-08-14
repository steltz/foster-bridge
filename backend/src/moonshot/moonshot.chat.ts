import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
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
  /** Exactly one of reasoning_effort / thinking is set — see effortParams. */
  reasoning_effort?: string;
  thinking?: { type: 'disabled' };
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

// Opt-in dump of the exact outgoing chat body (messages, including any file
// text folded in by MoonshotEnvelopeBuilder, plus the schema/response_format)
// right before it's handed to the SDK. Off by default: a real body can carry
// an entire uploaded document's extracted text, which is too large/sensitive
// to log unconditionally. Read directly from process.env rather than
// ConfigService since this module has no DI container to draw one from.
function logPayloadIfDebug(body: unknown): void {
  if (process.env.MOONSHOT_DEBUG_PAYLOAD !== 'true') return;
  const model = (body as { model?: string })?.model;
  logger.log(`Moonshot request payload (model=${model}):\n${JSON.stringify(body, null, 2)}`);
}

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

/**
 * The effort-related slice of a chat body. 'none' means "no reasoning", and it
 * MUST be expressed as thinking:{type:'disabled'}, not reasoning_effort:
 * verified live 2026-08-14 on kimi-k2.6, the reasoning_effort param (at any
 * level, 'none' included) makes strict-json_schema decoding degenerate into a
 * whitespace loop right before the final enum value — the output truncates or
 * parses invalid on every call — while thinking-disabled completes the same
 * payload cleanly in ~40 tokens.
 */
export function effortParams(effort?: string): Pick<MoonshotChatBody, 'reasoning_effort' | 'thinking'> {
  return effort === 'none'
    ? { thinking: { type: 'disabled' } }
    : { reasoning_effort: mapEffort(effort) };
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

// Latch of (model, schema-hash) pairs whose strict json_schema body Moonshot has
// already rejected: re-probing them burns one wasted 400 on EVERY request, since
// a validator rejection is deterministic for identical input. Unbounded on
// purpose — it can only hold as many entries as there are distinct (model,
// schema) pairs in the process, a handful in practice. Process-local, so a
// restart re-probes once; that is the desired behavior when Moonshot's
// validator changes.
const schemaRejectionLatch = new Set<string>();

/** Test seam: resets the process-local schema-rejection latch. */
export function clearSchemaRejectionLatch(): void {
  schemaRejectionLatch.clear();
}

function latchKey(body: MoonshotChatBody): string {
  return `${body.model}::${createHash('sha256').update(JSON.stringify(body.response_format)).digest('hex')}`;
}

// The D8 fallback call: json_object mode with a '{' partial prefill, repairing
// the leading brace the partial mode does not echo. Exported so
// messageStructured can also reach it directly when a strict json_schema
// response comes back degenerate (see effortParams for the kimi whitespace
// loop) rather than rejected.
//
// json_object mode has no grammar to hold the schema's enums — verified live
// 2026-08-14 on kimi-k2.6, which emitted `"confidence": 0.95` for a
// high|medium|low enum — so when the original body carried a schema, it is
// restated as an instruction message the unconstrained model can follow
// (6/6 clean in the same live test).
export async function createJsonObjectFallback(client: MoonshotChatClient, body: MoonshotChatBody): Promise<any> {
  const schema = (body.response_format as any)?.json_schema?.schema;
  const instruction = schema
    ? [{
        role: 'user' as const,
        content:
          'Respond with a single JSON object that conforms EXACTLY to this JSON Schema (no extra keys, enum values verbatim):\n' +
          JSON.stringify(schema),
      }]
    : [];
  const fallback = {
    ...body,
    response_format: { type: 'json_object' },
    messages: [...body.messages, ...instruction, { role: 'assistant', content: '{', partial: true }],
  };
  logPayloadIfDebug(fallback);
  const resp = await client.chat.completions.create(fallback);
  const content = resp?.choices?.[0]?.message?.content ?? '';
  // A json_object response that ignored the prefill already leads with '{', so
  // guard on it rather than doubling the brace.
  if (resp?.choices?.[0]?.message && !content.trimStart().startsWith('{')) {
    resp.choices[0].message.content = '{' + content;
  }
  return resp;
}

// D8 fallback: issue a chat call; if a strict json_schema body is rejected, latch
// that (model, schema) pair and retry in json_object mode. A latched pair skips
// the strict probe entirely on later calls — no wasted 400 per request.
export async function createChatWithFallback(client: MoonshotChatClient, body: MoonshotChatBody): Promise<any> {
  const isJsonSchema = (body.response_format as any)?.type === 'json_schema';
  if (isJsonSchema && schemaRejectionLatch.has(latchKey(body))) {
    return createJsonObjectFallback(client, body);
  }
  try {
    logPayloadIfDebug(body);
    return await client.chat.completions.create(body);
  } catch (err) {
    if (!isJsonSchema || !isSchemaRejection(err)) throw err;
    schemaRejectionLatch.add(latchKey(body));
    return createJsonObjectFallback(client, body);
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
