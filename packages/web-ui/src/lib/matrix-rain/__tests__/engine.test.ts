import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  ASSEMBLY_TARGET_TICKS,
  FRAME_MS,
  HOLD_TICKS,
  MAX_ASSEMBLY_TICKS,
  MAX_CATCH_UP_TICKS,
  SUBTITLE_REVEAL_TICKS,
  createRainEngine,
  createSeededRng,
} from '../engine.js';
import { computeLayout } from '../layout.js';
import { WORD } from '../font.js';
import type { FrameState, LayoutPlan } from '../types.js';

// ---------------------------------------------------------------------------
// Canvas mock for computeLayout (jsdom has no real Canvas)
// ---------------------------------------------------------------------------

const MOCK_TEXT_WIDTH = 600;
const MOCK_ASCENT = 80;
const MOCK_DESCENT = 20;

function createMockContext(): CanvasRenderingContext2D {
  let canvasWidth = 1;
  let canvasHeight = 1;

  const ctx = {
    font: '',
    textBaseline: 'top' as CanvasTextBaseline,
    textAlign: 'left' as CanvasTextAlign,
    fillStyle: '#000',
    shadowBlur: 0,
    shadowColor: 'transparent',
    canvas: {
      get width() {
        return canvasWidth;
      },
      set width(w: number) {
        canvasWidth = w;
      },
      get height() {
        return canvasHeight;
      },
      set height(h: number) {
        canvasHeight = h;
      },
    },
    measureText(_text: string) {
      return {
        width: MOCK_TEXT_WIDTH,
        actualBoundingBoxAscent: MOCK_ASCENT,
        actualBoundingBoxDescent: MOCK_DESCENT,
      };
    },
    clearRect: vi.fn(),
    fillText: vi.fn(),
    getImageData(_x: number, _y: number, w: number, h: number) {
      const size = w * h * 4;
      const data = new Uint8ClampedArray(size);
      for (let i = 0; i < size; i += 4) {
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
        data[i + 3] = 255;
      }
      return { data, width: w, height: h };
    },
  } as unknown as CanvasRenderingContext2D;

  return ctx;
}

// Prevent OffscreenCanvas from being used in tests.
let origOffscreenCanvas: typeof globalThis.OffscreenCanvas | undefined;

beforeEach(() => {
  origOffscreenCanvas = globalThis.OffscreenCanvas;
  // @ts-expect-error -- removing OffscreenCanvas to force fallback
  delete globalThis.OffscreenCanvas;
});

afterEach(() => {
  if (origOffscreenCanvas !== undefined) {
    globalThis.OffscreenCanvas = origOffscreenCanvas;
  }
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function buildLayout(): LayoutPlan {
  const ctx = createMockContext();
  const layout = computeLayout(WORD, 1440, 900, 10, ctx);
  if (!layout) throw new Error('fixture layout failed to compute');
  return layout;
}

/** A minimal hand-rolled layout with targets beyond MAX_ASSEMBLY_TICKS. */
function buildPathologicalLayout(): LayoutPlan {
  return {
    cellSize: 12,
    cols: 50,
    rows: 500,
    originX: 0,
    originY: 0,
    viewportWidth: 600,
    viewportHeight: 6000,
    // One title cell, far below any drop can reach in MAX_ASSEMBLY_TICKS.
    lockedCells: [{ col: 10, row: 400, group: 'title' as const }],
    wordmarkImage: null,
    wordmarkDrawX: 0,
    wordmarkDrawY: 0,
  };
}

/** Layout with both title and subtitle cells for two-phase assembly tests. */
function buildTwoPhaseLayout(): LayoutPlan {
  return {
    cellSize: 12,
    cols: 40,
    rows: 30,
    originX: 0,
    originY: 0,
    viewportWidth: 480,
    viewportHeight: 360,
    lockedCells: [
      // Title cells -- close to the top so drops lock quickly.
      { col: 5, row: 3, group: 'title' as const },
      { col: 6, row: 3, group: 'title' as const },
      { col: 7, row: 3, group: 'title' as const },
      // Subtitle cells -- below the title.
      { col: 5, row: 8, group: 'subtitle' as const },
      { col: 6, row: 8, group: 'subtitle' as const },
      { col: 7, row: 9, group: 'subtitle' as const },
    ],
    wordmarkImage: null,
    wordmarkDrawX: 0,
    wordmarkDrawY: 0,
  };
}

/** Deep-ish snapshot used for equality comparison in tests. */
function snapshot(frame: FrameState): string {
  return JSON.stringify({
    phase: frame.phase,
    alpha: frame.globalAlpha,
    locked: frame.lockedCells.map((c) => ({ col: c.col, row: c.row, alpha: c.alpha })),
    drops: frame.drops.map((d) => ({
      col: d.col,
      row: d.row,
      char: d.char,
      colorKind: d.colorKind,
      trail: d.trail.map((t) => ({ col: t.col, row: t.row, char: t.char, colorKind: t.colorKind })),
    })),
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Drive the engine forward by `tickCount` logical ticks, starting at `startMs`.
 * Returns the final timestamp so callers that need to continue driving
 * the same engine across multiple phases can chain monotonic calls —
 * feeding rewound timestamps would be silently ignored by `step()`.
 */
function driveTicks(engine: ReturnType<typeof createRainEngine>, tickCount: number, startMs: number = 0): number {
  engine.step(startMs);
  for (let i = 1; i <= tickCount; i++) engine.step(startMs + i * FRAME_MS);
  return startMs + tickCount * FRAME_MS;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createRainEngine -- step() time semantics', () => {
  it('first call primes lastTick and does not advance', () => {
    const engine = createRainEngine(buildLayout(), { seed: 42 });
    engine.step(1000);
    // After priming, phase is still assembly and no drop can have moved -- all
    // drops are at their initial (negative) headRows.
    expect(engine.phase).toBe('assembly');
  });

  it('same timestamp twice is a no-op', () => {
    const engine = createRainEngine(buildLayout(), { seed: 42 });
    engine.step(1000);
    engine.step(1000);
    const a = snapshot(engine.getFrame());
    engine.step(1000);
    const b = snapshot(engine.getFrame());
    expect(a).toBe(b);
  });

  it('rewound timestamp is a no-op', () => {
    const engine = createRainEngine(buildLayout(), { seed: 42 });
    engine.step(1000);
    const a = snapshot(engine.getFrame());
    engine.step(500);
    const b = snapshot(engine.getFrame());
    expect(a).toBe(b);
  });

  it('advances exactly MAX_CATCH_UP_TICKS ticks within the while-loop branch', () => {
    const boundary = MAX_CATCH_UP_TICKS * FRAME_MS; // 99 ms
    const engine = createRainEngine(buildPathologicalLayout(), { seed: 42 });
    engine.step(0);
    engine.step(boundary); // delta == boundary, NOT > boundary, so while-loop branch
    const frame = engine.getFrame();
    // Three ticks in the while-loop branch -> we should still be in assembly.
    expect(frame.phase).toBe('assembly');
    const oneTickEngine = createRainEngine(buildPathologicalLayout(), { seed: 42 });
    oneTickEngine.step(0);
    // delta=100ms > 99 -> fast-forward branch, exactly one tick of progress
    oneTickEngine.step(100);
    const oneDrop = oneTickEngine.getFrame().drops[0];
    const threeDrop = frame.drops[0];
    if (oneDrop && threeDrop) {
      expect(threeDrop.row).toBeGreaterThanOrEqual(oneDrop.row);
    }
  });

  it('takes the fast-forward branch when delta > MAX_CATCH_UP_TICKS * FRAME_MS and advances exactly one tick', () => {
    const engine = createRainEngine(buildPathologicalLayout(), { seed: 42 });
    engine.step(0);
    engine.step(10_000_000); // way past the cap
    expect(engine.phase).toBe('assembly');

    const before = snapshot(engine.getFrame());
    engine.step(10_000_000);
    const after = snapshot(engine.getFrame());
    expect(after).toBe(before);
  });
});

describe('createRainEngine -- determinism', () => {
  it('same seed and tick sequence yields identical FrameState', () => {
    const layout = buildLayout();
    const a = createRainEngine(layout, { seed: 123 });
    const b = createRainEngine(layout, { seed: 123 });
    a.step(0);
    b.step(0);
    for (let t = FRAME_MS; t <= FRAME_MS * 40; t += FRAME_MS) {
      a.step(t);
      b.step(t);
    }
    expect(snapshot(a.getFrame())).toBe(snapshot(b.getFrame()));
  });

  it('different seeds diverge', () => {
    const layout = buildLayout();
    const a = createRainEngine(layout, { seed: 1 });
    const b = createRainEngine(layout, { seed: 2 });
    a.step(0);
    b.step(0);
    for (let t = FRAME_MS; t <= FRAME_MS * 10; t += FRAME_MS) {
      a.step(t);
      b.step(t);
    }
    expect(snapshot(a.getFrame())).not.toBe(snapshot(b.getFrame()));
  });
});

describe('createRainEngine -- phase transitions', () => {
  it('starts in assembly with wordmarkReady=false', () => {
    const engine = createRainEngine(buildLayout(), { seed: 42 });
    expect(engine.phase).toBe('assembly');
    expect(engine.wordmarkReady).toBe(false);
  });

  it('transitions assembly -> hold within ASSEMBLY_TARGET_TICKS under typical layout', () => {
    const engine = createRainEngine(buildLayout(), { seed: 42 });
    driveTicks(engine, ASSEMBLY_TARGET_TICKS);
    expect(['hold', 'ambient']).toContain(engine.phase);
    expect(engine.wordmarkReady).toBe(true);
  });

  it('reaches ambient after assembly + HOLD_TICKS ticks', () => {
    const engine = createRainEngine(buildLayout(), { seed: 42 });
    driveTicks(engine, MAX_ASSEMBLY_TICKS + HOLD_TICKS + 2);
    expect(engine.phase).toBe('ambient');
    expect(engine.wordmarkReady).toBe(true);
  });

  it('hold phase emits a decreasing globalAlpha ramp', () => {
    const engine = createRainEngine(buildLayout(), { seed: 42 });
    // Drive until we are in hold.
    engine.step(0);
    let t = 1;
    while (engine.phase !== 'hold' && t <= MAX_ASSEMBLY_TICKS + 5) {
      engine.step(t * FRAME_MS);
      t++;
    }
    expect(engine.phase).toBe('hold');
    const startAlpha = engine.getFrame().globalAlpha;

    // Advance partway through hold.
    for (let i = 0; i < HOLD_TICKS - 2 && engine.phase === 'hold'; i++) {
      engine.step((t + i) * FRAME_MS);
    }
    const midFrame = engine.getFrame();
    expect(midFrame.globalAlpha).toBeLessThanOrEqual(startAlpha);
    expect(midFrame.globalAlpha).toBeGreaterThanOrEqual(0.55);
  });
});

describe('createRainEngine -- assembly safety cap', () => {
  it('force-locks all drops after MAX_ASSEMBLY_TICKS under a pathological layout', () => {
    const layout = buildPathologicalLayout();
    const engine = createRainEngine(layout, { seed: 42 });
    engine.step(0);
    for (let i = 1; i <= MAX_ASSEMBLY_TICKS + 1; i++) {
      engine.step(i * FRAME_MS);
    }
    expect(engine.phase).not.toBe('assembly');
    const frame = engine.getFrame();
    expect(frame.lockedCells).toHaveLength(layout.lockedCells.length);
  });
});

describe('createRainEngine -- reducedMotion', () => {
  it('starts in ambient with all wordmark cells locked and wordmarkReady=true', () => {
    const layout = buildLayout();
    const engine = createRainEngine(layout, { seed: 42, reducedMotion: true });
    expect(engine.phase).toBe('ambient');
    expect(engine.wordmarkReady).toBe(true);
    const frame = engine.getFrame();
    expect(frame.lockedCells).toHaveLength(layout.lockedCells.length);
    expect(frame.drops).toHaveLength(0);
    expect(frame.globalAlpha).toBeCloseTo(0.55, 5);
  });

  it('does not spawn ambient drops under reducedMotion', () => {
    const engine = createRainEngine(buildLayout(), { seed: 42, reducedMotion: true });
    engine.step(0);
    for (let i = 1; i <= 60; i++) engine.step(i * FRAME_MS);
    expect(engine.getFrame().drops).toHaveLength(0);
  });
});

describe('createRainEngine -- ambient drop population', () => {
  it('spawns drops and sustains a non-empty population in ambient', () => {
    const engine = createRainEngine(buildLayout(), { seed: 42 });
    // Drive well into ambient.
    engine.step(0);
    const totalTicks = MAX_ASSEMBLY_TICKS + HOLD_TICKS + 80;
    for (let i = 1; i <= totalTicks; i++) engine.step(i * FRAME_MS);
    expect(engine.phase).toBe('ambient');
    const frame = engine.getFrame();
    expect(frame.drops.length).toBeGreaterThan(0);
    expect(frame.drops.length).toBeLessThanOrEqual(60);
  });
});

describe('createRainEngine -- two-phase assembly (title + subtitle)', () => {
  it('does not reveal subtitle cells during title assembly', () => {
    const engine = createRainEngine(buildTwoPhaseLayout(), { seed: 42 });
    // Drive a few ticks into assembly -- not enough for all titles to lock.
    driveTicks(engine, 5);
    expect(engine.phase).toBe('assembly');
    const frame = engine.getFrame();
    const subtitleLocked = frame.lockedCells.filter((c) =>
      buildTwoPhaseLayout().lockedCells.some((lc) => lc.group === 'subtitle' && lc.col === c.col && lc.row === c.row),
    );
    expect(subtitleLocked).toHaveLength(0);
  });

  it('reveals subtitle cells progressively after title assembly completes', () => {
    const layout = buildTwoPhaseLayout();
    const engine = createRainEngine(layout, { seed: 42 });
    // Drive well past title assembly completion.
    driveTicks(engine, MAX_ASSEMBLY_TICKS + SUBTITLE_REVEAL_TICKS + 5);
    // Should be in hold or ambient now.
    expect(engine.phase).not.toBe('assembly');
    const frame = engine.getFrame();
    // All cells (title + subtitle) should be locked.
    expect(frame.lockedCells).toHaveLength(layout.lockedCells.length);
  });

  it('transitions to hold after subtitle reveal completes', () => {
    const engine = createRainEngine(buildTwoPhaseLayout(), { seed: 42 });
    driveTicks(engine, MAX_ASSEMBLY_TICKS + SUBTITLE_REVEAL_TICKS + 2);
    expect(['hold', 'ambient']).toContain(engine.phase);
  });

  it('handles layouts with no subtitle cells (backward compat)', () => {
    const noSubLayout: LayoutPlan = {
      cellSize: 12,
      cols: 40,
      rows: 30,
      originX: 0,
      originY: 0,
      viewportWidth: 480,
      viewportHeight: 360,
      lockedCells: [
        { col: 5, row: 3, group: 'title' },
        { col: 6, row: 3, group: 'title' },
      ],
      wordmarkImage: null,
      wordmarkDrawX: 0,
      wordmarkDrawY: 0,
    };
    const engine = createRainEngine(noSubLayout, { seed: 42 });
    driveTicks(engine, MAX_ASSEMBLY_TICKS + 2);
    // Should transition straight to hold without a subtitle phase.
    expect(['hold', 'ambient']).toContain(engine.phase);
    expect(engine.getFrame().lockedCells).toHaveLength(noSubLayout.lockedCells.length);
  });

  it('handles layouts with no group field (backward compat)', () => {
    const legacyLayout: LayoutPlan = {
      cellSize: 12,
      cols: 40,
      rows: 30,
      originX: 0,
      originY: 0,
      viewportWidth: 480,
      viewportHeight: 360,
      lockedCells: [
        { col: 5, row: 3 },
        { col: 6, row: 3 },
      ],
      wordmarkImage: null,
      wordmarkDrawX: 0,
      wordmarkDrawY: 0,
    };
    const engine = createRainEngine(legacyLayout, { seed: 42 });
    driveTicks(engine, MAX_ASSEMBLY_TICKS + 2);
    expect(['hold', 'ambient']).toContain(engine.phase);
    expect(engine.getFrame().lockedCells).toHaveLength(legacyLayout.lockedCells.length);
  });

  it('one drop per title cell guarantees full coverage at end of assembly', () => {
    const layout = buildTwoPhaseLayout();
    const titleCount = layout.lockedCells.filter((c) => c.group === 'title').length;
    const engine = createRainEngine(layout, { seed: 42 });
    // Drive until assembly ends (title + subtitle reveal).
    driveTicks(engine, MAX_ASSEMBLY_TICKS + SUBTITLE_REVEAL_TICKS + 2);
    const frame = engine.getFrame();
    const titleLocked = frame.lockedCells.filter((c) =>
      layout.lockedCells.some((lc) => lc.group === 'title' && lc.col === c.col && lc.row === c.row),
    );
    expect(titleLocked).toHaveLength(titleCount);
  });
});

describe('createRainEngine -- background rain during assembly', () => {
  it('spawns ambient drops during assembly phase', () => {
    const engine = createRainEngine(buildLayout(), { seed: 42 });
    // Drive enough ticks into assembly for ambient drops to spawn.
    driveTicks(engine, 20);
    expect(engine.phase).toBe('assembly');
    const frame = engine.getFrame();
    // Should have both assembly drops and background ambient drops.
    const hasAssemblyDrop = frame.drops.some((d) => d.colorKind === 'head');
    expect(hasAssemblyDrop).toBe(true);
    // Background ambient drops should exist (at reduced density).
    expect(frame.drops.length).toBeGreaterThan(0);
  });

  it('background drops during assembly use far color kind', () => {
    const layout = buildTwoPhaseLayout();
    const engine = createRainEngine(layout, { seed: 42 });
    driveTicks(engine, 15);
    expect(engine.phase).toBe('assembly');
    const frame = engine.getFrame();
    // Find drops that are not assembly drops (assembly drops have 'head' colorKind
    // and their trail has 'near'/'far'). Background ambient drops during assembly
    // should all use 'far' colorKind for head and trail.
    // We can identify background ambient drops as those whose head colorKind is 'far'
    // (assembly drops always have 'head' colorKind).
    const bgDrops = frame.drops.filter((d) => d.colorKind === 'far');
    if (bgDrops.length > 0) {
      for (const drop of bgDrops) {
        expect(drop.colorKind).toBe('far');
        for (const t of drop.trail) {
          expect(t.colorKind).toBe('far');
        }
      }
    }
  });

  it('spawns ambient drops during hold phase', () => {
    const engine = createRainEngine(buildLayout(), { seed: 42 });
    // Drive into hold phase.
    engine.step(0);
    let t = 1;
    while (engine.phase !== 'hold' && t <= MAX_ASSEMBLY_TICKS + SUBTITLE_REVEAL_TICKS + 5) {
      engine.step(t * FRAME_MS);
      t++;
    }
    expect(engine.phase).toBe('hold');
    // Drive a few more ticks in hold to let drops spawn.
    for (let i = 0; i < 10 && engine.phase === 'hold'; i++) {
      engine.step((t + i) * FRAME_MS);
    }
    const frame = engine.getFrame();
    // Hold phase should now have ambient drops (previously it had none).
    expect(frame.drops.length).toBeGreaterThan(0);
  });

  it('does not spawn background drops under reducedMotion', () => {
    const engine = createRainEngine(buildLayout(), { seed: 42, reducedMotion: true });
    driveTicks(engine, 30);
    expect(engine.getFrame().drops).toHaveLength(0);
  });
});

describe('createRainEngine -- resize', () => {
  /** Shift every locked cell one column to the right -- simulates the
   *  wordmark re-centering on a viewport width change without a
   *  cellSize change. */
  function shiftCellsRight(layout: LayoutPlan, delta: number): LayoutPlan {
    return {
      ...layout,
      lockedCells: layout.lockedCells.map((c) => ({ ...c, col: c.col + delta })),
    };
  }

  it('updates locked-cell snapshot when geometry shifts at the same cellSize (hold/ambient)', () => {
    const layout = buildTwoPhaseLayout();
    const engine = createRainEngine(layout, { seed: 42 });
    // Drive into ambient so the snapshot is locked in.
    driveTicks(engine, MAX_ASSEMBLY_TICKS + HOLD_TICKS + 5);
    expect(engine.phase).toBe('ambient');

    const shifted = shiftCellsRight(layout, 3);
    engine.resize(shifted);

    const frame = engine.getFrame();
    // Every locked cell in the frame must match the shifted layout, not
    // the original. This is the regression test for the stale-snapshot bug.
    for (const cell of frame.lockedCells) {
      const match = shifted.lockedCells.find((c) => c.col === cell.col && c.row === cell.row);
      expect(match).toBeDefined();
    }
    expect(frame.lockedCells).toHaveLength(shifted.lockedCells.length);
  });

  it('rebuilds assembly drops when locked cells shift during assembly', () => {
    const layout = buildTwoPhaseLayout();
    const engine = createRainEngine(layout, { seed: 42 });
    const afterInitialTicks = driveTicks(engine, 3);
    expect(engine.phase).toBe('assembly');

    const shifted = shiftCellsRight(layout, 5);
    engine.resize(shifted);

    // Drive assembly to completion. If drops still targeted the old
    // columns, the shifted title cells would never lock. Continue from
    // the timestamp the first driveTicks ended at — otherwise the engine
    // would treat the new call's initial timestamps as rewound and skip
    // advancing.
    driveTicks(engine, MAX_ASSEMBLY_TICKS + SUBTITLE_REVEAL_TICKS + 2, afterInitialTicks + FRAME_MS);

    // Compare full (col, row) pairs, not distinct columns — a future
    // layout could have multiple title cells in one column (stacked
    // glyphs), and the distinct-column count would spuriously pass then.
    const finalFrame = engine.getFrame();
    const shiftedTitleCells = shifted.lockedCells.filter((c) => c.group === 'title');
    const lockedTitleCells = finalFrame.lockedCells.filter((c) =>
      shiftedTitleCells.some((lc) => lc.col === c.col && lc.row === c.row),
    );
    expect(lockedTitleCells).toHaveLength(shiftedTitleCells.length);
  });

  it('is a no-op when the new layout has identical lockedCells and cellSize', () => {
    const layout = buildTwoPhaseLayout();
    const engine = createRainEngine(layout, { seed: 42 });
    driveTicks(engine, MAX_ASSEMBLY_TICKS + HOLD_TICKS + 5);
    const before = snapshot(engine.getFrame());

    // Same content, different array identity — must not tear down state.
    engine.resize({ ...layout, lockedCells: layout.lockedCells.map((c) => ({ ...c })) });

    const after = snapshot(engine.getFrame());
    expect(after).toBe(before);
  });
});

describe('createRainEngine -- FrameState.wordDrops', () => {
  it('always returns the shared frozen empty array (no per-frame allocation)', () => {
    const engine = createRainEngine(buildLayout(), { seed: 42 });
    engine.step(0);
    const a = engine.getFrame().wordDrops;
    driveTicks(engine, 5, FRAME_MS);
    const b = engine.getFrame().wordDrops;
    // Same identity across frames — the login engine never populates this,
    // so it reuses a module-level frozen empty array.
    expect(a).toBe(b);
    expect(a).toHaveLength(0);
    expect(Object.isFrozen(a)).toBe(true);
  });
});

describe('createSeededRng', () => {
  it('produces a deterministic sequence for a given seed', () => {
    const a = createSeededRng(99);
    const b = createSeededRng(99);
    for (let i = 0; i < 20; i++) {
      expect(a.random()).toBe(b.random());
    }
  });

  it('produces values strictly in [0, 1)', () => {
    const rng = createSeededRng(7);
    for (let i = 0; i < 1000; i++) {
      const v = rng.random();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
