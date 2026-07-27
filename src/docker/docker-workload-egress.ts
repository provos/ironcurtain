/**
 * Construction seam for the nested Docker workload's egress listeners.
 *
 * ## What this module is
 *
 * Phase 0F froze two egress policies — anonymous workload-image registry pulls
 * (§6.4) and the narrow current-Dockerfile build path (§6.3) — each with a
 * guard factory and a whole-proxy MITM mode. This module is the single place
 * that turns a *resolved* Docker-workload configuration into the exact set of
 * listeners that configuration authorizes, with the frozen manifests, the
 * per-mode proxy options, and the transport preconditions all decided in one
 * reviewable spot.
 *
 * It **constructs but does not start** the listeners. Binding a socket is a
 * placement decision with security consequences (an egress socket must not land
 * anywhere the agent container can reach), so start/stop and socket placement
 * stay with the caller that owns the bundle topology.
 *
 * ## No listener is the "off" state — never a listener that says no
 *
 * A mode that the configuration does not enable produces *no listener at all*,
 * not a listener wired to a `disabled` guard. A bound socket that TLS-terminates
 * every host and then 403s is strictly more attack surface than an absent
 * socket, and the design's claim for `preloaded-only` / `buildEgress: disabled`
 * is "there is no route" — not "there is a route that refuses".
 *
 * ## Fail-closed, at construction
 *
 * Guard construction is where the frozen manifests are loaded, validated, and
 * (for build egress) hash-bound to the current Dockerfiles; those throws
 * propagate unchanged. On top of that, both transport preconditions are checked
 * here rather than discovered per request:
 *
 * - Build egress requires a `fixed-parent-proxy` transport, because every rule
 *   in the frozen manifest is `addressPolicy: 'fixed-parent-only'` and would be
 *   refused per request on any other transport. A direct transport is a
 *   misconfiguration of the bundle, not a runtime condition.
 * - Registry egress requires `addressGuard: 'local-resolver'`, because it
 *   follows registry-chosen derived redirects and must therefore be the address
 *   authority itself (no other hop can re-derive such an authority).
 *
 * Neither listener is ever given LLM providers, package registries, package
 * validation, trajectory capture, a token-stream session, or a control
 * socket/port. The control API can add passthrough hosts, which would be an
 * unmediated route around the frozen manifest, so its absence is load-bearing
 * rather than incidental.
 *
 * Foundation code — inert behind the docker-workload admission fuse
 * (`assertDockerWorkloadImplementationAvailable`). No production caller
 * constructs these listeners yet; the nested rootless daemon that consumes them
 * does not exist.
 */

import type { ResolvedDockerWorkloadConfig } from '../docker-workload/config.js';
import { createBuildEgressGuard, type BuildEgressSeam } from './build-egress-proxy.js';
import type { CertificateAuthority } from './ca.js';
import {
  getFrozenBuildEgressManifestPath,
  getFrozenRegistryEgressManifestPath,
  getIronCurtainPackageRoot,
} from './docker-workload-paths.js';
import { createMitmProxy, type MitmProxy, type MitmProxyOptions } from './mitm-proxy.js';
import type { OutboundTransport } from './outbound-transport.js';
import { createRegistryEgressGuard } from './registry-egress-proxy.js';

/**
 * The build seam this listener serves. Every rule in the frozen build-egress
 * manifest declares `seams: ["run"]` — the Dockerfile-frontend and base-image
 * seams are mediated elsewhere (registry egress), not by a build listener.
 */
const BUILD_EGRESS_SEAM: BuildEgressSeam = 'run';

/**
 * Where a listener binds. Supplied by the caller: socket placement is a
 * topology decision this module deliberately does not make.
 */
export type DockerWorkloadEgressListenTarget =
  | { readonly socketPath: string; readonly listenPort?: never }
  | { readonly socketPath?: never; readonly listenPort: number };

/** Constructed (not started) listeners; an absent mode has no listener. */
export interface DockerWorkloadEgressListeners {
  readonly registryEgress?: MitmProxy;
  readonly buildEgress?: MitmProxy;
}

/**
 * The exact proxy options each enabled mode contributes, before any socket is
 * bound. Exposed so a caller can record the frozen manifest identity for audit
 * — and so the option discipline above is assertable — without owning a proxy.
 */
export interface DockerWorkloadEgressListenerOptions {
  readonly registryEgress?: MitmProxyOptions;
  readonly buildEgress?: MitmProxyOptions;
}

export interface CreateDockerWorkloadEgressListenersOptions {
  /** Trusted resolved configuration; a disabled workload yields no listeners. */
  readonly workload: ResolvedDockerWorkloadConfig;
  /** Session CA used to sign the per-host leaf certificates each listener presents. */
  readonly ca: CertificateAuthority;
  /**
   * Destination-bound transport shared by the listeners. Required: the
   * production fixed-parent endpoint is an unresolved topology decision, so
   * this module never invents one.
   */
  readonly outboundTransport: OutboundTransport;
  /** Required when `imageIngress` is `public-registry`. */
  readonly registryListen?: DockerWorkloadEgressListenTarget;
  /** Required when `buildEgress` is `ironcurtain-dockerfiles`. */
  readonly buildListen?: DockerWorkloadEgressListenTarget;
  /**
   * Checkout whose Dockerfiles the frozen build manifest hash-binds. Defaults
   * to this package's root. Overriding it cannot loosen anything — the manifest
   * still pins the exact reviewed bytes, so a root with different Dockerfiles
   * fails construction.
   */
  readonly repositoryRoot?: string;
}

/**
 * Decide which listeners the configuration authorizes and with exactly which
 * options, loading and validating the frozen manifests. Fail-closed: manifest,
 * Dockerfile-hash, and transport-precondition failures throw here.
 */
export function resolveDockerWorkloadEgressListenerOptions(
  options: CreateDockerWorkloadEgressListenersOptions,
): DockerWorkloadEgressListenerOptions {
  const { workload } = options;
  if (!workload.enabled) return {};

  const resolved: { registryEgress?: MitmProxyOptions; buildEgress?: MitmProxyOptions } = {};
  if (workload.imageIngress === 'public-registry') {
    resolved.registryEgress = registryEgressListenerOptions(options);
  }
  if (workload.buildEgress === 'ironcurtain-dockerfiles') {
    resolved.buildEgress = buildEgressListenerOptions(options);
  }
  return resolved;
}

/**
 * Construct the listeners the configuration authorizes. The caller owns the
 * lifecycle: nothing here binds a socket or starts a proxy.
 */
export function createDockerWorkloadEgressListeners(
  options: CreateDockerWorkloadEgressListenersOptions,
): DockerWorkloadEgressListeners {
  const resolved = resolveDockerWorkloadEgressListenerOptions(options);
  const listeners: { registryEgress?: MitmProxy; buildEgress?: MitmProxy } = {};
  if (resolved.registryEgress !== undefined) listeners.registryEgress = createMitmProxy(resolved.registryEgress);
  if (resolved.buildEgress !== undefined) listeners.buildEgress = createMitmProxy(resolved.buildEgress);
  return listeners;
}

function registryEgressListenerOptions(options: CreateDockerWorkloadEgressListenersOptions): MitmProxyOptions {
  const transport = options.outboundTransport;
  // Written fail-closed so a transport that omits the capability is refused.
  if (transport.addressGuard !== 'local-resolver') {
    throw new Error(
      'registry egress requires an outbound transport that resolves and screens destination addresses locally ' +
        `(got addressGuard "${transport.addressGuard}"): it follows registry-chosen redirect authorities that no other hop can re-derive`,
    );
  }
  return {
    ...listenOptions(options.registryListen, 'registry egress'),
    ca: options.ca,
    providers: [],
    outboundTransport: transport,
    registryEgress: {
      guard: createRegistryEgressGuard({
        mode: 'public-registry',
        manifestPath: getFrozenRegistryEgressManifestPath(),
      }),
    },
  };
}

function buildEgressListenerOptions(options: CreateDockerWorkloadEgressListenersOptions): MitmProxyOptions {
  const transport = options.outboundTransport;
  if (transport.kind !== 'fixed-parent-proxy') {
    throw new Error(
      'build egress requires the fixed parent proxy transport ' +
        `(got kind "${transport.kind}"): every rule in the frozen build manifest is fixed-parent-only`,
    );
  }
  return {
    ...listenOptions(options.buildListen, 'build egress'),
    ca: options.ca,
    providers: [],
    outboundTransport: transport,
    buildEgress: {
      guard: createBuildEgressGuard({
        mode: 'ironcurtain-dockerfiles',
        manifestPath: getFrozenBuildEgressManifestPath(),
        repositoryRoot: options.repositoryRoot ?? getIronCurtainPackageRoot(),
      }),
      seam: BUILD_EGRESS_SEAM,
    },
  };
}

function listenOptions(
  target: DockerWorkloadEgressListenTarget | undefined,
  label: string,
): Pick<MitmProxyOptions, 'socketPath' | 'listenPort'> {
  if (target === undefined) throw new Error(`${label} is enabled but no listen target was supplied`);
  return target.socketPath !== undefined ? { socketPath: target.socketPath } : { listenPort: target.listenPort };
}
