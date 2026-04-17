/**
 * Pure Canvas renderer for the Matrix rain.
 *
 * Stateless: every call re-establishes all Canvas context state it relies on
 * (font, textBaseline, textAlign, globalAlpha, fillStyle). The caller is
 * responsible for applying the DPR transform to `ctx` before calling --
 * all functions work exclusively in logical (CSS pixel) coordinates.
 *
 * The two-canvas architecture separates rain drops (opaque black background)
 * from the wordmark (transparent background). The Svelte wrapper applies a
 * CSS `drop-shadow` filter to the wordmark canvas for smooth GPU-accelerated
 * glow, avoiding the grid-edge artifacts of per-cell `shadowBlur`.
 */

import { COLOR_FAR, COLOR_HEAD, COLOR_NEAR } from './palette.js';
import type { DropColorKind, DropSnapshot, FrameState, LayoutPlan } from './types.js';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/**
 * Default font-size multiplier relative to `cellSize`. The renderer uses
 * `cellSize * fontSizeTuning` as the font size in px for rain drop characters.
 */
export const FONT_SIZE_TUNING = 1.3;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DrawOptions {
  /** CSS font-family string, e.g. `'"Fira Code", monospace'`. */
  readonly fontFamily: string;
  /** Font size multiplier relative to `layout.cellSize`. Defaults to `FONT_SIZE_TUNING`. */
  readonly fontSizeTuning?: number;
}

/**
 * Draw rain drops only (for the rain canvas). Clears to opaque black.
 */
export function drawRainFrame(
  ctx: CanvasRenderingContext2D,
  frame: FrameState,
  layout: LayoutPlan,
  viewportWidth: number,
  viewportHeight: number,
  options: DrawOptions,
): void {
  const tuning = options.fontSizeTuning ?? FONT_SIZE_TUNING;
  const fontSize = layout.cellSize * tuning;

  ctx.globalAlpha = 1.0;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, viewportWidth, viewportHeight);

  // Only set ctx.font when the value actually changes -- the assignment
  // triggers CSS font parsing which is expensive.
  const fontStr = `${fontSize}px ${options.fontFamily}`;
  if (ctx.font !== fontStr) {
    ctx.font = fontStr;
  }
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';

  ctx.globalAlpha = frame.globalAlpha;

  for (const drop of frame.drops) {
    drawDrop(ctx, drop, layout);
  }

  ctx.globalAlpha = 1.0;
}

/**
 * Draw revealed wordmark cells only (for the wordmark canvas).
 * Clears to transparent so CSS `drop-shadow` works correctly.
 */
export function drawWordmarkFrame(
  ctx: CanvasRenderingContext2D,
  frame: FrameState,
  layout: LayoutPlan,
  viewportWidth: number,
  viewportHeight: number,
): void {
  // Transparent clear -- critical for CSS drop-shadow to work.
  ctx.globalAlpha = 1.0;
  ctx.clearRect(0, 0, viewportWidth, viewportHeight);

  ctx.globalAlpha = frame.globalAlpha;

  if (frame.lockedCells.length > 0) {
    drawLockedCells(ctx, frame, layout);
  }

  ctx.globalAlpha = 1.0;
}

/**
 * Paint a single frame onto a single canvas (backward-compat wrapper).
 *
 * Draws rain drops over a black background, then overlays locked wordmark
 * cells. Used by tests and as a single-canvas fallback.
 */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  frame: FrameState,
  layout: LayoutPlan,
  viewportWidth: number,
  viewportHeight: number,
  options: DrawOptions,
): void {
  drawRainFrame(ctx, frame, layout, viewportWidth, viewportHeight, options);
  drawLockedCells(ctx, frame, layout);
}

// ---------------------------------------------------------------------------
// Locked cell drawing -- reveal pre-rendered wordmark image through cell mask
// ---------------------------------------------------------------------------

function drawLockedCells(ctx: CanvasRenderingContext2D, frame: FrameState, layout: LayoutPlan): void {
  const img = layout.wordmarkImage;
  if (!img) return;

  const cs = layout.cellSize;
  const imgW = 'width' in img ? (img as HTMLCanvasElement).width : (img as OffscreenCanvas).width;
  const imgH = 'height' in img ? (img as HTMLCanvasElement).height : (img as OffscreenCanvas).height;

  for (const cell of frame.lockedCells) {
    const destX = cell.col * cs;
    const destY = cell.row * cs;

    // Source rectangle in the wordmark image coordinate space.
    const srcX = destX - layout.wordmarkDrawX;
    const srcY = destY - layout.wordmarkDrawY;

    // Skip cells outside the wordmark image bounds.
    if (srcX < 0 || srcY < 0 || srcX + cs > imgW || srcY + cs > imgH) continue;

    ctx.drawImage(
      img as CanvasImageSource,
      srcX,
      srcY,
      cs,
      cs, // source rect
      destX,
      destY,
      cs,
      cs, // dest rect
    );
  }
}

// ---------------------------------------------------------------------------
// Drop drawing
// ---------------------------------------------------------------------------

function drawDrop(ctx: CanvasRenderingContext2D, drop: DropSnapshot, layout: LayoutPlan): void {
  // Trail is stored head-first (index 0 = nearest the head). Draw far-to-near
  // so nearer cells overpaint farther ones if they ever overlap.
  for (let i = drop.trail.length - 1; i >= 0; i--) {
    const cell = drop.trail[i];
    ctx.fillStyle = colorFor(cell.colorKind);
    ctx.fillText(cell.char, cellCenterX(layout, cell.col), cellTopY(layout, cell.row));
  }
  // Head last.
  ctx.fillStyle = colorFor(drop.colorKind);
  ctx.fillText(drop.char, cellCenterX(layout, drop.col), cellTopY(layout, drop.row));
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function colorFor(kind: DropColorKind): string {
  if (kind === 'head') return COLOR_HEAD;
  if (kind === 'near') return COLOR_NEAR;
  return COLOR_FAR;
}

function cellCenterX(layout: LayoutPlan, col: number): number {
  return col * layout.cellSize + layout.cellSize / 2;
}

function cellTopY(layout: LayoutPlan, row: number): number {
  return row * layout.cellSize;
}
