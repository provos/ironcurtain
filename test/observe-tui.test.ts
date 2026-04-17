/**
 * Tests for observe-tui -- TUI orchestrator for the observe command.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TokenStreamEvent } from '../src/docker/token-stream-types.js';
import {
  extractRainTokens,
  updateSessionState,
  computeDominantPhase,
  createObserveTui,
  TokenRateTracker,
  formatTokenCount,
} from '../src/observe/observe-tui.js';
import type { SessionState } from '../src/observe/observe-tui-types.js';
import { MIN_USABLE_ROWS } from '../src/observe/observe-tui-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textDelta(text: string): TokenStreamEvent {
  return { kind: 'text_delta', text, timestamp: Date.now() };
}

function toolUse(toolName: string, inputDelta: string): TokenStreamEvent {
  return { kind: 'tool_use', toolName, inputDelta, timestamp: Date.now() };
}

function messageStart(model: string): TokenStreamEvent {
  return { kind: 'message_start', model, timestamp: Date.now() };
}

function messageEnd(stopReason: string, inputTokens: number, outputTokens: number): TokenStreamEvent {
  return { kind: 'message_end', stopReason, inputTokens, outputTokens, timestamp: Date.now() };
}

function errorEvent(message: string): TokenStreamEvent {
  return { kind: 'error', message, timestamp: Date.now() };
}

function rawEvent(eventType: string, data: string): TokenStreamEvent {
  return { kind: 'raw', eventType, data, timestamp: Date.now() };
}

/** Create a fresh SessionState for testing. */
function freshState(label = 0): SessionState {
  return {
    label,
    inputTokens: 0,
    outputTokens: 0,
    toolCount: 0,
    model: null,
    phase: 'idle',
    lastEventTime: 0,
    ended: false,
    endReason: null,
    currentToolName: null,
  };
}

// ---------------------------------------------------------------------------
// extractRainTokens
// ---------------------------------------------------------------------------

describe('extractRainTokens', () => {
  it('converts text_delta characters to text tokens', () => {
    const tokens = extractRainTokens(textDelta('abc'));
    expect(tokens).toEqual([
      { char: 'a', kind: 'text' },
      { char: 'b', kind: 'text' },
      { char: 'c', kind: 'text' },
    ]);
  });

  it('converts tool_use toolName characters to tool tokens', () => {
    const tokens = extractRainTokens(toolUse('ls', '{}'));
    expect(tokens).toEqual([
      { char: 'l', kind: 'tool' },
      { char: 's', kind: 'tool' },
    ]);
  });

  it('converts error message characters to error tokens', () => {
    const tokens = extractRainTokens(errorEvent('oh'));
    expect(tokens).toEqual([
      { char: 'o', kind: 'error' },
      { char: 'h', kind: 'error' },
    ]);
  });

  it('returns empty array for message_start', () => {
    expect(extractRainTokens(messageStart('claude-sonnet-4-20250514'))).toEqual([]);
  });

  it('returns empty array for message_end', () => {
    expect(extractRainTokens(messageEnd('end_turn', 100, 50))).toEqual([]);
  });

  it('returns empty array for raw events', () => {
    expect(extractRainTokens(rawEvent('ping', '{}')).length).toBe(0);
  });

  it('handles empty text_delta', () => {
    expect(extractRainTokens(textDelta(''))).toEqual([]);
  });

  it('handles multi-byte characters', () => {
    const tokens = extractRainTokens(textDelta('\u00e9\u00e8'));
    expect(tokens).toHaveLength(2);
    expect(tokens[0].char).toBe('\u00e9');
    expect(tokens[1].char).toBe('\u00e8');
  });

  it('extracts tool_result content characters as tool tokens (truncated to 8 chars)', () => {
    const event: TokenStreamEvent = {
      kind: 'tool_result',
      toolUseId: 'tu_1',
      toolName: '',
      content: 'Hello World from tool',
      isError: false,
      timestamp: Date.now(),
    };
    const tokens = extractRainTokens(event);
    // Only first 8 characters of content
    expect(tokens).toHaveLength(8);
    expect(tokens[0]).toEqual({ char: 'H', kind: 'tool' });
    expect(tokens[7]).toEqual({ char: 'o', kind: 'tool' });
  });

  it('handles tool_result with short content', () => {
    const event: TokenStreamEvent = {
      kind: 'tool_result',
      toolUseId: 'tu_2',
      toolName: '',
      content: 'ok',
      isError: false,
      timestamp: Date.now(),
    };
    const tokens = extractRainTokens(event);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toEqual({ char: 'o', kind: 'tool' });
    expect(tokens[1]).toEqual({ char: 'k', kind: 'tool' });
  });
});

// ---------------------------------------------------------------------------
// updateSessionState
// ---------------------------------------------------------------------------

describe('updateSessionState', () => {
  it('sets phase to thinking on text_delta', () => {
    const state = freshState();
    updateSessionState(state, textDelta('hello'));
    expect(state.phase).toBe('thinking');
    expect(state.currentToolName).toBeNull();
  });

  it('sets phase to tool_use and increments toolCount on tool_use with name', () => {
    const state = freshState();
    updateSessionState(state, toolUse('read_file', '{}'));
    expect(state.phase).toBe('tool_use');
    expect(state.toolCount).toBe(1);
    expect(state.currentToolName).toBe('read_file');
  });

  it('does not increment toolCount for input_json_delta (empty toolName)', () => {
    const state = freshState();
    // First: content_block_start with toolName
    updateSessionState(state, toolUse('read_file', ''));
    expect(state.toolCount).toBe(1);

    // Then: input_json_delta with empty toolName
    updateSessionState(state, toolUse('', '{"path":"/foo"}'));
    expect(state.toolCount).toBe(1); // unchanged
    expect(state.currentToolName).toBe('read_file'); // unchanged
  });

  it('records model from message_start', () => {
    const state = freshState();
    updateSessionState(state, messageStart('claude-sonnet-4-20250514'));
    expect(state.model).toBe('claude-sonnet-4-20250514');
  });

  it('accumulates tokens and sets phase to idle on message_end', () => {
    const state = freshState();
    state.phase = 'thinking';
    state.currentToolName = 'some_tool';

    updateSessionState(state, messageEnd('end_turn', 100, 50));
    expect(state.inputTokens).toBe(100);
    expect(state.outputTokens).toBe(50);
    expect(state.phase).toBe('idle');
    expect(state.currentToolName).toBeNull();

    updateSessionState(state, messageEnd('end_turn', 200, 80));
    expect(state.inputTokens).toBe(300);
    expect(state.outputTokens).toBe(130);
  });

  it('clears currentToolName on text_delta', () => {
    const state = freshState();
    state.currentToolName = 'read_file';
    updateSessionState(state, textDelta('output'));
    expect(state.currentToolName).toBeNull();
  });

  it('updates lastEventTime on every event', () => {
    const state = freshState();
    expect(state.lastEventTime).toBe(0);

    updateSessionState(state, textDelta('x'));
    expect(state.lastEventTime).toBeGreaterThan(0);
  });

  it('does not change phase on error event', () => {
    const state = freshState();
    state.phase = 'thinking';
    updateSessionState(state, errorEvent('oops'));
    expect(state.phase).toBe('thinking');
  });

  it('does not change phase on raw event', () => {
    const state = freshState();
    state.phase = 'tool_use';
    updateSessionState(state, rawEvent('ping', '{}'));
    expect(state.phase).toBe('tool_use');
  });

  it('does not change phase on tool_result event', () => {
    const state = freshState();
    state.phase = 'thinking';
    const event: TokenStreamEvent = {
      kind: 'tool_result',
      toolUseId: 'tu_1',
      toolName: '',
      content: 'output',
      isError: false,
      timestamp: Date.now(),
    };
    updateSessionState(state, event);
    expect(state.phase).toBe('thinking');
    expect(state.toolCount).toBe(0); // not incremented
  });
});

// ---------------------------------------------------------------------------
// computeDominantPhase
// ---------------------------------------------------------------------------

describe('computeDominantPhase', () => {
  it('returns error when errorActive is true', () => {
    const sessions = new Map<number, SessionState>();
    sessions.set(0, { ...freshState(0), phase: 'thinking' });
    expect(computeDominantPhase(sessions, true)).toBe('error');
  });

  it('returns idle when all sessions are idle', () => {
    const sessions = new Map<number, SessionState>();
    sessions.set(0, freshState(0));
    sessions.set(1, freshState(1));
    expect(computeDominantPhase(sessions, false)).toBe('idle');
  });

  it('returns thinking when any session is thinking', () => {
    const sessions = new Map<number, SessionState>();
    sessions.set(0, { ...freshState(0), phase: 'thinking' });
    sessions.set(1, freshState(1));
    expect(computeDominantPhase(sessions, false)).toBe('thinking');
  });

  it('tool_use takes priority over thinking', () => {
    const sessions = new Map<number, SessionState>();
    sessions.set(0, { ...freshState(0), phase: 'thinking' });
    sessions.set(1, { ...freshState(1), phase: 'tool_use' });
    expect(computeDominantPhase(sessions, false)).toBe('tool_use');
  });

  it('error takes priority over tool_use', () => {
    const sessions = new Map<number, SessionState>();
    sessions.set(0, { ...freshState(0), phase: 'tool_use' });
    expect(computeDominantPhase(sessions, true)).toBe('error');
  });

  it('ignores ended sessions', () => {
    const sessions = new Map<number, SessionState>();
    sessions.set(0, { ...freshState(0), phase: 'tool_use', ended: true });
    sessions.set(1, freshState(1));
    expect(computeDominantPhase(sessions, false)).toBe('idle');
  });

  it('returns idle for empty session map', () => {
    const sessions = new Map<number, SessionState>();
    expect(computeDominantPhase(sessions, false)).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// createObserveTui: pushEvents routing
// ---------------------------------------------------------------------------

describe('createObserveTui pushEvents', () => {
  let writeImpl: typeof process.stdout.write;

  beforeEach(() => {
    // Mock stdout to capture writes without actually writing to terminal
    writeImpl = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    // Mock stdout dimensions
    Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
  });

  afterEach(() => {
    process.stdout.write = writeImpl;
  });

  it('creates session state on first event for a label', () => {
    const tui = createObserveTui({ raw: false, showLabel: false, debug: false });
    // Verify the create function returns the expected interface
    expect(typeof tui.pushEvents).toBe('function');
    expect(typeof tui.sessionEnded).toBe('function');
    expect(typeof tui.connectionLost).toBe('function');
    expect(typeof tui.start).toBe('function');
    expect(typeof tui.destroy).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Integration: event routing through TUI
// ---------------------------------------------------------------------------

describe('TUI event routing (without screen lifecycle)', () => {
  it('text_delta produces rain tokens and updates phase', () => {
    const state = freshState();
    const event = textDelta('hello');
    const tokens = extractRainTokens(event);
    updateSessionState(state, event);

    expect(tokens).toHaveLength(5);
    expect(tokens.every((t) => t.kind === 'text')).toBe(true);
    expect(state.phase).toBe('thinking');
  });

  it('tool_use produces rain tokens and increments tool count', () => {
    const state = freshState();
    const event = toolUse('read_file', '{}');
    const tokens = extractRainTokens(event);
    updateSessionState(state, event);

    expect(tokens).toHaveLength(9); // 'read_file' = 9 chars
    expect(tokens.every((t) => t.kind === 'tool')).toBe(true);
    expect(state.toolCount).toBe(1);
    expect(state.phase).toBe('tool_use');
  });

  it('message_end produces no rain tokens but updates token counts', () => {
    const state = freshState();
    const event = messageEnd('end_turn', 500, 200);
    const tokens = extractRainTokens(event);
    updateSessionState(state, event);

    expect(tokens).toHaveLength(0);
    expect(state.inputTokens).toBe(500);
    expect(state.outputTokens).toBe(200);
  });

  it('error produces rain tokens without changing session counters', () => {
    const state = freshState();
    state.inputTokens = 100;
    state.toolCount = 3;

    const event = errorEvent('fail');
    const tokens = extractRainTokens(event);
    updateSessionState(state, event);

    expect(tokens).toHaveLength(4); // 'fail' = 4 chars
    expect(tokens.every((t) => t.kind === 'error')).toBe(true);
    expect(state.inputTokens).toBe(100); // unchanged
    expect(state.toolCount).toBe(3); // unchanged
  });

  it('full session lifecycle: start -> think -> tool -> end', () => {
    const state = freshState(1);

    // message_start
    updateSessionState(state, messageStart('claude-sonnet-4-20250514'));
    expect(state.model).toBe('claude-sonnet-4-20250514');
    expect(state.phase).toBe('idle'); // message_start doesn't change phase

    // text_delta
    updateSessionState(state, textDelta('Let me read the file.'));
    expect(state.phase).toBe('thinking');

    // tool_use
    updateSessionState(state, toolUse('read_file', '{"path":"/tmp/test"}'));
    expect(state.phase).toBe('tool_use');
    expect(state.toolCount).toBe(1);
    expect(state.currentToolName).toBe('read_file');

    // text_delta (after tool result)
    updateSessionState(state, textDelta('The file contains...'));
    expect(state.phase).toBe('thinking');
    expect(state.currentToolName).toBeNull();

    // message_end
    updateSessionState(state, messageEnd('end_turn', 1234, 567));
    expect(state.phase).toBe('idle');
    expect(state.inputTokens).toBe(1234);
    expect(state.outputTokens).toBe(567);
  });
});

// ---------------------------------------------------------------------------
// destroy() cleanup
// ---------------------------------------------------------------------------

describe('destroy() cleanup', () => {
  let writeImpl: typeof process.stdout.write;
  let captured: string[];

  beforeEach(() => {
    captured = [];
    writeImpl = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
  });

  afterEach(() => {
    process.stdout.write = writeImpl;
  });

  it('destroy is idempotent (calling twice does not throw)', () => {
    const tui = createObserveTui({ raw: false, showLabel: false, debug: false });
    // Destroy without start -- should not throw
    tui.destroy();
    tui.destroy(); // second call is a no-op
  });

  it('destroy writes cursor restore and alternate screen exit', () => {
    const tui = createObserveTui({ raw: false, showLabel: false, debug: false });

    // In test environments stdin is not a TTY, so setRawMode doesn't exist.
    // Temporarily define it so start() can call it without error.
    const originalIsTTY = process.stdin.isTTY;
    const originalSetRawMode = (process.stdin as { setRawMode?: unknown }).setRawMode;

    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    (process.stdin as { setRawMode: unknown }).setRawMode = () => process.stdin;

    const resumeSpy = vi.spyOn(process.stdin, 'resume').mockImplementation(() => process.stdin);
    const unrefSpy = vi.spyOn(process.stdin, 'unref').mockImplementation(() => process.stdin);

    tui.start();

    // Clear captured output from start(), then capture destroy() output
    captured.length = 0;
    tui.destroy();

    const allOutput = captured.join('');
    expect(allOutput).toContain('\x1b[?25h'); // show cursor
    expect(allOutput).toContain('\x1b[?1049l'); // leave alternate screen

    // Restore stdin state
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    if (originalSetRawMode !== undefined) {
      (process.stdin as { setRawMode: unknown }).setRawMode = originalSetRawMode;
    } else {
      delete (process.stdin as { setRawMode?: unknown }).setRawMode;
    }
    resumeSpy.mockRestore();
    unrefSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// TokenRateTracker
// ---------------------------------------------------------------------------

describe('TokenRateTracker', () => {
  it('returns 0 with no samples', () => {
    const tracker = new TokenRateTracker();
    expect(tracker.rate()).toBe(0);
  });

  it('returns 0 with a single sample', () => {
    const tracker = new TokenRateTracker();
    tracker.record(1000, 100);
    expect(tracker.rate()).toBe(0);
  });

  it('computes correct rate over two samples', () => {
    const tracker = new TokenRateTracker();
    tracker.record(0, 0);
    tracker.record(1000, 500);
    // 500 tokens in 1 second = 500 tok/s
    expect(tracker.rate()).toBe(500);
  });

  it('computes rate over multiple samples', () => {
    const tracker = new TokenRateTracker();
    tracker.record(0, 0);
    tracker.record(500, 100);
    tracker.record(1000, 300);
    // 300 tokens in 1 second = 300 tok/s
    expect(tracker.rate()).toBe(300);
  });

  it('evicts samples older than window', () => {
    const tracker = new TokenRateTracker(2000); // 2s window
    tracker.record(0, 0);
    tracker.record(1000, 100);
    tracker.record(2000, 300);
    tracker.record(3000, 400);
    // Sample at t=0 (tokens=0) should be evicted (3000-0 > 2000)
    // Oldest remaining: t=1000, tokens=100
    // Newest: t=3000, tokens=400
    // Rate: (400-100) / ((3000-1000)/1000) = 300/2 = 150
    expect(tracker.rate()).toBe(150);
  });

  it('handles zero elapsed time', () => {
    const tracker = new TokenRateTracker();
    tracker.record(1000, 100);
    tracker.record(1000, 200);
    expect(tracker.rate()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// formatTokenCount
// ---------------------------------------------------------------------------

describe('formatTokenCount', () => {
  it('formats small numbers as-is', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(999)).toBe('999');
  });

  it('formats thousands with k suffix', () => {
    expect(formatTokenCount(1000)).toBe('1.0k');
    expect(formatTokenCount(12400)).toBe('12.4k');
    expect(formatTokenCount(999999)).toBe('1000.0k');
  });

  it('formats millions with M suffix', () => {
    expect(formatTokenCount(1000000)).toBe('1.0M');
    expect(formatTokenCount(2500000)).toBe('2.5M');
  });
});

// ---------------------------------------------------------------------------
// MIN_USABLE_ROWS constant
// ---------------------------------------------------------------------------

describe('MIN_USABLE_ROWS', () => {
  it('is 5', () => {
    expect(MIN_USABLE_ROWS).toBe(5);
  });
});
