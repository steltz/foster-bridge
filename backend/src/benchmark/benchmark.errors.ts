import { DriftReport } from './drift';

/**
 * A benchmarked input file changed after cells were written, or existing cells
 * disagree about what they ran on. Maps to HTTP 409 (NOT retryable — the run
 * would mix two versions of an input into one scoreboard row, so a human must
 * either revert the edit or start a new file).
 *
 * Thrown before any upload or batch submission, so nothing has been touched
 * when it surfaces. There is deliberately no bypass flag: a guard that is
 * routinely overridden stops preventing the thing it exists to prevent.
 */
export class BenchmarkDriftError extends Error {
  constructor(
    readonly report: DriftReport,
    message: string,
  ) {
    super(message);
  }
}
