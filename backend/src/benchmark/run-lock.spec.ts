import { BenchmarkRunLock, LockHeldError } from './run-lock';

describe('BenchmarkRunLock', () => {
  it('starts unheld', () => {
    expect(new BenchmarkRunLock().heldBy).toBeNull();
  });

  it('acquire records the holder', () => {
    const lock = new BenchmarkRunLock();
    lock.acquire('keys-backfill');
    expect(lock.heldBy).toBe('keys-backfill');
  });

  it('rejects a second acquire naming the current holder', () => {
    const lock = new BenchmarkRunLock();
    lock.acquire('keys-backfill');
    try {
      lock.acquire('benchmark-run');
      throw new Error('expected LockHeldError');
    } catch (err) {
      expect(err).toBeInstanceOf(LockHeldError);
      expect((err as LockHeldError).holder).toBe('keys-backfill');
      expect((err as Error).message).toBe('a keys backfill is already in progress');
    }
  });

  it('keeps the legacy wording for a held benchmark run', () => {
    const lock = new BenchmarkRunLock();
    lock.acquire('benchmark-run');
    expect(() => lock.acquire('keys-backfill')).toThrow('a benchmark run is already in progress');
  });

  it('release frees the lock for the other holder', () => {
    const lock = new BenchmarkRunLock();
    lock.acquire('benchmark-run');
    lock.release('benchmark-run');
    expect(lock.heldBy).toBeNull();
    expect(() => lock.acquire('keys-backfill')).not.toThrow();
  });

  it('release by a non-holder is a no-op', () => {
    const lock = new BenchmarkRunLock();
    lock.acquire('benchmark-run');
    lock.release('keys-backfill');
    expect(lock.heldBy).toBe('benchmark-run');
  });
});
