/**
 * Spike test: UDS socket mounting strategies in Docker.
 *
 * Tests two approaches for making a host-side Unix domain socket
 * accessible inside a Docker container:
 *
 * 1. **File mount** (current approach): bind-mount the .sock file directly
 *    - Works on Linux (native Docker, shared kernel)
 *    - FAILS on macOS Docker Desktop (socket can't cross VM boundary via VirtioFS)
 *
 * 2. **Directory mount** (proposed fix): mount the parent directory, let the
 *    socket appear naturally inside the container
 *    - Works on both Linux and macOS (VirtioFS supports socket creation in shared dirs)
 *
 * Requires Docker and the ironcurtain-base:latest image.
 * Run:  INTEGRATION_TEST=1 npm test -- test/docker-uds-mount.spike.test.ts
 */

import { describe, it, expect, afterAll, beforeAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:net';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

const IMAGE = 'ironcurtain-base:latest';

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
      timeout: 15_000,
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

/**
 * Creates a simple echo server on a UDS socket.
 * Responds with "PONG\n" to any connection.
 */
function createEchoServer(socketPath: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((conn) => {
      conn.write('PONG\n');
      conn.end();
    });
    server.on('error', reject);
    server.listen(socketPath, () => resolve(server));
  });
}

describe.skipIf(!process.env.INTEGRATION_TEST)('Docker UDS socket mount strategies', () => {
  let tempDir: string;
  const containers: string[] = [];

  beforeAll(async () => {
    if (!(await isDockerAvailable())) {
      throw new Error('Docker is not available');
    }
    if (!(await imageExists(IMAGE))) {
      throw new Error(`Docker image ${IMAGE} not found. Build it first.`);
    }
    tempDir = mkdtempSync(join(tmpdir(), 'uds-mount-spike-'));
  }, 30_000);

  afterEach(async () => {
    // Clean up any containers created during the test
    for (const id of containers) {
      try {
        await docker('rm', '-f', id);
      } catch {
        /* ignore */
      }
    }
    containers.length = 0;
  });

  afterAll(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('file mount: socat can connect to host UDS socket from inside container', async () => {
    // Strategy 1: mount the socket FILE directly (current production approach)
    const socketDir = join(tempDir, 'file-mount');
    mkdirSync(socketDir, { recursive: true });
    const socketPath = join(socketDir, 'test.sock');

    const server = await createEchoServer(socketPath);

    try {
      const name = `uds-spike-file-${Date.now()}`;
      const containerId = await docker(
        'create',
        '--name',
        name,
        '--network',
        'none',
        '--cap-drop=ALL',
        '-v',
        `${socketPath}:/run/test.sock:ro`,
        IMAGE,
        'sleep',
        'infinity',
      );
      containers.push(containerId);
      await docker('start', containerId);

      // Try to connect to the mounted socket from inside the container
      const result = await dockerExec(
        containerId,
        'socat',
        '-T2',
        'STDOUT',
        'UNIX-CONNECT:/run/test.sock',
      );

      // On Linux: should succeed with "PONG"
      // On macOS Docker Desktop: socat will fail (connection refused / not a socket)
      const succeeded = result.exitCode === 0 && result.stdout.includes('PONG');
      console.log(
        `  File mount strategy: ${succeeded ? 'WORKS' : 'FAILS'} ` +
          `(exit=${result.exitCode}, stdout=${JSON.stringify(result.stdout.trim())}, ` +
          `stderr=${JSON.stringify(result.stderr.trim())})`,
      );

      // This assertion documents current behavior — expected to pass on Linux, fail on macOS
      if (process.platform === 'linux') {
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('PONG');
      } else {
        // On macOS we expect this to fail — document the failure mode
        console.log('  (Expected failure on macOS Docker Desktop — socket not accessible across VM boundary)');
      }
    } finally {
      server.close();
    }
  }, 30_000);

  it('directory mount: socat can connect to host UDS socket from inside container', async () => {
    // Strategy 2: mount the parent DIRECTORY, socket appears naturally inside container
    const socketDir = join(tempDir, 'dir-mount');
    mkdirSync(socketDir, { recursive: true });
    const socketPath = join(socketDir, 'test.sock');

    const server = await createEchoServer(socketPath);

    try {
      const name = `uds-spike-dir-${Date.now()}`;
      const containerId = await docker(
        'create',
        '--name',
        name,
        '--network',
        'none',
        '--cap-drop=ALL',
        '-v',
        `${socketDir}:/run/testdir`,
        IMAGE,
        'sleep',
        'infinity',
      );
      containers.push(containerId);
      await docker('start', containerId);

      // Try to connect to the socket via the mounted directory
      const result = await dockerExec(
        containerId,
        'socat',
        '-T2',
        'STDOUT',
        'UNIX-CONNECT:/run/testdir/test.sock',
      );

      const succeeded = result.exitCode === 0 && result.stdout.includes('PONG');
      console.log(
        `  Directory mount strategy: ${succeeded ? 'WORKS' : 'FAILS'} ` +
          `(exit=${result.exitCode}, stdout=${JSON.stringify(result.stdout.trim())}, ` +
          `stderr=${JSON.stringify(result.stderr.trim())})`,
      );

      // Directory mount should work on BOTH Linux and macOS
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('PONG');
    } finally {
      server.close();
    }
  }, 30_000);

  it('directory mount: socket created AFTER container start is accessible', async () => {
    // Verifies that a socket created after the directory is mounted still works.
    // This matches our production scenario: the MITM proxy creates the socket
    // in the session dir, which is already mounted into the container.
    const socketDir = join(tempDir, 'late-create');
    mkdirSync(socketDir, { recursive: true });
    const socketPath = join(socketDir, 'late.sock');

    const name = `uds-spike-late-${Date.now()}`;
    const containerId = await docker(
      'create',
      '--name',
      name,
      '--network',
      'none',
      '--cap-drop=ALL',
      '-v',
      `${socketDir}:/run/testdir`,
      IMAGE,
      'sleep',
      'infinity',
    );
    containers.push(containerId);
    await docker('start', containerId);

    // Socket doesn't exist yet — create it AFTER container is running
    const server = await createEchoServer(socketPath);

    try {
      // Small delay to let filesystem sync propagate (especially on macOS VirtioFS)
      await new Promise((r) => setTimeout(r, 500));

      const result = await dockerExec(
        containerId,
        'socat',
        '-T2',
        'STDOUT',
        'UNIX-CONNECT:/run/testdir/late.sock',
      );

      const succeeded = result.exitCode === 0 && result.stdout.includes('PONG');
      console.log(
        `  Late-create directory mount: ${succeeded ? 'WORKS' : 'FAILS'} ` +
          `(exit=${result.exitCode}, stdout=${JSON.stringify(result.stdout.trim())}, ` +
          `stderr=${JSON.stringify(result.stderr.trim())})`,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('PONG');
    } finally {
      server.close();
    }
  }, 30_000);
});
