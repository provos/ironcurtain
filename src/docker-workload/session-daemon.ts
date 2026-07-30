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
 *  - which backend the topology is qualified on (Apple `container` only),
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
  type AppleVmDaemonReadiness,
} from './apple-vm-daemon.js';
import type { DockerWorkloadBundleHandle } from './infrastructure.js';

/**
 * Readiness ceiling for the in-VM daemon.
 *
 * Mirrors `maxima.daemonReadinessMs` in the frozen performance budget
 * `test/docker-workload/performance-budget.apple-rootless-vfs-arm64.json`.
 * That artifact is deliberately NOT read here: it lives in the test tree, which
 * the published package does not ship (`package.json` `files`), so a runtime
 * read would ENOENT in an installed copy. A freeze-guard test asserts this
 * constant still equals the frozen budget's value.
 */
export const APPLE_VM_DAEMON_READINESS_TIMEOUT_MS = 90_000;

/**
 * The same-VM topology is implementation-qualified on Apple `container` only:
 * the daemon needs a per-session VM to live in. Fail closed rather than run an
 * agent that believes it has a nested daemon it does not have.
 */
export function assertNestedDaemonBackendQualified(runtimeKind: ContainerRuntimeKind): void {
  if (runtimeKind === 'apple-container') return;
  throw new Error(
    `secure nested Docker is not implementation-qualified on the ${runtimeKind} backend: ` +
      'the nested Docker daemon runs inside the agent VM, which only the apple-container runtime provides',
  );
}

/**
 * The admitted bundle whose agent container IS the nested-daemon component, or
 * `undefined` for an ordinary session. Returning the handle rather than a
 * boolean keeps the "daemon wiring applies" decision and the handle the wiring
 * needs from ever disagreeing.
 *
 * @throws when a bundle was admitted on a backend the topology is not qualified
 * on — a create that silently produced no daemon would be the worse outcome.
 */
export function resolveNestedDaemonBundle(
  dockerWorkload: DockerWorkloadBundleHandle | undefined,
  runtimeKind: ContainerRuntimeKind,
): DockerWorkloadBundleHandle | undefined {
  if (dockerWorkload === undefined) return undefined;
  assertNestedDaemonBackendQualified(runtimeKind);
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

export interface StartAppleVmNestedDaemonOptions {
  readonly runtime: ContainerRuntime;
  /** The already-started agent container, i.e. the VM the daemon runs inside. */
  readonly containerId: string;
  readonly nestedDaemon: DockerWorkloadBundleHandle;
  /** Defaults to the frozen {@link APPLE_VM_DAEMON_READINESS_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

/**
 * §8.2 steps 4–5 for the same-VM topology: bootstrap the rootless daemon inside
 * the started agent VM, adjudicate its `docker info`, and record the
 * `daemon-ready` evidence against the lease.
 *
 * Any failure propagates unchanged. There is no degraded mode in which the
 * agent runs against an unverified daemon, so the caller's abort-and-teardown
 * path is the only outcome of a rejected or unreachable daemon.
 */
export async function startAppleVmNestedDaemon(
  options: StartAppleVmNestedDaemonOptions,
): Promise<AppleVmDaemonReadiness> {
  const exec = appleVmDaemonExecFor(options.runtime, options.containerId);
  await bootstrapAppleVmDaemon(exec);
  const readiness = await waitForAppleVmDaemonReady(exec, {
    timeoutMs: options.timeoutMs ?? APPLE_VM_DAEMON_READINESS_TIMEOUT_MS,
    pollIntervalMs: options.pollIntervalMs,
  });
  options.nestedDaemon.recordDaemonReady(readiness);
  return readiness;
}
