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
  return {
    col: 0,
    row: 0,
    word: 'x',
    source: 'text',
    priority: 1,
    alpha: 1,
    ...partial,
  };
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

  it('draws each wordDrop as one fillText at layout-anchored coordinates', () => {
    const { ctx, calls } = createMockCtx();
    const drops = [
      wordDrop({ col: 3, row: 4, word: 'alpha', source: 'text', alpha: 1 }),
      wordDrop({ col: 7, row: 2, word: 'beta', source: 'tool', alpha: 0.5 }),
    ];
    drawStreamFrame(ctx, makeFrame(drops), LAYOUT, 480, 360, OPTIONS);
    const texts = calls.filter((c): c is Extract<Call, { kind: 'fillText' }> => c.kind === 'fillText');
    expect(texts).toHaveLength(2);

    const a = texts.find((t) => t.text === 'alpha');
    expect(a).toBeDefined();
    if (a) {
      expect(a.x).toBe(3 * LAYOUT.cellSize + LAYOUT.originX);
      expect(a.y).toBe(4 * LAYOUT.cellSize + LAYOUT.originY);
      expect(a.globalAlpha).toBe(1);
    }
    const b = texts.find((t) => t.text === 'beta');
    expect(b).toBeDefined();
    if (b) {
      expect(b.globalAlpha).toBe(0.5);
    }
  });

  it('skips drops with alpha <= 0', () => {
    const { ctx, calls } = createMockCtx();
    const drops = [
      wordDrop({ word: 'visible', alpha: 1 }),
      wordDrop({ word: 'hidden', alpha: 0 }),
      wordDrop({ word: 'negative', alpha: -0.5 }),
    ];
    drawStreamFrame(ctx, makeFrame(drops), LAYOUT, 480, 360, OPTIONS);
    const texts = calls.filter((c): c is Extract<Call, { kind: 'fillText' }> => c.kind === 'fillText');
    expect(texts).toHaveLength(1);
    expect(texts[0].text).toBe('visible');
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
});
