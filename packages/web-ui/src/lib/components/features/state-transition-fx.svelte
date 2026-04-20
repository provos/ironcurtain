<script lang="ts">
  /**
   * Transition-FX overlay (see design doc §D.1–§D.6).
   *
   * Renders the payload handoff tile on a canvas stacked between the graph
   * (z-10) and the HUD (z-30). The tile is the one "discrete punctuation" event
   * in an otherwise ambient view — everything else lives in the rain layer.
   *
   * Architecture choice: this component is passive. The director owns the one
   * rAF loop (§D.6) and calls into here via `onframe`. When the FX is active
   * we draw; when idle we skip. No rAF here — that would violate the one-rAF
   * rule.
   *
   * Coordinate system: §A.4 treats SVG-space as CSS-pixel-space for the density
   * field. We follow the same convention for the tile. The FX canvas is pixel-
   * matched to the graph's SVG element (not the container) so the tile lands on
   * the same coordinates the graph reports via `onnodepositions`. Uses
   * `getScreenCTM()` to convert SVG-space -> screen pixels; the canvas is then
   * positioned to cover the SVG and drawn in screen-space. If `getScreenCTM`
   * returns null (jsdom in some test paths), we fall back to an identity-ish
   * layout — good enough for smoke tests, no visual artifact because the FX
   * isn't being observed.
   *
   * Edge brightening (§C.4): when the cycle starts, we toggle `data-active` on
   * the path in the graph SVG matching `fromId -> toId`. On cycle end we clear
   * it. The graph CSS already has the transition defined; we're just
   * orchestrating the data attribute.
   *
   * Arrival badge + scan-line (§D.2, §D.4): both driven by `data-arrival` on
   * the incoming node's foreignObject. CSS rules keyed off the attribute
   * handle the flash animation and the ::before scan-line sweep. This keeps
   * node styling local to the graph's style block and avoids leaking FX
   * concerns into the node template.
   */

  import { onMount } from 'svelte';
  import type { TransitionFxFrame, TransitionTriggerLike } from '$lib/transition-fx.js';

  interface Props {
    /** The director hands this canvas back into its tick loop. */
    oncanvas?: (el: HTMLCanvasElement | null) => void;
    /** The theater pipes the director's tick-end FX frame through this prop
     *  callback. Null = idle. We expose a ref-based setter via oncanvas so the
     *  theater has a direct handle for imperative draws if it prefers. */
    frame?: TransitionFxFrame | null;
    /** Currently-active trigger, or null. Drives DOM-side effects (edge
     *  brightening, arrival badge). The theater forwards from the director's
     *  `getActiveTransition()`. */
    active?: TransitionTriggerLike | null;
    /** The root element that contains the graph SVG — used to query edges and
     *  foreignObject nodes by `data-from` / `data-to` / `data-state-id`. */
    graphRoot?: HTMLElement | null;
  }

  const { frame = null, active = null, graphRoot = null, oncanvas }: Props = $props();

  let canvasEl: HTMLCanvasElement | undefined = $state();
  let hostEl: HTMLDivElement | undefined = $state();

  // Tracks the current edge/arrival-node so we can clean up their data-attrs
  // when the cycle ends, even if `active` flips to a different trigger.
  let activeEdgeEl: Element | null = null;
  let activeNodeEl: Element | null = null;
  let scanlineTimer: number | null = null;

  onMount(() => {
    oncanvas?.(canvasEl ?? null);
    return () => {
      oncanvas?.(null);
      clearActiveEdge();
      clearActiveNode();
    };
  });

  // Edge brightening + arrival badge/scan-line driver. §C.4 + §D.4 glued at
  // this effect boundary because they're both keyed off the same lifecycle:
  // active -> non-null on trigger, active -> null at TOTAL_MS.
  $effect(() => {
    const a = active;
    const f = frame;
    if (!a || !f) {
      clearActiveEdge();
      clearActiveNode();
      return;
    }
    // Edge stays bright for the full travel window. §C.4 fade-back is a CSS
    // transition already wired into the graph's style block.
    if (f.phase === 'traveling') {
      setActiveEdge(a.from, a.to);
    } else {
      clearActiveEdge();
    }
    // Arrival badge + scan-line trigger on absorb-enter. The node-side
    // CSS animation handles the rest; we just need to toggle the flag.
    if (f.phase === 'absorbing' && activeNodeEl === null) {
      setActiveNode(a.to, f.notes);
    }
    if (f.phase === 'scan-line') {
      // Keep the data-arrival flag up for the scan-line tail so the CSS
      // animation can complete. Clear it when we return to idle (handled
      // by the `!a || !f` branch next frame).
    }
  });

  // Canvas paint — imperative on every `frame` prop change. Svelte's reactive
  // graph fires this exactly once per director tick because the frame reference
  // is re-allocated each time. Idle frames (null) clear the canvas.
  $effect(() => {
    const f = frame;
    if (!canvasEl || !hostEl) return;
    const ctx = canvasEl.getContext('2d');
    if (!ctx) return;
    sizeCanvasToHost(canvasEl, hostEl, ctx);
    const cssW = canvasEl.clientWidth;
    const cssH = canvasEl.clientHeight;
    ctx.clearRect(0, 0, cssW, cssH);
    if (!f || f.tileAlpha <= 0 || f.tileScale <= 0) return;
    drawTile(ctx, f, cssW, cssH);
  });

  function sizeCanvasToHost(el: HTMLCanvasElement, host: HTMLDivElement, ctx: CanvasRenderingContext2D): void {
    const rect = host.getBoundingClientRect();
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const cssW = Math.max(1, Math.floor(rect.width));
    const cssH = Math.max(1, Math.floor(rect.height));
    if (el.width !== Math.floor(cssW * dpr) || el.height !== Math.floor(cssH * dpr)) {
      el.style.width = `${cssW}px`;
      el.style.height = `${cssH}px`;
      el.width = Math.floor(cssW * dpr);
      el.height = Math.floor(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Convert a point from SVG-space (the graph's internal coordinate system)
   *  to canvas CSS pixels. Falls back to identity if `getScreenCTM()` is
   *  unavailable (jsdom). */
  function svgToCanvas(svgX: number, svgY: number): { x: number; y: number } {
    const svg = graphRoot?.querySelector('svg.smg-svg') ?? null;
    const canvas = canvasEl;
    if (!svg || !canvas || !(svg instanceof SVGSVGElement)) {
      return { x: svgX, y: svgY };
    }
    const ctm = svg.getScreenCTM?.();
    if (!ctm) return { x: svgX, y: svgY };
    // Project (svgX, svgY) to screen, then subtract the canvas's screen origin.
    const pt = svg.createSVGPoint();
    pt.x = svgX;
    pt.y = svgY;
    const screen = pt.matrixTransform(ctm);
    const canvasRect = canvas.getBoundingClientRect();
    return { x: screen.x - canvasRect.left, y: screen.y - canvasRect.top };
  }

  const TILE_W = 180;
  const TILE_H = 44;

  function drawTile(ctx: CanvasRenderingContext2D, f: TransitionFxFrame, cssW: number, cssH: number): void {
    const { x, y } = svgToCanvas(f.tilePos.x, f.tilePos.y);
    // Center the tile on the projected point and apply scale.
    const w = TILE_W * f.tileScale;
    const h = TILE_H * f.tileScale;
    const left = x - w / 2;
    const top = y - h / 2;

    // Off-screen / clipped? Skip.
    if (left + w < 0 || top + h < 0 || left > cssW || top > cssH) return;

    ctx.save();
    ctx.globalAlpha = f.tileAlpha;

    // Phosphor glow — matches the rest of the viz. Tile border uses
    // --accent-cyan per §D.2; the theater is the only mount site for this FX
    // so there is no need to gate on a parent selector.
    const border = 'hsl(var(--accent-cyan))';
    const bg = 'hsl(var(--background) / 0.9)';

    ctx.shadowColor = border;
    ctx.shadowBlur = 10 * f.tileScale;
    ctx.fillStyle = bg;
    roundRect(ctx, left, top, w, h, 6 * f.tileScale);
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.strokeStyle = border;
    ctx.globalAlpha = f.tileAlpha * 0.8;
    ctx.lineWidth = 1.5;
    roundRect(ctx, left, top, w, h, 6 * f.tileScale);
    ctx.stroke();

    // Text: truncated notes. Skip during absorb-late when the tile is too
    // small to read — keeps the shrink-into-header look clean.
    if (f.tileScale > 0.6 && f.notes.length > 0) {
      ctx.globalAlpha = f.tileAlpha;
      ctx.fillStyle = border;
      const fontPx = Math.max(8, Math.round(11 * f.tileScale));
      ctx.font = `${fontPx}px "JetBrains Mono", ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // Canvas 2D lacks ellipsis-on-overflow, so we fit-truncate here. The
      // subsystem already capped at ~80 chars; visually we trim further to
      // fit the tile width.
      const maxPx = w - 16;
      const text = fitText(ctx, f.notes, maxPx);
      ctx.fillText(text, left + w / 2, top + h / 2);
    }

    ctx.restore();
  }

  function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  function fitText(ctx: CanvasRenderingContext2D, text: string, maxPx: number): string {
    if (maxPx <= 0) return '';
    if (ctx.measureText(text).width <= maxPx) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      const candidate = text.slice(0, mid) + '…';
      if (ctx.measureText(candidate).width <= maxPx) lo = mid;
      else hi = mid - 1;
    }
    return text.slice(0, lo) + '…';
  }

  // ---------------------------------------------------------------------------
  // DOM side effects: edge brightening, arrival badge/scan-line
  // ---------------------------------------------------------------------------

  function setActiveEdge(fromId: string, toId: string): void {
    if (!graphRoot) return;
    const el = graphRoot.querySelector(
      `path.smg-edge[data-from="${escapeAttr(fromId)}"][data-to="${escapeAttr(toId)}"]`,
    );
    if (!el) return;
    if (activeEdgeEl && activeEdgeEl !== el) activeEdgeEl.setAttribute('data-active', 'false');
    el.setAttribute('data-active', 'true');
    activeEdgeEl = el;
  }

  function clearActiveEdge(): void {
    if (activeEdgeEl) {
      activeEdgeEl.setAttribute('data-active', 'false');
      activeEdgeEl = null;
    }
  }

  function setActiveNode(toId: string, notes: string): void {
    if (!graphRoot) return;
    const fo = graphRoot.querySelector(`foreignObject[data-state-id="${escapeAttr(toId)}"]`);
    if (!fo) return;
    fo.setAttribute('data-arrival', 'true');
    fo.setAttribute('data-arrival-notes', notes);
    activeNodeEl = fo;
    // Drop the attribute after the scan-line tail so the CSS keyframes settle.
    // The cycle total after absorb is SCANLINE_MS=200; we give 400ms for the
    // fade tail because the tail's CSS transition is set to 400ms.
    if (scanlineTimer !== null) clearTimeout(scanlineTimer);
    scanlineTimer = setTimeout(() => {
      clearActiveNode();
    }, 400) as unknown as number;
  }

  function clearActiveNode(): void {
    if (activeNodeEl) {
      activeNodeEl.removeAttribute('data-arrival');
      activeNodeEl.removeAttribute('data-arrival-notes');
      activeNodeEl = null;
    }
    if (scanlineTimer !== null) {
      clearTimeout(scanlineTimer);
      scanlineTimer = null;
    }
  }

  function escapeAttr(s: string): string {
    return s.replace(/"/g, '\\"');
  }
</script>

<div bind:this={hostEl} class="transition-fx-host" aria-hidden="true">
  <canvas bind:this={canvasEl} class="transition-fx-canvas"></canvas>
</div>

<style>
  .transition-fx-host {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 20;
  }
  .transition-fx-canvas {
    position: absolute;
    inset: 0;
    display: block;
    pointer-events: none;
  }
</style>
