/**
 * CLI entry point for `ironcurtain observe`.
 *
 * Connects to the daemon's WebSocket server, subscribes to token
 * stream events, and renders LLM output to stdout in real time.
 *
 * When stdout is a TTY (and --json is not set), the command uses a
 * full-screen TUI with a Matrix rain panel and formatted text panel.
 * Otherwise (pipe, --json, --no-tui), it falls back to the plain
 * line-oriented renderer.
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
import type { ObserveEventSink } from './observe-tui-types.js';
import { createObserveTui, type ObserveTui } from './observe-tui.js';

// ---------------------------------------------------------------------------
// Command spec (for --help)
// ---------------------------------------------------------------------------

const observeSpec: CommandSpec = {
  name: 'ironcurtain observe',
  description: 'Watch live LLM token output for running sessions',
  usage: [
    'ironcurtain observe <label>             Watch a single session by label',
    'ironcurtain observe --all               Watch all active sessions',
  ],
  options: [
    { flag: 'all', description: 'Observe all active sessions' },
    { flag: 'raw', description: 'Show all event types, not just text' },
    { flag: 'debug', description: 'Show all events including protocol noise (implies --raw)' },
    { flag: 'json', description: 'Output events as newline-delimited JSON' },
    { flag: 'no-tui', description: 'Disable TUI mode (plain text output)' },
  ],
  examples: [
    'ironcurtain observe 3                 # Watch session #3 (TUI mode)',
    'ironcurtain observe --all             # Watch all sessions',
    'ironcurtain observe 3 --no-tui        # Plain text output',
    'ironcurtain observe 3 --raw           # Show tool use + message markers in TUI',
    'ironcurtain observe 3 --debug         # Show everything including protocol noise',
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
// Plain renderer adapter
// ---------------------------------------------------------------------------

/**
 * Wraps the existing plain-text renderer functions into the
 * ObserveEventSink interface so observe-command can use either
 * the TUI or the plain renderer interchangeably.
 */
function createPlainSink(renderOptions: RenderOptions): ObserveEventSink {
  return {
    pushEvents(label: number, events: readonly TokenStreamEvent[]): void {
      const output = renderEventBatch(label, events, renderOptions);
      if (output) process.stdout.write(output);
    },
    sessionEnded(label: number, reason: string): void {
      process.stderr.write(renderSessionEnded(label, reason));
    },
    connectionLost(reason: string): void {
      process.stderr.write(`\nConnection lost: ${reason}\n`);
    },
  };
}

// ---------------------------------------------------------------------------
// Push event handler
// ---------------------------------------------------------------------------

/**
 * Routes a single WebSocket push event to the event sink.
 */
function handlePushEvent(
  event: string,
  payload: Record<string, unknown>,
  sink: ObserveEventSink,
  targetLabel: number | undefined,
  cleanup: () => void,
): void {
  if (event === 'session.token_stream') {
    const label = payload.label as number;
    const events = payload.events as TokenStreamEvent[];
    sink.pushEvents(label, events);
    return;
  }

  if (event === 'session.ended') {
    const endedLabel = payload.label as number;
    const reason = (payload.reason as string | undefined) ?? 'unknown';

    // For single-session mode, exit when the watched session ends
    if (targetLabel !== undefined && endedLabel === targetLabel) {
      sink.sessionEnded(endedLabel, reason);
      cleanup();
      return;
    }

    // For multi-session mode (--all), just show a notification
    if (targetLabel === undefined) {
      sink.sessionEnded(endedLabel, reason);
    }
  }
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function runObserveCommand(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      all: { type: 'boolean' },
      raw: { type: 'boolean' },
      debug: { type: 'boolean' },
      json: { type: 'boolean' },
      'no-tui': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: false,
  });

  if (checkHelp(values as { help?: boolean }, observeSpec)) return;

  const allMode = values.all as boolean | undefined;
  const labelArg = positionals[0];
  const noTui = values['no-tui'] as boolean | undefined;

  // Validate argument combinations
  if (!allMode && !labelArg) {
    process.stderr.write(chalk.red('Error: provide a session label or --all\n'));
    process.exit(1);
  }
  if (labelArg && allMode) {
    process.stderr.write(chalk.red('Error: cannot combine a session label with --all\n'));
    process.exit(1);
  }

  const label = labelArg ? parseInt(labelArg, 10) : undefined;
  if (labelArg && (label === undefined || !Number.isFinite(label) || label < 1)) {
    process.stderr.write(chalk.red(`Error: invalid session label "${labelArg}" (must be a positive integer)\n`));
    process.exit(1);
  }

  const showLabel = !!allMode;
  const debugMode = !!values.debug;

  const renderOptions: RenderOptions = {
    raw: !!values.raw || debugMode,
    json: !!values.json,
    showLabel,
  };

  // Mode selection: TUI when stdout is a TTY and not in JSON or --no-tui mode
  const isTty = process.stdout.isTTY;
  const useTui = isTty && !renderOptions.json && !noTui;

  // Create the event sink
  let sink: ObserveEventSink;
  let tui: ObserveTui | null = null;

  if (useTui) {
    tui = createObserveTui({ raw: !!values.raw || debugMode, showLabel, debug: debugMode });
    tui.start();
    sink = tui;
  } else {
    sink = createPlainSink(renderOptions);
  }

  // Load daemon connection info
  const state = loadWebUiState();
  if (!state) {
    tui?.destroy();
    process.stderr.write(
      chalk.red('Error: cannot connect to daemon. Is the daemon running with --web-ui?\n') +
        chalk.dim('Start with: ironcurtain daemon --web-ui\n'),
    );
    process.exit(1);
  }

  // Connect to the daemon WebSocket
  const wsUrl = `ws://${state.host}:${state.port}/ws?token=${state.token}`;
  const ws = new WebSocket(wsUrl);

  await new Promise<void>((resolve, reject) => {
    let subscribeId: string | null = null;
    let unsubscribeId: string | null = null;
    let closing = false;

    const cleanup = () => {
      if (closing) return;
      closing = true;

      // Destroy TUI before unsubscribing (restores terminal state)
      tui?.destroy();

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

    // Handle Ctrl+C -- only register for plain mode; TUI handles its own signals
    let sigHandler: (() => void) | null = null;
    if (!useTui) {
      sigHandler = () => {
        process.stderr.write(chalk.dim('\n'));
        cleanup();
      };
      process.on('SIGINT', sigHandler);
      process.on('SIGTERM', sigHandler);
    }

    ws.on('open', () => {
      // Subscribe
      if (label !== undefined) {
        subscribeId = sendRpc(ws, 'sessions.subscribeTokenStream', { label });
      } else {
        subscribeId = sendRpc(ws, 'sessions.subscribeAllTokenStreams');
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
            // In TUI mode the text panel shows state; in plain mode write to stderr
            if (!useTui) {
              process.stderr.write(renderConnected(label));
            }
          } else {
            const err = frame.error as { message?: string } | undefined;
            if (!useTui) {
              process.stderr.write(chalk.red(`Error: ${err?.message ?? 'subscription failed'}\n`));
            }
            cleanup();
          }
          return;
        }
        if (frame.id === unsubscribeId) {
          // Unsubscribe response -- close handled by timeout
          return;
        }
        return;
      }

      // Push event
      if ('event' in frame && typeof frame.event === 'string') {
        handlePushEvent(frame.event, frame.payload as Record<string, unknown>, sink, label, cleanup);
      }
    });

    ws.on('error', (err: Error) => {
      // Notify the sink of the connection loss
      sink.connectionLost(err.message);
      if (tui) {
        // TUI manages its own 3-second exit timer; do not destroy immediately.
        // The promise resolves so runObserveCommand returns, but the TUI's
        // frame loop and stdin keep the event loop alive until destroy() fires.
        resolve();
      } else {
        reject(err);
      }
    });

    ws.on('close', (code: number) => {
      // Remove signal handlers if we registered them (plain mode only)
      if (sigHandler) {
        process.off('SIGINT', sigHandler);
        process.off('SIGTERM', sigHandler);
      }

      // If not a clean close triggered by our cleanup, notify the sink
      if (!closing) {
        sink.connectionLost(`WebSocket closed (code ${code})`);
        // In TUI mode, the 3-second exit timer handles cleanup
      }

      resolve();
    });
  });
}
