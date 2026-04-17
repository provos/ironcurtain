import { describe, it, expect } from 'vitest';

import { COLOR_FAR, COLOR_HEAD, COLOR_NEAR } from '../palette.js';
import { FONT_SIZE_TUNING, drawFrame, drawRainFrame, drawWordmarkFrame, type DrawOptions } from '../renderer.js';
import type { DropSnapshot, FrameState, LayoutPlan, LockedCellSnapshot } from '../types.js';

// ---------------------------------------------------------------------------
// Mock CanvasRenderingContext2D
// ---------------------------------------------------------------------------

type Call =
  | { kind: 'fillRect'; x: number; y: number; w: number; h: number; fillStyle: string; globalAlpha: number }
  | { kind: 'fillText'; text: string; x: number; y: number; fillStyle: string; globalAlpha: number }
  | {
      kind: 'drawImage';
      sx: number;
      sy: number;
      sw: number;
      sh: number;
      dx: number;
      dy: number;
      dw: number;
      dh: number;
    };

interface StateSet {
  fonts: string[];
  textBaselines: string[];
  textAligns: string[];
  globalAlphas: number[];
  fillStyles: string[];
}

function createMockCtx(): {
  ctx: CanvasRenderingContext2D;
  calls: Call[];
  stateSets: StateSet;
} {
  const calls: Call[] = [];
  const stateSets: StateSet = {
    fonts: [],
    textBaselines: [],
    textAligns: [],
    globalAlphas: [],
    fillStyles: [],
  };

  const state = {
    font: '',
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    textAlign: 'start' as CanvasTextAlign,
    globalAlpha: 1,
    fillStyle: '#000000' as string,
  };

  const ctx = {
    get font() {
      return state.font;
    },
    set font(v: string) {
      state.font = v;
      stateSets.fonts.push(v);
    },
    get textBaseline() {
      return state.textBaseline;
    },
    set textBaseline(v: CanvasTextBaseline) {
      state.textBaseline = v;
      stateSets.textBaselines.push(v);
    },
    get textAlign() {
      return state.textAlign;
    },
    set textAlign(v: CanvasTextAlign) {
      state.textAlign = v;
      stateSets.textAligns.push(v);
    },
    get globalAlpha() {
      return state.globalAlpha;
    },
    set globalAlpha(v: number) {
      state.globalAlpha = v;
      stateSets.globalAlphas.push(v);
    },
    get fillStyle() {
      return state.fillStyle;
    },
    set fillStyle(v: string) {
      state.fillStyle = v;
      stateSets.fillStyles.push(v);
    },
    clearRect(_x: number, _y: number, _w: number, _h: number) {
      // No-op for tracking; drawWordmarkFrame clears to transparent.
    },
    fillRect(x: number, y: number, w: number, h: number) {
      calls.push({
        kind: 'fillRect',
        x,
        y,
        w,
        h,
        fillStyle: state.fillStyle,
        globalAlpha: state.globalAlpha,
      });
    },
    fillText(text: string, x: number, y: number) {
      calls.push({
        kind: 'fillText',
        text,
        x,
        y,
        fillStyle: state.fillStyle,
        globalAlpha: state.globalAlpha,
      });
    },
    drawImage(
      _img: unknown,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
      dx: number,
      dy: number,
      dw: number,
      dh: number,
    ) {
      calls.push({ kind: 'drawImage', sx, sy, sw, sh, dx, dy, dw, dh });
    },
  } as unknown as CanvasRenderingContext2D;

  return { ctx, calls, stateSets };
}

// ---------------------------------------------------------------------------
// Mock wordmark image (a minimal canvas-like object)
// ---------------------------------------------------------------------------

function createMockWordmarkImage(width = 200, height = 50): HTMLCanvasElement {
  return { width, height } as unknown as HTMLCanvasElement;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LAYOUT: LayoutPlan = {
  cellSize: 12,
  cols: 40,
  rows: 30,
  originX: 10,
  originY: 20,
  viewportWidth: 480,
  viewportHeight: 360,
  lockedCells: [],
  wordmarkImage: createMockWordmarkImage(),
  wordmarkDrawX: 100,
  wordmarkDrawY: 140,
};

const OPTIONS: DrawOptions = { fontFamily: '"Fira Code", monospace' };

function makeDrop(col: number, row: number, trailLen: number): DropSnapshot {
  const trail = Array.from({ length: trailLen }, (_, i) => ({
    col,
    row: row - (i + 1),
    char: 'X',
    colorKind: i <= 1 ? ('near' as const) : ('far' as const),
  }));
  return { col, row, char: 'H', colorKind: 'head', trail };
}

function makeLocked(col: number, row: number): LockedCellSnapshot {
  return { col, row, alpha: 1.0 };
}

function makeFrame(overrides: Partial<FrameState> = {}): FrameState {
  return {
    phase: 'ambient',
    globalAlpha: 0.55,
    lockedCells: [],
    drops: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('drawFrame', () => {
  it('exports FONT_SIZE_TUNING = 1.3', () => {
    expect(FONT_SIZE_TUNING).toBe(1.3);
  });

  it('clears canvas first with black fillStyle at full alpha', () => {
    const { ctx, calls } = createMockCtx();
    drawFrame(ctx, makeFrame(), LAYOUT, 480, 360, OPTIONS);

    expect(calls.length).toBeGreaterThan(0);
    const first = calls[0];
    expect(first.kind).toBe('fillRect');
    if (first.kind !== 'fillRect') throw new Error('unreachable');
    expect(first.x).toBe(0);
    expect(first.y).toBe(0);
    expect(first.w).toBe(480);
    expect(first.h).toBe(360);
    expect(first.fillStyle.toLowerCase()).toBe('#000000');
    expect(first.globalAlpha).toBe(1);
  });

  it('sets font, textBaseline, and textAlign exactly once per draw', () => {
    const { ctx, stateSets } = createMockCtx();
    const frame = makeFrame({
      drops: [makeDrop(5, 10, 3)],
      lockedCells: [makeLocked(10, 14)],
    });
    drawFrame(ctx, frame, LAYOUT, 480, 360, OPTIONS);

    expect(stateSets.fonts).toEqual([`${LAYOUT.cellSize * FONT_SIZE_TUNING}px "Fira Code", monospace`]);
    expect(stateSets.textBaselines).toEqual(['top']);
    expect(stateSets.textAligns).toEqual(['center']);
  });

  it('honors fontSizeTuning override', () => {
    const { ctx, stateSets } = createMockCtx();
    drawFrame(ctx, makeFrame(), LAYOUT, 480, 360, { ...OPTIONS, fontSizeTuning: 1.25 });

    expect(stateSets.fonts).toEqual([`${LAYOUT.cellSize * 1.25}px "Fira Code", monospace`]);
  });

  it('applies frame.globalAlpha and resets to 1.0 at end', () => {
    const { ctx, stateSets } = createMockCtx();
    drawFrame(ctx, makeFrame({ globalAlpha: 0.42 }), LAYOUT, 480, 360, OPTIONS);

    expect(stateSets.globalAlphas[0]).toBe(1.0);
    expect(stateSets.globalAlphas).toContain(0.42);
    expect(stateSets.globalAlphas[stateSets.globalAlphas.length - 1]).toBe(1.0);
  });

  it('draws all drop fillText calls before any locked-cell drawImage calls', () => {
    const { ctx, calls } = createMockCtx();
    const frame = makeFrame({
      drops: [makeDrop(3, 8, 2), makeDrop(15, 12, 4)],
      lockedCells: [makeLocked(10, 14), makeLocked(11, 14)],
    });
    drawFrame(ctx, frame, LAYOUT, 480, 360, OPTIONS);

    const lastDropIdx = calls.findLastIndex((c) => c.kind === 'fillText');
    const firstDrawImageIdx = calls.findIndex((c) => c.kind === 'drawImage');

    expect(firstDrawImageIdx).toBeGreaterThan(-1);
    expect(lastDropIdx).toBeGreaterThan(-1);
    expect(lastDropIdx).toBeLessThan(firstDrawImageIdx);
  });

  it('drop fillText count equals sum of drop heads + trail lengths', () => {
    const { ctx, calls } = createMockCtx();
    const drops = [makeDrop(1, 10, 2), makeDrop(5, 20, 4), makeDrop(7, 15, 0)];
    drawFrame(ctx, makeFrame({ drops }), LAYOUT, 480, 360, OPTIONS);

    const expected = drops.reduce((n, d) => n + 1 + d.trail.length, 0);
    const dropCalls = calls.filter((c) => c.kind === 'fillText');
    expect(dropCalls.length).toBe(expected);
  });

  it('locked-cell drawImage count equals frame.lockedCells.length', () => {
    const { ctx, calls } = createMockCtx();
    // Place locked cells within the wordmark image bounds
    const cs = LAYOUT.cellSize;
    const baseCol = Math.ceil(LAYOUT.wordmarkDrawX / cs);
    const baseRow = Math.ceil(LAYOUT.wordmarkDrawY / cs);
    const lockedCells = [
      makeLocked(baseCol, baseRow),
      makeLocked(baseCol + 1, baseRow),
      makeLocked(baseCol + 2, baseRow),
    ];
    drawFrame(ctx, makeFrame({ lockedCells }), LAYOUT, 480, 360, OPTIONS);

    const drawImageCalls = calls.filter((c) => c.kind === 'drawImage');
    expect(drawImageCalls.length).toBe(lockedCells.length);
  });

  it('drawImage uses cell-sized source and dest rectangles', () => {
    const { ctx, calls } = createMockCtx();
    const cs = LAYOUT.cellSize;
    const col = Math.ceil(LAYOUT.wordmarkDrawX / cs) + 1;
    const row = Math.ceil(LAYOUT.wordmarkDrawY / cs) + 1;
    drawFrame(ctx, makeFrame({ lockedCells: [makeLocked(col, row)] }), LAYOUT, 480, 360, OPTIONS);

    const drawImageCall = calls.find((c) => c.kind === 'drawImage');
    expect(drawImageCall).toBeDefined();
    if (drawImageCall?.kind === 'drawImage') {
      // Source and dest should both be cellSize x cellSize
      expect(drawImageCall.sw).toBe(cs);
      expect(drawImageCall.sh).toBe(cs);
      expect(drawImageCall.dw).toBe(cs);
      expect(drawImageCall.dh).toBe(cs);
      // Dest position should be col * cellSize, row * cellSize
      expect(drawImageCall.dx).toBe(col * cs);
      expect(drawImageCall.dy).toBe(row * cs);
      // Source position should be offset from wordmarkDrawX/Y
      expect(drawImageCall.sx).toBe(col * cs - LAYOUT.wordmarkDrawX);
      expect(drawImageCall.sy).toBe(row * cs - LAYOUT.wordmarkDrawY);
    }
  });

  it('uses COLOR_HEAD for drop head', () => {
    const { ctx, calls, stateSets } = createMockCtx();
    const frame = makeFrame({ drops: [makeDrop(5, 10, 3)] });
    drawFrame(ctx, frame, LAYOUT, 480, 360, OPTIONS);

    const headCall = calls.find((c) => c.kind === 'fillText' && c.text === 'H');
    expect(headCall).toBeDefined();
    if (headCall?.kind === 'fillText') {
      expect(headCall.fillStyle).toBe(COLOR_HEAD);
    }
    expect(stateSets.fillStyles).toContain(COLOR_HEAD);
  });

  it('uses COLOR_NEAR and COLOR_FAR for trail cells matching colorKind', () => {
    const { ctx, calls } = createMockCtx();
    const frame = makeFrame({ drops: [makeDrop(5, 10, 4)] });
    drawFrame(ctx, frame, LAYOUT, 480, 360, OPTIONS);

    const trailCalls = calls.filter(
      (c): c is Extract<Call, { kind: 'fillText' }> => c.kind === 'fillText' && c.text === 'X',
    );
    expect(trailCalls.length).toBe(4);
    const fillStyles = new Set(trailCalls.map((c) => c.fillStyle));
    expect(fillStyles.has(COLOR_NEAR)).toBe(true);
    expect(fillStyles.has(COLOR_FAR)).toBe(true);
  });

  it('empty frame still clears and sets font state with no extra calls', () => {
    const { ctx, calls, stateSets } = createMockCtx();
    drawFrame(ctx, makeFrame(), LAYOUT, 480, 360, OPTIONS);

    const fillRects = calls.filter((c) => c.kind === 'fillRect');
    const fillTexts = calls.filter((c) => c.kind === 'fillText');
    const drawImages = calls.filter((c) => c.kind === 'drawImage');

    expect(fillRects.length).toBe(1);
    expect(fillTexts.length).toBe(0);
    expect(drawImages.length).toBe(0);
    expect(stateSets.fonts.length).toBe(1);
    expect(stateSets.textBaselines).toEqual(['top']);
    expect(stateSets.textAligns).toEqual(['center']);
    expect(stateSets.globalAlphas[0]).toBe(1.0);
    expect(stateSets.globalAlphas[stateSets.globalAlphas.length - 1]).toBe(1.0);
  });

  it('places drop head at expected logical pixel coordinates', () => {
    const { ctx, calls } = createMockCtx();
    const frame = makeFrame({ drops: [makeDrop(3, 7, 0)] });
    drawFrame(ctx, frame, LAYOUT, 480, 360, OPTIONS);

    const head = calls.find((c) => c.kind === 'fillText' && c.text === 'H');
    expect(head).toBeDefined();
    if (head?.kind === 'fillText') {
      const expectedX = 3 * LAYOUT.cellSize + LAYOUT.cellSize / 2;
      const expectedY = 7 * LAYOUT.cellSize;
      expect(head.x).toBe(expectedX);
      expect(head.y).toBe(expectedY);
    }
  });

  it('skips locked cells when wordmarkImage is null', () => {
    const { ctx, calls } = createMockCtx();
    const layoutNoImage: LayoutPlan = { ...LAYOUT, wordmarkImage: null };
    const frame = makeFrame({ lockedCells: [makeLocked(10, 14)] });
    drawFrame(ctx, frame, layoutNoImage, 480, 360, OPTIONS);

    const drawImages = calls.filter((c) => c.kind === 'drawImage');
    expect(drawImages.length).toBe(0);
  });

  it('skips locked cells outside wordmark image bounds', () => {
    const { ctx, calls } = createMockCtx();
    // Place a locked cell at (0, 0) which is far outside the wordmark image
    // (wordmarkDrawX=100, wordmarkDrawY=140 means srcX would be negative)
    const frame = makeFrame({ lockedCells: [makeLocked(0, 0)] });
    drawFrame(ctx, frame, LAYOUT, 480, 360, OPTIONS);

    const drawImages = calls.filter((c) => c.kind === 'drawImage');
    expect(drawImages.length).toBe(0);
  });
});

describe('drawRainFrame', () => {
  it('clears to opaque black and draws drops but no locked cells', () => {
    const { ctx, calls } = createMockCtx();
    const cs = LAYOUT.cellSize;
    const baseCol = Math.ceil(LAYOUT.wordmarkDrawX / cs) + 1;
    const baseRow = Math.ceil(LAYOUT.wordmarkDrawY / cs) + 1;
    const frame = makeFrame({
      drops: [makeDrop(5, 10, 2)],
      lockedCells: [makeLocked(baseCol, baseRow)],
    });
    drawRainFrame(ctx, frame, LAYOUT, 480, 360, OPTIONS);

    // Should clear with black.
    const first = calls[0];
    expect(first.kind).toBe('fillRect');
    if (first.kind === 'fillRect') {
      expect(first.fillStyle.toLowerCase()).toBe('#000000');
    }

    // Should draw drop fillText calls.
    const fillTexts = calls.filter((c) => c.kind === 'fillText');
    expect(fillTexts.length).toBeGreaterThan(0);

    // Should NOT draw any locked cells (no drawImage calls).
    const drawImages = calls.filter((c) => c.kind === 'drawImage');
    expect(drawImages.length).toBe(0);
  });
});

describe('drawWordmarkFrame', () => {
  it('clears to transparent and draws locked cells but no drops', () => {
    const { ctx, calls } = createMockCtx();
    const cs = LAYOUT.cellSize;
    const baseCol = Math.ceil(LAYOUT.wordmarkDrawX / cs) + 1;
    const baseRow = Math.ceil(LAYOUT.wordmarkDrawY / cs) + 1;
    const frame = makeFrame({
      drops: [makeDrop(5, 10, 2)],
      lockedCells: [makeLocked(baseCol, baseRow)],
    });
    drawWordmarkFrame(ctx, frame, LAYOUT, 480, 360);

    // Should NOT have fillRect (rain canvas does that, not wordmark).
    const fillRects = calls.filter((c) => c.kind === 'fillRect');
    expect(fillRects.length).toBe(0);

    // Should NOT draw any drops (no fillText calls).
    const fillTexts = calls.filter((c) => c.kind === 'fillText');
    expect(fillTexts.length).toBe(0);

    // Should draw locked cells via drawImage.
    const drawImages = calls.filter((c) => c.kind === 'drawImage');
    expect(drawImages.length).toBe(1);
  });
});
