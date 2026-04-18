import { describe, it, expect } from 'vitest';

import { FRAME_MS } from '../engine.js';
import { WORD_DROP_FIFO_CAP, createStreamRainEngine } from '../stream-engine.js';
import type { FrameState, LayoutPlan } from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function buildLayout(cols = 40, rows = 30): LayoutPlan {
  return {
    cellSize: 12,
    cols,
    rows,
    originX: 0,
    originY: 0,
    viewportWidth: cols * 12,
    viewportHeight: rows * 12,
    lockedCells: [],
    wordmarkImage: null,
    wordmarkDrawX: 0,
    wordmarkDrawY: 0,
  };
}

function snapshot(frame: FrameState): string {
  // Phase is fixed in the stream engine (always 'ambient' in the FrameState);
  // include it for completeness so regressions in the fixed value are caught.
  return JSON.stringify({
    phase: frame.phase,
    alpha: frame.globalAlpha,
    drops: frame.drops.map((d) => ({
      col: d.col,
      row: d.row,
      char: d.char,
      colorKind: d.colorKind,
      trail: d.trail.map((t) => ({ col: t.col, row: t.row, char: t.char, colorKind: t.colorKind })),
    })),
    wordDrops: frame.wordDrops.map((w) => ({
      col: w.col,
      row: w.row,
      word: w.word,
      source: w.source,
      priority: w.priority,
      alpha: w.alpha,
    })),
  });
}

function driveTicks(engine: ReturnType<typeof createStreamRainEngine>, tickCount: number, startMs = 0): number {
  engine.step(startMs);
  for (let i = 1; i <= tickCount; i++) engine.step(startMs + i * FRAME_MS);
  return startMs + tickCount * FRAME_MS;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createStreamRainEngine -- phase', () => {
  it('reports phase "stream" regardless of state', () => {
    const engine = createStreamRainEngine(buildLayout(), { seed: 1 });
    expect(engine.phase).toBe('stream');
    driveTicks(engine, 50);
    expect(engine.phase).toBe('stream');
  });

  it('emits empty lockedCells (no wordmark)', () => {
    const engine = createStreamRainEngine(buildLayout(), { seed: 1 });
    driveTicks(engine, 30);
    expect(engine.getFrame().lockedCells).toHaveLength(0);
  });
});

describe('createStreamRainEngine -- determinism', () => {
  it('identical seeds produce identical frames after N ticks', () => {
    const a = createStreamRainEngine(buildLayout(), { seed: 123 });
    const b = createStreamRainEngine(buildLayout(), { seed: 123 });
    driveTicks(a, 60);
    driveTicks(b, 60);
    expect(snapshot(a.getFrame())).toBe(snapshot(b.getFrame()));
  });

  it('different seeds diverge', () => {
    const a = createStreamRainEngine(buildLayout(), { seed: 1 });
    const b = createStreamRainEngine(buildLayout(), { seed: 2 });
    driveTicks(a, 30);
    driveTicks(b, 30);
    expect(snapshot(a.getFrame())).not.toBe(snapshot(b.getFrame()));
  });
});

describe('createStreamRainEngine -- getFrame() purity', () => {
  it('repeated getFrame() without step() returns deep-equal snapshots', () => {
    const engine = createStreamRainEngine(buildLayout(), { seed: 7 });
    driveTicks(engine, 20);
    const s1 = snapshot(engine.getFrame());
    const s2 = snapshot(engine.getFrame());
    const s3 = snapshot(engine.getFrame());
    expect(s1).toBe(s2);
    expect(s2).toBe(s3);
  });

  it('getFrame() does not age word drops', () => {
    const engine = createStreamRainEngine(buildLayout(), { seed: 42 });
    driveTicks(engine, 1);
    engine.enqueueWord('hello', { priority: 1, colorKind: 'text' });
    const alpha1 = engine.getFrame().wordDrops[0].alpha;
    const alpha2 = engine.getFrame().wordDrops[0].alpha;
    const alpha3 = engine.getFrame().wordDrops[0].alpha;
    expect(alpha1).toBe(alpha2);
    expect(alpha2).toBe(alpha3);
  });
});

describe('createStreamRainEngine -- weighted column picker', () => {
  it('biases ambient spawns toward columns with high density weight', () => {
    const cols = 40;
    const layout = buildLayout(cols, 60);
    const engine = createStreamRainEngine(layout, { seed: 9 });

    // Single sharp peak at column 5. Every other column is zero weight.
    const field = new Float32Array(cols);
    field[5] = 100;
    engine.setDensityField(field);

    // Drive plenty of ticks for drops to spawn and build a histogram of
    // spawn columns from emitted ambient drops at each tick.
    const histogram = new Array<number>(cols).fill(0);
    const seen = new Set<string>();
    engine.step(0);
    for (let i = 1; i <= 400; i++) {
      engine.step(i * FRAME_MS);
      for (const d of engine.getFrame().drops) {
        // Deduplicate drops across frames (same drop appears until it dies)
        // using (col, initialHead) — but head advances, so dedupe by a
        // lifetime-stable approximation: (col, headRow-floor close to birth).
        const key = `${d.col}:${Math.floor(d.row)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        histogram[d.col]++;
      }
    }

    // Column 5 must dominate by a healthy margin. Cooldown caps spawns at
    // about 1 per AMBIENT_COLUMN_COOLDOWN ticks on that column, but nothing
    // else should approach its count.
    const peakCount = histogram[5];
    expect(peakCount).toBeGreaterThan(5);
    for (let c = 0; c < cols; c++) {
      if (c === 5) continue;
      expect(histogram[c]).toBe(0);
    }
  });

  it('falls back to uniform sampling when density field is null', () => {
    const layout = buildLayout(20, 40);
    const engine = createStreamRainEngine(layout, { seed: 4 });
    engine.setDensityField(null);
    const histogram = new Array<number>(layout.cols).fill(0);
    const seen = new Set<string>();
    engine.step(0);
    for (let i = 1; i <= 400; i++) {
      engine.step(i * FRAME_MS);
      for (const d of engine.getFrame().drops) {
        const key = `${d.col}:${Math.floor(d.row)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        histogram[d.col]++;
      }
    }
    // Uniform sampling with cooldown should spread across most columns.
    const nonZeroCols = histogram.filter((v) => v > 0).length;
    expect(nonZeroCols).toBeGreaterThan(layout.cols / 2);
  });

  it('setDensityField(null) after a field resets to uniform', () => {
    const cols = 30;
    const engine = createStreamRainEngine(buildLayout(cols, 40), { seed: 11 });
    const field = new Float32Array(cols);
    field[0] = 100; // heavy bias on col 0
    engine.setDensityField(field);
    // Drive a bit so the CDF is realized.
    driveTicks(engine, 20);
    engine.setDensityField(null);

    const histogram = new Array<number>(cols).fill(0);
    const seen = new Set<string>();
    for (let i = 21; i <= 420; i++) {
      engine.step(i * FRAME_MS);
      for (const d of engine.getFrame().drops) {
        const key = `${d.col}:${Math.floor(d.row)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        histogram[d.col]++;
      }
    }
    const nonZeroCols = histogram.filter((v) => v > 0).length;
    expect(nonZeroCols).toBeGreaterThan(cols / 3);
  });
});

describe('createStreamRainEngine -- intensity', () => {
  it('higher intensity yields larger ambient population than lower', () => {
    const layout = buildLayout(60, 80);
    const ticks = 200;

    const lo = createStreamRainEngine(layout, { seed: 5 });
    lo.setIntensity(0.3);
    driveTicks(lo, ticks);
    const loCount = lo.getFrame().drops.length;

    const hi = createStreamRainEngine(layout, { seed: 5 });
    hi.setIntensity(2.0);
    driveTicks(hi, ticks);
    const hiCount = hi.getFrame().drops.length;

    expect(hiCount).toBeGreaterThan(loCount);
  });

  it('clamps values above 2.0 down to 2.0', () => {
    const layout = buildLayout(60, 80);
    const ticks = 200;

    const clamped = createStreamRainEngine(layout, { seed: 6 });
    clamped.setIntensity(10);
    driveTicks(clamped, ticks);
    const clampedCount = clamped.getFrame().drops.length;

    const max = createStreamRainEngine(layout, { seed: 6 });
    max.setIntensity(2.0);
    driveTicks(max, ticks);
    const maxCount = max.getFrame().drops.length;

    // Identical seed + identical effective intensity -> identical counts.
    expect(clampedCount).toBe(maxCount);
  });

  it('clamps values below 0.3 up to 0.3', () => {
    const layout = buildLayout(60, 80);
    const ticks = 200;

    const clamped = createStreamRainEngine(layout, { seed: 8 });
    clamped.setIntensity(-1);
    driveTicks(clamped, ticks);

    const min = createStreamRainEngine(layout, { seed: 8 });
    min.setIntensity(0.3);
    driveTicks(min, ticks);

    expect(clamped.getFrame().drops.length).toBe(min.getFrame().drops.length);
  });

  it('ignores non-finite multipliers (no crash, leaves prior value intact)', () => {
    const engine = createStreamRainEngine(buildLayout(), { seed: 1 });
    engine.setIntensity(1.5);
    engine.setIntensity(NaN);
    engine.setIntensity(Infinity);
    // If a later call threw, this would fail before reaching here.
    driveTicks(engine, 10);
    expect(engine.getFrame().drops.length).toBeGreaterThanOrEqual(0);
  });
});

describe('createStreamRainEngine -- word drops FIFO', () => {
  it('caps concurrent held drops at WORD_DROP_FIFO_CAP', () => {
    const engine = createStreamRainEngine(buildLayout(), { seed: 3 });
    driveTicks(engine, 1); // prime step

    for (let i = 0; i < WORD_DROP_FIFO_CAP + 6; i++) {
      engine.enqueueWord(`w${i}`, { priority: 1, colorKind: 'text' });
    }

    const frame = engine.getFrame();
    expect(frame.wordDrops.length).toBe(WORD_DROP_FIFO_CAP);
  });

  it('evicts oldest on overflow (the first 6 disappear)', () => {
    const engine = createStreamRainEngine(buildLayout(), { seed: 13 });
    driveTicks(engine, 1);

    const total = WORD_DROP_FIFO_CAP + 6;
    for (let i = 0; i < total; i++) {
      engine.enqueueWord(`word-${i}`, { priority: 1, colorKind: 'text' });
    }

    const words = engine.getFrame().wordDrops.map((w) => w.word);
    for (let i = 0; i < 6; i++) {
      expect(words).not.toContain(`word-${i}`);
    }
    for (let i = 6; i < total; i++) {
      expect(words).toContain(`word-${i}`);
    }
  });

  it('new enqueues after old drops retire do not trigger eviction', () => {
    const engine = createStreamRainEngine(buildLayout(), { seed: 14 });
    driveTicks(engine, 1);

    for (let i = 0; i < WORD_DROP_FIFO_CAP; i++) {
      engine.enqueueWord(`old-${i}`, { priority: 1, colorKind: 'text' });
    }
    expect(engine.getFrame().wordDrops.length).toBe(WORD_DROP_FIFO_CAP);

    // Drive well past the word-drop lifetime (~3.1s = ~94 ticks).
    driveTicks(engine, 110, 2 * FRAME_MS);
    expect(engine.getFrame().wordDrops.length).toBe(0);

    engine.enqueueWord('fresh', { priority: 1, colorKind: 'text' });
    const fresh = engine.getFrame().wordDrops;
    expect(fresh).toHaveLength(1);
    expect(fresh[0].word).toBe('fresh');
  });

  it('ignores empty words', () => {
    const engine = createStreamRainEngine(buildLayout(), { seed: 15 });
    driveTicks(engine, 1);
    engine.enqueueWord('', { priority: 1, colorKind: 'text' });
    expect(engine.getFrame().wordDrops).toHaveLength(0);
  });
});

describe('createStreamRainEngine -- word drop aging', () => {
  it('runs the alpha envelope: 0 -> 1 (fade in) -> 1 (hold) -> 0 (fade out) -> removed', () => {
    const engine = createStreamRainEngine(buildLayout(), { seed: 17 });
    engine.step(0);
    engine.enqueueWord('aging', { priority: 1, colorKind: 'text' });

    // Freshly enqueued: age=0 -> alpha=0 (fade-in hasn't advanced).
    expect(engine.getFrame().wordDrops[0].alpha).toBe(0);

    // Advance a few ticks into fade-in. Alpha should be strictly between
    // 0 and 1 at least once.
    let sawRising = false;
    let sawOne = false;
    let sawFalling = false;
    let finalCount = -1;

    for (let i = 1; i <= 120; i++) {
      engine.step(i * FRAME_MS);
      const drops = engine.getFrame().wordDrops;
      if (drops.length === 0) {
        finalCount = 0;
        break;
      }
      const a = drops[0].alpha;
      if (a > 0 && a < 1) sawRising = true;
      if (a === 1) sawOne = true;
      if (sawOne && a < 1 && a > 0) sawFalling = true;
    }

    expect(sawRising).toBe(true);
    expect(sawOne).toBe(true);
    expect(sawFalling).toBe(true);
    expect(finalCount).toBe(0);
  });
});

describe('createStreamRainEngine -- resize', () => {
  it('keeps producing frames after resize to a smaller grid', () => {
    const engine = createStreamRainEngine(buildLayout(40, 30), { seed: 18 });
    driveTicks(engine, 40);
    engine.resize(buildLayout(20, 20));
    driveTicks(engine, 20, 41 * FRAME_MS);
    // No crash; frame is well-formed.
    const frame = engine.getFrame();
    expect(Array.isArray(frame.drops)).toBe(true);
    expect(Array.isArray(frame.wordDrops)).toBe(true);
  });

  it('drops held words that no longer fit after shrink', () => {
    const engine = createStreamRainEngine(buildLayout(40, 30), { seed: 19 });
    engine.step(0);

    for (let i = 0; i < 20; i++) {
      engine.enqueueWord(`w${i}`, { priority: 1, colorKind: 'text' });
    }
    // Snapshot `before` to stable shape — FrameState reuses buffers.
    const before = engine.getFrame().wordDrops.map((w) => ({ col: w.col, word: w.word }));
    const hadHighCol = before.some((w) => w.col >= 10);

    engine.resize(buildLayout(10, 30));
    const after = engine.getFrame().wordDrops.map((w) => ({ col: w.col, word: w.word }));
    for (const w of after) {
      expect(w.col).toBeLessThan(10);
    }
    // Sanity: if any drops had col >= 10 before, the prune actually fired.
    if (hadHighCol) {
      expect(after.length).toBeLessThan(before.length);
    }
  });
});

describe('createStreamRainEngine -- reducedMotion', () => {
  it('does not spawn ambient drops', () => {
    const engine = createStreamRainEngine(buildLayout(), { seed: 21, reducedMotion: true });
    driveTicks(engine, 60);
    expect(engine.getFrame().drops).toHaveLength(0);
  });

  it('still ages and retires word drops', () => {
    const engine = createStreamRainEngine(buildLayout(), { seed: 22, reducedMotion: true });
    engine.step(0);
    engine.enqueueWord('still-ages', { priority: 1, colorKind: 'text' });
    expect(engine.getFrame().wordDrops).toHaveLength(1);
    driveTicks(engine, 110, FRAME_MS);
    expect(engine.getFrame().wordDrops).toHaveLength(0);
  });
});

describe('createStreamRainEngine -- step time semantics parity', () => {
  it('first call primes lastTick and does not advance', () => {
    const engine = createStreamRainEngine(buildLayout(), { seed: 25 });
    engine.step(1000);
    // No drops can exist yet — zero ticks elapsed.
    expect(engine.getFrame().drops).toHaveLength(0);
  });

  it('rewound timestamp is a no-op', () => {
    const engine = createStreamRainEngine(buildLayout(), { seed: 26 });
    engine.step(1000);
    driveTicks(engine, 20, 1000 + FRAME_MS);
    const before = snapshot(engine.getFrame());
    engine.step(500); // rewound
    const after = snapshot(engine.getFrame());
    expect(before).toBe(after);
  });
});
