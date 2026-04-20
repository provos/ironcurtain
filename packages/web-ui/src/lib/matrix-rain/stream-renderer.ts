/**
 * Renderer for the live-stream rain.
 *
 * Draws the rain layer (ambient drops, with optional per-drop source tint for
 * dissolve shards spawned by word drops) and the held-word layer (per-source
 * color, partial reveal during materialize). Keeps the login renderer
 * byte-unchanged by painting drops itself when any drop carries a tint, and
 * deferring to `drawRainFrame` when the frame is tint-free.
 *
 * Per-source colors match the palette referenced in §E of the viz design:
 *   text  -> green   (ambient / LLM text_delta)
 *   tool  -> cyan    (tool calls)
 *   model -> amber   (model announcements)
 *   error -> red     (errors / failures)
 *
 * Word-drop lifecycle (see word-drop-types.ts and §E.1 of the viz design):
 *   materialize -> hold -> dissolve (word removed from frame.wordDrops; chars
 *   continue as tinted drops in frame.drops until they fall off-grid).
 */

import { COLOR_FAR, COLOR_HEAD, COLOR_NEAR, COLOR_WORD_ERROR, COLOR_WORD_MODEL, COLOR_WORD_TOOL } from './palette.js';
import { drawRainFrame, type DrawOptions, FONT_SIZE_TUNING } from './renderer.js';
import type { DropColorKind, DropSnapshot, FrameState, LayoutPlan } from './types.js';
import type { WordDropSnapshot, WordDropSource } from './word-drop-types.js';

function wordColor(source: WordDropSource): string {
  if (source === 'tool') return COLOR_WORD_TOOL;
  if (source === 'model') return COLOR_WORD_MODEL;
  if (source === 'error') return COLOR_WORD_ERROR;
  return COLOR_NEAR;
}

/**
 * Resolve the color for a drop cell. Tinted drops (dissolve shards from a
 * word drop) use the word-drop palette; plain rain drops use the standard
 * head/near/far phosphor greens. Trail alpha is produced by the caller via
 * `globalAlpha` so this function is pure hex selection.
 */
function dropColor(kind: DropColorKind, tint: WordDropSource | undefined): string {
  if (tint !== undefined) return wordColor(tint);
  if (kind === 'head') return COLOR_HEAD;
  if (kind === 'near') return COLOR_NEAR;
  return COLOR_FAR;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Paint a stream frame: rain drops (tinted or plain) followed by held word
 * drops. Caller is responsible for applying the DPR transform before calling.
 *
 * When the frame has no tinted drops we defer to the login-path `drawRainFrame`
 * so the login renderer stays on the hot path and its behavior remains the
 * single source of truth. Frames with any tinted drop fall into a local drop
 * loop so shard colors can be plumbed through without mutating the shared
 * renderer.
 */
export function drawStreamFrame(
  ctx: CanvasRenderingContext2D,
  frame: FrameState,
  layout: LayoutPlan,
  viewportWidth: number,
  viewportHeight: number,
  options: DrawOptions,
): void {
  const hasTintedDrops = frameHasTintedDrops(frame);
  if (hasTintedDrops) {
    drawTintedRain(ctx, frame, layout, viewportWidth, viewportHeight, options);
  } else {
    drawRainFrame(ctx, frame, layout, viewportWidth, viewportHeight, options);
  }

  if (frame.wordDrops.length === 0) {
    return;
  }

  drawWordDrops(ctx, frame, layout, options);
}

// ---------------------------------------------------------------------------
// Internal drawing
// ---------------------------------------------------------------------------

function frameHasTintedDrops(frame: FrameState): boolean {
  for (const drop of frame.drops) {
    if (drop.tint !== undefined) return true;
  }
  return false;
}

/**
 * Locally paint the rain layer with per-drop tint support. Mirrors
 * `drawRainFrame` but walks each drop explicitly so dissolve shards can
 * pick up word-drop colors without duplicating trail-walk logic in the
 * login renderer.
 */
function drawTintedRain(
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

  const fontStr = `${fontSize}px ${options.fontFamily}`;
  if (ctx.font !== fontStr) {
    ctx.font = fontStr;
  }
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';

  ctx.globalAlpha = frame.globalAlpha;

  for (const drop of frame.drops) {
    drawSingleDrop(ctx, drop, layout);
  }

  ctx.globalAlpha = 1.0;
}

function drawSingleDrop(ctx: CanvasRenderingContext2D, drop: DropSnapshot, layout: LayoutPlan): void {
  const tint = drop.tint;
  // Trail far-to-near so nearer cells paint over farther ones on any overlap.
  for (let i = drop.trail.length - 1; i >= 0; i--) {
    const cell = drop.trail[i];
    ctx.fillStyle = dropColor(cell.colorKind, cell.tint ?? tint);
    ctx.fillText(cell.char, cell.col * layout.cellSize + layout.cellSize / 2, cell.row * layout.cellSize);
  }
  ctx.fillStyle = dropColor(drop.colorKind, tint);
  ctx.fillText(drop.char, drop.col * layout.cellSize + layout.cellSize / 2, drop.row * layout.cellSize);
}

function drawWordDrops(
  ctx: CanvasRenderingContext2D,
  frame: FrameState,
  layout: LayoutPlan,
  options: DrawOptions,
): void {
  // Word drops use the same monospace family as the rain so they feel like
  // they belong to the stream rather than an overlaid caption. Size tracks
  // cellSize so tiny grids don't produce illegible text.
  const tuning = options.fontSizeTuning ?? FONT_SIZE_TUNING;
  const fontSize = layout.cellSize * tuning;
  const fontStr = `${fontSize}px ${options.fontFamily}`;
  if (ctx.font !== fontStr) {
    ctx.font = fontStr;
  }
  ctx.textBaseline = 'top';
  // Left-align so multi-character words grow rightward from their grid cell.
  ctx.textAlign = 'left';

  for (const drop of frame.wordDrops) {
    drawWordDrop(ctx, drop, layout);
  }

  // Restore the conventions the rain draw expects so subsequent draws on
  // the same context aren't surprised.
  ctx.globalAlpha = 1.0;
  ctx.textAlign = 'center';
}

/**
 * Draw a single held word drop. Materialize renders the first `revealedChars`
 * glyphs only — the unrevealed tail is not drawn this frame. Hold renders the
 * full word. Alpha is flat at 1.0; the fade-in envelope is replaced by the
 * per-character reveal (see word-drop-types.ts).
 */
function drawWordDrop(ctx: CanvasRenderingContext2D, drop: WordDropSnapshot, layout: LayoutPlan): void {
  const visible = drop.phase === 'materialize' ? drop.word.slice(0, drop.revealedChars) : drop.word;
  if (visible.length === 0) return;
  ctx.globalAlpha = 1.0;
  ctx.fillStyle = wordColor(drop.source);
  const x = drop.col * layout.cellSize + layout.originX;
  const y = drop.row * layout.cellSize + layout.originY;
  ctx.fillText(visible, x, y);
}
