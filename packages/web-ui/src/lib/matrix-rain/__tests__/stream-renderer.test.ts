import { describe, it, expect } from 'vitest';

import { drawStreamFrame } from '../stream-renderer.js';
import type { DrawOptions } from '../renderer.js';
import type { FrameState, LayoutPlan } from '../types.js';
import type { WordDropSnapshot } from '../word-drop-types.js';

type Call =
  | { kind: 'fillRect'; x: number; y: number; w: number; h: number }
  | { kind: 'fillText'; text: string; x: number; y: number; fillStyle: string; globalAlpha: number };

function createMockCtx(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
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
    },
    get textBaseline() {
      return state.textBaseline;
    },
    set textBaseline(v: CanvasTextBaseline) {
      state.textBaseline = v;
    },
    get textAlign() {
      return state.textAlign;
    },
    set textAlign(v: CanvasTextAlign) {
      state.textAlign = v;
    },
    get globalAlpha() {
      return state.globalAlpha;
    },
    set globalAlpha(v: number) {
      state.globalAlpha = v;
    },
    get fillStyle() {
      return state.fillStyle;
    },
    set fillStyle(v: string) {
      state.fillStyle = v;
    },
    clearRect() {},
    fillRect(x: number, y: number, w: number, h: number) {
      calls.push({ kind: 'fillRect', x, y, w, h });
    },
    fillText(text: string, x: number, y: number) {
      calls.push({ kind: 'fillText', text, x, y, fillStyle: state.fillStyle, globalAlpha: state.globalAlpha });
    },
    drawImage() {},
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const LAYOUT: LayoutPlan = {
  cellSize: 12,
  cols: 40,
  rows: 30,
  originX: 10,
  originY: 20,
  viewportWidth: 480,
  viewportHeight: 360,
  lockedCells: [],
  wordmarkImage: null,
  wordmarkDrawX: 100,
  wordmarkDrawY: 140,
};

const OPTIONS: DrawOptions = { fontFamily: '"Fira Code", monospace' };

function wordDrop(partial: Partial<WordDropSnapshot>): WordDropSnapshot {
  const word = partial.word ?? 'x';
  // Default to fully-revealed so `phase: 'hold'` drops draw the whole word —
  // individual tests that want a partial reveal pass `revealedMask` explicitly.
  const defaults: WordDropSnapshot = {
    col: 0,
    row: 0,
    word,
    source: 'text',
    phase: 'hold',
    revealedMask: new Array<boolean>(word.length).fill(true),
  };
  return { ...defaults, ...partial };
}

/** Build a boolean mask from a string like "TTT..F" where T=true, F=false, .=false. */
function maskFromPattern(pattern: string): boolean[] {
  return pattern.split('').map((c) => c === 'T' || c === 't');
}

function makeFrame(wordDrops: WordDropSnapshot[]): FrameState {
  return {
    phase: 'ambient',
    globalAlpha: 1.0,
    lockedCells: [],
    drops: [],
    wordDrops,
  };
}

describe('drawStreamFrame', () => {
  it('clears the canvas (via drawRainFrame) even with no drops or words', () => {
    const { ctx, calls } = createMockCtx();
    drawStreamFrame(ctx, makeFrame([]), LAYOUT, 480, 360, OPTIONS);
    const fillRects = calls.filter((c) => c.kind === 'fillRect');
    expect(fillRects).toHaveLength(1);
    // No word fillText calls either.
    const fillTexts = calls.filter((c) => c.kind === 'fillText');
    expect(fillTexts).toHaveLength(0);
  });

  it('draws one fillText per revealed char at layout-anchored coordinates', () => {
    const { ctx, calls } = createMockCtx();
    const drops = [
      wordDrop({ col: 3, row: 4, word: 'alpha', source: 'text', phase: 'hold' }),
      wordDrop({ col: 7, row: 2, word: 'beta', source: 'tool', phase: 'hold' }),
    ];
    drawStreamFrame(ctx, makeFrame(drops), LAYOUT, 480, 360, OPTIONS);
    const texts = calls.filter((c): c is Extract<Call, { kind: 'fillText' }> => c.kind === 'fillText');
    // Each revealed char becomes its own fillText so mid-word gaps render
    // correctly during dissolve. "alpha" + "beta" = 9 chars total.
    expect(texts).toHaveLength(9);

    // First char of "alpha" anchors at (col * cellSize + originX, row * cellSize + originY).
    const aFirst = texts.find((t) => t.text === 'a' && t.x === 3 * LAYOUT.cellSize + LAYOUT.originX);
    expect(aFirst).toBeDefined();
    if (aFirst) {
      expect(aFirst.y).toBe(4 * LAYOUT.cellSize + LAYOUT.originY);
      expect(aFirst.globalAlpha).toBe(1);
    }

    // Second char of "alpha" is at +1 cellSize horizontally.
    const aSecond = texts.find((t) => t.text === 'l' && t.x === 3 * LAYOUT.cellSize + LAYOUT.originX + LAYOUT.cellSize);
    expect(aSecond).toBeDefined();
  });

  it('draws only the revealed positions during materialize', () => {
    const { ctx, calls } = createMockCtx();
    const drops = [
      wordDrop({
        col: 0,
        row: 0,
        word: 'crystal',
        phase: 'materialize',
        revealedMask: maskFromPattern('TTT....'),
      }),
    ];
    drawStreamFrame(ctx, makeFrame(drops), LAYOUT, 480, 360, OPTIONS);
    const texts = calls.filter((c): c is Extract<Call, { kind: 'fillText' }> => c.kind === 'fillText');
    expect(texts).toHaveLength(3);
    expect(texts.map((t) => t.text).sort()).toEqual(['c', 'r', 'y']);
  });

  it('preserves original column offsets when middle chars are not revealed (e.g. during dissolve)', () => {
    // "shatter" with only indices 0, 3, 6 revealed — the middle-char gap is
    // what separates the new mask-based draw from the old slice-based one.
    const { ctx, calls } = createMockCtx();
    const drops = [
      wordDrop({
        col: 5,
        row: 3,
        word: 'shatter',
        phase: 'dissolve',
        revealedMask: maskFromPattern('T..T..T'),
      }),
    ];
    drawStreamFrame(ctx, makeFrame(drops), LAYOUT, 480, 360, OPTIONS);
    const texts = calls.filter((c): c is Extract<Call, { kind: 'fillText' }> => c.kind === 'fillText');
    expect(texts).toHaveLength(3);
    // Each char sits at col + original-index * cellSize — not packed tight.
    const byChar = Object.fromEntries(texts.map((t) => [t.text, t.x]));
    expect(byChar.s).toBe(5 * LAYOUT.cellSize + LAYOUT.originX);
    expect(byChar.t).toBe(5 * LAYOUT.cellSize + LAYOUT.originX + 3 * LAYOUT.cellSize);
    expect(byChar.r).toBe(5 * LAYOUT.cellSize + LAYOUT.originX + 6 * LAYOUT.cellSize);
  });

  it('skips materializing drops with an all-false mask', () => {
    const { ctx, calls } = createMockCtx();
    const drops = [
      wordDrop({
        word: 'pending',
        phase: 'materialize',
        revealedMask: maskFromPattern('.......'),
      }),
    ];
    drawStreamFrame(ctx, makeFrame(drops), LAYOUT, 480, 360, OPTIONS);
    const texts = calls.filter((c): c is Extract<Call, { kind: 'fillText' }> => c.kind === 'fillText');
    expect(texts).toHaveLength(0);
  });

  it('tints by source kind', () => {
    const { ctx, calls } = createMockCtx();
    const drops = [
      wordDrop({ col: 1, row: 1, word: 'T', source: 'text' }),
      wordDrop({ col: 2, row: 2, word: 'O', source: 'tool' }),
      wordDrop({ col: 3, row: 3, word: 'M', source: 'model' }),
      wordDrop({ col: 4, row: 4, word: 'E', source: 'error' }),
    ];
    drawStreamFrame(ctx, makeFrame(drops), LAYOUT, 480, 360, OPTIONS);
    const texts = calls.filter((c): c is Extract<Call, { kind: 'fillText' }> => c.kind === 'fillText');
    const styles = new Set(texts.map((t) => t.fillStyle));
    // Four distinct colors.
    expect(styles.size).toBe(4);
  });

  it('uses per-source hex colors matching the palette spec (§E)', () => {
    const { ctx, calls } = createMockCtx();
    const drops = [
      wordDrop({ col: 0, row: 0, word: 'a', source: 'text' }),
      wordDrop({ col: 1, row: 0, word: 'b', source: 'tool' }),
      wordDrop({ col: 2, row: 0, word: 'c', source: 'model' }),
      wordDrop({ col: 3, row: 0, word: 'd', source: 'error' }),
    ];
    drawStreamFrame(ctx, makeFrame(drops), LAYOUT, 480, 360, OPTIONS);
    const texts = calls.filter((c): c is Extract<Call, { kind: 'fillText' }> => c.kind === 'fillText');
    const byText = (t: string) => texts.find((c) => c.text === t)!.fillStyle;
    // The palette is documented in stream-renderer.ts — these assertions pin
    // the mapping so a regression (e.g., tool green-washed) would trip here.
    expect(byText('a')).toBe('#00FF46');
    expect(byText('b')).toBe('#00E5FF');
    expect(byText('c')).toBe('#FFB84D');
    expect(byText('d')).toBe('#FF4D4D');
  });

  it('paints tinted drops (dissolve shards) with the word-drop palette instead of green', () => {
    const { ctx, calls } = createMockCtx();
    // A single tinted drop simulating a dissolve shard from a `tool` word drop.
    const frame: FrameState = {
      phase: 'ambient',
      globalAlpha: 1,
      lockedCells: [],
      drops: [
        {
          col: 5,
          row: 6,
          char: 'x',
          colorKind: 'head',
          trail: [],
          tint: 'tool',
        },
      ],
      wordDrops: [],
    };
    drawStreamFrame(ctx, frame, LAYOUT, 480, 360, OPTIONS);
    const texts = calls.filter((c): c is Extract<Call, { kind: 'fillText' }> => c.kind === 'fillText');
    expect(texts).toHaveLength(1);
    // Tool cyan — not the ambient COLOR_HEAD green (#B4FFB4).
    expect(texts[0].fillStyle).toBe('#00E5FF');
  });
});
