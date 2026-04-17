/**
 * Color palette and alpha constants for the Matrix rain.
 *
 * Colors match the phosphor-green scheme from `src/mux/mux-splash.ts`. The
 * login page is always green regardless of the selected UI theme — the rain
 * is a branded cinematic, not a theme-coupled surface.
 */

// ---------------------------------------------------------------------------
// Colors (CSS hex strings, consumed directly by the Canvas renderer)
// ---------------------------------------------------------------------------

/** Drop head — brightest, near-white green. */
export const COLOR_HEAD = '#B4FFB4';

/** Near trail (1–2 cells behind the head) — saturated green. */
export const COLOR_NEAR = '#00FF46';

/** Far trail (3+ cells behind the head) — dim green. */
export const COLOR_FAR = '#007800';

/** Assembled wordmark cells — mid-bright green. */
export const COLOR_LOCKED = '#00C800';

// ---------------------------------------------------------------------------
// Alpha values (frame-level multipliers)
// ---------------------------------------------------------------------------

/** Alpha held throughout assembly. */
export const ALPHA_ASSEMBLY = 1.0;

/** Alpha at the start of the hold phase (matches assembly). */
export const ALPHA_HOLD_START = 1.0;

/** Alpha at the end of the hold phase (matches ambient). */
export const ALPHA_HOLD_END = 0.55;

/** Alpha held throughout the ambient phase. */
export const ALPHA_AMBIENT = 0.55;
