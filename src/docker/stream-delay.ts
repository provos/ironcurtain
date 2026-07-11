/**
 * DEBUG stream-delay injection (issue #367 watchdog reproduction).
 *
 * Host-side MITM affordance for exercising Claude Code's streaming idle / stall
 * behavior without a real slow model. Two regimes:
 *
 *  - **stall** (`mid-stream` / `first-token`): inject a single idle gap into the
 *    agent-facing forwarding stream — reproduces a *complete* stall (no bytes
 *    for N ms), which is what idle watchdogs measure.
 *  - **drip**: re-pace the whole response to a trickle (a few bytes every N ms)
 *    — reproduces a *very slow but not stalled* model. The stream never idles
 *    long enough to trip an idle watchdog, but the total response drags on, so
 *    this isolates duration/throughput-based aborts from idle-based ones.
 *
 * Debug only; never installed unless `IRONCURTAIN_MITM_STREAM_DELAY_MS` is a
 * positive integer.
 */
import { Transform, type TransformCallback } from 'node:stream';

export type StreamDelayMode = 'mid-stream' | 'first-token' | 'drip';

export interface StreamDelayConfig {
  /** Gap size (stall modes) or inter-emit interval (drip mode), in ms. */
  readonly delayMs: number;
  readonly mode: StreamDelayMode;
  /** When set, only delay upstream hosts whose name includes this substring. */
  readonly hostFilter?: string;
  /** drip mode: bytes emitted per `delayMs` tick (default 1). */
  readonly dripBytes: number;
}

/**
 * Injects one idle gap into a byte stream (stall regime).
 *
 *  - 'mid-stream'  : forward the first chunk immediately, then inject the gap
 *                    before the next chunk. Faithful to the original "Response
 *                    stalled mid-stream" symptom. Needs the upstream to emit
 *                    >= 2 chunks — always true for a real SSE completion.
 *  - 'first-token' : hold the very first chunk for the gap (stall before any
 *                    body byte). Triggers regardless of upstream chunking.
 *
 * Bytes are never altered — only their arrival timing.
 */
export class GapDelayTransform extends Transform {
  private chunkIndex = 0;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly delayMs: number;
  private readonly mode: 'mid-stream' | 'first-token';

  constructor(delayMs: number, mode: 'mid-stream' | 'first-token') {
    super();
    this.delayMs = delayMs;
    this.mode = mode;
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    const idx = this.chunkIndex++;
    const inject = this.mode === 'first-token' ? idx === 0 : idx === 1;
    if (inject) {
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null;
        callback(null, chunk);
      }, this.delayMs);
      // A pending gap can be multi-minute; don't hold the event loop open, and
      // clear it in _destroy so the callback never fires after teardown.
      this.pendingTimer.unref();
    } else {
      callback(null, chunk);
    }
  }

  _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    callback(error);
  }
}

/**
 * Bound the drip buffer: once this many undrained bytes are queued, stop
 * accepting from upstream (withhold the write callback) until the trickle drains
 * back below it. Keeps a large/fast upstream from growing the queue unbounded.
 */
const DRIP_HIGH_WATER_BYTES = 1 << 20; // 1 MiB

/**
 * Re-paces a byte stream to a trickle: accepts upstream bytes (buffering them,
 * up to a high-water mark) and re-emits `bytesPerTick` bytes every `intervalMs`.
 * Simulates a very slow model whose stream never fully stalls. Bytes and their
 * order are preserved; only throughput is throttled. Honors backpressure so the
 * buffer stays bounded even if the upstream produces faster than the drip rate.
 */
export class SlowDripTransform extends Transform {
  private readonly queue: Buffer[] = [];
  private headOffset = 0;
  private queuedBytes = 0;
  private pendingWriteCallback: TransformCallback | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ended = false;
  private flushCallback: TransformCallback | null = null;
  private readonly intervalMs: number;
  private readonly bytesPerTick: number;

  constructor(intervalMs: number, bytesPerTick: number) {
    super();
    this.intervalMs = intervalMs;
    this.bytesPerTick = Math.max(1, bytesPerTick);
  }

  private hasBytes(): boolean {
    return this.queue.length > 0;
  }

  private emitBytes(n: number): void {
    const out: Buffer[] = [];
    let need = n;
    let emitted = 0;
    while (need > 0 && this.queue.length > 0) {
      const head = this.queue[0];
      const avail = head.length - this.headOffset;
      const take = Math.min(need, avail);
      out.push(head.subarray(this.headOffset, this.headOffset + take));
      this.headOffset += take;
      need -= take;
      emitted += take;
      if (this.headOffset >= head.length) {
        this.queue.shift();
        this.headOffset = 0;
      }
    }
    if (out.length > 0) this.push(Buffer.concat(out));
    this.queuedBytes -= emitted;
    // Draining below the mark resumes a withheld upstream write.
    if (this.pendingWriteCallback && this.queuedBytes < DRIP_HIGH_WATER_BYTES) {
      const cb = this.pendingWriteCallback;
      this.pendingWriteCallback = null;
      cb();
    }
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.destroyed) {
        this.stopTimer();
        return;
      }
      if (this.hasBytes()) this.emitBytes(this.bytesPerTick);
      if (!this.hasBytes() && this.ended) {
        this.stopTimer();
        const cb = this.flushCallback;
        this.flushCallback = null;
        cb?.();
      }
    }, this.intervalMs);
    // Debug-only, possibly multi-minute interval: never keep the loop alive.
    this.timer.unref();
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (chunk.length > 0) {
      this.queue.push(chunk);
      this.queuedBytes += chunk.length;
    }
    this.ensureTimer();
    // Emission is paced by the timer. Accept more only while the buffer is under
    // the high-water mark; otherwise withhold the callback so the upstream pipe
    // slows down — the timer's drain resumes it. Keeps the buffer bounded.
    if (this.queuedBytes < DRIP_HIGH_WATER_BYTES) {
      callback();
    } else {
      this.pendingWriteCallback = callback;
    }
  }

  _flush(callback: TransformCallback): void {
    this.ended = true;
    // If the queue already drained, finish now instead of waiting a full
    // (possibly multi-minute) tick to notice.
    if (!this.hasBytes()) {
      this.stopTimer();
      callback();
      return;
    }
    this.flushCallback = callback;
    this.ensureTimer();
  }

  _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    this.stopTimer();
    // Settle a withheld upstream write so it doesn't hang on teardown.
    if (this.pendingWriteCallback) {
      const cb = this.pendingWriteCallback;
      this.pendingWriteCallback = null;
      cb(error);
    }
    callback(error);
  }
}

/** Build the transform for a resolved stream-delay config. */
export function createStreamDelayTransform(config: StreamDelayConfig): Transform {
  return config.mode === 'drip'
    ? new SlowDripTransform(config.delayMs, config.dripBytes)
    : new GapDelayTransform(config.delayMs, config.mode);
}

/**
 * Parse the stream-delay debug config from the environment. Returns null (the
 * zero-cost default) unless `IRONCURTAIN_MITM_STREAM_DELAY_MS` is a positive
 * integer. `IRONCURTAIN_MITM_STREAM_DELAY_MODE` selects the mode (default
 * `mid-stream`); `IRONCURTAIN_MITM_STREAM_DELAY_HOST` optionally restricts it
 * to upstream hosts whose name contains the given substring;
 * `IRONCURTAIN_MITM_STREAM_DRIP_BYTES` sets the drip-mode bytes-per-tick.
 */
export function parseStreamDelayConfig(env: NodeJS.ProcessEnv = process.env): StreamDelayConfig | null {
  const raw = env.IRONCURTAIN_MITM_STREAM_DELAY_MS;
  if (!raw) return null;
  // Strict: `Number(...)` (not parseInt) so a partially-numeric value like
  // "100ms" is rejected rather than silently enabling the harness with 100.
  const delayMs = Number(raw);
  if (!Number.isInteger(delayMs) || delayMs <= 0) return null;
  const modeRaw = env.IRONCURTAIN_MITM_STREAM_DELAY_MODE;
  const mode: StreamDelayMode = modeRaw === 'first-token' || modeRaw === 'drip' ? modeRaw : 'mid-stream';
  const hostFilter = env.IRONCURTAIN_MITM_STREAM_DELAY_HOST || undefined;
  const dripRaw = Number(env.IRONCURTAIN_MITM_STREAM_DRIP_BYTES);
  const dripBytes = Number.isInteger(dripRaw) && dripRaw > 0 ? dripRaw : 1;
  return { delayMs, mode, hostFilter, dripBytes };
}
