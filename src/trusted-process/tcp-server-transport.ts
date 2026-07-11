/**
 * TCP server transport for the MCP SDK.
 *
 * Listens on a configurable TCP host and port and bridges each
 * connection to the MCP SDK's Transport interface. Uses the same
 * newline-delimited JSON framing as StdioServerTransport.
 *
 * This is the TCP equivalent of UdsServerTransport, used on macOS
 * where Docker Desktop's VirtioFS does not support Unix domain
 * sockets in bind mounts. The caller controls the bind address:
 * 127.0.0.1 for loopback-only or 0.0.0.0 for all interfaces.
 *
 * Only one concurrent client is expected (the agent in the container).
 * If a new connection arrives while one is active, the old connection
 * is closed.
 */

import { createServer, type Server as NetServer, type Socket } from 'node:net';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';

export interface TcpServerTransportOptions {
  /**
   * Connection-source filter. When set, an incoming connection whose
   * `socket.remoteAddress` fails the predicate is destroyed before any
   * data is read. Used when binding 0.0.0.0 for a host-only container
   * network (tcp-hostonly topology) so only the agent VM's subnet can
   * reach the unauthenticated MCP endpoint.
   */
  readonly allowRemoteAddress?: (remoteAddress: string | undefined) => boolean;
}

/** Side-effect-free liveness exchange used by the Docker sidecar startup gate. */
export const TCP_TRANSPORT_HEALTH_REQUEST = 'IRONCURTAIN_HEALTH/1\n';
export const TCP_TRANSPORT_HEALTH_RESPONSE = 'IRONCURTAIN_OK/1\n';

export class TcpServerTransport implements Transport {
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly allowRemoteAddress?: (remoteAddress: string | undefined) => boolean;
  private server: NetServer | null = null;
  private activeSocket: Socket | null = null;
  private readBuffer = new ReadBuffer();
  private _port: number | null = null;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(host: string, port: number, options?: TcpServerTransportOptions) {
    this.host = host;
    this.requestedPort = port;
    this.allowRemoteAddress = options?.allowRemoteAddress;
  }

  /** The actual port the server is listening on. Only valid after start(). */
  get port(): number {
    if (this._port === null) {
      throw new Error('TcpServerTransport has not been started');
    }
    return this._port;
  }

  /**
   * Starts listening on the TCP port.
   * Resolves once the server is bound and ready for connections.
   * Idempotent: subsequent calls are no-ops (the MCP SDK's
   * server.connect() calls start() internally).
   */
  async start(): Promise<void> {
    if (this.server) return;

    const server = createServer((socket) => this.handleConnection(socket));
    this.server = server;

    return new Promise<void>((resolve, reject) => {
      server.on('error', (err) => {
        reject(err);
      });
      server.listen(this.requestedPort, this.host, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          this._port = addr.port;
        }
        resolve();
      });
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- options included for Transport interface compliance
  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const socket = this.activeSocket;
    if (!socket || socket.destroyed) {
      throw new Error('No active TCP connection to send message to');
    }

    return new Promise<void>((resolve, reject) => {
      const data = serializeMessage(message);
      socket.write(data, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    this.activeSocket?.destroy();
    this.activeSocket = null;

    const server = this.server;
    if (server) {
      this.server = null;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }

    this.onclose?.();
  }

  private handleConnection(socket: Socket): void {
    // Drop connections from disallowed sources before touching the
    // active-socket slot, so a rejected peer can't evict the agent.
    if (this.allowRemoteAddress && !this.allowRemoteAddress(socket.remoteAddress)) {
      socket.destroy();
      return;
    }

    socket.on('error', (err) => {
      this.onerror?.(err);
    });

    // Delay claiming the single MCP connection until the first bytes arrive.
    // A health probe is answered locally and never evicts the real client.
    let pending = Buffer.alloc(0);
    const inspectFirstBytes = (chunk: Buffer): void => {
      pending = Buffer.concat([pending, chunk]);
      const text = pending.toString('utf8');
      if (TCP_TRANSPORT_HEALTH_REQUEST.startsWith(text) && pending.length < TCP_TRANSPORT_HEALTH_REQUEST.length) {
        return;
      }
      socket.off('data', inspectFirstBytes);
      if (text === TCP_TRANSPORT_HEALTH_REQUEST) {
        socket.end(TCP_TRANSPORT_HEALTH_RESPONSE);
        return;
      }

      // Close any existing connection -- only one MCP client is expected.
      if (this.activeSocket && !this.activeSocket.destroyed) this.activeSocket.destroy();
      this.activeSocket = socket;
      this.readBuffer = new ReadBuffer();
      this.readBuffer.append(pending);
      this.processReadBuffer();
      socket.on('data', (data: Buffer) => {
        this.readBuffer.append(data);
        this.processReadBuffer();
      });
    };
    socket.on('data', inspectFirstBytes);

    socket.on('close', () => {
      if (this.activeSocket === socket) {
        this.activeSocket = null;
      }
    });
  }

  private processReadBuffer(): void {
    let message: JSONRPCMessage | null;
    while ((message = this.readBuffer.readMessage()) !== null) {
      this.onmessage?.(message);
    }
  }
}
