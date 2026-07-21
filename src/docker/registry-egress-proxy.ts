/**
 * Proxy-side enforcement seam for anonymous workload-image registry egress (§6.4).
 *
 * ## Wiring-seam design (Phase 0F, §6.4 / §16.5 of the plan)
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
 * delete / catalog / tags enumeration, any credential header (anonymous-only — the
 * bundle holds no registry credential and the proxy injects none), and encoded-path
 * smuggling. The sanitized request is forwarded through the destination-bound
 * {@link OutboundTransport} — never a generic TCP relay, never with an injected
 * credential.
 *
 * **The load-bearing control — content-addressed verification.** A by-digest pull
 * (blob, or manifest by `sha256:…`) carries the requested digest in its URL. The
 * forwarder streams the response into {@link createRegistryContentHasher}, and only
 * a body whose sha256 matches is delivered; a mismatch is a fail-closed `502` with
 * the substituted content never handed to the daemon. This is what lets a blob
 * redirect follow a *dynamic* CDN host (not in the manifest) safely — the CDN cannot
 * substitute content. A tag pull has no a-priori digest, so its digest is resolved
 * from the verified bytes and recorded in provenance before any blob is fetched.
 *
 * The pure policy (schema, load, single-origin resolution, digest helpers) lives in
 * `./registry-egress-policy.ts`; this module owns only the lifecycle (freeze) and the
 * I/O (forward, follow bounded redirects, verify, deliver), keeping the policy
 * independently testable.
 *
 * Foundation-code scope: the forwarder buffers each bounded response before delivery
 * so unverified content is never streamed to the daemon — simple and strongly
 * fail-closed, but memory-bounded by the per-request ceiling rather than truly
 * streaming. True streaming delivery with a rolling hash, per-image cumulative
 * accounting across a full pull, and the anonymous bearer-token flow are Phase 0C
 * concerns and stay inert behind the docker-workload admission fuse until then.
 */

import * as http from 'node:http';
import {
  authorizeValidatedRegistryEgressRequest,
  authorizeValidatedRegistryRedirect,
  createRegistryContentHasher,
  loadRegistryEgressManifest,
  verifyContentDigest,
  type AuthorizedRegistryEgressRequest,
  type RegistryEgressRequest,
} from './registry-egress-policy.js';
import type { OutboundDestination, OutboundTransport } from './outbound-transport.js';
import { HOP_BY_HOP_RESPONSE_HEADERS } from './hop-by-hop-headers.js';
import * as logger from '../logger.js';

export type RegistryEgressMode = 'disabled' | 'public-registry';

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

/** Frozen manifest identity retained for audit and diagnostics. */
export interface FrozenRegistryEgressManifest {
  readonly path: string;
  readonly sha256: string;
  readonly policyId: string;
  readonly status: 'draft' | 'frozen';
  readonly origins: readonly { readonly id: string; readonly hostname: string; readonly port: number }[];
}

/** Resolved-digest provenance recorded for audit before content is delivered. */
export interface RegistryPullProvenance {
  readonly originId: string;
  readonly repository?: string;
  readonly reference?: string;
  readonly requestedDigest?: string;
  readonly resolvedDigest: string;
  readonly sizeBytes: number;
}

/**
 * The narrow safe API the outer MITM calls. `authorize` is the single policy
 * decision point; it throws (fail-closed) for a disabled guard, a client-selected
 * host, a credential header, a non-pull operation, or any undeclared behavior.
 */
export interface RegistryEgressGuard {
  readonly mode: RegistryEgressMode;
  /** Present only for an enabled guard. */
  readonly manifest?: FrozenRegistryEgressManifest;
  authorize(request: RegistryEgressRequest): AuthorizedRegistryEgressRequest;
  /** Authorize following one 3xx as the immediate bounded response to a content pull. */
  authorizeRedirect(current: AuthorizedRegistryEgressRequest, location: string): AuthorizedRegistryEgressRequest;
}

export interface CreateRegistryEgressGuardOptions {
  readonly mode: RegistryEgressMode;
  /** Absolute manifest path. Required (and fail-closed) for `public-registry`. */
  readonly manifestPath?: string;
}

/**
 * Build the guard once at bundle startup. Fail-closed: an enabled guard that cannot
 * load/validate the frozen manifest throws here, before any request is served.
 */
export function createRegistryEgressGuard(options: CreateRegistryEgressGuardOptions): RegistryEgressGuard {
  if (options.mode === 'disabled') {
    return {
      mode: 'disabled',
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

  return {
    mode: 'public-registry',
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
  /** Optional audit sink; receives the resolved digest before content is delivered. */
  readonly recordProvenance?: (record: RegistryPullProvenance) => void;
}

/**
 * Authorize one registry-originated request against the frozen manifest, forward it
 * through the destination-bound transport, follow bounded redirects, verify the
 * content digest, and deliver only verified content. Any rejection is a fail-closed
 * `403` with no upstream contact; the request body is drained but never forwarded
 * (only GET/HEAD are authorizable).
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
    rejectRegistryEgress(clientRes, context, error);
    return;
  }

  fetchAuthorized(clientRes, authorized, context);
}

function buildRequestUrl(context: RegistryEgressForwardContext): string {
  const target = context.requestTarget.startsWith('/') ? context.requestTarget : `/${context.requestTarget}`;
  return `${context.scheme}//${formatAuthority(context.targetHost, context.targetPort, context.scheme)}${target}`;
}

function fetchAuthorized(
  clientRes: http.ServerResponse,
  authorized: AuthorizedRegistryEgressRequest,
  context: RegistryEgressForwardContext,
): void {
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
      (upstreamRes) => onUpstreamResponse(clientRes, upstreamReq, upstreamRes, authorized, context),
    );
  } catch (error) {
    rejectRegistryEgressResponse(clientRes, 502, error instanceof Error ? error.message : 'upstream request failed');
    return;
  }

  upstreamReq.setTimeout(authorized.requestTimeoutMs, () => {
    upstreamReq.destroy(new Error(`registry egress timed out after ${authorized.requestTimeoutMs}ms`));
  });
  upstreamReq.on('error', (error) => {
    if (!clientRes.headersSent) rejectRegistryEgressResponse(clientRes, 502, error.message);
    else clientRes.destroy();
  });
  upstreamReq.end();
}

function onUpstreamResponse(
  clientRes: http.ServerResponse,
  upstreamReq: http.ClientRequest,
  upstreamRes: http.IncomingMessage,
  authorized: AuthorizedRegistryEgressRequest,
  context: RegistryEgressForwardContext,
): void {
  const status = upstreamRes.statusCode ?? 502;

  if (REDIRECT_STATUS_CODES.has(status)) {
    followRedirect(clientRes, upstreamRes, authorized, context);
    return;
  }

  // HEAD and non-2xx bodies (e.g. a 401 that drives the token flow) are delivered
  // verbatim under the byte ceiling; only 2xx GET content is digest-verified.
  if (authorized.method === 'HEAD' || status < 200 || status >= 300) {
    forwardBounded(clientRes, upstreamRes, upstreamReq, authorized, status);
    return;
  }

  verifyAndDeliver(clientRes, upstreamRes, upstreamReq, authorized, context, status);
}

function followRedirect(
  clientRes: http.ServerResponse,
  upstreamRes: http.IncomingMessage,
  authorized: AuthorizedRegistryEgressRequest,
  context: RegistryEgressForwardContext,
): void {
  const location = firstHeader(upstreamRes.headers.location);
  upstreamRes.resume(); // drain the redirect body before re-requesting
  if (location === undefined) {
    rejectRegistryEgressResponse(clientRes, 502, 'registry redirect is missing a Location header');
    return;
  }
  let next: AuthorizedRegistryEgressRequest;
  try {
    next = context.guard.authorizeRedirect(authorized, location);
  } catch (error) {
    rejectRegistryEgress(clientRes, context, error);
    return;
  }
  fetchAuthorized(clientRes, next, context);
}

function verifyAndDeliver(
  clientRes: http.ServerResponse,
  upstreamRes: http.IncomingMessage,
  upstreamReq: http.ClientRequest,
  authorized: AuthorizedRegistryEgressRequest,
  context: RegistryEgressForwardContext,
  status: number,
): void {
  const hasher = createRegistryContentHasher();
  const chunks: Buffer[] = [];
  let overflowed = false;

  upstreamRes.on('data', (chunk: Buffer) => {
    if (overflowed) return;
    if (hasher.bytesHashed + chunk.length > authorized.requestBytes) {
      overflowed = true;
      logger.info(`[registry-egress] ${authorized.originId} exceeded ${authorized.requestBytes} response bytes`);
      upstreamReq.destroy();
      upstreamRes.destroy();
      rejectRegistryEgressResponse(clientRes, 502, 'registry response exceeded the byte ceiling');
      return;
    }
    hasher.update(chunk);
    chunks.push(chunk);
  });
  upstreamRes.on('error', () => {
    if (!clientRes.headersSent) rejectRegistryEgressResponse(clientRes, 502, 'registry response stream error');
    else clientRes.destroy();
  });
  upstreamRes.on('end', () => {
    if (overflowed) return;
    const computedHex = hasher.digestHex();

    if (authorized.expectedDigest !== undefined) {
      const verification = verifyContentDigest(authorized.expectedDigest, computedHex);
      if (!verification.verified) {
        logger.info(
          `[registry-egress] DIGEST MISMATCH ${authorized.originId} ${authorized.path}: ` +
            `expected sha256:${verification.expectedHex} got sha256:${verification.computedHex}`,
        );
        rejectRegistryEgressResponse(clientRes, 502, 'registry content digest does not match the requested digest');
        return;
      }
    }

    recordProvenance(authorized, context, computedHex, hasher.bytesHashed);

    const body = Buffer.concat(chunks);
    clientRes.writeHead(status, deliveredHeaders(upstreamRes.headers, body.length));
    clientRes.end(body);
  });
}

function recordProvenance(
  authorized: AuthorizedRegistryEgressRequest,
  context: RegistryEgressForwardContext,
  computedHex: string,
  sizeBytes: number,
): void {
  if (context.recordProvenance === undefined) return;
  if (authorized.expectedDigest === undefined && !authorized.resolvesDigest) return;
  context.recordProvenance({
    originId: authorized.originId,
    repository: authorized.repository,
    reference: authorized.reference,
    requestedDigest: authorized.expectedDigest ? `sha256:${authorized.expectedDigest.hex}` : undefined,
    resolvedDigest: `sha256:${computedHex}`,
    sizeBytes,
  });
}

function forwardBounded(
  clientRes: http.ServerResponse,
  upstreamRes: http.IncomingMessage,
  upstreamReq: http.ClientRequest,
  authorized: AuthorizedRegistryEgressRequest,
  status: number,
): void {
  let forwardedBytes = 0;
  clientRes.writeHead(status, deliveredHeaders(upstreamRes.headers));
  upstreamRes.on('data', (chunk: Buffer) => {
    forwardedBytes += chunk.length;
    if (forwardedBytes > authorized.requestBytes) {
      logger.info(`[registry-egress] ${authorized.originId} exceeded ${authorized.requestBytes} response bytes`);
      upstreamReq.destroy();
      upstreamRes.destroy();
      clientRes.destroy();
      return;
    }
    clientRes.write(chunk);
  });
  upstreamRes.on('end', () => clientRes.end());
  upstreamRes.on('error', () => clientRes.destroy());
}

function deliveredHeaders(headers: http.IncomingHttpHeaders, contentLength?: number): http.OutgoingHttpHeaders {
  const result: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP_RESPONSE_HEADERS.has(lower)) continue;
    // The buffered body is re-framed with an exact content-length below.
    if (contentLength !== undefined && lower === 'content-length') continue;
    result[name] = value;
  }
  if (contentLength !== undefined) result['content-length'] = contentLength;
  return result;
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : value[0];
}

function toOutgoingHeaders(headers: Readonly<Record<string, string | readonly string[]>>): http.OutgoingHttpHeaders {
  const result: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name] = typeof value === 'string' ? value : [...value];
  }
  return result;
}

function rejectRegistryEgress(
  clientRes: http.ServerResponse,
  context: RegistryEgressForwardContext,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : 'registry egress denied';
  logger.info(`[registry-egress] DENIED ${context.scheme}//${context.targetHost}:${context.targetPort} — ${message}`);
  rejectRegistryEgressResponse(clientRes, 403, message);
}

function rejectRegistryEgressResponse(clientRes: http.ServerResponse, status: number, message: string): void {
  if (!clientRes.headersSent) {
    clientRes.writeHead(status, { 'content-type': 'text/plain' });
    clientRes.end(`registry egress denied: ${message}\n`);
  } else {
    clientRes.destroy();
  }
}

function formatAuthority(hostname: string, port: number, scheme: 'http:' | 'https:'): string {
  const host = hostname.includes(':') ? `[${hostname}]` : hostname;
  const standard = (scheme === 'https:' && port === 443) || (scheme === 'http:' && port === 80);
  return standard ? host : `${host}:${port}`;
}
