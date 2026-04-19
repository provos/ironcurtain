import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/svelte';
import WorkflowTheater from '../workflow-theater.svelte';
import type { StateGraphDto } from '$lib/types.js';

// ---------------------------------------------------------------------------
// jsdom shims
// ---------------------------------------------------------------------------
// jsdom lacks Canvas, ResizeObserver, and requestAnimationFrame in shapes the
// theater needs. We mirror the pattern used by `matrix-rain.test.ts`.

type RafCallback = (time: number) => void;
interface PendingRaf {
  id: number;
  cb: RafCallback;
}

let pendingRafs: PendingRaf[] = [];
let nextRafId = 1;

function makeStubContext(): CanvasRenderingContext2D {
  return {
    setTransform: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    measureText: vi.fn().mockReturnValue({ width: 0 }),
    globalAlpha: 1,
    fillStyle: '#000',
    font: '',
    textBaseline: 'top',
    textAlign: 'left',
  } as unknown as CanvasRenderingContext2D;
}

function installShims(): void {
  pendingRafs = [];
  nextRafId = 1;

  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );

  vi.stubGlobal('requestAnimationFrame', (cb: RafCallback) => {
    const id = nextRafId++;
    pendingRafs.push({ id, cb });
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    pendingRafs = pendingRafs.filter((r) => r.id !== id);
  });

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

  // Ensure visibilityState is reachable and overridable across tests.
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: (): DocumentVisibilityState => 'visible',
  });
}

/** Drain all queued rAF callbacks with a monotonically increasing timestamp. */
let currentNow = 0;
function drainRaf(advanceMs = 16): void {
  currentNow += advanceMs;
  const batch = pendingRafs;
  pendingRafs = [];
  for (const r of batch) r.cb(currentNow);
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  currentNow = 0;
  installShims();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeGraph(): StateGraphDto {
  return {
    states: [
      { id: 'a', type: 'agent', label: 'A' },
      { id: 'b', type: 'agent', label: 'B' },
      { id: 'c', type: 'terminal', label: 'C' },
    ],
    transitions: [
      { from: 'a', to: 'b', label: '', event: 'CONTINUE' },
      { from: 'b', to: 'c', label: '', event: 'DONE' },
    ],
  };
}

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    workflowId: 'wf-test',
    graph: makeGraph(),
    currentState: 'a' as string | null,
    completedStates: [] as readonly string[],
    failedState: null as string | null,
    visitCounts: new Map<string, number>(),
    agentEvent: null,
    ...overrides,
  };
}

function findVisibilityHandler(): () => void {
  // addEventListener was called inline during the theater's mount $effect.
  // We can't re-read history after the fact without a pre-installed spy, so
  // we capture events on the raw document prototype via a minimal DOM probe:
  // dispatch a visibilitychange Event and observe whether the loop changes
  // state. Callers prefer calling this for the assert; here we just return a
  // function that simulates the event.
  return () => {
    document.dispatchEvent(new Event('visibilitychange'));
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowTheater', () => {
  describe('mount', () => {
    it('mounts without throwing, given minimal valid props', () => {
      expect(() => {
        render(WorkflowTheater, { props: makeProps() });
      }).not.toThrow();
    });

    it('renders the embedded state-machine-graph', () => {
      const { container } = render(WorkflowTheater, { props: makeProps() });
      const fos = container.querySelectorAll('foreignObject[data-state-id]');
      expect(fos.length).toBe(3);
    });

    it('renders a canvas and a graph container stacked correctly', () => {
      const { container } = render(WorkflowTheater, { props: makeProps() });
      expect(container.querySelector('canvas.theater-canvas')).not.toBeNull();
      expect(container.querySelector('.theater-graph')).not.toBeNull();
    });
  });

  describe('rAF loop lifecycle', () => {
    it('starts the loop on mount (rAF queue non-empty)', async () => {
      render(WorkflowTheater, { props: makeProps() });
      await flushMicrotasks();
      expect(pendingRafs.length).toBeGreaterThan(0);
    });

    it('continues looping across frames', async () => {
      render(WorkflowTheater, { props: makeProps() });
      await flushMicrotasks();
      const before = pendingRafs.length;
      drainRaf();
      expect(pendingRafs.length).toBeGreaterThan(0);
      expect(before).toBeGreaterThan(0);
    });

    it('cancels the loop on unmount', async () => {
      const { unmount } = render(WorkflowTheater, { props: makeProps() });
      await flushMicrotasks();
      unmount();
      // After unmount and draining, no new callbacks should be queued.
      drainRaf();
      drainRaf();
      expect(pendingRafs.length).toBe(0);
    });
  });

  describe('visibility handling', () => {
    it('halts the loop when the document becomes hidden', async () => {
      render(WorkflowTheater, { props: makeProps() });
      await flushMicrotasks();
      // Clear the queue so we can observe fresh activity post-visibilitychange.
      drainRaf();
      expect(pendingRafs.length).toBeGreaterThan(0);

      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      findVisibilityHandler()();
      // The director's stop() cancels the currently-queued rAF; drain returns 0.
      drainRaf();
      expect(pendingRafs.length).toBe(0);
    });

    it('resumes the loop when the document becomes visible', async () => {
      render(WorkflowTheater, { props: makeProps() });
      await flushMicrotasks();
      drainRaf();

      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      findVisibilityHandler()();
      drainRaf();
      expect(pendingRafs.length).toBe(0);

      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      findVisibilityHandler()();
      // Resuming should re-queue a callback.
      expect(pendingRafs.length).toBeGreaterThan(0);
    });
  });

  describe('subscribe / unsubscribe wiring', () => {
    it('calls onSubscribe on mount and onUnsubscribe on unmount', async () => {
      const onSubscribe = vi.fn().mockResolvedValue(undefined);
      const onUnsubscribe = vi.fn().mockResolvedValue(undefined);
      const { unmount } = render(WorkflowTheater, {
        props: makeProps({ onSubscribe, onUnsubscribe }),
      });
      await flushMicrotasks();
      expect(onSubscribe).toHaveBeenCalledTimes(1);
      unmount();
      expect(onUnsubscribe).toHaveBeenCalledTimes(1);
    });

    it('swallows onSubscribe rejection without crashing the mount', async () => {
      const onSubscribe = vi.fn().mockRejectedValue(new Error('nope'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      render(WorkflowTheater, { props: makeProps({ onSubscribe }) });
      await flushMicrotasks();
      await flushMicrotasks();
      expect(onSubscribe).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe('currentState changes', () => {
    it('updates without throwing when currentState transitions', async () => {
      const { rerender } = render(WorkflowTheater, { props: makeProps({ currentState: 'a' }) });
      await flushMicrotasks();
      await rerender(makeProps({ currentState: 'b' }));
      await rerender(makeProps({ currentState: 'c' }));
      expect(pendingRafs.length).toBeGreaterThan(0);
    });
  });

  describe('agentEvent pass-through', () => {
    it('reflects the last transition through the theater container data attr', async () => {
      const { container, rerender } = render(WorkflowTheater, { props: makeProps() });
      await flushMicrotasks();
      await rerender(
        makeProps({
          agentEvent: { id: 1, kind: 'completed', stateId: 'a', peerStateId: 'b', notes: 'handoff' },
        }),
      );
      await flushMicrotasks();
      const theater = container.querySelector('.workflow-theater');
      // The state-machine-graph fires ontransition synchronously in its $effect;
      // theater stores the event and renders a `data-last-transition` attr.
      expect(theater?.getAttribute('data-last-transition')).toBe('a->b');
    });
  });

  describe('Chunk 9: transition-fx overlay wiring', () => {
    it('does not mount the FX overlay before any transition', async () => {
      const { container } = render(WorkflowTheater, { props: makeProps() });
      await flushMicrotasks();
      expect(container.querySelector('.transition-fx-host')).toBeNull();
    });

    it('mounts the FX overlay after an agent transition fires', async () => {
      const { container, rerender } = render(WorkflowTheater, { props: makeProps() });
      await flushMicrotasks();
      await rerender(
        makeProps({
          agentEvent: {
            id: 1,
            kind: 'completed',
            stateId: 'a',
            peerStateId: 'b',
            notes: 'handoff notes',
          },
        }),
      );
      await flushMicrotasks();
      // First tick paints and publishes the frame through onTransitionFxFrame.
      drainRaf();
      await flushMicrotasks();
      expect(container.querySelector('.transition-fx-host')).not.toBeNull();
    });
  });

  // Fix #1 — the theater measures rendered node bounding rects on each
  // onnodepositions callback and forwards them to the director as avoid
  // regions. Verify the measurement flow runs end-to-end by overriding
  // Element.prototype.getBoundingClientRect and watching for foreignObject
  // invocations while the $effect chain runs on mount.
  describe('avoid-regions wiring', () => {
    it('measures node rects after layout fires', async () => {
      const foCalls: string[] = [];
      // Swap Element.prototype getBCR so every descendant measurement is
      // observable, then restore on teardown. Per-element spies don't work
      // here because the spy needs to be in place *before* the theater's
      // $effect chain runs — and that runs during render, before the test
      // body gets control to install spies.
      const priorDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect');
      const priorFn = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
        const tag = this.tagName?.toLowerCase();
        if (tag === 'foreignobject') {
          const id = this.getAttribute('data-state-id');
          if (id) foCalls.push(id);
          return {
            x: 50,
            y: 50,
            top: 50,
            left: 50,
            bottom: 100,
            right: 130,
            width: 80,
            height: 50,
            toJSON: () => ({}),
          } as DOMRect;
        }
        return priorFn.call(this) as DOMRect;
      };

      try {
        render(WorkflowTheater, { props: makeProps() });
        await flushMicrotasks();
        // Drain one rAF so the director's loop has had a tick; some of the
        // measurement flow may defer to the next frame on certain Svelte
        // versions.
        drainRaf();
        await flushMicrotasks();
        // Three nodes → measure should have run against all three.
        expect(new Set(foCalls)).toEqual(new Set(['a', 'b', 'c']));
      } finally {
        if (priorDescriptor) {
          Object.defineProperty(Element.prototype, 'getBoundingClientRect', priorDescriptor);
        } else {
          Element.prototype.getBoundingClientRect = priorFn;
        }
      }
    });
  });

  // Fix #3 — the theater-graph wrapper must center its child SVG so the
  // dagre-laid-out graph sits in the middle of the theater rather than
  // pinned to the top-left. jsdom doesn't process Svelte scoped CSS
  // robustly enough to measure computed flex styles, so we assert the
  // structural contract: the SVG carries the xMidYMid meet hint and lives
  // inside the expected wrapper. Rendered-layout centering is covered by
  // the Playwright e2e suite.
  describe('graph centering in theater mode', () => {
    it('renders the graph SVG centered within its wrapper', async () => {
      const { container } = render(WorkflowTheater, { props: makeProps() });
      await flushMicrotasks();
      const svg = container.querySelector<SVGSVGElement>('svg.smg-svg');
      expect(svg).not.toBeNull();
      if (!svg) return;
      // With preserveAspectRatio="xMidYMid meet" + width/height:100% the SVG
      // content is guaranteed to center as long as the wrapper has flex
      // centering (enforced via CSS). Assert the structural contract: the
      // SVG lives inside a `.theater-graph` wrapper and carries the
      // xMidYMid meet hint. If a future refactor drops either, centering
      // regresses silently — the e2e suite catches the visual failure.
      expect(svg.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
      expect(svg.closest('.theater-graph')).not.toBeNull();
    });

    it('declares flex centering rules in the theater style block', async () => {
      // The regression the fix targets was a dropped centering rule on the
      // `.theater-graph` wrapper. Guard against a future refactor that
      // deletes the flex/center rules by scanning the component source. We
      // can't use document.styleSheets here because @testing-library/svelte
      // under jsdom doesn't inject Svelte's scoped CSS — the style tags
      // never reach the document. Reading the source file gives the same
      // guarantee without relying on jsdom CSS.
      const fs = await import('node:fs');
      const path = await import('node:path');
      const src = fs.readFileSync(
        path.resolve(process.cwd(), 'src/lib/components/features/workflow-theater.svelte'),
        'utf-8',
      );
      // A theater-graph rule must declare `justify-content: center` and
      // `align-items: center` — otherwise the SVG pins to a corner.
      expect(src).toMatch(/\.theater-graph[^{]*\{[^}]*justify-content:\s*center/);
      expect(src).toMatch(/\.theater-graph[^{]*\{[^}]*align-items:\s*center/);
    });
  });
});
