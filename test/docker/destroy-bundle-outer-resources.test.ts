/**
 * Unit coverage for the shared bundle teardown helper used by
 * destroyDockerInfrastructure, the assembleDockerInfrastructure failure path,
 * and the PTY session finally. It must tear the LEDGERED resources down through
 * the lease AND sweep any non-ledgered sidecar/network (belt-and-braces) so a
 * non-uds topology cannot leak while the lease's cleanup proof reports the
 * ledgered set clean.
 */

import { describe, expect, it } from 'vitest';
import { destroyBundleOuterResources } from '../../src/docker/container-lifecycle.js';
import {
  admitDockerWorkloadBundle,
  type DockerWorkloadBundleHandle,
} from '../../src/docker-workload/infrastructure.js';
import { loadDockerWorkloadLease } from '../../src/docker-workload/bundle-lease.js';
import { join } from 'node:path';
import {
  ADMISSION_BINDINGS,
  ADMISSION_CONFIG_HASH,
  WATCHDOG_ENTRYPOINT_PATH,
  WATCHDOG_TEMPLATE_PATH,
  createEventRuntime,
  createFakeClock,
  createFakeSupervisor,
  useDockerWorkloadHome,
  type EventRuntime,
  type FakeClock,
  type FakeSupervisor,
} from '../docker-workload/helpers/infrastructure-harness.js';

const getHome = useDockerWorkloadHome();

/** Admit a bundle and ledger+observe+activate one agent container (uds-style, single outer create). */
async function admitWithAgent(
  clock: FakeClock,
  runtime: EventRuntime,
  supervisor: FakeSupervisor,
): Promise<{ handle: DockerWorkloadBundleHandle; agentId: string }> {
  const handle = await admitDockerWorkloadBundle({
    runtime: runtime.runtime,
    runtimeKind: 'docker',
    bundleId: 'bundle-destroy-001',
    workspaceRoot: join(getHome(), 'workspace'),
    bindings: ADMISSION_BINDINGS,
    configHash: ADMISSION_CONFIG_HASH,
    watchdogPolicyTemplatePath: WATCHDOG_TEMPLATE_PATH,
    watchdogSupervisorEntrypointPath: WATCHDOG_ENTRYPOINT_PATH,
    clock: clock.clock,
    sleep: clock.sleep,
    pidAlive: () => true,
    supervisor,
    startHeartbeat: false,
  });
  await handle.attestWatchdog();
  const grant = handle.requestOuterResource('container', 'agent');
  const agentId = await runtime.runtime.create({
    name: grant.requestedName,
    image: 'agent',
    mounts: [],
    network: 'none',
    env: {},
    command: [],
    labels: grant.labels,
  });
  grant.observed(agentId);
  handle.activate();
  return { handle, agentId };
}

describe('destroyBundleOuterResources', () => {
  it('tears down the ledgered agent through the lease AND sweeps the non-ledgered sidecar + network', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: clock.clock, closeLeaseOnStop: true });
    const { handle, agentId } = await admitWithAgent(clock, runtime, supervisor);

    // tcp-sidecar leftovers the lease never ledgered (foreign ownership label).
    runtime.containers.push({
      id: 'sidecar-id',
      name: 'ic-sidecar',
      created: '2026-07-20T12:00:00Z',
      running: true,
      labels: {},
    });
    runtime.networks.push({
      id: 'net-id',
      name: 'ic-internal',
      created: '2026-07-20T12:00:00Z',
      labels: {},
      subnets: [],
      containerIds: [],
    });

    await destroyBundleOuterResources({
      docker: runtime.runtime,
      dockerWorkload: handle,
      containerId: agentId,
      sidecarContainerId: 'sidecar-id',
      networkName: 'net-id',
      bundleId: 'bundle-destroy-001',
      context: 'test',
    });

    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('closed');
    expect(runtime.containers.map((container) => container.id)).not.toContain(agentId);
    expect(runtime.containers.map((container) => container.id)).not.toContain('sidecar-id');
    expect(runtime.networks.map((network) => network.id)).not.toContain('net-id');
    expect(supervisor.calls.stopRequested).toBe(1);
  });

  it('sweeps every outer resource for an ordinary (non-workload) bundle', async () => {
    const runtime = createEventRuntime();
    const agentId = await runtime.runtime.create({
      name: 'ic-agent',
      image: 'agent',
      mounts: [],
      network: 'none',
      env: {},
      command: [],
    });
    const sidecarId = await runtime.runtime.create({
      name: 'ic-sidecar',
      image: 'socat',
      mounts: [],
      network: 'bridge',
      env: {},
      command: [],
    });
    await runtime.runtime.createNetwork('ic-internal');
    const networkId = runtime.networks.find((network) => network.name === 'ic-internal')?.id ?? '';

    await destroyBundleOuterResources({
      docker: runtime.runtime,
      dockerWorkload: undefined,
      containerId: agentId,
      sidecarContainerId: sidecarId,
      networkName: networkId,
      bundleId: 'bundle-destroy-002',
      context: 'test',
    });

    expect(runtime.containers).toHaveLength(0);
    expect(runtime.networks).toHaveLength(0);
  });
});
