<script lang="ts">
  /**
   * Matrix rain Svelte wrapper -- thin glue layer between Svelte and the
   * pure-logic engine / renderer / layout modules.
   *
   * Uses a two-canvas architecture:
   *   - Rain canvas (bottom): opaque black background with falling drops
   *   - Wordmark canvas (top): transparent background with locked wordmark cells,
   *     styled with CSS `drop-shadow` for smooth GPU-accelerated glow
   *
   * Responsibilities:
   *   - Bind two `<canvas>` elements and acquire 2D contexts
   *   - Wait for the wordmark font (Orbitron) to load before bootstrapping
   *   - Compute a `LayoutPlan` from the container size (or bail if too small)
   *   - Run the `requestAnimationFrame` loop
   *   - Handle DPR on mount and resize for both canvases
   *   - Observe container resize and rebuild the engine on significant changes
   *   - Respect the `reducedMotion` prop from the parent
   *   - Clean up every resource on unmount
   *
   * The wrapper deliberately contains no animation logic -- everything visual
   * lives in `engine.ts` / `renderer.ts` / `layout.ts`.
   */

  import { createRainEngine } from '$lib/matrix-rain/engine.js';
  import { computeLayout } from '$lib/matrix-rain/layout.js';
  import { drawRainFrame, drawWordmarkFrame, FONT_SIZE_TUNING } from '$lib/matrix-rain/renderer.js';
  import { WORD, WORDMARK_FONT_FAMILY, WORDMARK_FONT_WEIGHT } from '$lib/matrix-rain/font.js';
  import type { LayoutPlan, RainEngine } from '$lib/matrix-rain/types.js';

  interface Props {
    word?: string;
    reducedMotion?: boolean;
    onready?: () => void;
    class?: string;
  }

  const { word = WORD, reducedMotion = false, onready, class: className = '' }: Props = $props();

  /** Match the web UI's monospace font (see packages/web-ui/src/app.css). */
  const FONT_FAMILY = '"JetBrains Mono", ui-monospace, monospace';

  let rainCanvas: HTMLCanvasElement | null = $state(null);
  let wordmarkCanvas: HTMLCanvasElement | null = $state(null);

  /**
   * Tracks whether the wordmark font has loaded. Layout computation is
   * deferred until the font is available so the offscreen canvas renders
   * correct glyph outlines.
   */
  let fontReady = $state(false);

  // Load the wordmark font on mount.
  $effect(() => {
    if (typeof document === 'undefined' || !document.fonts) {
      fontReady = true;
      return;
    }

    // Guard against writes after unmount: if the component is destroyed
    // before document.fonts.load() resolves, the promise handler would
    // otherwise assign to already-disposed state.
    let cancelled = false;
    const fontSpec = `${WORDMARK_FONT_WEIGHT} 48px ${WORDMARK_FONT_FAMILY}`;
    document.fonts
      .load(fontSpec)
      .then(() => {
        if (!cancelled) fontReady = true;
      })
      .catch(() => {
        // Font failed to load -- fall back to system font. Layout will
        // still work since computeLayout accepts any renderable font.
        if (!cancelled) fontReady = true;
      });
    return () => {
      cancelled = true;
    };
  });

  // Main render effect. Re-runs on canvas mount, word change, font readiness,
  // or reduced-motion change -- each of which requires a fresh engine.
  $effect(() => {
    if (!rainCanvas || !wordmarkCanvas || !fontReady) return;
    // The canvases live inside a wrapper div; observe the wrapper's parent
    // (the full-viewport container from App.svelte) for size changes.
    const wrapper = rainCanvas.parentElement;
    const parent = wrapper?.parentElement;
    if (!wrapper || !parent) return;

    const rainCtx0 = rainCanvas.getContext('2d');
    const wordmarkCtx0 = wordmarkCanvas.getContext('2d');
    if (!rainCtx0 || !wordmarkCtx0) return;

    // Re-bind as non-null locals so narrowing holds inside nested closures.
    const rainEl: HTMLCanvasElement = rainCanvas;
    const wordmarkEl: HTMLCanvasElement = wordmarkCanvas;
    const rainCtx: CanvasRenderingContext2D = rainCtx0;
    const wordmarkCtx: CanvasRenderingContext2D = wordmarkCtx0;

    // Capture reactive inputs so the effect re-subscribes if they change.
    const activeWord = word;
    const rm = reducedMotion;

    let layout: LayoutPlan | null = null;
    let engine: RainEngine | null = null;
    let rafHandle: number | null = null;
    let resizeRafHandle: number | null = null;
    let readyFired = false;
    let wordmarkDrawn = false;
    let lastPhase: string | null = null;
    let disposed = false;

    function applySize(width: number, height: number): void {
      const newLayout = computeLayout(activeWord, width, height);
      if (!newLayout) {
        // Viewport too small to animate -- halt and clear.
        stopLoop();
        layout = null;
        engine = null;
        sizeCanvas(rainEl, rainCtx, 0, 0);
        sizeCanvas(wordmarkEl, wordmarkCtx, 0, 0);
        return;
      }

      sizeCanvas(rainEl, rainCtx, newLayout.viewportWidth, newLayout.viewportHeight);
      sizeCanvas(wordmarkEl, wordmarkCtx, newLayout.viewportWidth, newLayout.viewportHeight);

      // Rebuild the engine on first layout or after a significant cellSize
      // change. Minor resizes keep the current engine state.
      const cellChanged = !layout || Math.abs(layout.cellSize - newLayout.cellSize) >= 1;
      if (!engine || cellChanged) {
        engine = createRainEngine(newLayout, { reducedMotion: rm });
        readyFired = false;
        wordmarkDrawn = false;
        lastPhase = null;
      } else {
        engine.resize(newLayout);
        wordmarkDrawn = false;
        lastPhase = null;
      }
      layout = newLayout;

      if (rafHandle === null) {
        rafHandle = requestAnimationFrame(tick);
      }
    }

    function tick(nowMs: number): void {
      if (!engine || !layout) {
        rafHandle = null;
        return;
      }
      engine.step(nowMs);
      const frame = engine.getFrame();
      const vw = Math.floor(layout.viewportWidth);
      const vh = Math.floor(layout.viewportHeight);

      drawRainFrame(rainCtx, frame, layout, vw, vh, {
        fontFamily: FONT_FAMILY,
        fontSizeTuning: FONT_SIZE_TUNING,
      });

      // Skip wordmark redraws once the ambient phase has been painted --
      // the wordmark is static at that point and never changes.
      if (engine.phase !== lastPhase) {
        wordmarkDrawn = false;
        lastPhase = engine.phase;
      }
      if (!wordmarkDrawn || engine.phase !== 'ambient') {
        drawWordmarkFrame(wordmarkCtx, frame, layout, vw, vh);
        if (engine.phase === 'ambient') wordmarkDrawn = true;
      }

      if (!readyFired && engine.wordmarkReady) {
        readyFired = true;
        onready?.();
      }

      rafHandle = requestAnimationFrame(tick);
    }

    function stopLoop(): void {
      if (rafHandle !== null) {
        cancelAnimationFrame(rafHandle);
        rafHandle = null;
      }
    }

    // Initial measure + bootstrap.
    const initialRect = parent.getBoundingClientRect();
    applySize(initialRect.width, initialRect.height);

    // ResizeObserver debounced via RAF. The RAF callback is tracked so
    // unmount can cancel it.
    const ro = new ResizeObserver((entries) => {
      if (disposed || resizeRafHandle !== null) return;
      resizeRafHandle = requestAnimationFrame(() => {
        resizeRafHandle = null;
        if (disposed) return;
        const entry = entries[0];
        if (!entry) return;
        const { width, height } = entry.contentRect;
        applySize(width, height);
      });
    });
    ro.observe(parent);

    return () => {
      disposed = true;
      stopLoop();
      if (resizeRafHandle !== null) {
        cancelAnimationFrame(resizeRafHandle);
        resizeRafHandle = null;
      }
      ro.disconnect();
      engine = null;
      layout = null;
    };
  });

  /**
   * Resize the canvas backing store to match `(w, h)` logical CSS pixels at
   * the current device-pixel ratio. Resets the 2D transform to map logical
   * pixels onto the scaled backing store. Setting `canvas.width` or
   * `canvas.height` clears all canvas state; the renderer re-establishes
   * everything it needs each frame, so the clear is safe.
   */
  function sizeCanvas(el: HTMLCanvasElement, ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.max(0, Math.floor(w));
    const cssH = Math.max(0, Math.floor(h));
    el.style.width = `${cssW}px`;
    el.style.height = `${cssH}px`;
    el.width = Math.floor(cssW * dpr);
    el.height = Math.floor(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
</script>

<div class={className} style="position: relative;">
  <canvas bind:this={rainCanvas} class="absolute inset-0 block w-full h-full"></canvas>
  <canvas bind:this={wordmarkCanvas} class="absolute inset-0 block w-full h-full wordmark-glow pointer-events-none"
  ></canvas>
</div>

<style>
  .wordmark-glow {
    filter: drop-shadow(0 0 8px rgba(0, 255, 65, 0.4)) drop-shadow(0 0 3px rgba(0, 255, 65, 0.3));
  }
</style>
