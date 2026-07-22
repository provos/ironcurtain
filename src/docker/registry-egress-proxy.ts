/**
 * Proxy-side enforcement seam for anonymous workload-image registry egress (§6.4).
 *
 * ## Wiring-seam design (Phase 0F, §6.4 / §16.5 / §16.6 of the plan)
 *
 * When a session enables `imageIngress: public-registry`, the nested daemon receives
 * proxy environment plus the session public CA and can reach only the fixed proxy
 * path — there is still no direct registry route. The outer MITM runs in
 * *registry-egress mode* (`MitmProxyOptions.registryEgress`): like build-egress, this
 * listener has no LLM providers, package registries, or dynamic passthrough, so every
 * decrypted request is registry-originated by construction and is authorized against
 * the frozen `registry-egress-manifest.json` rather than an allowlist. In
 * `preloaded-only` mode no such listener exists, so registry traffic has no route.
 *
 * **How pulls are authorized.** The proxy holds a {@link RegistryEgressGuard} built
 * once at bundle startup; construction is fail-closed (a missing/invalid manifest
 * aborts before any request is served). Per request the guard resolves exactly one
 * reviewed origin and one pull operation, rejecting client-selected hosts, push /
 * delete / catalog / tags enumeration, disallowed credential headers, and encoded-path
 * smuggling. The sanitized request is forwarded through the destination-bound
 * {@link OutboundTransport} — never a generic TCP relay.
 *
 * **The binding controls (§16.6).** Workload image *content* is untrusted bundle
 * state, so the proxy does not hash or verify blob bytes. Authority is constrained by:
 * client-origin URL/operation gating (the guard), exact derived-redirect authorization
 * (an unlisted CDN host is reachable only as the immediate `Location` of an authorized
 * manifest/blob response — HTTPS, credential-stripped, SSRF-checked by the transport,
 * finite hops), anonymous bearer-token handling, and per-request / per-session transfer
 * ceilings. The body streams through with normal backpressure — never accumulated in
 * trusted memory. A per-request byte or absolute-time ceiling, or the cumulative
 * per-session byte or concurrency ceiling, fails closed (both sides destroyed) and is
 * audited. Requested and registry-reported digests are recorded as provenance only.
 *
 * The pure policy (schema, load, single-origin resolution, digest syntax) lives in
 * `./registry-egress-policy.ts`; this module owns the lifecycle (freeze), the
 * per-session ledger, and the I/O (stream, follow bounded redirects, enforce
 * ceilings), keeping the policy independently testable.
 *
 * Foundation code — inert behind the docker-workload admission fuse until a later
 * phase constructs a `public-registry` session.
 */

import * as http from 'node:http';
import { Transform, pipeline } from 'node:stream';
import {
  authorizeValidatedRegistryEgressRequest,
  authorizeValidatedRegistryRedirect,
  loadRegistryEgressManifest,
  parseOciDigest,
  type AuthorizedRegistryEgressRequest,
  type RegistryEgressRequest,
  type RegistryEgressSessionLimits,
} from './registry-egress-policy.js';
import type { OutboundDestination, OutboundTransport } from './outbound-transport.js';
import { buildRequestUrl, sanitizeResponseHeaders, toOutgoingHeaders } from './egress-forwarding.js';
import * as logger from '../logger.js';

export type RegistryEgressMode = 'disabled' | 'public-registry';

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * A legitimate registry redirect (3xx) carries a tiny or empty body. It is drained,
 * not delivered, but still consumes bandwidth, so it is bounded by this tight cap in
 * addition to the per-request and per-session byte ceilings (F1).
 */
const MAX_REDIRECT_BODY_BYTES = 64 * 1024;

/** Frozen manifest identity retained for audit and diagnostics. */
export interface FrozenRegistryEgressManifest {
  readonly path: string;
  readonly sha256: string;
  readonly policyId: string;
  readonly status: 'draft' | 'frozen';
  readonly origins: readonly { readonly id: string; readonly hostname: string; readonly port: number }[];
}

/** Digest provenance recorded for audit; never a security control (§16.6). */
export interface RegistryPullProvenance {
  readonly originId: string;
  readonly repository?: string;
  readonly reference?: string;
  /** Requested digest from a by-digest URL, if any. */
  readonly requestedDigest?: string;
  /** Registry-reported `Docker-Content-Digest`, if the response carried one. */
  readonly resolvedDigest?: string;
  /** Bytes streamed to the daemon (observed, not a control input). */
  readonly sizeBytes: number;
}

/** A reserved concurrency slot in the per-session ledger; releasing is idempotent. */
export interface RegistryEgressLease {
  release(): void;
}

/**
 * Per-session cumulative accounting threaded through the proxy seam. Created once by
 * the guard factory and shared by every request in the session; the streaming
 * forwarder consults it for the concurrent-request and total-byte ceilings.
 */
export interface RegistryEgressSessionLedger {
  readonly maxTotalBytes: number;
  readonly maxConcurrentRequests: number;
  readonly totalBytes: number;
  readonly activeRequests: number;
  /** Reserve a concurrency slot; throws once the concurrency ceiling is reached. */
  acquire(): RegistryEgressLease;
  /** Would `additional` bytes still fit within the session total? (peek, no mutation) */
  wouldFit(additional: number): boolean;
  /** Account `count` streamed bytes; returns false once the session total is exceeded. */
  addBytes(count: number): boolean;
}

/**
 * The narrow safe API the outer MITM calls. `authorize` is the single policy
 * decision point; it throws (fail-closed) for a disabled guard, a client-selected
 * host, a disallowed credential header, a non-pull operation, or any undeclared
 * behavior. `session` carries the shared per-session ceilings ledger.
 */
export interface RegistryEgressGuard {
  readonly mode: RegistryEgressMode;
  /** Present only for an enabled guard. */
  readonly manifest?: FrozenRegistryEgressManifest;
  readonly session: RegistryEgressSessionLedger;
  authorize(request: RegistryEgressRequest): AuthorizedRegistryEgressRequest;
  /** Authorize following one 3xx as the immediate bounded response to a content pull. */
  authorizeRedirect(current: AuthorizedRegistryEgressRequest, location: string): AuthorizedRegistryEgressRequest;
}

export interface CreateRegistryEgressGuardOptions {
  readonly mode: RegistryEgressMode;
  /** Absolute manifest path. Required (and fail-closed) for `public-registry`. */
  readonly manifestPath?: string;
  /**
   * Serve a `status: "draft"` (unreviewed) manifest. Off by default: a
   * `public-registry` guard fails closed on a non-frozen manifest so an
   * unreviewed origin/ceiling set can never serve live traffic (F2). Only the
   * hermetic tests and the pre-freeze live gate that deliberately exercise a
   * draft manifest set this; the production admission path never does.
   */
  readonly allowUnfrozenManifest?: boolean;
}

/** Build a per-session cumulative ledger from the manifest's session ceilings. */
export function createRegistryEgressSessionLedger(limits: RegistryEgressSessionLimits): RegistryEgressSessionLedger {
  let totalBytes = 0;
  let activeRequests = 0;
  return {
    maxTotalBytes: limits.maxTotalBytes,
    maxConcurrentRequests: limits.maxConcurrentRequests,
    get totalBytes(): number {
      return totalBytes;
    },
    get activeRequests(): number {
      return activeRequests;
    },
    acquire(): RegistryEgressLease {
      if (activeRequests >= limits.maxConcurrentRequests) {
        throw new Error(`registry-egress session concurrency ceiling reached (${limits.maxConcurrentRequests})`);
      }
      activeRequests += 1;
      let released = false;
      return {
        release(): void {
          if (released) return;
          released = true;
          activeRequests -= 1;
        },
      };
    },
    wouldFit(additional: number): boolean {
      return totalBytes + additional <= limits.maxTotalBytes;
    },
    addBytes(count: number): boolean {
      totalBytes += count;
      return totalBytes <= limits.maxTotalBytes;
    },
  };
}

/**
 * Build the guard once at bundle startup. Fail-closed: an enabled guard that cannot
 * load/validate the frozen manifest throws here, before any request is served.
 */
export function createRegistryEgressGuard(options: CreateRegistryEgressGuardOptions): RegistryEgressGuard {
  if (options.mode === 'disabled') {
    const disabled: RegistryEgressSessionLedger = createRegistryEgressSessionLedger({
      maxTotalBytes: 1,
      maxConcurrentRequests: 1,
    });
    return {
      mode: 'disabled',
      session: disabled,
      authorize() {
        throw new Error('registry egress is disabled; no registry pull is authorized');
      },
      authorizeRedirect() {
        throw new Error('registry egress is disabled; no redirect is authorized');
      },
    };
  }

  const { manifestPath } = options;
  if (manifestPath === undefined) throw new Error('public-registry egress requires a manifest path');

  const loaded = loadRegistryEgressManifest(manifestPath);
  const manifest = loaded.manifest;
  if (manifest.status !== 'frozen' && options.allowUnfrozenManifest !== true) {
    throw new Error(
      `registry egress requires a frozen manifest; ${loaded.path} has status "${manifest.status}" (set allowUnfrozenManifest only for tests or the pre-freeze gate)`,
    );
  }
  const session = createRegistryEgressSessionLedger(manifest.perSession);

  return {
    mode: 'public-registry',
    session,
    manifest: {
      path: loaded.path,
      sha256: loaded.sha256,
      policyId: manifest.policyId,
      status: manifest.status,
      origins: manifest.origins.map((origin) => ({
        id: origin.id,
        hostname: origin.destination.hostname,
        port: origin.destination.port,
      })),
    },
    authorize(request: RegistryEgressRequest): AuthorizedRegistryEgressRequest {
      return authorizeValidatedRegistryEgressRequest(manifest, request);
    },
    authorizeRedirect(current: AuthorizedRegistryEgressRequest, location: string): AuthorizedRegistryEgressRequest {
      return authorizeValidatedRegistryRedirect(manifest, current, location);
    },
  };
}

export interface RegistryEgressForwardContext {
  readonly guard: RegistryEgressGuard;
  /** Destination-bound transport: fixed-parent in nested mode, direct only in tests. */
  readonly transport: OutboundTransport;
  readonly scheme: 'http:' | 'https:';
  readonly targetHost: string;
  readonly targetPort: number;
  /** Origin-form request target (path + query) as seen after TLS termination. */
  readonly requestTarget: string;
  /** Optional audit sink; receives provenance once a content pull completes. */
  readonly recordProvenance?: (record: RegistryPullProvenance) => void;
}

/** Mutable per-request state: one logical pull, spanning any derived redirects. */
interface RegistryEgressExchange {
  readonly clientRes: http.ServerResponse;
  readonly context: RegistryEgressForwardContext;
  readonly lease: RegistryEgressLease;
  deadline?: NodeJS.Timeout;
  upstreamReq?: http.ClientRequest;
  settled: boolean;
}

/**
 * Authorize one registry-originated request against the frozen manifest, reserve a
 * session concurrency slot, forward it through the destination-bound transport,
 * follow bounded derived redirects, and stream the response with backpressure under
 * the per-request and per-session ceilings. Any rejection is a fail-closed response
 * with no upstream contact; the request body is drained but never forwarded (only
 * GET/HEAD are authorizable).
 */
export function handleRegistryEgressRequest(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  context: RegistryEgressForwardContext,
): void {
  clientReq.resume();

  let authorized: AuthorizedRegistryEgressRequest;
  try {
    authorized = context.guard.authorize({
      method: clientReq.method ?? 'GET',
      url: buildRequestUrl(context),
      headers: clientReq.headers,
    });
  } catch (error) {
    rejectRegistryEgress(clientRes, context, 403, error);
    return;
  }

  let lease: RegistryEgressLease;
  try {
    lease = context.guard.session.acquire();
  } catch (error) {
    rejectRegistryEgress(clientRes, context, 503, error);
    return;
  }

  const exchange: RegistryEgressExchange = { clientRes, context, lease, settled: false };
  exchange.deadline = armDeadline(exchange, authorized);
  clientRes.once('close', () => finalizeExchange(exchange));

  fetchAuthorized(exchange, authorized);
}

/** Absolute per-request wall-clock ceiling: tear down both sides and fail closed. */
function armDeadline(exchange: RegistryEgressExchange, authorized: AuthorizedRegistryEgressRequest): NodeJS.Timeout {
  const timer = setTimeout(() => {
    logger.info(`[registry-egress] ${authorized.originId} exceeded ${authorized.maxDurationMs}ms; aborting`);
    if (exchange.upstreamReq !== undefined) exchange.upstreamReq.destroy();
    if (!exchange.clientRes.headersSent) {
      rejectRegistryEgressResponse(exchange.clientRes, 504, 'registry pull exceeded the time ceiling');
    } else {
      exchange.clientRes.destroy();
    }
  }, authorized.maxDurationMs);
  timer.unref();
  return timer;
}

/** Idempotent teardown: clear the deadline and release the session concurrency slot. */
function finalizeExchange(exchange: RegistryEgressExchange): void {
  if (exchange.settled) return;
  exchange.settled = true;
  if (exchange.deadline !== undefined) clearTimeout(exchange.deadline);
  exchange.lease.release();
}

function fetchAuthorized(exchange: RegistryEgressExchange, authorized: AuthorizedRegistryEgressRequest): void {
  const { clientRes, context } = exchange;
  const destination: OutboundDestination = {
    protocol: authorized.destination.protocol,
    hostname: authorized.destination.hostname,
    port: authorized.destination.port,
  };

  let upstreamReq: http.ClientRequest;
  try {
    upstreamReq = context.transport.request(
      {
        destination,
        method: authorized.method,
        path: authorized.path,
        headers: toOutgoingHeaders(authorized.headers),
      },
      (upstreamRes) => onUpstreamResponse(exchange, upstreamRes, authorized),
    );
  } catch (error) {
    if (!clientRes.headersSent)
      rejectRegistryEgressResponse(clientRes, 502, error instanceof Error ? error.message : 'upstream request failed');
    else clientRes.destroy();
    return;
  }

  exchange.upstreamReq = upstreamReq;
  upstreamReq.on('error', (error) => {
    // A superseded hop's stale connection must not tear down the current one (F5).
    if (exchange.upstreamReq !== upstreamReq) return;
    if (!clientRes.headersSent) rejectRegistryEgressResponse(clientRes, 502, error.message);
    else clientRes.destroy();
  });
  upstreamReq.end();
}

function onUpstreamResponse(
  exchange: RegistryEgressExchange,
  upstreamRes: http.IncomingMessage,
  authorized: AuthorizedRegistryEgressRequest,
): void {
  if (exchange.settled || exchange.clientRes.writableEnded || exchange.clientRes.destroyed) {
    upstreamRes.resume(); // the exchange already failed closed (e.g. the deadline fired)
    return;
  }
  const status = upstreamRes.statusCode ?? 502;

  if (REDIRECT_STATUS_CODES.has(status)) {
    followRedirect(exchange, upstreamRes, authorized);
    return;
  }

  streamToClient(exchange, upstreamRes, authorized, status);
}

function followRedirect(
  exchange: RegistryEgressExchange,
  upstreamRes: http.IncomingMessage,
  authorized: AuthorizedRegistryEgressRequest,
): void {
  const location = firstHeader(upstreamRes.headers.location);
  if (location === undefined) {
    upstreamRes.destroy(); // fail closed without draining an unusable response
    rejectRegistryEgressResponse(exchange.clientRes, 502, 'registry redirect is missing a Location header');
    return;
  }
  // Authorize the redirect target before consuming its body: an unauthorized
  // target is rejected without spending bandwidth draining the 3xx response.
  let next: AuthorizedRegistryEgressRequest;
  try {
    next = exchange.context.guard.authorizeRedirect(authorized, location);
  } catch (error) {
    upstreamRes.destroy();
    rejectRegistryEgress(exchange.clientRes, exchange.context, 403, error);
    return;
  }
  // Drain the redirect body under the byte ceilings before following (F1): the body
  // is never delivered but still consumes bandwidth, so it counts against a tight
  // redirect cap, the per-request cap, and the cumulative session ledger. Overflow
  // fails the whole exchange closed; the per-request wall-clock deadline bounds a
  // slow body.
  const ledger = exchange.context.guard.session;
  const bodyCap = Math.min(MAX_REDIRECT_BODY_BYTES, authorized.maxBytes);
  let drained = 0;
  let aborted = false;
  upstreamRes.on('data', (chunk: Buffer) => {
    if (aborted) return;
    drained += chunk.length;
    if (drained > bodyCap || !ledger.addBytes(chunk.length)) {
      aborted = true;
      upstreamRes.destroy();
      rejectRegistryEgressResponse(exchange.clientRes, 502, 'registry redirect body exceeds a byte ceiling');
    }
  });
  upstreamRes.on('error', () => {
    if (aborted) return;
    aborted = true;
    rejectRegistryEgressResponse(exchange.clientRes, 502, 'registry redirect body transfer failed');
  });
  upstreamRes.on('end', () => {
    if (aborted || exchange.settled) return;
    fetchAuthorized(exchange, next);
  });
}

/**
 * Pipe the upstream response to the daemon with backpressure, enforcing the
 * per-request and per-session byte ceilings as bytes flow. A declared
 * `content-length` that already overshoots a ceiling is rejected before any body is
 * streamed; a chunked body that overshoots mid-stream tears down both sides. Content
 * pulls record provenance (requested + registry-reported digest, streamed size) on
 * successful completion.
 */
function streamToClient(
  exchange: RegistryEgressExchange,
  upstreamRes: http.IncomingMessage,
  authorized: AuthorizedRegistryEgressRequest,
  status: number,
): void {
  const { clientRes, context } = exchange;
  const ledger = context.guard.session;

  const declared = declaredContentLength(upstreamRes.headers);
  if (declared !== undefined && (declared > authorized.maxBytes || !ledger.wouldFit(declared))) {
    upstreamRes.resume();
    rejectRegistryEgressResponse(clientRes, 502, 'registry response exceeds a byte ceiling');
    return;
  }

  const resolvedDigest = reportedDigest(upstreamRes.headers);
  const limiter = createByteCeilingTransform(authorized.originId, authorized.maxBytes, ledger);
  let streamedBytes = 0;
  limiter.on('data', (chunk: Buffer) => {
    streamedBytes += chunk.length;
  });

  clientRes.writeHead(status, sanitizeResponseHeaders(upstreamRes.headers));
  pipeline(upstreamRes, limiter, clientRes, (error) => {
    if (error) {
      logger.info(`[registry-egress] ${authorized.originId} transfer failed: ${error.message}`);
      if (exchange.upstreamReq !== undefined) exchange.upstreamReq.destroy();
      clientRes.destroy();
      return;
    }
    recordProvenance(authorized, context, resolvedDigest, streamedBytes);
  });
}

/**
 * A pass-through Transform that fails closed once a stream exceeds the per-request
 * or cumulative per-session byte ceiling. `pipeline` propagates the error to destroy
 * both the upstream response and the client response.
 */
function createByteCeilingTransform(
  originId: string,
  maxRequestBytes: number,
  ledger: RegistryEgressSessionLedger,
): Transform {
  let requestBytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback): void {
      requestBytes += chunk.length;
      if (requestBytes > maxRequestBytes) {
        callback(new Error(`registry-egress ${originId} exceeded the per-request byte ceiling (${maxRequestBytes})`));
        return;
      }
      if (!ledger.addBytes(chunk.length)) {
        callback(
          new Error(`registry-egress ${originId} exceeded the per-session byte ceiling (${ledger.maxTotalBytes})`),
        );
        return;
      }
      callback(null, chunk);
    },
  });
}

function recordProvenance(
  authorized: AuthorizedRegistryEgressRequest,
  context: RegistryEgressForwardContext,
  resolvedDigest: string | undefined,
  sizeBytes: number,
): void {
  if (context.recordProvenance === undefined) return;
  if (authorized.operation !== 'manifest-pull' && authorized.operation !== 'blob-pull') return;
  context.recordProvenance({
    originId: authorized.originId,
    repository: authorized.repository,
    reference: authorized.reference,
    requestedDigest: authorized.requestedDigest ? `sha256:${authorized.requestedDigest.hex}` : undefined,
    resolvedDigest,
    sizeBytes,
  });
}

function declaredContentLength(headers: http.IncomingHttpHeaders): number | undefined {
  const raw = firstHeader(headers['content-length']);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Registry-reported content digest recorded as provenance only (never verified). */
function reportedDigest(headers: http.IncomingHttpHeaders): string | undefined {
  const raw = firstHeader(headers['docker-content-digest']);
  if (raw === undefined) return undefined;
  return parseOciDigest(raw) !== undefined ? raw : undefined;
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : value[0];
}

function rejectRegistryEgress(
  clientRes: http.ServerResponse,
  context: RegistryEgressForwardContext,
  status: number,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : 'registry egress denied';
  logger.info(`[registry-egress] DENIED ${context.scheme}//${context.targetHost}:${context.targetPort} — ${message}`);
  rejectRegistryEgressResponse(clientRes, status, message);
}

function rejectRegistryEgressResponse(clientRes: http.ServerResponse, status: number, message: string): void {
  if (!clientRes.headersSent) {
    clientRes.writeHead(status, { 'content-type': 'text/plain' });
    clientRes.end(`registry egress denied: ${message}\n`);
  } else {
    clientRes.destroy();
  }
}
