import { describe, expect, it } from 'vitest';
import {
  PRIVATE_DOCKER_HOST,
  PRIVATE_DOCKER_WORKLOAD_NETWORK,
  createPrivateDockerClient,
  createPrivateDockerWorkloadNetwork,
  waitForPrivateDockerDaemonReady,
} from '../../src/docker-workload/private-docker.js';
import type { ContainerRuntime, DockerExecResult } from '../../src/docker/types.js';

const NETWORK_ID = '1'.repeat(64);

describe('backend-neutral private Docker client', () => {
  it('binds readiness and managed-network commands to one client, socket, container, and user', async () => {
    const commands: (readonly string[])[] = [];
    const runtime: Pick<ContainerRuntime, 'exec'> = {
      async exec(containerId, command, timeoutMs, user): Promise<DockerExecResult> {
        expect(containerId).toBe('daemon-sidecar');
        expect(timeoutMs).toBeGreaterThan(0);
        expect(user).toBe('rootless');
        commands.push([...command]);
        const args = command.slice(3);
        if (args[0] === 'info') {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              Driver: 'vfs',
              SecurityOptions: ['name=rootless'],
              ServerVersion: '29.2.1',
            }),
            stderr: '',
          };
        }
        if (args[0] === 'network' && args[1] === 'create') {
          return { exitCode: 0, stdout: `${NETWORK_ID}\n`, stderr: '' };
        }
        if (args[0] === 'network' && args[1] === 'inspect') {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              Id: NETWORK_ID,
              Name: PRIVATE_DOCKER_WORKLOAD_NETWORK,
              Driver: 'bridge',
              Scope: 'local',
              Internal: true,
              Labels: { 'com.ironcurtain.managed-workload': 'true' },
              Containers: {},
            }),
            stderr: '',
          };
        }
        throw new Error(`unexpected command: ${command.join(' ')}`);
      },
    };
    const client = createPrivateDockerClient({
      runtime,
      containerId: 'daemon-sidecar',
      dockerCommand: '/pinned/docker',
      dockerHost: PRIVATE_DOCKER_HOST,
      execUser: 'rootless',
      defaultTimeoutMs: 30_000,
    });

    await expect(waitForPrivateDockerDaemonReady(client, { timeoutMs: 1_000 })).resolves.toMatchObject({
      driver: 'vfs',
      securityOptions: ['name=rootless'],
      serverVersion: '29.2.1',
    });
    await expect(createPrivateDockerWorkloadNetwork(client)).resolves.toEqual({
      name: PRIVATE_DOCKER_WORKLOAD_NETWORK,
      id: NETWORK_ID,
    });
    expect(commands).toHaveLength(3);
    expect(commands.every((command) => command[0] === '/pinned/docker')).toBe(true);
    expect(commands.every((command) => command[1] === '--host' && command[2] === PRIVATE_DOCKER_HOST)).toBe(true);
  });
});
