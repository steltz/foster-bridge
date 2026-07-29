import { toMoonshotSchema, jsonSchemaFormat, createChatWithFallback } from './moonshot.chat';

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

describe('jsonSchemaFormat', () => {
  it('wraps a shaped schema in strict json_schema', () => {
    const f = jsonSchemaFormat({ type: 'object', required: [], properties: { x: { type: 'number' } } }) as any;
    expect(f.type).toBe('json_schema');
    expect(f.json_schema.strict).toBe(true);
    expect(f.json_schema.schema.required).toEqual(['x']);
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
});
