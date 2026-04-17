import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { computeLayout, DEFAULT_CELL_SIZE, MAX_CELL_SIZE, MIN_CELL_SIZE } from '../layout.js';
import { WORD } from '../font.js';

// ---------------------------------------------------------------------------
// Canvas mock -- jsdom has no real Canvas so we mock the 2D context.
// The mock renders text as a predictable filled rectangle so layout tests
// can verify grid math without relying on real font rendering.
// ---------------------------------------------------------------------------

/** Width in "pixels" the mock reports for measureText. */
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

    // getImageData returns a filled rectangle covering the text area.
    // Every pixel in the canvas has alpha=255, simulating a solid text block.
    getImageData(_x: number, _y: number, w: number, h: number) {
      const size = w * h * 4;
      const data = new Uint8ClampedArray(size);
      // Fill all pixels with white + full alpha to simulate text.
      for (let i = 0; i < size; i += 4) {
        data[i] = 255; // R
        data[i + 1] = 255; // G
        data[i + 2] = 255; // B
        data[i + 3] = 255; // A
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
// Tests
// ---------------------------------------------------------------------------

describe('computeLayout', () => {
  it('produces a valid layout for a typical desktop viewport', () => {
    const ctx = createMockContext();
    const layout = computeLayout(WORD, 1440, 900, 10, ctx);
    expect(layout).not.toBeNull();
    if (!layout) return;

    expect(layout.cellSize).toBeGreaterThanOrEqual(MIN_CELL_SIZE);
    expect(layout.cellSize).toBeLessThanOrEqual(MAX_CELL_SIZE);
    expect(layout.cols).toBe(Math.floor(1440 / layout.cellSize));
    expect(layout.rows).toBe(Math.floor(900 / layout.cellSize));
    expect(layout.viewportWidth).toBe(1440);
    expect(layout.viewportHeight).toBe(900);

    expect(layout.lockedCells.length).toBeGreaterThan(0);
    // All locked cells must be inside the grid.
    for (const cell of layout.lockedCells) {
      expect(cell.col).toBeGreaterThanOrEqual(0);
      expect(cell.row).toBeGreaterThanOrEqual(0);
      expect(cell.col).toBeLessThan(layout.cols);
      expect(cell.row).toBeLessThan(layout.rows);
    }
  });

  it('returns null for a tiny viewport', () => {
    const ctx = createMockContext();
    expect(computeLayout(WORD, 100, 100, DEFAULT_CELL_SIZE, ctx)).toBeNull();
  });

  it('returns null for non-positive viewport dimensions', () => {
    const ctx = createMockContext();
    expect(computeLayout(WORD, 0, 900, DEFAULT_CELL_SIZE, ctx)).toBeNull();
    expect(computeLayout(WORD, 1440, 0, DEFAULT_CELL_SIZE, ctx)).toBeNull();
    expect(computeLayout(WORD, -1, 900, DEFAULT_CELL_SIZE, ctx)).toBeNull();
  });

  it('returns null for an empty word', () => {
    const ctx = createMockContext();
    expect(computeLayout('', 1440, 900, DEFAULT_CELL_SIZE, ctx)).toBeNull();
  });

  it('clamps cellSize at MAX_CELL_SIZE even when preferred is larger', () => {
    const ctx = createMockContext();
    const layout = computeLayout(WORD, 4000, 2000, 50, ctx);
    expect(layout).not.toBeNull();
    if (!layout) return;
    expect(layout.cellSize).toBeLessThanOrEqual(MAX_CELL_SIZE);
  });

  it('produces fewer cells on smaller viewports (responsive)', () => {
    const ctx = createMockContext();
    const large = computeLayout(WORD, 1920, 1080, 10, ctx);
    const small = computeLayout(WORD, 800, 600, 10, ctx);
    expect(large).not.toBeNull();
    expect(small).not.toBeNull();
    if (!large || !small) return;
    // Smaller viewport should have fewer columns and rows.
    expect(small.cols).toBeLessThan(large.cols);
    expect(small.rows).toBeLessThan(large.rows);
  });

  it('centers the wordmark roughly in the viewport', () => {
    const ctx = createMockContext();
    const layout = computeLayout(WORD, 1440, 900, 10, ctx);
    expect(layout).not.toBeNull();
    if (!layout) return;

    const minCol = Math.min(...layout.lockedCells.map((c) => c.col));
    const maxCol = Math.max(...layout.lockedCells.map((c) => c.col));
    const minRow = Math.min(...layout.lockedCells.map((c) => c.row));
    const maxRow = Math.max(...layout.lockedCells.map((c) => c.row));

    const wordmarkCenterCol = (minCol + maxCol) / 2;
    const wordmarkCenterRow = (minRow + maxRow) / 2;
    const gridCenterCol = layout.cols / 2;

    // Horizontally centered (generous tolerance for mock's full rectangle).
    expect(Math.abs(wordmarkCenterCol - gridCenterCol)).toBeLessThan(layout.cols * 0.1);
    // Vertically positioned at ~30% from top (above the login card).
    const expectedRow = layout.rows * 0.3;
    expect(Math.abs(wordmarkCenterRow - expectedRow)).toBeLessThan(layout.rows * 0.15);
  });

  it('accepts the optional ctx parameter for testability', () => {
    const ctx = createMockContext();
    const layout = computeLayout(WORD, 1440, 900, 10, ctx);
    expect(layout).not.toBeNull();
    // The mock context should have been used (fillText called).
    expect(ctx.fillText).toHaveBeenCalled();
  });

  it('uses responsive cell size based on viewport width', () => {
    const ctx = createMockContext();
    // Very wide viewport -- should get larger cell size.
    const wide = computeLayout(WORD, 2400, 1200, 14, ctx);
    // Narrow viewport -- should get smaller cell size.
    const narrow = computeLayout(WORD, 600, 800, 14, ctx);

    expect(wide).not.toBeNull();
    expect(narrow).not.toBeNull();
    if (!wide || !narrow) return;

    expect(narrow.cellSize).toBeLessThanOrEqual(wide.cellSize);
  });

  it('tags locked cells with title and subtitle groups', () => {
    const ctx = createMockContext();
    const layout = computeLayout(WORD, 1440, 900, 10, ctx);
    expect(layout).not.toBeNull();
    if (!layout) return;

    const titleCells = layout.lockedCells.filter((c) => c.group === 'title');
    const subtitleCells = layout.lockedCells.filter((c) => c.group === 'subtitle');

    // Both groups should be non-empty since the mock fills all pixels.
    expect(titleCells.length).toBeGreaterThan(0);
    expect(subtitleCells.length).toBeGreaterThan(0);
    // Every cell should have a group.
    expect(titleCells.length + subtitleCells.length).toBe(layout.lockedCells.length);
  });

  it('subtitle cells are below title cells', () => {
    const ctx = createMockContext();
    const layout = computeLayout(WORD, 1440, 900, 10, ctx);
    expect(layout).not.toBeNull();
    if (!layout) return;

    const titleRows = layout.lockedCells.filter((c) => c.group === 'title').map((c) => c.row);
    const subtitleRows = layout.lockedCells.filter((c) => c.group === 'subtitle').map((c) => c.row);

    if (titleRows.length > 0 && subtitleRows.length > 0) {
      const maxTitleRow = Math.max(...titleRows);
      const minSubtitleRow = Math.min(...subtitleRows);
      expect(minSubtitleRow).toBeGreaterThanOrEqual(maxTitleRow);
    }
  });
});
