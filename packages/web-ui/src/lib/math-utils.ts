/**
 * Small numeric helpers shared across the workflow visualization. Kept
 * here so the rain engine, transition-fx, token-stream store, and director
 * all agree on implementations without each rolling their own.
 */

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Ease-out cubic: starts fast, decelerates to rest. */
export function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}
