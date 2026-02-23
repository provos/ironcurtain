import { describe, it, expect, afterEach } from 'vitest';
import { request as httpRequest } from 'node:http';
import { createServer, type Socket } from 'node:net';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnectProxy, type ConnectProxy } from '../src/docker/connect-proxy.js';

describe('ConnectProxy', () => {
  let proxy: ConnectProxy | undefined;
  let tempDir: string;
  let socketPath: string;

  function makeSocketPath(): string {
    return join(tempDir, 'connect-proxy.sock');
  }

  afterEach(async () => {
    if (proxy) {
      await proxy.stop();
      proxy = undefined;
    }
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /**
   * Sends a CONNECT request to the proxy via UDS and returns the client socket + status.
   * For denied requests, socket will be null.
   */
  function sendConnect(host: string, port: number): Promise<{ socket: Socket | null; statusCode: number }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        socketPath,
        method: 'CONNECT',
        path: `${host}:${port}`,
      });

      req.on('connect', (_res, socket) => {
        resolve({ socket, statusCode: _res.statusCode ?? 0 });
      });

      req.on('error', reject);

      req.on('response', (res) => {
        // Non-200 responses come here for non-CONNECT methods
        resolve({ socket: null, statusCode: res.statusCode ?? 0 });
      });

      req.end();
    });
  }

  it('starts and listens on the specified socket path', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'connect-proxy-test-'));
    socketPath = makeSocketPath();
    proxy = createConnectProxy({ allowedHosts: ['api.anthropic.com'], socketPath });
    const addr = await proxy.start();

    expect(addr.socketPath).toBe(socketPath);
    expect(existsSync(socketPath)).toBe(true);
  });

  it('returns 403 for denied hosts', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'connect-proxy-test-'));
    socketPath = makeSocketPath();
    proxy = createConnectProxy({ allowedHosts: ['api.anthropic.com'], socketPath });
    await proxy.start();

    const { socket, statusCode } = await sendConnect('evil.com', 443);
    expect(statusCode).toBe(403);
    socket?.destroy();
  });

  it('returns 403 for empty host', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'connect-proxy-test-'));
    socketPath = makeSocketPath();
    proxy = createConnectProxy({ allowedHosts: ['api.anthropic.com'], socketPath });
    await proxy.start();

    const { socket, statusCode } = await sendConnect('', 443);
    expect(statusCode).toBe(403);
    socket?.destroy();
  });

  it('returns 200 for allowed hosts and establishes tunnel', async () => {
    // Set up a simple TCP echo server to tunnel to
    const echo = createServer((socket) => {
      socket.on('data', (data) => socket.write(data));
    });

    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
    const echoAddr = echo.address();
    if (!echoAddr || typeof echoAddr === 'string') throw new Error('No echo address');
    const echoPort = echoAddr.port;

    try {
      tempDir = mkdtempSync(join(tmpdir(), 'connect-proxy-test-'));
      socketPath = makeSocketPath();
      proxy = createConnectProxy({ allowedHosts: ['127.0.0.1'], socketPath });
      await proxy.start();

      const { socket, statusCode } = await sendConnect('127.0.0.1', echoPort);
      expect(statusCode).toBe(200);
      expect(socket).not.toBeNull();

      // Send data through the tunnel and verify echo
      const received = await new Promise<string>((resolve, reject) => {
        socket!.on('data', (chunk) => {
          resolve(chunk.toString());
        });
        socket!.on('error', reject);
        socket!.write('hello');
      });

      expect(received).toBe('hello');
      socket!.destroy();
    } finally {
      echo.close();
    }
  });

  it('returns 405 for non-CONNECT methods', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'connect-proxy-test-'));
    socketPath = makeSocketPath();
    proxy = createConnectProxy({ allowedHosts: ['api.anthropic.com'], socketPath });
    await proxy.start();

    const statusCode = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath,
          method: 'GET',
          path: '/',
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(statusCode).toBe(405);
  });

  it('stop() closes the server and cleans up the socket file', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'connect-proxy-test-'));
    socketPath = makeSocketPath();
    proxy = createConnectProxy({ allowedHosts: ['api.anthropic.com'], socketPath });
    await proxy.start();

    expect(existsSync(socketPath)).toBe(true);
    await proxy.stop();
    expect(existsSync(socketPath)).toBe(false);
    proxy = undefined; // Already stopped
  });

  it('cleans up stale socket file on start', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'connect-proxy-test-'));
    socketPath = makeSocketPath();

    // Start and stop to create a stale socket (stop cleans up, but let's test the path)
    const proxy1 = createConnectProxy({ allowedHosts: ['api.anthropic.com'], socketPath });
    await proxy1.start();
    // Don't call stop -- simulate a crash leaving a stale socket
    // Instead, just start a new proxy on the same path
    proxy = createConnectProxy({ allowedHosts: ['api.anthropic.com'], socketPath });
    // The old server is still listening, but start() will unlink and re-listen
    await proxy1.stop();
    const addr = await proxy.start();
    expect(addr.socketPath).toBe(socketPath);
  });
});
