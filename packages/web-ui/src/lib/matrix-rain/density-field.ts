/**
 * Per-column spawn-weight field for the stream rain engine.
 *
 * Theater resolves its workflow model (active node, inactive nodes, transition
 * lerp midpoint) into `DensitySource[]` with amplitudes and calls this module.
 * This module stays deliberately node-ID-agnostic — it is a pure geometric
 * computation.
 */

export interface DensitySource {
  readonly centerCol: number;
  readonly centerRow: number;
  /** 1.0 = full, 0.1 = faint trace. Theater picks per source. */
  readonly amplitude: number;
}

export interface DensityInput {
  readonly sources: ReadonlyArray<DensitySource>;
  readonly cols: number;
  readonly rows: number;
  /** Falloff radius in cells. 8-12 looks right at typical cellSize=12. */
  readonly sigma: number;
}

/**
 * Each source contributes a 2D Gaussian bump at (centerCol, centerRow) scaled
 * by `amplitude` onto a (cols * rows) scalar field. Collapse to per-column
 * weights by taking the max across rows — sum makes every column near the hot
 * source equally hot, which blurs the focus.
 */
export function computeColumnWeights(input: DensityInput): Float32Array {
  const { sources, cols, rows, sigma } = input;

  if (cols <= 0) {
    throw new Error(`computeColumnWeights: cols must be > 0 (got ${cols})`);
  }
  if (rows <= 0) {
    throw new Error(`computeColumnWeights: rows must be > 0 (got ${rows})`);
  }
  if (sigma <= 0) {
    throw new Error(`computeColumnWeights: sigma must be > 0 (got ${sigma})`);
  }

  const out = new Float32Array(cols);
  if (sources.length === 0) {
    return out;
  }

  const radius = Math.ceil(3 * sigma);
  const twoSigmaSq = 2 * sigma * sigma;

  for (const source of sources) {
    const { centerCol, centerRow, amplitude } = source;

    const cMin = Math.max(0, Math.floor(centerCol - radius));
    const cMax = Math.min(cols - 1, Math.ceil(centerCol + radius));
    const rMin = Math.max(0, Math.floor(centerRow - radius));
    const rMax = Math.min(rows - 1, Math.ceil(centerRow + radius));

    for (let c = cMin; c <= cMax; c++) {
      const dc = c - centerCol;
      const dcSq = dc * dc;
      let colMax = out[c];
      for (let r = rMin; r <= rMax; r++) {
        const dr = r - centerRow;
        const value = amplitude * Math.exp(-(dcSq + dr * dr) / twoSigmaSq);
        if (value > colMax) {
          colMax = value;
        }
      }
      out[c] = colMax;
    }
  }

  return out;
}
