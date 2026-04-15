/**
 * SSE extraction transform stream for the MITM proxy.
 *
 * Sits in the response pipeline between the upstream LLM API and the
 * Docker container. All data passes through unmodified -- the extractor
 * only emits structured side-channel events via a callback.
 *
 * Handles Anthropic and OpenAI SSE formats. Unknown providers emit
 * raw events for every complete SSE line.
 */

import { Transform, type TransformCallback } from 'node:stream';
import type { TokenStreamEvent, SseEventCallback, SseProvider } from './token-stream-types.js';

/** Maximum length of a single SSE line buffer before truncation (1 MB). */
export const MAX_SSE_LINE_LENGTH = 1_048_576;

/** Safely extract a string from an unknown value. */
function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Safely extract a number from an unknown value. */
function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' ? value : fallback;
}

/** Safely extract a record from an unknown value. */
function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Safely extract an array from an unknown value. */
function arr(value: unknown): Array<Record<string, unknown>> | undefined {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : undefined;
}

/**
 * A passthrough Transform stream that intercepts SSE data flowing
 * through the MITM proxy without modifying the forwarded bytes.
 *
 * Usage:
 *   upstreamRes.pipe(extractor).pipe(clientRes)
 *
 * The extractor reassembles SSE lines across chunk boundaries,
 * parses provider-specific event formats, and invokes the callback
 * with structured TokenStreamEvents.
 *
 * All data passes through unmodified. The extractor never drops,
 * delays, or modifies chunks. If parsing fails for any event,
 * a `raw` event is emitted and data continues to flow.
 *
 * ERROR CONTRACT: `_transform()` must NEVER throw or call
 * `callback(err)`. The entire body is wrapped in a try/catch
 * that always calls `callback(null, chunk)`. A parsing bug must
 * never interrupt the forwarding path to the Docker container.
 */
export class SseExtractorTransform extends Transform {
  private lineBuffer = '';
  private currentEventType = '';
  private readonly provider: SseProvider;
  private readonly onEvent: SseEventCallback;

  constructor(provider: SseProvider, onEvent: SseEventCallback) {
    super();
    this.provider = provider;
    this.onEvent = onEvent;
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      const text = chunk.toString('utf-8');
      this.processText(text);
    } catch {
      // Parsing errors must never propagate -- the forwarding path is sacred.
    }
    callback(null, chunk);
  }

  _flush(callback: TransformCallback): void {
    try {
      if (this.lineBuffer.length > 0) {
        this.processLine(this.lineBuffer);
        this.lineBuffer = '';
      }
    } catch {
      // Same error contract as _transform.
    }
    callback();
  }

  private processText(text: string): void {
    let pos = 0;
    while (pos < text.length) {
      const nextLf = text.indexOf('\n', pos);
      const nextCr = text.indexOf('\r', pos);

      // Find the nearest line ending (-1 means not found)
      let lineEnd: number;
      if (nextLf === -1 && nextCr === -1) {
        // No more line endings -- buffer the rest
        this.lineBuffer += text.slice(pos);
        if (this.lineBuffer.length > MAX_SSE_LINE_LENGTH) {
          this.emitSafe({
            kind: 'raw',
            eventType: 'truncated',
            data: '',
            timestamp: Date.now(),
          });
          this.lineBuffer = '';
        }
        return;
      } else if (nextCr === -1) {
        lineEnd = nextLf;
      } else if (nextLf === -1) {
        lineEnd = nextCr;
      } else {
        lineEnd = Math.min(nextLf, nextCr);
      }

      // Append the segment before the line ending and process
      this.lineBuffer += text.slice(pos, lineEnd);
      if (this.lineBuffer.length > MAX_SSE_LINE_LENGTH) {
        this.emitSafe({
          kind: 'raw',
          eventType: 'truncated',
          data: '',
          timestamp: Date.now(),
        });
        this.lineBuffer = '';
      } else {
        this.processLine(this.lineBuffer);
        this.lineBuffer = '';
      }

      // Advance past the line ending, consuming CRLF as a single break
      pos = lineEnd + 1;
      if (text[lineEnd] === '\r' && pos < text.length && text[pos] === '\n') {
        pos++;
      }
    }
  }

  private processLine(line: string): void {
    if (this.provider === 'unknown') {
      this.processUnknownLine(line);
      return;
    }

    if (line === '') {
      // Empty line = SSE event boundary. Reset event type for next event.
      this.currentEventType = '';
      return;
    }

    if (line.startsWith('event:')) {
      this.currentEventType = line.slice(6).trim();
      return;
    }

    if (line.startsWith('data:')) {
      const data = line.slice(5).trim();
      if (this.provider === 'anthropic') {
        this.parseAnthropicData(data);
      } else {
        this.parseOpenaiData(data);
      }
    }
    // Ignore other SSE fields (id:, retry:, comments starting with :)
  }

  private processUnknownLine(line: string): void {
    if (line === '') return;
    this.emitSafe({
      kind: 'raw',
      eventType: 'unknown_provider',
      data: line,
      timestamp: Date.now(),
    });
  }

  private parseAnthropicData(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      this.emitSafe({ kind: 'raw', eventType: this.currentEventType || 'parse_error', data, timestamp: Date.now() });
      return;
    }

    const root = obj(parsed);
    if (!root) return;

    const type = str(root['type']);
    const now = Date.now();

    if (type === 'message_start') {
      const message = obj(root['message']);
      this.emitSafe({ kind: 'message_start', model: str(message?.['model'], 'unknown'), timestamp: now });
      return;
    }

    if (type === 'content_block_delta') {
      const delta = obj(root['delta']);
      if (!delta) return;

      const deltaType = str(delta['type']);
      if (deltaType === 'text_delta') {
        this.emitSafe({ kind: 'text_delta', text: str(delta['text']), timestamp: now });
        return;
      }
      if (deltaType === 'input_json_delta') {
        this.emitSafe({ kind: 'tool_use', toolName: '', inputDelta: str(delta['partial_json']), timestamp: now });
        return;
      }
    }

    if (type === 'content_block_start') {
      const block = obj(root['content_block']);
      if (str(block?.['type']) === 'tool_use') {
        this.emitSafe({ kind: 'tool_use', toolName: str(block?.['name']), inputDelta: '', timestamp: now });
        return;
      }
    }

    if (type === 'message_delta') {
      const delta = obj(root['delta']);
      const usage = obj(root['usage']);
      this.emitSafe(this.makeMessageEnd(str(delta?.['stop_reason']), 0, num(usage?.['output_tokens'])));
      return;
    }

    if (type === 'message_stop') {
      this.emitSafe({ kind: 'raw', eventType: 'message_stop', data, timestamp: now });
      return;
    }

    if (type === 'error') {
      const error = obj(root['error']);
      this.emitSafe({ kind: 'error', message: str(error?.['message'], data), timestamp: now });
      return;
    }

    // Unknown Anthropic event type -- emit as raw.
    this.emitSafe({ kind: 'raw', eventType: type || this.currentEventType || 'unknown', data, timestamp: now });
  }

  private parseOpenaiData(data: string): void {
    if (data === '[DONE]') {
      this.emitSafe(this.makeMessageEnd('stop', 0, 0));
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      this.emitSafe({ kind: 'raw', eventType: 'parse_error', data, timestamp: Date.now() });
      return;
    }

    const root = obj(parsed);
    if (!root) return;

    const now = Date.now();
    const choices = arr(root['choices']);
    if (!choices || choices.length === 0) {
      const model = typeof root['model'] === 'string' ? root['model'] : undefined;
      if (model) {
        this.emitSafe({ kind: 'message_start', model, timestamp: now });
        return;
      }
      this.emitSafe({ kind: 'raw', eventType: 'openai_chunk', data, timestamp: now });
      return;
    }

    const choice = choices[0];
    const delta = obj(choice['delta']);
    if (!delta) {
      const finishReason = str(choice['finish_reason']) || undefined;
      if (finishReason) {
        this.emitSafe(this.makeMessageEnd(finishReason, 0, 0));
      }
      return;
    }

    if (typeof delta['content'] === 'string') {
      this.emitSafe({ kind: 'text_delta', text: delta['content'], timestamp: now });
      return;
    }

    const toolCalls = arr(delta['tool_calls']);
    if (toolCalls && toolCalls.length > 0) {
      const tc = toolCalls[0];
      const fn = obj(tc['function']);
      this.emitSafe({
        kind: 'tool_use',
        toolName: str(fn?.['name']),
        inputDelta: str(fn?.['arguments']),
        timestamp: now,
      });
      return;
    }

    // Empty delta with finish_reason (common OpenAI pattern for stream end).
    const finishReason = str(choice['finish_reason']) || undefined;
    if (finishReason) {
      this.emitSafe(this.makeMessageEnd(finishReason, 0, 0));
      return;
    }

    // Unknown delta shape -- emit as raw.
    this.emitSafe({ kind: 'raw', eventType: 'openai_delta', data, timestamp: now });
  }

  private makeMessageEnd(stopReason: string, inputTokens: number, outputTokens: number): TokenStreamEvent {
    return { kind: 'message_end', stopReason, inputTokens, outputTokens, timestamp: Date.now() };
  }

  /** Invoke the callback, swallowing any listener errors. */
  private emitSafe(event: TokenStreamEvent): void {
    try {
      this.onEvent(event);
    } catch {
      // Listener errors must never propagate to the stream pipeline.
    }
  }
}
