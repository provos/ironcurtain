/**
 * UDS client transport for MCP SDK -- used by integration tests
 * to connect to a UDS-based MCP server.
 */

import { connect as netConnect } from 'node:net';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';

export class UdsClientTransport implements Transport {
  private socket: ReturnType<typeof netConnect> | null = null;
  private readBuffer = new ReadBuffer();
  private readonly socketPath: string;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  async start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.socket = netConnect(this.socketPath, () => {
        this.socket?.removeListener('error', reject);
        this.socket?.on('error', (err: Error) => this.onerror?.(err));
        resolve();
      });
      this.socket.on('error', reject);
      this.socket.on('data', (chunk: Buffer) => {
        this.readBuffer.append(chunk);
        let message: JSONRPCMessage | null;
        while ((message = this.readBuffer.readMessage()) !== null) {
          this.onmessage?.(message);
        }
      });
      this.socket.on('close', () => this.onclose?.());
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      throw new Error('UDS client not connected');
    }
    return new Promise<void>((resolve, reject) => {
      socket.write(serializeMessage(message), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    this.socket?.destroy();
    this.socket = null;
  }
}
