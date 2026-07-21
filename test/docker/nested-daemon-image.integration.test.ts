import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { isRuntimeAvailable } from '../helpers/container-runtimes.js';

const enabled = process.env.NESTED_DAEMON_IMAGE_INTEGRATION === '1';
const ready = enabled && isRuntimeAvailable('docker');
const execFile = promisify(execFileCallback);

describe.skipIf(!ready)('purpose-built nested daemon image metadata', () => {
  it('builds offline and clears stock anonymous volumes and exposed TCP ports', async () => {
    const tag = `localhost/ironcurtain-nested-daemon-itest:${process.pid}`;
    try {
      await execFile(
        'docker',
        [
          'build',
          '--network',
          'none',
          '--pull=false',
          '--tag',
          tag,
          '--file',
          'docker/nested-daemon/Dockerfile',
          'docker/nested-daemon',
        ],
        { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
      );
      const { stdout } = await execFile('docker', ['image', 'inspect', tag], {
        timeout: 10_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const parsed = JSON.parse(stdout) as Array<{
        readonly Config?: {
          readonly User?: string;
          readonly Volumes?: unknown;
          readonly ExposedPorts?: unknown;
          readonly Entrypoint?: readonly string[];
          readonly Env?: readonly string[];
          readonly Labels?: Readonly<Record<string, string>>;
        };
      }>;
      expect(parsed).toHaveLength(1);
      expect(parsed[0].Config).toMatchObject({
        User: 'rootless',
        Entrypoint: ['dockerd-entrypoint.sh'],
        Labels: { 'com.ironcurtain.docker-workload.image-role': 'nested-daemon' },
      });
      expect(parsed[0].Config?.Volumes).toBeUndefined();
      expect(parsed[0].Config?.ExposedPorts).toBeUndefined();
      expect(parsed[0].Config?.Env).toEqual(
        expect.arrayContaining([
          'DOCKER_VERSION=29.2.1',
          'DOCKER_BUILDX_VERSION=0.31.1',
          'DOCKER_COMPOSE_VERSION=5.1.0',
          'DOCKERD_ROOTLESS_ROOTLESSKIT_NET=none',
        ]),
      );
    } finally {
      await execFile('docker', ['image', 'rm', '--force', tag], { timeout: 30_000 }).catch(() => {});
    }
  }, 150_000);
});
