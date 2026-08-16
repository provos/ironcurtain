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
import { randomUUID } from 'node:crypto';
import type { TrajectoryCaptureWriter } from './trajectory-capture.js';
import { type Reassembler, redactHeaders } from './trajectory-types.js';
import type { ExchangeRecord, PoisonReason } from './trajectory-types.js';
import { createReassembler, providerForHost, ReassemblyError, TruncatedStreamError } from './trajectory-reassembler.js';
import type { SessionId } from '../session/types.js';
import * as logger from '../logger.js';
import { BoundedContentDecoder, type ContentDecoderFailure } from './llm-observation/content-decoder.js';

/** Reused for the (ignored) responseBody arg on the reassembler path. */
const EMPTY_BODY = Buffer.alloc(0);

/**
 * Trajectory capture predates the bounded metrics observer and deliberately
 * records a whole exchange or poisons the whole session. Do not silently
 * inherit metrics' smaller per-response limits here: a partial training record
 * is not useful. These deliberately generous finite caps still protect the
 * process from an unbounded response or a decompressor that falls behind.
 */
const TRAJECTORY_DECODER_LIMITS = Object.freeze({
  maxCompressedBytes: 64 * 1024 * 1024,
  maxDecodedBytes: 128 * 1024 * 1024,
  maxExpansionRatio: 4_096,
  expansionRatioSlackBytes: 4 * 1024 * 1024,
  maxPendingInputBytes: 8 * 1024 * 1024,
});

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
      provider: providerForHost(inputs.host, inputs.path),
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
      // Decide whether to engage an SSE reassembler. A capturable completion
      // endpoint (the only thing reaching attachResponse) can answer either
      // as an SSE stream OR — when the client sets stream:false — as a single
      // JSON object. Feeding a non-streaming JSON body into the reassembler
      // would never yield a terminal event and would falsely poison the
      // session `reassembly-failure`, so engage ONLY when the response is
      // actually SSE:
      //   - content-type contains `text/event-stream`, OR
      //   - content-type is ABSENT on a host we have a reassembler for —
      //     Codex's chatgpt.com Responses stream is SSE but sends no
      //     content-type header (verified via live --capture-traces). A
      //     non-streaming completion always sets `content-type:
      //     application/json`, so an absent content-type unambiguously means
      //     the headerless-SSE case.
      // `createReassembler` returns `undefined` for unknown hosts, so those
      // fall back to verbatim raw capture either way.
      const contentType = String(args.headers['content-type'] ?? '').toLowerCase();
      const isSse = contentType.includes('text/event-stream');
      const reassembler: Reassembler | undefined =
        isSse || contentType === '' ? createReassembler(inputs.host, inputs.path) : undefined;
      const streaming = reassembler !== undefined || isSse;
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
            // Do NOT emit a partial record. Distinguish a transport
            // truncation (stream ended before the terminal event) from a
            // genuine reassembly bug (a parse/dispatch/assembly failure):
            // the former is an upstream abort that must NOT pollute
            // reassembly-failure metrics. A clean `end()` with no terminal
            // event reaches here e.g. when an upstream reset is flushed
            // gracefully via `inlet.end()` (the gzip-tail recovery path).
            const msg = err instanceof ReassemblyError ? err.message : String(err);
            if (err instanceof TruncatedStreamError) {
              poisonAndAbort('mid-stream-abort', err);
            } else {
              logger.warn(`[trajectory-tap] reassembly failed (${inputs.host}): ${msg}`);
              poisonAndAbort('reassembly-failure', err instanceof Error ? err : new Error(msg));
            }
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

/**
 * Build the head of the capture pipeline for a response body. The
 * caller writes raw upstream bytes to the returned `Writable`; the
 * pipeline decompresses (if needed) and routes the decompressed bytes
 * to `captureTap`.
 *
 * For `identity` (or absent header) the captureTap is returned directly
 * — no decoder is inserted, no extra copy. For supported encodings
 * (`gzip`, `deflate`, `br`) the generic bounded content decoder is used. For
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

  let failed = false;
  const failCapture = (failure: ContentDecoderFailure): void => {
    if (failed) return;
    failed = true;
    const poisonReason: PoisonReason =
      failure.reason === 'unsupported-encoding' ? 'unsupported-encoding' : 'reassembly-failure';
    logger.warn(`[trajectory-tap] response decoder detached (${encoding}): ${failure.message}`);
    args.onPoison(poisonReason);
    args.captureHandle.abort();
    if (!args.captureTap.destroyed) args.captureTap.destroy(new Error(failure.message));
  };

  const decoder = new BoundedContentDecoder({
    contentEncoding: encoding,
    limits: TRAJECTORY_DECODER_LIMITS,
    onDecodedChunk(chunk) {
      // Writable.write(false) is advisory and the tap has accepted the bytes.
      // Production taps install their synchronous data consumer before this
      // inlet is created, so honoring that signal must not poison capture or
      // feed back into the independent forwarding path.
      args.captureTap.write(chunk);
    },
    onEnd() {
      if (!args.captureTap.destroyed && !args.captureTap.writableEnded) args.captureTap.end();
    },
    onFailure: failCapture,
  });

  let inputEnded = false;
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      decoder.write(chunk);
      callback();
    },
    final(callback) {
      inputEnded = true;
      decoder.end();
      callback();
    },
    destroy(error, callback) {
      // Writable auto-destroys after a successful `_final`; zlib may still be
      // asynchronously draining at that point, so only explicit/error
      // teardown detaches the decoder.
      if ((error || !inputEnded) && decoder.snapshot().state === 'active') {
        decoder.detach('decoder-error', error?.message ?? 'trajectory response inlet destroyed');
      }
      callback(error);
    },
  });
}

// Re-export for callers that want a single import surface.
export { ReassemblyError };
export type { Reassembler };
