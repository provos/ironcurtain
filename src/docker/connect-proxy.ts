/**
 * HTTP CONNECT proxy with domain allowlist.
 *
 * Handles only CONNECT requests -- used to restrict Docker container
 * network access to specific LLM API domains. No TLS termination;
 * tunnels raw TCP bytes for allowed hosts and returns 403 for denied.
 */

import { createServer, type Server as HttpServer, type IncomingMessage } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import * as logger from '../logger.js';

export interface ConnectProxy {
  /** Start listening. Resolves with the socket path. */
  start(): Promise<{ socketPath: string }>;

  /** Stop the proxy and close all active tunnels. */
  stop(): Promise<void>;
}

export interface ConnectProxyOptions {
  /**
   * Hostnames allowed for CONNECT tunneling.
   * Exact match only (no wildcards). Example: ['api.anthropic.com']
   */
  readonly allowedHosts: readonly string[];

  /** Absolute path for the Unix domain socket. */
  readonly socketPath: string;
}

/** Callback for CONNECT proxy access events. */
export type ConnectProxyLogFn = (event: { host: string; port: number; allowed: boolean }) => void;

export function createConnectProxy(options: ConnectProxyOptions): ConnectProxy {
  const allowed = new Set(options.allowedHosts);
  const activeTunnels = new Set<Socket>();

  const server: HttpServer = createServer((_req, res) => {
    // Only CONNECT is supported; reject everything else
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
  });

  let connectionId = 0;

  server.on('connect', (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    const url = req.url ?? '';
    // Split host:port. Uses lastIndexOf which works for domain names but
    // not IPv6 literals ([::1]:443). IPv6 is not needed here — the allowlist
    // only contains domain names (e.g. api.anthropic.com).
    const colonIndex = url.lastIndexOf(':');
    const host = colonIndex > 0 ? url.substring(0, colonIndex) : url;
    const port = colonIndex > 0 ? parseInt(url.substring(colonIndex + 1), 10) : 443;
    const connId = ++connectionId;

    if (!host || !allowed.has(host)) {
      logger.info(`[connect-proxy] #${connId} DENIED  CONNECT ${url} — host not in allowlist`);
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    const startTime = Date.now();
    let bytesUp = head.length;
    let bytesDown = 0;

    logger.info(`[connect-proxy] #${connId} ALLOWED CONNECT ${url}`);
    const serverSocket = netConnect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    // Track bytes for the connection summary
    clientSocket.on('data', (chunk) => {
      bytesUp += chunk.length;
    });
    serverSocket.on('data', (chunk) => {
      bytesDown += chunk.length;
    });

    activeTunnels.add(serverSocket);
    activeTunnels.add(clientSocket);

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      activeTunnels.delete(serverSocket);
      activeTunnels.delete(clientSocket);
      const durationMs = Date.now() - startTime;
      logger.info(`[connect-proxy] #${connId} CLOSED  ${host}:${port} — ${durationMs}ms, ↑${bytesUp}B ↓${bytesDown}B`);
    };

    serverSocket.on('error', (err) => {
      logger.info(`[connect-proxy] #${connId} ERROR   ${host}:${port} (server) — ${err.message}`);
      clientSocket.destroy();
      cleanup();
    });
    clientSocket.on('error', (err) => {
      logger.info(`[connect-proxy] #${connId} ERROR   ${host}:${port} (client) — ${err.message}`);
      serverSocket.destroy();
      cleanup();
    });
    serverSocket.on('close', cleanup);
    clientSocket.on('close', cleanup);
  });

  return {
    async start() {
      // Clean up stale socket file from a previous run
      if (existsSync(options.socketPath)) {
        unlinkSync(options.socketPath);
      }

      return new Promise((resolve, reject) => {
        server.listen(options.socketPath, () => {
          resolve({ socketPath: options.socketPath });
        });
        server.once('error', reject);
      });
    },

    async stop() {
      // Destroy all active tunnels
      for (const socket of activeTunnels) {
        socket.destroy();
      }
      activeTunnels.clear();

      return new Promise<void>((resolve) => {
        server.close(() => {
          // Clean up the socket file
          try {
            if (existsSync(options.socketPath)) {
              unlinkSync(options.socketPath);
            }
          } catch {
            // Ignore cleanup errors
          }
          resolve();
        });
      });
    },
  };
}
