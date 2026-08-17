import { Injectable } from '@nestjs/common';

export type LockHolder = 'benchmark-run' | 'keys-backfill';

const HOLDER_LABEL: Record<LockHolder, string> = {
  'benchmark-run': 'benchmark run',
  'keys-backfill': 'keys backfill',
};

/** Thrown by acquire() when someone else holds the lock; controllers map to 409. */
export class LockHeldError extends Error {
  constructor(readonly holder: LockHolder) {
    super(`a ${HOLDER_LABEL[holder]} is already in progress`);
  }
}

/**
 * Single-flight across everything that calls SevenKeysService.ensureKeys.
 * Two concurrent writers race saveKeysArtifact (last-write-wins) and can orphan
 * a submitted batch's pinned KEYS hash — a permanent per-day wedge.
 *
 * In-memory, so this assumes a SINGLE backend process. BENCHMARK_SCHEDULER
 * exists to split API from worker; running the keys backfill in a multi-process
 * deployment would need a Firestore lease instead. Out of scope by design.
 */
@Injectable()
export class BenchmarkRunLock {
  private holder: LockHolder | null = null;

  acquire(holder: LockHolder): void {
    if (this.holder) throw new LockHeldError(this.holder);
    this.holder = holder;
  }

  release(holder: LockHolder): void {
    if (this.holder === holder) this.holder = null;
  }

  get heldBy(): LockHolder | null {
    return this.holder;
  }
}
