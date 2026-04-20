/**
 * Tests for extractToolResults and extractFromJsonResponse in mitm-proxy.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTokenStreamBus, resetTokenStreamBus } from '../src/docker/token-stream-bus.js';
import type { TokenStreamEvent } from '../src/docker/token-stream-types.js';
import type { SessionId } from '../src/session/types.js';
import {
  extractToolResults,
  extractFromJsonResponse,
  createBoundedJsonResponseCapture,
  MAX_JSON_RESPONSE_CAPTURE_BYTES,
} from '../src/docker/mitm-proxy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_ID = 'test-session' as SessionId;

/**
 * Collect events from the singleton bus for the given session.
 * Requires `resetTokenStreamBus()` to have been called in `beforeEach` so
 * each test sees a fresh bus. Subscribing after the reset means the listener
 * is attached to the same singleton instance extractor calls publish into.
 */
function collectEvents(sessionId: SessionId): {
  events: TokenStreamEvent[];
} {
  const events: TokenStreamEvent[] = [];
  getTokenStreamBus().subscribe(sessionId, (_sid, event) => events.push(event));
  return { events };
}

/** Type-safe event filter that narrows the union. */
function eventsOfKind<K extends TokenStreamEvent['kind']>(
  events: TokenStreamEvent[],
  kind: K,
): Array<Extract<TokenStreamEvent, { kind: K }>> {
  return events.filter((e): e is Extract<TokenStreamEvent, { kind: K }> => e.kind === kind);
}

// ---------------------------------------------------------------------------
// extractToolResults
// ---------------------------------------------------------------------------

describe('extractToolResults', () => {
  beforeEach(() => {
    resetTokenStreamBus();
  });

  it('extracts Anthropic tool_result blocks from request body', () => {
    const { events } = collectEvents(SESSION_ID);
    const parsed = {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_123',
              content: 'File contents here',
            },
          ],
        },
      ],
    };

    extractToolResults(parsed, SESSION_ID);

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('tool_result');
    if (events[0].kind === 'tool_result') {
      expect(events[0].toolUseId).toBe('tu_123');
      expect(events[0].content).toBe('File contents here');
      expect(events[0].isError).toBe(false);
    }
  });

  it('handles is_error flag', () => {
    const { events } = collectEvents(SESSION_ID);
    const parsed = {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_456',
              content: 'Command failed',
              is_error: true,
            },
          ],
        },
      ],
    };

    extractToolResults(parsed, SESSION_ID);

    expect(events).toHaveLength(1);
    if (events[0].kind === 'tool_result') {
      expect(events[0].isError).toBe(true);
      expect(events[0].content).toBe('Command failed');
    }
  });

  it('handles array content blocks (Anthropic format)', () => {
    const { events } = collectEvents(SESSION_ID);
    const parsed = {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_789',
              content: [
                { type: 'text', text: 'Line one' },
                { type: 'text', text: 'Line two' },
              ],
            },
          ],
        },
      ],
    };

    extractToolResults(parsed, SESSION_ID);

    expect(events).toHaveLength(1);
    if (events[0].kind === 'tool_result') {
      expect(events[0].content).toBe('Line one\nLine two');
    }
  });

  it('truncates very long content', () => {
    const { events } = collectEvents(SESSION_ID);
    const longContent = 'x'.repeat(1000);
    const parsed = {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_long',
              content: longContent,
            },
          ],
        },
      ],
    };

    extractToolResults(parsed, SESSION_ID);

    expect(events).toHaveLength(1);
    if (events[0].kind === 'tool_result') {
      expect(events[0].content.length).toBeLessThanOrEqual(501); // 500 + ellipsis
      expect(events[0].content).toContain('\u2026');
    }
  });

  it('extracts multiple tool_results from a single message', () => {
    const { events } = collectEvents(SESSION_ID);
    const parsed = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_a', content: 'Result A' },
            { type: 'tool_result', tool_use_id: 'tu_b', content: 'Result B' },
          ],
        },
      ],
    };

    extractToolResults(parsed, SESSION_ID);

    expect(events).toHaveLength(2);
    if (events[0].kind === 'tool_result' && events[1].kind === 'tool_result') {
      expect(events[0].content).toBe('Result A');
      expect(events[1].content).toBe('Result B');
    }
  });

  it('extracts OpenAI tool role messages', () => {
    const { events } = collectEvents(SESSION_ID);
    const parsed = {
      messages: [
        {
          role: 'tool',
          tool_call_id: 'call_abc',
          content: 'OpenAI tool output',
        },
      ],
    };

    extractToolResults(parsed, SESSION_ID);

    expect(events).toHaveLength(1);
    if (events[0].kind === 'tool_result') {
      expect(events[0].toolUseId).toBe('call_abc');
      expect(events[0].content).toBe('OpenAI tool output');
      expect(events[0].isError).toBe(false);
    }
  });

  it('ignores non-user/non-tool messages', () => {
    const { events } = collectEvents(SESSION_ID);
    const parsed = {
      messages: [
        { role: 'assistant', content: 'Some text' },
        { role: 'system', content: 'System prompt' },
      ],
    };

    extractToolResults(parsed, SESSION_ID);

    expect(events).toHaveLength(0);
  });

  it('handles missing messages array gracefully', () => {
    const { events } = collectEvents(SESSION_ID);
    extractToolResults({}, SESSION_ID);
    expect(events).toHaveLength(0);
  });

  it('ignores non-tool_result content blocks', () => {
    const { events } = collectEvents(SESSION_ID);
    const parsed = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'tool_result', tool_use_id: 'tu_x', content: 'Output' },
          ],
        },
      ],
    };

    extractToolResults(parsed, SESSION_ID);

    expect(events).toHaveLength(1);
    if (events[0].kind === 'tool_result') {
      expect(events[0].content).toBe('Output');
    }
  });
});

// ---------------------------------------------------------------------------
// extractFromJsonResponse
// ---------------------------------------------------------------------------

describe('extractFromJsonResponse', () => {
  beforeEach(() => {
    resetTokenStreamBus();
  });

  it('extracts Anthropic JSON response (model + text + usage)', () => {
    const { events } = collectEvents(SESSION_ID);
    const body = Buffer.from(
      JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        content: [{ type: 'text', text: 'Hello world' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    );

    extractFromJsonResponse(body, SESSION_ID);

    expect(events).toHaveLength(3);

    const starts = eventsOfKind(events, 'message_start');
    expect(starts).toHaveLength(1);
    expect(starts[0].model).toBe('claude-sonnet-4-20250514');

    const deltas = eventsOfKind(events, 'text_delta');
    expect(deltas).toHaveLength(1);
    expect(deltas[0].text).toBe('Hello world');

    const ends = eventsOfKind(events, 'message_end');
    expect(ends).toHaveLength(1);
    expect(ends[0].stopReason).toBe('end_turn');
    expect(ends[0].inputTokens).toBe(100);
    expect(ends[0].outputTokens).toBe(50);
  });

  it('extracts OpenAI JSON response format', () => {
    const { events } = collectEvents(SESSION_ID);
    const body = Buffer.from(
      JSON.stringify({
        model: 'gpt-4',
        choices: [{ message: { role: 'assistant', content: 'OpenAI response' } }],
        usage: { prompt_tokens: 200, completion_tokens: 80 },
      }),
    );

    extractFromJsonResponse(body, SESSION_ID);

    const starts = eventsOfKind(events, 'message_start');
    expect(starts).toHaveLength(1);
    expect(starts[0].model).toBe('gpt-4');

    const deltas = eventsOfKind(events, 'text_delta');
    expect(deltas).toHaveLength(1);
    expect(deltas[0].text).toBe('OpenAI response');

    const ends = eventsOfKind(events, 'message_end');
    expect(ends).toHaveLength(1);
    expect(ends[0].inputTokens).toBe(200);
    expect(ends[0].outputTokens).toBe(80);
  });

  it('handles invalid JSON gracefully', () => {
    const { events } = collectEvents(SESSION_ID);
    extractFromJsonResponse(Buffer.from('not json'), SESSION_ID);
    expect(events).toHaveLength(0);
  });

  it('handles response without model', () => {
    const { events } = collectEvents(SESSION_ID);
    const body = Buffer.from(
      JSON.stringify({
        content: [{ type: 'text', text: 'no model' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    );

    extractFromJsonResponse(body, SESSION_ID);

    // No message_start since no model
    expect(eventsOfKind(events, 'message_start')).toHaveLength(0);

    // Still get text_delta and message_end
    expect(eventsOfKind(events, 'text_delta')).toHaveLength(1);
    expect(eventsOfKind(events, 'message_end')).toHaveLength(1);
  });

  it('handles response without usage', () => {
    const { events } = collectEvents(SESSION_ID);
    const body = Buffer.from(
      JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        content: [{ type: 'text', text: 'Hello' }],
      }),
    );

    extractFromJsonResponse(body, SESSION_ID);

    const ends = eventsOfKind(events, 'message_end');
    expect(ends).toHaveLength(1);
    expect(ends[0].inputTokens).toBe(0);
    expect(ends[0].outputTokens).toBe(0);
  });

  it('extracts multiple content blocks', () => {
    const { events } = collectEvents(SESSION_ID);
    const body = Buffer.from(
      JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        content: [
          { type: 'text', text: 'First block' },
          { type: 'text', text: 'Second block' },
        ],
        usage: { input_tokens: 50, output_tokens: 25 },
      }),
    );

    extractFromJsonResponse(body, SESSION_ID);

    const deltas = eventsOfKind(events, 'text_delta');
    expect(deltas).toHaveLength(2);
    expect(deltas[0].text).toBe('First block');
    expect(deltas[1].text).toBe('Second block');
  });

  it('defaults stop_reason to "stop" when missing', () => {
    const { events } = collectEvents(SESSION_ID);
    const body = Buffer.from(
      JSON.stringify({
        content: [],
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    );

    extractFromJsonResponse(body, SESSION_ID);

    const ends = eventsOfKind(events, 'message_end');
    expect(ends).toHaveLength(1);
    expect(ends[0].stopReason).toBe('stop');
  });
});

// ---------------------------------------------------------------------------
// createBoundedJsonResponseCapture (OOM guard)
// ---------------------------------------------------------------------------

describe('createBoundedJsonResponseCapture', () => {
  it('exposes a sensible default cap', () => {
    expect(MAX_JSON_RESPONSE_CAPTURE_BYTES).toBe(2 * 1024 * 1024);
  });

  it('accumulates chunks and delivers them at end', () => {
    const capture = createBoundedJsonResponseCapture(1024);
    capture.onData(Buffer.from('hello '));
    capture.onData(Buffer.from('world'));

    const onComplete = vi.fn<(body: Buffer | null) => void>();
    capture.onEnd(onComplete);
    expect(onComplete).toHaveBeenCalledOnce();
    const body = onComplete.mock.calls[0][0];
    expect(body).not.toBeNull();
    expect(body?.toString()).toBe('hello world');
  });

  it('passes null to onEnd callback once the cap is exceeded', () => {
    const capture = createBoundedJsonResponseCapture(10);
    capture.onData(Buffer.from('12345'));
    capture.onData(Buffer.from('678'));

    // Pushes past the cap
    capture.onData(Buffer.from('9abcd'));

    const onComplete = vi.fn<(body: Buffer | null) => void>();
    capture.onEnd(onComplete);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete.mock.calls[0][0]).toBeNull();
  });

  it('ignores further chunks after overflow (best-effort, no-throw)', () => {
    const capture = createBoundedJsonResponseCapture(4);
    capture.onData(Buffer.from('aaaaaa')); // single chunk blows the cap

    // Must not throw; overflow state persists.
    expect(() => capture.onData(Buffer.from('bbbb'))).not.toThrow();

    const onComplete = vi.fn<(body: Buffer | null) => void>();
    capture.onEnd(onComplete);
    expect(onComplete.mock.calls[0][0]).toBeNull();
  });

  it('exactly-at-cap is allowed (only strictly greater overflows)', () => {
    const capture = createBoundedJsonResponseCapture(8);
    capture.onData(Buffer.from('01234567')); // exactly 8 bytes

    const onComplete = vi.fn<(body: Buffer | null) => void>();
    capture.onEnd(onComplete);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete.mock.calls[0][0]?.toString()).toBe('01234567');
  });
});
