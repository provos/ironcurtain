/**
 * Platform detection for Docker transport selection.
 *
 * Docker Desktop on macOS uses VirtioFS for bind mounts, which does
 * not support Unix domain sockets. On macOS, we use TCP transport
 * instead so the container can reach host-side proxies via
 * `host.docker.internal`.
 */

import { platform } from 'node:os';

/**
 * Returns true when the Docker session should use TCP transport
 * instead of Unix domain sockets. Currently true on macOS where
 * Docker Desktop's VirtioFS does not support UDS in bind mounts.
 */
export function useTcpTransport(): boolean {
  return platform() === 'darwin';
}

/**
 * Returns a per-session Docker network name for the internal (no-egress)
 * bridge used in TCP mode. Each session gets its own network to avoid
 * conflicts when multiple sessions run concurrently.
 */
export function getInternalNetworkName(shortId: string): string {
  return `ironcurtain-${shortId}`;
}
