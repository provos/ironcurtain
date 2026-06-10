/**
 * Network topology selection and host-only network helpers.
 *
 * Docker Agent Mode reaches host-side proxies through one of three
 * topologies (see docs/designs/apple-container-runtime.md §2):
 *
 *  - `uds`          — Linux Docker: `--network=none` + bind-mounted Unix
 *                     domain sockets.
 *  - `tcp-sidecar`  — macOS Docker Desktop: `--internal` bridge network +
 *                     socat sidecar forwarding exactly the two proxy ports.
 *  - `tcp-hostonly` — Apple `container`: a host-only (`--internal`) vmnet
 *                     network. No sidecar: the host is natively reachable
 *                     at the network's gateway IP, and internet egress is
 *                     blocked at the network layer.
 *
 * For `tcp-hostonly`, the vmnet bridge interface does not exist on the
 * host until the first container attaches, so proxies cannot bind the
 * gateway IP at startup. They bind 0.0.0.0 instead, guarded by a
 * source-address predicate (`makeSourceAddressGuard`) that only admits
 * connections from the bundle's own subnet (plus loopback) — equivalent
 * port-level exposure to the sidecar's two forwarded ports.
 */

import type { ContainerRuntime } from './types.js';
import type { ContainerRuntimeKind } from './container-runtime.js';
import { useTcpTransport } from './platform.js';
import { isExecError } from '../utils/exec-error.js';
import * as logger from '../logger.js';

export type NetworkTopology = 'uds' | 'tcp-sidecar' | 'tcp-hostonly';

/**
 * Resolves the proxy-transport topology for a runtime kind on the current
 * platform. Apple `container` always uses the host-only topology; Docker
 * keeps its existing platform split (`dockerUsesTcp` is injectable for
 * tests, defaulting to the live platform check).
 */
export function resolveNetworkTopology(
  kind: ContainerRuntimeKind,
  dockerUsesTcp: boolean = useTcpTransport(),
): NetworkTopology {
  if (kind === 'apple-container') return 'tcp-hostonly';
  return dockerUsesTcp ? 'tcp-sidecar' : 'uds';
}

/** A created host-only network plus the addresses derived from it. */
export interface HostOnlyNetwork {
  readonly name: string;
  /** IPv4 subnet in CIDR form, e.g. "192.168.201.0/24". */
  readonly subnet: string;
  /** Host-side gateway address (first host address of the subnet). */
  readonly gateway: string;
}

/**
 * Candidate /24 subnets for per-bundle host-only networks. Chosen from
 * the upper 192.168.0.0/16 range to stay clear of the runtime's own
 * default network (192.168.64.0/24) and the common home-router defaults
 * (192.168.0/1.x). Concurrent bundles each consume one entry; the
 * runtime rejects overlapping subnets, which is what drives the walk.
 */
export const HOST_ONLY_SUBNET_POOL: readonly string[] = Array.from({ length: 16 }, (_, i) => `192.168.${200 + i}.0/24`);

/** Derives the gateway (.1) address from a /24 subnet in CIDR form. */
export function gatewayForSubnet(subnet: string): string {
  const base = subnet.split('/')[0];
  const octets = base.split('.');
  if (octets.length !== 4) {
    throw new Error(`Cannot derive gateway from subnet: ${subnet}`);
  }
  return `${octets[0]}.${octets[1]}.${octets[2]}.1`;
}

/**
 * Creates a per-bundle host-only network, walking the subnet pool on
 * overlap conflicts (vmnet rejects overlapping subnets with an
 * "overlaps an existing network" error; concurrent bundles each take a
 * distinct subnet). The walk starts at an offset derived from the
 * network name so concurrent bundles usually succeed on their first try
 * instead of racing for pool slot 0.
 *
 * The runtime tolerates re-creating an existing network name
 * (`createNetwork` swallows "already exists"), which covers the
 * stale-network-from-crashed-session case: the network is reused and the
 * gateway derived from the subnet we would have assigned. Since names
 * embed the bundle short-id and subnets are derived deterministically
 * from the name, a reused network has the expected subnet.
 */
export async function createHostOnlyNetwork(docker: ContainerRuntime, name: string): Promise<HostOnlyNetwork> {
  // Defensive stale cleanup: a crashed previous session can leave the
  // deterministically-named network behind. removeNetwork swallows
  // errors (including "still has attached containers"), and createNetwork
  // swallows "already exists", so the reuse path below stays viable.
  await docker.removeNetwork(name);

  const offset = hashToOffset(name, HOST_ONLY_SUBNET_POOL.length);
  let lastError: unknown;

  for (let i = 0; i < HOST_ONLY_SUBNET_POOL.length; i++) {
    const subnet = HOST_ONLY_SUBNET_POOL[(offset + i) % HOST_ONLY_SUBNET_POOL.length];
    try {
      await docker.createNetwork(name, { internal: true, subnet });
      // When the create reused a surviving stale network, its actual
      // subnet may differ from the one we just tried — trust the
      // runtime's view of the gateway over the derived value.
      const gateway = (await docker.getNetworkGateway?.(name)) ?? gatewayForSubnet(subnet);
      return { name, subnet, gateway };
    } catch (err) {
      if (isExecError(err) && err.stderr.includes('overlaps an existing network')) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  throw new Error(
    `No free host-only subnet available for network ${name} ` +
      `(tried ${HOST_ONLY_SUBNET_POOL.length} candidates in 192.168.200-215.0/24). ` +
      `Remove stale networks with \`container network list\` / \`container network delete\`.`,
    { cause: lastError },
  );
}

/**
 * Builds a connection-source predicate admitting only the given /24
 * subnet plus loopback. Used by the proxies when listening on 0.0.0.0
 * in `tcp-hostonly` mode so the agent VM can connect but other LAN/host
 * processes cannot (the code-mode proxy is unauthenticated; see module
 * doc). Handles IPv4-mapped IPv6 forms (`::ffff:a.b.c.d`).
 */
export function makeSourceAddressGuard(subnet: string): (remoteAddress: string | undefined) => boolean {
  const prefix = subnet.split('/')[0].split('.').slice(0, 3).join('.') + '.';
  return (remoteAddress: string | undefined): boolean => {
    if (!remoteAddress) return false;
    const addr = remoteAddress.startsWith('::ffff:') ? remoteAddress.slice('::ffff:'.length) : remoteAddress;
    if (addr === '127.0.0.1' || addr === '::1') return true;
    const allowed = addr.startsWith(prefix);
    if (!allowed) {
      logger.warn(`[network-topology] rejected connection from outside the bundle subnet: ${remoteAddress}`);
    }
    return allowed;
  };
}

/** Small deterministic string hash → pool offset. */
function hashToOffset(value: string, modulo: number): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash % modulo;
}
