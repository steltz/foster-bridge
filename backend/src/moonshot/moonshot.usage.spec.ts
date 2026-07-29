import { tokensFromUsage } from './moonshot.usage';

describe('tokensFromUsage – moonshot', () => {
  it('splits prompt_tokens into uncached input and cache-read', () => {
    expect(tokensFromUsage({ prompt_tokens: 1000, cached_tokens: 300, completion_tokens: 50 })).toEqual({
      input: 700, cacheRead: 300, cacheCreate5m: 0, cacheCreate1h: 0, output: 50,
    });
  });

  it('defaults everything to 0 and never returns negative input', () => {
    expect(tokensFromUsage(undefined)).toEqual({
      input: 0, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0, output: 0,
    });
    expect(tokensFromUsage({ prompt_tokens: 10, cached_tokens: 40 }).input).toBe(0);
  });
});
