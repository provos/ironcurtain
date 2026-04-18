import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createVisualizationDirector, type DirectorDeps } from '$lib/visualization-director.js';
import { createTokenStreamStore } from '$lib/token-stream-store.svelte.js';
import { createStreamRainEngine, type StreamRainEngine } from '$lib/matrix-rain/stream-engine.js';
import type { LayoutPlan } from '$lib/matrix-rain/types.js';
import type { SvgPoint } from '$lib/project-svg-to-grid.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLayout(overrides: Partial<LayoutPlan> = {}): LayoutPlan {
  return {
    cellSize: 12,
    cols: 50,
    rows: 30,
    originX: 0,
    originY: 0,
    viewportWidth: 600,
    viewportHeight: 360,
    lockedCells: [],
    wordmarkImage: null,
    wordmarkDrawX: 0,
    wordmarkDrawY: 0,
    ...overrides,
  };
}

function makeCtxStub(): CanvasRenderingContext2D {
  // Minimal stub — drawStreamFrame assigns to font, fillStyle, and calls a
  // handful of methods. We collect no state beyond what the director needs.
  const ctx = {
    font: '',
    fillStyle: '#000',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
    fillRect: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn().mockReturnValue({ width: 0 }),
    clearRect: vi.fn(),
    setTransform: vi.fn(),
    drawImage: vi.fn(),
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

interface RafHarness {
  readonly raf: (cb: FrameRequestCallback) => number;
  readonly caf: (h: number) => void;
  flush(count?: number): void;
  queueLength(): number;
}

function makeRafHarness(): RafHarness {
  const queue: Array<FrameRequestCallback | null> = [];
  let nowMs = 0;
  return {
    raf(cb) {
      queue.push(cb);
      return queue.length;
    },
    caf(h) {
      if (h >= 1 && h <= queue.length) queue[h - 1] = null;
    },
    flush(count = 1) {
      for (let i = 0; i < count; i++) {
        const drained = queue.splice(0, queue.length);
        for (const cb of drained) {
          nowMs += 16;
          if (cb) cb(nowMs);
        }
      }
    },
    queueLength() {
      return queue.filter((c) => c !== null).length;
    },
  };
}

function makeDeps(overrides: Partial<DirectorDeps> = {}): DirectorDeps {
  const layout = makeLayout();
  return {
    ctx: makeCtxStub(),
    engine: createStreamRainEngine(layout),
    layout,
    tokenStreamStore: createTokenStreamStore(),
    cellSize: 12,
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VisualizationDirector', () => {
  it('starts and stops the rAF loop', () => {
    const harness = makeRafHarness();
    const d = createVisualizationDirector({
      ...makeDeps(),
      requestAnimationFrame: harness.raf,
      cancelAnimationFrame: harness.caf,
    });

    expect(d.running).toBe(false);
    d.start();
    expect(d.running).toBe(true);
    expect(harness.queueLength()).toBe(1);

    harness.flush();
    // Self-sustaining: tick re-queues itself.
    expect(harness.queueLength()).toBe(1);

    d.stop();
    expect(d.running).toBe(false);
  });

  it('dispose() is a no-op when called twice', () => {
    const d = createVisualizationDirector(makeDeps());
    d.dispose();
    expect(() => d.dispose()).not.toThrow();
  });

  it('isolates errors in the stream engine (§D.6) without killing the loop', () => {
    const harness = makeRafHarness();
    const engine = createStreamRainEngine(makeLayout());
    let throwCount = 0;
    const origStep = engine.step.bind(engine);
    engine.step = (nowMs: number): void => {
      throwCount++;
      if (throwCount === 1) throw new Error('boom');
      origStep(nowMs);
    };

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const d = createVisualizationDirector({
      ...makeDeps({ engine }),
      requestAnimationFrame: harness.raf,
      cancelAnimationFrame: harness.caf,
    });
    d.start();
    harness.flush();
    // After the first tick threw, the director should still be running and
    // the loop should have re-queued itself.
    expect(d.running).toBe(true);
    expect(harness.queueLength()).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('subscribes to the token stream store on start and unsubscribes on dispose', () => {
    const store = createTokenStreamStore();
    const publishSpy = vi.spyOn(store, 'subscribeToStream');
    const d = createVisualizationDirector(makeDeps({ tokenStreamStore: store }));
    d.start();
    expect(publishSpy).toHaveBeenCalledTimes(1);
    d.dispose();
    // publish() after dispose must not reach the director (would throw, since
    // the engine's enqueueWord expects a live layout). Successful no-op here
    // means the unsubscribe actually happened.
    expect(() => store.publish(0, [{ kind: 'text_delta', text: 'hello', timestamp: 0 }])).not.toThrow();
  });

  it('rebuilds the density field when setNodePositions is called', () => {
    const engine = createStreamRainEngine(makeLayout());
    const setField = vi.spyOn(engine, 'setDensityField');
    const d = createVisualizationDirector(makeDeps({ engine }));

    const positions = new Map<string, SvgPoint>([
      ['a', { x: 100, y: 100 }],
      ['b', { x: 200, y: 200 }],
    ]);
    d.setActiveNode('a');
    d.setNodePositions(positions);

    expect(setField).toHaveBeenCalled();
    // Active node rebuild: the last call passes a Float32Array of length cols.
    const lastCall = setField.mock.calls[setField.mock.calls.length - 1];
    expect(lastCall[0]).not.toBeNull();
    const field = lastCall[0] as Float32Array;
    expect(field.length).toBe(50);
    // Active node 'a' at (100,100) -> col 8 should have higher weight than
    // 'b' at (200,200) -> col 17 since 'b' is at INACTIVE_AMPLITUDE (0.1).
    expect(field[8]).toBeGreaterThan(field[17]);
  });

  it('switches the hot-spot when setActiveNode changes', () => {
    const engine = createStreamRainEngine(makeLayout());
    const setField = vi.spyOn(engine, 'setDensityField');
    const d = createVisualizationDirector(makeDeps({ engine }));

    const positions = new Map<string, SvgPoint>([
      ['a', { x: 100, y: 100 }],
      ['b', { x: 200, y: 200 }],
    ]);
    d.setNodePositions(positions);
    d.setActiveNode('a');
    const aField = setField.mock.calls[setField.mock.calls.length - 1][0] as Float32Array;

    d.setActiveNode('b');
    const bField = setField.mock.calls[setField.mock.calls.length - 1][0] as Float32Array;

    // After switching active to 'b', b's column should be the max; before, a's was.
    expect(aField[8]).toBeGreaterThan(aField[17]);
    expect(bField[17]).toBeGreaterThan(bField[8]);
  });

  it('clears the density field when positions map is empty', () => {
    const engine = createStreamRainEngine(makeLayout());
    const setField = vi.spyOn(engine, 'setDensityField');
    const d = createVisualizationDirector(makeDeps({ engine }));
    d.setNodePositions(new Map());
    // Last call should be setDensityField(null).
    const lastCall = setField.mock.calls[setField.mock.calls.length - 1];
    expect(lastCall[0]).toBeNull();
  });

  it('enqueues word drops from a text_delta event', () => {
    const engine = createStreamRainEngine(makeLayout());
    const enqueue = vi.spyOn(engine, 'enqueueWord');
    const store = createTokenStreamStore();
    const d = createVisualizationDirector(makeDeps({ engine, tokenStreamStore: store }));
    d.start();

    // One message_start to reset accumulators, then enough text to cross the
    // mid-stream threshold (MID_STREAM_THRESHOLD = 200 chars).
    store.publish(0, [{ kind: 'message_start', model: 'claude-sonnet', timestamp: 0 }]);
    const longText = 'compile '.repeat(40);
    store.publish(0, [{ kind: 'text_delta', text: longText, timestamp: 100 }]);

    // Between the message_start (which enqueues the model name) and the text,
    // at least one word drop should have been enqueued.
    expect(enqueue).toHaveBeenCalled();
  });

  it('samples intensity at most once per 100ms in the tick', () => {
    const harness = makeRafHarness();
    const store = createTokenStreamStore();
    const intensitySpy = vi.spyOn(store.intensity, 'current');
    const d = createVisualizationDirector({
      ...makeDeps({ tokenStreamStore: store }),
      requestAnimationFrame: harness.raf,
      cancelAnimationFrame: harness.caf,
    });
    d.start();
    // 7 ticks at 16ms each = 112ms. We expect exactly one sample on the first
    // tick (lastIntensityReadAt = 0 => first delta clears 100ms), then a
    // second sample once wall-clock passes the 200ms mark.
    for (let i = 0; i < 7; i++) harness.flush();
    // Either 1 or 2 samples is acceptable depending on rAF timing; three or
    // more would mean the throttle is broken.
    expect(intensitySpy.mock.calls.length).toBeLessThanOrEqual(2);
    expect(intensitySpy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('resize() forwards a new layout to the engine', () => {
    const engine = createStreamRainEngine(makeLayout());
    const resize = vi.spyOn(engine, 'resize');
    const d = createVisualizationDirector(makeDeps({ engine }));
    const newLayout = makeLayout({ cols: 80, rows: 40, viewportWidth: 960, viewportHeight: 480 });
    d.resize(newLayout);
    expect(resize).toHaveBeenCalledWith(newLayout);
  });
});

describe('VisualizationDirector — error isolation', () => {
  it('a throwing scorer does not kill the director', () => {
    const engine = createStreamRainEngine(makeLayout());
    const store = createTokenStreamStore();
    const badScorer = {
      get documentCount() {
        return 0;
      },
      scoreDocument(): never {
        throw new Error('bad scorer');
      },
      tryShow(): boolean {
        return true;
      },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const d = createVisualizationDirector(
      makeDeps({
        engine,
        tokenStreamStore: store,
        // Mis-typed on purpose: WordScorer is structural; this satisfies the
        // required shape for the scorer injection path.
        scorer: badScorer as unknown as ReturnType<typeof import('$lib/word-scorer.js').createWordScorer>,
      }),
    );
    d.start();
    // Publishing a text_delta with enough length triggers scoreDocument.
    store.publish(0, [{ kind: 'text_delta', text: 'x'.repeat(300), timestamp: 0 }]);
    // Director must still report running.
    expect(d.running).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Chunk 9: transition-fx wiring
// ---------------------------------------------------------------------------

describe('VisualizationDirector — transition-fx', () => {
  it('triggers a transition and exposes the active trigger', () => {
    const d = createVisualizationDirector(makeDeps());
    expect(d.getActiveTransition()).toBeNull();
    d.triggerTransition(
      {
        from: 'a',
        to: 'b',
        fromPos: { x: 100, y: 100 },
        toPos: { x: 400, y: 100 },
        handoffLabel: 'hello',
      },
      0,
    );
    expect(d.getActiveTransition()?.from).toBe('a');
  });

  it('advances fx state per tick and returns to idle after the cycle', () => {
    const harness = makeRafHarness();
    const d = createVisualizationDirector({
      ...makeDeps(),
      requestAnimationFrame: harness.raf,
      cancelAnimationFrame: harness.caf,
    });
    d.start();
    d.triggerTransition(
      {
        from: 'a',
        to: 'b',
        fromPos: { x: 0, y: 0 },
        toPos: { x: 120, y: 0 },
        handoffLabel: 'notes',
      },
      0,
    );
    // Each flush advances nowMs by 16. We need ~62 ticks to pass 1000ms.
    for (let i = 0; i < 75; i++) harness.flush();
    expect(d.getTransitionFxFrame()).toBeNull();
    expect(d.getActiveTransition()).toBeNull();
  });

  it('invokes onTransitionFxFrame with live frames during the cycle', () => {
    const harness = makeRafHarness();
    const frames: Array<ReturnType<ReturnType<typeof createVisualizationDirector>['getTransitionFxFrame']>> = [];
    const d = createVisualizationDirector({
      ...makeDeps(),
      requestAnimationFrame: harness.raf,
      cancelAnimationFrame: harness.caf,
      onTransitionFxFrame: (f) => frames.push(f),
    });
    d.start();
    d.triggerTransition(
      {
        from: 'a',
        to: 'b',
        fromPos: { x: 0, y: 0 },
        toPos: { x: 120, y: 0 },
        handoffLabel: 'notes',
      },
      0,
    );
    for (let i = 0; i < 5; i++) harness.flush();
    const nonNull = frames.filter((f) => f !== null);
    expect(nonNull.length).toBeGreaterThan(0);
    expect(nonNull[0]?.fromId).toBe('a');
    expect(nonNull[0]?.toId).toBe('b');
  });

  it('drops a second trigger while the first is still active (warn-once)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const d = createVisualizationDirector(makeDeps());
    d.triggerTransition({ from: 'a', to: 'b', fromPos: { x: 0, y: 0 }, toPos: { x: 100, y: 0 }, handoffLabel: '' }, 0);
    d.triggerTransition({ from: 'x', to: 'y', fromPos: { x: 0, y: 0 }, toPos: { x: 100, y: 0 }, handoffLabel: '' }, 50);
    expect(d.getActiveTransition()?.from).toBe('a');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('includes a transit density source while the payload is traveling', () => {
    const engine = createStreamRainEngine(makeLayout());
    const setField = vi.spyOn(engine, 'setDensityField');
    const d = createVisualizationDirector(makeDeps({ engine }));

    // Seed node positions so the baseline density field is non-empty.
    d.setNodePositions(
      new Map<string, SvgPoint>([
        ['a', { x: 100, y: 100 }],
        ['b', { x: 400, y: 100 }],
      ]),
    );
    const preTriggerCalls = setField.mock.calls.length;

    d.triggerTransition(
      { from: 'a', to: 'b', fromPos: { x: 100, y: 100 }, toPos: { x: 400, y: 100 }, handoffLabel: '' },
      0,
    );
    // triggerTransition should have rebuilt the field at least once more.
    expect(setField.mock.calls.length).toBeGreaterThan(preTriggerCalls);
    // The latest field isn't null — the transit source makes sure the
    // density is non-uniform across the travel axis.
    const lastField = setField.mock.calls[setField.mock.calls.length - 1][0];
    expect(lastField).not.toBeNull();
  });
});

// Minimal check that the director type export is public.
void (null as unknown as StreamRainEngine);
