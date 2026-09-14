import { chmodSync, existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { connect, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createContainerRuntime } from '../../src/docker/container-runtime.js';
import { DOCKER_AGENT_VOLUME_SHADOW } from '../../src/docker/docker-agent-volume-shadow.js';
import { bindDockerEndpointExec, resolveDockerEndpoint } from '../../src/docker/docker-endpoint.js';
import { ensureDockerDesktopRelayImage } from '../../src/docker/docker-infrastructure.js';
import { defaultExecFile } from '../../src/docker/docker-manager.js';
import {
  ironCurtainInternalSubnetHostAddress,
  selectIronCurtainInternalSubnet,
} from '../../src/docker/docker-resource-lifecycle.js';
import {
  createDesktopRelayExposure,
  type DesktopRelayCreateAuthority,
} from '../../src/docker-workload/desktop-relay.js';

const enabled = process.env.DESKTOP_RELAY_UDS_INTEGRATION === '1';
const AUTHORIZATION = 'Basic aXJvbmN1cnRhaW46QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQQ==';
const CLIENT_IMAGE = 'ironcurtain-claude-code:latest';

/** Model the host policy listener's tracked-stream revocation on stop. */
async function listenPolicy(path: string, response: string) {
  const sockets = new Set<Socket>();
  const requests: string[] = [];
  let acknowledgedStreams = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => sockets.delete(socket));
    socket.setTimeout(15_000, () => socket.destroy());
    let header = '';
    const read = (chunk: Buffer) => {
      header += chunk.toString('utf8');
      if (header.length > 65_536) return socket.destroy();
      if (!header.includes('\r\n\r\n')) return;
      socket.off('data', read);
      requests.push(header);
      if (!header.includes(`\r\nProxy-Authorization: ${AUTHORIZATION}\r\n`)) return socket.destroy();
      if (header.startsWith('GET http://fixture.invalid/stream ')) {
        let acknowledgement = '';
        const acknowledge = (chunk: Buffer) => {
          acknowledgement += chunk.toString('utf8');
          if (acknowledgement === 'stream-observed\n') {
            acknowledgedStreams += 1;
            socket.off('data', acknowledge);
          } else if (acknowledgement.length > 32) socket.destroy();
        };
        socket.on('data', acknowledge);
        socket.write(response);
      } else socket.end(response);
    };
    socket.on('data', read);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  chmodSync(path, 0o600);
  return {
    requests,
    get acknowledgedStreams(): number {
      return acknowledgedStreams;
    },
    async stop(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      if (server.listening) {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
    },
  };
}

function requestReplacementDirectly(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let response = '';
    socket.setTimeout(5_000, () => socket.destroy(new Error('replacement policy socket timed out')));
    socket.once('connect', () =>
      socket.write(
        `GET http://fixture.invalid/request HTTP/1.1\r\nHost: fixture.invalid\r\nProxy-Authorization: ${AUTHORIZATION}\r\n\r\n`,
      ),
    );
    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString('utf8');
    });
    socket.once('error', reject);
    socket.once('end', () => resolve(response));
  });
}

// The existing prepared agent image supplies Node. The client itself has no
// host mounts, runtime socket, capabilities, published port or uplink network.
const CLIENT_REQUEST = `
const net = require('node:net');
const socket = net.connect({ host: process.argv[1], port: Number(process.argv[2]) });
const result = { data: '', error: null };
let acknowledged = false;
socket.setTimeout(10000, () => socket.destroy(new Error('client stream timed out')));
socket.once('connect', () => socket.write('GET http://fixture.invalid/' + process.argv[3] + ' HTTP/1.1\\r\\nHost: fixture.invalid\\r\\nConnection: close\\r\\n\\r\\n'));
socket.on('data', chunk => {
  result.data += chunk.toString('utf8');
  if (process.argv[3] === 'stream' && !acknowledged && result.data.endsWith('\\n')) {
    acknowledged = true;
    socket.write('stream-observed\\n');
  }
});
socket.once('error', error => { result.error = error.message; });
socket.once('close', () => process.stdout.write(JSON.stringify(result)));
`;

describe.skipIf(!enabled)('Linux Docker fixed relay with a mounted policy socket', () => {
  it('revokes streams and fails closed across socket removal and replacement, then removes exact resources', async () => {
    // Selected qualification fails on missing prerequisites instead of skipping.
    expect(process.platform).toBe('linux');
    const uid = process.getuid!();
    const gid = process.getgid!();
    expect(uid).toBeGreaterThan(0);
    const endpoint = await resolveDockerEndpoint(defaultExecFile);
    const exec = bindDockerEndpointExec(endpoint, defaultExecFile);
    const runtime = createContainerRuntime('docker', endpoint);
    const docker = (args: readonly string[], timeout = 30_000) =>
      exec('docker', args, { timeout, maxBuffer: 1024 * 1024 });
    const listExactResource = async (kind: 'container' | 'network', id: string): Promise<string> =>
      (
        await docker(
          kind === 'container'
            ? ['container', 'ls', '-aq', '--no-trunc', '--filter', `id=${id}`]
            : ['network', 'ls', '--filter', `id=${id}`, '--format', '{{.ID}}'],
        )
      ).stdout.trim();
    const clientImage = await runtime.inspectImage(CLIENT_IMAGE);
    if (clientImage === undefined) throw new Error(`Build the required test client image first: ${CLIENT_IMAGE}`);
    const imageId = await ensureDockerDesktopRelayImage(runtime);
    const suffix = `${process.pid}-${randomBytes(6).toString('hex')}`;
    const networkName = `ic-uds-relay-net-${suffix}`;
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ic-relay-')));
    const socketPath = join(directory, 'policy.sock');
    const containers: string[] = [];
    const networks: string[] = [];
    const failures: unknown[] = [];
    let policy: Awaited<ReturnType<typeof listenPolicy>> | undefined;
    let replacement: Awaited<ReturnType<typeof listenPolicy>> | undefined;
    const createAuthority: DesktopRelayCreateAuthority = async (spec, create) => {
      const result = await create(spec.requestedName, spec.baseLabels ?? {});
      (spec.kind === 'container' ? containers : networks).push(result.id);
      await spec.adjudicateObserved?.(result.id);
      return result;
    };
    try {
      policy = await listenPolicy(socketPath, `original-policy-${suffix}\n`);
      const originalInode = lstatSync(socketPath).ino;
      const subnet = await selectIronCurtainInternalSubnet(runtime, networkName);
      const relayAddress = ironCurtainInternalSubnetHostAddress(subnet, 2);
      const relay = await createDesktopRelayExposure(exec, {
        bundleId: `ic-uds-${suffix}`,
        mode: 'images',
        imageId,
        isolatedNetworkName: networkName,
        ipv4Subnet: subnet,
        // Exercise Docker's canonicalization on every run, not only when a
        // randomly generated hextet happens to start with zero.
        ipv6Subnet: `fd00:001c:${randomBytes(2).toString('hex')}:${randomBytes(2).toString('hex')}::/64`,
        requiredProxyAuthorization: AUTHORIZATION,
        registry: {
          containerName: `ic-uds-relay-${suffix}`,
          relayIpv4Address: relayAddress,
          listenPort: 18_081,
          upstream: { kind: 'unix', socketPath, runtimeUid: uid, runtimeGid: gid },
        },
        createOuterResource: createAuthority,
      });
      const [observed] = JSON.parse((await docker(['inspect', relay.registry.containerId])).stdout) as {
        Config: { User: string };
        HostConfig: { ExtraHosts: unknown; PortBindings: unknown };
        Mounts: unknown[];
        NetworkSettings: { Networks: Record<string, unknown> };
      }[];
      // Keep the live boundary expectation independent of the create builder.
      expect(observed.Config.User).toBe(`${uid}:${gid}`);
      expect(observed.HostConfig.ExtraHosts ?? []).toEqual([]);
      expect(observed.HostConfig.PortBindings ?? {}).toEqual({});
      expect(Object.keys(observed.NetworkSettings.Networks)).toEqual([networkName]);
      expect(observed.Mounts).toEqual([
        expect.objectContaining({
          Type: 'bind',
          Source: socketPath,
          Destination: '/run/ironcurtain-upstream.sock',
          RW: false,
          Propagation: 'rprivate',
        }),
      ]);
      const client = await docker([
        'create',
        '--name',
        `ic-uds-client-${suffix}`,
        '--network',
        networkName,
        '--read-only',
        '--tmpfs',
        DOCKER_AGENT_VOLUME_SHADOW.specification,
        '--cap-drop=ALL',
        '--security-opt',
        'no-new-privileges:true',
        '--user',
        `${uid}:${gid}`,
        '--memory',
        '64m',
        '--cpus',
        '0.25',
        '--pids-limit',
        '16',
        '--entrypoint',
        'node',
        clientImage.id,
        '-e',
        'setInterval(() => {}, 1000)',
      ]);
      const clientId = client.stdout.trim();
      expect(clientId).toMatch(/^[a-f0-9]{64}$/u);
      containers.push(clientId);
      const [observedClient] = JSON.parse((await docker(['inspect', clientId])).stdout) as {
        HostConfig: { Tmpfs: Record<string, string> };
        Mounts: { Type: string }[];
      }[];
      // The prepared image inherits a Docker data volume. The test client must
      // shadow it just like a production agent, so exact container cleanup does
      // not leave an anonymous volume on the host daemon.
      expect(observedClient.HostConfig.Tmpfs).toEqual({
        [DOCKER_AGENT_VOLUME_SHADOW.target]: DOCKER_AGENT_VOLUME_SHADOW.options,
      });
      expect(observedClient.Mounts.filter((mount) => mount.Type === 'volume')).toEqual([]);
      await docker(['start', clientId]);
      const request = async (path = 'request'): Promise<{ data: string; error: string | null }> => {
        const answer = await docker(
          ['exec', clientId, 'node', '-e', CLIENT_REQUEST, relayAddress, '18081', path],
          15_000,
        );
        return JSON.parse(answer.stdout) as { data: string; error: string | null };
      };
      expect(await request()).toEqual({ data: `original-policy-${suffix}\n`, error: null });
      expect(policy.requests).toHaveLength(1);

      const active = request('stream');
      // Observe the host-side request before revoking its live connection.
      void active.catch(() => undefined);
      await expect.poll(() => policy!.acknowledgedStreams, { timeout: 8_000 }).toBe(1);
      await policy.stop();
      const interrupted = await active;
      expect(interrupted.data).toBe(`original-policy-${suffix}\n`);
      expect(interrupted.error).not.toBe('client stream timed out');
      expect(existsSync(socketPath)).toBe(false);
      expect((await request()).data).toBe('');

      replacement = await listenPolicy(socketPath, `replacement-policy-${suffix}\n`);
      expect(lstatSync(socketPath).ino).not.toBe(originalInode);
      expect(await requestReplacementDirectly(socketPath)).toBe(`replacement-policy-${suffix}\n`);
      expect(replacement.requests).toHaveLength(1);
      // The relay still holds the original mounted inode. It must not follow
      // the new host pathname into a replacement authority.
      expect((await request()).data).toBe('');
      expect(replacement.requests).toHaveLength(1);
      expect(
        (await docker(['inspect', '--format', '{{.State.Running}}', relay.registry.containerId])).stdout.trim(),
      ).toBe('true');
    } catch (error) {
      failures.push(error);
    } finally {
      const attempt = async (operation: () => Promise<unknown>) => {
        try {
          await operation();
        } catch (error) {
          failures.push(error);
        }
      };
      await attempt(async () => {
        await policy?.stop();
      });
      await attempt(async () => {
        await replacement?.stop();
      });
      // Failed creation may already have rolled back an observed resource.
      // Inventory failures remain errors, and every recorded ID is checked
      // again below to prove exact absence after cleanup.
      for (const id of containers.reverse())
        await attempt(async () => {
          if (await listExactResource('container', id)) await docker(['container', 'rm', '--force', '--volumes', id]);
        });
      for (const id of networks.reverse())
        await attempt(async () => {
          if (await listExactResource('network', id)) await docker(['network', 'rm', id]);
        });
      for (const id of containers)
        await attempt(async () => {
          expect(await listExactResource('container', id)).toBe('');
        });
      for (const id of networks)
        await attempt(async () => {
          expect(await listExactResource('network', id)).toBe('');
        });
      await attempt(async () => {
        rmSync(directory, { recursive: true, force: true });
      });
    }
    if (failures.length > 0) throw new AggregateError(failures, 'UDS relay lifecycle or exact cleanup failed');
  }, 180_000);
});
