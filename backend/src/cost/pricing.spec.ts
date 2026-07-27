import { priceUsage } from './pricing';
import { UsageTokens } from './cost.types';

const zero: UsageTokens = { input: 0, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0, output: 0 };
const TS = '2026-07-27T13:00:00.000Z';

describe('priceUsage', () => {
  it('prices fable input + output at standard tier', () => {
    const r = priceUsage({ ...zero, input: 1_000_000, output: 1_000_000 }, 'claude-fable-5', 'standard', TS);
    expect(r).not.toBeNull();
    expect(r!.cost.input).toBeCloseTo(10, 6); // $10 / MTok
    expect(r!.cost.output).toBeCloseTo(50, 6); // $50 / MTok
    expect(r!.cost.total).toBeCloseTo(60, 6);
    expect(r!.version).toBe('fable-2026-07');
  });

  it('applies cache multipliers on the input rate (fable: 1h write x2, read x0.1)', () => {
    const r = priceUsage({ ...zero, cacheCreate1h: 1_000_000, cacheRead: 1_000_000 }, 'claude-fable-5', 'standard', TS);
    expect(r!.cost.cacheCreate).toBeCloseTo(20, 6); // 10 * 2.0
    expect(r!.cost.cacheRead).toBeCloseTo(1, 6); // 10 * 0.1
    expect(r!.cost.total).toBeCloseTo(21, 6);
  });

  it('prices 5m cache writes at x1.25', () => {
    const r = priceUsage({ ...zero, cacheCreate5m: 1_000_000 }, 'claude-fable-5', 'standard', TS);
    expect(r!.cost.cacheCreate).toBeCloseTo(12.5, 6); // 10 * 1.25
  });

  it('halves everything at batch tier', () => {
    const r = priceUsage({ ...zero, input: 1_000_000, output: 1_000_000 }, 'claude-fable-5', 'batch', TS);
    expect(r!.cost.total).toBeCloseTo(30, 6); // 60 * 0.5
  });

  it('prices opus and haiku (recorded id has a date suffix)', () => {
    const opus = priceUsage({ ...zero, input: 1_000_000 }, 'claude-opus-4-8', 'standard', TS);
    expect(opus!.cost.input).toBeCloseTo(5, 6);
    const haiku = priceUsage({ ...zero, input: 1_000_000 }, 'claude-haiku-4-5-20251001', 'standard', TS);
    expect(haiku!.cost.input).toBeCloseTo(1, 6);
  });

  it('selects sonnet intro pricing before 2026-09-01 and standard after', () => {
    const intro = priceUsage({ ...zero, input: 1_000_000 }, 'claude-sonnet-5', 'standard', '2026-08-15T00:00:00.000Z');
    expect(intro!.cost.input).toBeCloseTo(2, 6); // $2 intro
    expect(intro!.version).toBe('sonnet5-intro');
    const std = priceUsage({ ...zero, input: 1_000_000 }, 'claude-sonnet-5', 'standard', '2026-09-15T00:00:00.000Z');
    expect(std!.cost.input).toBeCloseTo(3, 6); // $3 standard
    expect(std!.version).toBe('sonnet5-standard');
  });

  it('returns null for an unknown model id (never throws)', () => {
    expect(priceUsage({ ...zero, input: 100 }, 'claude-unknown-9', 'standard', TS)).toBeNull();
  });

  it('computes uncachedInputEquiv: all input-side tokens at plain input rate x tier', () => {
    // 20 input + 3227 cacheRead + 16434 1h-create = 19681 input-side tokens.
    const t = { input: 20, cacheRead: 3227, cacheCreate5m: 0, cacheCreate1h: 16434, output: 2157 };
    const std = priceUsage(t, 'claude-fable-5', 'standard', TS)!;
    expect(std.cost.uncachedInputEquiv).toBeCloseTo(19681 * 10 / 1_000_000, 8); // $10/MTok
    const batch = priceUsage(t, 'claude-fable-5', 'batch', TS)!;
    expect(batch.cost.uncachedInputEquiv).toBeCloseTo(19681 * 10 / 1_000_000 * 0.5, 8); // x0.5 batch
  });

  it('net cache benefit can be negative when 1h write premium outweighs the read discount', () => {
    // Pure 1h cache write, no reads: paid 2x input, uncached equiv is 1x -> net loss.
    const t = { input: 0, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 1_000_000, output: 0 };
    const r = priceUsage(t, 'claude-fable-5', 'standard', TS)!;
    const net = r.cost.uncachedInputEquiv - (r.cost.input + r.cost.cacheRead + r.cost.cacheCreate);
    expect(net).toBeCloseTo(10 - 20, 6); // uncached $10 vs paid $20 write -> -$10
    expect(net).toBeLessThan(0);
  });
});
