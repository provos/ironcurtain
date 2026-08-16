/**
 * A bounded fan-out hub for passive response observation.
 *
 * Raw upstream bytes have one independent forwarding path. This hub accepts a
 * copy, decodes it once, frames SSE once, and isolates every observer behind
 * resource and exception boundaries.
 */

import {
  BoundedContentDecoder,
  type ContentDecoderFailure,
  type ContentDecoderLimits,
  type ContentDecoderSnapshot,
} from './content-decoder.js';
import { SseEventFramer, SseFramingError, type SseEventFrame, type SseEventFramerLimits } from './sse-event-framer.js';

export type ObservationConsumerDetachReason =
  | 'consumer-decoded-byte-limit'
  | 'consumer-event-count-limit'
  | 'consumer-callback-error'
  | 'consumer-returned-promise'
  | 'consumer-callback-time-limit'
  | 'sse-framing-failure'
  | 'content-decoding-failure'
  | 'hub-input-queue-limit'
  | 'hub-aborted';

export interface ObservationConsumerDetached {
  readonly consumerId: string;
  readonly reason: ObservationConsumerDetachReason;
  readonly message: string;
}

export interface ResponseObservationConsumer {
  readonly id: string;
  /** Per-consumer cap; cannot exceed the shared decoder's cap. */
  readonly maxDecodedBytes?: number;
  readonly maxSseEvents?: number;
  /** Buffers are defensive copies and may be retained by the consumer. */
  readonly onDecodedChunk?: (chunk: Buffer) => void;
  readonly onSseEvent?: (frame: SseEventFrame) => void;
  readonly onEnd?: () => void;
  readonly onDetach?: (detached: ObservationConsumerDetached) => void;
}

export interface ResponseObservationHubOptions {
  readonly contentEncoding?: string;
  readonly frameSse: boolean;
  readonly consumers: readonly ResponseObservationConsumer[];
  readonly decoderLimits?: Partial<ContentDecoderLimits>;
  readonly sseLimits?: Partial<SseEventFramerLimits>;
  /** Maximum raw bytes waiting for the asynchronous observation pump. */
  readonly maxQueuedCompressedBytes?: number;
  /** Maximum queued chunks, independently of their byte size. */
  readonly maxQueuedChunks?: number;
  /** A callback exceeding this duration is detached after that invocation. */
  readonly maxCallbackDurationMs?: number;
  readonly onDecoderFailure?: (failure: ContentDecoderFailure) => void;
}

interface ConsumerState {
  readonly consumer: ResponseObservationConsumer;
  active: boolean;
  decodedBytes: number;
  sseEvents: number;
  detached?: ObservationConsumerDetached;
}

export interface ResponseObservationConsumerSnapshot {
  readonly id: string;
  readonly active: boolean;
  readonly decodedBytes: number;
  readonly sseEvents: number;
  readonly detached?: ObservationConsumerDetached;
}

export interface ResponseObservationHubSnapshot {
  readonly decoder: ContentDecoderSnapshot;
  readonly queuedCompressedBytes: number;
  readonly endRequested: boolean;
  readonly framingFailure?: { readonly reason: string; readonly message: string };
  readonly consumers: readonly ResponseObservationConsumerSnapshot[];
}

const DEFAULT_CONSUMER_MAX_DECODED_BYTES = 32 * 1024 * 1024;
const DEFAULT_CONSUMER_MAX_SSE_EVENTS = 100_000;
const DEFAULT_MAX_CALLBACK_DURATION_MS = 25;
const DEFAULT_MAX_QUEUED_COMPRESSED_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_QUEUED_CHUNKS = 65_536;
const MAX_CHUNKS_PER_PUMP = 64;

function positiveLimit(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
  return value;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    'then' in value &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** The hub never participates in the upstream→client pipe. */
export class ResponseObservationHub {
  private readonly consumers: ConsumerState[];
  private readonly framer?: SseEventFramer;
  private readonly decoder: BoundedContentDecoder;
  private readonly maxCallbackDurationMs: number;
  private readonly maxQueuedCompressedBytes: number;
  private readonly maxQueuedChunks: number;
  private readonly rawQueue: Buffer[] = [];
  private rawQueueHead = 0;
  private queuedCompressedBytes = 0;
  private pumpScheduled = false;
  private endRequested = false;
  private framingFailure?: { readonly reason: string; readonly message: string };
  private ended = false;

  constructor(options: ResponseObservationHubOptions) {
    this.maxCallbackDurationMs = positiveLimit(
      'maxCallbackDurationMs',
      options.maxCallbackDurationMs ?? DEFAULT_MAX_CALLBACK_DURATION_MS,
    );
    this.maxQueuedCompressedBytes = positiveLimit(
      'maxQueuedCompressedBytes',
      options.maxQueuedCompressedBytes ?? DEFAULT_MAX_QUEUED_COMPRESSED_BYTES,
    );
    this.maxQueuedChunks = positiveLimit('maxQueuedChunks', options.maxQueuedChunks ?? DEFAULT_MAX_QUEUED_CHUNKS);
    const seenIds = new Set<string>();
    this.consumers = options.consumers.map((consumer) => {
      if (consumer.id.length === 0) throw new Error('observation consumer id must not be empty');
      if (seenIds.has(consumer.id)) throw new Error(`duplicate observation consumer id: ${consumer.id}`);
      seenIds.add(consumer.id);
      if (consumer.maxDecodedBytes !== undefined) positiveLimit('maxDecodedBytes', consumer.maxDecodedBytes);
      if (consumer.maxSseEvents !== undefined) positiveLimit('maxSseEvents', consumer.maxSseEvents);
      return { consumer, active: true, decodedBytes: 0, sseEvents: 0 };
    });
    this.framer = options.frameSse ? new SseEventFramer({ limits: options.sseLimits }) : undefined;
    this.decoder = new BoundedContentDecoder({
      contentEncoding: options.contentEncoding,
      limits: options.decoderLimits,
      onDecodedChunk: (chunk) => this.onDecodedChunk(chunk),
      onEnd: () => this.onDecodedEnd(),
      onFailure: (failure) => {
        this.ended = true;
        this.clearRawQueue();
        for (const state of this.consumers) {
          if (state.active) this.detachConsumer(state, 'content-decoding-failure', failure.message);
        }
        try {
          options.onDecoderFailure?.(failure);
        } catch {
          // Health listeners are observation consumers too.
        }
      },
    });
  }

  /** Copy raw upstream bytes into observation. Never throws or backpressures. */
  write(chunk: Buffer): void {
    if (this.ended || this.endRequested || chunk.length === 0) return;
    if (
      this.queuedCompressedBytes + chunk.length > this.maxQueuedCompressedBytes ||
      this.rawQueue.length - this.rawQueueHead >= this.maxQueuedChunks
    ) {
      this.failInputQueue('response observation input queue limit exceeded');
      return;
    }
    // The upstream may reuse its chunk after listeners return. Own the copy
    // before yielding; no consumer callback runs in this forwarding stack.
    try {
      this.rawQueue.push(Buffer.from(chunk));
    } catch (error) {
      this.failInputQueue(error instanceof Error ? error.message : 'unable to copy observation input');
      return;
    }
    this.queuedCompressedBytes += chunk.length;
    this.schedulePump();
  }

  /** Finish decoding/framing. Completion callbacks are invoked at most once. */
  end(): void {
    if (this.ended || this.endRequested) return;
    this.endRequested = true;
    this.schedulePump();
  }

  abort(message = 'response observation aborted'): void {
    if (this.ended) return;
    this.ended = true;
    this.clearRawQueue();
    for (const state of this.consumers) {
      if (state.active) this.detachConsumer(state, 'hub-aborted', message);
    }
    this.decoder.detach('consumer-error', message);
  }

  snapshot(): ResponseObservationHubSnapshot {
    return Object.freeze({
      decoder: this.decoder.snapshot(),
      queuedCompressedBytes: this.queuedCompressedBytes,
      endRequested: this.endRequested,
      ...(this.framingFailure ? { framingFailure: this.framingFailure } : {}),
      consumers: Object.freeze(
        this.consumers.map((state) =>
          Object.freeze({
            id: state.consumer.id,
            active: state.active,
            decodedBytes: state.decodedBytes,
            sseEvents: state.sseEvents,
            ...(state.detached ? { detached: state.detached } : {}),
          }),
        ),
      ),
    });
  }

  private schedulePump(): void {
    if (this.pumpScheduled || this.ended) return;
    this.pumpScheduled = true;
    setImmediate(() => {
      this.pumpScheduled = false;
      this.pumpOne();
    });
  }

  private pumpOne(): void {
    if (this.ended) return;
    let processed = 0;
    while (this.rawQueueHead < this.rawQueue.length && processed < MAX_CHUNKS_PER_PUMP) {
      const chunk = this.rawQueue[this.rawQueueHead++];
      this.queuedCompressedBytes -= chunk.length;
      try {
        this.decoder.write(chunk);
      } catch {
        this.abort('content decoder escaped its exception boundary');
        return;
      }
      processed += 1;
    }
    if (this.rawQueueHead < this.rawQueue.length) {
      this.schedulePump();
      return;
    }
    this.rawQueue.length = 0;
    this.rawQueueHead = 0;
    if (this.endRequested) {
      try {
        this.decoder.end();
      } catch {
        this.abort('content decoder end escaped its exception boundary');
      }
    }
  }

  private failInputQueue(message: string): void {
    if (this.ended) return;
    this.ended = true;
    this.clearRawQueue();
    for (const state of this.consumers) {
      if (state.active) this.detachConsumer(state, 'hub-input-queue-limit', message);
    }
    this.decoder.detach('consumer-error', message);
  }

  private onDecodedChunk(chunk: Buffer): void {
    if (!this.consumers.some((state) => state.active)) return;

    for (const state of this.consumers) {
      if (!state.active) continue;
      const maxBytes = state.consumer.maxDecodedBytes ?? DEFAULT_CONSUMER_MAX_DECODED_BYTES;
      if (state.decodedBytes + chunk.length > maxBytes) {
        this.detachConsumer(state, 'consumer-decoded-byte-limit', 'consumer decoded-byte limit exceeded');
        continue;
      }
      state.decodedBytes += chunk.length;
      if (state.consumer.onDecodedChunk) {
        this.invokeConsumer(state, () => state.consumer.onDecodedChunk?.(Buffer.from(chunk)));
      }
    }
    if (this.ended) return;

    // Decoded-chunk consumers receive defensive copies, so framing cannot be
    // affected by consumer mutation even though byte limits are checked first.
    if (this.framer && !this.framingFailure) {
      try {
        this.framer.feed(chunk, (frame) => this.deliverSseFrame(frame));
      } catch (error) {
        this.failFraming(error);
      }
    }
  }

  private deliverSseFrame(frame: SseEventFrame): void {
    for (const state of this.consumers) {
      if (!state.active || !state.consumer.onSseEvent) continue;
      const maxEvents = state.consumer.maxSseEvents ?? DEFAULT_CONSUMER_MAX_SSE_EVENTS;
      if (state.sseEvents >= maxEvents) {
        this.detachConsumer(state, 'consumer-event-count-limit', 'consumer SSE event limit exceeded');
        continue;
      }
      state.sseEvents++;
      this.invokeConsumer(state, () => state.consumer.onSseEvent?.(frame));
    }
  }

  private onDecodedEnd(): void {
    if (this.ended) return;
    if (this.framer && !this.framingFailure) {
      try {
        this.framer.finish((frame) => this.deliverSseFrame(frame));
      } catch (error) {
        this.failFraming(error);
      }
    }
    this.ended = true;
    for (const state of this.consumers) {
      if (state.active) this.invokeConsumer(state, () => state.consumer.onEnd?.());
    }
  }

  private failFraming(error: unknown): void {
    const reason = error instanceof SseFramingError ? error.reason : 'unexpected-framing-error';
    const message = error instanceof Error ? error.message : String(error);
    this.framingFailure = Object.freeze({ reason, message });
    for (const state of this.consumers) {
      if (state.active && state.consumer.onSseEvent) {
        this.detachConsumer(state, 'sse-framing-failure', message);
      }
    }
  }

  private invokeConsumer(state: ConsumerState, invoke: () => unknown): void {
    if (!state.active) return;
    const started = performance.now();
    let result: unknown;
    try {
      result = invoke();
    } catch (error) {
      this.detachConsumer(state, 'consumer-callback-error', error instanceof Error ? error.message : String(error));
      return;
    }
    if (isPromiseLike(result)) {
      // Do not await a consumer on the forwarding event-loop path. Attach a
      // rejection handler solely to prevent an unhandled-rejection warning.
      void Promise.resolve(result).catch(() => {});
      this.detachConsumer(state, 'consumer-returned-promise', 'observation callbacks must be synchronous');
      return;
    }
    if (performance.now() - started > this.maxCallbackDurationMs) {
      this.detachConsumer(state, 'consumer-callback-time-limit', 'observation callback exceeded time limit');
    }
  }

  private detachConsumer(state: ConsumerState, reason: ObservationConsumerDetachReason, message: string): void {
    if (!state.active) return;
    state.active = false;
    state.detached = Object.freeze({ consumerId: state.consumer.id, reason, message });
    try {
      state.consumer.onDetach?.(state.detached);
    } catch {
      // A detach callback cannot affect another consumer.
    }
    if (!this.ended && this.consumers.every((consumer) => !consumer.active)) {
      this.ended = true;
      this.clearRawQueue();
      this.decoder.detach('consumer-error', 'all response observation consumers detached');
    }
  }

  private clearRawQueue(): void {
    this.rawQueue.length = 0;
    this.rawQueueHead = 0;
    this.queuedCompressedBytes = 0;
  }
}
