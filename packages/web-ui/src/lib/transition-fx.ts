/**
 * Transition-FX state machine (Chunk 9, §D.1–§D.6).
 *
 * Headless subsystem driven by the visualization director's rAF loop. Each
 * {@link TransitionEvent} kicks off a 1000ms punctuation cycle:
 *
 *   [0ms  ..  600ms] "traveling"  — payload tile lerps along the edge (ease-out cubic)
 *   [600ms .. 800ms] "absorbing"  — tile scales to zero into the incoming node header
 *   [800ms .. 1000ms] "scan-line" — edge fade + arrival scan-line tail
 *   (>=1000ms)       "idle"       — no-op
 *
 * Concurrency policy (§D.6): if a new transition arrives mid-cycle we drop it
 * with a warn-once. Transitions are rare (minutes apart in normal runs); the
 * cost of glitching a half-played FX to chase a new one outweighs the cost of
 * skipping the new one's punctuation.
 */
import type { SvgPoint } from './project-svg-to-grid.js';
import { projectSvgToGrid } from './project-svg-to-grid.js';
import type { DensitySource } from './matrix-rain/density-field.js';

// ---------------------------------------------------------------------------
// Tuning constants — mirror §D.2 exactly.
// ---------------------------------------------------------------------------

/** Tile travels from outgoing to incoming node center. */
export const TRAVEL_MS = 600;
/** Tile scales 1 -> 0 into the incoming node header. */
export const ABSORB_MS = 200;
/** Arrival scan-line trail; edge fades back to dormant over the same window. */
export const SCANLINE_MS = 200;
/** Sum used to gate idle-vs-active and for mount-only-while-active logic. */
export const TOTAL_MS = TRAVEL_MS + ABSORB_MS + SCANLINE_MS;

/** Truncation cap for the tile's notes text. §D.2: ~80 chars. */
export const NOTES_CHAR_CAP = 80;

export type TransitionFxPhase = 'idle' | 'traveling' | 'absorbing' | 'scan-line';

/** Minimum shape the FX subsystem needs from a state-machine-graph TransitionEvent.
 *  Declared locally so this module doesn't import the Svelte component. */
export interface TransitionTriggerLike {
  readonly from: string;
  readonly to: string;
  readonly fromPos: SvgPoint;
  readonly toPos: SvgPoint;
  readonly handoffLabel: string;
}

/** Single frame of FX state. Consumer reads this to draw the tile + drive
 *  DOM-attr side effects (edge brightening, arrival badge). */
export interface TransitionFxFrame {
  readonly phase: TransitionFxPhase;
  /** Interpolated tile position in SVG space. */
  readonly tilePos: SvgPoint;
  /** Tile scale — 1 while traveling, 1 -> 0 during absorb, 0 during scan-line. */
  readonly tileScale: number;
  /** Alpha — 1 while traveling, 1 -> 0 during absorb, 0 during scan-line. */
  readonly tileAlpha: number;
  /** Truncated handoff text. */
  readonly notes: string;
  readonly fromId: string;
  readonly toId: string;
}

/** Density-sweep source position interpolated between the node centers. Used
 *  by the director to push a transit `DensitySource` into the rain field. */
export interface TransitionFxDensity {
  readonly gridCol: number;
  readonly gridRow: number;
  readonly amplitude: number;
}

// ---------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------

/** Ease-out cubic. Fast start, gentle stop — §D.2. */
function easeOutCubic(t: number): number {
  const c = 1 - t;
  return 1 - c * c * c;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** §D.2: truncate to NOTES_CHAR_CAP with a trailing ellipsis. */
export function truncateNotes(text: string): string {
  if (text.length <= NOTES_CHAR_CAP) return text;
  return text.slice(0, NOTES_CHAR_CAP - 1) + '…';
}

// ---------------------------------------------------------------------------
// Subsystem
// ---------------------------------------------------------------------------

export interface TransitionFxSubsystem {
  /** Start a new FX cycle at `nowMs`. No-op (with warn-once) if a cycle is
   *  still active — see concurrency policy above. */
  trigger(evt: TransitionTriggerLike, nowMs: number): void;
  /** Advance internal state. Pure; never allocates when idle. */
  step(nowMs: number): void;
  /** Current drawable frame or `null` when idle. */
  getFrame(): TransitionFxFrame | null;
  /** The active cycle's full trigger, or null. The director uses this to
   *  locate the edge DOM node for the `data-active` toggle and to ask the
   *  grid-projected density source for the current transit position. */
  getActive(): TransitionTriggerLike | null;
  /** Current density source in grid space, or `null` when idle. Cell size is
   *  injected here (not captured in the subsystem) because the theater may
   *  resize and the contract is "use whatever cellSize the caller thinks is
   *  current at query time." */
  getDensitySource(cellSize: number): TransitionFxDensity | null;
  /** True while the overlay should be mounted. Equivalent to `getFrame() !== null`
   *  but without allocating a frame object. */
  isActive(): boolean;
  /** Reset to idle — used by tests and on theater teardown. */
  reset(): void;
  /** Current phase. */
  readonly phase: TransitionFxPhase;
}

export function createTransitionFxSubsystem(): TransitionFxSubsystem {
  let active: TransitionTriggerLike | null = null;
  let startedAtMs = 0;
  let elapsedMs = 0;
  let phase: TransitionFxPhase = 'idle';
  let warnedBusy = false;

  function recomputePhase(): void {
    if (!active) {
      phase = 'idle';
      return;
    }
    if (elapsedMs < TRAVEL_MS) phase = 'traveling';
    else if (elapsedMs < TRAVEL_MS + ABSORB_MS) phase = 'absorbing';
    else if (elapsedMs < TOTAL_MS) phase = 'scan-line';
    else {
      active = null;
      phase = 'idle';
    }
  }

  function trigger(evt: TransitionTriggerLike, nowMs: number): void {
    if (active !== null) {
      if (!warnedBusy) {
        warnedBusy = true;
        console.warn('[transition-fx] dropping transition — prior FX cycle still active', evt);
      }
      return;
    }
    warnedBusy = false;
    active = evt;
    startedAtMs = nowMs;
    elapsedMs = 0;
    phase = 'traveling';
  }

  function step(nowMs: number): void {
    if (!active) return;
    elapsedMs = Math.max(0, nowMs - startedAtMs);
    recomputePhase();
  }

  function getFrame(): TransitionFxFrame | null {
    if (!active) return null;
    // Travel uses ease-out cubic on [0, 1] across TRAVEL_MS.
    const travelT = clamp01(elapsedMs / TRAVEL_MS);
    const eased = easeOutCubic(travelT);
    const x = lerp(active.fromPos.x, active.toPos.x, eased);
    const y = lerp(active.fromPos.y, active.toPos.y, eased);

    // During absorb, scale/alpha decay linearly from 1 to 0.
    let scale = 1;
    let alpha = 1;
    if (phase === 'absorbing') {
      const t = clamp01((elapsedMs - TRAVEL_MS) / ABSORB_MS);
      scale = 1 - t;
      alpha = 1 - t;
    } else if (phase === 'scan-line') {
      scale = 0;
      alpha = 0;
    }

    return {
      phase,
      tilePos: { x, y },
      tileScale: scale,
      tileAlpha: alpha,
      notes: truncateNotes(active.handoffLabel),
      fromId: active.from,
      toId: active.to,
    };
  }

  function getActive(): TransitionTriggerLike | null {
    return active;
  }

  function getDensitySource(cellSize: number): TransitionFxDensity | null {
    if (!active || phase !== 'traveling') return null;
    // Only sweep the density during the travel window (§D.3); after the tile
    // absorbs, the theater's per-node sources already highlight the incoming
    // node and a trailing transit source would look like ghost trail.
    const travelT = clamp01(elapsedMs / TRAVEL_MS);
    const eased = easeOutCubic(travelT);
    const x = lerp(active.fromPos.x, active.toPos.x, eased);
    const y = lerp(active.fromPos.y, active.toPos.y, eased);
    const grid = projectSvgToGrid({ x, y }, cellSize);
    return { gridCol: grid.col, gridRow: grid.row, amplitude: 1.0 };
  }

  function isActive(): boolean {
    return active !== null;
  }

  function reset(): void {
    active = null;
    elapsedMs = 0;
    startedAtMs = 0;
    phase = 'idle';
  }

  return {
    trigger,
    step,
    getFrame,
    getActive,
    getDensitySource,
    isActive,
    reset,
    get phase(): TransitionFxPhase {
      return phase;
    },
  };
}

/** Helper for the director: promote a FX density source to the DensitySource
 *  shape consumed by `computeColumnWeights`. Extracted so the density-field
 *  rebuild in the director stays a plain map over positions + this one extra. */
export function fxToDensitySource(fx: TransitionFxDensity): DensitySource {
  return { centerCol: fx.gridCol, centerRow: fx.gridRow, amplitude: fx.amplitude };
}
