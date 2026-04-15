/**
 * Tests for observe-renderer -- output formatting for `ironcurtain observe`.
 */

import { describe, it, expect } from 'vitest';
import chalk from 'chalk';
import {
  renderEventBatch,
  renderEvent,
  renderConnected,
  renderSessionEnded,
  type RenderOptions,
} from '../src/observe/observe-renderer.js';
import type { TokenStreamEvent } from '../src/docker/token-stream-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ts = 1700000000000;

function textDelta(text: string): TokenStreamEvent {
  return { kind: 'text_delta', text, timestamp: ts };
}

function toolUse(toolName: string, inputDelta = ''): TokenStreamEvent {
  return { kind: 'tool_use', toolName, inputDelta, timestamp: ts };
}

function messageStart(model = 'claude-sonnet-4-20250514'): TokenStreamEvent {
  return { kind: 'message_start', model, timestamp: ts };
}

function messageEnd(stopReason = 'end_turn', inputTokens = 100, outputTokens = 50): TokenStreamEvent {
  return { kind: 'message_end', stopReason, inputTokens, outputTokens, timestamp: ts };
}

function errorEvent(message: string): TokenStreamEvent {
  return { kind: 'error', message, timestamp: ts };
}

function rawEvent(eventType: string, data: string): TokenStreamEvent {
  return { kind: 'raw', eventType, data, timestamp: ts };
}

const defaultOptions: RenderOptions = { raw: false, json: false, showLabel: false };
const rawOptions: RenderOptions = { raw: true, json: false, showLabel: false };
const jsonOptions: RenderOptions = { raw: false, json: true, showLabel: false };
const labelOptions: RenderOptions = { raw: false, json: false, showLabel: true };
const allOptions: RenderOptions = { raw: true, json: false, showLabel: true };

// ---------------------------------------------------------------------------
// renderEvent -- text mode
// ---------------------------------------------------------------------------

describe('renderEvent (text mode)', () => {
  it('renders text_delta without label', () => {
    const result = renderEvent(1, textDelta('Hello'), defaultOptions);
    expect(result).toBe('Hello');
  });

  it('renders text_delta with label prefix', () => {
    const result = renderEvent(3, textDelta('world'), labelOptions);
    expect(result).toBe(chalk.dim('[3] ') + 'world');
  });

  it('suppresses tool_use in non-raw mode', () => {
    const result = renderEvent(1, toolUse('read_file'), defaultOptions);
    expect(result).toBeNull();
  });

  it('renders tool_use in raw mode', () => {
    const result = renderEvent(1, toolUse('read_file', '{"path":"/foo"}'), rawOptions);
    expect(result).toContain('tool: read_file');
    expect(result).toContain('{"path":"/foo"}');
    expect(result).toMatch(/\n$/);
  });

  it('suppresses message_start in non-raw mode', () => {
    const result = renderEvent(1, messageStart(), defaultOptions);
    expect(result).toBeNull();
  });

  it('renders message_start in raw mode', () => {
    const result = renderEvent(1, messageStart('claude-sonnet-4-20250514'), rawOptions);
    expect(result).toContain('message start');
    expect(result).toContain('claude-sonnet-4-20250514');
  });

  it('suppresses message_end in non-raw mode', () => {
    const result = renderEvent(1, messageEnd(), defaultOptions);
    expect(result).toBeNull();
  });

  it('renders message_end in raw mode', () => {
    const result = renderEvent(1, messageEnd('end_turn', 200, 100), rawOptions);
    expect(result).toContain('message end');
    expect(result).toContain('end_turn');
    expect(result).toContain('200+100 tokens');
  });

  it('always renders error events', () => {
    const result = renderEvent(1, errorEvent('rate limited'), defaultOptions);
    expect(result).toContain('rate limited');
    expect(result).toContain('[error]');
  });

  it('suppresses raw events in non-raw mode', () => {
    const result = renderEvent(1, rawEvent('ping', ''), defaultOptions);
    expect(result).toBeNull();
  });

  it('renders raw events in raw mode', () => {
    const result = renderEvent(1, rawEvent('ping', 'pong'), rawOptions);
    expect(result).toContain('[ping]');
    expect(result).toContain('pong');
  });

  it('renders label prefix for all event types in labeled raw mode', () => {
    const events: TokenStreamEvent[] = [textDelta('hi'), toolUse('run'), messageStart(), messageEnd(), errorEvent('x')];
    for (const event of events) {
      const result = renderEvent(5, event, allOptions);
      if (result !== null) {
        expect(result).toContain(chalk.dim('[5] '));
      }
    }
  });

  it('truncates long tool input in raw mode', () => {
    const longInput = 'x'.repeat(200);
    const result = renderEvent(1, toolUse('big_tool', longInput), rawOptions);
    // 120 char truncation + ellipsis
    expect(result).toContain('\u2026');
    // The full 200-char input should not appear
    expect(result).not.toContain(longInput);
  });
});

// ---------------------------------------------------------------------------
// renderEvent -- JSON mode
// ---------------------------------------------------------------------------

describe('renderEvent (JSON mode)', () => {
  it('outputs valid NDJSON for text_delta', () => {
    const result = renderEvent(3, textDelta('hello'), jsonOptions);
    expect(result).toMatch(/\n$/);
    const parsed = JSON.parse(result!) as Record<string, unknown>;
    expect(parsed).toEqual({ label: 3, kind: 'text_delta', text: 'hello', timestamp: ts });
  });

  it('outputs all event types (nothing suppressed in JSON mode)', () => {
    const events: TokenStreamEvent[] = [
      textDelta('hi'),
      toolUse('foo'),
      messageStart(),
      messageEnd(),
      errorEvent('err'),
      rawEvent('unknown', 'data'),
    ];
    for (const event of events) {
      const result = renderEvent(1, event, jsonOptions);
      expect(result).not.toBeNull();
      expect(result).toMatch(/\n$/);
      // Should be valid JSON
      expect(() => JSON.parse(result!)).not.toThrow();
    }
  });

  it('includes label in JSON output', () => {
    const result = renderEvent(42, textDelta('x'), jsonOptions);
    const parsed = JSON.parse(result!) as Record<string, unknown>;
    expect(parsed.label).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// renderEventBatch
// ---------------------------------------------------------------------------

describe('renderEventBatch', () => {
  it('concatenates multiple text_delta events', () => {
    const events = [textDelta('Hello'), textDelta(' '), textDelta('world')];
    const result = renderEventBatch(1, events, defaultOptions);
    expect(result).toBe('Hello world');
  });

  it('skips suppressed events in a batch', () => {
    const events = [textDelta('a'), toolUse('foo'), textDelta('b')];
    const result = renderEventBatch(1, events, defaultOptions);
    expect(result).toBe('ab');
  });

  it('handles empty batch', () => {
    const result = renderEventBatch(1, [], defaultOptions);
    expect(result).toBe('');
  });

  it('renders all events in raw mode', () => {
    const events = [messageStart(), textDelta('hi'), toolUse('run'), messageEnd()];
    const result = renderEventBatch(1, events, rawOptions);
    expect(result).toContain('message start');
    expect(result).toContain('hi');
    expect(result).toContain('tool: run');
    expect(result).toContain('message end');
  });

  it('renders NDJSON for a batch', () => {
    const events = [textDelta('a'), textDelta('b')];
    const result = renderEventBatch(1, events, jsonOptions);
    const lines = result.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).text).toBe('a');
    expect(JSON.parse(lines[1]).text).toBe('b');
  });
});

// ---------------------------------------------------------------------------
// Helper renderers
// ---------------------------------------------------------------------------

describe('renderConnected', () => {
  it('mentions session label for single-session mode', () => {
    const result = renderConnected(3);
    expect(result).toContain('session 3');
  });

  it('mentions "all sessions" when no label given', () => {
    const result = renderConnected();
    expect(result).toContain('all sessions');
  });
});

describe('renderSessionEnded', () => {
  it('includes label and reason', () => {
    const result = renderSessionEnded(5, 'user_ended');
    expect(result).toContain('5');
    expect(result).toContain('user_ended');
  });
});
