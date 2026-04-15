/**
 * Tests for observe-tui-text-panel -- text panel for the observe TUI.
 */

import { describe, it, expect } from 'vitest';
import { createTextPanel, type TextPanelOptions } from '../src/observe/observe-tui-text-panel.js';
import type { TokenStreamEvent } from '../src/docker/token-stream-types.js';
import { SGR, TEXT_BUFFER_CAPACITY } from '../src/observe/observe-tui-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip ANSI escape sequences to get plain text. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** Standard panel options for most tests. */
const DEFAULT_OPTS: TextPanelOptions = { raw: false, showLabel: false };
const RAW_OPTS: TextPanelOptions = { raw: true, showLabel: false };
const LABEL_OPTS: TextPanelOptions = { raw: false, showLabel: true };
const RAW_LABEL_OPTS: TextPanelOptions = { raw: true, showLabel: true };

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

// ---------------------------------------------------------------------------
// text_delta accumulation
// ---------------------------------------------------------------------------

describe('text_delta accumulation', () => {
  it('accumulates text without newlines as partial line', () => {
    const panel = createTextPanel(0, 80, 20);
    panel.appendEvent(0, textDelta('hello '), DEFAULT_OPTS);
    panel.appendEvent(0, textDelta('world'), DEFAULT_OPTS);

    // No finalized lines yet
    expect(panel.lineCount).toBe(0);

    // But render should show the partial
    const output = panel.render();
    const plain = stripAnsi(output);
    expect(plain).toContain('hello world');
  });

  it('finalizes line when newline is encountered', () => {
    const panel = createTextPanel(0, 80, 20);
    panel.appendEvent(0, textDelta('hello\n'), DEFAULT_OPTS);

    expect(panel.lineCount).toBe(1);

    const output = panel.render();
    const plain = stripAnsi(output);
    expect(plain).toContain('hello');
  });

  it('handles embedded newlines splitting into multiple lines', () => {
    const panel = createTextPanel(0, 80, 20);
    panel.appendEvent(0, textDelta('line1\nline2\nline3\n'), DEFAULT_OPTS);

    expect(panel.lineCount).toBe(3);

    const output = panel.render();
    const plain = stripAnsi(output);
    expect(plain).toContain('line1');
    expect(plain).toContain('line2');
    expect(plain).toContain('line3');
  });

  it('accumulates across multiple deltas before newline', () => {
    const panel = createTextPanel(0, 80, 20);
    panel.appendEvent(0, textDelta('foo'), DEFAULT_OPTS);
    panel.appendEvent(0, textDelta('bar'), DEFAULT_OPTS);
    panel.appendEvent(0, textDelta('baz\n'), DEFAULT_OPTS);

    expect(panel.lineCount).toBe(1);

    const output = panel.render();
    const plain = stripAnsi(output);
    expect(plain).toContain('foobarbaz');
  });

  it('starts new partial after finalization', () => {
    const panel = createTextPanel(0, 80, 20);
    panel.appendEvent(0, textDelta('first\nsecond'), DEFAULT_OPTS);

    // 'first' is finalized, 'second' is partial
    expect(panel.lineCount).toBe(1);

    const output = panel.render();
    const plain = stripAnsi(output);
    expect(plain).toContain('first');
    expect(plain).toContain('second');
  });

  it('handles empty segments from consecutive newlines', () => {
    const panel = createTextPanel(0, 80, 20);
    panel.appendEvent(0, textDelta('a\n\nb\n'), DEFAULT_OPTS);

    // 'a' + empty line + 'b' = 3 finalized lines
    expect(panel.lineCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Partial line rendering
// ---------------------------------------------------------------------------

describe('Partial line rendering', () => {
  it('renders partial line at current length without wrapping', () => {
    const panel = createTextPanel(0, 20, 5);
    // Send text longer than panel width but no newline
    panel.appendEvent(0, textDelta('this is a long partial line that exceeds width'), DEFAULT_OPTS);

    expect(panel.lineCount).toBe(0);

    const output = panel.render();
    const plain = stripAnsi(output);
    // Partial should be truncated for display
    expect(plain).toContain('this is a long');
  });

  it('shows partial line after finalized lines', () => {
    const panel = createTextPanel(0, 80, 10);
    panel.appendEvent(0, textDelta('finalized\n'), DEFAULT_OPTS);
    panel.appendEvent(0, textDelta('still partial'), DEFAULT_OPTS);

    const output = panel.render();
    const plain = stripAnsi(output);
    expect(plain).toContain('finalized');
    expect(plain).toContain('still partial');
  });
});

// ---------------------------------------------------------------------------
// Word wrapping
// ---------------------------------------------------------------------------

describe('Word wrapping', () => {
  it('wraps finalized line at word boundary', () => {
    const panel = createTextPanel(0, 20, 10);
    panel.appendEvent(0, textDelta('hello world this is a test\n'), DEFAULT_OPTS);

    // Should produce multiple finalized lines due to wrapping
    expect(panel.lineCount).toBeGreaterThan(1);

    const output = panel.render();
    const plain = stripAnsi(output);
    expect(plain).toContain('hello world this is');
  });

  it('hard-breaks when no space is found', () => {
    const panel = createTextPanel(0, 10, 10);
    panel.appendEvent(0, textDelta('abcdefghijklmnopqrstuvwxyz\n'), DEFAULT_OPTS);

    // Should hard-break at width
    expect(panel.lineCount).toBeGreaterThan(1);
  });

  it('continuation lines are indented by label width when showLabel', () => {
    const panel = createTextPanel(0, 30, 10);
    // With label, prefix is "[0] " = 4 chars, leaving 26 for content
    const longText = 'word '.repeat(10) + '\n'; // 50 chars
    panel.appendEvent(0, textDelta(longText), LABEL_OPTS);

    expect(panel.lineCount).toBeGreaterThan(1);

    const output = panel.render();
    const plain = stripAnsi(output);

    // First line should have label prefix
    expect(plain).toContain('[0]');
  });

  it('does not wrap short lines', () => {
    const panel = createTextPanel(0, 80, 10);
    panel.appendEvent(0, textDelta('short\n'), DEFAULT_OPTS);

    expect(panel.lineCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Ring buffer capacity and eviction
// ---------------------------------------------------------------------------

describe('Ring buffer', () => {
  it('stores lines up to capacity', () => {
    const panel = createTextPanel(0, 80, 20);

    for (let i = 0; i < 100; i++) {
      panel.appendEvent(0, textDelta(`line ${i}\n`), DEFAULT_OPTS);
    }

    expect(panel.lineCount).toBe(100);
  });

  it('evicts oldest lines when at capacity', () => {
    const panel = createTextPanel(0, 80, 20);

    // Fill beyond capacity
    for (let i = 0; i < TEXT_BUFFER_CAPACITY + 50; i++) {
      panel.appendEvent(0, textDelta(`line ${i}\n`), DEFAULT_OPTS);
    }

    expect(panel.lineCount).toBe(TEXT_BUFFER_CAPACITY);

    // Render should show the most recent lines, not the oldest
    const output = panel.render();
    const plain = stripAnsi(output);

    // The very first line should have been evicted
    expect(plain).not.toContain('line 0 ');
    // Recent lines should be present
    expect(plain).toContain(`line ${TEXT_BUFFER_CAPACITY + 49}`);
  });

  it('handles capacity boundary correctly', () => {
    const panel = createTextPanel(0, 80, 5);

    for (let i = 0; i < TEXT_BUFFER_CAPACITY; i++) {
      panel.appendEvent(0, textDelta(`x${i}\n`), DEFAULT_OPTS);
    }

    expect(panel.lineCount).toBe(TEXT_BUFFER_CAPACITY);

    // Add one more to trigger eviction
    panel.appendEvent(0, textDelta('overflow\n'), DEFAULT_OPTS);
    expect(panel.lineCount).toBe(TEXT_BUFFER_CAPACITY);
  });
});

// ---------------------------------------------------------------------------
// Event type formatting
// ---------------------------------------------------------------------------

describe('tool_use formatting', () => {
  it('shows tool name with cyan marker in raw mode', () => {
    const panel = createTextPanel(0, 80, 10);
    panel.appendEvent(0, toolUse('filesystem__read_file', '{"path":"/src/foo.ts"}'), RAW_OPTS);

    expect(panel.lineCount).toBe(1);

    const output = panel.render();
    expect(output).toContain(SGR.TEXT_TOOL);
    const plain = stripAnsi(output);
    expect(plain).toContain('\u25B8 filesystem__read_file');
    expect(plain).toContain('/src/foo.ts');
  });

  it('is suppressed when not in raw mode', () => {
    const panel = createTextPanel(0, 80, 10);
    panel.appendEvent(0, toolUse('read_file', '{}'), DEFAULT_OPTS);

    expect(panel.lineCount).toBe(0);
  });

  it('truncates long tool input', () => {
    const panel = createTextPanel(0, 40, 10);
    const longInput = '{"path":"/' + 'a'.repeat(200) + '"}';
    panel.appendEvent(0, toolUse('tool', longInput), RAW_OPTS);

    expect(panel.lineCount).toBe(1);

    const output = panel.render();
    const plain = stripAnsi(output);
    // Should contain the ellipsis
    expect(plain).toContain('\u2026');
  });
});

describe('message_start formatting', () => {
  it('shows model name as separator in raw mode', () => {
    const panel = createTextPanel(0, 60, 10);
    panel.appendEvent(0, messageStart('claude-sonnet-4-20250514'), RAW_OPTS);

    expect(panel.lineCount).toBe(1);

    const output = panel.render();
    expect(output).toContain(SGR.TEXT_SEPARATOR);
    const plain = stripAnsi(output);
    expect(plain).toContain('claude-sonnet-4-20250514');
    expect(plain).toContain('\u2500'); // dash separator
  });

  it('is suppressed when not in raw mode', () => {
    const panel = createTextPanel(0, 80, 10);
    panel.appendEvent(0, messageStart('model'), DEFAULT_OPTS);

    expect(panel.lineCount).toBe(0);
  });
});

describe('message_end formatting', () => {
  it('shows stop reason and token counts in raw mode', () => {
    const panel = createTextPanel(0, 80, 10);
    panel.appendEvent(0, messageEnd('end_turn', 1234, 567), RAW_OPTS);

    expect(panel.lineCount).toBe(1);

    const output = panel.render();
    const plain = stripAnsi(output);
    expect(plain).toContain('end_turn');
    expect(plain).toContain('1234+567 tokens');
  });

  it('is suppressed when not in raw mode', () => {
    const panel = createTextPanel(0, 80, 10);
    panel.appendEvent(0, messageEnd('end_turn', 100, 50), DEFAULT_OPTS);

    expect(panel.lineCount).toBe(0);
  });
});

describe('error formatting', () => {
  it('shows error in red', () => {
    const panel = createTextPanel(0, 80, 10);
    panel.appendEvent(0, errorEvent('Connection refused'), DEFAULT_OPTS);

    expect(panel.lineCount).toBe(1);

    const output = panel.render();
    expect(output).toContain(SGR.TEXT_ERROR);
    const plain = stripAnsi(output);
    expect(plain).toContain('\u2717 Connection refused');
  });

  it('is always shown regardless of raw mode', () => {
    const panel = createTextPanel(0, 80, 10);
    panel.appendEvent(0, errorEvent('test error'), DEFAULT_OPTS);

    expect(panel.lineCount).toBe(1);
  });
});

describe('raw event formatting', () => {
  it('shows event type and data in dim text when raw', () => {
    const panel = createTextPanel(0, 80, 10);
    panel.appendEvent(0, rawEvent('content_block_start', '{"type":"text"}'), RAW_OPTS);

    expect(panel.lineCount).toBe(1);

    const output = panel.render();
    expect(output).toContain(SGR.TEXT_META);
    const plain = stripAnsi(output);
    expect(plain).toContain('[content_block_start]');
    expect(plain).toContain('{"type":"text"}');
  });

  it('is suppressed when not in raw mode', () => {
    const panel = createTextPanel(0, 80, 10);
    panel.appendEvent(0, rawEvent('ping', ''), DEFAULT_OPTS);

    expect(panel.lineCount).toBe(0);
  });

  it('truncates long raw data', () => {
    const panel = createTextPanel(0, 40, 10);
    const longData = 'x'.repeat(200);
    panel.appendEvent(0, rawEvent('evt', longData), RAW_OPTS);

    expect(panel.lineCount).toBe(1);
    const output = panel.render();
    const plain = stripAnsi(output);
    expect(plain).toContain('\u2026');
  });
});

// ---------------------------------------------------------------------------
// Session label prefixing
// ---------------------------------------------------------------------------

describe('Session label prefixing', () => {
  it('prefixes lines with session label when showLabel is true', () => {
    const panel = createTextPanel(0, 80, 10);
    panel.appendEvent(2, textDelta('hello\n'), LABEL_OPTS);

    const output = panel.render();
    const plain = stripAnsi(output);
    expect(plain).toContain('[2] hello');
  });

  it('uses session color for label', () => {
    const panel = createTextPanel(0, 80, 10);
    panel.appendEvent(1, textDelta('test\n'), LABEL_OPTS);

    const output = panel.render();
    // Session 1 uses SESSION_1 color (cyan)
    expect(output).toContain(SGR.SESSION_1);
  });

  it('does not prefix when showLabel is false', () => {
    const panel = createTextPanel(0, 80, 10);
    panel.appendEvent(0, textDelta('no label\n'), DEFAULT_OPTS);

    const output = panel.render();
    const plain = stripAnsi(output);
    expect(plain).not.toContain('[0]');
    expect(plain).toContain('no label');
  });

  it('prefixes tool_use with label in raw+label mode', () => {
    const panel = createTextPanel(0, 80, 10);
    panel.appendEvent(3, toolUse('my_tool', '{}'), RAW_LABEL_OPTS);

    const output = panel.render();
    const plain = stripAnsi(output);
    expect(plain).toContain('[3]');
    expect(plain).toContain('\u25B8 my_tool');
  });

  it('prefixes error with label when showLabel', () => {
    const panel = createTextPanel(0, 80, 10);
    panel.appendEvent(4, errorEvent('oops'), LABEL_OPTS);

    const output = panel.render();
    const plain = stripAnsi(output);
    expect(plain).toContain('[4]');
    expect(plain).toContain('\u2717 oops');
  });
});

// ---------------------------------------------------------------------------
// Multi-session interleaving
// ---------------------------------------------------------------------------

describe('Multi-session interleaving', () => {
  it('tracks separate partial lines per session', () => {
    const panel = createTextPanel(0, 80, 10);
    panel.appendEvent(0, textDelta('session-0-'), LABEL_OPTS);
    panel.appendEvent(1, textDelta('session-1-'), LABEL_OPTS);
    panel.appendEvent(0, textDelta('continued\n'), LABEL_OPTS);
    panel.appendEvent(1, textDelta('also continued\n'), LABEL_OPTS);

    expect(panel.lineCount).toBe(2);

    const output = panel.render();
    const plain = stripAnsi(output);
    expect(plain).toContain('[0] session-0-continued');
    expect(plain).toContain('[1] session-1-also continued');
  });

  it('interleaves finalized lines from different sessions', () => {
    const panel = createTextPanel(0, 80, 10);
    panel.appendEvent(0, textDelta('from zero\n'), LABEL_OPTS);
    panel.appendEvent(1, textDelta('from one\n'), LABEL_OPTS);
    panel.appendEvent(0, textDelta('zero again\n'), LABEL_OPTS);

    expect(panel.lineCount).toBe(3);

    const output = panel.render();
    const plain = stripAnsi(output);
    // Verify ordering is preserved
    const zeroPos = plain.indexOf('from zero');
    const onePos = plain.indexOf('from one');
    const zeroAgainPos = plain.indexOf('zero again');
    expect(zeroPos).toBeLessThan(onePos);
    expect(onePos).toBeLessThan(zeroAgainPos);
  });

  it('renders multiple partial lines from different sessions', () => {
    const panel = createTextPanel(0, 80, 10);
    panel.appendEvent(0, textDelta('partial-zero'), LABEL_OPTS);
    panel.appendEvent(1, textDelta('partial-one'), LABEL_OPTS);

    expect(panel.lineCount).toBe(0);

    const output = panel.render();
    const plain = stripAnsi(output);
    expect(plain).toContain('partial-zero');
    expect(plain).toContain('partial-one');
  });
});

// ---------------------------------------------------------------------------
// sessionEnded and connectionLost markers
// ---------------------------------------------------------------------------

describe('sessionEnded', () => {
  it('adds a separator line with session number and reason', () => {
    const panel = createTextPanel(0, 80, 10);
    panel.sessionEnded(2, 'task complete', false);

    expect(panel.lineCount).toBe(1);

    const output = panel.render();
    expect(output).toContain(SGR.TEXT_SEPARATOR);
    const plain = stripAnsi(output);
    expect(plain).toContain('session 2 ended');
    expect(plain).toContain('task complete');
    expect(plain).toContain('\u2500'); // dash separator
  });

  it('does not add label prefix when showLabel is false', () => {
    const panel = createTextPanel(0, 80, 10);
    panel.sessionEnded(2, 'task complete', false);

    const output = panel.render();
    const plain = stripAnsi(output);
    expect(plain).not.toContain('[2]');
    expect(plain).toContain('session 2 ended');
  });

  it('adds label prefix when showLabel is true', () => {
    const panel = createTextPanel(0, 80, 10);
    panel.sessionEnded(2, 'task complete', true);

    const output = panel.render();
    const plain = stripAnsi(output);
    expect(plain).toContain('[2]');
    expect(plain).toContain('session 2 ended');
  });

  it('flushes partial line buffer before adding end marker', () => {
    const panel = createTextPanel(0, 80, 10);
    // Accumulate a partial line (no trailing newline)
    panel.appendEvent(3, textDelta('unfinished output'), LABEL_OPTS);

    expect(panel.lineCount).toBe(0); // still partial

    panel.sessionEnded(3, 'completed', true);

    // Should have 2 lines: the flushed partial + the end marker
    expect(panel.lineCount).toBe(2);

    const output = panel.render();
    const plain = stripAnsi(output);
    expect(plain).toContain('unfinished output');
    expect(plain).toContain('session 3 ended');
  });

  it('does not add empty line when no partial exists', () => {
    const panel = createTextPanel(0, 80, 10);
    panel.appendEvent(1, textDelta('complete line\n'), LABEL_OPTS);

    expect(panel.lineCount).toBe(1);

    panel.sessionEnded(1, 'done', true);

    // Only the finalized line + end marker, no spurious empty line
    expect(panel.lineCount).toBe(2);
  });
});

describe('connectionLost', () => {
  it('adds an error marker with reason', () => {
    const panel = createTextPanel(0, 80, 10);
    panel.connectionLost('WebSocket closed unexpectedly');

    expect(panel.lineCount).toBe(1);

    const output = panel.render();
    expect(output).toContain(SGR.TEXT_ERROR);
    const plain = stripAnsi(output);
    expect(plain).toContain('\u2717 connection lost');
    expect(plain).toContain('WebSocket closed unexpectedly');
  });
});

// ---------------------------------------------------------------------------
// Rendering viewport
// ---------------------------------------------------------------------------

describe('Render viewport', () => {
  it('shows last textRows lines when more lines than viewport', () => {
    const panel = createTextPanel(0, 80, 5);

    for (let i = 0; i < 20; i++) {
      panel.appendEvent(0, textDelta(`line ${i}\n`), DEFAULT_OPTS);
    }

    const output = panel.render();
    const plain = stripAnsi(output);

    // Should show lines 15-19 (last 5)
    expect(plain).toContain('line 19');
    expect(plain).toContain('line 15');
    expect(plain).not.toContain('line 0 ');
  });

  it('positions lines using cursor escape sequences', () => {
    const panel = createTextPanel(20, 60, 10);
    panel.appendEvent(0, textDelta('test\n'), DEFAULT_OPTS);

    const output = panel.render();
    // Should position at column 21 (1-indexed)
    expect(output).toContain('\x1b[1;21H');
  });

  it('clears each line with erase-to-EOL', () => {
    const panel = createTextPanel(0, 80, 5);
    panel.appendEvent(0, textDelta('test\n'), DEFAULT_OPTS);

    const output = panel.render();
    // Each line should have \x1b[K (erase to end of line)
    expect(output).toContain('\x1b[K');
  });

  it('ends with SGR reset', () => {
    const panel = createTextPanel(0, 80, 5);
    panel.appendEvent(0, textDelta('test\n'), DEFAULT_OPTS);

    const output = panel.render();
    expect(output).toContain(SGR.RESET);
  });

  it('renders empty panel without errors', () => {
    const panel = createTextPanel(0, 80, 10);
    const output = panel.render();

    // Should still produce cursor positioning for empty rows
    expect(output).toContain('\x1b[1;1H\x1b[K');
    expect(output).toContain(SGR.RESET);
  });
});

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------

describe('resize', () => {
  it('updates dimensions for new lines', () => {
    const panel = createTextPanel(0, 80, 10);
    panel.appendEvent(0, textDelta('before resize\n'), DEFAULT_OPTS);

    panel.resize(10, 40, 5);
    panel.appendEvent(0, textDelta('after resize\n'), DEFAULT_OPTS);

    const output = panel.render();
    // After resize, cursor should use new startCol (10 + 1 = 11)
    expect(output).toContain('\x1b[1;11H');
  });

  it('adjusts viewport to new row count', () => {
    const panel = createTextPanel(0, 80, 20);

    for (let i = 0; i < 15; i++) {
      panel.appendEvent(0, textDelta(`line ${i}\n`), DEFAULT_OPTS);
    }

    // Shrink viewport
    panel.resize(0, 80, 5);
    const output = panel.render();
    const plain = stripAnsi(output);

    // Should only show last 5 lines
    expect(plain).toContain('line 14');
    expect(plain).toContain('line 10');
  });
});
