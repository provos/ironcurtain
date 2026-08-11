/**
 * Shared credential-free forward lifecycle for the destination-bound egress
 * proxies (`build-egress-proxy.ts` and `registry-egress-proxy.ts`).
 *
 * Both proxies terminate TLS on a per-listener MITM, authorize the decrypted
 * request against a frozen manifest, then forward the sanitized result through a
 * destination-bound {@link OutboundTransport}. The forward lifecycle around that
 * — arming an absolute per-request deadline, streaming the response with real
 * backpressure under a per-request byte ceiling, and failing closed on any
 * overflow — is identical between them, so it lives here as one copy. The pieces
 * that differ are parameterized on {@link MediatedEgressConfig}:
 *
 * - `assertReady` — a pre-flight transport-binding check (build's `fixed-parent-only`
 *   rule); absent for registry.
 * - `session` — a per-session concurrency lease and cumulative-byte ceiling
 *   (registry's ledger); absent for build.
 * - `followRedirect` — when present, a 3xx is authorized and followed *internally*
 *   under the F1 redirect-body ceiling (registry); when absent, a 3xx streams
 *   straight through to the client, which drives its own redirects (build).
 * - `onComplete` — a provenance sink invoked once on successful completion
 *   (registry records the requested/reported digest and streamed size).
 *
 * This is a leaf: it depends only on node, the destination-bound transport, the
 * shared request/response shaping in `egress-forwarding.ts`, and the logger.
 */

import * as http from 'node:http';
import { Transform, pipeline } from 'node:stream';
import type { OutboundDestination, OutboundTransport } from './outbound-transport.js';
import { firstHeader, sanitizeResponseHeaders, toOutgoingHeaders } from './egress-forwarding.js';
import * as logger from '../logger.js';

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * A legitimate registry redirect (3xx) carries a tiny or empty body. It is drained,
 * not delivered, but still consumes bandwidth, so it is bounded by this tight cap in
 * addition to the per-request and per-session byte ceilings (F1).
 */
const MAX_REDIRECT_BODY_BYTES = 64 * 1024;

/** The destination-bound upstream fetch derived from an authorized request. */
export interface MediatedEgressRequestSpec {
  readonly destination: OutboundDestination;
  readonly method: 'GET' | 'HEAD';
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[]>>;
  /** Per-request streamed-byte ceiling; the forwarder aborts once it is exceeded. */
  readonly maxBytes: number;
  /** Absolute per-request wall-clock ceiling in milliseconds. */
  readonly maxDurationMs: number;
}

/** A reserved concurrency slot in a per-session ledger; releasing is idempotent. */
export interface MediatedEgressLease {
  release(): void;
}

/**
 * Structural per-session accounting. Registry's `RegistryEgressSessionLedger`
 * already satisfies it; build has no session and passes none.
 */
export interface MediatedEgressSession {
  /** Reserve a concurrency slot; throws once the concurrency ceiling is reached. */
  acquire(): MediatedEgressLease;
  /** Would `additional` bytes still fit within the session total? (peek, no mutation) */
  wouldFit(additional: number): boolean;
  /** Account `count` streamed bytes; returns false once the session total is exceeded. */
  addBytes(count: number): boolean;
}

/**
 * The forward lifecycle parameterized on the caller's authorized-request type `A`.
 * Only `transport`, `initial`, `describe`, and `label` are required; the optional
 * fields select the registry-vs-build behaviors described in the module comment.
 */
export interface MediatedEgressConfig<A> {
  readonly transport: OutboundTransport;
  /** The already-authorized initial request. */
  readonly initial: A;
  /** Map an authorized request to its destination-bound upstream fetch. */
  describe(authorized: A): MediatedEgressRequestSpec;
  /** Log/response label, e.g. `build-egress` | `registry-egress`. */
  readonly label: string;
  /** Pre-flight check; a throw rejects `502` before any upstream contact. */
  assertReady?(authorized: A): void;
  /** Present enables a concurrency lease and cumulative-byte ceiling. */
  readonly session?: MediatedEgressSession;
  /** Present follows 3xx internally; absent passes 3xx through to the client. */
  readonly followRedirect?: (current: A, location: string) => A;
  /** Provenance sink; called once on successful terminal-response completion. */
  onComplete?(authorized: A, streamedBytes: number, responseHeaders: http.IncomingHttpHeaders): void;
}

/** Mutable per-request state: one logical forward, spanning any followed redirects. */
interface MediatedExchange<A> {
  readonly clientRes: http.ServerResponse;
  readonly config: MediatedEgressConfig<A>;
  readonly lease: MediatedEgressLease | undefined;
  deadline?: NodeJS.Timeout;
  upstreamReq?: http.ClientRequest;
  /**
   * Bytes this logical request has already consumed on *earlier* hops (drained
   * redirect bodies). The per-request byte ceiling is a property of the logical
   * request, not of a single hop, so every later hop — including the terminal
   * stream — is bounded by `maxBytes - consumedBytes`.
   */
  consumedBytes: number;
  settled: boolean;
}

/**
 * Fail-closed rejection shared by both proxies: a text status while the response
 * is still open, or a connection teardown once headers have been sent.
 */
export function rejectMediatedEgress(clientRes: http.ServerResponse, status: number, message: string): void {
  if (!clientRes.headersSent) {
    clientRes.writeHead(status, { 'content-type': 'text/plain' });
    clientRes.end(`${message}\n`);
  } else {
    clientRes.destroy();
  }
}

/**
 * Run the shared forward lifecycle for one already-authorized request: optionally
 * check transport binding and reserve a session slot, arm an absolute deadline,
 * fetch through the destination-bound transport, optionally follow bounded derived
 * redirects, and stream the response with backpressure under the per-request (and
 * per-session, when present) byte ceilings. Every failure path is fail-closed.
 */
export function forwardMediatedEgress<A>(clientRes: http.ServerResponse, config: MediatedEgressConfig<A>): void {
  const authorized = config.initial;

  if (config.assertReady !== undefined) {
    try {
      config.assertReady(authorized);
    } catch (error) {
      rejectMediatedEgress(clientRes, 502, messageOf(error, 'mediated egress is not ready'));
      return;
    }
  }

  let lease: MediatedEgressLease | undefined;
  if (config.session !== undefined) {
    try {
      lease = config.session.acquire();
    } catch (error) {
      logger.info(`[${config.label}] DENIED ${messageOf(error, 'concurrency ceiling reached')}`);
      rejectMediatedEgress(clientRes, 503, messageOf(error, 'mediated egress concurrency ceiling reached'));
      return;
    }
  }

  const exchange: MediatedExchange<A> = { clientRes, config, lease, consumedBytes: 0, settled: false };
  exchange.deadline = armMediatedDeadline(exchange, config.describe(authorized).maxDurationMs);
  clientRes.once('close', () => finalizeMediatedExchange(exchange));
  fetchMediated(exchange, authorized);
}

/** Absolute per-request wall-clock ceiling: tear down both sides and fail closed. */
function armMediatedDeadline<A>(exchange: MediatedExchange<A>, maxDurationMs: number): NodeJS.Timeout {
  const timer = setTimeout(() => {
    logger.info(`[${exchange.config.label}] exceeded ${maxDurationMs}ms; aborting`);
    if (exchange.upstreamReq !== undefined) exchange.upstreamReq.destroy();
    if (!exchange.clientRes.headersSent) {
      rejectMediatedEgress(exchange.clientRes, 504, `${exchange.config.label}: exceeded the time ceiling`);
    } else {
      exchange.clientRes.destroy();
    }
  }, maxDurationMs);
  timer.unref();
  return timer;
}

/** Idempotent teardown: clear the deadline and release the session concurrency slot. */
function finalizeMediatedExchange<A>(exchange: MediatedExchange<A>): void {
  if (exchange.settled) return;
  exchange.settled = true;
  if (exchange.deadline !== undefined) clearTimeout(exchange.deadline);
  exchange.lease?.release();
}

function fetchMediated<A>(exchange: MediatedExchange<A>, authorized: A): void {
  const { clientRes, config } = exchange;
  const spec = config.describe(authorized);

  let upstreamReq: http.ClientRequest;
  try {
    upstreamReq = config.transport.request(
      { destination: spec.destination, method: spec.method, path: spec.path, headers: toOutgoingHeaders(spec.headers) },
      (upstreamRes) => onMediatedResponse(exchange, upstreamRes, authorized),
    );
  } catch (error) {
    if (!clientRes.headersSent) rejectMediatedEgress(clientRes, 502, messageOf(error, 'upstream request failed'));
    else clientRes.destroy();
    return;
  }

  exchange.upstreamReq = upstreamReq;
  upstreamReq.on('error', (error) => {
    // A superseded hop's stale connection must not tear down the current one (F5).
    if (exchange.upstreamReq !== upstreamReq) return;
    if (!clientRes.headersSent) rejectMediatedEgress(clientRes, 502, error.message);
    else clientRes.destroy();
  });
  upstreamReq.end();
}

function onMediatedResponse<A>(exchange: MediatedExchange<A>, upstreamRes: http.IncomingMessage, authorized: A): void {
  const { clientRes, config } = exchange;
  if (exchange.settled || clientRes.writableEnded || clientRes.destroyed) {
    upstreamRes.resume(); // the exchange already failed closed (e.g. the deadline fired)
    return;
  }
  const status = upstreamRes.statusCode ?? 502;

  // A 3xx is followed internally only when the caller supplies an authorizer;
  // otherwise it streams straight through so the client drives its own redirects.
  if (REDIRECT_STATUS_CODES.has(status) && config.followRedirect !== undefined) {
    followMediatedRedirect(exchange, upstreamRes, authorized, config.followRedirect);
    return;
  }

  streamMediatedToClient(exchange, upstreamRes, authorized, status);
}

function followMediatedRedirect<A>(
  exchange: MediatedExchange<A>,
  upstreamRes: http.IncomingMessage,
  authorized: A,
  followRedirect: (current: A, location: string) => A,
): void {
  const { clientRes, config } = exchange;
  const location = firstHeader(upstreamRes.headers.location);
  if (location === undefined) {
    upstreamRes.destroy(); // fail closed without draining an unusable response
    rejectMediatedEgress(clientRes, 502, `${config.label}: redirect is missing a Location header`);
    return;
  }
  // Authorize the redirect target before consuming its body: an unauthorized
  // target is rejected without spending bandwidth draining the 3xx response.
  let next: A;
  try {
    next = followRedirect(authorized, location);
  } catch (error) {
    upstreamRes.destroy();
    logger.info(`[${config.label}] DENIED redirect ${messageOf(error, 'target is not authorized')}`);
    rejectMediatedEgress(clientRes, 403, messageOf(error, 'redirect target is not authorized'));
    return;
  }
  // Drain the redirect body under the byte ceilings before following (F1): the body
  // is never delivered but still consumes bandwidth, so it counts against a tight
  // per-hop redirect cap, the per-request cap *shared with every later hop*, and
  // (when present) the cumulative session ledger. Overflow fails the whole exchange
  // closed; the wall-clock deadline bounds a slow body.
  const session = config.session;
  const remaining = config.describe(authorized).maxBytes - exchange.consumedBytes;
  const bodyCap = Math.min(MAX_REDIRECT_BODY_BYTES, remaining);
  let drained = 0;
  let aborted = false;
  upstreamRes.on('data', (chunk: Buffer) => {
    if (aborted) return;
    drained += chunk.length;
    if (drained > bodyCap || (session !== undefined && !session.addBytes(chunk.length))) {
      aborted = true;
      upstreamRes.destroy();
      rejectMediatedEgress(clientRes, 502, `${config.label}: redirect body exceeds a byte ceiling`);
    }
  });
  upstreamRes.on('error', () => {
    if (aborted) return;
    aborted = true;
    rejectMediatedEgress(clientRes, 502, `${config.label}: redirect body transfer failed`);
  });
  upstreamRes.on('end', () => {
    if (aborted || exchange.settled) return;
    exchange.consumedBytes += drained;
    fetchMediated(exchange, next);
  });
}

/**
 * Pipe the upstream response to the client with backpressure, enforcing the
 * per-request (and, when present, per-session) byte ceilings as bytes flow. Bytes
 * already consumed by drained redirect hops count against the per-request ceiling,
 * so it holds across the whole logical request. A declared `content-length` that
 * already overshoots a ceiling is rejected before any body is streamed; a chunked
 * body that overshoots mid-stream tears down both sides. On successful completion
 * the provenance sink is invoked once.
 */
function streamMediatedToClient<A>(
  exchange: MediatedExchange<A>,
  upstreamRes: http.IncomingMessage,
  authorized: A,
  status: number,
): void {
  const { clientRes, config } = exchange;
  const session = config.session;
  const maxBytes = config.describe(authorized).maxBytes;
  const consumed = exchange.consumedBytes;

  const declared = declaredContentLength(upstreamRes.headers);
  if (
    declared !== undefined &&
    (consumed + declared > maxBytes || (session !== undefined && !session.wouldFit(declared)))
  ) {
    upstreamRes.resume();
    rejectMediatedEgress(clientRes, 502, `${config.label}: response exceeds a byte ceiling`);
    return;
  }

  const ceiling = createMediatedByteCeiling(config.label, maxBytes, session, consumed);
  clientRes.writeHead(status, sanitizeResponseHeaders(upstreamRes.headers));
  pipeline(upstreamRes, ceiling.transform, clientRes, (error) => {
    if (error) {
      logger.info(`[${config.label}] transfer failed: ${error.message}`);
      if (exchange.upstreamReq !== undefined) exchange.upstreamReq.destroy();
      clientRes.destroy();
      return;
    }
    config.onComplete?.(authorized, ceiling.byteCount(), upstreamRes.headers);
  });
}

interface MediatedByteCeiling {
  readonly transform: Transform;
  /** The running total of bytes that have passed the ceiling so far. */
  byteCount(): number;
}

/**
 * A pass-through Transform that fails closed once a stream exceeds the per-request
 * or cumulative per-session byte ceiling, exposing its running byte total so the
 * caller never needs a second `data` counter. `pipeline` propagates the error to
 * destroy both the upstream response and the client response.
 *
 * `alreadyConsumed` seeds the per-request ceiling with the bytes earlier hops of the
 * same logical request already spent; `byteCount()` still reports only the bytes
 * streamed here, which is what the provenance sink records.
 */
function createMediatedByteCeiling(
  label: string,
  maxBytes: number,
  session: MediatedEgressSession | undefined,
  alreadyConsumed: number,
): MediatedByteCeiling {
  let total = 0;
  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback): void {
      total += chunk.length;
      if (alreadyConsumed + total > maxBytes) {
        callback(new Error(`${label} exceeded the per-request byte ceiling (${maxBytes})`));
        return;
      }
      if (session !== undefined && !session.addBytes(chunk.length)) {
        callback(new Error(`${label} exceeded the per-session byte ceiling`));
        return;
      }
      callback(null, chunk);
    },
  });
  return { transform, byteCount: () => total };
}

function declaredContentLength(headers: http.IncomingHttpHeaders): number | undefined {
  const raw = firstHeader(headers['content-length']);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
