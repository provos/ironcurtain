/**
 * Shared type for held word drops.
 *
 * Produced by the stream engine in its frame snapshots and consumed by the
 * stream renderer. Kept in its own module so both sides can depend on it
 * without a circular import.
 */

export type WordDropSource = 'text' | 'tool' | 'model' | 'error';

export interface WordDropSnapshot {
  /** Column at which the word is pinned. */
  readonly col: number;
  /** Row at which the word is pinned. */
  readonly row: number;
  /** The word text itself (already passed scorer thresholds). */
  readonly word: string;
  /** 0.0 (just spawned, fading in) -> 1.0 (fully visible) -> 0.0 (fading out). */
  readonly alpha: number;
  /** Used by renderer to choose tint. */
  readonly source: WordDropSource;
  /** Scorer priority. Reserved for future policy; stream engine's current
   *  eviction is strict FIFO per §G Q6. */
  readonly priority: number;
}
