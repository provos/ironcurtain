/**
 * Tests for SseExtractorTransform -- SSE line reassembly and
 * provider-specific parsing for the MITM proxy token stream tap.
 */

import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { SseExtractorTransform, MAX_SSE_LINE_LENGTH } from '../src/docker/sse-extractor.js';
import type { TokenStreamEvent } from '../src/docker/token-stream-types.js';

/** Pipe data through the extractor and collect events + output. */
function run(
  provider: 'anthropic' | 'openai' | 'unknown',
  input: string | string[],
): Promise<{ events: TokenStreamEvent[]; output: string }> {
  return new Promise((resolve, reject) => {
    const events: TokenStreamEvent[] = [];
    const extractor = new SseExtractorTransform(provider, (event) => {
      events.push(event);
    });
    const sink = new PassThrough();
    const chunks: Buffer[] = [];

    sink.on('data', (chunk: Buffer) => chunks.push(chunk));
    sink.on('end', () => {
      resolve({ events, output: Buffer.concat(chunks).toString('utf-8') });
    });
    sink.on('error', reject);
    extractor.pipe(sink);

    const inputs = Array.isArray(input) ? input : [input];
    for (const chunk of inputs) {
      extractor.write(Buffer.from(chunk, 'utf-8'));
    }
    extractor.end();
  });
}

describe('SseExtractorTransform', () => {
  describe('Anthropic format', () => {
    it('parses text_delta events', async () => {
      const sse = [
        'event: content_block_delta\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n',
        '\n',
      ].join('');

      const { events } = await run('anthropic', sse);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'text_delta', text: 'Hello' });
    });

    it('parses tool_use events from content_block_start', async () => {
      const sse = [
        'event: content_block_start\n',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_123","name":"read_file","input":{}}}\n',
        '\n',
      ].join('');

      const { events } = await run('anthropic', sse);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'tool_use', toolName: 'read_file', inputDelta: '' });
    });

    it('parses tool_use input_json_delta events', async () => {
      const sse = [
        'event: content_block_delta\n',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\""}}\n',
        '\n',
      ].join('');

      const { events } = await run('anthropic', sse);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'tool_use', toolName: '', inputDelta: '{"path":"' });
    });

    it('parses message_start events', async () => {
      const sse = [
        'event: message_start\n',
        'data: {"type":"message_start","message":{"id":"msg_01","model":"claude-sonnet-4-20250514","role":"assistant"}}\n',
        '\n',
      ].join('');

      const { events } = await run('anthropic', sse);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'message_start', model: 'claude-sonnet-4-20250514' });
    });

    it('parses message_end from message_delta', async () => {
      const sse = [
        'event: message_delta\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}\n',
        '\n',
      ].join('');

      const { events } = await run('anthropic', sse);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'message_end',
        stopReason: 'end_turn',
        outputTokens: 42,
      });
    });

    it('parses error events', async () => {
      const sse = [
        'event: error\n',
        'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n',
        '\n',
      ].join('');

      const { events } = await run('anthropic', sse);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'error', message: 'Overloaded' });
    });

    it('emits raw for malformed JSON', async () => {
      const sse = ['event: content_block_delta\n', 'data: {not valid json}\n', '\n'].join('');

      const { events } = await run('anthropic', sse);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'raw', eventType: 'content_block_delta' });
    });

    it('handles a complete multi-event Anthropic stream', async () => {
      const sse = [
        'event: message_start\n',
        'data: {"type":"message_start","message":{"id":"msg_01","model":"claude-sonnet-4-20250514","role":"assistant"}}\n',
        '\n',
        'event: content_block_delta\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n',
        '\n',
        'event: content_block_delta\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}\n',
        '\n',
        'event: message_delta\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}\n',
        '\n',
        'event: message_stop\n',
        'data: {"type":"message_stop"}\n',
        '\n',
      ].join('');

      const { events } = await run('anthropic', sse);

      expect(events).toHaveLength(5);
      expect(events[0]).toMatchObject({ kind: 'message_start' });
      expect(events[1]).toMatchObject({ kind: 'text_delta', text: 'Hi' });
      expect(events[2]).toMatchObject({ kind: 'text_delta', text: ' there' });
      expect(events[3]).toMatchObject({ kind: 'message_end', stopReason: 'end_turn' });
      expect(events[4]).toMatchObject({ kind: 'raw', eventType: 'message_stop' });
    });
  });

  describe('OpenAI format', () => {
    it('parses text content deltas', async () => {
      const sse = [
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"}}]}\n',
        '\n',
      ].join('');

      const { events } = await run('openai', sse);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'text_delta', text: 'Hello' });
    });

    it('parses tool_calls deltas', async () => {
      const sse = [
        'data: {"id":"chatcmpl-1","choices":[{"delta":{"tool_calls":[{"function":{"name":"read_file","arguments":"{\\"p"}}]}}]}\n',
        '\n',
      ].join('');

      const { events } = await run('openai', sse);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'tool_use', toolName: 'read_file', inputDelta: '{"p' });
    });

    it('parses [DONE] as message_end', async () => {
      const sse = 'data: [DONE]\n\n';

      const { events } = await run('openai', sse);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'message_end', stopReason: 'stop' });
    });

    it('parses model info as message_start', async () => {
      const sse = [
        'data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[]}\n',
        '\n',
        'data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"delta":{"content":"Hi"}}]}\n',
        '\n',
      ].join('');

      const { events } = await run('openai', sse);

      // First chunk has empty choices + model => message_start
      // Second chunk has content => text_delta
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events[0]).toMatchObject({ kind: 'message_start', model: 'gpt-4o' });
      expect(events[1]).toMatchObject({ kind: 'text_delta', text: 'Hi' });
    });

    it('emits raw for malformed JSON', async () => {
      const sse = 'data: not-json-at-all\n\n';

      const { events } = await run('openai', sse);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'raw', eventType: 'parse_error' });
    });

    it('parses finish_reason from empty delta chunk', async () => {
      // OpenAI commonly sends {delta: {}, finish_reason: "stop"} before [DONE]
      const sse = [
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n',
        '\n',
        'data: [DONE]\n',
        '\n',
      ].join('');

      const { events } = await run('openai', sse);

      // First: message_end from the finish_reason in the empty-delta chunk
      // Second: message_end from [DONE]
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        kind: 'message_end',
        stopReason: 'tool_calls',
      });
      expect(events[1]).toMatchObject({
        kind: 'message_end',
        stopReason: 'stop',
      });
    });
  });

  describe('unknown provider', () => {
    it('emits all complete SSE lines as raw events', async () => {
      const sse = 'event: something\ndata: {"foo":"bar"}\n\n';

      const { events } = await run('unknown', sse);

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ kind: 'raw', eventType: 'unknown_provider', data: 'event: something' });
      expect(events[1]).toMatchObject({ kind: 'raw', eventType: 'unknown_provider', data: 'data: {"foo":"bar"}' });
    });

    it('does not emit events for empty lines', async () => {
      const sse = 'line1\n\nline2\n';

      const { events } = await run('unknown', sse);

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ data: 'line1' });
      expect(events[1]).toMatchObject({ data: 'line2' });
    });
  });

  describe('data passthrough', () => {
    it('output equals input for Anthropic SSE', async () => {
      const input =
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n';

      const { output } = await run('anthropic', input);

      expect(output).toBe(input);
    });

    it('output equals input for OpenAI SSE', async () => {
      const input = 'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n';

      const { output } = await run('openai', input);

      expect(output).toBe(input);
    });

    it('output equals input for unknown provider', async () => {
      const input = 'some arbitrary data\nmore lines\n';

      const { output } = await run('unknown', input);

      expect(output).toBe(input);
    });
  });

  describe('chunked reassembly', () => {
    it('reassembles SSE lines split across chunks', async () => {
      // Split a single data line across two chunks
      const chunk1 = 'event: content_block_delta\ndata: {"type":"content_block_de';
      const chunk2 = 'lta","index":0,"delta":{"type":"text_delta","text":"split"}}\n\n';

      const { events, output } = await run('anthropic', [chunk1, chunk2]);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'text_delta', text: 'split' });
      expect(output).toBe(chunk1 + chunk2);
    });

    it('handles CRLF line endings', async () => {
      const sse =
        'event: content_block_delta\r\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"crlf"}}\r\n\r\n';

      const { events } = await run('anthropic', sse);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'text_delta', text: 'crlf' });
    });
  });

  describe('line buffer truncation', () => {
    it('truncates lines exceeding MAX_SSE_LINE_LENGTH', async () => {
      // Create a line that exceeds the max length
      const longLine = 'data: ' + 'x'.repeat(MAX_SSE_LINE_LENGTH + 100) + '\n';

      const { events, output } = await run('anthropic', longLine);

      const truncationEvents = events.filter((e) => e.kind === 'raw' && e.eventType === 'truncated');
      expect(truncationEvents.length).toBeGreaterThanOrEqual(1);
      // Data still passes through unmodified
      expect(output).toBe(longLine);
    });
  });

  describe('error handling', () => {
    it('error in onEvent callback does not break the stream', async () => {
      const events: TokenStreamEvent[] = [];
      let callCount = 0;

      const extractor = new SseExtractorTransform('anthropic', (event) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('callback exploded');
        }
        events.push(event);
      });

      const sink = new PassThrough();
      const chunks: Buffer[] = [];
      sink.on('data', (chunk: Buffer) => chunks.push(chunk));

      const input = [
        'event: content_block_delta\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"first"}}\n',
        '\n',
        'event: content_block_delta\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"second"}}\n',
        '\n',
      ].join('');

      await new Promise<void>((resolve, reject) => {
        sink.on('end', resolve);
        sink.on('error', reject);
        extractor.pipe(sink);
        extractor.write(Buffer.from(input, 'utf-8'));
        extractor.end();
      });

      const output = Buffer.concat(chunks).toString('utf-8');
      expect(output).toBe(input);
      // Second event should have been received despite first callback throwing
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'text_delta', text: 'second' });
    });
  });

  describe('_flush', () => {
    it('processes remaining buffer on stream end', async () => {
      // Send data without a trailing newline -- _flush should process the remainder
      const input = 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"flushed"}}';

      const { events, output } = await run('anthropic', input);

      expect(output).toBe(input);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'text_delta', text: 'flushed' });
    });
  });
});
