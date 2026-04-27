import { describe, it, expect } from 'vitest';

import { computeColumnWeights, type DensitySource } from '../density-field.js';

const SIGMA = 5;

function peakCol(weights: Float32Array): number {
  let best = -1;
  let bestVal = -Infinity;
  for (let i = 0; i < weights.length; i++) {
    if (weights[i] > bestVal) {
      bestVal = weights[i];
      best = i;
    }
  }
  return best;
}

describe('computeColumnWeights', () => {
  it('returns an all-zero field of the right length when sources is empty', () => {
    const weights = computeColumnWeights({ sources: [], cols: 40, rows: 20, sigma: SIGMA });
    expect(weights).toBeInstanceOf(Float32Array);
    expect(weights.length).toBe(40);
    for (const w of weights) {
      expect(w).toBe(0);
    }
  });

  it('produces a peak at a single source column', () => {
    const sources: DensitySource[] = [{ centerCol: 20, centerRow: 10, amplitude: 1 }];
    const weights = computeColumnWeights({ sources, cols: 40, rows: 20, sigma: SIGMA });

    expect(peakCol(weights)).toBe(20);
    expect(weights[20]).toBeCloseTo(1, 5);
    expect(weights[20]).toBeGreaterThan(weights[15]);
    expect(weights[20]).toBeGreaterThan(weights[25]);
  });

  it('handles a source whose center is off-grid without crashing', () => {
    const sources: DensitySource[] = [{ centerCol: -5, centerRow: 30, amplitude: 1 }];
    const weights = computeColumnWeights({ sources, cols: 40, rows: 20, sigma: SIGMA });

    expect(weights.length).toBe(40);
    for (const w of weights) {
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
      expect(Number.isFinite(w)).toBe(true);
    }
  });

  it('produces two separated peaks for distant sources with near-zero trough between them', () => {
    const sources: DensitySource[] = [
      { centerCol: 10, centerRow: 10, amplitude: 1 },
      { centerCol: 60, centerRow: 10, amplitude: 1 },
    ];
    const weights = computeColumnWeights({ sources, cols: 80, rows: 20, sigma: SIGMA });

    expect(weights[10]).toBeCloseTo(1, 5);
    expect(weights[60]).toBeCloseTo(1, 5);
    // Midpoint is 25 sigma widths away from each source — effectively zero.
    expect(weights[35]).toBeLessThan(0.001);
  });

  it('produces a merged hot region when sources are in adjacent columns', () => {
    const sources: DensitySource[] = [
      { centerCol: 20, centerRow: 10, amplitude: 1 },
      { centerCol: 21, centerRow: 10, amplitude: 1 },
    ];
    const weights = computeColumnWeights({ sources, cols: 40, rows: 20, sigma: SIGMA });

    expect(weights[20]).toBeCloseTo(1, 5);
    expect(weights[21]).toBeCloseTo(1, 5);
    // Both peaks are visible, and columns just outside remain high (merged blob).
    expect(weights[19]).toBeGreaterThan(0.9);
    expect(weights[22]).toBeGreaterThan(0.9);
  });

  it('collapses across rows by max, not sum, when sources share a column', () => {
    const shared: DensitySource[] = [
      { centerCol: 5, centerRow: 10, amplitude: 1 },
      { centerCol: 5, centerRow: 2, amplitude: 0.3 },
    ];
    const merged = computeColumnWeights({ sources: shared, cols: 20, rows: 20, sigma: SIGMA });

    const onlyStrong = computeColumnWeights({
      sources: [shared[0]],
      cols: 20,
      rows: 20,
      sigma: SIGMA,
    });

    // If rows were summed, merged[5] would exceed 1. Under max, it equals the
    // stronger source's peak exactly.
    expect(merged[5]).toBeCloseTo(onlyStrong[5], 5);
    expect(merged[5]).toBeLessThanOrEqual(1);
  });

  it('scales the peak linearly with amplitude', () => {
    const full = computeColumnWeights({
      sources: [{ centerCol: 10, centerRow: 10, amplitude: 1 }],
      cols: 30,
      rows: 20,
      sigma: SIGMA,
    });
    const half = computeColumnWeights({
      sources: [{ centerCol: 10, centerRow: 10, amplitude: 0.5 }],
      cols: 30,
      rows: 20,
      sigma: SIGMA,
    });

    expect(half[10]).toBeCloseTo(full[10] * 0.5, 5);
    expect(half[8]).toBeCloseTo(full[8] * 0.5, 5);
  });

  it('throws when sigma is zero', () => {
    expect(() => computeColumnWeights({ sources: [], cols: 10, rows: 10, sigma: 0 })).toThrow(/sigma/);
  });

  it('throws when sigma is negative', () => {
    expect(() => computeColumnWeights({ sources: [], cols: 10, rows: 10, sigma: -1 })).toThrow(/sigma/);
  });

  it('throws when cols is zero or negative', () => {
    expect(() => computeColumnWeights({ sources: [], cols: 0, rows: 10, sigma: SIGMA })).toThrow(/cols/);
    expect(() => computeColumnWeights({ sources: [], cols: -5, rows: 10, sigma: SIGMA })).toThrow(/cols/);
  });

  it('throws when rows is zero or negative', () => {
    expect(() => computeColumnWeights({ sources: [], cols: 10, rows: 0, sigma: SIGMA })).toThrow(/rows/);
    expect(() => computeColumnWeights({ sources: [], cols: 10, rows: -3, sigma: SIGMA })).toThrow(/rows/);
  });
});
