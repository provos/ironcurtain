/**
 * Session-time wiring for the same-VM nested Docker daemon (plan §4.4 variant 1).
 *
 * On the Apple `container` backend the rootless daemon runs INSIDE the agent's
 * own per-session VM, so there is no separate daemon container: the agent
 * container create IS the §8.2 step-4 "daemon component" create, and the in-VM
 * bootstrap happens between that container's start and the agent process. This
 * module owns the three consequences of that topology so neither session mode
 * has to re-derive them:
 *
 *  - which backend currently implements the topology (Apple `container` only),
 *  - the `ContainerRuntime.exec` -> {@link AppleVmDaemonExec} adaptation plus
 *    the bootstrap/adjudicate/record sequence,
 *  - the one environment variable the agent process gets as a result.
 *
 * Everything here is inert for an ordinary session: with no admitted
 * Docker-workload bundle every entry point resolves to "absent" and callers
 * take exactly today's path.
 */

import type { ContainerRuntimeKind } from '../docker/container-runtime.js';
import type { ContainerRuntime } from '../docker/types.js';
import {
  APPLE_VM_DAEMON_DOCKER_HOST,
  bootstrapAppleVmDaemon,
  waitForAppleVmDaemonReady,
  type AppleVmDaemonExec,
} from './apple-vm-daemon.js';
import { provisionAppleVmDockerWorkload, type AppleVmDockerWorkloadBootstrapConfig } from './apple-private-docker.js';
import type { DockerWorkloadBundleHandle } from './infrastructure.js';

/**
 * Readiness ceiling for the in-VM daemon: a generous upper bound on how long
 * rootless dockerd inside a fresh session VM may take to answer `docker info`.
 * Measured boot on the development host is a few seconds, so 90s is slack for a
 * cold or loaded machine, not a target. Exceeding it means the daemon is not
 * coming up and admission fails closed rather than waiting forever.
 *
 * An ordinary reviewed constant — change it by ordinary review.
 */
export const APPLE_VM_DAEMON_READINESS_TIMEOUT_MS = 90_000;

/**
 * The same-VM topology is implemented behind the resolved-variant guard on Apple
 * `container` only: the daemon needs a per-session VM to live in. This is an
 * implementation check, not a qualification or enablement claim.
 */
export function assertNestedDaemonBackendImplemented(runtimeKind: ContainerRuntimeKind): void {
  if (runtimeKind === 'apple-container') return;
  throw new Error(
    `secure nested Docker is not implemented on the ${runtimeKind} backend: ` +
      'the nested Docker daemon runs inside the agent VM, which only the apple-container runtime provides',
  );
}

/**
 * The admitted bundle whose agent container IS the nested-daemon component, or
 * `undefined` for an ordinary session. Returning the handle rather than a
 * boolean keeps the "daemon wiring applies" decision and the handle the wiring
 * needs from ever disagreeing.
 *
 * @throws when a bundle was admitted on a backend where the topology is not
 * implemented — a create that silently produced no daemon would be worse.
 */
export function resolveNestedDaemonBundle(
  dockerWorkload: DockerWorkloadBundleHandle | undefined,
  runtimeKind: ContainerRuntimeKind,
): DockerWorkloadBundleHandle | undefined {
  if (dockerWorkload === undefined) return undefined;
  assertNestedDaemonBackendImplemented(runtimeKind);
  return dockerWorkload;
}

/**
 * §8.2 step 6: the agent reaches the daemon over the VM-local socket, which is
 * never published outside the VM. Empty for every ordinary session, so the
 * container environment is byte-identical to today when the feature is off.
 */
export function nestedDaemonAgentEnv(
  nestedDaemon: DockerWorkloadBundleHandle | undefined,
): Readonly<Record<string, string>> {
  return nestedDaemon === undefined ? {} : { DOCKER_HOST: APPLE_VM_DAEMON_DOCKER_HOST };
}

/** Adapt the container runtime's exec to the daemon module's single command seam. */
export function appleVmDaemonExecFor(runtime: ContainerRuntime, containerId: string): AppleVmDaemonExec {
  return (argv, options) => runtime.exec(containerId, argv, options.timeoutMs, options.user);
}

export interface StartAppleVmDockerWorkloadOptions {
  readonly runtime: ContainerRuntime;
  /** The already-started agent container, i.e. the VM the daemon runs inside. */
  readonly containerId: string;
  readonly nestedDaemon: DockerWorkloadBundleHandle;
  /** Immutable per-lease catalog view mounted into this VM. */
  readonly bootstrap: AppleVmDockerWorkloadBootstrapConfig;
  /** Selects the trusted daemon-only registry proxy bootstrap. */
  readonly registryEgress?: boolean;
  /** Defaults to {@link APPLE_VM_DAEMON_READINESS_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

/**
 * Complete same-VM activation before the host attaches to the PTY: bootstrap and
 * adjudicate the rootless daemon, preflight the pinned Docker client/plugin
 * tuple, provision the selected catalog-authorized agent image, record the
 * transparent observations, and activate the lease.
 *
 * Any failure propagates unchanged. There is no degraded mode in which the
 * agent runs against an incomplete bootstrap, so the caller's
 * abort-and-teardown path is the only outcome of any failure.
 */
export async function startAppleVmDockerWorkload(options: StartAppleVmDockerWorkloadOptions): Promise<void> {
  const exec = appleVmDaemonExecFor(options.runtime, options.containerId);
  await bootstrapAppleVmDaemon(exec, { registryEgress: options.registryEgress });
  const readiness = await waitForAppleVmDaemonReady(exec, {
    timeoutMs: options.timeoutMs ?? APPLE_VM_DAEMON_READINESS_TIMEOUT_MS,
    pollIntervalMs: options.pollIntervalMs,
  });
  options.nestedDaemon.recordDaemonReady(readiness);
  const provisioning = await provisionAppleVmDockerWorkload({
    outerRuntime: options.runtime,
    containerId: options.containerId,
    config: options.bootstrap,
  });
  options.nestedDaemon.recordPrivateDockerBootstrap(provisioning);
  await options.nestedDaemon.activate();
}
