/**
 * Headless coordinator for the workflow-theater subsystems.
 *
 * Extracted from workflow-theater.svelte when the component crossed the
 * ~400 LOC trigger documented in §A.1 of the viz design. The director owns:
 *
 *   - the single `requestAnimationFrame` loop
 *   - per-subsystem error isolation (§D.6) with warn-once discipline
 *   - the density-field sources model (active/inactive node amplitudes)
 *   - intensity-EMA sampling at ~10 Hz (not per frame)
 *   - word-scorer wiring from `TokenStreamEvent` batches into rain drops
 *   - pause/resume from a visibility signal
 *   - the stream subscription + scorer lifecycle
 *
 * This module is pure TypeScript — no Svelte, no DOM lookups beyond the
 * canvas/context the component hands in. The Svelte component is now true glue:
 * bind the canvas, create the director, feed it positions, dispose on unmount.
 *
 * Error isolation promise: every subsystem call goes through `safeStep()`.
 * A thrown error is logged once and the subsystem is skipped for the rest of
 * the frame; the loop continues. Matches AC4 (tab-hidden halt/resume) and the
 * §D.6 contract that a bug in one subsystem cannot freeze the rest.
 */

import { drawStreamFrame } from './matrix-rain/stream-renderer.js';
import { FONT_SIZE_TUNING } from './matrix-rain/renderer.js';
import { computeColumnWeights, type DensitySource } from './matrix-rain/density-field.js';
import type { LayoutPlan } from './matrix-rain/types.js';
import type { AvoidRect, StreamRainEngine } from './matrix-rain/stream-engine.js';
import { projectSvgToGrid, type SvgPoint } from './project-svg-to-grid.js';
import type { TokenStreamStore } from './token-stream-store.svelte.js';
import {
  createSessionWordState,
  createWordScorer,
  processEventForWords,
  type SessionWordState,
  type WordScorer,
} from './word-scorer.js';
import type { TokenStreamEvent } from './types.js';
import {
  createTransitionFxSubsystem,
  fxToDensitySource,
  type TransitionFxSubsystem,
  type TransitionTriggerLike,
  type TransitionFxFrame,
} from './transition-fx.js';

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Gaussian falloff for the density field. 8-12 looks right at cellSize=12. */
const DENSITY_SIGMA = 10;

/** Active-node amplitude = 1.0, inactive nodes trace at 0.1 (§A.3). */
const ACTIVE_AMPLITUDE = 1.0;
const INACTIVE_AMPLITUDE = 0.1;

/** Intensity is read once per ~100ms (not per rAF) — the EMA only changes at
 *  the scale of token batches, sampling faster just wastes cycles. */
const INTENSITY_SAMPLE_PERIOD_MS = 100;

/** Renderer font family — monospace stack matching the rest of the web UI. */
const FONT_FAMILY = '"JetBrains Mono", ui-monospace, monospace';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DirectorDeps {
  readonly ctx: CanvasRenderingContext2D;
  readonly engine: StreamRainEngine;
  readonly layout: LayoutPlan;
  readonly tokenStreamStore: TokenStreamStore;
  /** Pluggable rAF pair so tests can drive the loop under fake timers. */
  readonly requestAnimationFrame?: (cb: FrameRequestCallback) => number;
  readonly cancelAnimationFrame?: (handle: number) => void;
  /** Injectable scorer/state — defaults to fresh instances per director. */
  readonly scorer?: WordScorer;
  readonly wordState?: SessionWordState;
  /** Cell size used for SVG -> grid projection. */
  readonly cellSize: number;
  /** Transition-FX subsystem, injectable for tests. Defaults to a fresh instance. */
  readonly transitionFx?: TransitionFxSubsystem;
  /** Called on every tick with the current FX frame (or null when idle). The
   *  theater component draws onto its own FX canvas from this callback so the
   *  director keeps paint-dispatch to one place and the component stays a
   *  passive consumer. */
  readonly onTransitionFxFrame?: (frame: TransitionFxFrame | null) => void;
}

export interface VisualizationDirector {
  /** Begin the rAF loop and subsystem wiring. Idempotent — no-op if running. */
  start(): void;
  /** Halt the rAF loop. Preserves runtime state; call `start()` to resume. */
  stop(): void;
  /** Full teardown: unsubscribes from the stream store and nulls everything out. */
  dispose(): void;
  /** Apply a new layout (cell-size or grid change). */
  resize(newLayout: LayoutPlan): void;
  /** Update the set of node positions used to build the density field. */
  setNodePositions(positions: ReadonlyMap<string, SvgPoint>): void;
  /** Update the active node. Rebuilds the density field with cached positions. */
  setActiveNode(id: string | null): void;
  /**
   * Forward avoid regions (CSS pixel rects of node chrome) to the engine so
   * rain doesn't bleed through opaque node interiors. The theater computes
   * these from foreignObject bounding rects after each layout.
   */
  setAvoidRegions(rects: ReadonlyArray<AvoidRect>): void;
  /**
   * Propagate a `prefers-reduced-motion` toggle to the underlying engine.
   * The theater subscribes to the media-query and calls this on `change`
   * events so the rain adapts mid-session.
   */
  setReducedMotion(flag: boolean): void;
  /** Kick the transition-FX subsystem. Dropped with a warn-once if a cycle
   *  is already active. */
  triggerTransition(evt: TransitionTriggerLike, nowMs?: number): void;
  /** The FX subsystem's current trigger (active cycle), or null. The theater
   *  uses this to locate edge DOM nodes for the dormant->active brightening. */
  getActiveTransition(): TransitionTriggerLike | null;
  /** True if the loop is currently running. Exposed for tests. */
  readonly running: boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createVisualizationDirector(deps: DirectorDeps): VisualizationDirector {
  const raf = deps.requestAnimationFrame ?? ((cb) => requestAnimationFrame(cb));
  const caf = deps.cancelAnimationFrame ?? ((h) => cancelAnimationFrame(h));

  const scorer = deps.scorer ?? createWordScorer();
  const wordState = deps.wordState ?? createSessionWordState();
  const transitionFx = deps.transitionFx ?? createTransitionFxSubsystem();

  const engine = deps.engine;
  let layout = deps.layout;
  const ctx = deps.ctx;
  const cellSize = deps.cellSize;

  let latestPositions: ReadonlyMap<string, SvgPoint> = new Map();
  let activeNode: string | null = null;

  let rafHandle: number | null = null;
  let lastIntensityReadAt = 0;

  /** Ticks the FX subsystem stayed active. Drives density-field rebuilds only
   *  when the transit source moves (cheaper than every frame); also gates the
   *  "active -> idle" cleanup path so we rebuild once after the cycle ends. */
  let fxWasActive = false;

  let unsubscribeStream: (() => void) | null = null;
  let disposed = false;
  const warned = new Set<string>();

  function safeStep(name: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      if (!warned.has(name)) {
        warned.add(name);
        console.warn(`[visualization-director] ${name} threw; suppressing further warnings`, err);
      }
    }
  }

  function tick(nowMs: number): void {
    if (disposed) {
      rafHandle = null;
      return;
    }

    safeStep('stream-engine', () => engine.step(nowMs));

    // Advance the transition-FX subsystem before anything that reads from it,
    // so the per-frame density rebuild and the onTransitionFxFrame callback
    // both see up-to-date state. §D.6: one rAF owns every subsystem's step.
    safeStep('transition-fx-step', () => {
      transitionFx.step(nowMs);
      const fxActive = transitionFx.isActive();
      if (fxActive || fxWasActive) {
        // Rebuild while the transit source is moving, and once more when the
        // cycle ends so the field collapses back to the per-node sources.
        rebuildDensityField();
      }
      fxWasActive = fxActive;
    });

    if (nowMs - lastIntensityReadAt >= INTENSITY_SAMPLE_PERIOD_MS) {
      lastIntensityReadAt = nowMs;
      safeStep('intensity-sampler', () => {
        const mult = deps.tokenStreamStore.intensity.current();
        engine.setIntensity(mult);
      });
    }

    safeStep('stream-renderer', () => {
      const frame = engine.getFrame();
      const vw = Math.floor(layout.viewportWidth);
      const vh = Math.floor(layout.viewportHeight);
      drawStreamFrame(ctx, frame, layout, vw, vh, {
        fontFamily: FONT_FAMILY,
        fontSizeTuning: FONT_SIZE_TUNING,
      });
    });

    safeStep('transition-fx-paint', () => {
      deps.onTransitionFxFrame?.(transitionFx.getFrame());
    });

    rafHandle = raf(tick);
  }

  function start(): void {
    if (rafHandle !== null || disposed) return;
    rafHandle = raf(tick);
    if (unsubscribeStream === null) {
      unsubscribeStream = deps.tokenStreamStore.subscribeToStream((_label, events) => {
        for (const event of events) {
          handleStreamEventImpl(event);
        }
      });
    }
  }

  function stop(): void {
    if (rafHandle !== null) {
      caf(rafHandle);
      rafHandle = null;
    }
  }

  function dispose(): void {
    disposed = true;
    stop();
    if (unsubscribeStream) {
      unsubscribeStream();
      unsubscribeStream = null;
    }
  }

  function resize(newLayout: LayoutPlan): void {
    const gridChanged = newLayout.cols !== layout.cols || newLayout.rows !== layout.rows;
    layout = newLayout;
    engine.resize(newLayout);
    if (gridChanged && latestPositions.size > 0) {
      rebuildDensityField();
    }
  }

  function setNodePositions(positions: ReadonlyMap<string, SvgPoint>): void {
    latestPositions = positions;
    rebuildDensityField();
  }

  function setActiveNode(id: string | null): void {
    activeNode = id;
    if (latestPositions.size > 0) rebuildDensityField();
  }

  function setAvoidRegions(rects: ReadonlyArray<AvoidRect>): void {
    // Thin forward — the engine owns the filtering/defensive-copy logic so
    // every caller path stays consistent. Isolated via safeStep so a
    // corrupted rect doesn't take the loop down.
    safeStep('avoid-regions', () => engine.setAvoidRegions(rects));
  }

  function rebuildDensityField(): void {
    if (layout.cols <= 0 || layout.rows <= 0 || latestPositions.size === 0) {
      engine.setDensityField(null);
      return;
    }
    const sources: DensitySource[] = [];
    for (const [id, pt] of latestPositions) {
      const grid = projectSvgToGrid(pt, cellSize);
      sources.push({
        centerCol: grid.col,
        centerRow: grid.row,
        amplitude: id === activeNode ? ACTIVE_AMPLITUDE : INACTIVE_AMPLITUDE,
      });
    }
    // §D.3: while a transition is traveling, push a transit source at the
    // lerped grid coord so the rain "follows" the payload tile.
    const fxSource = transitionFx.getDensitySource(cellSize);
    if (fxSource) {
      sources.push(fxToDensitySource(fxSource));
    }
    try {
      const weights = computeColumnWeights({
        sources,
        cols: layout.cols,
        rows: layout.rows,
        sigma: DENSITY_SIGMA,
      });
      engine.setDensityField(weights);
    } catch (err) {
      // Bad source (NaN, etc.) must not take the theater down; revert to
      // uniform spawning and warn once.
      if (!warned.has('density-field')) {
        warned.add('density-field');
        console.warn('[visualization-director] density-field threw; reverting to uniform', err);
      }
      engine.setDensityField(null);
    }
  }

  function handleStreamEventImpl(event: TokenStreamEvent): void {
    try {
      const candidates = processEventForWords(event, wordState, scorer);
      for (const c of candidates) {
        engine.enqueueWord(c.word, { colorKind: c.source });
      }
    } catch (err) {
      if (!warned.has('word-scorer')) {
        warned.add('word-scorer');
        console.warn('[visualization-director] word-scorer threw; suppressing further warnings', err);
      }
    }
  }

  function triggerTransition(evt: TransitionTriggerLike, nowMs?: number): void {
    // Default to performance.now() (what the rAF callback sees). The optional
    // parameter exists so tests can pin to a fake clock without stubbing globals.
    const t =
      nowMs ??
      (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());
    safeStep('transition-fx-trigger', () => transitionFx.trigger(evt, t));
    // Immediately rebuild the density field so the transit source shows up on
    // the very first frame the FX is active, not one tick late.
    rebuildDensityField();
  }

  return {
    start,
    stop,
    dispose,
    resize,
    setNodePositions,
    setActiveNode,
    setAvoidRegions,
    setReducedMotion(flag: boolean): void {
      // Thin forward — the engine owns the semantics (ambient spawn gating,
      // word-drop aging still running). Wrapped in safeStep so a misbehaving
      // engine impl can't take the director down.
      safeStep('set-reduced-motion', () => engine.setReducedMotion(flag));
    },
    triggerTransition,
    getActiveTransition: () => transitionFx.getActive(),
    get running(): boolean {
      return rafHandle !== null && !disposed;
    },
  };
}
