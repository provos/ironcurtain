/**
 * Tests for extractToolResults and extractFromJsonResponse in mitm-proxy.ts.
 */

import { describe, it, expect } from 'vitest';
import { createTokenStreamBus } from '../src/docker/token-stream-bus.js';
import type { TokenStreamEvent } from '../src/docker/token-stream-types.js';
import type { SessionId } from '../src/session/types.js';
import { extractToolResults, extractFromJsonResponse } from '../src/docker/mitm-proxy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_ID = 'test-session' as SessionId;

/** Collect all events pushed to a bus for a given session. */
function collectEvents(sessionId: SessionId): {
  events: TokenStreamEvent[];
  bus: ReturnType<typeof createTokenStreamBus>;
} {
  const bus = createTokenStreamBus();
  const events: TokenStreamEvent[] = [];
  bus.subscribe(sessionId, (_sid, event) => events.push(event));
  return { events, bus };
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
  it('extracts Anthropic tool_result blocks from request body', () => {
    const { events, bus } = collectEvents(SESSION_ID);
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

    extractToolResults(parsed, bus, SESSION_ID);

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('tool_result');
    if (events[0].kind === 'tool_result') {
      expect(events[0].toolUseId).toBe('tu_123');
      expect(events[0].content).toBe('File contents here');
      expect(events[0].isError).toBe(false);
    }
  });

  it('handles is_error flag', () => {
    const { events, bus } = collectEvents(SESSION_ID);
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

    extractToolResults(parsed, bus, SESSION_ID);

    expect(events).toHaveLength(1);
    if (events[0].kind === 'tool_result') {
      expect(events[0].isError).toBe(true);
      expect(events[0].content).toBe('Command failed');
    }
  });

  it('handles array content blocks (Anthropic format)', () => {
    const { events, bus } = collectEvents(SESSION_ID);
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

    extractToolResults(parsed, bus, SESSION_ID);

    expect(events).toHaveLength(1);
    if (events[0].kind === 'tool_result') {
      expect(events[0].content).toBe('Line one\nLine two');
    }
  });

  it('truncates very long content', () => {
    const { events, bus } = collectEvents(SESSION_ID);
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

    extractToolResults(parsed, bus, SESSION_ID);

    expect(events).toHaveLength(1);
    if (events[0].kind === 'tool_result') {
      expect(events[0].content.length).toBeLessThanOrEqual(501); // 500 + ellipsis
      expect(events[0].content).toContain('\u2026');
    }
  });

  it('extracts multiple tool_results from a single message', () => {
    const { events, bus } = collectEvents(SESSION_ID);
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

    extractToolResults(parsed, bus, SESSION_ID);

    expect(events).toHaveLength(2);
    if (events[0].kind === 'tool_result' && events[1].kind === 'tool_result') {
      expect(events[0].content).toBe('Result A');
      expect(events[1].content).toBe('Result B');
    }
  });

  it('extracts OpenAI tool role messages', () => {
    const { events, bus } = collectEvents(SESSION_ID);
    const parsed = {
      messages: [
        {
          role: 'tool',
          tool_call_id: 'call_abc',
          content: 'OpenAI tool output',
        },
      ],
    };

    extractToolResults(parsed, bus, SESSION_ID);

    expect(events).toHaveLength(1);
    if (events[0].kind === 'tool_result') {
      expect(events[0].toolUseId).toBe('call_abc');
      expect(events[0].content).toBe('OpenAI tool output');
      expect(events[0].isError).toBe(false);
    }
  });

  it('ignores non-user/non-tool messages', () => {
    const { events, bus } = collectEvents(SESSION_ID);
    const parsed = {
      messages: [
        { role: 'assistant', content: 'Some text' },
        { role: 'system', content: 'System prompt' },
      ],
    };

    extractToolResults(parsed, bus, SESSION_ID);

    expect(events).toHaveLength(0);
  });

  it('handles missing messages array gracefully', () => {
    const { events, bus } = collectEvents(SESSION_ID);
    extractToolResults({}, bus, SESSION_ID);
    expect(events).toHaveLength(0);
  });

  it('ignores non-tool_result content blocks', () => {
    const { events, bus } = collectEvents(SESSION_ID);
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

    extractToolResults(parsed, bus, SESSION_ID);

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
  it('extracts Anthropic JSON response (model + text + usage)', () => {
    const { events, bus } = collectEvents(SESSION_ID);
    const body = Buffer.from(
      JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        content: [{ type: 'text', text: 'Hello world' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    );

    extractFromJsonResponse(body, bus, SESSION_ID);

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
    const { events, bus } = collectEvents(SESSION_ID);
    const body = Buffer.from(
      JSON.stringify({
        model: 'gpt-4',
        choices: [{ message: { role: 'assistant', content: 'OpenAI response' } }],
        usage: { prompt_tokens: 200, completion_tokens: 80 },
      }),
    );

    extractFromJsonResponse(body, bus, SESSION_ID);

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
    const { events, bus } = collectEvents(SESSION_ID);
    extractFromJsonResponse(Buffer.from('not json'), bus, SESSION_ID);
    expect(events).toHaveLength(0);
  });

  it('handles response without model', () => {
    const { events, bus } = collectEvents(SESSION_ID);
    const body = Buffer.from(
      JSON.stringify({
        content: [{ type: 'text', text: 'no model' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    );

    extractFromJsonResponse(body, bus, SESSION_ID);

    // No message_start since no model
    expect(eventsOfKind(events, 'message_start')).toHaveLength(0);

    // Still get text_delta and message_end
    expect(eventsOfKind(events, 'text_delta')).toHaveLength(1);
    expect(eventsOfKind(events, 'message_end')).toHaveLength(1);
  });

  it('handles response without usage', () => {
    const { events, bus } = collectEvents(SESSION_ID);
    const body = Buffer.from(
      JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        content: [{ type: 'text', text: 'Hello' }],
      }),
    );

    extractFromJsonResponse(body, bus, SESSION_ID);

    const ends = eventsOfKind(events, 'message_end');
    expect(ends).toHaveLength(1);
    expect(ends[0].inputTokens).toBe(0);
    expect(ends[0].outputTokens).toBe(0);
  });

  it('extracts multiple content blocks', () => {
    const { events, bus } = collectEvents(SESSION_ID);
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

    extractFromJsonResponse(body, bus, SESSION_ID);

    const deltas = eventsOfKind(events, 'text_delta');
    expect(deltas).toHaveLength(2);
    expect(deltas[0].text).toBe('First block');
    expect(deltas[1].text).toBe('Second block');
  });

  it('defaults stop_reason to "stop" when missing', () => {
    const { events, bus } = collectEvents(SESSION_ID);
    const body = Buffer.from(
      JSON.stringify({
        content: [],
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    );

    extractFromJsonResponse(body, bus, SESSION_ID);

    const ends = eventsOfKind(events, 'message_end');
    expect(ends).toHaveLength(1);
    expect(ends[0].stopReason).toBe('stop');
  });
});
