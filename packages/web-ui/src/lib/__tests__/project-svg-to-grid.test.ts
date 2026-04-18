import { describe, it, expect } from 'vitest';

import { projectSvgToGrid } from '../project-svg-to-grid.js';

describe('projectSvgToGrid', () => {
  it('maps the origin to grid (0, 0)', () => {
    expect(projectSvgToGrid({ x: 0, y: 0 }, 12)).toEqual({ col: 0, row: 0 });
  });

  it('maps integer multiples cleanly', () => {
    expect(projectSvgToGrid({ x: 24, y: 36 }, 12)).toEqual({ col: 2, row: 3 });
    expect(projectSvgToGrid({ x: 120, y: 240 }, 12)).toEqual({ col: 10, row: 20 });
  });

  it('rounds fractional points down when closer to the lower cell', () => {
    expect(projectSvgToGrid({ x: 14, y: 14 }, 12)).toEqual({ col: 1, row: 1 });
  });

  it('rounds fractional points up when closer to the upper cell', () => {
    expect(projectSvgToGrid({ x: 22, y: 22 }, 12)).toEqual({ col: 2, row: 2 });
  });

  it('rounds exact half-cells using Math.round semantics', () => {
    expect(projectSvgToGrid({ x: 6, y: 6 }, 12)).toEqual({ col: 1, row: 1 });
  });

  it('projects negative coords to negative grid coords (no clamping)', () => {
    expect(projectSvgToGrid({ x: -24, y: -12 }, 12)).toEqual({ col: -2, row: -1 });
    expect(projectSvgToGrid({ x: -7, y: -7 }, 12)).toEqual({ col: -1, row: -1 });
  });

  it('respects a custom cellSize', () => {
    expect(projectSvgToGrid({ x: 40, y: 60 }, 20)).toEqual({ col: 2, row: 3 });
  });

  it('throws when cellSize is zero', () => {
    expect(() => projectSvgToGrid({ x: 10, y: 10 }, 0)).toThrow(/cellSize/);
  });

  it('throws when cellSize is negative', () => {
    expect(() => projectSvgToGrid({ x: 10, y: 10 }, -12)).toThrow(/cellSize/);
  });
});
