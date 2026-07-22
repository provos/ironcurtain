/**
 * Proxy-side enforcement seam for the narrow current-Dockerfile build egress.
 *
 * ## Wiring-seam design (Phase 0F, §6.3 / §9.5 of the plan)
 *
 * The nested bundle's Docker daemon rebuilds only the checked-in IronCurtain
 * Dockerfiles, whose `RUN` steps fetch apt/npm/GitHub/toolchain artifacts. Those
 * fetches are the *only* build egress the base capability permits; everything
 * else is offline. This module is where the outer MITM turns a build-originated
 * request into an authorized, destination-bound upstream fetch — or a fail-closed
 * rejection.
 *
 * **How build traffic is identified.** Build egress does not share a socket with
 * agent/provider traffic. The nested build path connects to a MITM proxy that was
 * created in *build-egress mode* (`MitmProxyOptions.buildEgress`). Every request
 * that reaches such a proxy is build-originated by construction of the topology —
 * there are no LLM providers, package registries, or dynamic passthrough hosts on
 * that listener — so the proxy authorizes each decrypted request against the
 * frozen manifest instead of an allowlist. This avoids the impossible task of
 * distinguishing build vs agent HTTP on a shared tunnel and keeps the seam
 * auditable: one listener, one policy, one purpose.
 *
 * **How the outer MITM consults the manifest.** The proxy holds a
 * {@link BuildEgressGuard} built once at bundle startup. Construction is
 * fail-closed: in `ironcurtain-dockerfiles` mode it loads the frozen manifest
 * (strict schema, non-symlink, non-writable) and hash-binds the *current*
 * Dockerfiles via `verifyBuildEgressDockerfileSources`, so a drifted Dockerfile
 * or a missing/invalid manifest aborts before any request is served. In
 * `disabled` mode the guard authorizes nothing, so a build-egress-tagged request
 * fails fast. Per decrypted request the proxy calls {@link BuildEgressGuard.authorize},
 * which resolves the request to exactly one seam/host/method/path rule (rejecting
 * client-selected targets, credential/encoded-path smuggling, and undeclared
 * headers), then forwards the sanitized request through the existing
 * destination-bound {@link OutboundTransport} — never a generic TCP relay, never
 * with an injected credential. A `fixed-parent-only` rule additionally refuses to
 * egress over anything but the fixed-parent transport, so a misconfiguration can
 * never leak a reviewed origin to direct egress.
 *
 * The pure policy (schema, load, verify, single-rule resolution) lives in
 * `../docker-workload/build-egress-policy.ts`; this module owns only the
 * lifecycle (freeze) and the I/O (forward), keeping the policy independently
 * testable.
 *
 * Foundation-code scope: redirect-chain provenance is not yet threaded across
 * hops (each hop is authorized on its own rule; the build client drives
 * redirects), and BuildKit per-seam tagging is a fixed per-listener value here.
 * Both are Phase 0C concerns and stay inert behind the docker-workload admission
 * fuse until then. The `MitmProxyOptions.buildEgress` mode flags in
 * `mitm-proxy.ts` that route a listener here are a natural candidate for a later
 * strategy-object consolidation of the proxy's per-listener modes.
 */

import * as http from 'node:http';
import {
  authorizeValidatedBuildEgressRequest,
  loadBuildEgressManifest,
  verifyBuildEgressDockerfileSources,
  type AuthorizedBuildEgressRequest,
  type BuildEgressRequest,
  type BuildEgressRule,
} from '../docker-workload/build-egress-policy.js';
import type { OutboundDestination, OutboundTransport } from './outbound-transport.js';
import { buildRequestUrl, sanitizeResponseHeaders, toOutgoingHeaders } from './egress-forwarding.js';
import * as logger from '../logger.js';

export type BuildEgressMode = 'disabled' | 'ironcurtain-dockerfiles';
export type BuildEgressSeam = BuildEgressRule['seams'][number];

/** Frozen manifest identity retained for audit and diagnostics. */
export interface FrozenBuildEgressManifest {
  readonly path: string;
  readonly sha256: string;
  readonly policyId: string;
  readonly dockerfiles: readonly { readonly path: string; readonly sha256: string }[];
}

/**
 * The narrow safe API the outer MITM calls. `authorize` is the single policy
 * decision point; it throws (fail-closed) for a disabled guard, a client-selected
 * target, a credential/encoded-path smuggle, or any undeclared behavior.
 */
export interface BuildEgressGuard {
  readonly mode: BuildEgressMode;
  /** Present only for an enabled guard. */
  readonly manifest?: FrozenBuildEgressManifest;
  authorize(request: BuildEgressRequest): AuthorizedBuildEgressRequest;
}

export interface CreateBuildEgressGuardOptions {
  readonly mode: BuildEgressMode;
  /** Absolute manifest path. Required (and fail-closed) for `ironcurtain-dockerfiles`. */
  readonly manifestPath?: string;
  /** Canonical absolute repository root the manifest hash-binds. Required for `ironcurtain-dockerfiles`. */
  readonly repositoryRoot?: string;
}

/**
 * Build the guard once at bundle startup. Fail-closed: an enabled guard that
 * cannot load/validate the frozen manifest or prove the current Dockerfile hashes
 * throws here, before any request is served.
 */
export function createBuildEgressGuard(options: CreateBuildEgressGuardOptions): BuildEgressGuard {
  if (options.mode === 'disabled') {
    return {
      mode: 'disabled',
      authorize() {
        throw new Error('build egress is disabled; no build-originated request is authorized');
      },
    };
  }

  const { manifestPath, repositoryRoot } = options;
  if (manifestPath === undefined || repositoryRoot === undefined) {
    throw new Error('ironcurtain-dockerfiles build egress requires a manifest path and repository root');
  }

  const loaded = loadBuildEgressManifest(manifestPath);
  const dockerfiles = verifyBuildEgressDockerfileSources(loaded.manifest, repositoryRoot);
  // The manifest is validated exactly once at guard construction; the per-request
  // hot path below authorizes against the pre-validated manifest without re-parsing.
  const manifest = loaded.manifest;

  return {
    mode: 'ironcurtain-dockerfiles',
    manifest: {
      path: loaded.path,
      sha256: loaded.sha256,
      policyId: manifest.policyId,
      dockerfiles: dockerfiles.map((source) => ({ path: source.path, sha256: source.sha256 })),
    },
    authorize(request: BuildEgressRequest): AuthorizedBuildEgressRequest {
      return authorizeValidatedBuildEgressRequest(manifest, request);
    },
  };
}

export interface BuildEgressForwardContext {
  readonly guard: BuildEgressGuard;
  /** The build seam this listener serves (fixed per listener in foundation wiring). */
  readonly seam: BuildEgressSeam;
  /** Destination-bound transport: fixed-parent in nested mode, direct only in tests. */
  readonly transport: OutboundTransport;
  readonly scheme: 'http:' | 'https:';
  readonly targetHost: string;
  readonly targetPort: number;
  /** Origin-form request target (path + query) as seen after TLS termination. */
  readonly requestTarget: string;
}

/**
 * Authorize one build-originated request against the frozen manifest and forward
 * the sanitized result through the destination-bound transport. Any rejection is
 * a fail-closed `403` with no upstream contact; the request body is drained but
 * never forwarded (only GET/HEAD are authorizable).
 */
export function handleBuildEgressRequest(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  context: BuildEgressForwardContext,
): void {
  clientReq.resume();

  let authorized: AuthorizedBuildEgressRequest;
  try {
    authorized = context.guard.authorize({
      seam: context.seam,
      method: clientReq.method ?? 'GET',
      url: buildRequestUrl(context),
      headers: clientReq.headers,
    });
  } catch (error) {
    rejectBuildEgress(clientRes, context, error);
    return;
  }

  forwardAuthorizedBuildEgress(clientRes, authorized, context.transport);
}

function forwardAuthorizedBuildEgress(
  clientRes: http.ServerResponse,
  authorized: AuthorizedBuildEgressRequest,
  transport: OutboundTransport,
): void {
  if (authorized.destination.addressPolicy === 'fixed-parent-only' && transport.kind !== 'fixed-parent-proxy') {
    rejectBuildEgressResponse(clientRes, 502, 'fixed-parent-only rule requires the fixed parent proxy transport');
    return;
  }

  const destination: OutboundDestination = {
    protocol: authorized.destination.protocol,
    hostname: authorized.destination.hostname,
    port: authorized.destination.port,
  };

  let forwardedBytes = 0;
  let upstreamReq: http.ClientRequest;
  try {
    upstreamReq = transport.request(
      { destination, method: authorized.method, path: authorized.path, headers: toOutgoingHeaders(authorized.headers) },
      (upstreamRes) => {
        clientRes.writeHead(upstreamRes.statusCode ?? 502, sanitizeResponseHeaders(upstreamRes.headers));
        upstreamRes.on('data', (chunk: Buffer) => {
          forwardedBytes += chunk.length;
          if (forwardedBytes > authorized.responseBytes) {
            logger.info(`[build-egress] ${authorized.ruleId} exceeded ${authorized.responseBytes} response bytes`);
            upstreamReq.destroy();
            upstreamRes.destroy();
            clientRes.destroy();
            return;
          }
          clientRes.write(chunk);
        });
        upstreamRes.on('end', () => clientRes.end());
        upstreamRes.on('error', () => clientRes.destroy());
      },
    );
  } catch (error) {
    rejectBuildEgressResponse(clientRes, 502, error instanceof Error ? error.message : 'upstream request failed');
    return;
  }

  upstreamReq.setTimeout(authorized.timeoutMs, () => {
    upstreamReq.destroy(new Error(`build egress timed out after ${authorized.timeoutMs}ms`));
  });
  upstreamReq.on('error', (error) => {
    if (!clientRes.headersSent) {
      rejectBuildEgressResponse(clientRes, 502, error.message);
    } else {
      clientRes.destroy();
    }
  });
  upstreamReq.end();
}

function rejectBuildEgress(clientRes: http.ServerResponse, context: BuildEgressForwardContext, error: unknown): void {
  const message = error instanceof Error ? error.message : 'build egress denied';
  logger.info(`[build-egress] DENIED ${context.scheme}//${context.targetHost}:${context.targetPort} — ${message}`);
  rejectBuildEgressResponse(clientRes, 403, message);
}

function rejectBuildEgressResponse(clientRes: http.ServerResponse, status: number, message: string): void {
  if (!clientRes.headersSent) {
    clientRes.writeHead(status, { 'content-type': 'text/plain' });
    clientRes.end(`build egress denied: ${message}\n`);
  } else {
    clientRes.destroy();
  }
}
