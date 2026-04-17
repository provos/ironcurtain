/**
 * Layout computation for the Matrix rain wordmark.
 *
 * Given a word and viewport dimensions, `computeLayout()` renders the word
 * (and optional subtitle) with a real font (Orbitron) onto an offscreen canvas,
 * samples the pixel data, and quantizes it to a cell grid. The result is a
 * `LayoutPlan` with responsive sizing that adapts to any viewport.
 *
 * The offscreen canvas approach replaces the old hardcoded pixel font,
 * producing smooth, scalable wordmark outlines at any resolution.
 */

import { SUBTITLE, WORDMARK_FONT_FAMILY, WORDMARK_FONT_WEIGHT } from './font.js';
import type { LayoutPlan, LockedCellCoord } from './types.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Minimum allowed cell size in CSS pixels. */
export const MIN_CELL_SIZE = 5;

/** Maximum cell size in CSS pixels. */
export const MAX_CELL_SIZE = 14;

/** Default preferred cell size when the caller does not pin one. */
export const DEFAULT_CELL_SIZE = 10;

/** Minimum font size in CSS pixels. Below this the wordmark is unreadable. */
const MIN_FONT_SIZE = 24;

/** Maximum font size in CSS pixels. Caps ultra-wide monitors. */
const MAX_FONT_SIZE = 160;

/** Alpha threshold for pixel sampling. Pixels with alpha above this are "filled". */
const ALPHA_THRESHOLD = 128;

/** Minimum viewport dimension to attempt layout (px). */
const MIN_VIEWPORT_DIM = 200;

/** Subtitle font size relative to the main wordmark font size. */
const SUBTITLE_SIZE_RATIO = 0.35;

/** Gap between the title baseline and subtitle top, as a fraction of fontSize. */
const SUBTITLE_GAP_RATIO = 0.4;

/** Subtitle fill color. */
const SUBTITLE_CORE_COLOR = '#009900';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute a `LayoutPlan` for the given word and viewport.
 *
 * Renders the word with Orbitron (or fallback) onto an offscreen canvas,
 * samples the resulting pixels, and maps them to a cell grid.
 *
 * @param word The word to assemble (e.g. `IronCurtain`).
 * @param viewportW Viewport width in CSS pixels.
 * @param viewportH Viewport height in CSS pixels.
 * @param cellSize Preferred cell size in CSS pixels.
 * @param ctx Optional pre-created canvas context (for testing).
 * @returns A `LayoutPlan` or `null` if the viewport is too small.
 */
export function computeLayout(
  word: string,
  viewportW: number,
  viewportH: number,
  cellSize: number = DEFAULT_CELL_SIZE,
  ctx?: CanvasRenderingContext2D,
): LayoutPlan | null {
  if (viewportW < MIN_VIEWPORT_DIM || viewportH < MIN_VIEWPORT_DIM || word.length === 0) {
    return null;
  }

  const chosenCellSize = clampCellSize(cellSize, viewportW);
  const fontSize = computeFontSize(viewportW, viewportH);

  const cols = Math.max(1, Math.floor(viewportW / chosenCellSize));
  const rows = Math.max(1, Math.floor(viewportH / chosenCellSize));

  const context = ctx ?? createOffscreenContext();
  if (!context) return null;

  const result = sampleWordmarkCells(context, word, fontSize, viewportW, viewportH, chosenCellSize, cols, rows);

  if (result.lockedCells.length === 0) return null;

  // Compute bounding box for origin.
  let minCol = Infinity;
  let minRow = Infinity;
  for (const c of result.lockedCells) {
    if (c.col < minCol) minCol = c.col;
    if (c.row < minRow) minRow = c.row;
  }

  return {
    cellSize: chosenCellSize,
    cols,
    rows,
    originX: minCol * chosenCellSize,
    originY: minRow * chosenCellSize,
    viewportWidth: viewportW,
    viewportHeight: viewportH,
    lockedCells: result.lockedCells,
    wordmarkImage: result.wordmarkCanvas,
    wordmarkDrawX: result.drawX,
    wordmarkDrawY: result.drawY,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Clamp cell size to valid range, adapting to viewport width. */
function clampCellSize(preferred: number, viewportW: number): number {
  // Derive a responsive cell size: larger viewports get larger cells.
  const responsive = Math.max(MIN_CELL_SIZE, Math.min(MAX_CELL_SIZE, Math.floor(viewportW / 120)));
  const clamped = Math.max(MIN_CELL_SIZE, Math.min(MAX_CELL_SIZE, Math.floor(preferred)));
  return Math.min(clamped, responsive);
}

/** Compute a responsive font size based on viewport dimensions. */
function computeFontSize(viewportW: number, viewportH: number): number {
  // Scale with viewport, capped at both ends.
  const widthBased = viewportW * 0.08;
  const heightBased = viewportH * 0.15;
  return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.floor(Math.min(widthBased, heightBased))));
}

/** Create an offscreen 2D rendering context for text measurement and sampling. */
function createOffscreenContext(): CanvasRenderingContext2D | null {
  // Prefer OffscreenCanvas when available (web workers, modern browsers).
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const canvas = new OffscreenCanvas(1, 1);
      return canvas.getContext('2d') as CanvasRenderingContext2D | null;
    } catch {
      // Fall through to DOM canvas.
    }
  }

  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    return canvas.getContext('2d');
  }

  return null;
}

interface SampleResult {
  lockedCells: LockedCellCoord[];
  wordmarkCanvas: HTMLCanvasElement | OffscreenCanvas | null;
  drawX: number;
  drawY: number;
}

/** Measure a text string and return width, ascent, and descent. */
function measureTextMetrics(
  ctx: CanvasRenderingContext2D,
  text: string,
  fontSize: number,
): { width: number; ascent: number; descent: number } {
  const metrics = ctx.measureText(text);
  const width = Math.ceil(metrics.width);
  const ascent = Math.ceil(metrics.actualBoundingBoxAscent ?? fontSize * 0.8);
  const descent = Math.ceil(metrics.actualBoundingBoxDescent ?? fontSize * 0.2);
  return { width, ascent, descent };
}

/**
 * Render the word and subtitle onto an offscreen canvas and sample pixels
 * into grid cells, tagging each cell with its group ('title' or 'subtitle').
 */
function sampleWordmarkCells(
  ctx: CanvasRenderingContext2D,
  word: string,
  fontSize: number,
  viewportW: number,
  viewportH: number,
  cellSize: number,
  cols: number,
  rows: number,
): SampleResult {
  // --- Measure title ---
  const titleFontSpec = `${WORDMARK_FONT_WEIGHT} ${fontSize}px ${WORDMARK_FONT_FAMILY}`;
  ctx.font = titleFontSpec;
  const title = measureTextMetrics(ctx, word, fontSize);
  if (title.width <= 0 || title.ascent + title.descent <= 0) {
    return { lockedCells: [], wordmarkCanvas: null, drawX: 0, drawY: 0 };
  }

  // --- Measure subtitle ---
  const subtitleFontSize = Math.max(12, Math.round(fontSize * SUBTITLE_SIZE_RATIO));
  const subtitleFontSpec = `${WORDMARK_FONT_WEIGHT} ${subtitleFontSize}px ${WORDMARK_FONT_FAMILY}`;
  ctx.font = subtitleFontSpec;
  const sub = measureTextMetrics(ctx, SUBTITLE, subtitleFontSize);

  // --- Canvas sizing: accommodate both title and subtitle ---
  const titleHeight = title.ascent + title.descent;
  const gap = Math.round(fontSize * SUBTITLE_GAP_RATIO);
  const subtitleHeight = sub.ascent + sub.descent;
  const totalWidth = Math.max(title.width, sub.width);
  const totalHeight = titleHeight + gap + subtitleHeight;

  const padding = Math.ceil(fontSize * 0.1);
  const canvasW = totalWidth + padding * 2;
  const canvasH = totalHeight + padding * 2;
  resizeCanvas(ctx, canvasW, canvasH);

  // --- Draw title (two-pass fill for visual depth, no shadow) ---
  ctx.font = titleFontSpec;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.clearRect(0, 0, canvasW, canvasH);

  const titleX = padding + Math.floor((totalWidth - title.width) / 2);
  const titleY = padding;

  ctx.fillStyle = '#00E800';
  ctx.fillText(word, titleX, titleY);

  // --- Draw subtitle (two-pass fill, no shadow) ---
  const subtitleX = padding + Math.floor((totalWidth - sub.width) / 2);
  const subtitleY = padding + titleHeight + gap;

  ctx.font = subtitleFontSpec;
  ctx.fillStyle = SUBTITLE_CORE_COLOR;
  ctx.fillText(SUBTITLE, subtitleX, subtitleY);

  // --- Sample pixels ---
  const imageData = ctx.getImageData(0, 0, canvasW, canvasH);
  const pixels = imageData.data;

  // Center horizontally; position at ~30% from top so the wordmark
  // sits above the login card (which is vertically centered).
  const offsetX = Math.floor((viewportW - totalWidth) / 2);
  const offsetY = Math.floor(viewportH * 0.3 - totalHeight / 2);

  const drawX = offsetX - padding;
  const drawY = offsetY - padding;

  // The boundary between title and subtitle in canvas-local Y coordinates.
  // Cells above this row threshold belong to 'title', at or below to 'subtitle'.
  const subtitleBoundaryCanvasY = padding + titleHeight + gap / 2;

  const seen = new Uint8Array(cols * rows);
  const cells: LockedCellCoord[] = [];

  for (let py = 0; py < canvasH; py++) {
    for (let px = 0; px < canvasW; px++) {
      const idx = (py * canvasW + px) * 4;
      const alpha = pixels[idx + 3];
      if (alpha <= ALPHA_THRESHOLD) continue;

      const vpX = px - padding + offsetX;
      const vpY = py - padding + offsetY;
      const col = Math.floor(vpX / cellSize);
      const row = Math.floor(vpY / cellSize);

      if (col < 0 || col >= cols || row < 0 || row >= rows) continue;

      const seenIdx = row * cols + col;
      if (seen[seenIdx]) continue;
      seen[seenIdx] = 1;

      const group: 'title' | 'subtitle' = py < subtitleBoundaryCanvasY ? 'title' : 'subtitle';
      cells.push({ col, row, group });
    }
  }

  const wordmarkCanvas = ctx.canvas;
  return { lockedCells: cells, wordmarkCanvas, drawX, drawY };
}

/** Resize a canvas context's backing canvas to the given dimensions. */
function resizeCanvas(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const canvas = ctx.canvas;
  if ('width' in canvas) {
    (canvas as HTMLCanvasElement).width = width;
    (canvas as HTMLCanvasElement).height = height;
  }
}
