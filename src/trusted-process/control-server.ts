/**
 * HTTP control server for `ToolCallCoordinator`.
 *
 * Exposes a small JSON-over-HTTP API that the workflow orchestrator uses
 * to hot-swap the coordinator's policy between state transitions. The
 * server follows the same shape as the MITM proxy's control server:
 * HTTP/1.1 over a Unix domain socket (preferred) or loopback TCP
 * (fallback for platforms where UDS in bind mounts is not viable --
 * typically macOS with Docker Desktop).
 *
 * Routing convention: endpoints live under `/__ironcurtain/<noun>/<verb>`.
 * This prefix is shared with the MITM control server but each server
 * routes a disjoint set of nouns (MITM owns `domains/*`; the coordinator
 * owns `policy/*`). The two services are deliberately separate --
 * they run in different processes and serve different concerns.
 *
 * Transport selection rules:
 *   - If `socketPath` is supplied, bind UDS. The parent directory is
 *     assumed to carry `0o700` mode (same pattern as MITM); this is
 *     how access control is enforced.
 *   - Otherwise if `port` is supplied, bind TCP on 127.0.0.1.
 *   - Callers must supply exactly one of the two.
 *
 * The server is silent when no workflow is wired up: `start()` is only
 * called when the coordinator was constructed with a control-socket
 * path, so the single-session CLI / daemon / cron paths are unaffected.
 */

import { existsSync, unlinkSync } from 'node:fs';
import * as http from 'node:http';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Request body for `POST /__ironcurtain/policy/load`.
 * Matches `ToolCallCoordinator.loadPolicy`'s argument shape exactly so
 * the server is a thin HTTP adapter.
 */
export interface LoadPolicyRequest {
  readonly persona: string;
  readonly version: number;
  readonly policyDir: string;
  readonly auditPath: string;
}

/** Handler invoked when `POST /__ironcurtain/policy/load` arrives. */
export type LoadPolicyHandler = (req: LoadPolicyRequest) => Promise<void>;

/** Listen options. Exactly one of `socketPath` / `port` must be set. */
export interface ControlServerListenOptions {
  /** Absolute UDS path. Mutually exclusive with `port`. */
  readonly socketPath?: string;
  /** TCP port (0 for OS-assigned). Mutually exclusive with `socketPath`. */
  readonly port?: number;
}

/** Address the server actually bound to (TCP port is filled in if 0 was passed). */
export interface ControlServerAddress {
  readonly socketPath?: string;
  readonly port?: number;
}

/**
 * Constructor dependencies for `ControlServer`. The handler is injected
 * so the server has no direct coupling to `ToolCallCoordinator`; this
 * keeps the server unit-testable without a full coordinator.
 */
export interface ControlServerDeps {
  readonly onLoadPolicy: LoadPolicyHandler;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Cap on control-request body size (4 KiB). Load requests are tiny; anything larger is hostile or buggy. */
const MAX_BODY_BYTES = 4096;

/** Buffers an HTTP request body up to `maxBytes`; rejects if the limit is exceeded. */
function bufferRequestBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error(`Request body exceeds ${maxBytes} bytes`));
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Writes a JSON response with the given status code and body. */
function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Validates the decoded body of a load-policy request. Returns the
 * validated shape or a string describing the first validation failure.
 */
function parseLoadPolicyBody(raw: unknown): LoadPolicyRequest | string {
  if (typeof raw !== 'object' || raw === null) return 'body must be a JSON object';
  const obj = raw as Record<string, unknown>;
  if (typeof obj.persona !== 'string' || obj.persona.length === 0) {
    return 'persona must be a non-empty string';
  }
  if (typeof obj.version !== 'number' || !Number.isFinite(obj.version) || obj.version < 0) {
    return 'version must be a finite non-negative number';
  }
  if (typeof obj.policyDir !== 'string' || obj.policyDir.length === 0) {
    return 'policyDir must be a non-empty string';
  }
  if (typeof obj.auditPath !== 'string' || obj.auditPath.length === 0) {
    return 'auditPath must be a non-empty string';
  }
  return {
    persona: obj.persona,
    version: obj.version,
    policyDir: obj.policyDir,
    auditPath: obj.auditPath,
  };
}

/**
 * HTTP server that routes control requests to the coordinator.
 *
 * Lifecycle: `start(options)` once, `stop()` once. Re-starting after
 * `stop()` is not supported -- construct a new instance instead.
 */
export class ControlServer {
  private readonly server: http.Server;
  private boundAddress: ControlServerAddress | null = null;

  constructor(deps: ControlServerDeps) {
    this.server = http.createServer((req, res) => {
      this.route(req, res, deps).catch((err: unknown) => {
        // The per-handler try/catch should absorb all errors; this is
        // a belt-and-braces guard against a handler that leaks a
        // rejection. Report as a 500 so callers see something useful.
        if (!res.headersSent) {
          writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        } else {
          res.end();
        }
      });
    });
  }

  /** Dispatches a single request. One method, one route, for now. */
  private async route(req: http.IncomingMessage, res: http.ServerResponse, deps: ControlServerDeps): Promise<void> {
    const url = req.url ?? '';

    if (url === '/__ironcurtain/policy/load' && req.method === 'POST') {
      await this.handleLoadPolicy(req, res, deps.onLoadPolicy);
      return;
    }

    writeJson(res, 404, { error: 'Not Found' });
  }

  /**
   * Parses a `POST /__ironcurtain/policy/load` request and invokes the
   * handler. 400 on malformed input; 500 on handler failure; 200 on
   * success with `{ ok: true, loadedAt: <ISO> }`.
   */
  private async handleLoadPolicy(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    onLoadPolicy: LoadPolicyHandler,
  ): Promise<void> {
    let body: Buffer;
    try {
      body = await bufferRequestBody(req, MAX_BODY_BYTES);
    } catch (err) {
      writeJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf-8'));
    } catch (err) {
      writeJson(res, 400, { error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    const validated = parseLoadPolicyBody(parsed);
    if (typeof validated === 'string') {
      writeJson(res, 400, { error: validated });
      return;
    }

    try {
      await onLoadPolicy(validated);
    } catch (err) {
      writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      return;
    }

    writeJson(res, 200, { ok: true, loadedAt: new Date().toISOString() });
  }

  /**
   * Begins accepting connections. Resolves once the socket is bound;
   * rejects with the server's `'error'` event on bind failure.
   */
  async start(options: ControlServerListenOptions): Promise<ControlServerAddress> {
    const { socketPath, port } = options;
    const hasSocket = socketPath !== undefined;
    const hasPort = port !== undefined;
    if (hasSocket === hasPort) {
      throw new Error('ControlServer.start: exactly one of socketPath or port must be provided');
    }

    if (socketPath !== undefined) {
      // If a stale socket exists from a previous run, clear it. Matches
      // MITM's behavior at mitm-proxy.ts:1600.
      if (existsSync(socketPath)) {
        unlinkSync(socketPath);
      }
      this.boundAddress = await listen(this.server, socketPath);
      return this.boundAddress;
    }

    // Narrowing: port must be defined here (we rejected the both-undefined
    // and both-defined cases above).
    this.boundAddress = await listenTcp(this.server, port ?? 0);
    return this.boundAddress;
  }

  /** Returns the bound address, or null if `start()` has not completed. */
  getAddress(): ControlServerAddress | null {
    return this.boundAddress;
  }

  /**
   * Shuts down the server. Closes all in-flight connections, removes
   * the socket file (UDS mode), and resolves once the listener has
   * fully stopped.
   */
  async stop(): Promise<void> {
    // closeAllConnections() cancels any in-flight requests so close()
    // doesn't hang waiting for keep-alive connections to end.
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });

    const socketPath = this.boundAddress?.socketPath;
    if (socketPath) {
      try {
        if (existsSync(socketPath)) {
          unlinkSync(socketPath);
        }
      } catch {
        // best-effort cleanup
      }
    }
  }
}

/** Listens on a UDS and resolves with the bound address. */
function listen(server: http.Server, socketPath: string): Promise<ControlServerAddress> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(socketPath, () => {
      server.removeListener('error', onError);
      resolve({ socketPath });
    });
  });
}

/** Listens on loopback TCP and resolves with the OS-assigned port. */
function listenTcp(server: http.Server, port: number): Promise<ControlServerAddress> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError);
      const addr = server.address();
      const boundPort = addr && typeof addr === 'object' ? addr.port : port;
      resolve({ port: boundPort });
    });
  });
}
