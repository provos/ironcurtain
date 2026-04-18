import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/svelte';
import StateTransitionFx from '../state-transition-fx.svelte';
import type { TransitionFxFrame, TransitionTriggerLike } from '$lib/transition-fx.js';

// ---------------------------------------------------------------------------
// jsdom canvas shim (same pattern as workflow-theater.test.ts)
// ---------------------------------------------------------------------------

function makeStubContext(): CanvasRenderingContext2D {
  return {
    setTransform: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    measureText: vi.fn().mockReturnValue({ width: 50 }),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    globalAlpha: 1,
    fillStyle: '#000',
    strokeStyle: '#000',
    shadowColor: '#000',
    shadowBlur: 0,
    lineWidth: 1,
    font: '',
    textBaseline: 'top',
    textAlign: 'left',
  } as unknown as CanvasRenderingContext2D;
}

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() =>
    makeStubContext(),
  ) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  Element.prototype.getBoundingClientRect = vi.fn(
    () =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        bottom: 400,
        right: 600,
        width: 600,
        height: 400,
        toJSON: () => ({}),
      }) as DOMRect,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFrame(overrides: Partial<TransitionFxFrame> = {}): TransitionFxFrame {
  return {
    phase: 'traveling',
    tilePos: { x: 100, y: 100 },
    tileScale: 1,
    tileAlpha: 1,
    notes: 'handoff notes',
    fromId: 'a',
    toId: 'b',
    ...overrides,
  };
}

function makeActive(overrides: Partial<TransitionTriggerLike> = {}): TransitionTriggerLike {
  return {
    from: 'a',
    to: 'b',
    fromPos: { x: 100, y: 100 },
    toPos: { x: 400, y: 100 },
    handoffLabel: 'notes',
    ...overrides,
  };
}

function makeGraphRoot(): HTMLDivElement {
  const root = document.createElement('div');
  root.innerHTML = `
    <svg class="smg-svg" viewBox="0 0 600 400">
      <path class="smg-edge" data-from="a" data-to="b" data-active="false"></path>
      <foreignObject data-state-id="a"><div class="smg-node">A</div></foreignObject>
      <foreignObject data-state-id="b"><div class="smg-node">B</div></foreignObject>
    </svg>
  `;
  return root;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StateTransitionFx', () => {
  describe('mount', () => {
    it('renders without throwing when given null frame + null active', () => {
      expect(() => {
        render(StateTransitionFx, { props: { frame: null, active: null, graphRoot: null } });
      }).not.toThrow();
    });

    it('renders a canvas element', () => {
      const { container } = render(StateTransitionFx, {
        props: { frame: null, active: null, graphRoot: null },
      });
      expect(container.querySelector('canvas.transition-fx-canvas')).not.toBeNull();
    });

    it('renders without throwing when given a live frame + active trigger', () => {
      const graphRoot = makeGraphRoot();
      expect(() => {
        render(StateTransitionFx, {
          props: { frame: makeFrame(), active: makeActive(), graphRoot },
        });
      }).not.toThrow();
    });
  });

  describe('edge brightening (§C.4)', () => {
    it('sets data-active=true on the matching edge while traveling', async () => {
      const graphRoot = makeGraphRoot();
      render(StateTransitionFx, {
        props: { frame: makeFrame({ phase: 'traveling' }), active: makeActive(), graphRoot },
      });
      // $effect runs after mount microtask.
      await Promise.resolve();
      const edge = graphRoot.querySelector('path.smg-edge[data-from="a"][data-to="b"]');
      expect(edge?.getAttribute('data-active')).toBe('true');
    });

    it('clears data-active when the phase leaves traveling', async () => {
      const graphRoot = makeGraphRoot();
      const { rerender } = render(StateTransitionFx, {
        props: { frame: makeFrame({ phase: 'traveling' }), active: makeActive(), graphRoot },
      });
      await Promise.resolve();
      await rerender({
        frame: makeFrame({ phase: 'absorbing' }),
        active: makeActive(),
        graphRoot,
      });
      const edge = graphRoot.querySelector('path.smg-edge[data-from="a"][data-to="b"]');
      expect(edge?.getAttribute('data-active')).toBe('false');
    });

    it('clears data-active when active/frame become null', async () => {
      const graphRoot = makeGraphRoot();
      const { rerender } = render(StateTransitionFx, {
        props: { frame: makeFrame({ phase: 'traveling' }), active: makeActive(), graphRoot },
      });
      await Promise.resolve();
      await rerender({ frame: null, active: null, graphRoot });
      const edge = graphRoot.querySelector('path.smg-edge[data-from="a"][data-to="b"]');
      expect(edge?.getAttribute('data-active')).toBe('false');
    });
  });

  describe('arrival badge (§D.2)', () => {
    it('sets data-arrival on the incoming node when absorbing', async () => {
      const graphRoot = makeGraphRoot();
      render(StateTransitionFx, {
        props: { frame: makeFrame({ phase: 'absorbing' }), active: makeActive(), graphRoot },
      });
      await Promise.resolve();
      const fo = graphRoot.querySelector('foreignObject[data-state-id="b"]');
      expect(fo?.getAttribute('data-arrival')).toBe('true');
      // data-arrival-notes exposes the truncated notes to CSS content: attr().
      expect(fo?.getAttribute('data-arrival-notes')).toBe('handoff notes');
    });
  });

  describe('graceful no-ops', () => {
    it('does nothing when graphRoot is null even while active', async () => {
      expect(() => {
        render(StateTransitionFx, {
          props: { frame: makeFrame(), active: makeActive(), graphRoot: null },
        });
      }).not.toThrow();
    });

    it('tolerates a missing edge path in the graph DOM', async () => {
      const graphRoot = document.createElement('div');
      graphRoot.innerHTML = '<svg class="smg-svg"></svg>';
      expect(() => {
        render(StateTransitionFx, {
          props: { frame: makeFrame(), active: makeActive({ from: 'x', to: 'y' }), graphRoot },
        });
      }).not.toThrow();
    });
  });
});
