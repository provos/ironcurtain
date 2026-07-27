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
 * ceilings. Because a derived-redirect authority is chosen by the upstream response
 * and no parent hop can re-derive it, the SSRF check must happen in this process:
 * the forwarder refuses (502, before upstream contact) any transport that does not
 * declare `addressGuard: 'local-resolver'`. The body streams through with normal
 * backpressure — never accumulated in trusted memory. A per-request byte or absolute-time ceiling, or the cumulative
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
import {
  authorizeValidatedRegistryEgressRequest,
  authorizeValidatedRegistryRedirect,
  loadRegistryEgressManifest,
  parseOciDigest,
  type AuthorizedRegistryEgressRequest,
  type RegistryEgressRequest,
  type RegistryEgressSessionLimits,
} from './registry-egress-policy.js';
import type { OutboundTransport } from './outbound-transport.js';
import { buildRequestUrl, firstHeader } from './egress-forwarding.js';
import { forwardMediatedEgress, rejectMediatedEgress, type MediatedEgressRequestSpec } from './mediated-egress.js';
import * as logger from '../logger.js';

export type RegistryEgressMode = 'disabled' | 'public-registry';

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

/**
 * Authorize one registry-originated request against the frozen manifest (including
 * anonymous-bearer admission), then hand it to the shared mediated forwarder with
 * the registry-specific behaviors wired in: the per-session ledger, internal
 * derived-redirect following, and digest provenance. Any authorization rejection is
 * a fail-closed `403` with no upstream contact.
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

  forwardMediatedEgress<AuthorizedRegistryEgressRequest>(clientRes, {
    transport: context.transport,
    initial: authorized,
    label: 'registry-egress',
    describe: describeRegistryRequest,
    assertReady: () => assertLocalAddressAuthority(context.transport),
    session: context.guard.session,
    followRedirect: (current, location) => context.guard.authorizeRedirect(current, location),
    onComplete: (request, streamedBytes, responseHeaders) =>
      recordProvenance(request, context, reportedDigest(responseHeaders), streamedBytes),
  });
}

/**
 * Registry egress follows *derived* redirects: an unlisted CDN authority chosen
 * by the upstream response, i.e. an attacker-influenceable destination. That is
 * only safe when the address policy is applied in this process — no parent hop
 * can re-derive such an authority, so a `delegated` transport would leave the
 * SSRF check to nobody. Refuse before any upstream contact rather than assume.
 */
function assertLocalAddressAuthority(transport: OutboundTransport): void {
  if (transport.addressGuard !== 'local-resolver') {
    throw new Error(
      'registry egress follows derived redirects and requires a transport that resolves and screens destination addresses locally',
    );
  }
}

/** Map an authorized pull onto the shared forwarder's destination-bound fetch spec. */
function describeRegistryRequest(authorized: AuthorizedRegistryEgressRequest): MediatedEgressRequestSpec {
  return {
    destination: {
      protocol: authorized.destination.protocol,
      hostname: authorized.destination.hostname,
      port: authorized.destination.port,
    },
    method: authorized.method,
    path: authorized.path,
    headers: authorized.headers,
    maxBytes: authorized.maxBytes,
    maxDurationMs: authorized.maxDurationMs,
  };
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

/** Registry-reported content digest recorded as provenance only (never verified). */
function reportedDigest(headers: http.IncomingHttpHeaders): string | undefined {
  const raw = firstHeader(headers['docker-content-digest']);
  if (raw === undefined) return undefined;
  return parseOciDigest(raw) !== undefined ? raw : undefined;
}

function rejectRegistryEgress(
  clientRes: http.ServerResponse,
  context: RegistryEgressForwardContext,
  status: number,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : 'registry egress denied';
  logger.info(`[registry-egress] DENIED ${context.scheme}//${context.targetHost}:${context.targetPort} — ${message}`);
  rejectMediatedEgress(clientRes, status, `registry egress denied: ${message}`);
}
