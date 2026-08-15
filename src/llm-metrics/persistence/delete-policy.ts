import type { LlmDeleteBeforeOptions } from './repository.js';

/** Shared bounded maintenance policy for automatic retention and explicit deletion. */
export const BOUNDED_STATISTICS_DELETE_OPTIONS: Readonly<
  Pick<LlmDeleteBeforeOptions, 'chunkSize' | 'maxRows' | 'maxDurationMs' | 'leaseDurationMs'>
> = Object.freeze({
  chunkSize: 1_000,
  maxRows: 10_000,
  maxDurationMs: 1_000,
  leaseDurationMs: 5_000,
});
