/**
 * Control socket for live daemon communication.
 *
 * The daemon listens on a Unix domain socket at ~/.ironcurtain/daemon.sock.
 * CLI commands detect whether the daemon is running (socket exists and
 * responds) and forward commands to it. If no daemon is running, CLI
 * commands fall back to direct filesystem operations.
 *
 * Protocol: newline-delimited JSON. Each request is a single JSON line;
 * the daemon writes a single JSON response line and closes the connection.
 */

import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { unlinkSync } from 'node:fs';
import { getDaemonSocketPath } from '../config/paths.js';
import * as logger from '../logger.js';
import type { JobDefinition, RunRecord } from '../cron/types.js';

// ---------------------------------------------------------------------------
// Protocol types
// ---------------------------------------------------------------------------

/** Commands the CLI can send to the daemon. */
export type ControlRequest =
  | { readonly command: 'ping' }
  | { readonly command: 'add-job'; readonly job: JobDefinition }
  | { readonly command: 'remove-job'; readonly jobId: string }
  | { readonly command: 'enable-job'; readonly jobId: string }
  | { readonly command: 'disable-job'; readonly jobId: string }
  | { readonly command: 'recompile-job'; readonly jobId: string }
  | { readonly command: 'run-job'; readonly jobId: string }
  | { readonly command: 'list-jobs' };

/** Successful response from the daemon. */
export interface ControlResponseOk {
  readonly ok: true;
  readonly data?: unknown;
}

/** Error response from the daemon. */
export interface ControlResponseError {
  readonly ok: false;
  readonly error: string;
}

export type ControlResponse = ControlResponseOk | ControlResponseError;

// ---------------------------------------------------------------------------
// Request handler interface (implemented by the daemon)
// ---------------------------------------------------------------------------

export interface ControlRequestHandler {
  addJob(job: JobDefinition): Promise<void>;
  removeJob(jobId: string): Promise<void>;
  enableJob(jobId: string): Promise<void>;
  disableJob(jobId: string): Promise<void>;
  recompileJob(jobId: string): Promise<void>;
  runJobNow(jobId: string): Promise<RunRecord>;
  listJobs(): Array<{
    job: JobDefinition;
    nextRun: Date | undefined;
    lastRun: RunRecord | undefined;
    isRunning: boolean;
  }>;
}

// ---------------------------------------------------------------------------
// Server (daemon-side)
// ---------------------------------------------------------------------------

export class ControlSocketServer {
  private server: Server | null = null;
  private readonly socketPath: string;
  private readonly handler: ControlRequestHandler;

  constructor(handler: ControlRequestHandler, socketPath?: string) {
    this.handler = handler;
    this.socketPath = socketPath ?? getDaemonSocketPath();
  }

  /** Starts listening on the Unix domain socket. */
  async start(): Promise<void> {
    await this.removeStaleSocket();

    return new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => this.onConnection(socket));
      this.server = server;

      server.on('error', (err) => {
        logger.error(`[ControlSocket] Server error: ${err.message}`);
        reject(err);
      });

      server.listen(this.socketPath, () => {
        logger.info(`[ControlSocket] Listening on ${this.socketPath}`);
        resolve();
      });
    });
  }

  /** Stops the server and removes the socket file. */
  async stop(): Promise<void> {
    if (!this.server) return;

    const server = this.server;
    return new Promise<void>((resolve) => {
      server.close(() => {
        this.cleanupSocketFile();
        this.server = null;
        resolve();
      });
    });
  }

  /**
   * Removes a stale socket file left behind by a crashed daemon.
   * Attempts to connect first — only unlinks when the socket is
   * confirmed stale (ECONNREFUSED) or absent (ENOENT). If the
   * socket is live, throws so the caller knows another daemon is running.
   */
  private async removeStaleSocket(): Promise<void> {
    const alive = await this.isSocketAlive();
    if (alive) {
      throw new Error(
        `Another daemon is already listening on ${this.socketPath}. ` + `Stop it first or remove the socket manually.`,
      );
    }
    // Socket is stale or absent — safe to unlink
    try {
      unlinkSync(this.socketPath);
      logger.info(`[ControlSocket] Removed stale socket file`);
    } catch {
      // File doesn't exist — fine
    }
  }

  /**
   * Probes whether the socket is actively accepting connections.
   * Returns true if a daemon is listening, false if stale/absent.
   */
  private isSocketAlive(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const conn = createConnection(this.socketPath);
      conn.once('connect', () => {
        conn.destroy();
        resolve(true);
      });
      conn.once('error', () => {
        resolve(false);
      });
    });
  }

  private cleanupSocketFile(): void {
    try {
      unlinkSync(this.socketPath);
    } catch {
      // Best-effort cleanup
    }
  }

  private onConnection(socket: Socket): void {
    let data = '';
    let dispatched = false;

    socket.on('data', (chunk) => {
      if (dispatched) return;
      data += chunk.toString();
      const newlineIndex = data.indexOf('\n');
      if (newlineIndex === -1) return;

      dispatched = true;
      const line = data.slice(0, newlineIndex);
      void this.handleRequest(line, socket);
    });

    socket.on('error', (err) => {
      logger.warn(`[ControlSocket] Connection error: ${err.message}`);
    });

    // Timeout idle connections after 30s
    socket.setTimeout(30_000, () => {
      socket.destroy();
    });
  }

  private async handleRequest(line: string, socket: Socket): Promise<void> {
    let request: ControlRequest;
    try {
      request = JSON.parse(line) as ControlRequest;
    } catch {
      this.sendResponse(socket, { ok: false, error: 'Invalid JSON' });
      return;
    }

    try {
      const response = await this.dispatch(request);
      this.sendResponse(socket, response);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendResponse(socket, { ok: false, error: message });
    }
  }

  private async dispatch(request: ControlRequest): Promise<ControlResponse> {
    switch (request.command) {
      case 'ping':
        return { ok: true, data: { status: 'running' } };

      case 'add-job':
        await this.handler.addJob(request.job);
        return { ok: true };

      case 'remove-job':
        await this.handler.removeJob(request.jobId);
        return { ok: true };

      case 'enable-job':
        await this.handler.enableJob(request.jobId);
        return { ok: true };

      case 'disable-job':
        await this.handler.disableJob(request.jobId);
        return { ok: true };

      case 'recompile-job':
        await this.handler.recompileJob(request.jobId);
        return { ok: true };

      case 'run-job': {
        const record = await this.handler.runJobNow(request.jobId);
        return { ok: true, data: record };
      }

      case 'list-jobs': {
        const jobs = this.handler.listJobs();
        // Serialize dates for JSON transport
        const serialized = jobs.map((j) => ({
          ...j,
          nextRun: j.nextRun?.toISOString() ?? null,
        }));
        return { ok: true, data: serialized };
      }

      default:
        return { ok: false, error: `Unknown command: ${(request as ControlRequest).command}` };
    }
  }

  private sendResponse(socket: Socket, response: ControlResponse): void {
    try {
      socket.end(JSON.stringify(response) + '\n');
    } catch {
      // Connection may have been closed
    }
  }
}

// ---------------------------------------------------------------------------
// Client (CLI-side)
// ---------------------------------------------------------------------------

/** Timeout for connecting to the daemon socket (ms). */
const CONNECT_TIMEOUT = 2_000;

/** Timeout for receiving a response from the daemon (ms). */
const RESPONSE_TIMEOUT = 300_000; // 5 minutes -- run-job can take a while

/**
 * Sends a request to the running daemon via the control socket.
 * Returns the parsed response, or null if the daemon is not reachable.
 */
export async function sendControlRequest(
  request: ControlRequest,
  socketPath?: string,
): Promise<ControlResponse | null> {
  const path = socketPath ?? getDaemonSocketPath();

  return new Promise<ControlResponse | null>((resolve) => {
    const socket = createConnection({ path });
    let data = '';
    let settled = false;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: ControlResponse | null) => {
      if (settled) return;
      settled = true;
      if (connectTimer) clearTimeout(connectTimer);
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(RESPONSE_TIMEOUT, () => {
      finish(null);
    });

    socket.on('connect', () => {
      socket.write(JSON.stringify(request) + '\n');
    });

    socket.on('data', (chunk) => {
      data += chunk.toString();
      const newlineIndex = data.indexOf('\n');
      if (newlineIndex === -1) return;

      try {
        const response = JSON.parse(data.slice(0, newlineIndex)) as ControlResponse;
        finish(response);
      } catch {
        finish(null);
      }
    });

    socket.on('error', () => {
      finish(null);
    });

    // Connect timeout -- daemon not responding
    connectTimer = setTimeout(() => {
      finish(null);
    }, CONNECT_TIMEOUT);
  });
}

/**
 * Checks if a daemon is currently running and responsive.
 * Returns true if the daemon responds to a ping.
 */
export async function isDaemonRunning(socketPath?: string): Promise<boolean> {
  const response = await sendControlRequest({ command: 'ping' }, socketPath);
  return response !== null && response.ok;
}
