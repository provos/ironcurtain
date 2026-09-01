/**
 * Construction seam for the nested Docker workload's egress listeners.
 *
 * ## What this module is
 *
 * This module is the single construction seam for the distinct registry and
 * strict-package listeners. It turns a
 * *resolved* Docker-workload configuration into the exact listener set that
 * configuration authorizes while keeping the independent implementations from
 * being accidentally merged.
 *
 * It **constructs but does not start** the listeners. Binding a socket is a
 * placement decision with security consequences (each authority must land only
 * at its exact per-bundle path and matching guest mount), so start/stop and
 * socket placement stay with the caller that owns the bundle topology.
 *
 * ## No listener is the "off" state — never a listener that says no
 *
 * A mode that the configuration does not enable produces *no listener at all*,
 * not a listener wired to a `disabled` guard. A bound socket that TLS-terminates
 * every host and then 403s is strictly more attack surface than an absent
 * socket, and the design's claim for `networkAccess: "offline"`
 * is "there is no route" — not "there is a route that refuses".
 *
 * ## Fail-closed, at construction
 *
 * Registry guard construction loads and validates the frozen origin/operation
 * manifest. Its transport precondition is checked here rather than discovered
 * per request:
 * - Registry egress requires `addressGuard: 'local-resolver'`, because it
 *   follows registry-chosen derived redirects and must therefore be the address
 *   authority itself (no other hop can re-derive such an authority).
 *
 * The registry listener is not given LLM providers, package registries,
 * trajectory capture, a token-stream session, or a control socket/port. The
 * dedicated package proxy receives only the session CA and the optional
 * source-owned package policy; it has no provider, control, credential, or
 * generic CONNECT mode. Policy-enabled artifact requests are checked against
 * bounded derived metadata fetched through the same screened dialer.
 *
 * Production construction remains inert unless the resolved Docker-workload
 * configuration explicitly admits the corresponding mode. The bundle
 * lifecycle owns the returned listeners; backend adapters choose only their
 * UDS or TCP exposure. The obsolete current-Dockerfile
 * build-egress listener was deleted; package builds use the separate
 * credential-free strict package proxy.
 */

import type { ResolvedDockerWorkloadConfig } from '../docker-workload/config.js';
import type { CertificateAuthority } from './ca.js';
import { getFrozenRegistryEgressManifestPath } from './docker-workload-paths.js';
import { createMitmProxy, type MitmProxy, type MitmProxyOptions } from './mitm-proxy.js';
import type { OutboundTransport } from './outbound-transport.js';
import {
  createPackageEgressProxy,
  type PackageEgressListenTarget,
  type PackageEgressPolicy,
  type PackageEgressProxy,
} from './package-egress-proxy.js';
import {
  createRegistryEgressGuard,
  type RegistryEgressGuard,
  type RegistryEgressSessionLedger,
} from './registry-egress-proxy.js';

/**
 * Where a listener binds. Supplied by the caller: socket placement is a
 * topology decision this module deliberately does not make.
 */
export type DockerWorkloadEgressListenTarget = PackageEgressListenTarget;

/** Exact egress authorities for one admitted mode; offline is `undefined`. */
export type DockerWorkloadEgressSet<R, P> =
  | { readonly networkAccess: 'images'; readonly registry: R }
  | { readonly networkAccess: 'packages'; readonly registry: R; readonly packages: P };

export interface RegistryEgressLedgerSnapshot {
  readonly attempts: number;
  readonly totalBytes: number;
  readonly activeRequests: number;
}

export interface DockerWorkloadEgressAuthority<L, S> {
  readonly listener: L;
  readonly snapshot: () => S;
}

export type RegistryEgressAuthority = DockerWorkloadEgressAuthority<MitmProxy, RegistryEgressLedgerSnapshot>;
export type PackageEgressAuthority = DockerWorkloadEgressAuthority<
  PackageEgressProxy,
  import('./package-egress-ledger.js').PackageEgressLedgerSnapshot
> & { readonly listenTarget: DockerWorkloadEgressListenTarget };

interface ResolvedRegistryEgress {
  readonly options: MitmProxyOptions;
  readonly session: RegistryEgressSessionLedger;
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
  /** Required when the workload admits registry image ingress. */
  readonly registryListen?: DockerWorkloadEgressListenTarget;
  /** Required only for strict package mode. */
  readonly packageListen?: DockerWorkloadEgressListenTarget;
  /** Optional TCP source admission shared by the registry and package authorities. */
  readonly allowRemoteAddress?: (remoteAddress: string | undefined) => boolean;
  /** Exact per-bundle credential for the Docker Desktop TCP hop. */
  readonly requiredProxyAuthorization?: string;
  /** Optional ordinary package policy, resolved exactly once by the caller. */
  readonly packagePolicy?: PackageEgressPolicy;
  /** Required only for strict package mode. */
  readonly packageAuditLogPath?: string;
}

/**
 * Decide which listeners the configuration authorizes and with exactly which
 * options, loading and validating the frozen registry manifest. Fail-closed:
 * manifest and transport-precondition failures throw here.
 */
export function resolveDockerWorkloadEgressListenerOptions(
  options: CreateDockerWorkloadEgressListenersOptions,
): DockerWorkloadEgressSet<MitmProxyOptions, true> | undefined {
  const { workload } = options;
  if (!workload.enabled || workload.networkAccess === 'offline') return undefined;
  const registry = registryEgressListenerOptions(options).options;
  if (workload.networkAccess === 'images') return { networkAccess: 'images', registry };
  requiredListenTarget(options.packageListen, 'package egress');
  return { networkAccess: 'packages', registry, packages: true };
}

/**
 * Construct the listeners the configuration authorizes. The caller owns the
 * lifecycle: nothing here binds a socket or starts a proxy.
 */
export function createDockerWorkloadEgressListeners(
  options: CreateDockerWorkloadEgressListenersOptions,
): DockerWorkloadEgressSet<RegistryEgressAuthority, PackageEgressAuthority> | undefined {
  const { workload } = options;
  if (!workload.enabled || workload.networkAccess === 'offline') return undefined;
  const resolvedRegistry = registryEgressListenerOptions(options);
  const registryListener = createMitmProxy(resolvedRegistry.options);
  const registry: RegistryEgressAuthority = {
    listener: registryListener,
    snapshot: () => ({
      attempts: resolvedRegistry.session.attempts,
      totalBytes: resolvedRegistry.session.totalBytes,
      activeRequests: resolvedRegistry.session.activeRequests,
    }),
  };
  if (workload.networkAccess === 'images') return { networkAccess: 'images', registry };
  if (options.packageAuditLogPath === undefined) {
    throw new Error('package egress is enabled but no per-bundle audit path was supplied');
  }
  const packageListen = requiredListenTarget(options.packageListen, 'package egress');
  const packageListener = createPackageEgressProxy({
    ca: options.ca,
    auditLogPath: options.packageAuditLogPath,
    ...(options.packagePolicy === undefined ? {} : { policy: options.packagePolicy }),
    ...(options.allowRemoteAddress === undefined ? {} : { allowRemoteAddress: options.allowRemoteAddress }),
    ...(options.requiredProxyAuthorization === undefined
      ? {}
      : { requiredProxyAuthorization: options.requiredProxyAuthorization }),
  });
  const packages: PackageEgressAuthority = {
    listener: packageListener,
    listenTarget: packageListen,
    snapshot: () => packageListener.snapshot,
  };
  return { networkAccess: 'packages', registry, packages };
}

function registryEgressListenerOptions(options: CreateDockerWorkloadEgressListenersOptions): ResolvedRegistryEgress {
  const transport = options.outboundTransport;
  // Written fail-closed so a transport that omits the capability is refused.
  if (transport.addressGuard !== 'local-resolver') {
    throw new Error(
      'registry egress requires an outbound transport that resolves and screens destination addresses locally ' +
        `(got addressGuard "${transport.addressGuard}"): it follows registry-chosen redirect authorities that no other hop can re-derive`,
    );
  }
  const guard: RegistryEgressGuard = createRegistryEgressGuard({
    mode: 'public-registry',
    manifestPath: getFrozenRegistryEgressManifestPath(),
  });
  return {
    session: guard.session,
    options: {
      ...listenOptions(options.registryListen, 'registry egress'),
      ca: options.ca,
      providers: [],
      outboundTransport: transport,
      registryEgress: {
        guard,
      },
      ...(options.allowRemoteAddress === undefined ? {} : { allowRemoteAddress: options.allowRemoteAddress }),
      ...(options.requiredProxyAuthorization === undefined
        ? {}
        : { requiredProxyAuthorization: options.requiredProxyAuthorization }),
    },
  };
}

function listenOptions(
  target: DockerWorkloadEgressListenTarget | undefined,
  label: string,
): Pick<MitmProxyOptions, 'socketPath' | 'listenPort'> {
  target = requiredListenTarget(target, label);
  return target.socketPath !== undefined ? { socketPath: target.socketPath } : { listenPort: target.listenPort };
}

function requiredListenTarget(
  target: DockerWorkloadEgressListenTarget | undefined,
  label: string,
): DockerWorkloadEgressListenTarget {
  if (target === undefined) throw new Error(`${label} is enabled but no listen target was supplied`);
  return target;
}
