import { describe, expect, it } from 'vitest';
import {
  SseEventFramer,
  SseFramingError,
  type SseEventFrame,
} from '../../src/docker/llm-observation/sse-event-framer.js';

function frameChunks(chunks: readonly Buffer[]): SseEventFrame[] {
  const frames: SseEventFrame[] = [];
  const framer = new SseEventFramer();
  for (const chunk of chunks) framer.feed(chunk, (frame) => frames.push(frame));
  framer.finish((frame) => frames.push(frame));
  return frames;
}

describe('SseEventFramer', () => {
  it('frames CR, LF, CRLF, comments, unknown fields, and multi-line data', () => {
    const wire =
      ': heartbeat\r' +
      'event: greeting\r\n' +
      'id: ignored\n' +
      'data: hello\r\n' +
      'data: world\r\n' +
      '\r\n' +
      'data: tail';
    expect(frameChunks([Buffer.from(wire)])).toEqual([
      { eventType: 'greeting', dataUtf8: 'hello\nworld' },
      { eventType: '', dataUtf8: 'tail' },
    ]);
  });

  it('is invariant at every byte split, including CRLF and multibyte UTF-8 splits', () => {
    const wire = Buffer.from('event: unicode\r\ndata: hé🚀\r\n\r\nevent: done\ndata: [DONE]\n\n', 'utf8');
    const expected = frameChunks([wire]);
    for (let split = 0; split <= wire.length; split++) {
      expect(frameChunks([wire.subarray(0, split), wire.subarray(split)])).toEqual(expected);
    }
    const bytewise = Array.from(wire, (_value, index) => wire.subarray(index, index + 1));
    expect(frameChunks(bytewise)).toEqual(expected);
  });

  it('bounds individual lines before retaining them', () => {
    const framer = new SseEventFramer({ limits: { maxLineBytes: 8 } });
    expect(() => framer.feed(Buffer.from('data: 123456789'), () => {})).toThrowError(SseFramingError);
  });

  it('bounds total stream work even when individual events are small', () => {
    const framer = new SseEventFramer({ limits: { maxStreamBytes: 8 } });
    framer.feed(Buffer.from('data: x'), () => {});
    expect(() => framer.feed(Buffer.from('\n\n'), () => {})).toThrow(/stream exceeds/);
  });

  it('bounds joined multi-line event payloads and event counts', () => {
    const eventLimited = new SseEventFramer({ limits: { maxEventBytes: 5 } });
    expect(() => eventLimited.feed(Buffer.from('data: abc\ndata: def\n'), () => {})).toThrow(/event exceeds/);

    const countLimited = new SseEventFramer({ limits: { maxEvents: 1 } });
    expect(() => countLimited.feed(Buffer.from('data: one\n\ndata: two\n\n'), () => {})).toThrow(/event count/);
  });

  it('does not emit events without data fields', () => {
    expect(frameChunks([Buffer.from('event: empty\n\nid: x\n\n')])).toEqual([]);
  });
});
