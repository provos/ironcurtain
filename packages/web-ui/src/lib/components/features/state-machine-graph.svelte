<script lang="ts" module>
  import type { SvgPoint } from '$lib/project-svg-to-grid.js';

  /**
   * Trigger pushed by the theater when an `agent_started` / `agent_completed`
   * workflow event fires. The graph enriches it with SVG-space positions and
   * emits a {@link TransitionEvent} via `ontransition`.
   *
   * `id` disambiguates successive triggers of the same kind so the graph's
   * `$effect` re-fires; theater-side monotonic counter is fine.
   */
  export interface AgentTransitionTrigger {
    readonly id: string | number;
    readonly kind: 'started' | 'completed';
    /** State that just started (`started`) or just finished (`completed`). */
    readonly stateId: string;
    /** Peer end of the handoff: previous state for `started`, next state for `completed`. */
    readonly peerStateId: string;
    /** Truncated notes from agent_status YAML — only present on `completed`. */
    readonly notes?: string;
  }

  /**
   * Enriched transition event fired to the theater.
   * Positions are in SVG space; project via `projectSvgToGrid()` for density work.
   */
  export interface TransitionEvent {
    readonly kind: 'started' | 'completed';
    readonly from: string;
    readonly to: string;
    readonly fromPos: SvgPoint;
    readonly toPos: SvgPoint;
    /** Short human-readable handoff text (truncated notes). Empty string if absent. */
    readonly handoffLabel: string;
  }

  export type { SvgPoint };
</script>

<script lang="ts">
  import dagre from '@dagrejs/dagre';
  import type { StateGraphDto, StateNodeDto, TransitionEdgeDto } from '$lib/types.js';

  let {
    graph,
    currentState = null,
    completedStates = [],
    failedState = null,
    visitCounts = {},
    compact = false,
    agentEvent = null,
    onnodepositions,
    ontransition,
  }: {
    graph: StateGraphDto;
    currentState: string | null;
    completedStates: string[];
    failedState: string | null;
    visitCounts: Record<string, number>;
    compact?: boolean;
    /** When set, the graph fires `ontransition` with enriched positions. */
    agentEvent?: AgentTransitionTrigger | null;
    onnodepositions?: (positions: ReadonlyMap<string, SvgPoint>) => void;
    ontransition?: (t: TransitionEvent) => void;
  } = $props();

  // Layout constants
  const NODE_WIDTH = 180;
  const NODE_HEIGHT = 56;
  const NODE_PADDING = 40;

  interface LayoutNode {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    node: StateNodeDto;
  }

  interface LayoutEdge {
    from: string;
    to: string;
    points: Array<{ x: number; y: number }>;
    /** All transitions between this from/to pair (may be multiple with different guards). */
    edges: TransitionEdgeDto[];
  }

  // Responsive layout direction based on container dimensions
  let containerEl: HTMLDivElement | undefined = $state();
  let rankDir = $state<'LR' | 'TB'>('LR');

  $effect(() => {
    if (!containerEl) return;
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      rankDir = width >= height * 1.3 ? 'LR' : 'TB';
    });
    observer.observe(containerEl);
    return () => observer.disconnect();
  });

  const completedSet = $derived(new Set(completedStates));

  // Recompute layout when graph or rankDir changes
  const layoutResult = $derived.by(() => {
    if (!graph || graph.states.length === 0) return null;
    return computeLayout(graph, rankDir);
  });

  const layoutNodes = $derived(layoutResult?.nodes ?? []);
  const layoutEdges = $derived(layoutResult?.edges ?? []);
  const viewBox = $derived(layoutResult?.viewBox ?? '0 0 400 300');

  // Map nodeId -> SVG-space center. Stable reference per layout so consumers
  // that depend on equality (effect deps) don't thrash.
  const nodePositions = $derived.by<ReadonlyMap<string, SvgPoint>>(() => {
    const m = new Map<string, SvgPoint>();
    for (const ln of layoutNodes) m.set(ln.id, { x: ln.x, y: ln.y });
    return m;
  });

  // Report positions after each layout pass. The theater projects them into
  // grid space for the density field; skipping the callback when undefined
  // preserves the zero-cost path for WorkflowDetail consumers.
  $effect(() => {
    if (!onnodepositions) return;
    if (nodePositions.size === 0) return;
    onnodepositions(nodePositions);
  });

  // Fire ontransition only when a new agentEvent arrives (discriminated by id).
  // Guard states and decision nodes surface as state_entered (not agent_*), so
  // they update highlighting via `currentState` without triggering FX here.
  let lastFiredAgentEventId = $state<string | number | null>(null);
  $effect(() => {
    if (!ontransition || !agentEvent) return;
    if (agentEvent.id === lastFiredAgentEventId) return;
    const fromId = agentEvent.kind === 'completed' ? agentEvent.stateId : agentEvent.peerStateId;
    const toId = agentEvent.kind === 'completed' ? agentEvent.peerStateId : agentEvent.stateId;
    // Guard: when the route can't resolve a peer state (first event of a run,
    // or a gap in event ordering), fromId === toId. A zero-length lerp would
    // pop in place — skip the FX cycle until a real handoff arrives.
    if (fromId === toId) return;
    const fromPos = nodePositions.get(fromId);
    const toPos = nodePositions.get(toId);
    if (!fromPos || !toPos) return;
    lastFiredAgentEventId = agentEvent.id;
    ontransition({
      kind: agentEvent.kind,
      from: fromId,
      to: toId,
      fromPos,
      toPos,
      handoffLabel: truncateHandoff(agentEvent.notes ?? ''),
    });
  });

  function truncateHandoff(text: string): string {
    const max = 80;
    if (text.length <= max) return text;
    return text.slice(0, max - 1) + '…';
  }

  function computeLayout(
    g: StateGraphDto,
    dir: 'LR' | 'TB',
  ): {
    nodes: LayoutNode[];
    edges: LayoutEdge[];
    viewBox: string;
  } {
    const nodesep = dir === 'LR' ? 40 : 50;
    const ranksep = dir === 'LR' ? 90 : 70;

    const dg = new dagre.graphlib.Graph({ multigraph: true });
    dg.setGraph({ rankdir: dir, nodesep, ranksep, marginx: NODE_PADDING, marginy: NODE_PADDING });
    dg.setDefaultEdgeLabel(() => ({}));

    for (const state of g.states) {
      dg.setNode(state.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
    }
    for (let i = 0; i < g.transitions.length; i++) {
      const t = g.transitions[i];
      const edgeKey = `${t.from}-${t.to}-${i}`;
      dg.setEdge(t.from, t.to, {}, edgeKey);
    }

    dagre.layout(dg);

    const nodeMap = new Map<string, StateNodeDto>();
    for (const s of g.states) nodeMap.set(s.id, s);

    const nodes: LayoutNode[] = [];
    for (const nodeId of dg.nodes()) {
      const n = dg.node(nodeId);
      const stateNode = nodeMap.get(nodeId);
      if (!n || !stateNode) continue;
      nodes.push({
        id: nodeId,
        x: n.x,
        y: n.y,
        width: n.width,
        height: n.height,
        node: stateNode,
      });
    }

    // Group all transitions by from->to pair so multiple guards are preserved
    const edgeMap = new Map<string, TransitionEdgeDto[]>();
    for (const t of g.transitions) {
      const key = `${t.from}->${t.to}`;
      const list = edgeMap.get(key);
      if (list) {
        list.push(t);
      } else {
        edgeMap.set(key, [t]);
      }
    }

    // Dagre may produce multiple edge entries for multigraph; deduplicate by from->to pair
    const seenEdgePairs = new Set<string>();
    const edges: LayoutEdge[] = [];
    for (const e of dg.edges()) {
      const pairKey = `${e.v}->${e.w}`;
      if (seenEdgePairs.has(pairKey)) continue;
      seenEdgePairs.add(pairKey);
      const edgeData = dg.edge(e);
      const edgeDtos = edgeMap.get(pairKey);
      if (!edgeData || !edgeDtos) continue;
      edges.push({
        from: e.v,
        to: e.w,
        points: edgeData.points ?? [],
        edges: edgeDtos,
      });
    }

    // Compute viewBox from bounds
    const graphInfo = dg.graph();
    const w = (graphInfo.width ?? 400) + NODE_PADDING * 2;
    const h = (graphInfo.height ?? 300) + NODE_PADDING * 2;
    const vb = `0 0 ${Math.ceil(w)} ${Math.ceil(h)}`;

    return { nodes, edges, viewBox: vb };
  }

  type NodeStatus = 'active' | 'completed' | 'failed' | 'pending';

  function nodeStatus(id: string): NodeStatus {
    if (id === failedState) return 'failed';
    if (id === currentState) return 'active';
    if (completedSet.has(id)) return 'completed';
    return 'pending';
  }

  // CSS classes for the HTML node body. Borders/glows/pulse live in the
  // component style block; background + text color pull from Tailwind theme vars.
  function nodeBodyClass(node: StateNodeDto, status: NodeStatus): string {
    const base = 'smg-node';
    const typeCls = `smg-node--${node.type}`;
    const statusCls = `smg-node--${status}`;
    return `${base} ${typeCls} ${statusCls}`;
  }

  function edgePath(points: Array<{ x: number; y: number }>): string {
    if (points.length === 0) return '';
    const [first, ...rest] = points;
    let d = `M ${first.x} ${first.y}`;
    if (rest.length === 1) {
      d += ` L ${rest[0].x} ${rest[0].y}`;
    } else if (rest.length >= 2) {
      // Use smooth curve through points
      for (let i = 0; i < rest.length - 1; i++) {
        const curr = rest[i];
        const next = rest[i + 1];
        const cx = (curr.x + next.x) / 2;
        const cy = (curr.y + next.y) / 2;
        d += ` Q ${curr.x} ${curr.y} ${cx} ${cy}`;
      }
      const last = rest[rest.length - 1];
      d += ` L ${last.x} ${last.y}`;
    }
    return d;
  }

  function edgeLabelPos(points: Array<{ x: number; y: number }>): { x: number; y: number } {
    if (points.length === 0) return { x: 0, y: 0 };
    const mid = Math.floor(points.length / 2);
    return { x: points[mid].x, y: points[mid].y - 8 };
  }
</script>

<div bind:this={containerEl} class="w-full {compact ? 'max-h-48' : 'max-h-[60vh]'} overflow-auto">
  <svg
    class="w-full smg-svg"
    {viewBox}
    preserveAspectRatio="xMidYMid meet"
    role="img"
    aria-label="Workflow state machine graph"
  >
    <defs>
      <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
        <polygon points="0 0, 8 3, 0 6" class="fill-muted-foreground/60" />
      </marker>
    </defs>

    <!-- Edges: dormant by default. The transition-FX overlay (Chunk 9) brightens
         them during payload handoff by toggling the data-active attribute. -->
    {#each layoutEdges as le (le.from + '->' + le.to)}
      {@const isBackEdge = le.edges.some(
        (e) => e.guard?.toLowerCase().includes('reject') || e.guard?.toLowerCase().includes('revision'),
      )}
      <path
        d={edgePath(le.points)}
        fill="none"
        class="smg-edge {isBackEdge ? 'smg-edge--back' : ''}"
        stroke-width={compact ? 1 : 1.5}
        marker-end="url(#arrowhead)"
        data-from={le.from}
        data-to={le.to}
        data-active="false"
      />
      {#if !compact}
        {@const labels = le.edges.map((e) => e.label).filter(Boolean)}
        {#if labels.length > 0}
          {@const pos = edgeLabelPos(le.points)}
          <text x={pos.x} y={pos.y} text-anchor="middle" class="smg-edge-label">
            {labels.join(' | ')}
          </text>
        {/if}
      {/if}
    {/each}

    <!-- Nodes: HTML via <foreignObject> so drop-shadow, backdrop-filter, and
         the active-state CSS pulse are GPU-accelerated. SVG primitives would
         require filter chains that don't composite as cheaply. -->
    {#each layoutNodes as ln (ln.id)}
      {@const status = nodeStatus(ln.id)}
      {@const vc = visitCounts[ln.id]}
      <foreignObject
        x={ln.x - ln.width / 2}
        y={ln.y - ln.height / 2}
        width={ln.width}
        height={ln.height}
        data-state-id={ln.id}
      >
        <div
          class={nodeBodyClass(ln.node, status)}
          title={ln.node.description || ln.node.label}
          role="figure"
          aria-label={ln.node.label}
        >
          <div class="smg-node__title">{ln.node.label}</div>
          {#if ln.node.persona && !compact}
            <div class="smg-node__persona">{ln.node.persona}</div>
          {/if}

          {#if vc && vc > 1 && !compact}
            <div class="smg-node__badge">{vc}x</div>
          {:else if status === 'completed'}
            <div class="smg-node__check" aria-hidden="true">&#10003;</div>
          {/if}
        </div>
      </foreignObject>
    {/each}
  </svg>
</div>

<style>
  /* Dormant edges — thin dashed 20% opacity. The transition-FX overlay toggles
     data-active to brighten them during payload handoff (Chunk 9). Muting the
     arrowhead here keeps the "path exists, not in use" affordance consistent. */
  .smg-edge {
    stroke: hsl(var(--primary));
    stroke-opacity: 0.2;
    stroke-dasharray: 4 3;
    fill: none;
    transition:
      stroke-opacity 400ms ease,
      stroke-width 400ms ease;
  }
  .smg-edge--back {
    stroke-dasharray: 6 4;
  }
  /* Chunk 9's transition FX toggles data-active via direct DOM manipulation, so
     the concrete value is never set by this template. :global keeps the rule
     in the output without Svelte pruning it as "unused". */
  .smg-edge:global([data-active='true']) {
    stroke-opacity: 0.8;
    stroke-width: 2;
    filter: drop-shadow(0 0 4px hsl(var(--primary) / 0.6));
  }

  .smg-edge-label {
    fill: hsl(var(--muted-foreground) / 0.7);
    font-size: 11px;
  }

  /* Node HTML body. The foreignObject establishes the SVG-space bounding box;
     this div fills it with CSS-rendered content so typography and effects are
     under the normal CSS pipeline. */
  .smg-node {
    width: 100%;
    height: 100%;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    position: relative;
    border-radius: 8px;
    padding: 4px 8px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-feature-settings: 'tnum' 1; /* tabular numerics for visit count */
    text-align: center;
    overflow: hidden;
    color: hsl(var(--foreground));
    background: hsl(var(--muted) / 0.5);
    border: 1px solid hsl(var(--border));
    transition:
      opacity 200ms ease,
      border-color 200ms ease,
      box-shadow 200ms ease;
  }

  .smg-node--human_gate {
    /* Rounded corners clipped into a soft-lozenge approximation — SVG diamond
       primitive was visually louder than the active-state FX warranted. */
    border-radius: 14px;
  }
  .smg-node--terminal {
    border-radius: 12px;
    box-shadow: inset 0 0 0 1px hsl(var(--border) / 0.6);
  }
  .smg-node--deterministic {
    border-radius: 2px;
  }

  .smg-node__title {
    font-size: 11px;
    font-weight: 600;
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
  .smg-node__persona {
    font-size: 9px;
    color: hsl(var(--muted-foreground));
    line-height: 1.2;
    margin-top: 1px;
  }

  .smg-node__badge {
    position: absolute;
    top: 2px;
    right: 4px;
    min-width: 18px;
    height: 14px;
    padding: 0 4px;
    border-radius: 7px;
    background: hsl(var(--primary));
    color: hsl(var(--primary-foreground));
    font-size: 8px;
    font-weight: 700;
    line-height: 14px;
    text-align: center;
  }
  .smg-node__check {
    position: absolute;
    top: 1px;
    right: 4px;
    color: hsl(var(--success));
    font-size: 12px;
    line-height: 1;
  }

  /* Active: breathing pulse. 1.8s sine cycle, 0.4 -> 1.0 on the glow so it's
     clearly alive without being fidgety across the minutes a state runs.
     Background layers a primary tint over an opaque-ish backdrop so the
     pulse + label read cleanly against the rain instead of letting
     characters flicker through the interior. */
  .smg-node--active {
    /* --smg-active-color parameterizes the active-node affordance so the
       theater scope can override it (cyan in documentary viz, amber in
       classic). Keyframes below reference this variable; they resolve
       per-element, so an override on the element takes effect immediately. */
    --smg-active-color: var(--primary);
    border: 2px solid hsl(var(--smg-active-color));
    background:
      linear-gradient(hsl(var(--smg-active-color) / 0.18), hsl(var(--smg-active-color) / 0.18)),
      hsl(var(--background) / 0.7);
    animation: smg-node-pulse 1.8s ease-in-out infinite;
  }
  /* Phosphor bloom on the active-node label (§E.5). Same drop-shadow idiom
     the login page's matrix-rain uses for its wordmark — applied to the
     label text only, not the node chrome, so the visual language stays
     "glowing phosphor glyph" rather than "glowing button." */
  .smg-node--active .smg-node__title {
    text-shadow:
      0 0 4px hsl(var(--smg-active-color) / 0.9),
      0 0 10px hsl(var(--smg-active-color) / 0.5);
  }
  .smg-node--active.smg-node--human_gate {
    --smg-active-color: var(--warning);
    border-color: hsl(var(--smg-active-color));
    background:
      linear-gradient(hsl(var(--smg-active-color) / 0.18), hsl(var(--smg-active-color) / 0.18)),
      hsl(var(--background) / 0.7);
    animation-name: smg-node-pulse-warn;
  }

  /* Scan-line overlay on the active node. Absolute-positioned ::before gives
     us a no-layout-shift interior stripe that reads as "live terminal". */
  .smg-node--active::before {
    content: '';
    position: absolute;
    inset: 0;
    background-image: repeating-linear-gradient(
      0deg,
      transparent 0,
      transparent 3px,
      hsl(var(--smg-active-color) / 0.08) 3px,
      hsl(var(--smg-active-color) / 0.08) 4px
    );
    pointer-events: none;
  }

  @keyframes smg-node-pulse {
    0%,
    100% {
      box-shadow: 0 0 8px hsl(var(--smg-active-color) / 0.4);
    }
    50% {
      box-shadow: 0 0 24px hsl(var(--smg-active-color) / 1);
    }
  }
  @keyframes smg-node-pulse-warn {
    0%,
    100% {
      box-shadow: 0 0 8px hsl(var(--warning) / 0.4);
    }
    50% {
      box-shadow: 0 0 24px hsl(var(--warning) / 1);
    }
  }

  /* Completed: faded but still readable. Opaque-ish background keeps the
     check glyph and label legible against the rain backdrop; a light success
     tint preserves the "done" affordance the old 0.15 success fill gave us. */
  .smg-node--completed {
    opacity: 0.4;
    border: 1px solid hsl(var(--success) / 0.5);
    background: linear-gradient(hsl(var(--success) / 0.12), hsl(var(--success) / 0.12)), hsl(var(--background) / 0.6);
  }

  /* Failed: constant crimson glow, no pulse -- dead things don't breathe.
     Stays at full opacity so the failure affordance is never missed. The
     destructive tint layers over an opaque-ish backdrop so the crimson
     chrome reads cleanly against the rain behind the theater. */
  .smg-node--failed {
    border: 2px solid hsl(var(--destructive));
    background:
      linear-gradient(hsl(var(--destructive) / 0.2), hsl(var(--destructive) / 0.2)), hsl(var(--background) / 0.7);
    box-shadow: 0 0 16px hsl(var(--destructive) / 0.7);
  }

  .smg-node--pending {
    opacity: 0.85;
    border-style: dashed;
  }
  /* Unvisited pending nodes (not currently active, not completed, not failed):
     raised from the original 0.2/dashed/no-background to 0.7/solid/opaque
     backdrop. At 0.2 over the rain the nodes effectively disappeared; the
     graph's shape has to read clearly even when the active node is hidden,
     which is the Fix #2 forcing function. Solid border beats dashed here
     because dashed reads as noise against the flickering rain. */
  .smg-node--pending:not(.smg-node--active):not(.smg-node--completed):not(.smg-node--failed) {
    opacity: 0.7;
    border-style: solid;
    background: hsl(var(--background) / 0.6);
  }

  /* Accessibility: respect the user's motion preferences. The active-node pulse
     is intentional decoration, not informational — if a user opts out, hold
     the node at the pulse's peak so the active affordance is still visible. */
  @media (prefers-reduced-motion: reduce) {
    .smg-node--active,
    .smg-node--active.smg-node--human_gate {
      animation: none;
    }
    .smg-node--active {
      box-shadow: 0 0 24px hsl(var(--primary));
    }
    .smg-node--active.smg-node--human_gate {
      box-shadow: 0 0 24px hsl(var(--warning));
    }
  }

  /* ---------- Chunk 9: arrival scan-line + flash badge (§D.2, §D.4) ----------
     Set by the transition-FX component via `data-arrival='true'` on the
     foreignObject. Both the scan-line sweep and the notes flash are driven
     off the same attribute so the graph owns the visual language; the FX
     component only orchestrates the flag. The :global block passes rules
     through untouched — the data attribute is toggled at runtime so Svelte's
     scoped CSS pruner can't see it. */
  :global {
    foreignObject[data-arrival='true'] .smg-node::after {
      content: '';
      position: absolute;
      inset: 0;
      pointer-events: none;
      background-image: linear-gradient(90deg, transparent 0%, hsl(var(--primary) / 0.6) 50%, transparent 100%);
      animation: smg-arrival-sweep 200ms ease-out forwards;
    }
    foreignObject[data-arrival='true'] .smg-node::before {
      content: attr(data-arrival-notes);
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      padding: 2px 6px;
      background: hsl(var(--primary) / 0.95);
      color: hsl(var(--primary-foreground));
      font-size: 9px;
      line-height: 1.2;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      text-align: left;
      animation: smg-arrival-badge-fade 400ms ease-out forwards;
      pointer-events: none;
      z-index: 2;
    }
    @keyframes smg-arrival-sweep {
      0% {
        transform: translateX(-100%);
        opacity: 1;
      }
      100% {
        transform: translateX(100%);
        opacity: 0;
      }
    }
    @keyframes smg-arrival-badge-fade {
      0% {
        opacity: 1;
        transform: translateY(0);
      }
      70% {
        opacity: 0.9;
      }
      100% {
        opacity: 0;
        transform: translateY(-2px);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      foreignObject[data-arrival='true'] .smg-node::after,
      foreignObject[data-arrival='true'] .smg-node::before {
        animation: none;
      }
    }
  }
</style>
