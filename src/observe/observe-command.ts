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

import chalk from 'chalk';

import { checkHelp, parseArgsStrict, type CommandSpec } from '../cli-help.js';
import {
  createDaemonClient,
  discoverDaemon,
  type DaemonClient,
  type DaemonCloseInfo,
} from '../daemon-client/daemon-client.js';
import { renderEventBatch, renderConnected, renderSessionEnded, type RenderOptions } from './observe-renderer.js';
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
  const { values, positionals } = parseArgsStrict(
    {
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
    },
    observeSpec.name,
  );

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

  // Discover daemon connection info; "no daemon" surfaces identically to before.
  const endpoint = discoverDaemon();
  if (!endpoint) {
    tui?.destroy();
    printConnectionError();
    process.exit(1);
  }

  const client = createDaemonClient({ endpoint });

  try {
    await client.connect();
  } catch {
    // A connect failure is presentationally identical to "no daemon".
    tui?.destroy();
    printConnectionError();
    process.exit(1);
  }

  await runObserveSession(client, { label, useTui, tui, sink });
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

interface ObserveSessionContext {
  readonly label: number | undefined;
  readonly useTui: boolean;
  readonly tui: ObserveTui | null;
  readonly sink: ObserveEventSink;
}

/**
 * Drives a connected {@link DaemonClient}: subscribes to the token stream,
 * routes push events to the sink, and tears down on session end, involuntary
 * disconnect, or Ctrl+C. Resolves exactly once.
 */
async function runObserveSession(client: DaemonClient, ctx: ObserveSessionContext): Promise<void> {
  const { label, useTui, tui, sink } = ctx;

  await new Promise<void>((resolve) => {
    let closing = false;
    let unsubscribeEvents: (() => void) | null = null;
    let unsubscribeClose: (() => void) | null = null;
    let sigHandler: (() => void) | null = null;

    const removeSignalHandlers = () => {
      if (sigHandler) {
        process.off('SIGINT', sigHandler);
        process.off('SIGTERM', sigHandler);
        sigHandler = null;
      }
    };

    // Deliberate teardown: destroy TUI, unsubscribe, then close the client.
    // `client.close()` is what suppresses any onClose for this self-initiated
    // disconnect, so connectionLost never fires for our own cleanup.
    const cleanup = () => {
      if (closing) return;
      closing = true;

      // Destroy TUI before unsubscribing (restores terminal state).
      tui?.destroy();
      unsubscribeEvents?.();
      unsubscribeClose?.();
      removeSignalHandlers();

      const unsubscribe =
        label !== undefined
          ? client.call('sessions.unsubscribeTokenStream', { label })
          : client.call('sessions.unsubscribeAllTokenStreams');

      void unsubscribe
        .catch(() => {
          /* best-effort: we are tearing down regardless */
        })
        .then(() => client.close())
        .catch(() => {
          /* close() is idempotent and never throws meaningfully here */
        })
        .finally(resolve);
    };

    // Handle Ctrl+C -- only register for plain mode; TUI handles its own signals.
    if (!useTui) {
      sigHandler = () => {
        process.stderr.write(chalk.dim('\n'));
        cleanup();
      };
      process.on('SIGINT', sigHandler);
      process.on('SIGTERM', sigHandler);
    }

    unsubscribeEvents = client.onEvent((e) => {
      handlePushEvent(e.event, e.payload as Record<string, unknown>, sink, label, cleanup);
    });

    unsubscribeClose = client.onClose((info: DaemonCloseInfo) => {
      // An *involuntary* disconnect (our own cleanup uses client.close(), which
      // never fires onClose). Mirror the old ws 'error'/'close' behavior.
      if (closing) return;
      closing = true;
      removeSignalHandlers();
      sink.connectionLost(info.reason);
      // In TUI mode the TUI's own 3-second exit timer manages shutdown; the
      // promise resolves so runObserveCommand returns, but the TUI's frame loop
      // and stdin keep the event loop alive until its destroy() fires.
      resolve();
    });

    void subscribe(client, label, useTui).then((ok) => {
      if (closing) return;
      if (ok) {
        // In TUI mode the text panel shows state; in plain mode write to stderr.
        if (!useTui) process.stderr.write(renderConnected(label));
      } else {
        cleanup();
      }
    });
  });
}

/**
 * Subscribes to the token stream for `label` (or all sessions). Returns true on
 * success; on an RPC error, writes the plain-mode error and returns false.
 */
async function subscribe(client: DaemonClient, label: number | undefined, useTui: boolean): Promise<boolean> {
  const result =
    label !== undefined
      ? await client.call('sessions.subscribeTokenStream', { label })
      : await client.call('sessions.subscribeAllTokenStreams');

  if (result.ok) return true;

  // Match the old plain-mode behavior: TUI mode swallows the message (the panel
  // surfaces state); plain mode prints it. Cleanup is the caller's job.
  if (!useTui) {
    process.stderr.write(chalk.red(`Error: ${result.message || 'subscription failed'}\n`));
  }
  return false;
}

/** Prints the shared "cannot connect to daemon" guidance to stderr. */
function printConnectionError(): void {
  process.stderr.write(
    chalk.red('Error: cannot connect to daemon. Is the daemon running with --web-ui?\n') +
      chalk.dim('Start with: ironcurtain daemon --web-ui\n'),
  );
}
