/** Provider-neutral, bounded SSE event framing. */

import { StringDecoder } from 'node:string_decoder';

export interface SseEventFrame {
  readonly eventType: string;
  /** Exact decoded data payload, with multi-line data joined by `\n`. */
  readonly dataUtf8: string;
}

export interface SseEventFramerLimits {
  readonly maxStreamBytes: number;
  readonly maxLineBytes: number;
  readonly maxEventBytes: number;
  readonly maxEvents: number;
}

export const DEFAULT_SSE_EVENT_FRAMER_LIMITS: SseEventFramerLimits = Object.freeze({
  maxStreamBytes: 32 * 1024 * 1024,
  maxLineBytes: 2 * 1024 * 1024,
  maxEventBytes: 4 * 1024 * 1024,
  maxEvents: 100_000,
});

export type SseFramingFailureReason =
  | 'stream-limit'
  | 'line-limit'
  | 'event-limit'
  | 'event-count-limit'
  | 'already-ended';

export class SseFramingError extends Error {
  constructor(
    readonly reason: SseFramingFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'SseFramingError';
  }
}

export interface SseEventFramerOptions {
  readonly limits?: Partial<SseEventFramerLimits>;
}

function limit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

/**
 * Incremental SSE framer with correct CR/LF/CRLF and split-UTF-8 handling.
 * It emits only complete events, except that `finish()` emits a pending data
 * event at EOF to preserve the existing trajectory capture behavior.
 */
export class SseEventFramer {
  private readonly decoder = new StringDecoder('utf8');
  private readonly limits: SseEventFramerLimits;
  private lineFragments: string[] = [];
  private lineBytes = 0;
  private currentEventType = '';
  private currentDataLines: string[] = [];
  private currentDataSeen = false;
  private currentDataBytes = 0;
  private eventCount = 0;
  private streamBytes = 0;
  private skipLeadingLf = false;
  private ended = false;

  constructor(options: SseEventFramerOptions = {}) {
    this.limits = Object.freeze({
      maxStreamBytes: limit(
        'maxStreamBytes',
        options.limits?.maxStreamBytes ?? DEFAULT_SSE_EVENT_FRAMER_LIMITS.maxStreamBytes,
      ),
      maxLineBytes: limit('maxLineBytes', options.limits?.maxLineBytes ?? DEFAULT_SSE_EVENT_FRAMER_LIMITS.maxLineBytes),
      maxEventBytes: limit(
        'maxEventBytes',
        options.limits?.maxEventBytes ?? DEFAULT_SSE_EVENT_FRAMER_LIMITS.maxEventBytes,
      ),
      maxEvents: limit('maxEvents', options.limits?.maxEvents ?? DEFAULT_SSE_EVENT_FRAMER_LIMITS.maxEvents),
    });
  }

  feed(chunk: Buffer, sink: (frame: SseEventFrame) => void): void {
    if (this.ended) throw new SseFramingError('already-ended', 'cannot feed an ended SSE framer');
    if (this.streamBytes + chunk.length > this.limits.maxStreamBytes) {
      throw new SseFramingError('stream-limit', 'SSE stream exceeds configured byte limit');
    }
    this.streamBytes += chunk.length;
    this.processText(this.decoder.write(chunk), sink);
  }

  finish(sink: (frame: SseEventFrame) => void): void {
    if (this.ended) return;
    this.processText(this.decoder.end(), sink);
    if (this.lineFragments.length > 0) this.finishLine(sink);
    if (this.currentDataSeen) this.emitEvent(sink);
    this.ended = true;
  }

  private processText(text: string, sink: (frame: SseEventFrame) => void): void {
    let pos = 0;
    if (this.skipLeadingLf) {
      this.skipLeadingLf = false;
      if (text[0] === '\n') pos = 1;
    }

    while (pos < text.length) {
      const nextLf = text.indexOf('\n', pos);
      const nextCr = text.indexOf('\r', pos);
      let lineEnd: number;
      if (nextLf === -1 && nextCr === -1) {
        this.appendLine(text.slice(pos));
        return;
      }
      if (nextCr === -1) lineEnd = nextLf;
      else if (nextLf === -1) lineEnd = nextCr;
      else lineEnd = Math.min(nextLf, nextCr);

      this.appendLine(text.slice(pos, lineEnd));
      this.finishLine(sink);
      const terminator = text[lineEnd];
      pos = lineEnd + 1;
      if (terminator === '\r') {
        if (pos < text.length && text[pos] === '\n') pos++;
        else if (pos === text.length) this.skipLeadingLf = true;
      }
    }
  }

  private appendLine(value: string): void {
    if (value.length === 0) return;
    const bytes = Buffer.byteLength(value, 'utf8');
    if (this.lineBytes + bytes > this.limits.maxLineBytes) {
      throw new SseFramingError('line-limit', 'SSE line exceeds configured byte limit');
    }
    this.lineFragments.push(value);
    this.lineBytes += bytes;
  }

  private finishLine(sink: (frame: SseEventFrame) => void): void {
    const line = this.lineFragments.join('');
    this.lineFragments = [];
    this.lineBytes = 0;
    this.processLine(line, sink);
  }

  private processLine(line: string, sink: (frame: SseEventFrame) => void): void {
    if (line === '') {
      if (this.currentDataSeen) this.emitEvent(sink);
      this.currentEventType = '';
      this.currentDataLines = [];
      this.currentDataSeen = false;
      this.currentDataBytes = 0;
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') {
      this.currentEventType = value;
      return;
    }
    if (field !== 'data') return;

    const separatorBytes = this.currentDataSeen ? 1 : 0;
    const valueBytes = Buffer.byteLength(value, 'utf8');
    if (this.currentDataBytes + separatorBytes + valueBytes > this.limits.maxEventBytes) {
      throw new SseFramingError('event-limit', 'SSE event exceeds configured byte limit');
    }
    this.currentDataLines.push(value);
    this.currentDataSeen = true;
    this.currentDataBytes += separatorBytes + valueBytes;
  }

  private emitEvent(sink: (frame: SseEventFrame) => void): void {
    if (!this.currentDataSeen) return;
    if (this.eventCount >= this.limits.maxEvents) {
      throw new SseFramingError('event-count-limit', 'SSE event count exceeds configured limit');
    }
    this.eventCount++;
    sink(Object.freeze({ eventType: this.currentEventType, dataUtf8: this.currentDataLines.join('\n') }));
  }
}

/** Compatibility surface for trajectory reassemblers while they migrate. */
export class SseLineSplitter {
  private readonly framer: SseEventFramer;

  constructor(options: SseEventFramerOptions = {}) {
    this.framer = new SseEventFramer(options);
  }

  feed(chunk: Buffer, sink: (eventType: string, dataUtf8: string) => void): void {
    this.framer.feed(chunk, (frame) => sink(frame.eventType, frame.dataUtf8));
  }

  flush(sink: (eventType: string, dataUtf8: string) => void): void {
    this.framer.finish((frame) => sink(frame.eventType, frame.dataUtf8));
  }
}
