import { describe, expect, it } from 'vitest';
import { defaultExecFile } from '../../src/docker/docker-manager.js';
import {
  createDesktopRelay,
  removeDesktopRelay,
  type DesktopRelayConfig,
  type DesktopRelayResources,
} from '../../src/docker-workload/desktop-relay.js';
import { isRuntimeAvailable } from '../helpers/container-runtimes.js';

const enabled = process.env.DESKTOP_RELAY_INTEGRATION === '1';
const ready = enabled && isRuntimeAvailable('docker');

async function docker(args: readonly string[], timeout = 30_000): Promise<{ stdout: string; stderr: string }> {
  return defaultExecFile('docker', args, { timeout, maxBuffer: 10 * 1024 * 1024 });
}

async function bestEffort(args: readonly string[]): Promise<void> {
  try {
    await docker(args);
  } catch {
    // Exact post-test absence checks adjudicate cleanup.
  }
}

async function expectDockerFailure(args: readonly string[]): Promise<void> {
  await expect(docker(args, 15_000)).rejects.toThrow();
}

describe.skipIf(!ready)('Docker Desktop fixed relay', () => {
  it('forwards only across the fixed tuple and fails closed after relay loss', async () => {
    const suffix = `${process.pid}-${Date.now().toString(36)}`;
    const bundleId = `ic-bundle-${suffix}`;
    const uplinkNetworkName = `ic-uplink-${suffix}`;
    const isolatedNetworkName = `ic-isolated-${suffix}`;
    const targetName = `ic-target-${suffix}`;
    let targetId: string | undefined;
    let uplinkNetworkId: string | undefined;
    let relay: DesktopRelayResources | undefined;

    const image = await docker(['image', 'inspect', '--format', '{{.Id}}', 'ironcurtain-fixed-relay:phase0f-spike']);
    const imageId = image.stdout.trim();
    const config: DesktopRelayConfig = {
      bundleId,
      containerName: `ic-relay-${suffix}`,
      isolatedNetworkName,
      uplinkNetworkName,
      imageId,
      ipv4Subnet: '172.31.44.0/24',
      ipv6Subnet: 'fd00:1c:44::/64',
      relayIpv4Address: '172.31.44.2',
      listenPort: 8443,
      targetIpv4Address: '172.31.45.2',
      targetPort: 9443,
    };

    try {
      const uplink = await docker([
        'network',
        'create',
        '--subnet',
        '172.31.45.0/24',
        '--label',
        `com.ironcurtain.docker-workload.bundle=${bundleId}`,
        uplinkNetworkName,
      ]);
      uplinkNetworkId = uplink.stdout.trim();
      const target = await docker([
        'container',
        'create',
        '--name',
        targetName,
        '--network',
        uplinkNetworkName,
        '--ip',
        config.targetIpv4Address,
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt',
        'no-new-privileges:true',
        '--user',
        '65532:65532',
        '--memory',
        '32m',
        '--cpus',
        '0.25',
        '--pids-limit',
        '32',
        '--label',
        `com.ironcurtain.docker-workload.bundle=${bundleId}`,
        'alpine/socat:latest',
        'TCP4-LISTEN:9443,fork,reuseaddr',
        'SYSTEM:/bin/echo relay-fixed-target',
      ]);
      targetId = target.stdout.trim();
      await docker(['container', 'start', targetId]);

      relay = await createDesktopRelay(defaultExecFile, config);
      let readyLog = '';
      for (let attempt = 0; attempt < 20; attempt += 1) {
        readyLog = (await docker(['container', 'logs', relay.containerId])).stderr;
        if (readyLog.includes('relay ready')) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(readyLog).toContain('relay ready');

      const request = await docker([
        'run',
        '--rm',
        '--network',
        isolatedNetworkName,
        '--ip',
        '172.31.44.3',
        '--entrypoint',
        '/bin/sh',
        'alpine/socat:latest',
        '-c',
        'sleep 1 | socat -T5 - TCP4:172.31.44.2:8443',
      ]);
      expect(request.stdout).toBe('relay-fixed-target\n');

      await expectDockerFailure([
        'run',
        '--rm',
        '--network',
        uplinkNetworkName,
        '--entrypoint',
        '/bin/sh',
        'alpine/socat:latest',
        '-c',
        'socat -T1 - TCP4:172.31.44.2:8443 </dev/null',
      ]);

      await docker(['container', 'stop', '--time', '1', relay.containerId]);
      await expectDockerFailure([
        'run',
        '--rm',
        '--network',
        isolatedNetworkName,
        '--ip',
        '172.31.44.3',
        '--entrypoint',
        '/bin/sh',
        'alpine/socat:latest',
        '-c',
        "printf 'must-fail' | socat -T1 - TCP4:172.31.44.2:8443",
      ]);
    } finally {
      if (relay !== undefined) {
        try {
          await removeDesktopRelay(defaultExecFile, config, relay);
          relay = undefined;
        } catch {
          await bestEffort(['container', 'rm', '--force', relay.containerId]);
          await bestEffort(['network', 'rm', relay.networkId]);
        }
      }
      if (targetId !== undefined) await bestEffort(['container', 'rm', '--force', targetId]);
      if (uplinkNetworkId !== undefined) await bestEffort(['network', 'rm', uplinkNetworkId]);
    }

    await expectDockerFailure(['container', 'inspect', config.containerName]);
    await expectDockerFailure(['network', 'inspect', isolatedNetworkName]);
    await expectDockerFailure(['container', 'inspect', targetName]);
    await expectDockerFailure(['network', 'inspect', uplinkNetworkName]);
  }, 120_000);
});
