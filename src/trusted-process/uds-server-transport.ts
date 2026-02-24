/**
 * UDS (Unix Domain Socket) server transport for the MCP SDK.
 *
 * Listens on a Unix domain socket and bridges each connection to
 * the MCP SDK's Transport interface. Uses newline-delimited JSON
 * framing, matching the StdioServerTransport protocol.
 *
 * Only one concurrent client is expected (the agent in the container).
 * If a new connection arrives while one is active, the old connection
 * is closed.
 */

import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { unlinkSync, existsSync } from 'node:fs';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';

export class UdsServerTransport implements Transport {
  private readonly socketPath: string;
  private server: NetServer | null = null;
  private activeSocket: Socket | null = null;
  private readBuffer = new ReadBuffer();

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  /**
   * Starts listening on the Unix domain socket.
   * Resolves once the server is bound and ready for connections.
   */
  async start(): Promise<void> {
    // Clean up stale socket file from a previous run
    if (existsSync(this.socketPath)) {
      unlinkSync(this.socketPath);
    }

    const server = createServer((socket) => this.handleConnection(socket));
    this.server = server;

    return new Promise<void>((resolve, reject) => {
      server.on('error', (err) => {
        reject(err);
      });
      server.listen(this.socketPath, () => {
        resolve();
      });
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- options included for Transport interface compliance
  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const socket = this.activeSocket;
    if (!socket || socket.destroyed) {
      throw new Error('No active UDS connection to send message to');
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

    // Clean up the socket file
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        /* ignore cleanup errors */
      }
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
