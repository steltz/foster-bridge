import { Logger } from '@nestjs/common';
import {
  toMoonshotSchema,
  jsonSchemaFormat,
  createChatWithFallback,
  mapEffort,
  isSchemaRejection,
  toChatResult,
} from './moonshot.chat';
import { SETUP_SCHEMA } from '../benchmark/benchmark.types';
import { CURRENT_SCHEMA, LOOKBACK_SCHEMA, SYNTH_SCHEMA, VERIFY_SCHEMA } from '../benchmark/seven-keys/schemas';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('toMoonshotSchema (D8)', () => {
  it('marks every property required and makes optionals nullable', () => {
    const shaped = toMoonshotSchema({
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      additionalProperties: false,
    }) as any;
    expect(shaped.required.sort()).toEqual(['a', 'b']);
    expect(shaped.properties.a).toEqual({ type: 'string' });          // required: unchanged
    expect(shaped.properties.b).toEqual({ type: ['string', 'null'] }); // optional: nullable
  });
});

describe('toMoonshotSchema (D8) — nullable enums', () => {
  it('appends null to enum values for an optional enum property (type + enum)', () => {
    const shaped = toMoonshotSchema({
      type: 'object',
      required: [],
      properties: { color: { type: 'string', enum: ['a', 'b'] } },
    }) as any;
    expect(shaped.properties.color.type).toEqual(['string', 'null']);
    expect(shaped.properties.color.enum).toEqual(['a', 'b', null]);
  });
});

describe('toMoonshotSchema (D8) — anyOf branch + additionalProperties injection', () => {
  it('wraps an optional enum-only property (no type field) in anyOf with a null alternative', () => {
    const shaped = toMoonshotSchema({
      type: 'object',
      required: [],
      properties: { side: { enum: ['long', 'short'] } },
    }) as any;
    expect(shaped.properties.side).toEqual({ anyOf: [{ enum: ['long', 'short'] }, { type: 'null' }] });
  });

  it('wraps an optional $ref-style property (no type field) in anyOf with a null alternative', () => {
    const shaped = toMoonshotSchema({
      type: 'object',
      required: [],
      properties: { thing: { $ref: '#/definitions/Thing' } },
    }) as any;
    expect(shaped.properties.thing).toEqual({ anyOf: [{ $ref: '#/definitions/Thing' }, { type: 'null' }] });
  });

  it('injects additionalProperties: false at the top level even when absent from the input', () => {
    const shaped = toMoonshotSchema({
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string' } },
    }) as any;
    expect(shaped.additionalProperties).toBe(false);
  });
});

// Recursively verifies OpenAI-strict invariants on `shaped` (toMoonshotSchema's
// output). `original` is only used to know which subtrees were already "closed"
// (every property already required) — the shaper doesn't recurse, so nested
// schemas pass straight through unchanged; we only assert closedness there if
// the input already had it, and skip otherwise (don't overreach beyond what the
// shaper actually promises). Purpose: break loudly if a schema gains a nested
// optional field this shaper silently ignores.
function assertStrictSchema(shaped: any, original: any): void {
  if (!shaped || typeof shaped !== 'object') return;
  if (shaped.properties) {
    const keys = Object.keys(shaped.properties);
    const origKeys = original?.properties ? Object.keys(original.properties) : [];
    const origRequired = new Set(original?.required ?? []);
    const wasClosed = origKeys.length > 0 && origKeys.every((k) => origRequired.has(k));
    if (wasClosed) expect([...(shaped.required ?? [])].sort()).toEqual([...keys].sort());
    for (const key of keys) assertStrictSchema(shaped.properties[key], original?.properties?.[key]);
  }
  if (shaped.items) assertStrictSchema(shaped.items, original?.items);
}

describe('toMoonshotSchema schema gate (real schemas)', () => {
  const realSchemas: Record<string, any> = { SETUP_SCHEMA, CURRENT_SCHEMA, LOOKBACK_SCHEMA, SYNTH_SCHEMA, VERIFY_SCHEMA };

  it.each(Object.keys(realSchemas))('%s: shaped output satisfies OpenAI-strict invariants', (name) => {
    const original = realSchemas[name];
    const shaped = toMoonshotSchema(original) as any;

    expect(shaped.additionalProperties).toBe(false);
    expect([...shaped.required].sort()).toEqual(Object.keys(shaped.properties).sort());

    const originalRequired = new Set(original.required ?? []);
    for (const key of Object.keys(shaped.properties)) {
      if (!originalRequired.has(key)) {
        const def = shaped.properties[key];
        const admitsNull = Array.isArray(def.type)
          ? def.type.includes('null')
          : Array.isArray(def.anyOf) && def.anyOf.some((d: any) => d?.type === 'null');
        expect(admitsNull).toBe(true);
      }
    }

    assertStrictSchema(shaped, original);
  });
});

describe('jsonSchemaFormat', () => {
  it('wraps a shaped schema in strict json_schema', () => {
    const f = jsonSchemaFormat({ type: 'object', required: [], properties: { x: { type: 'number' } } }) as any;
    expect(f.type).toBe('json_schema');
    expect(f.json_schema.strict).toBe(true);
    expect(f.json_schema.schema.required).toEqual(['x']);
  });
});

describe('mapEffort', () => {
  it('passes low/high/max through unchanged', () => {
    expect(mapEffort('low')).toBe('low');
    expect(mapEffort('high')).toBe('high');
    expect(mapEffort('max')).toBe('max');
  });

  it('maps an unrecognized effort to high and warns exactly once across repeated calls', () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined as any);
    expect(mapEffort('medium')).toBe('high');
    expect(mapEffort('medium')).toBe('high');
    expect(mapEffort('medium')).toBe('high');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('maps undefined effort to high without warning', () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined as any);
    expect(mapEffort(undefined)).toBe('high');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('mapEffort (table)', () => {
  it.each([
    ['low', 'low'],
    ['high', 'high'],
    ['max', 'max'],
    ['turbo', 'high'],
  ])('mapEffort(%s) -> %s', (input, expected) => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined as any);
    expect(mapEffort(input)).toBe(expected);
  });
});

describe('isSchemaRejection', () => {
  it('returns false for a context-length 400 (not a schema rejection)', () => {
    const err = Object.assign(new Error('This model\'s maximum context length is 131072 tokens'), {
      status: 400,
      error: { type: 'invalid_request_error' },
    });
    expect(isSchemaRejection(err)).toBe(false);
  });

  it('returns true for a genuine schema-rejection 400', () => {
    const err = Object.assign(new Error('Invalid schema for response_format'), {
      status: 400,
      error: { type: 'invalid_request_error' },
    });
    expect(isSchemaRejection(err)).toBe(true);
  });
});

describe('createChatWithFallback (D8)', () => {
  it('falls back to json_object + brace repair when strict json_schema is rejected', async () => {
    let call = 0;
    const client = { chat: { completions: { create: async (body: any) => {
      call++;
      if (call === 1) throw Object.assign(new Error('bad schema'), { status: 400, error: { type: 'invalid_request_error' } });
      expect(body.response_format).toEqual({ type: 'json_object' });
      expect(body.messages[body.messages.length - 1]).toEqual({ role: 'assistant', content: '{', partial: true });
      return { choices: [{ message: { content: '"a":1}' }, finish_reason: 'stop' }] };
    } } } };
    const resp = await createChatWithFallback(client as any, { model: 'kimi-k3', messages: [{ role: 'user', content: 'x' }], max_completion_tokens: 10, reasoning_effort: 'high', response_format: { type: 'json_schema' } as any });
    expect(resp.choices[0].message.content).toBe('{"a":1}');
    expect(call).toBe(2);
  });

  it('rethrows a non-schema error unchanged', async () => {
    const client = { chat: { completions: { create: async () => { throw Object.assign(new Error('boom'), { status: 500 }); } } } };
    await expect(createChatWithFallback(client as any, { model: 'k', messages: [], max_completion_tokens: 1, reasoning_effort: 'high', response_format: { type: 'json_schema' } as any })).rejects.toThrow('boom');
  });

  it('does not double the leading brace when the json_object fallback response already starts with {', async () => {
    let call = 0;
    const client = { chat: { completions: { create: async () => {
      call++;
      if (call === 1) throw Object.assign(new Error('bad schema'), { status: 400, error: { type: 'invalid_request_error' } });
      // Model ignored the '{' prefill and re-emitted its own leading brace.
      return { choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }] };
    } } } };
    const resp = await createChatWithFallback(client as any, { model: 'kimi-k3', messages: [{ role: 'user', content: 'x' }], max_completion_tokens: 10, reasoning_effort: 'high', response_format: { type: 'json_schema' } as any });
    expect(resp.choices[0].message.content).toBe('{"a":1}');
  });
});

describe('toChatResult', () => {
  it('defaults text to empty string and finishReason to null when choices are missing', () => {
    const result = toChatResult({});
    expect(result.text).toBe('');
    expect(result.finishReason).toBeNull();
  });

  it('maps usage via tokensFromUsage', () => {
    const resp = {
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, cached_tokens: 40, completion_tokens: 10 },
    };
    const result = toChatResult(resp);
    expect(result.text).toBe('hi');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ input: 60, cacheRead: 40, cacheCreate5m: 0, cacheCreate1h: 0, output: 10 });
    expect(result.rawUsage).toBe(resp.usage);
  });
});
