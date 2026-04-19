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
  const defaults: WordDropSnapshot = {
    col: 0,
    row: 0,
    word: 'x',
    source: 'text',
    priority: 1,
    phase: 'hold',
    revealedChars: partial.word?.length ?? 1,
  };
  return { ...defaults, ...partial };
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

  it('draws each fully-held wordDrop as one fillText at layout-anchored coordinates', () => {
    const { ctx, calls } = createMockCtx();
    const drops = [
      wordDrop({ col: 3, row: 4, word: 'alpha', source: 'text', phase: 'hold', revealedChars: 5 }),
      wordDrop({ col: 7, row: 2, word: 'beta', source: 'tool', phase: 'hold', revealedChars: 4 }),
    ];
    drawStreamFrame(ctx, makeFrame(drops), LAYOUT, 480, 360, OPTIONS);
    const texts = calls.filter((c): c is Extract<Call, { kind: 'fillText' }> => c.kind === 'fillText');
    expect(texts).toHaveLength(2);

    const a = texts.find((t) => t.text === 'alpha');
    expect(a).toBeDefined();
    if (a) {
      expect(a.x).toBe(3 * LAYOUT.cellSize + LAYOUT.originX);
      expect(a.y).toBe(4 * LAYOUT.cellSize + LAYOUT.originY);
      // Hold phase always renders at full opacity — the fade-in envelope is
      // replaced by per-char materialization.
      expect(a.globalAlpha).toBe(1);
    }
    const b = texts.find((t) => t.text === 'beta');
    expect(b).toBeDefined();
    if (b) {
      expect(b.globalAlpha).toBe(1);
    }
  });

  it('draws only the revealed prefix during materialize', () => {
    const { ctx, calls } = createMockCtx();
    const drops = [wordDrop({ col: 0, row: 0, word: 'crystal', phase: 'materialize', revealedChars: 3 })];
    drawStreamFrame(ctx, makeFrame(drops), LAYOUT, 480, 360, OPTIONS);
    const texts = calls.filter((c): c is Extract<Call, { kind: 'fillText' }> => c.kind === 'fillText');
    // Only one fillText call (one word per drop), with the partial prefix.
    expect(texts).toHaveLength(1);
    expect(texts[0].text).toBe('cry');
  });

  it('skips materializing drops that have not revealed any characters yet', () => {
    const { ctx, calls } = createMockCtx();
    const drops = [wordDrop({ word: 'pending', phase: 'materialize', revealedChars: 0 })];
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
