/**
 * Shared type for held word drops.
 *
 * Produced by the stream engine in its frame snapshots and consumed by the
 * stream renderer. Kept in its own module so both sides can depend on it
 * without a circular import.
 *
 * Lifecycle (see §E.1 of docs/designs/web-ui-workflow-visualization.md and
 * the reference TUI in src/observe/observe-tui-rain.ts):
 *
 *   materialize -> hold -> dissolve (word removed; chars continue as rain)
 *
 * The `dissolve` phase is not representable as a `WordDropSnapshot` — once
 * dissolve begins the stream engine deletes the held record and spawns
 * synthetic falling drops (with `tint` set to the word's source) that decay
 * through the normal rain pipeline. The renderer therefore only ever sees
 * `materialize` or `hold` on snapshots.
 */

export type WordDropSource = 'text' | 'tool' | 'model' | 'error';

/**
 * Lifecycle phase visible to the renderer.
 * - `materialize`: characters are being revealed left-to-right; only the
 *   first `revealedChars` of `word` should be drawn, the rest stay invisible.
 *   Mirrors the TUI's forming phase (a word crystallizing out of the rain).
 * - `hold`: every character revealed, full `word` drawn. This is the
 *   "reading" phase the viewer sees for ~2.5s.
 */
export type WordDropPhase = 'materialize' | 'hold';

export interface WordDropSnapshot {
  /** Column at which the word is pinned. */
  readonly col: number;
  /** Row at which the word is pinned. */
  readonly row: number;
  /** The word text itself (already passed scorer thresholds). */
  readonly word: string;
  /** Used by renderer to choose tint. */
  readonly source: WordDropSource;
  /** Scorer priority. Reserved for future policy; stream engine's current
   *  eviction is strict FIFO per §G Q6. */
  readonly priority: number;
  /** Current lifecycle phase. */
  readonly phase: WordDropPhase;
  /**
   * Number of leading characters that should be drawn this frame.
   * - During `materialize`: increases by 1 per tick (0..word.length).
   * - During `hold`: always equals `word.length`.
   * The renderer draws exactly `word.slice(0, revealedChars)`; no alpha
   * interpolation — per-character reveal replaces the old alpha envelope.
   */
  readonly revealedChars: number;
}
