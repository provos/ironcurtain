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
import { VERSION } from '../version.js';

/** Per-server probe deadline. 5s is enough for npx warm-cache servers. */
const PROBE_TIMEOUT_MS = 5_000;

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
export async function probeServer(name: string, config: MCPServerConfig): Promise<ProbeResult> {
  const start = Date.now();
  let client: Client | undefined;
  try {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...(process.env as Record<string, string>), ...(config.env ?? {}) },
      stderr: 'pipe',
    });
    if (transport.stderr) {
      // Drain stderr to prevent backpressure on chatty servers.
      transport.stderr.on('data', () => {});
    }

    client = new Client(
      { name: `ironcurtain-doctor:${name}`, version: VERSION },
      { jsonSchemaValidator: permissiveJsonSchemaValidator },
    );

    await withDeadline(client.connect(transport), PROBE_TIMEOUT_MS, `connect(${name})`);
    const toolsResult = await withDeadline(client.listTools(), PROBE_TIMEOUT_MS, `listTools(${name})`);

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
      try {
        await client.close();
      } catch {
        // Best-effort cleanup.
      }
    }
  }
}
