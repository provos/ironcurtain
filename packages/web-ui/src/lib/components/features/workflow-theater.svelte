<script lang="ts" module>
  import type { AgentTransitionTrigger, TransitionEvent } from './state-machine-graph.svelte';

  export type { AgentTransitionTrigger, TransitionEvent };
</script>

<script lang="ts">
  /**
   * Workflow theater — the cinematic viz container (Chunk 8).
   *
   * Full-bleed stack:
   *   z-0   stream-rain canvas       (decorative, ambient tableau)
   *   z-10  state-machine-graph      (the Dagre-rendered FSM; interactive)
   *   z-20  transition-FX overlay    (Chunk 9, mounted only while active)
   *   z-30  ambient HUD              (Chunk 10, deferred)
   *
   * The heavy lifting — rAF loop, density-field updates, word scorer, intensity
   * sampling, error isolation — lives in `VisualizationDirector` (§A.1 size
   * trigger hit; this component crossed 400 LOC before extraction). The
   * component is now true glue: bind the canvas, own the visibility + resize
   * handlers that only make sense here, forward lifecycle calls to the director.
   *
   * Token-stream participation is delegated via `onSubscribe` / `onUnsubscribe`
   * props — the route owns WS actions, the theater just gets the lifecycle
   * hooks. `tokenStreamStore` (the singleton imperative fanout) is imported
   * directly because it's presentation-agnostic and doesn't talk to the WS.
   * See CLAUDE.md "features/ components MUST NOT import from stores.svelte.ts"
   * — this split keeps RPC calls route-side while still letting the theater
   * subscribe to the fanout.
   */

  import { onMount, untrack } from 'svelte';
  import { createStreamRainEngine } from '$lib/matrix-rain/stream-engine.js';
  import type { AvoidRect } from '$lib/matrix-rain/stream-engine.js';
  import type { LayoutPlan } from '$lib/matrix-rain/types.js';
  import { tokenStreamStore } from '$lib/token-stream-store-singleton.js';
  import { createVisualizationDirector, type VisualizationDirector } from '$lib/visualization-director.js';
  import type { SvgPoint } from '$lib/project-svg-to-grid.js';
  import type { StateGraphDto, TokenStreamEvent } from '$lib/types.js';
  import type { TransitionFxFrame, TransitionTriggerLike } from '$lib/transition-fx.js';
  import { shortenModelName } from '$lib/word-scorer.js';
  import StateMachineGraph from './state-machine-graph.svelte';
  import StateTransitionFx from './state-transition-fx.svelte';
  import AmbientHud from './ambient-hud.svelte';

  interface Props {
    workflowId: string;
    graph: StateGraphDto;
    currentState: string | null;
    completedStates: readonly string[];
    failedState: string | null;
    visitCounts: ReadonlyMap<string, number>;
    agentEvent: AgentTransitionTrigger | null;
    /** Route-owned RPC hook. Called once on mount. */
    onSubscribe?: () => Promise<void> | void;
    /** Route-owned RPC hook. Called once on unmount. Fire-and-forget. */
    onUnsubscribe?: () => Promise<void> | void;
    // ── HUD inputs (Chunk 10) ──────────────────────────────────────────
    /** Displayed in the top-left HUD panel. Falls back to the workflow id. */
    workflowName?: string;
    currentRound?: number;
    totalRounds?: number;
    connectionStatus?: 'connected' | 'reconnecting' | 'disconnected';
  }

  const {
    workflowId,
    graph,
    currentState,
    completedStates,
    failedState,
    visitCounts,
    agentEvent,
    onSubscribe,
    onUnsubscribe,
    workflowName,
    currentRound,
    totalRounds,
    connectionStatus = 'connected',
  }: Props = $props();

  /** Theater-owned cellSize. Stream rain uses uniform 12px cells per §A.3. */
  const CELL_SIZE = 12;

  let containerEl: HTMLDivElement | undefined = $state();
  let canvasEl: HTMLCanvasElement | undefined = $state();
  /** Graph wrapper DOM node. Passed to the FX overlay so it can query edge
   *  paths and arrival nodes by data-attr without coupling to the graph's
   *  internal component surface. */
  let graphEl: HTMLDivElement | undefined = $state();

  /** Captured from the graph's `ontransition` callback. Drives the Chunk 9
   *  payload-handoff tile via {@link handleTransition}. */
  let lastTransition = $state<TransitionEvent | null>(null);

  /** Reactive mirror of the director's FX subsystem state, fed by the
   *  director's `onTransitionFxFrame` callback. Null means the overlay is
   *  idle and can unmount. */
  let fxFrame = $state<TransitionFxFrame | null>(null);
  let fxActive = $state<TransitionTriggerLike | null>(null);

  // ── HUD state (Chunk 10) ────────────────────────────────────────────
  // Sampled from tokenStreamStore.intensity.current() at the same cadence
  // the director uses to drive rain intensity (~10 Hz). One more $state
  // per 100ms is noise the reactive graph can absorb without thrashing.
  let tokensPerSec = $state(0);
  // Captured from `message_start` events seen in the stream subscription.
  let modelName = $state<string | null>(null);

  // Imperative, non-reactive runtime bindings. Treating these as $state forces
  // every mutation through Svelte's reactive graph for no template benefit.
  let director: VisualizationDirector | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let visibilityHandler: (() => void) | null = null;
  let resizeRafHandle: number | null = null;
  let hudUnsubscribeStream: (() => void) | null = null;
  let hudSampleHandle: ReturnType<typeof setInterval> | null = null;

  // ---------------------------------------------------------------------------
  // Setup effect — mounts when canvas + container are both bound.
  // ---------------------------------------------------------------------------

  $effect(() => {
    if (!canvasEl || !containerEl) return;
    const ctx = canvasEl.getContext('2d');
    if (!ctx) return;

    const container = containerEl;
    const canvas = canvasEl;
    const rect = container.getBoundingClientRect();
    const layout = buildLayout(Math.max(1, rect.width), Math.max(1, rect.height));
    sizeCanvas(canvas, ctx, layout.viewportWidth, layout.viewportHeight);

    const engine = createStreamRainEngine(layout);
    const d = createVisualizationDirector({
      ctx,
      engine,
      layout,
      tokenStreamStore,
      cellSize: CELL_SIZE,
      onTransitionFxFrame: (f) => {
        fxFrame = f;
        fxActive = d.getActiveTransition();
      },
    });

    director = d;
    // Read currentState untracked — otherwise the setup effect re-runs when
    // a parent re-renders (even with an unchanged value), tearing down and
    // re-creating the director mid-cycle and losing any in-flight FX. The
    // dedicated effect below tracks currentState for the setActiveNode call.
    d.setActiveNode(untrack(() => currentState));
    // Flush any node positions that were reported by the graph before the
    // director finished initializing. Svelte 5 runs child $effects ahead of
    // parent $effects, so handleNodePositions typically fires once with a
    // null director on mount — catch that up now so the density field and
    // avoid regions are live on the first rendered frame.
    if (pendingPositions !== null) {
      d.setNodePositions(pendingPositions);
      d.setAvoidRegions(measureNodeAvoidRegions());
      pendingPositions = null;
    }

    // Only start if the tab is visible. If hidden, we wait for the first
    // visible event before kicking the loop — matches AC4.
    const startHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    if (!startHidden) d.start();

    visibilityHandler = wireVisibility(d);
    resizeObserver = wireResize(canvas, container, ctx, d);
    // HUD wiring is part of the mount lifecycle, not the director — the HUD
    // consumes the same stream but presents a different projection (tok/s +
    // model name), and keeping it outside the director avoids growing the
    // director's surface area for what is strictly a cosmetic readout.
    hudUnsubscribeStream = wireHud();

    return () => {
      d.dispose();
      if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
      }
      if (resizeRafHandle !== null) {
        cancelAnimationFrame(resizeRafHandle);
        resizeRafHandle = null;
      }
      if (visibilityHandler && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', visibilityHandler);
        visibilityHandler = null;
      }
      if (hudUnsubscribeStream) {
        hudUnsubscribeStream();
        hudUnsubscribeStream = null;
      }
      if (hudSampleHandle !== null) {
        clearInterval(hudSampleHandle);
        hudSampleHandle = null;
      }
      director = null;
    };
  });

  // Forward currentState changes to the director. $effect uses reactive deps,
  // so this re-fires on currentState updates without us threading them by hand.
  $effect(() => {
    const id = currentState;
    director?.setActiveNode(id);
  });

  // onMount is the clean home for the subscribe/unsubscribe lifecycle: the
  // cleanup runs once per mount, after $effect cleanups, which is fine — the
  // director has already disposed the stream subscription by then, so late
  // unsubscribe failures are cosmetic.
  onMount(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (onSubscribe) await onSubscribe();
      } catch (err) {
        if (!cancelled) console.warn('[workflow-theater] onSubscribe failed', err);
      }
    })();
    return () => {
      cancelled = true;
      try {
        const result = onUnsubscribe?.();
        if (result instanceof Promise) result.catch(() => undefined);
      } catch (err) {
        console.warn('[workflow-theater] onUnsubscribe failed', err);
      }
    };
  });

  // ---------------------------------------------------------------------------
  // HUD wiring (Chunk 10)
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to the token-stream singleton for `message_start` (model name)
   * and poll the intensity EMA at ~10 Hz for tokens/sec display. Both feeds
   * land in local $state so the `AmbientHud` prop surface stays pure.
   *
   * Sampling is on a setInterval rather than piggybacking on rAF because the
   * HUD's text cadence (~10 Hz) is independent of the canvas's frame rate,
   * and running the interval even when the rAF loop is paused (e.g. tab
   * hidden) is fine — the timer will just tick and update hidden DOM.
   */
  function wireHud(): () => void {
    const stopListener = tokenStreamStore.subscribeToStream((_label, events) => {
      for (const event of events as ReadonlyArray<TokenStreamEvent>) {
        if (event.kind === 'message_start') {
          modelName = shortenModelName(event.model);
        }
      }
    });
    // 100ms matches the director's INTENSITY_SAMPLE_PERIOD_MS. Read the raw
    // EMA (pre-clamp) for display; the rain's density multiplier is separately
    // clamped inside `intensity.current()`.
    hudSampleHandle = setInterval(() => {
      tokensPerSec = tokenStreamStore.ratePerSecond();
    }, 100);
    return stopListener;
  }

  // ---------------------------------------------------------------------------
  // Visibility pause/resume (§D.6 + AC4)
  // ---------------------------------------------------------------------------

  function wireVisibility(d: VisualizationDirector): (() => void) | null {
    if (typeof document === 'undefined') return null;
    const handler = (): void => {
      if (document.visibilityState === 'hidden') {
        d.stop();
      } else {
        d.start();
      }
    };
    document.addEventListener('visibilitychange', handler);
    return handler;
  }

  // ---------------------------------------------------------------------------
  // Resize — debounced via rAF, same pattern as matrix-rain.svelte
  // ---------------------------------------------------------------------------

  function wireResize(
    canvas: HTMLCanvasElement,
    container: HTMLDivElement,
    ctx: CanvasRenderingContext2D,
    d: VisualizationDirector,
  ): ResizeObserver | null {
    if (typeof ResizeObserver === 'undefined') return null;
    const ro = new ResizeObserver((entries) => {
      if (resizeRafHandle !== null) return;
      resizeRafHandle = requestAnimationFrame(() => {
        resizeRafHandle = null;
        const entry = entries[0];
        if (!entry) return;
        const { width, height } = entry.contentRect;
        const w = Math.max(1, width);
        const h = Math.max(1, height);
        const newLayout = buildLayout(w, h);
        sizeCanvas(canvas, ctx, newLayout.viewportWidth, newLayout.viewportHeight);
        d.resize(newLayout);
        // `engine.resize()` clears avoid regions on a grid change; re-publish
        // from the theater's current DOM measurements so the rain keeps
        // parting around nodes. Even without a grid change, node rects shift
        // in CSS pixels when the viewport resizes, so a re-publish is correct.
        d.setAvoidRegions(measureNodeAvoidRegions());
      });
    });
    ro.observe(container);
    return ro;
  }

  // ---------------------------------------------------------------------------
  // Graph callbacks — forward to the director
  // ---------------------------------------------------------------------------

  /**
   * Latest positions reported by the graph. Cached so the setup $effect can
   * forward them to the director on the first tick — Svelte 5 runs child
   * $effects before parent $effects, so `handleNodePositions` frequently
   * fires before `director` is initialized. Without this buffer the initial
   * density field + avoid regions would be dropped until the next layout.
   */
  let pendingPositions: ReadonlyMap<string, SvgPoint> | null = null;

  function handleNodePositions(positions: ReadonlyMap<string, SvgPoint>): void {
    pendingPositions = positions;
    if (director) {
      director.setNodePositions(positions);
      director.setAvoidRegions(measureNodeAvoidRegions());
    }
  }

  /**
   * Measure the CSS-pixel bounding rect of each rendered node (keyed by
   * `data-state-id` on the foreignObject) relative to the theater's own
   * container, then publish the list to the director. The stream engine
   * uses these rects to avoid spawning drops inside opaque node chrome so
   * rain "parts" around nodes cleanly.
   *
   * Called from the graph's `onnodepositions` callback (after each layout
   * pass), which is the precise moment the foreignObject elements have been
   * placed in the DOM at the positions we're about to measure. Reading
   * getBoundingClientRect() here is one paint of forced layout per node —
   * acceptable because the graph only re-lays-out on resize or graph
   * changes, not per frame.
   */
  function measureNodeAvoidRegions(): AvoidRect[] {
    if (!graphEl || !containerEl) return [];
    const containerRect = containerEl.getBoundingClientRect();
    const foreignObjects = graphEl.querySelectorAll('foreignObject[data-state-id]');
    const rects: AvoidRect[] = [];
    for (const fo of foreignObjects) {
      // foreignObject is an SVGGraphicsElement; getBoundingClientRect() reports
      // the element's CSS-pixel bbox in viewport coords. Subtract the theater's
      // own origin so the rect lives in the same coordinate space as the
      // canvas the stream engine paints into.
      const r = (fo as SVGGraphicsElement).getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      rects.push({
        x: r.left - containerRect.left,
        y: r.top - containerRect.top,
        w: r.width,
        h: r.height,
      });
    }
    return rects;
  }

  function handleTransition(evt: TransitionEvent): void {
    lastTransition = evt;
    // Fire the payload-handoff tile. The director drops concurrent triggers
    // with a warn-once (§D concurrency policy), so theater-side doesn't need
    // its own guard.
    director?.triggerTransition(evt);
  }

  // ---------------------------------------------------------------------------
  // Layout + canvas helpers
  // ---------------------------------------------------------------------------

  /**
   * Minimal LayoutPlan for the stream engine. lockedCells + wordmarkImage are
   * stubbed because the stream renderer never reads them (see stream-renderer.ts).
   */
  function buildLayout(width: number, height: number): LayoutPlan {
    const cellSize = CELL_SIZE;
    const cols = Math.max(1, Math.floor(width / cellSize));
    const rows = Math.max(1, Math.floor(height / cellSize));
    return {
      cellSize,
      cols,
      rows,
      originX: 0,
      originY: 0,
      viewportWidth: width,
      viewportHeight: height,
      lockedCells: [],
      wordmarkImage: null,
      wordmarkDrawX: 0,
      wordmarkDrawY: 0,
    };
  }

  function sizeCanvas(el: HTMLCanvasElement, ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const cssW = Math.max(0, Math.floor(w));
    const cssH = Math.max(0, Math.floor(h));
    el.style.width = `${cssW}px`;
    el.style.height = `${cssH}px`;
    el.width = Math.floor(cssW * dpr);
    el.height = Math.floor(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Adapters: graph expects Record<string, number>; theater prop is ReadonlyMap.
  const visitCountsRecord = $derived.by(() => {
    const rec: Record<string, number> = {};
    for (const [k, v] of visitCounts) rec[k] = v;
    return rec;
  });

  // Graph wants a mutable-shaped array for completedStates.
  const completedStatesArr = $derived([...completedStates]);

  // HUD display label — fall back to the id when the route doesn't supply a name.
  const hudWorkflowName = $derived(workflowName ?? workflowId);
</script>

<!-- `data-workflow-id` + `data-last-transition` are genuine attachment points:
     Chunk 9's transition-FX overlay reads the transition id from DOM to drive
     its SVG edge brightening, and the HUD needs the workflow id for display.
     They also make the public props surface observable from E2E probes. -->
<div
  bind:this={containerEl}
  class="workflow-theater"
  data-workflow-id={workflowId}
  data-last-transition={lastTransition ? `${lastTransition.from}->${lastTransition.to}` : ''}
>
  <canvas bind:this={canvasEl} class="theater-canvas"></canvas>

  <div class="theater-graph" bind:this={graphEl}>
    <StateMachineGraph
      {graph}
      {currentState}
      completedStates={completedStatesArr}
      {failedState}
      visitCounts={visitCountsRecord}
      {agentEvent}
      onnodepositions={handleNodePositions}
      ontransition={handleTransition}
    />
  </div>

  <!-- z-20: transition-FX overlay (Chunk 9). Mounted only while the cycle is
       active so the canvas + paint effect are idle-free between transitions. -->
  {#if fxFrame || fxActive}
    <StateTransitionFx frame={fxFrame} active={fxActive} graphRoot={graphEl ?? null} />
  {/if}

  <!-- z-30: ambient HUD (Chunk 10). Two corners only (§E.3, §F.3). -->
  <AmbientHud
    workflowName={hudWorkflowName}
    {currentRound}
    {totalRounds}
    {connectionStatus}
    {tokensPerSec}
    {modelName}
  />
</div>

<style>
  .workflow-theater {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: #000;
  }

  /* CRT scan-lines (§E.4). Full-bleed ::after overlay at z-40 so it sits
     above every subsystem including the HUD — without this ordering, the
     stripes wouldn't unify the canvas + HTML + SVG layers visually.
     pointer-events:none so the graph remains interactive. The 1px/sec
     vertical drift keeps the effect from feeling static without drawing
     the eye. prefers-reduced-motion disables the drift but holds the
     stripes so the terminal aesthetic survives. */
  .workflow-theater::after {
    content: '';
    position: absolute;
    inset: 0;
    z-index: 40;
    pointer-events: none;
    background-image: repeating-linear-gradient(0deg, transparent 0, transparent 2px, rgba(0, 0, 0, 0.15) 3px);
    mix-blend-mode: multiply;
    animation: theater-crt-drift 3s linear infinite;
  }

  @keyframes theater-crt-drift {
    from {
      background-position: 0 0;
    }
    to {
      background-position: 0 3px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .workflow-theater::after {
      animation: none;
    }
  }

  .theater-canvas {
    position: absolute;
    inset: 0;
    z-index: 0;
    display: block;
    pointer-events: none;
  }

  .theater-graph {
    position: absolute;
    inset: 0;
    z-index: 10;
    pointer-events: auto;
    /* The graph component wraps itself in a scroll container capped at 60vh.
       Inside the theater we want it to fill the container, not the viewport.
       center + center lets the SVG's xMidYMid meet preserveAspectRatio kick
       in symmetrically — stretch + stretch left the SVG pinned top-left in
       browsers that honored intrinsic SVG aspect. */
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .theater-graph :global(> div) {
    width: 100%;
    height: 100%;
    max-height: none;
    /* The inner wrapper is the dagre layout's scrolling box. Center its
       SVG child so a short/wide graph viewBox sits in the middle of the
       theater instead of hugging the top-left. */
    display: flex;
    align-items: center;
    justify-content: center;
  }
  /* Force the SVG to fill both axes of its wrapper; preserveAspectRatio
     handles the centering of the actual graph content within. Without an
     explicit height the SVG defaults to intrinsic (viewBox) height which
     broke centering when the theater wrapped the graph in a full-height
     container. */
  .theater-graph :global(svg.smg-svg) {
    width: 100%;
    height: 100%;
  }

  /* Theater-scoped color token migration: the design doc (§C.4, §C.5, §D.2,
     §D.4, §E.3) repeatedly calls for `--accent-cyan` on the dormant edges,
     the active-node chrome, and the payload-handoff tile. Classic
     WorkflowDetail renders the same graph component in a non-cyberpunk
     context, so we can't migrate `--primary` wholesale inside
     state-machine-graph.svelte; instead we swap the tint here and let
     classic mode keep its amber aesthetic. `:global(.smg-*)` reaches into
     the child component's scoped selectors — the same idiom the theater
     already uses for `.theater-graph :global(svg.smg-svg)`. */
  .workflow-theater :global(.smg-edge) {
    stroke: hsl(var(--accent-cyan));
  }
  .workflow-theater :global(.smg-edge[data-active='true']) {
    filter: drop-shadow(0 0 4px hsl(var(--accent-cyan) / 0.6));
  }
  /* The graph defines `--smg-active-color` on `.smg-node--active` that its
     border, background, phosphor bloom, scan-line tint, and pulse keyframe
     all resolve against. Overriding the variable from theater scope flips
     the entire active-node affordance from amber to cyan in one shot —
     including the animated pulse, which (being `var()`-driven) resolves
     per-element at animation time. The human_gate variant sets its own
     override at higher specificity and keeps its warning amber. */
  .workflow-theater :global(.smg-node--active:not(.smg-node--human_gate)) {
    --smg-active-color: var(--accent-cyan);
  }
  /* Arrival scan-line + flash-badge on the receiving node (§D.2, §D.4).
     The child defines these under a `:global` block keyed on
     `data-arrival`; override their primary references here so the sweep
     and badge read as cyan in the theater. The selector path includes
     the foreignObject to match the child's specificity and beat its
     declaration. */
  .workflow-theater :global(foreignObject[data-arrival='true'] .smg-node::after) {
    background-image: linear-gradient(90deg, transparent 0%, hsl(var(--accent-cyan) / 0.6) 50%, transparent 100%);
  }
  .workflow-theater :global(foreignObject[data-arrival='true'] .smg-node::before) {
    background: hsl(var(--accent-cyan) / 0.95);
    color: hsl(var(--background));
  }
</style>
