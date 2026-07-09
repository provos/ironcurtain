/**
 * DEBUG stream-delay injection (issue #367 watchdog reproduction).
 *
 * A Transform that injects a single controllable idle gap into the
 * agent-facing forwarding stream, reproducing exactly what Claude Code's
 * streaming idle watchdog measures: elapsed time between response bytes
 * arriving at the client. Lets us test — deterministically and without a real
 * slow model — whether the watchdog aborts a stalled stream behind the MITM
 * and whether `CLAUDE_ENABLE_STREAM_WATCHDOG=0` suppresses it.
 *
 * This is a debug affordance only. The MITM never installs it unless
 * `IRONCURTAIN_MITM_STREAM_DELAY_MS` is a positive integer.
 */
import { Transform, type TransformCallback } from 'node:stream';

export type StreamDelayMode = 'mid-stream' | 'first-token';

export interface StreamDelayConfig {
  readonly delayMs: number;
  readonly mode: StreamDelayMode;
  /** When set, only delay upstream hosts whose name includes this substring. */
  readonly hostFilter?: string;
}

/**
 * Injects one idle gap into a byte stream.
 *
 * Modes:
 *  - 'mid-stream'  : forward the first chunk immediately, then inject the gap
 *                    before the next chunk. Faithful to the original "Response
 *                    stalled mid-stream" symptom. Needs the upstream to emit
 *                    >= 2 chunks — always true for a real SSE completion.
 *  - 'first-token' : hold the very first chunk for the gap (stall before any
 *                    body byte). Triggers regardless of upstream chunking.
 *
 * Bytes are never altered — only their arrival timing. The delayed chunk's
 * callback is deferred with `setTimeout`, which naturally backpressures the
 * upstream and defers stream `end` until the gap elapses.
 */
export class StreamDelayTransform extends Transform {
  private chunkIndex = 0;
  private readonly delayMs: number;
  private readonly mode: StreamDelayMode;

  constructor(delayMs: number, mode: StreamDelayMode) {
    super();
    this.delayMs = delayMs;
    this.mode = mode;
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    const idx = this.chunkIndex++;
    const inject = this.mode === 'first-token' ? idx === 0 : idx === 1;
    if (inject) {
      setTimeout(() => callback(null, chunk), this.delayMs);
    } else {
      callback(null, chunk);
    }
  }
}

/**
 * Parse the stream-delay debug config from the environment. Returns null (the
 * zero-cost default) unless `IRONCURTAIN_MITM_STREAM_DELAY_MS` is a positive
 * integer. `IRONCURTAIN_MITM_STREAM_DELAY_MODE` selects the mode (default
 * `mid-stream`); `IRONCURTAIN_MITM_STREAM_DELAY_HOST` optionally restricts it
 * to upstream hosts whose name contains the given substring.
 */
export function parseStreamDelayConfig(env: NodeJS.ProcessEnv = process.env): StreamDelayConfig | null {
  const raw = env.IRONCURTAIN_MITM_STREAM_DELAY_MS;
  if (!raw) return null;
  const delayMs = Number.parseInt(raw, 10);
  if (!Number.isFinite(delayMs) || delayMs <= 0) return null;
  const mode: StreamDelayMode = env.IRONCURTAIN_MITM_STREAM_DELAY_MODE === 'first-token' ? 'first-token' : 'mid-stream';
  const hostFilter = env.IRONCURTAIN_MITM_STREAM_DELAY_HOST || undefined;
  return { delayMs, mode, hostFilter };
}
