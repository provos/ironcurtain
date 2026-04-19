import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  createTransitionFxSubsystem,
  truncateNotes,
  fxToDensitySource,
  TRAVEL_MS,
  ABSORB_MS,
  SCANLINE_MS,
  TOTAL_MS,
  NOTES_CHAR_CAP,
  type TransitionTriggerLike,
} from '$lib/transition-fx.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTrigger(overrides: Partial<TransitionTriggerLike> = {}): TransitionTriggerLike {
  return {
    from: 'analyze',
    to: 'discover',
    fromPos: { x: 100, y: 100 },
    toPos: { x: 400, y: 100 },
    handoffLabel: 'hypothesis: off-by-one',
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// truncateNotes
// ---------------------------------------------------------------------------

describe('truncateNotes', () => {
  it('passes through short strings unchanged', () => {
    expect(truncateNotes('hello')).toBe('hello');
  });

  it('returns the exact cap untouched', () => {
    const s = 'x'.repeat(NOTES_CHAR_CAP);
    expect(truncateNotes(s)).toBe(s);
  });

  it('truncates over-cap strings with a single trailing ellipsis', () => {
    const s = 'a'.repeat(NOTES_CHAR_CAP + 20);
    const result = truncateNotes(s);
    expect(result.length).toBe(NOTES_CHAR_CAP);
    expect(result.endsWith('…')).toBe(true);
  });

  it('handles empty strings', () => {
    expect(truncateNotes('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// State machine — phase progression
// ---------------------------------------------------------------------------

describe('TransitionFxSubsystem — phase progression', () => {
  it('starts idle and reports null frame', () => {
    const fx = createTransitionFxSubsystem();
    expect(fx.phase).toBe('idle');
    expect(fx.isActive()).toBe(false);
    expect(fx.getFrame()).toBeNull();
    expect(fx.getActive()).toBeNull();
  });

  it('enters traveling phase immediately on trigger', () => {
    const fx = createTransitionFxSubsystem();
    fx.trigger(makeTrigger(), 1000);
    expect(fx.phase).toBe('traveling');
    expect(fx.isActive()).toBe(true);
    const f = fx.getFrame();
    expect(f).not.toBeNull();
    expect(f?.phase).toBe('traveling');
  });

  it('transitions to absorbing after TRAVEL_MS', () => {
    const fx = createTransitionFxSubsystem();
    fx.trigger(makeTrigger(), 0);
    fx.step(TRAVEL_MS);
    expect(fx.phase).toBe('absorbing');
  });

  it('transitions to scan-line after TRAVEL_MS + ABSORB_MS', () => {
    const fx = createTransitionFxSubsystem();
    fx.trigger(makeTrigger(), 0);
    fx.step(TRAVEL_MS + ABSORB_MS);
    expect(fx.phase).toBe('scan-line');
  });

  it('returns to idle after TOTAL_MS', () => {
    const fx = createTransitionFxSubsystem();
    fx.trigger(makeTrigger(), 0);
    fx.step(TOTAL_MS);
    expect(fx.phase).toBe('idle');
    expect(fx.isActive()).toBe(false);
    expect(fx.getFrame()).toBeNull();
  });

  it('remains idle if step is called without a trigger', () => {
    const fx = createTransitionFxSubsystem();
    fx.step(500);
    expect(fx.phase).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// Tile lerp
// ---------------------------------------------------------------------------

describe('TransitionFxSubsystem — tile position', () => {
  it('places the tile at the outgoing position at t=0', () => {
    const fx = createTransitionFxSubsystem();
    fx.trigger(makeTrigger(), 0);
    const f = fx.getFrame();
    expect(f?.tilePos.x).toBeCloseTo(100, 4);
    expect(f?.tilePos.y).toBeCloseTo(100, 4);
  });

  it('places the tile at the incoming position at t=TRAVEL_MS', () => {
    const fx = createTransitionFxSubsystem();
    fx.trigger(makeTrigger(), 0);
    fx.step(TRAVEL_MS);
    const f = fx.getFrame();
    // At the travel endpoint the tile is at toPos (even though the phase is
    // already absorbing, position has completed its lerp).
    expect(f?.tilePos.x).toBeCloseTo(400, 4);
    expect(f?.tilePos.y).toBeCloseTo(100, 4);
  });

  it('uses ease-out cubic — more than half-way at the mid-point', () => {
    const fx = createTransitionFxSubsystem();
    fx.trigger(makeTrigger({ fromPos: { x: 0, y: 0 }, toPos: { x: 1000, y: 0 } }), 0);
    fx.step(TRAVEL_MS / 2);
    const f = fx.getFrame();
    // Ease-out cubic at t=0.5 is 1 - 0.5^3 = 0.875. So x should be ~875.
    expect(f?.tilePos.x).toBeGreaterThan(500);
    expect(f?.tilePos.x).toBeCloseTo(875, 0);
  });

  it('holds scale=1 and alpha=1 throughout the travel window', () => {
    const fx = createTransitionFxSubsystem();
    fx.trigger(makeTrigger(), 0);
    for (const t of [0, 100, 300, TRAVEL_MS - 1]) {
      fx.step(t);
      const f = fx.getFrame();
      expect(f?.tileScale).toBe(1);
      expect(f?.tileAlpha).toBe(1);
    }
  });

  it('holds scale at 1 and fades alpha linearly through the absorb window (Fix #3)', () => {
    // The absorb phase used to scale down alongside fading alpha, but that
    // collapsed the tile from full-size to zero in 200ms, leaving the notes
    // unreadable for most of the absorb window. The contract is now:
    // scale stays at 1.0 for the whole absorb; alpha decays 1 -> 0 linearly.
    const fx = createTransitionFxSubsystem();
    fx.trigger(makeTrigger(), 0);
    fx.step(TRAVEL_MS);
    const start = fx.getFrame();
    expect(start?.tileScale).toBe(1);
    expect(start?.tileAlpha).toBeCloseTo(1, 4);
    fx.step(TRAVEL_MS + ABSORB_MS / 2);
    const mid = fx.getFrame();
    expect(mid?.tileScale).toBe(1);
    expect(mid?.tileAlpha).toBeCloseTo(0.5, 2);
    fx.step(TRAVEL_MS + ABSORB_MS);
    const end = fx.getFrame();
    // At the boundary phase flips to scan-line which zeros both.
    expect(end?.tileScale).toBe(0);
    expect(end?.tileAlpha).toBe(0);
  });

  it('reports scale=0 and alpha=0 during the scan-line tail', () => {
    const fx = createTransitionFxSubsystem();
    fx.trigger(makeTrigger(), 0);
    fx.step(TRAVEL_MS + ABSORB_MS + SCANLINE_MS / 2);
    const f = fx.getFrame();
    expect(f?.phase).toBe('scan-line');
    expect(f?.tileScale).toBe(0);
    expect(f?.tileAlpha).toBe(0);
  });

  it('preserves the 1000ms cycle budget after the legibility fix (Fix #3)', () => {
    // Guard against unintended growth of the total cycle length: if Fix #3 ever
    // migrates to "hold visible then fade" by extending ABSORB_MS, this assert
    // fires and forces a conscious decision.
    expect(TRAVEL_MS + ABSORB_MS + SCANLINE_MS).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// Notes truncation in the frame
// ---------------------------------------------------------------------------

describe('TransitionFxSubsystem — notes', () => {
  it('truncates over-long notes in the frame', () => {
    const fx = createTransitionFxSubsystem();
    const longNotes = 'a'.repeat(NOTES_CHAR_CAP + 40);
    fx.trigger(makeTrigger({ handoffLabel: longNotes }), 0);
    const f = fx.getFrame();
    expect(f?.notes.length).toBe(NOTES_CHAR_CAP);
    expect(f?.notes.endsWith('…')).toBe(true);
  });

  it('surfaces from/to ids on the frame', () => {
    const fx = createTransitionFxSubsystem();
    fx.trigger(makeTrigger({ from: 'a', to: 'b' }), 0);
    const f = fx.getFrame();
    expect(f?.fromId).toBe('a');
    expect(f?.toId).toBe('b');
  });
});

// ---------------------------------------------------------------------------
// Concurrency — "dropping the new one if <1000ms from the prior is defensible"
// ---------------------------------------------------------------------------

describe('TransitionFxSubsystem — concurrency', () => {
  it('drops a second trigger while the first is still active', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fx = createTransitionFxSubsystem();
    const t1 = makeTrigger({ from: 'a', to: 'b' });
    const t2 = makeTrigger({ from: 'c', to: 'd' });
    fx.trigger(t1, 0);
    fx.trigger(t2, 100); // during travel
    expect(fx.getActive()?.from).toBe('a');
    expect(fx.getActive()?.to).toBe('b');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('accepts a new trigger after the prior cycle completes', () => {
    const fx = createTransitionFxSubsystem();
    const t1 = makeTrigger({ from: 'a', to: 'b' });
    const t2 = makeTrigger({ from: 'c', to: 'd' });
    fx.trigger(t1, 0);
    fx.step(TOTAL_MS); // cycle expired
    fx.trigger(t2, TOTAL_MS);
    expect(fx.getActive()?.from).toBe('c');
    expect(fx.phase).toBe('traveling');
  });

  it('warns only once for a burst of dropped triggers', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fx = createTransitionFxSubsystem();
    fx.trigger(makeTrigger(), 0);
    fx.trigger(makeTrigger(), 50);
    fx.trigger(makeTrigger(), 100);
    fx.trigger(makeTrigger(), 200);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Density source
// ---------------------------------------------------------------------------

describe('TransitionFxSubsystem — density source', () => {
  it('returns null when idle', () => {
    const fx = createTransitionFxSubsystem();
    expect(fx.getDensitySource(12)).toBeNull();
  });

  it('returns null after the travel window closes', () => {
    const fx = createTransitionFxSubsystem();
    fx.trigger(makeTrigger(), 0);
    fx.step(TRAVEL_MS);
    expect(fx.getDensitySource(12)).toBeNull();
    fx.step(TRAVEL_MS + 100);
    expect(fx.getDensitySource(12)).toBeNull();
  });

  it('returns a lerped grid point mid-travel', () => {
    const fx = createTransitionFxSubsystem();
    fx.trigger(makeTrigger({ fromPos: { x: 0, y: 0 }, toPos: { x: 1200, y: 0 } }), 0);
    fx.step(TRAVEL_MS / 2);
    const src = fx.getDensitySource(12);
    expect(src).not.toBeNull();
    // ease-out cubic at t=0.5 -> ~0.875 * 1200 = 1050 -> grid col ~= 88.
    expect(src?.gridCol).toBeCloseTo(88, 0);
    expect(src?.gridRow).toBe(0);
    expect(src?.amplitude).toBe(1.0);
  });

  it('throws via projectSvgToGrid when cellSize is zero', () => {
    const fx = createTransitionFxSubsystem();
    fx.trigger(makeTrigger(), 0);
    expect(() => fx.getDensitySource(0)).toThrow(/cellSize/);
  });
});

// ---------------------------------------------------------------------------
// reset()
// ---------------------------------------------------------------------------

describe('TransitionFxSubsystem — reset', () => {
  it('returns to idle immediately', () => {
    const fx = createTransitionFxSubsystem();
    fx.trigger(makeTrigger(), 0);
    fx.step(100);
    fx.reset();
    expect(fx.phase).toBe('idle');
    expect(fx.getFrame()).toBeNull();
    expect(fx.getActive()).toBeNull();
  });

  it('allows a subsequent trigger after reset', () => {
    const fx = createTransitionFxSubsystem();
    fx.trigger(makeTrigger({ from: 'a', to: 'b' }), 0);
    fx.reset();
    fx.trigger(makeTrigger({ from: 'c', to: 'd' }), 0);
    expect(fx.getActive()?.from).toBe('c');
  });
});

// ---------------------------------------------------------------------------
// fxToDensitySource — mapping helper
// ---------------------------------------------------------------------------

describe('fxToDensitySource', () => {
  it('maps grid-space fx density source to computeColumnWeights source shape', () => {
    const src = fxToDensitySource({ gridCol: 12, gridRow: 8, amplitude: 0.7 });
    expect(src).toEqual({ centerCol: 12, centerRow: 8, amplitude: 0.7 });
  });
});
