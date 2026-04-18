/**
 * Type definitions for the Matrix rain animation engine.
 *
 * The engine is a pure-logic state machine that produces immutable-ish frame
 * snapshots describing what should be drawn. It never touches the DOM, Canvas,
 * or Svelte — that is all the wrapper's job. See docs/designs/web-ui-matrix-rain.md
 * for the full design.
 */

import type { WordDropSnapshot } from './word-drop-types.js';

// ---------------------------------------------------------------------------
// Phase
// ---------------------------------------------------------------------------

/**
 * Visible lifecycle phases for the animation.
 * - `assembly` — drops fall into target positions to form the wordmark.
 * - `hold` — all drops locked; the wordmark is held static while the global
 *   alpha linearly ramps from 1.0 down to the ambient level.
 * - `ambient` — wordmark held at reduced alpha; free-falling drops loop
 *   indefinitely until the canvas unmounts.
 */
export type RainPhase = 'assembly' | 'hold' | 'ambient';

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Pre-computed layout produced by `computeLayout()`. Passed to the engine at
 * construction time. The engine treats this as read-only; the wrapper creates
 * a new `LayoutPlan` on resize and calls `engine.resize()`.
 */
export interface LayoutPlan {
  /** Edge length of a single cell in CSS pixels (square cells). */
  readonly cellSize: number;
  /** Total grid columns (viewport width / cellSize). */
  readonly cols: number;
  /** Total grid rows (viewport height / cellSize). */
  readonly rows: number;
  /** Top-left pixel X of the wordmark bounding box (cols are cellSize apart). */
  readonly originX: number;
  /** Top-left pixel Y of the wordmark bounding box. */
  readonly originY: number;
  /** Logical CSS viewport width (the caller's container width). */
  readonly viewportWidth: number;
  /** Logical CSS viewport height. */
  readonly viewportHeight: number;
  /**
   * Target positions for the wordmark, expressed in grid coordinates (not
   * pixels). These are the cells the assembly phase locks into and the cells
   * the hold/ambient phases reveal from the pre-rendered wordmark image.
   */
  readonly lockedCells: ReadonlyArray<LockedCellCoord>;
  /**
   * Pre-rendered wordmark image. The renderer uses this as the source for
   * `drawImage()` clipping — locked cells reveal portions of this image
   * rather than drawing block characters. The image is rendered at the
   * font's native resolution and positioned at `(wordmarkDrawX, wordmarkDrawY)`
   * in viewport coordinates.
   *
   * May be `null` in test environments where canvas rendering is unavailable.
   */
  readonly wordmarkImage: HTMLCanvasElement | OffscreenCanvas | null;
  /** Viewport X where the wordmark image's left edge should be drawn. */
  readonly wordmarkDrawX: number;
  /** Viewport Y where the wordmark image's top edge should be drawn. */
  readonly wordmarkDrawY: number;
}

/** One wordmark target cell in grid coordinates. */
export interface LockedCellCoord {
  readonly col: number;
  readonly row: number;
  /** Which reveal group this cell belongs to. Title cells assemble first;
   *  subtitle cells are revealed after the title is fully locked. */
  readonly group?: 'title' | 'subtitle';
}

// ---------------------------------------------------------------------------
// FrameState — the narrow interface between engine and renderer
// ---------------------------------------------------------------------------

/**
 * Plain-data snapshot of what to draw this frame. Produced by `engine.getFrame()`
 * and consumed by the renderer. All arrays are `ReadonlyArray` references to
 * internal engine buffers that the engine may mutate on the next `step()` or
 * `getFrame()` call — the renderer MUST read-only and MUST NOT retain
 * references across frames.
 */
export interface FrameState {
  readonly phase: RainPhase;
  /**
   * Global alpha to apply to the whole frame. The renderer sets this once at
   * the top of the frame and resets to 1.0 at the end.
   */
  readonly globalAlpha: number;
  /**
   * Already-locked wordmark cells. During assembly this grows as drops land;
   * during hold and ambient it contains every wordmark cell.
   */
  readonly lockedCells: ReadonlyArray<LockedCellSnapshot>;
  /**
   * Active falling drops. During hold this is empty; during assembly this
   * shrinks as drops lock in; during ambient this holds the current
   * free-falling population.
   */
  readonly drops: ReadonlyArray<DropSnapshot>;
  /**
   * Held TF-IDF word drops pinned at fixed grid cells. The login engine
   * always returns a shared frozen empty array (`EMPTY_WORD_DROPS`) — only
   * the stream engine ever populates this.
   */
  readonly wordDrops: ReadonlyArray<WordDropSnapshot>;
}

/**
 * Frozen empty word-drop array. Shared by engines that never emit word drops
 * (the login engine) so every `FrameState` can satisfy the contract without a
 * per-frame allocation. Consumers MUST treat it as read-only.
 */
export const EMPTY_WORD_DROPS: ReadonlyArray<WordDropSnapshot> = Object.freeze([]);

/**
 * A locked wordmark cell in the current frame.
 * `alpha` is the per-cell multiplier (in addition to the frame `globalAlpha`).
 * Currently always 1.0 — the field exists to support progressive-reveal
 * experiments later without breaking the public type.
 */
export interface LockedCellSnapshot {
  readonly col: number;
  readonly row: number;
  /** 0.0–1.0. Ignored (always 1.0) outside the assembly phase. */
  readonly alpha: number;
}

/**
 * A single drop in the current frame, with its trail. Drops are stored in grid
 * coordinates; `row` may be fractional for ambient drops that carry a
 * sub-cell speed accumulator.
 */
export interface DropSnapshot {
  readonly col: number;
  /** Head row. Fractional values are allowed (ambient drops). */
  readonly row: number;
  /** Head character (what the renderer draws at (col, row)). */
  readonly char: string;
  /** Color tier for the head cell. */
  readonly colorKind: DropColorKind;
  /**
   * Trail cells from the head outward (index 0 is nearest the head). The head
   * itself is NOT included in this array — it is described by `char` /
   * `colorKind` / `row` above.
   */
  readonly trail: ReadonlyArray<DropTrailSnapshot>;
}

export interface DropTrailSnapshot {
  readonly col: number;
  readonly row: number;
  readonly char: string;
  readonly colorKind: DropColorKind;
}

/**
 * Drop color tier — maps 1:1 to a palette slot in the renderer.
 * `head` is brightest, `far` is dimmest. `word-hold` is a stream-engine-only
 * variant tagging cells belonging to held word drops so the stream renderer
 * can tint them per their source kind; the login engine never emits it.
 */
export type DropColorKind = 'head' | 'near' | 'far' | 'word-hold';

// ---------------------------------------------------------------------------
// RNG
// ---------------------------------------------------------------------------

/**
 * Injectable random number generator. Tests pass a seeded instance for
 * determinism; production passes `Math.random`.
 */
export interface RainRng {
  /** Returns a float in [0, 1). */
  random(): number;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/** Options accepted by `createRainEngine()`. */
export interface RainEngineOptions {
  /** When true, skip assembly/hold and start directly in `ambient` phase with
   * all wordmark cells already locked and no ambient drops spawning. */
  readonly reducedMotion?: boolean;
  /** Injected RNG for deterministic tests. Defaults to `Math.random`. */
  readonly rng?: RainRng;
  /** Seed for the default seeded RNG. If `rng` is provided, `seed` is ignored. */
  readonly seed?: number;
}

/**
 * Public engine contract.
 *
 * The engine is driven by a monotonic `nowMs` from the wrapper (typically
 * `requestAnimationFrame`). Internal advancement is in fixed 33ms logical
 * ticks so the animation feels the same on 60Hz and 120Hz displays.
 */
export interface RainEngine {
  /**
   * Advance internal state toward `nowMs`. Semantics (precise):
   *
   * 1. On the first call, records `lastTick = nowMs` and returns (no advance).
   * 2. If `delta = nowMs - lastTick <= 0`, returns (same or rewound timestamp
   *    is a no-op).
   * 3. If `delta > MAX_CATCH_UP_TICKS * FRAME_MS`, advances EXACTLY ONE
   *    logical tick and sets `lastTick = nowMs`. This is the "background tab
   *    resumed after minutes" fast-forward branch.
   * 4. Otherwise, advances logical ticks in a fixed-step loop:
   *      while (nowMs - lastTick >= FRAME_MS) { lastTick += FRAME_MS; advance(); }
   *    Leaves the residual sub-tick delta in `lastTick` so the next call
   *    picks up where this one left off.
   */
  step(nowMs: number): void;

  /** Produce a plain-data snapshot of the current drawable state. No side effects. */
  getFrame(): FrameState;

  /** Swap in a new layout. On cellSize change, drops are re-seeded. */
  resize(newLayout: LayoutPlan): void;

  /** Current phase (read-only). */
  readonly phase: RainPhase;

  /** `true` once the engine has transitioned out of the `assembly` phase. */
  readonly wordmarkReady: boolean;
}
