/**
 * A pipeline stage failed. Maps to HTTP 502 (retryable as-is). Stages:
 * 'plan' (storage existence checks / reloads / stale-recap cleanup),
 * 'resolve' (scraping), 'transcribe' (YouTube transcript fetch),
 * 'download' (pdf), 'verify' (oEmbed / LLM transport), 'upload' (bucket
 * save), 'commit' (manifest write / video-id claim transport).
 * Already-uploaded artifacts remain in the bucket, so a retry resumes via
 * fill-and-skip. ArchiveNotFoundError and IngestValidationError deliberately
 * do NOT get wrapped into this — they pass through to the controller's
 * 404/422 mappings.
 */
export class IngestStageError extends Error {
  /**
   * The original failure, kept so the underlying stack survives the wrap.
   * Declared explicitly rather than passed via `super(msg, { cause })`: the
   * backend targets ES2021, whose lib has no `Error.cause` and no
   * `ErrorOptions` overload. Same property name and meaning as the ES2022
   * built-in, so loggers that read `err.cause` work either way.
   */
  readonly cause: Error;

  constructor(
    readonly stage: 'plan' | 'resolve' | 'transcribe' | 'download' | 'verify' | 'upload' | 'commit',
    readonly artifact: 'archive' | 'recap' | 'tradePlanMd' | 'tradePlanPdf',
    cause: Error,
  ) {
    super(`eminiplayer ingest failed at ${stage} (${artifact}): ${cause.message}`);
    this.cause = cause;
  }
}

/**
 * We got data and refuse to trust it: a deterministic gate, date cross-check,
 * structural invariant, LLM verdict, or video-id uniqueness claim failed.
 * Maps to HTTP 422 (NOT retryable as-is — the source data or our expectations
 * are wrong and a human must look). No manifest is written; the day stays
 * invisible to consumers; artifacts stay in place for diagnosis.
 */
export class IngestValidationError extends Error {}
