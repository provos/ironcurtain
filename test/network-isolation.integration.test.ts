/**
 * Integration test: --network=none + UDS CONNECT proxy isolation.
 *
 * Requires Docker and the ironcurtain-base:latest image to be built.
 * Skipped unless INTEGRATION_TEST=1 is set.
 *
 * Run:  INTEGRATION_TEST=1 npm test -- test/network-isolation.integration.test.ts
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createConnectProxy, type ConnectProxy } from '../src/docker/connect-proxy.js';

const execFile = promisify(execFileCb);

const IMAGE = 'ironcurtain-base:latest';
const CONTAINER_NAME = `ironcurtain-net-iso-test-${Date.now()}`;

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await execFile('docker', args, { timeout: 30_000 });
  return stdout.trim();
}

async function dockerExec(
  containerId: string,
  ...cmd: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFile('docker', ['exec', containerId, ...cmd], {
      timeout: 30_000,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.code ?? 1 };
  }
}

async function isDockerAvailable(): Promise<boolean> {
  try {
    await execFile('docker', ['info'], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function imageExists(image: string): Promise<boolean> {
  try {
    await execFile('docker', ['image', 'inspect', image], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!process.env.INTEGRATION_TEST)('Network isolation (--network=none + UDS proxy)', () => {
  let tempDir: string;
  let proxy: ConnectProxy;
  let containerId: string;

  beforeAll(async () => {
    if (!(await isDockerAvailable())) {
      throw new Error('Docker is not available');
    }
    if (!(await imageExists(IMAGE))) {
      throw new Error(`Docker image ${IMAGE} not found. Build it first.`);
    }

    tempDir = mkdtempSync(join(tmpdir(), 'network-isolation-test-'));
    const socketPath = join(tempDir, 'connect-proxy.sock');

    // Start connect proxy allowing only api.anthropic.com
    proxy = createConnectProxy({
      allowedHosts: ['api.anthropic.com'],
      socketPath,
    });
    await proxy.start();

    // Create and start --network=none container
    containerId = await docker(
      'create',
      '--name',
      CONTAINER_NAME,
      '--network',
      'none',
      '--cap-drop=ALL',
      '-v',
      `${socketPath}:/run/ironcurtain/connect-proxy.sock:ro`,
      '-e',
      'HTTPS_PROXY=http://127.0.0.1:18080',
      '-e',
      'HTTP_PROXY=http://127.0.0.1:18080',
      IMAGE,
      'sleep',
      'infinity',
    );
    await docker('start', containerId);

    // Start socat bridge inside container
    const socat = await dockerExec(
      containerId,
      'bash',
      '-c',
      'socat TCP-LISTEN:18080,fork,reuseaddr UNIX-CONNECT:/run/ironcurtain/connect-proxy.sock &' +
        ' sleep 0.5 && pgrep socat > /dev/null && echo OK',
    );
    if (!socat.stdout.includes('OK')) {
      throw new Error(`socat failed to start: ${socat.stderr}`);
    }
  }, 60_000);

  afterAll(async () => {
    try {
      await docker('rm', '-f', containerId);
    } catch {
      /* ignore */
    }
    await proxy.stop();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('container uses NetworkMode=none', async () => {
    const mode = await docker('inspect', '-f', '{{.HostConfig.NetworkMode}}', containerId);
    expect(mode).toBe('none');
  });

  it('allows CONNECT tunnel to api.anthropic.com', async () => {
    const result = await dockerExec(
      containerId,
      'curl',
      '-s',
      '-o',
      '/dev/null',
      '-w',
      '%{http_code}',
      '--proxy',
      'http://127.0.0.1:18080',
      '--connect-timeout',
      '10',
      'https://api.anthropic.com/',
    );

    // Tunnel succeeds — we get an HTTP response from the API (likely 404 or 401, not 403)
    const status = parseInt(result.stdout.trim(), 10);
    expect(result.exitCode).toBe(0);
    expect(status).not.toBe(403);
  }, 30_000);

  it('blocks CONNECT tunnel to google.com', async () => {
    const result = await dockerExec(
      containerId,
      'curl',
      '-s',
      '-o',
      '/dev/null',
      '-w',
      '%{http_code}',
      '--proxy',
      'http://127.0.0.1:18080',
      '--connect-timeout',
      '10',
      'https://www.google.com/',
    );

    // Proxy returns 403 → curl sees a failed CONNECT (exit code 56)
    expect(result.exitCode).not.toBe(0);
  }, 30_000);

  it('blocks direct internet access (no proxy bypass)', async () => {
    const result = await dockerExec(
      containerId,
      'curl',
      '-s',
      '-o',
      '/dev/null',
      '-w',
      '%{http_code}',
      '--noproxy',
      '*',
      '--connect-timeout',
      '5',
      'https://www.google.com/',
    );

    // --network=none means no IP stack at all — curl fails to resolve/connect
    expect(result.exitCode).not.toBe(0);
  }, 30_000);
});
