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
  }: {
    graph: StateGraphDto;
    currentState: string | null;
    completedStates: string[];
    failedState: string | null;
    visitCounts: Record<string, number>;
    compact?: boolean;
  } = $props();

  // Layout constants
  const NODE_WIDTH = 160;
  const NODE_HEIGHT = 50;
  const NODE_PADDING = 40;
  const COMPACT_SCALE = 0.7;

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

  let layoutNodes: LayoutNode[] = $state([]);
  let layoutEdges: LayoutEdge[] = $state([]);
  let viewBox = $state('0 0 400 300');

  const completedSet = $derived(new Set(completedStates));

  // Recompute layout when graph changes
  $effect(() => {
    if (!graph || graph.states.length === 0) return;
    const result = computeLayout(graph);
    layoutNodes = result.nodes;
    layoutEdges = result.edges;
    viewBox = result.viewBox;
  });

  function computeLayout(g: StateGraphDto): {
    nodes: LayoutNode[];
    edges: LayoutEdge[];
    viewBox: string;
  } {
    const dg = new dagre.graphlib.Graph({ multigraph: true });
    dg.setGraph({ rankdir: 'TB', nodesep: 60, ranksep: 80, marginx: NODE_PADDING, marginy: NODE_PADDING });
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

  function nodeStatus(id: string): 'active' | 'completed' | 'failed' | 'pending' {
    if (id === failedState) return 'failed';
    if (id === currentState) return 'active';
    if (completedSet.has(id)) return 'completed';
    return 'pending';
  }

  function nodeFillClass(node: StateNodeDto, status: string): string {
    if (status === 'failed') return 'fill-destructive/20 stroke-destructive';
    if (status === 'active' && node.type === 'human_gate') return 'fill-warning/20 stroke-warning';
    if (status === 'active') return 'fill-primary/20 stroke-primary';
    if (status === 'completed') return 'fill-success/15 stroke-success/50';
    if (node.type === 'human_gate') return 'fill-warning/10 stroke-warning/30';
    return 'fill-muted/50 stroke-border';
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

  // Node shape path generators
  function roundedRect(x: number, y: number, w: number, h: number, r: number): string {
    const x0 = x - w / 2;
    const y0 = y - h / 2;
    return `M ${x0 + r} ${y0} h ${w - 2 * r} a ${r} ${r} 0 0 1 ${r} ${r} v ${h - 2 * r} a ${r} ${r} 0 0 1 -${r} ${r} h -${w - 2 * r} a ${r} ${r} 0 0 1 -${r} -${r} v -${h - 2 * r} a ${r} ${r} 0 0 1 ${r} -${r} Z`;
  }

  function diamondPath(x: number, y: number, w: number, h: number): string {
    return `M ${x} ${y - h / 2} L ${x + w / 2} ${y} L ${x} ${y + h / 2} L ${x - w / 2} ${y} Z`;
  }

  function hexagonPath(x: number, y: number, w: number, h: number): string {
    const indent = w * 0.2;
    const x0 = x - w / 2;
    const y0 = y - h / 2;
    return `M ${x0 + indent} ${y0} L ${x0 + w - indent} ${y0} L ${x0 + w} ${y} L ${x0 + w - indent} ${y0 + h} L ${x0 + indent} ${y0 + h} L ${x0} ${y} Z`;
  }

  function terminalRect(x: number, y: number, w: number, h: number): string {
    return roundedRect(x, y, w, h, 6);
  }

  function shapePath(node: StateNodeDto, x: number, y: number, w: number, h: number): string {
    switch (node.type) {
      case 'agent':
        return roundedRect(x, y, w, h, 8);
      case 'human_gate':
        return diamondPath(x, y, w * 1.1, h * 1.2);
      case 'deterministic':
        return hexagonPath(x, y, w, h);
      case 'terminal':
        return terminalRect(x, y, w, h);
    }
  }
</script>

<svg
  class="w-full {compact ? 'max-h-48' : 'max-h-[500px]'}"
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

  <!-- Edges -->
  {#each layoutEdges as le (le.from + '->' + le.to)}
    {@const isBackEdge = le.edges.some(
      (e) => e.guard?.toLowerCase().includes('reject') || e.guard?.toLowerCase().includes('revision'),
    )}
    <path
      d={edgePath(le.points)}
      fill="none"
      class="stroke-muted-foreground/40"
      stroke-width={compact ? 1 : 1.5}
      stroke-dasharray={isBackEdge ? '6,4' : 'none'}
      marker-end="url(#arrowhead)"
    />
    {#if !compact}
      {@const labels = le.edges.map((e) => e.label).filter(Boolean)}
      {#if labels.length > 0}
        {@const pos = edgeLabelPos(le.points)}
        <text x={pos.x} y={pos.y} text-anchor="middle" class="fill-muted-foreground text-[9px]">
          {labels.join(' | ')}
        </text>
      {/if}
    {/if}
  {/each}

  <!-- Nodes -->
  {#each layoutNodes as ln (ln.id)}
    {@const status = nodeStatus(ln.id)}
    {@const fill = nodeFillClass(ln.node, status)}
    {@const vc = visitCounts[ln.id]}
    <g class={status === 'active' ? 'animate-pulse-slow' : ''}>
      <path
        d={shapePath(ln.node, ln.x, ln.y, ln.width, ln.height)}
        class={fill}
        stroke-width={status === 'active' ? 2 : 1}
      />

      {#if ln.node.type === 'terminal' && status !== 'failed'}
        <!-- Double border for terminal -->
        <path
          d={shapePath(ln.node, ln.x, ln.y, ln.width - 6, ln.height - 6)}
          class={fill}
          stroke-width={0.5}
          fill="none"
        />
      {/if}

      <!-- Label -->
      <text
        x={ln.x}
        y={ln.node.persona && !compact ? ln.y - 4 : ln.y + 1}
        text-anchor="middle"
        dominant-baseline="middle"
        class="fill-foreground text-[11px] font-medium pointer-events-none"
      >
        {ln.node.label}
      </text>

      <!-- Persona sub-label -->
      {#if ln.node.persona && !compact}
        <text
          x={ln.x}
          y={ln.y + 12}
          text-anchor="middle"
          dominant-baseline="middle"
          class="fill-muted-foreground text-[9px] pointer-events-none"
        >
          {ln.node.persona}
        </text>
      {/if}

      <!-- Visit count badge -->
      {#if vc && vc > 1 && !compact}
        <circle cx={ln.x + ln.width / 2 - 4} cy={ln.y - ln.height / 2 + 4} r="9" class="fill-primary" />
        <text
          x={ln.x + ln.width / 2 - 4}
          y={ln.y - ln.height / 2 + 4}
          text-anchor="middle"
          dominant-baseline="middle"
          class="fill-primary-foreground text-[8px] font-bold pointer-events-none"
        >
          {vc}x
        </text>
      {/if}

      <!-- Completed check overlay (hidden when visit count badge is shown) -->
      {#if status === 'completed' && !(vc && vc > 1 && !compact)}
        <text
          x={ln.x + ln.width / 2 - 4}
          y={ln.y - ln.height / 2 + 6}
          text-anchor="middle"
          dominant-baseline="middle"
          class="fill-success text-[12px] pointer-events-none"
        >
          &#10003;
        </text>
      {/if}
    </g>
  {/each}
</svg>

<style>
  @keyframes pulse-slow {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.75;
    }
  }
  :global(.animate-pulse-slow) {
    animation: pulse-slow 2s ease-in-out infinite;
  }
</style>
