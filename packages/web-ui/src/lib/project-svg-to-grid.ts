/**
 * SVG-space to grid-space coordinate projection.
 *
 * Dagre reports node centers in SVG pixel space; the density field, HUD anchors,
 * and transition-FX overlay all think in grid cells at a given `cellSize`.
 * Centralized here so every consumer agrees on the contract.
 */

export interface SvgPoint {
  readonly x: number;
  readonly y: number;
}

export interface GridPoint {
  readonly col: number;
  readonly row: number;
}

/**
 * Project an SVG-space point into grid cells. The theater pixel-matches its
 * canvas to the graph viewport, so this is a pure divide-and-round.
 */
export function projectSvgToGrid(p: SvgPoint, cellSize: number): GridPoint {
  if (cellSize <= 0) {
    throw new Error(`projectSvgToGrid: cellSize must be > 0 (got ${cellSize})`);
  }
  return {
    col: Math.round(p.x / cellSize),
    row: Math.round(p.y / cellSize),
  };
}
