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
 *   materialize -> hold -> dissolve (word record stays alive while chars
 *   drop off one-by-one into the rain; record is retired once every char
 *   has left).
 *
 * The renderer sees all three phases. During `materialize` and `dissolve`,
 * individual characters toggle in/out of the drawn glyph set via
 * `revealedMask` — chars appear/disappear in lockstep looks mechanical, so
 * the per-char mask lets the engine stagger reveals and dissolves across a
 * short window for an organic coalesce/shatter feel.
 */

export type WordDropSource = 'text' | 'tool' | 'model' | 'error';

/**
 * Lifecycle phase visible to the renderer.
 * - `materialize`: characters are flipping from unrevealed to revealed over
 *   a short staggered window. Draw chars whose mask bit is true; leave the
 *   rest blank. Mirrors the TUI's forming phase.
 * - `hold`: every character revealed, full `word` drawn. This is the
 *   "reading" phase the viewer sees for ~2.5s. All mask bits are true.
 * - `dissolve`: characters are flipping from revealed back to unrevealed
 *   over a short staggered window, with each removed char spawning a
 *   tinted falling rain shard on the same tick it disappears. Draw chars
 *   whose mask bit is still true; the rest have already shattered.
 */
export type WordDropPhase = 'materialize' | 'hold' | 'dissolve';

export interface WordDropSnapshot {
  /** Column at which the word is pinned. */
  readonly col: number;
  /** Row at which the word is pinned. */
  readonly row: number;
  /** The word text itself (already passed scorer thresholds). */
  readonly word: string;
  /** Used by renderer to choose tint. */
  readonly source: WordDropSource;
  /** Current lifecycle phase. */
  readonly phase: WordDropPhase;
  /**
   * Per-character visibility. `revealedMask[i]` is true when character
   * `word[i]` should be drawn this frame, false otherwise. Length always
   * equals `word.length`.
   * - `materialize`: starts all-false, bits flip to true on a per-char
   *   schedule over ~4-8 ticks.
   * - `hold`: all bits true.
   * - `dissolve`: starts all-true, bits flip to false on a per-char
   *   schedule over ~6-10 ticks. Each flip spawns a matching rain shard.
   * Renderer iterates the mask and draws only the revealed positions at
   * their original offset from the word's start column.
   */
  readonly revealedMask: readonly boolean[];
}
