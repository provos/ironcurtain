/**
 * Capture-tap helpers used by the MITM proxy.
 *
 * Wraps the messy bookkeeping needed to:
 *   1. Tee a request body off `clientReq` without disturbing
 *      `clientReq.pipe(upstreamReq)`.
 *   2. Tee an upstream response off `upstreamRes` while it still flows
 *      to either `clientRes` or a sibling extractor pipeline.
 *   3. Assemble an `ExchangeRecord` and hand it to a
 *      `TrajectoryCaptureWriter` after both halves settle.
 *
 * Pulled into a separate module so `mitm-proxy.ts` stays focused on
 * forwarding and the capture machinery is unit-testable in isolation.
 *
 * Design references: docs/designs/mitm-token-trajectory-capture.md §3 (taps),
 * §4 (record shape), §5 (reassembly), §6 (byte fidelity), §8 (credential
 * boundary), §9 (lifecycle / poison wiring).
 */

import { PassThrough, Writable } from 'node:stream';
import * as zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import type { TrajectoryCaptureWriter } from './trajectory-capture.js';
import { type Reassembler, redactHeaders } from './trajectory-types.js';
import type { ExchangeRecord, PoisonReason } from './trajectory-types.js';
import { createReassembler, providerForHost, ReassemblyError } from './trajectory-reassembler.js';
import type { SessionId } from '../session/types.js';
import * as logger from '../logger.js';

/** Reused for the (ignored) responseBody arg on the reassembler path. */
const EMPTY_BODY = Buffer.alloc(0);

/**
 * Decode a Buffer as UTF-8 if it round-trips losslessly, otherwise
 * fall back to base64. Mirrors the §6 invariant #6 ("bodyUtf8 honesty"):
 * never silently corrupt bytes by lossily decoding compressed or non-text
 * payloads.
 */
function bodyToFields(buf: Buffer): { bodyUtf8: string; bodyBase64?: string; bodyBytes: number } {
  const bytes = buf.length;
  // A UTF-8 decode followed by an encode must round-trip exactly. Buffer.toString('utf-8')
  // silently replaces invalid sequences with U+FFFD, which would corrupt the corpus.
  const decoded = buf.toString('utf-8');
  const reencoded = Buffer.from(decoded, 'utf-8');
  if (reencoded.length === bytes && reencoded.equals(buf)) {
    return { bodyUtf8: decoded, bodyBytes: bytes };
  }
  return { bodyUtf8: '', bodyBase64: buf.toString('base64'), bodyBytes: bytes };
}

export interface BeginCaptureExchangeInputs {
  readonly writer: TrajectoryCaptureWriter;
  readonly sessionId: SessionId;
  readonly persona?: string;
  readonly workflowRunId?: string;
  readonly bundleId?: string;
  readonly recordedAgentName?: string;
  readonly host: string;
  readonly path: string;
  readonly method: string;
  /** Original (pre-key-swap) client request headers. */
  readonly requestHeaders: Readonly<Record<string, string | string[] | undefined>>;
  /** Encoding header from the request body, captured verbatim (no decode). */
  readonly requestContentEncoding?: string;
  readonly requestStartedAt: number;
}

export interface CaptureExchangeHandle {
  /** Append a chunk of the request body as it is teed off `clientReq`. */
  pushRequestChunk(chunk: Buffer): void;
  /** Finalize the request body. Called from `clientReq.on('end')` or when buffered. */
  finishRequest(): void;
  /** Provide a pre-buffered request body (rewrite path). Bypasses pushRequestChunk. */
  setRequestBody(buf: Buffer): void;
  /**
   * Hook the upstream response. Must be called from inside the
   * `upstreamRes` callback. Installs a PassThrough on the response so
   * we observe every byte the agent sees. Returns the tap stream the
   * caller should pipe `upstreamRes` through; the caller is then
   * responsible for piping the tap's downstream side onward to the
   * existing extractor/clientRes pipeline.
   */
  attachResponse(args: AttachResponseInputs): PassThrough;
  /**
   * Force-abort the capture (e.g. on upstream error / agent disconnect).
   * Marks reassembly as failed and emits no record. The dispatcher's
   * own poisoning machinery handles session-level fallout via
   * mid-stream-abort detection on the captureTap.
   */
  abort(): void;
}

export interface AttachResponseInputs {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/**
 * Build a per-exchange capture handle. The MITM-proxy request handler
 * invokes this once at the start of a captured exchange and drives the
 * handle through its lifecycle: feed request bytes → attach response →
 * await `responseFinished` to write the record.
 */
export function beginCaptureExchange(inputs: BeginCaptureExchangeInputs): CaptureExchangeHandle {
  const exchangeId = randomUUID();
  const requestChunks: Buffer[] = [];
  let requestBytes = 0;
  let requestFinishedAt = 0;
  let requestFinalized = false;
  let aborted = false;
  let bufferedRequestBody: Buffer | undefined;

  function maybeWriteRecord(args: {
    statusCode: number;
    responseHeaders: Readonly<Record<string, string | string[] | undefined>>;
    streaming: boolean;
    responseBody: Buffer;
    responseFinishedAt: number;
    reassembly?: {
      ok: boolean;
      diagnostic?: string;
      providerRequestId?: string;
      stopReason?: string;
      modelFingerprint?: string;
      usage?: Readonly<Record<string, unknown>>;
      events?: ReadonlyArray<{ eventType: string; dataUtf8: string; offsetMs: number }>;
      reassembledBody?: string;
    };
  }): void {
    if (aborted) return;
    const reqBuf = bufferedRequestBody ?? Buffer.concat(requestChunks, requestBytes);
    const reqFields = bodyToFields(reqBuf);
    let respBodyUtf8: string;
    let respBodyBase64: string | undefined;
    let respBodyBytes: number;
    if (args.streaming && args.reassembly?.ok && args.reassembly.reassembledBody !== undefined) {
      respBodyUtf8 = args.reassembly.reassembledBody;
      respBodyBytes = Buffer.byteLength(respBodyUtf8, 'utf-8');
    } else {
      const respFields = bodyToFields(args.responseBody);
      respBodyUtf8 = respFields.bodyUtf8;
      respBodyBase64 = respFields.bodyBase64;
      respBodyBytes = respFields.bodyBytes;
    }
    const record: ExchangeRecord = {
      schemaVersion: 1,
      exchangeId,
      sessionId: inputs.sessionId,
      ...(inputs.persona !== undefined ? { persona: inputs.persona } : {}),
      ...(inputs.workflowRunId !== undefined ? { workflowRunId: inputs.workflowRunId } : {}),
      ...(inputs.bundleId !== undefined ? { bundleId: inputs.bundleId } : {}),
      ...(inputs.recordedAgentName !== undefined ? { recordedAgentName: inputs.recordedAgentName } : {}),
      provider: providerForHost(inputs.host),
      method: inputs.method,
      host: inputs.host,
      path: inputs.path,
      requestStartedAt: inputs.requestStartedAt,
      requestFinishedAt: requestFinishedAt || inputs.requestStartedAt,
      responseFinishedAt: args.responseFinishedAt,
      request: {
        headers: redactHeaders(inputs.requestHeaders),
        bodyUtf8: reqFields.bodyUtf8,
        ...(reqFields.bodyBase64 !== undefined ? { bodyBase64: reqFields.bodyBase64 } : {}),
        bodyBytes: reqFields.bodyBytes,
        ...(inputs.requestContentEncoding !== undefined ? { contentEncoding: inputs.requestContentEncoding } : {}),
      },
      response: {
        status: args.statusCode,
        headers: redactHeaders(args.responseHeaders),
        streaming: args.streaming,
        ...(args.reassembly?.providerRequestId !== undefined
          ? { providerRequestId: args.reassembly.providerRequestId }
          : {}),
        ...(args.reassembly?.stopReason !== undefined ? { stopReason: args.reassembly.stopReason } : {}),
        ...(args.reassembly?.modelFingerprint !== undefined
          ? { modelFingerprint: args.reassembly.modelFingerprint }
          : {}),
        ...(args.reassembly?.usage !== undefined ? { usage: args.reassembly.usage } : {}),
        bodyUtf8: respBodyUtf8,
        ...(respBodyBase64 !== undefined ? { bodyBase64: respBodyBase64 } : {}),
        bodyBytes: respBodyBytes,
        ...(args.reassembly?.events !== undefined ? { streamRaw: { events: args.reassembly.events } } : {}),
      },
      capture: {
        reassemblyOk: args.reassembly?.ok ?? true,
        ...(args.reassembly?.diagnostic !== undefined ? { reassemblyDiagnostic: args.reassembly.diagnostic } : {}),
      },
    };
    try {
      inputs.writer.write(record);
    } catch (err) {
      logger.warn(
        `[trajectory-tap] writer.write threw (swallowed): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    pushRequestChunk(chunk: Buffer) {
      if (aborted || requestFinalized) return;
      requestChunks.push(chunk);
      requestBytes += chunk.length;
    },
    finishRequest() {
      if (requestFinalized) return;
      requestFinalized = true;
      requestFinishedAt = Date.now();
    },
    setRequestBody(buf: Buffer) {
      bufferedRequestBody = buf;
      requestFinalized = true;
      requestFinishedAt = Date.now();
    },
    attachResponse(args: AttachResponseInputs): PassThrough {
      const tap = new PassThrough();
      const responseChunks: Buffer[] = [];
      let responseBytes = 0;
      // Engagement is driven by HOST classification, OR'd with a
      // content-type sniff. Codex's chatgpt.com Responses stream carries
      // NO content-type header (verified via live --capture-traces), so a
      // content-type-only gate never engages the reassembler on the real
      // codex path. `createReassembler` returns a reassembler for known
      // completion hosts and `undefined` for unknown ones; combined with
      // the `isCapturableEndpoint` gate (only completion POST endpoints
      // reach attachResponse), host classification is the authoritative
      // streaming signal. A non-SSE body that ever reached a reassembler
      // would fail to see a terminal event and poison `reassembly-failure`
      // (loud) rather than silently corrupt.
      const reassembler: Reassembler | undefined = createReassembler(inputs.host);
      const streaming =
        reassembler !== undefined ||
        String(args.headers['content-type'] ?? '')
          .toLowerCase()
          .includes('text/event-stream');
      // The caller is responsible for wiring a decompressor in front of
      // this tap (see `createResponseCaptureInlet`). The bytes reaching
      // `tap.on('data')` are therefore always uncompressed; the
      // `content-encoding` header is preserved on the captured record
      // as metadata via `args.headers`.

      // Per §9 Phase B condition 2: a completion Promise is registered
      // with the dispatcher so `endSession` can await this tap's
      // settlement before emitting the `session-end` marker. The
      // promise resolves on clean `_flush` (= `tap.on('end')`) and
      // rejects on close-before-flush or error — the reject path
      // surfaces the abort to the dispatcher's poison machinery via
      // its in-flight cleanup.
      let completionResolve: (() => void) | undefined;
      let completionReject: ((err: Error) => void) | undefined;
      const completion = new Promise<void>((res, rej) => {
        completionResolve = res;
        completionReject = rej;
      });
      // Swallow the completion-promise rejection so an unhandled
      // rejection warning never fires; the dispatcher consumes it via
      // `Promise.allSettled`.
      completion.catch(() => {});
      inputs.writer.trackInFlight(inputs.sessionId, completion);

      const finishCompletion = (ok: boolean, err?: Error): void => {
        if (ok) {
          completionResolve?.();
        } else {
          completionReject?.(err ?? new Error('capture tap aborted'));
        }
        completionResolve = undefined;
        completionReject = undefined;
      };

      // Poison the session and reject the in-flight completion. Shared by
      // the reassembly-failure, mid-stream-abort (close), and error paths.
      const poisonAndAbort = (reason: PoisonReason, err: Error): void => {
        aborted = true;
        try {
          inputs.writer.markSessionPoisoned(inputs.sessionId, reason);
        } catch {
          /* swallow — poisoning is best-effort */
        }
        finishCompletion(false, err);
      };

      tap.on('data', (chunk: Buffer) => {
        if (aborted) return;
        if (reassembler) {
          // On the streaming path the reassembled message is the captured
          // body, so the raw chunks are never used (see maybeWriteRecord).
          // Skip buffering them to avoid holding the full response twice.
          try {
            reassembler.push(chunk);
          } catch {
            /* reassembler accumulates; failures surface at finalize */
          }
          return;
        }
        responseChunks.push(chunk);
        responseBytes += chunk.length;
      });

      // Tracks whether `finalize` already ran (cleanly OR with a
      // reassembly failure). A `close` event arriving after `finalize`
      // is normal end-of-stream lifecycle, NOT a mid-stream abort.
      let finalized = false;

      const finalize = (): void => {
        if (aborted || finalized) {
          finishCompletion(false);
          return;
        }
        finalized = true;
        const responseFinishedAt = Date.now();
        if (reassembler) {
          try {
            const result = reassembler.finalize();
            maybeWriteRecord({
              statusCode: args.statusCode,
              responseHeaders: args.headers,
              streaming: true,
              responseBody: EMPTY_BODY, // ignored on the reassembly-ok path
              responseFinishedAt,
              reassembly: {
                ok: true,
                providerRequestId: result.providerRequestId,
                stopReason: result.stopReason,
                modelFingerprint: result.modelFingerprint,
                usage: result.usage,
                events: result.events,
                reassembledBody: result.bodyUtf8,
              },
            });
            finishCompletion(true);
          } catch (err) {
            // Reassembly failure: do NOT emit a partial record. Per §5
            // and §9, the session is poisoned with `reassembly-failure`
            // so the eventual `session-end` carries the reason.
            const msg = err instanceof ReassemblyError ? err.message : String(err);
            logger.warn(`[trajectory-tap] reassembly failed (${inputs.host}): ${msg}`);
            poisonAndAbort('reassembly-failure', err instanceof Error ? err : new Error(msg));
          }
        } else {
          // No reassembler: capture the raw bytes verbatim. `streaming`
          // reflects the content-type sniff — true only for a known SSE
          // content-type on a host without a reassembler (no structured
          // fields available), false otherwise.
          maybeWriteRecord({
            statusCode: args.statusCode,
            responseHeaders: args.headers,
            streaming,
            responseBody: Buffer.concat(responseChunks, responseBytes),
            responseFinishedAt,
          });
          finishCompletion(true);
        }
      };

      // Shared by the close/error paths. The captureTap was torn down
      // before a clean `end` (`_flush`). The bytes already pushed into
      // the reassembler are retained in its state independent of the tap
      // being destroyed, so a teardown is the SIGNAL to decide: if the
      // reassembler already parsed its terminal event (`canFinalize()`),
      // the stream is COMPLETE-but-socket-aborted — run the SAME
      // `finalize` closure to write a faithful record (it guards
      // `aborted || finalized`, and sets `finalized=true` synchronously
      // before any throw, so an error-then-close pair finalizes exactly
      // once). Only when the terminal event was never seen is this a
      // GENUINELY-PARTIAL stream that poisons `mid-stream-abort`.
      const finalizeOrPoisonOnTeardown = (err: Error): void => {
        if (aborted || finalized) {
          finishCompletion(false);
          return;
        }
        if (reassembler?.canFinalize()) {
          finalize();
          return;
        }
        poisonAndAbort('mid-stream-abort', err);
      };

      tap.on('end', finalize);
      tap.on('close', () => {
        finalizeOrPoisonOnTeardown(new Error('mid-stream-abort'));
      });
      tap.on('error', (err) => {
        finalizeOrPoisonOnTeardown(err instanceof Error ? err : new Error(String(err)));
      });

      return tap;
    },
    abort(): void {
      aborted = true;
    },
  };
}

/** Encodings handled natively by `node:zlib`. Anything else poisons the session. */
const SUPPORTED_ENCODINGS = new Set(['identity', '', 'gzip', 'x-gzip', 'deflate', 'br']);

/**
 * Build the head of the capture pipeline for a response body. The
 * caller writes raw upstream bytes to the returned `Writable`; the
 * pipeline decompresses (if needed) and routes the decompressed bytes
 * to `captureTap`.
 *
 * For `identity` (or absent header) the captureTap is returned directly
 * — no decompressor is inserted, no extra copy. For supported encodings
 * (`gzip`, `deflate`, `br`) a `node:zlib` transform is inserted. For
 * unsupported encodings (`zstd`, etc.) the session is poisoned with
 * `unsupported-encoding`, the captureTap is detached, and the returned
 * sink discards any bytes the caller still pushes — the forwarding path
 * is unaffected.
 *
 * Decompression failures (truncated gzip, corrupt frame) poison the
 * session with `reassembly-failure`. See §3 of the design doc.
 */
export function createResponseCaptureInlet(args: {
  readonly captureTap: PassThrough;
  readonly contentEncoding: string | undefined;
  readonly captureHandle: CaptureExchangeHandle;
  readonly onPoison: (reason: PoisonReason) => void;
}): Writable {
  const encoding = (args.contentEncoding ?? 'identity').toLowerCase().trim();
  // Multiple encodings (e.g. `gzip, identity`) are vanishingly rare from
  // Anthropic / OpenAI; the spec allows fanning them out into a stack
  // but until a real case appears, treat any comma-bearing value as
  // unsupported rather than silently mishandle it.

  if (encoding === '' || encoding === 'identity') {
    return args.captureTap;
  }

  if (!SUPPORTED_ENCODINGS.has(encoding)) {
    logger.warn(`[trajectory-tap] unsupported content-encoding: ${encoding}; poisoning session`);
    args.onPoison('unsupported-encoding');
    args.captureHandle.abort();
    // Detach the tap so it doesn't sit waiting for bytes that never come,
    // and return a sink that silently drops further chunks the caller
    // may still push.
    args.captureTap.destroy();
    return new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
      final(cb) {
        cb();
      },
    });
  }

  const decompressor = createDecompressor(encoding);
  decompressor.on('error', (err: Error) => {
    logger.warn(`[trajectory-tap] decompressor error (${encoding}): ${err.message}`);
    args.onPoison('reassembly-failure');
    args.captureHandle.abort();
    // Close the captureTap so its `_flush` does not fire on a half-
    // decompressed stream; the in-flight promise will reject via the
    // tap's `close` handler.
    if (!args.captureTap.destroyed) {
      args.captureTap.destroy(err);
    }
  });
  // Decompressor → captureTap. End-propagation is the default for pipe.
  decompressor.pipe(args.captureTap);
  return decompressor;
}

function createDecompressor(encoding: string): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress {
  switch (encoding) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip();
    case 'deflate':
      return zlib.createInflate();
    case 'br':
      return zlib.createBrotliDecompress();
    default:
      // Should be unreachable — SUPPORTED_ENCODINGS guarded this.
      throw new Error(`createDecompressor called with unsupported encoding: ${encoding}`);
  }
}

// Re-export for callers that want a single import surface.
export { ReassemblyError };
export type { Reassembler };
