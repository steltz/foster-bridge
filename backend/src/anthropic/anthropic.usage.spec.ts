import { tokensFromUsage, serviceTierFromUsage } from './anthropic.usage';

describe('tokensFromUsage', () => {
  it('reads the detailed cache_creation TTL split when present', () => {
    const t = tokensFromUsage({
      input_tokens: 20,
      cache_read_input_tokens: 3227,
      cache_creation_input_tokens: 16434,
      cache_creation: { ephemeral_5m_input_tokens: 434, ephemeral_1h_input_tokens: 16000 },
      output_tokens: 2157,
    });
    expect(t).toEqual({ input: 20, cacheRead: 3227, cacheCreate5m: 434, cacheCreate1h: 16000, output: 2157 });
  });

  it('attributes a flat cache_creation number to 1h (this app caches at 1h TTL)', () => {
    const t = tokensFromUsage({
      input_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 16784,
      output_tokens: 1416,
    });
    expect(t).toEqual({ input: 20, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 16784, output: 1416 });
  });

  it('defaults every field to 0 for an empty/absent usage object', () => {
    expect(tokensFromUsage(undefined)).toEqual({ input: 0, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0, output: 0 });
  });
});

describe('serviceTierFromUsage', () => {
  it('returns the usage service_tier when it is a known value', () => {
    expect(serviceTierFromUsage({ service_tier: 'batch' }, 'standard')).toBe('batch');
  });
  it('falls back when service_tier is missing or unknown', () => {
    expect(serviceTierFromUsage({ service_tier: 'weird' }, 'standard')).toBe('standard');
    expect(serviceTierFromUsage({}, 'batch')).toBe('batch');
  });
});
