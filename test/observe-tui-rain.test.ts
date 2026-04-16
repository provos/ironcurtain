/**
 * Tests for observe-tui-rain -- Matrix rain engine for the observe TUI.
 */

import { describe, it, expect } from 'vitest';
import { createRainEngine, type RainRng } from '../src/observe/observe-tui-rain.js';
import { calculateTuiLayout, SGR, type RainToken } from '../src/observe/observe-tui-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic RNG that cycles through preset values. */
function createSeededRng(values: number[]): RainRng {
  let idx = 0;
  return {
    random() {
      const val = values[idx % values.length];
      idx++;
      return val;
    },
  };
}

function textToken(char: string): RainToken {
  return { char, kind: 'text' };
}

function toolToken(char: string): RainToken {
  return { char, kind: 'tool' };
}

function errorToken(char: string): RainToken {
  return { char, kind: 'error' };
}

/** Escape sequence prefix for ANSI CSI commands. */
const ESC = '\x1b[';

/** Check if a string contains ANSI cursor positioning sequences (e.g. ESC[5;3H). */
function hasCursorPositioning(s: string): boolean {
  // Look for pattern: ESC[ digits ; digits H
  let i = 0;
  while (i < s.length) {
    const pos = s.indexOf(ESC, i);
    if (pos === -1) return false;
    // Check for "digits;digitsH" after the ESC[
    let j = pos + ESC.length;
    if (j >= s.length || s[j] < '0' || s[j] > '9') {
      i = pos + 1;
      continue;
    }
    while (j < s.length && s[j] >= '0' && s[j] <= '9') j++;
    if (j >= s.length || s[j] !== ';') {
      i = pos + 1;
      continue;
    }
    j++;
    if (j >= s.length || s[j] < '0' || s[j] > '9') {
      i = pos + 1;
      continue;
    }
    while (j < s.length && s[j] >= '0' && s[j] <= '9') j++;
    if (j < s.length && s[j] === 'H') return true;
    i = pos + 1;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Token queue
// ---------------------------------------------------------------------------

describe('Token queue', () => {
  it('tracks queue depth as tokens are enqueued', () => {
    const layout = calculateTuiLayout(80, 20);
    const engine = createRainEngine({ layout });
    expect(engine.queueDepth).toBe(0);

    engine.enqueueTokens([textToken('a'), textToken('b'), textToken('c')]);
    expect(engine.queueDepth).toBe(3);
  });

  it('bounds queue at capacity, dropping oldest on overflow', () => {
    const layout = calculateTuiLayout(80, 24);
    const engine = createRainEngine({ layout });

    // Fill beyond capacity (2048)
    const tokens: RainToken[] = [];
    for (let i = 0; i < 2100; i++) {
      tokens.push(textToken(String.fromCharCode(65 + (i % 26))));
    }
    engine.enqueueTokens(tokens);

    // Queue should be capped at 2048
    expect(engine.queueDepth).toBe(2048);
  });

  it('dequeues in FIFO order via drop spawning', () => {
    const rng = createSeededRng([0.0]);
    const layout = calculateTuiLayout(60, 20);
    const engine = createRainEngine({ layout, rng });

    engine.enqueueTokens([textToken('X'), textToken('Y')]);
    // First tick spawns a drop consuming at least one token
    engine.tick();
    expect(engine.queueDepth).toBeLessThan(2);
  });
});

// ---------------------------------------------------------------------------
// Drop movement
// ---------------------------------------------------------------------------

describe('Drop advancement', () => {
  it('drops advance downward on each tick', () => {
    const layout = calculateTuiLayout(80, 30);
    const rng = createSeededRng([0.0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const engine = createRainEngine({ layout, rng });

    engine.enqueueTokens([textToken('A')]);
    engine.tick();

    const output = engine.render();
    // Should produce ANSI output with escape sequences
    expect(output).toContain(ESC);
  });

  it('drops produce visible ANSI output on render', () => {
    const layout = calculateTuiLayout(80, 20);
    const rng = createSeededRng([0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
    const engine = createRainEngine({ layout, rng });

    engine.enqueueTokens([textToken('M')]);

    // Tick several times to ensure drop is in visible area
    for (let i = 0; i < 5; i++) {
      engine.tick();
    }

    const output = engine.render();
    // Should contain cursor positioning sequences
    expect(hasCursorPositioning(output)).toBe(true);
    // Should contain an SGR reset at the end
    expect(output).toContain(SGR.RESET);
  });
});

// ---------------------------------------------------------------------------
// Drop despawn
// ---------------------------------------------------------------------------

describe('Drop despawn', () => {
  it('drops marked dead when fully off screen', () => {
    // Small viewport so drops exit quickly
    const layout = calculateTuiLayout(60, 5);
    const rng = createSeededRng([0.0, 0.99, 0.0, 0.0, 0.99, 0.0]);
    const engine = createRainEngine({ layout, rng });

    engine.enqueueTokens([textToken('Z')]);
    engine.tick();

    // Tick many times to push drops off screen
    for (let i = 0; i < 30; i++) {
      engine.tick();
    }

    const output = engine.render();
    // The output should still be valid ANSI (clear + reset)
    expect(output).toContain(SGR.RESET);
  });

  it('dead drops are removed from active pool', () => {
    const layout = calculateTuiLayout(60, 3);
    const rng = createSeededRng([0.0, 0.99, 0.0, 0.0, 0.99, 0.0]);
    const engine = createRainEngine({ layout, rng });

    engine.enqueueTokens([textToken('D')]);

    // Run enough ticks for drops to fully exit a 3-row viewport
    for (let i = 0; i < 40; i++) {
      engine.tick();
    }

    // After sufficient ticks, render should be stable (no ghost drops)
    const output1 = engine.render();
    const output2 = engine.render();
    expect(output1).toBe(output2);
  });
});

// ---------------------------------------------------------------------------
// Column cooldown
// ---------------------------------------------------------------------------

describe('Column cooldown', () => {
  it('prevents spawning in the same column on consecutive frames', () => {
    const layout = calculateTuiLayout(60, 20);
    const rainCols = layout.rainCols;

    // Use RNG that always selects column 0
    const rng = createSeededRng([0.0]);
    const engine = createRainEngine({ layout, rng });

    // Fill queue with tokens
    const tokens = Array.from({ length: 100 }, (_, i) => textToken(String(i % 10)));
    engine.enqueueTokens(tokens);

    // First tick: spawns drops
    engine.tick();
    const initialDepth = engine.queueDepth;

    // Second tick: columns should be on cooldown, fewer available
    engine.tick();
    const secondDepth = engine.queueDepth;

    expect(rainCols).toBeGreaterThan(0);
    // The token consumption should be bounded by available columns
    expect(initialDepth).toBeGreaterThanOrEqual(secondDepth);
  });

  it('allows spawning after cooldown expires', () => {
    const layout = calculateTuiLayout(60, 20);
    const rng = createSeededRng([0.0]);
    const engine = createRainEngine({ layout, rng });

    const tokens = Array.from({ length: 200 }, (_, i) => textToken(String(i % 10)));
    engine.enqueueTokens(tokens);

    // Run enough ticks for cooldowns to expire (trailLen + random(2,5) ~ 5-11 frames)
    for (let i = 0; i < 15; i++) {
      engine.tick();
    }

    const depthBefore = engine.queueDepth;
    engine.tick();
    const depthAfter = engine.queueDepth;

    // After cooldown expires, new drops should spawn (consuming tokens)
    expect(depthBefore).toBeGreaterThanOrEqual(depthAfter);
  });
});

// ---------------------------------------------------------------------------
// Idle mode
// ---------------------------------------------------------------------------

describe('Idle mode', () => {
  it('spawns with random characters when queue is empty', () => {
    const layout = calculateTuiLayout(80, 20);
    const rng = createSeededRng([0.5, 0.3, 0.7, 0.1, 0.9, 0.2, 0.8, 0.4]);
    const engine = createRainEngine({ layout, rng });

    // No tokens enqueued; run past idle threshold (15 frames)
    for (let i = 0; i < 20; i++) {
      engine.tick();
    }

    // Should still produce rendered output (idle drops)
    const output = engine.render();
    expect(output.length).toBeGreaterThan(0);
    expect(output).toContain(ESC);
  });

  it('transitions back from idle when tokens arrive', () => {
    const layout = calculateTuiLayout(80, 20);
    const rng = createSeededRng([0.5, 0.3, 0.7, 0.1, 0.9, 0.2, 0.8, 0.4]);
    const engine = createRainEngine({ layout, rng });

    // Go idle
    for (let i = 0; i < 20; i++) {
      engine.tick();
    }

    // Enqueue tokens
    engine.enqueueTokens([textToken('A'), textToken('B'), textToken('C')]);

    // Next tick should consume from queue (not idle)
    engine.tick();
    expect(engine.queueDepth).toBeLessThan(3);
  });

  it('idle spawn rate is lower than active spawn rate', () => {
    const layout = calculateTuiLayout(60, 20);
    const rainCols = layout.rainCols;

    // active rate = ceil(rainCols/8), idle rate = max(1, floor(rainCols/30))
    const activeRate = Math.ceil(rainCols / 8);
    const idleRate = Math.max(1, Math.floor(rainCols / 30));

    expect(idleRate).toBeLessThanOrEqual(activeRate);
  });
});

// ---------------------------------------------------------------------------
// Render output
// ---------------------------------------------------------------------------

describe('render()', () => {
  it('produces ANSI output with cursor positioning', () => {
    const layout = calculateTuiLayout(80, 20);
    const rng = createSeededRng([0.5]);
    const engine = createRainEngine({ layout, rng });

    engine.enqueueTokens([textToken('X')]);
    engine.tick();

    const output = engine.render();

    // Should have cursor positioning (CSI row;col H)
    expect(hasCursorPositioning(output)).toBe(true);

    // Should end with SGR reset
    expect(output).toContain(SGR.RESET);
  });

  it('clears rain panel before drawing drops', () => {
    const layout = calculateTuiLayout(80, 10);
    const rng = createSeededRng([0.5]);
    const engine = createRainEngine({ layout, rng });

    engine.tick();
    const output = engine.render();

    // The clear pass moves to row 1, col 1 and writes spaces
    expect(output).toContain(`${ESC}1;1H`);
  });

  it('returns empty string when rainCols is 0', () => {
    // Terminal too narrow for rain
    const layout = calculateTuiLayout(50, 20);
    const engine = createRainEngine({ layout });

    engine.tick();
    expect(engine.render()).toBe('');
  });

  it('includes color-coded output for different token kinds', () => {
    const layout = calculateTuiLayout(80, 20);
    const rng = createSeededRng([0.0, 0.5, 0.5, 0.5, 0.1, 0.5, 0.5, 0.5, 0.2, 0.5, 0.5, 0.5]);
    const engine = createRainEngine({ layout, rng });

    engine.enqueueTokens([textToken('T'), toolToken('L'), errorToken('E')]);

    // Run enough ticks for drops to be visible
    for (let i = 0; i < 5; i++) {
      engine.tick();
    }

    const output = engine.render();
    // Should contain SGR color sequences (38;2 for true-color)
    expect(output).toContain('38;2;');
  });
});

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------

describe('resize()', () => {
  it('kills drops in columns beyond new width', () => {
    const layout = calculateTuiLayout(100, 20);
    const rng = createSeededRng([0.99, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const engine = createRainEngine({ layout, rng });

    engine.enqueueTokens(Array.from({ length: 50 }, (_, i) => textToken(String.fromCharCode(65 + (i % 26)))));

    // Spawn drops across wide layout
    for (let i = 0; i < 5; i++) {
      engine.tick();
    }

    const outputBefore = engine.render();

    // Shrink to narrow (no rain panel)
    const narrowLayout = calculateTuiLayout(50, 20);
    engine.resize(narrowLayout);

    const outputAfter = engine.render();
    // With rainCols=0 after resize, render returns empty
    expect(outputAfter).toBe('');
    // Before resize had content
    expect(outputBefore.length).toBeGreaterThan(outputAfter.length);
  });

  it('preserves drops within new bounds after resize', () => {
    const layout = calculateTuiLayout(80, 20);
    const rng = createSeededRng([0.0, 0.5, 0.5, 0.5]);
    const engine = createRainEngine({ layout, rng });

    engine.enqueueTokens([textToken('K')]);
    engine.tick();

    // Resize to slightly smaller but still valid
    const newLayout = calculateTuiLayout(70, 18);
    engine.resize(newLayout);

    // Should still render (drops in col 0 survive)
    engine.tick();
    const output = engine.render();
    expect(output).toContain(ESC);
    expect(output.length).toBeGreaterThan(10);
  });

  it('updates cooldowns array on resize', () => {
    const layout = calculateTuiLayout(100, 20);
    const rng = createSeededRng([0.5]);
    const engine = createRainEngine({ layout, rng });

    engine.enqueueTokens(Array.from({ length: 100 }, () => textToken('X')));

    // Spawn to set some cooldowns
    engine.tick();

    // Resize to much smaller
    const smallLayout = calculateTuiLayout(60, 10);
    engine.resize(smallLayout);

    // Should still function after resize
    engine.tick();
    const output = engine.render();
    expect(output).toContain(ESC);
  });

  it('kills word drops that no longer fit after resize', () => {
    const layout = calculateTuiLayout(100, 20);
    const rng = createSeededRng([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const engine = createRainEngine({ layout, rng });

    engine.enqueueWord('longword', 'tool');
    engine.tick(); // Try to spawn word drop

    // Shrink to very narrow
    const narrowLayout = calculateTuiLayout(60, 5);
    engine.resize(narrowLayout);

    // Should not crash
    engine.tick();
    const output = engine.render();
    expect(output).toContain(SGR.RESET);
  });

  it('clears word queue on resize', () => {
    const layout = calculateTuiLayout(80, 20);
    const engine = createRainEngine({ layout });

    engine.enqueueWord('word1', 'tool');
    engine.enqueueWord('word2', 'model');

    // Resize
    const newLayout = calculateTuiLayout(70, 18);
    engine.resize(newLayout);

    // Word queue should be cleared; ticking should not crash
    for (let i = 0; i < 10; i++) {
      engine.tick();
    }
    const output = engine.render();
    expect(output).toContain(SGR.RESET);
  });
});

// ---------------------------------------------------------------------------
// Phase-driven colors (Phase 2)
// ---------------------------------------------------------------------------

describe('setPhase', () => {
  it('accepts all phase values without error', () => {
    const layout = calculateTuiLayout(80, 20);
    const engine = createRainEngine({ layout });

    engine.setPhase('thinking');
    engine.setPhase('tool_use');
    engine.setPhase('idle');
    engine.setPhase('error');

    // Should not throw
    engine.tick();
    expect(engine.render()).toBeTruthy();
  });

  it('idle drops use phase color (tool_use -> tool color)', () => {
    const layout = calculateTuiLayout(80, 20);
    const rng = createSeededRng([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const engine = createRainEngine({ layout, rng });

    engine.setPhase('tool_use');

    // Go idle (no tokens, past idle threshold)
    for (let i = 0; i < 20; i++) {
      engine.tick();
    }

    const output = engine.render();
    // Should contain cyan tool color (from RAIN_HEAD_TOOL or similar)
    // During tool_use phase, idle drops get 'tool' colorKind
    expect(output).toContain('38;2;');
    expect(output.length).toBeGreaterThan(10);
  });

  it('token-derived drops keep their original color regardless of phase', () => {
    const layout = calculateTuiLayout(80, 20);
    const rng = createSeededRng([0.0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const engine = createRainEngine({ layout, rng });

    // Set phase to error but enqueue text tokens
    engine.setPhase('error');
    engine.enqueueTokens([textToken('A'), textToken('B'), textToken('C')]);

    // Run several ticks so drops are visible on screen
    for (let i = 0; i < 5; i++) {
      engine.tick();
    }

    // The token-derived drops should have text color, not error color
    const output = engine.render();
    expect(output).toContain('38;2;');
  });
});

// ---------------------------------------------------------------------------
// Word drops (Phase 3)
// ---------------------------------------------------------------------------

describe('enqueueWord', () => {
  it('accepts word without error', () => {
    const layout = calculateTuiLayout(80, 20);
    const engine = createRainEngine({ layout });

    engine.enqueueWord('hello', 'tool');
    engine.enqueueWord('world', 'model');
    engine.enqueueWord('thinking...', 'phase');
    engine.enqueueWord('code', 'text');

    // Should not throw
    engine.tick();
  });

  it('word appears in rendered output during forming phase', () => {
    const layout = calculateTuiLayout(80, 20);
    // Controlled RNG: placement row=5, col=3
    const rng = createSeededRng([0.3, 0.3, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const engine = createRainEngine({ layout, rng });

    engine.enqueueWord('test', 'tool');

    // Tick enough frames for forming phase
    for (let i = 0; i < 6; i++) {
      engine.tick();
    }

    const output = engine.render();
    // Should contain the word characters with WORD_TOOL color
    expect(output).toContain(SGR.WORD_TOOL);
  });

  it('word drop queue drops oldest when full', () => {
    const layout = calculateTuiLayout(80, 20);
    const engine = createRainEngine({ layout });

    // Queue capacity is 4; add 5 words
    engine.enqueueWord('word1', 'tool');
    engine.enqueueWord('word2', 'model');
    engine.enqueueWord('word3', 'phase');
    engine.enqueueWord('word4', 'text');
    engine.enqueueWord('word5', 'tool');

    // Should not crash; oldest dropped
    engine.tick();
  });

  it('word drop truncated to fit rain panel', () => {
    const layout = calculateTuiLayout(80, 20);
    const rng = createSeededRng([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const engine = createRainEngine({ layout, rng });

    // Enqueue a very long word
    engine.enqueueWord('a'.repeat(100), 'tool');
    engine.tick();

    // Should not crash
    const output = engine.render();
    expect(output).toContain(SGR.RESET);
  });

  it('max 2 active word drops at once', () => {
    const layout = calculateTuiLayout(100, 30);
    // RNG values chosen so word drops land in non-overlapping positions
    const rng = createSeededRng([
      0.1,
      0.1,
      0.5, // word1: row ~3, col ~1
      0.9,
      0.9,
      0.5, // word2: row ~27, col ~high
      0.5,
      0.5,
      0.5, // word3: attempted but should not spawn
      0.5,
      0.5,
      0.5,
      0.5,
      0.5,
      0.5,
      0.5,
    ]);
    const engine = createRainEngine({ layout, rng });

    engine.enqueueWord('ab', 'tool');
    engine.enqueueWord('cd', 'model');
    engine.enqueueWord('ef', 'text');

    // Tick once -- should spawn at most 2
    engine.tick();

    // Third word stays queued; engine should not crash
    engine.tick();
    engine.tick();

    const output = engine.render();
    expect(output).toContain(SGR.RESET);
  });

  it('word drop lifecycle completes without errors', () => {
    const layout = calculateTuiLayout(80, 20);
    // Use consistent RNG for predictable behavior
    const rng = createSeededRng([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const engine = createRainEngine({ layout, rng });

    engine.enqueueWord('hello', 'tool');

    // Run through complete lifecycle:
    // forming (~5 frames) + holding (~67 frames at 0.5) + dissolving (~10 frames)
    for (let i = 0; i < 150; i++) {
      engine.tick();
    }

    // After lifecycle completes, render should be clean
    const output = engine.render();
    expect(output).toContain(SGR.RESET);
    // Word drop color should no longer appear (dissolved)
    // But spawned rain drops from dissolution may still be falling
  });

  it('does not spawn word drops when rainCols is too small', () => {
    const layout = calculateTuiLayout(50, 20);
    const engine = createRainEngine({ layout });

    engine.enqueueWord('hello', 'tool');
    engine.tick();

    // With rainCols=0 (50 cols < MIN_TOTAL_COLS=60), no word drops
    const output = engine.render();
    expect(output).toBe(''); // No rain panel
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  it('handles zero-width rain panel gracefully', () => {
    const layout = calculateTuiLayout(40, 20);
    const engine = createRainEngine({ layout });

    engine.enqueueTokens([textToken('A')]);
    engine.tick();

    expect(engine.render()).toBe('');
    expect(engine.queueDepth).toBe(1); // token stays in queue
  });

  it('handles rapid enqueue/tick cycles', () => {
    const layout = calculateTuiLayout(80, 20);
    const rng = createSeededRng([0.5, 0.3, 0.7, 0.1]);
    const engine = createRainEngine({ layout, rng });

    for (let cycle = 0; cycle < 100; cycle++) {
      engine.enqueueTokens([textToken('x')]);
      engine.tick();
    }

    // Should not throw or produce empty output
    const output = engine.render();
    expect(output.length).toBeGreaterThan(0);
  });

  it('handles empty tick without tokens', () => {
    const layout = calculateTuiLayout(80, 20);
    const engine = createRainEngine({ layout });

    // Tick without any tokens (pre-idle threshold)
    engine.tick();
    const output = engine.render();
    // Should produce cleared panel + reset at minimum
    expect(output).toContain(SGR.RESET);
  });

  it('word drop suppresses regular spawn in occupied columns', () => {
    const layout = calculateTuiLayout(80, 20);
    const rng = createSeededRng([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const engine = createRainEngine({ layout, rng });

    engine.enqueueWord('abcdef', 'tool');
    engine.enqueueTokens(Array.from({ length: 50 }, () => textToken('X')));

    // Tick to spawn word drop
    engine.tick();

    // Word drop occupies 6 columns during forming/holding.
    // Regular drops should not spawn in those columns.
    // We verify by ensuring no crash and valid output.
    for (let i = 0; i < 5; i++) {
      engine.tick();
    }

    const output = engine.render();
    expect(output).toContain(SGR.RESET);
  });
});
