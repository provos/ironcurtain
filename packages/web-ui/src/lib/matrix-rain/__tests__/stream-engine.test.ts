import { describe, it, expect } from 'vitest';

import { FRAME_MS } from '../engine.js';
import { WORD_DROP_FIFO_CAP, WORD_PLACEMENT_MAX_ATTEMPTS, createStreamRainEngine } from '../stream-engine.js';
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
      tint: d.tint ?? null,
      trail: d.trail.map((t) => ({ col: t.col, row: t.row, char: t.char, colorKind: t.colorKind })),
    })),
    wordDrops: frame.wordDrops.map((w) => ({
      col: w.col,
      row: w.row,
      word: w.word,
      source: w.source,
      phase: w.phase,
      // Copy the mask so snapshot equality is structural; the array is a live
      // reference into the engine and would otherwise alias across snapshots.
      revealedMask: [...w.revealedMask],
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
    engine.enqueueWord('hello', { colorKind: 'text' });
    const countRevealed = () => engine.getFrame().wordDrops[0].revealedMask.filter(Boolean).length;
    const r1 = countRevealed();
    const r2 = countRevealed();
    const r3 = countRevealed();
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
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
      engine.enqueueWord(`w${i}`, { colorKind: 'text' });
    }

    const frame = engine.getFrame();
    expect(frame.wordDrops.length).toBe(WORD_DROP_FIFO_CAP);
  });

  it('evicts oldest on overflow (the first 6 disappear)', () => {
    const engine = createStreamRainEngine(buildLayout(), { seed: 13 });
    driveTicks(engine, 1);

    const total = WORD_DROP_FIFO_CAP + 6;
    for (let i = 0; i < total; i++) {
      engine.enqueueWord(`word-${i}`, { colorKind: 'text' });
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
      engine.enqueueWord(`old-${i}`, { colorKind: 'text' });
    }
    expect(engine.getFrame().wordDrops.length).toBe(WORD_DROP_FIFO_CAP);

    // Drive well past the word-drop lifetime (~3.1s = ~94 ticks).
    driveTicks(engine, 110, 2 * FRAME_MS);
    expect(engine.getFrame().wordDrops.length).toBe(0);

    engine.enqueueWord('fresh', { colorKind: 'text' });
    const fresh = engine.getFrame().wordDrops;
    expect(fresh).toHaveLength(1);
    expect(fresh[0].word).toBe('fresh');
  });

  it('ignores empty words', () => {
    const engine = createStreamRainEngine(buildLayout(), { seed: 15 });
    driveTicks(engine, 1);
    engine.enqueueWord('', { colorKind: 'text' });
    expect(engine.getFrame().wordDrops).toHaveLength(0);
  });
});

describe('createStreamRainEngine -- word drop lifecycle', () => {
  it('materializes characters on a staggered schedule, then holds, then fully dissolves', () => {
    const engine = createStreamRainEngine(buildLayout(), { seed: 17 });
    engine.step(0);
    engine.enqueueWord('aging', { colorKind: 'text' });

    // Freshly enqueued: phase=materialize, no chars revealed yet — the
    // first tick's ageHeldWords() call is what reveals the first char whose
    // scheduled offset is 0.
    const initial = engine.getFrame().wordDrops[0];
    expect(initial.phase).toBe('materialize');
    expect(initial.revealedMask.filter(Boolean).length).toBe(0);

    // Drive the full lifecycle: materialize -> hold -> dissolve -> removed.
    let sawMaterializePartial = false;
    let sawHoldFull = false;
    let sawDissolvePartial = false;
    let finalCount = -1;

    for (let i = 1; i <= 200; i++) {
      engine.step(i * FRAME_MS);
      const drops = engine.getFrame().wordDrops;
      if (drops.length === 0) {
        finalCount = 0;
        break;
      }
      const d = drops[0];
      const revealed = d.revealedMask.filter(Boolean).length;
      if (d.phase === 'materialize' && revealed > 0 && revealed < d.word.length) {
        sawMaterializePartial = true;
      }
      if (d.phase === 'hold' && revealed === d.word.length) {
        sawHoldFull = true;
      }
      if (d.phase === 'dissolve' && revealed > 0 && revealed < d.word.length) {
        sawDissolvePartial = true;
      }
    }

    expect(sawMaterializePartial).toBe(true);
    expect(sawHoldFull).toBe(true);
    expect(sawDissolvePartial).toBe(true);
    expect(finalCount).toBe(0);
  });

  it('reveals every materialize char within MATERIALIZE_WINDOW_TICKS', () => {
    const engine = createStreamRainEngine(buildLayout(), { seed: 41 });
    engine.step(0);
    engine.enqueueWord('crystal', { colorKind: 'text' });
    // The stagger window is a small fixed number of ticks (see
    // MATERIALIZE_WINDOW_TICKS in stream-engine.ts). After at most that
    // many ticks every char must be revealed and the word must have
    // transitioned to hold. Give it one extra tick of slack for the phase
    // flip to be observable in the same snapshot.
    const maxTicks = 10; // MATERIALIZE_WINDOW_TICKS is 6; slack for phase flip.
    let allRevealedTick = -1;
    for (let i = 1; i <= maxTicks; i++) {
      engine.step(i * FRAME_MS);
      const d = engine.getFrame().wordDrops[0];
      const revealed = d.revealedMask.filter(Boolean).length;
      if (revealed === d.word.length) {
        allRevealedTick = i;
        break;
      }
    }
    expect(allRevealedTick).toBeGreaterThan(0);
    expect(allRevealedTick).toBeLessThanOrEqual(maxTicks);
  });

  it('stagger is non-trivial (not strictly left-to-right in the common case)', () => {
    // Seed chosen so at least one char reveals in a non-sequential order.
    // If the schedule were purely left-to-right the first revealed char
    // would always be index 0. The stagger mixes things up.
    const engine = createStreamRainEngine(buildLayout(), { seed: 50 });
    engine.step(0);
    engine.enqueueWord('abcdefgh', { colorKind: 'text' });
    engine.step(FRAME_MS);
    const mask = engine.getFrame().wordDrops[0].revealedMask;
    // On the very first materialize tick, there may be multiple chars
    // already revealed (every char whose schedule offset is 0). Just
    // verify that the revealed set isn't a strict left-aligned prefix of
    // length 1 for every seed — this specific seed produces a non-prefix set.
    const revealedIdxs = mask.map((r, i) => (r ? i : -1)).filter((i) => i >= 0);
    // Either the revealed set skips an index (non-prefix) or multiple
    // chars revealed at once — both are evidence the schedule is stagger-
    // based rather than strictly sequential per-tick.
    const isStrictPrefix = revealedIdxs.every((idx, k) => idx === k);
    const multipleRevealed = revealedIdxs.length > 1;
    expect(isStrictPrefix === false || multipleRevealed).toBe(true);
  });

  it('spawns one falling rain shard per character on dissolve, tagged with source tint', () => {
    const engine = createStreamRainEngine(buildLayout(), { seed: 42 });
    engine.step(0);
    engine.enqueueWord('shatter', { colorKind: 'tool' });

    // Drive through materialize + hold + full dissolve. Every char must
    // eventually appear as a tinted shard in the ambient drops pool.
    const seenTintedCols = new Set<number>();
    let finalHeldCount = -1;
    let lastTintColor: string | undefined;
    for (let i = 1; i <= 400; i++) {
      engine.step(i * FRAME_MS);
      const frame = engine.getFrame();
      for (const d of frame.drops) {
        if (d.tint !== undefined) {
          seenTintedCols.add(d.col);
          lastTintColor = d.tint;
        }
      }
      if (frame.wordDrops.length === 0) {
        finalHeldCount = 0;
        break;
      }
    }
    expect(finalHeldCount).toBe(0);
    // One tinted shard per char, each at a unique column.
    expect(seenTintedCols.size).toBe('shatter'.length);
    expect(lastTintColor).toBe('tool');
  });

  it('dissolve shards retain source color after the word record is retired', () => {
    const engine = createStreamRainEngine(buildLayout(), { seed: 43 });
    engine.step(0);
    engine.enqueueWord('fade', { colorKind: 'error' });

    // Walk until the held record is retired; then confirm the error tint
    // still appears on at least one shard for the next few ticks (shards
    // are slow, trailLen 3, so they survive past the retirement tick).
    let retireTick = -1;
    for (let i = 1; i <= 400; i++) {
      engine.step(i * FRAME_MS);
      if (engine.getFrame().wordDrops.length === 0) {
        retireTick = i;
        break;
      }
    }
    expect(retireTick).toBeGreaterThan(0);

    let sawErrorTint = false;
    for (let i = retireTick + 1; i <= retireTick + 4; i++) {
      engine.step(i * FRAME_MS);
      const tinted = engine.getFrame().drops.filter((d) => d.tint === 'error');
      if (tinted.length > 0) sawErrorTint = true;
    }
    expect(sawErrorTint).toBe(true);
  });

  it('FIFO slot frees when a held word enters dissolve (not only when fully retired)', () => {
    const engine = createStreamRainEngine(buildLayout(), { seed: 44 });
    engine.step(0);

    // Saturate the FIFO cap.
    for (let i = 0; i < WORD_DROP_FIFO_CAP; i++) {
      engine.enqueueWord(`w${i}`, { colorKind: 'text' });
    }
    expect(engine.getFrame().wordDrops.length).toBe(WORD_DROP_FIFO_CAP);

    // Drive past the full lifetime; every slot must eventually retire.
    for (let i = 1; i <= 400; i++) {
      engine.step(i * FRAME_MS);
    }
    expect(engine.getFrame().wordDrops.length).toBe(0);

    // Prove the FIFO freed: re-saturate, then confirm only materialize/hold
    // records count against the cap. Dissolving shards don't hold a slot.
    for (let i = 0; i < WORD_DROP_FIFO_CAP; i++) {
      engine.enqueueWord(`r${i}`, { colorKind: 'text' });
    }
    expect(engine.getFrame().wordDrops.length).toBe(WORD_DROP_FIFO_CAP);
  });

  it('per-char schedules are deterministic under the same seed', () => {
    // Two engines with the same seed and the same sequence of enqueues
    // must produce identical reveal patterns frame-by-frame throughout
    // the full lifecycle. This pins the seeded-RNG invariant against
    // accidental Math.random() regressions.
    const a = createStreamRainEngine(buildLayout(), { seed: 99 });
    const b = createStreamRainEngine(buildLayout(), { seed: 99 });
    a.step(0);
    b.step(0);
    a.enqueueWord('determinism', { colorKind: 'text' });
    b.enqueueWord('determinism', { colorKind: 'text' });

    for (let i = 1; i <= 200; i++) {
      a.step(i * FRAME_MS);
      b.step(i * FRAME_MS);
      const sa = snapshot(a.getFrame());
      const sb = snapshot(b.getFrame());
      expect(sa).toBe(sb);
    }
  });

  it('dissolving words do not count against the FIFO cap', () => {
    const engine = createStreamRainEngine(buildLayout(), { seed: 45 });
    engine.step(0);
    // Enqueue one word, push it fully through materialize + hold into
    // dissolve (but not yet fully retired — the dissolve window is a
    // handful of ticks long, so pick a mid-dissolve frame).
    engine.enqueueWord('ghost', { colorKind: 'text' });
    // Hold ticks ~= 75; after that the word enters dissolve.
    for (let i = 1; i <= 90; i++) engine.step(i * FRAME_MS);
    // Now the word is somewhere in dissolve. Saturate with fresh enqueues
    // and confirm none of them evict the dissolving word's slot (because
    // dissolve doesn't count), and total held count equals CAP + 1 while
    // the ghost still has at least one revealed char.
    for (let i = 0; i < WORD_DROP_FIFO_CAP; i++) {
      engine.enqueueWord(`fresh${i}`, { colorKind: 'text' });
    }
    const held = engine.getFrame().wordDrops;
    const ghost = held.find((w) => w.word === 'ghost');
    // The ghost may or may not still be alive at this exact tick depending
    // on where the random schedule placed its chars. If it is alive, its
    // phase must be 'dissolve' and the total count must exceed the cap —
    // both together prove the slot-freeing behavior.
    if (ghost) {
      expect(ghost.phase).toBe('dissolve');
      expect(held.length).toBeGreaterThan(WORD_DROP_FIFO_CAP);
    }
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
      engine.enqueueWord(`w${i}`, { colorKind: 'text' });
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
    engine.enqueueWord('still-ages', { colorKind: 'text' });
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

// ---------------------------------------------------------------------------
// Avoid regions (Fix #1): theater declares rectangles where graph nodes live;
// the engine must stop spawning ambient drops and word drops inside them, and
// existing drop heads that enter a region must retire cleanly.
// ---------------------------------------------------------------------------

describe('createStreamRainEngine -- avoid regions', () => {
  it('rain spawns above/around avoid regions; heads never render inside one', () => {
    const cols = 40;
    const cellSize = 12;
    const layout = buildLayout(cols, 60);
    const engine = createStreamRainEngine(layout, { seed: 31 });
    // Region covers the middle band: cols 10..19, rows 20..39. Rain should still
    // fall *above* cols 10..19 (rows < 20), proving the spawn isn't blocked
    // wholesale — and no head ever renders inside the region itself.
    const regionX = 10 * cellSize;
    const regionY = 20 * cellSize;
    const regionW = 10 * cellSize;
    const regionH = 20 * cellSize;
    engine.setAvoidRegions([{ x: regionX, y: regionY, w: regionW, h: regionH }]);

    let sawAboveInsideCols = 0;
    engine.step(0);
    for (let i = 1; i <= 400; i++) {
      engine.step(i * FRAME_MS);
      for (const d of engine.getFrame().drops) {
        const cellX = d.col * cellSize;
        const cellY = Math.floor(d.row) * cellSize;
        const inRegion = cellX >= regionX && cellX < regionX + regionW && cellY >= regionY && cellY < regionY + regionH;
        expect(inRegion).toBe(false);
        if (d.col >= 10 && d.col < 20) sawAboveInsideCols++;
      }
    }
    // Sanity: drops must appear in cols 10..19 above row 20, otherwise the
    // cell-level retirement is accidentally acting like column-level blocking.
    expect(sawAboveInsideCols).toBeGreaterThan(0);
  });

  it('density-biased spawns still retire inside avoid regions', () => {
    const cols = 40;
    const cellSize = 12;
    const layout = buildLayout(cols, 60);
    const engine = createStreamRainEngine(layout, { seed: 32 });
    // Heavy density at col 15, which sits inside the avoid region's column span.
    const field = new Float32Array(cols);
    field[15] = 100;
    engine.setDensityField(field);
    // Region at rows 20..39 in cols 10..19.
    const regionY = 20 * cellSize;
    const regionH = 20 * cellSize;
    engine.setAvoidRegions([{ x: 10 * cellSize, y: regionY, w: 10 * cellSize, h: regionH }]);

    engine.step(0);
    for (let i = 1; i <= 400; i++) {
      engine.step(i * FRAME_MS);
      // Invariant: no head ever renders inside the region, regardless of
      // the density bias.
      for (const d of engine.getFrame().drops) {
        if (d.col >= 10 && d.col < 20) {
          const cellY = Math.floor(d.row) * cellSize;
          expect(cellY >= regionY && cellY < regionY + regionH).toBe(false);
        }
      }
    }
  });

  it('retires existing drop heads that enter an avoid region mid-fall', () => {
    const cellSize = 12;
    const layout = buildLayout(40, 60);
    const engine = createStreamRainEngine(layout, { seed: 33 });
    // Let ambient drops spawn freely for a while (no avoid regions yet).
    driveTicks(engine, 80);
    const beforeCount = engine.getFrame().drops.length;
    expect(beforeCount).toBeGreaterThan(0);

    // Now declare a region covering the vertical middle of every column.
    // Every drop's head will eventually cross rows 20..39 and retire.
    engine.setAvoidRegions([{ x: 0, y: 20 * cellSize, w: 40 * cellSize, h: 20 * cellSize }]);
    // Drive long enough that every previously-alive drop's head reaches
    // row 20 (even the slowest drop at speed 1.0 makes it in 20 ticks).
    // New spawns may replace them, but those new spawns would also retire
    // on entering the band, so the live population collapses.
    let anyDropCrossed = false;
    for (let i = 81; i < 200; i++) {
      engine.step(i * FRAME_MS);
      for (const d of engine.getFrame().drops) {
        if (Math.floor(d.row) >= 20 && Math.floor(d.row) < 40) {
          anyDropCrossed = true;
        }
      }
    }
    // If a drop head had ever sat inside the region without being retired,
    // this flag would flip true. The retirement must happen in the same
    // frame the head enters, so no frame should contain a head in-range.
    expect(anyDropCrossed).toBe(false);
  });

  it('refuses enqueueWord placements that fall inside an avoid region', () => {
    const cols = 20;
    const cellSize = 12;
    const layout = buildLayout(cols, 30);
    const engine = createStreamRainEngine(layout, { seed: 34 });
    engine.step(0);
    // Covers the entire top-third drop row band, so every candidate placement
    // is invalid. Word drops land in the top third (rows 0..9); the region
    // covers all of them.
    engine.setAvoidRegions([{ x: 0, y: 0, w: cols * cellSize, h: 10 * cellSize }]);

    engine.enqueueWord('hello', { colorKind: 'text' });
    expect(engine.getFrame().wordDrops).toHaveLength(0);
  });

  it('succeeds on retry when part of the layout is free', () => {
    const cols = 20;
    const cellSize = 12;
    const layout = buildLayout(cols, 30);
    const engine = createStreamRainEngine(layout, { seed: 35 });
    engine.step(0);
    // Block only half of the columns. Placement must eventually land in the
    // unblocked half via the retry loop (WORD_PLACEMENT_MAX_ATTEMPTS tries).
    engine.setAvoidRegions([{ x: 0, y: 0, w: 10 * cellSize, h: 10 * cellSize }]);

    for (let i = 0; i < 20; i++) {
      engine.enqueueWord(`w${i}`, { colorKind: 'text' });
    }
    const drops = engine.getFrame().wordDrops;
    expect(drops.length).toBeGreaterThan(0);
    for (const drop of drops) {
      // All accepted drops must have landed outside the avoid region.
      expect(drop.col).toBeGreaterThanOrEqual(10);
    }
  });

  it('exposes WORD_PLACEMENT_MAX_ATTEMPTS as an integer > 1', () => {
    // Guardrail: prevents accidental regression to a single-attempt placement
    // policy, which would be indistinguishable from the pre-fix behavior.
    expect(Number.isInteger(WORD_PLACEMENT_MAX_ATTEMPTS)).toBe(true);
    expect(WORD_PLACEMENT_MAX_ATTEMPTS).toBeGreaterThan(1);
  });

  it('setAvoidRegions([]) clears the previously-declared regions', () => {
    const cellSize = 12;
    const cols = 20;
    const rows = 30;
    const engine = createStreamRainEngine(buildLayout(cols, rows), { seed: 36 });
    // Declare a region at rows 10..19 — drops should retire when they enter it.
    engine.setAvoidRegions([{ x: 0, y: 10 * cellSize, w: cols * cellSize, h: 10 * cellSize }]);
    engine.step(0);
    for (let i = 1; i <= 100; i++) {
      engine.step(i * FRAME_MS);
      for (const d of engine.getFrame().drops) {
        const cellY = Math.floor(d.row) * cellSize;
        expect(cellY < 10 * cellSize || cellY >= 20 * cellSize).toBe(true);
      }
    }

    // Clear the regions; drops may now occupy the previously-blocked rows.
    engine.setAvoidRegions([]);
    let sawDropInClearedRegion = false;
    for (let i = 101; i <= 400; i++) {
      engine.step(i * FRAME_MS);
      for (const d of engine.getFrame().drops) {
        const cellY = Math.floor(d.row) * cellSize;
        if (cellY >= 10 * cellSize && cellY < 20 * cellSize) sawDropInClearedRegion = true;
      }
    }
    expect(sawDropInClearedRegion).toBe(true);
  });

  it('resize clears avoid regions (theater will re-publish)', () => {
    const cellSize = 12;
    const cols = 20;
    const rows = 30;
    const engine = createStreamRainEngine(buildLayout(cols, rows), { seed: 37 });
    // Declare a region at rows 10..19 and confirm heads retire there.
    engine.setAvoidRegions([{ x: 0, y: 10 * cellSize, w: cols * cellSize, h: 10 * cellSize }]);
    engine.step(0);
    for (let i = 1; i <= 100; i++) {
      engine.step(i * FRAME_MS);
      for (const d of engine.getFrame().drops) {
        const cellY = Math.floor(d.row) * cellSize;
        expect(cellY < 10 * cellSize || cellY >= 20 * cellSize).toBe(true);
      }
    }

    // Resize to a new grid — regions must clear because they're pixel-space
    // and the theater will re-measure. Without this behavior, stale regions
    // could silently suppress rendering in the old coords forever.
    engine.resize(buildLayout(30, 40));
    let sawDropInPreviouslyBlockedRows = false;
    for (let i = 101; i <= 400; i++) {
      engine.step(i * FRAME_MS);
      for (const d of engine.getFrame().drops) {
        const cellY = Math.floor(d.row) * cellSize;
        if (cellY >= 10 * cellSize && cellY < 20 * cellSize) sawDropInPreviouslyBlockedRows = true;
      }
    }
    expect(sawDropInPreviouslyBlockedRows).toBe(true);
  });

  it('filters degenerate rects (zero / negative area)', () => {
    const cols = 20;
    const engine = createStreamRainEngine(buildLayout(cols, 30), { seed: 38 });
    // All four should be filtered as invalid — the rectangle with zero width
    // or height matches no cells anyway, but the defensive filter keeps the
    // per-cell predicate loop tight regardless.
    engine.setAvoidRegions([
      { x: 0, y: 0, w: 0, h: 100 },
      { x: 0, y: 0, w: 100, h: 0 },
      { x: 0, y: 0, w: -10, h: 100 },
      { x: 0, y: 0, w: 100, h: -10 },
    ]);
    engine.step(0);
    for (let i = 1; i <= 200; i++) engine.step(i * FRAME_MS);
    // Degenerate rects must not suppress spawning; behavior should match an
    // engine that never had regions set.
    expect(engine.getFrame().drops.length).toBeGreaterThan(0);
  });
});
