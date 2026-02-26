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

export class TcpServerTransport implements Transport {
  private readonly host: string;
  private readonly requestedPort: number;
  private server: NetServer | null = null;
  private activeSocket: Socket | null = null;
  private readBuffer = new ReadBuffer();
  private _port: number | null = null;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(host: string, port: number) {
    this.host = host;
    this.requestedPort = port;
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
    // Close any existing connection -- only one client expected
    if (this.activeSocket && !this.activeSocket.destroyed) {
      this.activeSocket.destroy();
    }

    this.activeSocket = socket;
    this.readBuffer = new ReadBuffer();

    socket.on('data', (chunk: Buffer) => {
      this.readBuffer.append(chunk);
      this.processReadBuffer();
    });

    socket.on('error', (err) => {
      this.onerror?.(err);
    });

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
