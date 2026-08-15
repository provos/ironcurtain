/**
 * Bounded, fail-open decoding for passive LLM response observation.
 *
 * This is deliberately not a forwarding stream. Callers continue forwarding
 * the original upstream bytes and copy them into this side branch. A corrupt,
 * unsupported, or unexpectedly large body detaches observation only.
 */

import * as zlib from 'node:zlib';
import type { Transform } from 'node:stream';

export type ContentDecodingFailureReason =
  | 'unsupported-encoding'
  | 'compressed-byte-limit'
  | 'decoded-byte-limit'
  | 'expansion-ratio-limit'
  | 'decoder-backpressure'
  | 'decoder-error'
  | 'consumer-error';

export interface ContentDecoderLimits {
  /** Maximum wire bytes copied into this observation branch. */
  readonly maxCompressedBytes: number;
  /** Maximum decoded bytes delivered to the observer. */
  readonly maxDecodedBytes: number;
  /** Maximum decoded/wire expansion after the configured slack. */
  readonly maxExpansionRatio: number;
  /** Allows small compressed bodies to expand without noisy ratio failures. */
  readonly expansionRatioSlackBytes: number;
}

export const DEFAULT_CONTENT_DECODER_LIMITS: ContentDecoderLimits = Object.freeze({
  maxCompressedBytes: 16 * 1024 * 1024,
  maxDecodedBytes: 32 * 1024 * 1024,
  maxExpansionRatio: 64,
  expansionRatioSlackBytes: 64 * 1024,
});

export interface ContentDecoderFailure {
  readonly reason: ContentDecodingFailureReason;
  readonly message: string;
  readonly compressedBytes: number;
  readonly decodedBytes: number;
}

export interface ContentDecoderSnapshot {
  readonly state: 'active' | 'ended' | 'detached';
  readonly compressedBytes: number;
  readonly decodedBytes: number;
  readonly failure?: ContentDecoderFailure;
}

export interface BoundedContentDecoderOptions {
  readonly contentEncoding?: string;
  readonly limits?: Partial<ContentDecoderLimits>;
  readonly onDecodedChunk: (chunk: Buffer) => void;
  readonly onEnd?: () => void;
  readonly onFailure?: (failure: ContentDecoderFailure) => void;
}

function positiveFinite(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return value;
}

function resolveLimits(overrides: Partial<ContentDecoderLimits> | undefined): ContentDecoderLimits {
  return Object.freeze({
    maxCompressedBytes: positiveFinite(
      'maxCompressedBytes',
      overrides?.maxCompressedBytes ?? DEFAULT_CONTENT_DECODER_LIMITS.maxCompressedBytes,
    ),
    maxDecodedBytes: positiveFinite(
      'maxDecodedBytes',
      overrides?.maxDecodedBytes ?? DEFAULT_CONTENT_DECODER_LIMITS.maxDecodedBytes,
    ),
    maxExpansionRatio: positiveFinite(
      'maxExpansionRatio',
      overrides?.maxExpansionRatio ?? DEFAULT_CONTENT_DECODER_LIMITS.maxExpansionRatio,
    ),
    expansionRatioSlackBytes: positiveFinite(
      'expansionRatioSlackBytes',
      overrides?.expansionRatioSlackBytes ?? DEFAULT_CONTENT_DECODER_LIMITS.expansionRatioSlackBytes,
    ),
  });
}

function normalizeEncoding(value: string | undefined): string {
  return (value ?? 'identity').trim().toLowerCase();
}

function createDecoder(encoding: string): Transform | undefined {
  switch (encoding) {
    case 'identity':
    case '':
      return undefined;
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip();
    case 'deflate':
      return zlib.createInflate();
    case 'br':
      return zlib.createBrotliDecompress();
    default:
      return undefined;
  }
}

function isIdentityEncoding(encoding: string): boolean {
  return encoding === '' || encoding === 'identity';
}

/**
 * Incrementally decodes copied response bytes under hard resource limits.
 * Public methods and observer callbacks are exception-isolated: decoder
 * faults change the state to `detached` and never throw into forwarding.
 */
export class BoundedContentDecoder {
  private readonly limits: ContentDecoderLimits;
  private readonly encoding: string;
  private readonly decoder?: Transform;
  private readonly onDecodedChunk: (chunk: Buffer) => void;
  private readonly onEnd?: () => void;
  private readonly onFailure?: (failure: ContentDecoderFailure) => void;
  private state: ContentDecoderSnapshot['state'] = 'active';
  private endRequested = false;
  private compressedBytes = 0;
  private decodedBytes = 0;
  private failure?: ContentDecoderFailure;

  constructor(options: BoundedContentDecoderOptions) {
    this.limits = resolveLimits(options.limits);
    this.encoding = normalizeEncoding(options.contentEncoding);
    this.onDecodedChunk = options.onDecodedChunk;
    this.onEnd = options.onEnd;
    this.onFailure = options.onFailure;
    this.decoder = createDecoder(this.encoding);

    if (!isIdentityEncoding(this.encoding) && this.decoder === undefined) {
      this.detach('unsupported-encoding', `unsupported content-encoding: ${this.encoding}`);
      return;
    }

    if (this.decoder) {
      this.decoder.on('data', (chunk: Buffer) => this.deliverDecoded(chunk));
      this.decoder.once('end', () => this.finishSuccessfully());
      this.decoder.once('error', (error: Error) => {
        this.detach('decoder-error', error.message);
      });
    }
  }

  /** Copy one raw upstream chunk into the observation branch. */
  write(chunk: Buffer): void {
    if (this.state !== 'active' || this.endRequested || chunk.length === 0) return;
    this.compressedBytes += chunk.length;
    if (this.compressedBytes > this.limits.maxCompressedBytes) {
      this.detach('compressed-byte-limit', 'compressed response observation limit exceeded');
      return;
    }

    if (!this.decoder) {
      this.deliverDecoded(chunk);
      return;
    }

    try {
      // The observation branch must not queue behind zlib. Forwarding owns
      // the real flow-control path, so a false return detaches this copy.
      if (!this.decoder.write(chunk)) {
        this.detach('decoder-backpressure', 'content decoder requested backpressure');
      }
    } catch (error) {
      this.detach('decoder-error', error instanceof Error ? error.message : String(error));
    }
  }

  /** Signal that the copied upstream body ended. Safe to call repeatedly. */
  end(): void {
    if (this.state !== 'active' || this.endRequested) return;
    this.endRequested = true;
    if (!this.decoder) {
      this.finishSuccessfully();
      return;
    }
    try {
      this.decoder.end();
    } catch (error) {
      this.detach('decoder-error', error instanceof Error ? error.message : String(error));
    }
  }

  /** Explicitly stop observing without affecting the forwarding stream. */
  detach(reason: ContentDecodingFailureReason, message: string = reason): void {
    if (this.state !== 'active') return;
    this.state = 'detached';
    this.failure = Object.freeze({
      reason,
      message,
      compressedBytes: this.compressedBytes,
      decodedBytes: this.decodedBytes,
    });
    if (this.decoder && !this.decoder.destroyed) this.decoder.destroy();
    try {
      this.onFailure?.(this.failure);
    } catch {
      // Health reporting is part of observation and is isolated too.
    }
  }

  snapshot(): ContentDecoderSnapshot {
    return Object.freeze({
      state: this.state,
      compressedBytes: this.compressedBytes,
      decodedBytes: this.decodedBytes,
      ...(this.failure ? { failure: this.failure } : {}),
    });
  }

  private deliverDecoded(chunk: Buffer): void {
    if (this.state !== 'active' || chunk.length === 0) return;
    const nextDecodedBytes = this.decodedBytes + chunk.length;
    if (nextDecodedBytes > this.limits.maxDecodedBytes) {
      this.detach('decoded-byte-limit', 'decoded response observation limit exceeded');
      return;
    }
    const expansionLimit = this.compressedBytes * this.limits.maxExpansionRatio + this.limits.expansionRatioSlackBytes;
    if (nextDecodedBytes > expansionLimit) {
      this.detach('expansion-ratio-limit', 'response decompression expansion ratio exceeded');
      return;
    }
    this.decodedBytes = nextDecodedBytes;
    try {
      this.onDecodedChunk(chunk);
    } catch (error) {
      this.detach('consumer-error', error instanceof Error ? error.message : String(error));
    }
  }

  private finishSuccessfully(): void {
    if (this.state !== 'active') return;
    this.state = 'ended';
    try {
      this.onEnd?.();
    } catch {
      // Completion notification cannot escape into forwarding.
    }
  }
}
