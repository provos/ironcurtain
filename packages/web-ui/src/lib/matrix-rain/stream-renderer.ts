/**
 * Renderer for the live-stream rain.
 *
 * Thin wrapper over `drawRainFrame` (login renderer) that adds one extra
 * pass: held TF-IDF word drops drawn on top of the rain, alpha-blended and
 * colored per source kind. Keeps the login renderer byte-unchanged and the
 * stream-specific drawing local to this module.
 *
 * Per-source colors match the palette referenced in §E of the viz design:
 *   text  -> green   (ambient / LLM text_delta)
 *   tool  -> cyan    (tool calls)
 *   model -> amber   (model announcements)
 *   error -> red     (errors / failures)
 */

import { drawRainFrame, type DrawOptions, FONT_SIZE_TUNING } from './renderer.js';
import type { FrameState, LayoutPlan } from './types.js';
import type { WordDropSource } from './word-drop-types.js';

// ---------------------------------------------------------------------------
// Palette for held word drops
// ---------------------------------------------------------------------------

/** text_delta — ambient narration. Matches COLOR_NEAR from the login palette. */
const WORD_COLOR_TEXT = '#00FF46';
/** tool — tool invocations. Distinct cyan so calls pop out of the green rain. */
const WORD_COLOR_TOOL = '#00E5FF';
/** model — model identity blips (e.g., swap to a new model). Amber accent. */
const WORD_COLOR_MODEL = '#FFB84D';
/** error — failures, surfaced in crimson. */
const WORD_COLOR_ERROR = '#FF4D4D';

function wordColor(source: WordDropSource): string {
  if (source === 'tool') return WORD_COLOR_TOOL;
  if (source === 'model') return WORD_COLOR_MODEL;
  if (source === 'error') return WORD_COLOR_ERROR;
  return WORD_COLOR_TEXT;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Paint a stream frame: rain drops via `drawRainFrame`, then overlay held
 * word drops. Caller is responsible for applying the DPR transform before
 * calling (same convention as `drawRainFrame`).
 *
 * TODO(§A.3): optional alpha-channel density tint — a faint column-wise
 * overlay echoing the density field. Skipped in v1; the active-node pulse
 * plus weighted spawn already carry focus without it.
 */
export function drawStreamFrame(
  ctx: CanvasRenderingContext2D,
  frame: FrameState,
  layout: LayoutPlan,
  viewportWidth: number,
  viewportHeight: number,
  options: DrawOptions,
): void {
  drawRainFrame(ctx, frame, layout, viewportWidth, viewportHeight, options);

  if (frame.wordDrops.length === 0) {
    return;
  }

  drawWordDrops(ctx, frame, layout, options);
}

// ---------------------------------------------------------------------------
// Internal drawing
// ---------------------------------------------------------------------------

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
    const alpha = clamp01(drop.alpha);
    if (alpha <= 0) continue;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = wordColor(drop.source);
    const x = drop.col * layout.cellSize + layout.originX;
    const y = drop.row * layout.cellSize + layout.originY;
    ctx.fillText(drop.word, x, y);
  }

  // Restore the conventions `drawRainFrame` expects so subsequent draws on
  // the same context aren't surprised.
  ctx.globalAlpha = 1.0;
  ctx.textAlign = 'center';
}

function clamp01(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}
