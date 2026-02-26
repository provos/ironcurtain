/**
 * Manages the lifecycle of an MCP proxy server process for a Docker session.
 *
 * Spawns the proxy as a child process with PROXY_SOCKET_PATH set.
 * The proxy process is the same mcp-proxy-server.ts used by the
 * built-in session, just with a UDS transport instead of stdio.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connect as netConnect } from 'node:net';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ToolInfo } from './agent-adapter.js';
import { VERSION } from '../version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Timeout for socket readiness polling. */
const SOCKET_READY_TIMEOUT_MS = 15_000;
const SOCKET_POLL_INTERVAL_MS = 50;

/** Path to the mcp-proxy-server module. */
function getProxyModulePath(): string {
  // In compiled mode: dist/trusted-process/mcp-proxy-server.js
  // In source mode: src/trusted-process/mcp-proxy-server.ts (needs tsx)
  const compiledPath = resolve(__dirname, '..', 'trusted-process', 'mcp-proxy-server.js');
  if (existsSync(compiledPath)) return compiledPath;
  return resolve(__dirname, '..', 'trusted-process', 'mcp-proxy-server.ts');
}

export interface ManagedProxy {
  /** Start the proxy process. Resolves when the transport is ready for connections. */
  start(): Promise<void>;

  /** Query available tools from the running proxy. */
  listTools(): Promise<ToolInfo[]>;

  /** Stop the proxy process and clean up the socket. */
  stop(): Promise<void>;

  /** The socket path the proxy is listening on (UDS mode). */
  readonly socketPath: string;

  /** The TCP port the proxy is listening on (TCP mode). Only valid after start(). */
  readonly port: number | undefined;
}

export interface ManagedProxyOptions {
  /** Absolute path for the UDS socket (used in UDS mode). */
  readonly socketPath: string;

  /** Environment variables to pass to the proxy process. */
  readonly env: Record<string, string>;

  /** Working directory for the proxy process. Defaults to process.cwd(). */
  readonly cwd?: string;

  /** Listen mode: 'uds' (default) or 'tcp'. TCP mode uses OS-assigned port. */
  readonly listenMode?: 'uds' | 'tcp';
}

/**
 * Creates a temporary MCP client connection via TCP.
 * Used for listTools() queries in TCP mode.
 */
class TcpClientTransport implements Transport {
  private socket: ReturnType<typeof netConnect> | null = null;
  private readBuffer = new ReadBuffer();
  private readonly host: string;
  private readonly port: number;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(host: string, port: number) {
    this.host = host;
    this.port = port;
  }

  async start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.socket = netConnect({ host: this.host, port: this.port }, () => resolve());
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
      throw new Error('TCP client not connected');
    }
    return new Promise<void>((resolve, reject) => {
      socket.write(serializeMessage(message), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- must be async to satisfy Transport interface
  async close(): Promise<void> {
    this.socket?.destroy();
    this.socket = null;
  }
}

/**
 * Creates a temporary MCP client connection to the UDS socket.
 * Used for listTools() queries.
 */
class UdsClientTransport implements Transport {
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
      this.socket = netConnect(this.socketPath, () => resolve());
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

  // eslint-disable-next-line @typescript-eslint/require-await -- must be async to satisfy Transport interface
  async close(): Promise<void> {
    this.socket?.destroy();
    this.socket = null;
  }
}

export function createManagedProxy(options: ManagedProxyOptions): ManagedProxy {
  let childProcess: ChildProcess | null = null;
  const useTcp = options.listenMode === 'tcp';
  let resolvedPort: number | undefined;

  // In TCP mode, the proxy writes its port to this file after binding
  const portFilePath = resolve(dirname(options.socketPath), 'proxy-port.txt');

  return {
    socketPath: options.socketPath,

    get port(): number | undefined {
      return resolvedPort;
    },

    async start(): Promise<void> {
      // Remove stale port file from a prior crashed run to prevent
      // false readiness during polling.
      if (useTcp) {
        try {
          unlinkSync(portFilePath);
        } catch {
          /* file may not exist */
        }
      }

      const modulePath = getProxyModulePath();
      const isTsSource = modulePath.endsWith('.ts');

      // Fork the proxy process with the appropriate transport env vars
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        ...options.env,
      };

      if (useTcp) {
        // Ensure UDS-specific env vars do not leak from the parent environment
        delete env.PROXY_SOCKET_PATH;
        env.PROXY_TCP_PORT = '0'; // OS-assigned port
        env.PROXY_PORT_FILE = portFilePath;
      } else {
        // Ensure TCP-specific env vars do not leak from the parent environment
        delete env.PROXY_TCP_PORT;
        delete env.PROXY_PORT_FILE;
        env.PROXY_SOCKET_PATH = options.socketPath;
      }

      const cwd = options.cwd ?? process.cwd();

      if (isTsSource) {
        // In development, use tsx to run TypeScript directly
        const { spawn } = await import('node:child_process');
        childProcess = spawn('npx', ['tsx', modulePath], {
          env,
          cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } else {
        childProcess = fork(modulePath, [], {
          env,
          cwd,
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        });
      }

      // Capture stderr and exit for diagnostics
      let proxyStderr = '';
      let proxyExited = false;
      let proxyExitCode: number | null = null;

      childProcess.stderr?.on('data', (chunk: Buffer) => {
        proxyStderr += chunk.toString();
      });

      childProcess.on('error', (err) => {
        console.error(`MCP proxy process error: ${err.message}`);
      });

      childProcess.on('exit', (code) => {
        proxyExited = true;
        proxyExitCode = code;
      });

      // Poll for readiness: port file in TCP mode, socket file in UDS mode
      const readinessTarget = useTcp ? portFilePath : options.socketPath;
      const start = Date.now();
      while (!existsSync(readinessTarget)) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- mutated by async 'exit' event handler
        if (proxyExited) {
          throw new Error(
            `MCP proxy process exited with code ${proxyExitCode} before becoming ready.\nStderr: ${proxyStderr}`,
          );
        }
        if (Date.now() - start > SOCKET_READY_TIMEOUT_MS) {
          throw new Error(
            `MCP proxy did not become ready within ${SOCKET_READY_TIMEOUT_MS}ms.\nStderr: ${proxyStderr}`,
          );
        }
        await delay(SOCKET_POLL_INTERVAL_MS);
      }

      // In TCP mode, read the port from the file
      if (useTcp && portFilePath) {
        const rawPort = readFileSync(portFilePath, 'utf-8').trim();
        const parsedPort = parseInt(rawPort, 10);
        if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
          throw new Error(`Invalid TCP port "${rawPort}" read from ${portFilePath}.`);
        }
        resolvedPort = parsedPort;
      }
    },

    async listTools(): Promise<ToolInfo[]> {
      const transport =
        useTcp && resolvedPort !== undefined
          ? new TcpClientTransport('127.0.0.1', resolvedPort)
          : new UdsClientTransport(options.socketPath);
      const client = new Client({ name: 'ironcurtain-tool-lister', version: VERSION }, {});

      try {
        await client.connect(transport);
        const result = await client.listTools();
        return result.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as Record<string, unknown>,
        }));
      } finally {
        try {
          await client.close();
        } catch {
          /* ignore cleanup errors */
        }
      }
    },

    async stop(): Promise<void> {
      if (childProcess) {
        childProcess.kill('SIGTERM');
        // Give it a moment to clean up
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            childProcess?.kill('SIGKILL');
            resolve();
          }, 3000);
          childProcess?.on('exit', () => {
            clearTimeout(timeout);
            resolve();
          });
        });
        childProcess = null;
      }
    },
  };
}
