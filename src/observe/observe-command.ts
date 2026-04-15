/**
 * CLI entry point for `ironcurtain observe`.
 *
 * Connects to the daemon's WebSocket server, subscribes to token
 * stream events, and renders LLM output to stdout in real time.
 */

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import chalk from 'chalk';
import { WebSocket } from 'ws';

import { checkHelp, type CommandSpec } from '../cli-help.js';
import { getWebUiStatePath } from '../config/paths.js';
import { renderEventBatch, renderConnected, renderSessionEnded, type RenderOptions } from './observe-renderer.js';
import { wsDataToString } from '../web-ui/ws-utils.js';
import type { TokenStreamEvent } from '../docker/token-stream-types.js';

// ---------------------------------------------------------------------------
// Command spec (for --help)
// ---------------------------------------------------------------------------

const observeSpec: CommandSpec = {
  name: 'ironcurtain observe',
  description: 'Watch live LLM token output for running sessions',
  usage: [
    'ironcurtain observe <label>             Watch a single session by label',
    'ironcurtain observe --all               Watch all active sessions',
    'ironcurtain observe --workflow <name>    Watch sessions in a workflow',
  ],
  options: [
    { flag: 'all', description: 'Observe all active sessions' },
    { flag: 'workflow', description: 'Observe all sessions in a named workflow', placeholder: '<name>' },
    { flag: 'raw', description: 'Show all event types, not just text' },
    { flag: 'json', description: 'Output events as newline-delimited JSON' },
  ],
  examples: [
    'ironcurtain observe 3                 # Watch session #3',
    'ironcurtain observe --all             # Watch all sessions',
    'ironcurtain observe --workflow build   # Watch workflow "build"',
    'ironcurtain observe 3 --raw           # Include tool use and message markers',
    'ironcurtain observe --all --json      # NDJSON output for piping',
  ],
};

// ---------------------------------------------------------------------------
// Web UI state (persisted by daemon)
// ---------------------------------------------------------------------------

interface WebUiState {
  readonly port: number;
  readonly host: string;
  readonly token: string;
}

/** Reads daemon connection info from the well-known state file. */
function loadWebUiState(): WebUiState | null {
  try {
    const raw = readFileSync(getWebUiStatePath(), 'utf-8');
    return JSON.parse(raw) as WebUiState;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

let rpcIdCounter = 0;

function sendRpc(ws: WebSocket, method: string, params: Record<string, unknown> = {}): string {
  const id = `observe-${++rpcIdCounter}`;
  ws.send(JSON.stringify({ id, method, params }));
  return id;
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function runObserveCommand(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      all: { type: 'boolean' },
      workflow: { type: 'string' },
      raw: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: false,
  });

  if (checkHelp(values as { help?: boolean }, observeSpec)) return;

  const allMode = values.all as boolean | undefined;
  const workflowName = values.workflow as string | undefined;
  const labelArg = positionals[0];

  // Validate argument combinations
  if (!allMode && !workflowName && !labelArg) {
    process.stderr.write(chalk.red('Error: provide a session label, --all, or --workflow <name>\n'));
    process.exit(1);
  }
  if (labelArg && (allMode || workflowName)) {
    process.stderr.write(chalk.red('Error: cannot combine a session label with --all or --workflow\n'));
    process.exit(1);
  }
  if (allMode && workflowName) {
    process.stderr.write(chalk.red('Error: cannot combine --all with --workflow\n'));
    process.exit(1);
  }

  const label = labelArg ? parseInt(labelArg, 10) : undefined;
  if (labelArg && (label === undefined || !Number.isFinite(label) || label < 1)) {
    process.stderr.write(chalk.red(`Error: invalid session label "${labelArg}" (must be a positive integer)\n`));
    process.exit(1);
  }

  const renderOptions: RenderOptions = {
    raw: !!values.raw,
    json: !!values.json,
    showLabel: !!allMode || !!workflowName,
  };

  // Load daemon connection info
  const state = loadWebUiState();
  if (!state) {
    process.stderr.write(
      chalk.red('Error: cannot connect to daemon. Is the daemon running with --web-ui?\n') +
        chalk.dim('Start with: ironcurtain daemon --web-ui\n'),
    );
    process.exit(1);
  }

  // Connect to the daemon WebSocket
  const wsUrl = `ws://${state.host}:${state.port}/ws?token=${state.token}`;
  const ws = new WebSocket(wsUrl);

  // Track workflow session labels for --workflow filtering
  let workflowLabels: Set<number> | null = null;

  await new Promise<void>((resolve, reject) => {
    let subscribeId: string | null = null;
    let unsubscribeId: string | null = null;
    let sessionListId: string | null = null;
    let closing = false;

    const cleanup = () => {
      if (closing) return;
      closing = true;

      // Unsubscribe before closing
      if (ws.readyState === WebSocket.OPEN) {
        if (label !== undefined) {
          unsubscribeId = sendRpc(ws, 'sessions.unsubscribeTokenStream', { label });
        } else {
          unsubscribeId = sendRpc(ws, 'sessions.unsubscribeAllTokenStreams');
        }
        // Give a moment for the unsubscribe to send, then close
        setTimeout(() => {
          ws.close();
          resolve();
        }, 100);
      } else {
        resolve();
      }
    };

    // Handle Ctrl+C
    const sigHandler = () => {
      process.stderr.write(chalk.dim('\n'));
      cleanup();
    };
    process.on('SIGINT', sigHandler);
    process.on('SIGTERM', sigHandler);

    ws.on('open', () => {
      // Subscribe
      if (label !== undefined) {
        subscribeId = sendRpc(ws, 'sessions.subscribeTokenStream', { label });
      } else {
        subscribeId = sendRpc(ws, 'sessions.subscribeAllTokenStreams');
      }

      // If workflow mode, query sessions to find workflow members
      if (workflowName) {
        sessionListId = sendRpc(ws, 'sessions.list');
      }
    });

    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      const text = wsDataToString(data);

      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return;
      }

      // Response to a request
      if ('id' in frame && typeof frame.id === 'string') {
        if (frame.id === subscribeId) {
          if (frame.ok) {
            process.stderr.write(renderConnected(label));
          } else {
            const err = frame.error as { message?: string } | undefined;
            process.stderr.write(chalk.red(`Error: ${err?.message ?? 'subscription failed'}\n`));
            ws.close();
            resolve();
          }
          return;
        }
        if (frame.id === unsubscribeId) {
          // Unsubscribe response -- close handled by timeout
          return;
        }
        if (frame.id === sessionListId && frame.ok && workflowName) {
          // Filter sessions by workflow -- sessions don't currently expose
          // workflow membership directly, so this is a best-effort filter.
          // For now, we accept all sessions when using --workflow and rely
          // on the workflow name being part of the session persona or source.
          // This will be refined when workflow-session association is available.
          workflowLabels = new Set<number>();
          const payload = frame.payload as Array<{ label: number; source?: { kind: string; jobName?: string } }>;
          if (Array.isArray(payload)) {
            for (const s of payload) {
              workflowLabels.add(s.label);
            }
          }
          return;
        }
        return;
      }

      // Push event
      if ('event' in frame && typeof frame.event === 'string') {
        handlePushEvent(
          frame.event,
          frame.payload as Record<string, unknown>,
          renderOptions,
          label,
          workflowLabels,
          cleanup,
        );
      }
    });

    ws.on('error', (err: Error) => {
      process.stderr.write(chalk.red(`WebSocket error: ${err.message}\n`));
      reject(err);
    });

    ws.on('close', () => {
      process.off('SIGINT', sigHandler);
      process.off('SIGTERM', sigHandler);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Push event handler
// ---------------------------------------------------------------------------

function handlePushEvent(
  event: string,
  payload: Record<string, unknown>,
  options: RenderOptions,
  targetLabel: number | undefined,
  workflowLabels: Set<number> | null,
  cleanup: () => void,
): void {
  if (event === 'session.token_stream') {
    const label = payload.label as number;
    const events = payload.events as TokenStreamEvent[];

    // Workflow filtering: skip events from non-workflow sessions
    if (workflowLabels && !workflowLabels.has(label)) return;

    const output = renderEventBatch(label, events, options);
    if (output) {
      process.stdout.write(output);
    }
    return;
  }

  if (event === 'session.ended') {
    const endedLabel = payload.label as number;
    const reason = (payload.reason as string | undefined) ?? 'unknown';

    // For single-session mode, exit when the watched session ends
    if (targetLabel !== undefined && endedLabel === targetLabel) {
      process.stderr.write(renderSessionEnded(endedLabel, reason));
      cleanup();
      return;
    }

    // For multi-session modes, just show a notification
    if (targetLabel === undefined) {
      process.stderr.write(renderSessionEnded(endedLabel, reason));
      // Remove from workflow labels if tracking
      workflowLabels?.delete(endedLabel);
    }
  }
}
