import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/svelte';
import StateMachineGraph from './state-machine-graph.svelte';
import type { AgentTransitionTrigger } from './state-machine-graph.svelte';
import type { StateGraphDto, StateNodeDto, TransitionEdgeDto } from '$lib/types.js';

// ---------------------------------------------------------------------------
// jsdom is missing ResizeObserver -- stub it globally.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeNode(id: string, overrides: Partial<StateNodeDto> = {}): StateNodeDto {
  return { id, type: 'agent', label: id, ...overrides };
}

function makeEdge(from: string, to: string, overrides: Partial<TransitionEdgeDto> = {}): TransitionEdgeDto {
  return { from, to, label: '', ...overrides };
}

function makeGraph(): StateGraphDto {
  // Linear a -> b -> c with one back-edge c -> a.
  return {
    states: [makeNode('a'), makeNode('b'), makeNode('c', { type: 'terminal' })],
    transitions: [
      makeEdge('a', 'b', { event: 'CONTINUE' }),
      makeEdge('b', 'c', { event: 'CONTINUE' }),
      makeEdge('c', 'a', { guard: 'reject' }),
    ],
  };
}

// Let TS infer the shape from the literal -- Svelte 5 matches it structurally
// against $$ComponentProps; explicitly annotating erases required fields.
function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    graph: makeGraph(),
    currentState: null,
    completedStates: [],
    failedState: null,
    visitCounts: {},
    ...overrides,
  };
}

// Helper: grab rendered node bodies keyed by state id.
function nodeBodies(container: HTMLElement): Map<string, HTMLElement> {
  const map = new Map<string, HTMLElement>();
  const foreignObjects = container.querySelectorAll('foreignObject[data-state-id]');
  for (const fo of foreignObjects) {
    const id = fo.getAttribute('data-state-id');
    const body = fo.querySelector<HTMLElement>('.smg-node');
    if (id && body) map.set(id, body);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StateMachineGraph', () => {
  describe('rendering', () => {
    it('renders one foreignObject per state with the label', () => {
      const { container } = render(StateMachineGraph, { props: makeProps() });
      const bodies = nodeBodies(container);
      expect(bodies.size).toBe(3);
      for (const id of ['a', 'b', 'c']) {
        expect(bodies.get(id)?.querySelector('.smg-node__title')?.textContent).toBe(id);
      }
    });

    it('renders one SVG path per edge with the dormant class', () => {
      const { container } = render(StateMachineGraph, { props: makeProps() });
      const edges = container.querySelectorAll('path.smg-edge');
      expect(edges.length).toBe(3);
      for (const edge of edges) {
        // Dormant edges must not be pre-activated; Chunk 9 will toggle this to 'true'.
        expect(edge.getAttribute('data-active')).toBe('false');
      }
    });

    it('marks back-edges (guard contains reject) with smg-edge--back', () => {
      const { container } = render(StateMachineGraph, { props: makeProps() });
      const backEdges = container.querySelectorAll('path.smg-edge--back');
      expect(backEdges.length).toBe(1);
      const backEdge = backEdges[0] as SVGPathElement;
      expect(backEdge.getAttribute('data-from')).toBe('c');
      expect(backEdge.getAttribute('data-to')).toBe('a');
    });
  });

  describe('node state styling', () => {
    it('applies smg-node--active to the currentState node', () => {
      const { container } = render(StateMachineGraph, {
        props: makeProps({ currentState: 'b' }),
      });
      const bodies = nodeBodies(container);
      expect(bodies.get('a')?.classList.contains('smg-node--active')).toBe(false);
      expect(bodies.get('b')?.classList.contains('smg-node--active')).toBe(true);
      expect(bodies.get('c')?.classList.contains('smg-node--active')).toBe(false);
    });

    it('applies smg-node--completed to completedStates', () => {
      const { container } = render(StateMachineGraph, {
        props: makeProps({ currentState: 'b', completedStates: ['a'] }),
      });
      const bodies = nodeBodies(container);
      expect(bodies.get('a')?.classList.contains('smg-node--completed')).toBe(true);
      expect(bodies.get('b')?.classList.contains('smg-node--completed')).toBe(false);
    });

    it('applies smg-node--failed to failedState and not smg-node--active', () => {
      const { container } = render(StateMachineGraph, {
        props: makeProps({ currentState: 'b', failedState: 'b' }),
      });
      const bodies = nodeBodies(container);
      // failed outranks active when both would match
      expect(bodies.get('b')?.classList.contains('smg-node--failed')).toBe(true);
      expect(bodies.get('b')?.classList.contains('smg-node--active')).toBe(false);
    });

    it('renders a check glyph for completed-but-not-revisited states', () => {
      const { container } = render(StateMachineGraph, {
        props: makeProps({ currentState: 'b', completedStates: ['a'] }),
      });
      const check = container.querySelector('foreignObject[data-state-id="a"] .smg-node__check');
      expect(check).not.toBeNull();
    });

    it('renders a visit-count badge in place of the check glyph when visits > 1', () => {
      const { container } = render(StateMachineGraph, {
        props: makeProps({
          currentState: 'b',
          completedStates: ['a'],
          visitCounts: { a: 3 },
        }),
      });
      const fo = container.querySelector('foreignObject[data-state-id="a"]');
      expect(fo?.querySelector('.smg-node__badge')?.textContent).toBe('3x');
      expect(fo?.querySelector('.smg-node__check')).toBeNull();
    });

    it('hides the visit-count badge in compact mode', () => {
      const { container } = render(StateMachineGraph, {
        props: makeProps({
          currentState: 'b',
          completedStates: ['a'],
          visitCounts: { a: 3 },
          compact: true,
        }),
      });
      expect(container.querySelector('.smg-node__badge')).toBeNull();
    });

    it('applies pending/dashed to unvisited nodes by default', () => {
      const { container } = render(StateMachineGraph, { props: makeProps() });
      const bodies = nodeBodies(container);
      for (const body of bodies.values()) {
        expect(body.classList.contains('smg-node--pending')).toBe(true);
      }
    });
  });

  describe('onnodepositions callback', () => {
    it('fires with a map of every rendered node', () => {
      const cb = vi.fn<(positions: ReadonlyMap<string, { x: number; y: number }>) => void>();
      render(StateMachineGraph, { props: makeProps({ onnodepositions: cb }) });

      expect(cb).toHaveBeenCalled();
      const lastCall = cb.mock.calls[cb.mock.calls.length - 1][0];
      expect(new Set(lastCall.keys())).toEqual(new Set(['a', 'b', 'c']));
      // Dagre assigns finite coordinates; we don't assert specific values.
      for (const pos of lastCall.values()) {
        expect(Number.isFinite(pos.x)).toBe(true);
        expect(Number.isFinite(pos.y)).toBe(true);
      }
    });

    it('does not throw when omitted (existing consumers keep working)', () => {
      expect(() => {
        render(StateMachineGraph, { props: makeProps() });
      }).not.toThrow();
    });
  });

  describe('ontransition callback', () => {
    function renderWithTrigger(trigger: AgentTransitionTrigger | null) {
      const ontransition = vi.fn();
      const result = render(StateMachineGraph, {
        props: makeProps({ agentEvent: trigger, ontransition }),
      });
      return { ontransition, ...result };
    }

    it('does not fire when agentEvent is null', () => {
      const { ontransition } = renderWithTrigger(null);
      expect(ontransition).not.toHaveBeenCalled();
    });

    it('fires on an agent_completed trigger with from=stateId, to=peerStateId', async () => {
      const { ontransition, rerender } = renderWithTrigger(null);
      await rerender(
        makeProps({
          agentEvent: { id: 1, kind: 'completed', stateId: 'a', peerStateId: 'b', notes: 'handed off' },
          ontransition,
        }),
      );
      expect(ontransition).toHaveBeenCalledTimes(1);
      const evt = ontransition.mock.calls[0][0];
      expect(evt.kind).toBe('completed');
      expect(evt.from).toBe('a');
      expect(evt.to).toBe('b');
      expect(evt.handoffLabel).toBe('handed off');
      expect(Number.isFinite(evt.fromPos.x)).toBe(true);
      expect(Number.isFinite(evt.toPos.x)).toBe(true);
    });

    it('fires on an agent_started trigger with from=peerStateId, to=stateId', async () => {
      const { ontransition, rerender } = renderWithTrigger(null);
      await rerender(
        makeProps({
          agentEvent: { id: 1, kind: 'started', stateId: 'b', peerStateId: 'a' },
          ontransition,
        }),
      );
      expect(ontransition).toHaveBeenCalledTimes(1);
      const evt = ontransition.mock.calls[0][0];
      expect(evt.kind).toBe('started');
      expect(evt.from).toBe('a');
      expect(evt.to).toBe('b');
      expect(evt.handoffLabel).toBe(''); // started carries no notes
    });

    it('deduplicates repeat triggers with the same id', async () => {
      const ontransition = vi.fn();
      const trigger: AgentTransitionTrigger = {
        id: 42,
        kind: 'completed',
        stateId: 'a',
        peerStateId: 'b',
      };
      const { rerender } = render(StateMachineGraph, {
        props: makeProps({ agentEvent: trigger, ontransition }),
      });
      expect(ontransition).toHaveBeenCalledTimes(1);

      // Same id, new object reference -- should NOT refire.
      await rerender(makeProps({ agentEvent: { ...trigger }, ontransition }));
      expect(ontransition).toHaveBeenCalledTimes(1);

      // New id -- SHOULD refire.
      await rerender(makeProps({ agentEvent: { ...trigger, id: 43 }, ontransition }));
      expect(ontransition).toHaveBeenCalledTimes(2);
    });

    it('truncates notes longer than 80 chars with an ellipsis', async () => {
      const longNotes = 'x'.repeat(120);
      const ontransition = vi.fn();
      render(StateMachineGraph, {
        props: makeProps({
          agentEvent: { id: 'a1', kind: 'completed', stateId: 'a', peerStateId: 'b', notes: longNotes },
          ontransition,
        }),
      });
      const label = ontransition.mock.calls[0][0].handoffLabel;
      expect(label.length).toBe(80);
      expect(label.endsWith('…')).toBe(true);
    });

    it('does not fire when either referenced state is missing from the graph', async () => {
      const ontransition = vi.fn();
      render(StateMachineGraph, {
        props: makeProps({
          agentEvent: { id: 1, kind: 'completed', stateId: 'a', peerStateId: 'ghost' },
          ontransition,
        }),
      });
      expect(ontransition).not.toHaveBeenCalled();
    });
  });

  describe('backward compatibility', () => {
    it('renders without the new props (mirrors WorkflowDetail usage today)', () => {
      const { container } = render(StateMachineGraph, {
        props: makeProps({
          currentState: 'b',
          completedStates: ['a'],
          visitCounts: { a: 1 },
        }),
      });
      // Three nodes, three edges, no errors.
      expect(nodeBodies(container).size).toBe(3);
      expect(container.querySelectorAll('path.smg-edge').length).toBe(3);
    });
  });
});
