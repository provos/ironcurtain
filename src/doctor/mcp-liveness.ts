/**
 * MCP server liveness probe used by `ironcurtain doctor`.
 *
 * Spawns a short-lived MCP client, sends initialize + tools/list, and
 * closes. Pattern copied from src/pipeline/annotate.ts (do NOT refactor
 * annotate.ts — keep this module independent so the probe surface stays
 * minimal).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { MCPServerConfig } from '../config/types.js';
import { permissiveJsonSchemaValidator } from '../trusted-process/permissive-output-validator.js';
import { resolveContainerSpawnCommand } from '../trusted-process/container-command.js';
import { VERSION } from '../version.js';

/** Per-server probe deadline (covers connect + listTools combined). */
const PROBE_TIMEOUT_MS = 5_000;

/** Hard cap on close() — best-effort cleanup; the subprocess is reaped on doctor exit anyway. */
const CLOSE_TIMEOUT_MS = 1_000;

export interface ProbeOk {
  readonly status: 'ok';
  readonly toolCount: number;
  readonly elapsedMs: number;
}

export interface ProbeFail {
  readonly status: 'fail';
  readonly elapsedMs: number;
  readonly reason: string;
}

export type ProbeResult = ProbeOk | ProbeFail;

/**
 * Wraps a promise in a deadline. Resolves to the original value, or rejects
 * with a timeout error if the deadline elapses first. Does not cancel the
 * underlying promise — the caller is responsible for cleanup.
 */
function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolveOk, rejectErr) => {
    const timer = setTimeout(() => {
      rejectErr(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolveOk(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        rejectErr(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Probes a single MCP server: connect, list tools, close.
 *
 * Catches all errors and converts them to a ProbeFail result so callers
 * can run multiple probes in parallel without a single failure aborting
 * the whole batch (Promise.all would otherwise reject on the first error).
 */
export async function probeServer(
  name: string,
  config: MCPServerConfig,
  serverCredentials: Readonly<Record<string, string>> = {},
): Promise<ProbeResult> {
  const start = Date.now();
  let client: Client | undefined;
  try {
    // Same docker→container translation the MCP relay applies, so the
    // probe exercises what sessions will actually spawn on machines
    // using the Apple container runtime.
    const spawnSpec = resolveContainerSpawnCommand(config.command, config.args);
    const transport = new StdioClientTransport({
      command: spawnSpec.command,
      args: spawnSpec.args,
      // Credential injection mirrors the MCP relay: stored per-server
      // credentials from ~/.ironcurtain/config.json win over inherited
      // env, same as a real session.
      env: { ...(process.env as Record<string, string>), ...(config.env ?? {}), ...serverCredentials },
      stderr: 'pipe',
    });
    if (transport.stderr) {
      // Drain stderr to prevent backpressure on chatty servers.
      transport.stderr.on('data', () => {});
    }

    const c = new Client(
      { name: `ironcurtain-doctor:${name}`, version: VERSION },
      { jsonSchemaValidator: permissiveJsonSchemaValidator },
    );
    client = c;

    const toolsResult = await withDeadline(
      (async () => {
        await c.connect(transport);
        return c.listTools();
      })(),
      PROBE_TIMEOUT_MS,
      `probe(${name})`,
    );

    return {
      status: 'ok',
      toolCount: toolsResult.tools.length,
      elapsedMs: Date.now() - start,
    };
  } catch (err) {
    return {
      status: 'fail',
      elapsedMs: Date.now() - start,
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (client) {
      // close() can hang when the server is wedged; cap it so a stuck server
      // can't block the rest of the doctor run.
      await withDeadline(client.close(), CLOSE_TIMEOUT_MS, `close(${name})`).catch(() => undefined);
    }
  }
}
