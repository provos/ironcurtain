/**
 * PtyBridge -- bridges a node-pty child process to a headless xterm terminal.
 *
 * Data flow:
 *   node-pty child -> raw bytes -> @xterm/headless Terminal.write()
 *   @xterm/headless buffer -> readBuffer() -> MuxRenderer   (grid sink, mux)
 *   @xterm/headless buffer -> onData(chunk) -> WS stream    (stream sink, web-ui)
 *
 * Each PtyBridge instance owns:
 * - One node-pty child process (the `ironcurtain start --pty` invocation)
 * - One @xterm/headless Terminal (the virtual terminal buffer + scrollback)
 * - The session's escalation directory path (for trusted input writes)
 *
 * Leaf module under src/pty/: both `mux/` (grid sink) and `web-ui/` (stream sink)
 * consume it, so it must not import from either.
 */

import type { Terminal as TerminalType } from '@xterm/headless';
import xtermHeadless from '@xterm/headless';
const { Terminal } = xtermHeadless;
import serializeAddonPkg from '@xterm/addon-serialize';
const { SerializeAddon } = serializeAddonPkg;
import { getPtyRegistryDir } from '../config/paths.js';
import { readActiveRegistrations } from '../escalation/session-registry.js';
import type { PtySessionRegistration } from '../docker/pty-types.js';

export interface PtyBridge {
  /** The headless terminal instance for reading buffer state. */
  readonly terminal: TerminalType;

  /** The session ID (extracted from child process registration). */
  readonly sessionId: string | undefined;

  /** The escalation directory path for this session. */
  readonly escalationDir: string | undefined;

  /** Whether the child process is still running. */
  readonly alive: boolean;

  /** The child process exit code, if exited. */
  readonly exitCode: number | undefined;

  /** The child process PID. */
  readonly pid: number;

  /**
   * Writes raw bytes to the child process's PTY stdin.
   * Used in PTY mode to forward keystrokes.
   */
  write(data: string): void;

  /**
   * Resizes the child PTY and the headless terminal.
   */
  resize(cols: number, rows: number): void;

  /**
   * Kills the child process and cleans up resources.
   */
  kill(): void;

  /**
   * Registers a callback invoked when new output arrives (a "something changed"
   * signal with no payload). This is the GRID sink used by the mux renderer.
   */
  onOutput(callback: () => void): void;

  /**
   * Registers a callback invoked with each raw output chunk from the child.
   * The callback fires AFTER the headless terminal buffer has been updated with
   * the chunk, so a `serialize()` taken inside the callback already reflects it
   * (the reconnect ordering invariant). Returns an unsubscribe function. This is
   * the STREAM sink used by the web-ui to forward bytes to a browser xterm; the
   * mux grid sink ignores it.
   */
  onData(callback: (chunk: string) => void): () => void;

  /**
   * Serializes the current screen + scrollback (the alternate buffer is included)
   * into a replayable ANSI string, for reconnect replay into a fresh xterm.
   * Backed by `@xterm/addon-serialize`. Pass `{ scrollback }` to cap the replayed
   * scrollback tail (the alternate buffer has no scrollback, so a live TUI's
   * snapshot is tiny regardless).
   */
  serialize(options?: { scrollback?: number }): string;

  /**
   * Registers a callback invoked when the child process exits.
   */
  onExit(callback: (exitCode: number) => void): void;

  /**
   * Registers a callback invoked when the child's session registration
   * is discovered (sessionId and escalationDir become available).
   */
  onSessionDiscovered(callback: (registration: PtySessionRegistration | null) => void): void;

  /**
   * Updates the registration if not already set (e.g. from late discovery
   * via the escalation manager's registry polling). Fires any queued
   * session callbacks.
   */
  updateRegistration(registration: PtySessionRegistration): void;
}

export interface PtyBridgeOptions {
  /** Columns for the initial PTY size. */
  readonly cols: number;
  /** Rows for the initial PTY size. */
  readonly rows: number;
  /** The ironcurtain binary path (or runtime like tsx/node). */
  readonly ironcurtainBin: string;
  /** Extra args to insert before the 'start' subcommand (e.g. the script path when running via tsx). */
  readonly prefixArgs?: string[];
  /** Agent to pass to --agent flag. */
  readonly agent: string;
  /** Optional workspace directory path (passed as --workspace to the child). */
  readonly workspacePath?: string;
  /** Optional session ID to resume (passed as --resume to the child). */
  readonly resumeSessionId?: string;
  /** Optional persona name (passed as --persona to the child). */
  readonly persona?: string;
  /** Optional provider-profile name (passed as --provider-profile to the child). */
  readonly providerProfileName?: string;
  /** Optional model ID override (passed as --model to the child). */
  readonly model?: string;
  /** When true, pass `--capture-traces` to the child `ironcurtain start --pty`. */
  readonly captureTraces?: boolean;
  /** Mux instance ID to propagate to child sessions via env var. */
  readonly muxId?: string;
  /** Mux process PID to propagate to child sessions via env var. */
  readonly muxPid?: number;
}

/**
 * Builds the child `ironcurtain start --pty` argv from the bridge options.
 *
 * Pure and exported so the argv construction is unit-testable (F6) without
 * spawning a process. Order: prefix args (tsx loader/script path) → the
 * `start --pty --agent <agent>` base → the optional per-session selection
 * flags (`--resume`, `--workspace`, `--persona`, `--provider-profile`,
 * `--model`, `--capture-traces`). Each flag is appended only when set.
 */
export function buildSpawnArgs(options: PtyBridgeOptions): string[] {
  const spawnArgs = [...(options.prefixArgs ?? []), 'start', '--pty', '--agent', options.agent];
  if (options.resumeSessionId) {
    spawnArgs.push('--resume', options.resumeSessionId);
  }
  if (options.workspacePath) {
    spawnArgs.push('--workspace', options.workspacePath);
  }
  if (options.persona) {
    spawnArgs.push('--persona', options.persona);
  }
  if (options.providerProfileName) {
    spawnArgs.push('--provider-profile', options.providerProfileName);
  }
  if (options.model) {
    spawnArgs.push('--model', options.model);
  }
  if (options.captureTraces) {
    spawnArgs.push('--capture-traces');
  }
  return spawnArgs;
}

/** Session discovery timeout (ms). */
const DISCOVERY_TIMEOUT_MS = 10_000;
/** Session discovery poll interval (ms). */
const DISCOVERY_POLL_MS = 200;
/** Headless scrollback cap (lines). Bounds daemon memory on long-running sessions. */
const SCROLLBACK_LINES = 5000;

/**
 * Spawns a new `ironcurtain start --pty` child process via node-pty
 * and wires it to a headless xterm terminal.
 */
export async function createPtyBridge(options: PtyBridgeOptions): Promise<PtyBridge> {
  const nodePty = (await import('node-pty')) as typeof import('node-pty');

  const terminal = new Terminal({
    cols: options.cols,
    rows: options.rows,
    scrollback: SCROLLBACK_LINES,
    allowProposedApi: true,
  });
  const serializeAddon = new SerializeAddon();
  terminal.loadAddon(serializeAddon);

  const spawnArgs = buildSpawnArgs(options);
  // Create a copy of process.env so we don't mutate the shared object
  const childEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (options.muxId) {
    childEnv.IRONCURTAIN_MUX_ID = options.muxId;
  }
  if (options.muxPid !== undefined) {
    childEnv.IRONCURTAIN_MUX_PID = String(options.muxPid);
  }

  const child = nodePty.spawn(options.ironcurtainBin, spawnArgs, {
    cols: options.cols,
    rows: options.rows,
    name: 'xterm-256color',
    env: childEnv,
  });

  const outputCallbacks: Array<() => void> = [];
  const dataCallbacks: Array<(chunk: string) => void> = [];
  const exitCallbacks: Array<(exitCode: number) => void> = [];
  const sessionCallbacks: Array<(reg: PtySessionRegistration | null) => void> = [];

  let _alive = true;
  let _exitCode: number | undefined;
  let _registration: PtySessionRegistration | null | undefined;

  // Wire child output to the headless terminal. Both sinks fire from INSIDE the
  // write callback so the buffer already reflects `data`: the grid sink
  // (onOutput) first -- unchanged mux ordering -- then the stream sink (onData),
  // which guarantees a serialize() taken in an onData handler includes the chunk.
  child.onData((data: string) => {
    terminal.write(data, () => {
      for (const cb of outputCallbacks) cb();
      for (const cb of dataCallbacks) cb(data);
    });
  });

  const discoveryAbort = new AbortController();

  child.onExit(({ exitCode }: { exitCode: number }) => {
    _alive = false;
    _exitCode = exitCode;
    discoveryAbort.abort();
    // If discovery hasn't resolved yet, flush callbacks with null
    if (_registration === undefined) {
      _registration = null;
      for (const cb of sessionCallbacks) cb(null);
      sessionCallbacks.length = 0;
    }
    for (const cb of exitCallbacks) cb(exitCode);
  });

  // Start session discovery
  void discoverSessionRegistration(child.pid, discoveryAbort.signal).then((registration) => {
    if (!_alive) return; // child already exited; ignore late result
    _registration = registration;
    for (const cb of sessionCallbacks) cb(registration);
    sessionCallbacks.length = 0;
  });

  return {
    get terminal() {
      return terminal;
    },
    get sessionId() {
      return _registration?.sessionId;
    },
    get escalationDir() {
      return _registration?.escalationDir;
    },
    get alive() {
      return _alive;
    },
    get exitCode() {
      return _exitCode;
    },
    get pid() {
      return child.pid;
    },

    write(data: string): void {
      if (_alive) child.write(data);
    },

    resize(cols: number, rows: number): void {
      if (_alive) child.resize(cols, rows);
      terminal.resize(cols, rows);
    },

    kill(): void {
      if (_alive) child.kill('SIGTERM');
    },

    onOutput(callback: () => void): void {
      outputCallbacks.push(callback);
    },

    onData(callback: (chunk: string) => void): () => void {
      dataCallbacks.push(callback);
      return () => {
        const idx = dataCallbacks.indexOf(callback);
        if (idx !== -1) dataCallbacks.splice(idx, 1);
      };
    },

    serialize(options?: { scrollback?: number }): string {
      return serializeAddon.serialize(options);
    },

    onExit(callback: (exitCode: number) => void): void {
      if (!_alive && _exitCode !== undefined) {
        callback(_exitCode);
        return;
      }
      exitCallbacks.push(callback);
    },

    onSessionDiscovered(callback: (reg: PtySessionRegistration | null) => void): void {
      // If already discovered, call immediately with the stored registration
      if (_registration !== undefined || !_alive) {
        callback(_registration ?? null);
        return;
      }
      sessionCallbacks.push(callback);
    },

    updateRegistration(registration: PtySessionRegistration): void {
      if (_registration) return; // already have one
      _registration = registration;
      for (const cb of sessionCallbacks) cb(registration);
      sessionCallbacks.length = 0;
    },
  };
}

/**
 * Polls the PTY registry for a registration matching the child PID.
 * Stops early if the abort signal fires (e.g. child exited).
 */
async function discoverSessionRegistration(
  childPid: number,
  signal: AbortSignal,
): Promise<PtySessionRegistration | null> {
  const registryDir = getPtyRegistryDir();
  const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;

  while (Date.now() < deadline && !signal.aborted) {
    const registrations = readActiveRegistrations(registryDir);
    const match = registrations.find((r) => r.pid === childPid);
    if (match) return match;
    await new Promise((r) => setTimeout(r, DISCOVERY_POLL_MS));
  }
  return null;
}
