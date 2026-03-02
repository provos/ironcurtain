/**
 * PtyBridge -- bridges a node-pty child process to a headless xterm terminal.
 *
 * Data flow:
 *   node-pty child -> raw bytes -> @xterm/headless Terminal.write()
 *   @xterm/headless buffer -> readBuffer() -> MuxRenderer
 *
 * Each PtyBridge instance owns:
 * - One node-pty child process (the `ironcurtain start --pty` invocation)
 * - One @xterm/headless Terminal (the virtual terminal buffer)
 * - The session's escalation directory path (for trusted input writes)
 */

import type { Terminal as TerminalType } from '@xterm/headless';
import xtermHeadless from '@xterm/headless';
const { Terminal } = xtermHeadless;
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
   * Registers a callback invoked when new output arrives.
   */
  onOutput(callback: () => void): void;

  /**
   * Registers a callback invoked when the child process exits.
   */
  onExit(callback: (exitCode: number) => void): void;

  /**
   * Registers a callback invoked when the child's session registration
   * is discovered (sessionId and escalationDir become available).
   */
  onSessionDiscovered(callback: (registration: PtySessionRegistration | null) => void): void;
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
}

/** Session discovery timeout (ms). */
const DISCOVERY_TIMEOUT_MS = 10_000;
/** Session discovery poll interval (ms). */
const DISCOVERY_POLL_MS = 200;

/**
 * Spawns a new `ironcurtain start --pty` child process via node-pty
 * and wires it to a headless xterm terminal.
 */
export async function createPtyBridge(options: PtyBridgeOptions): Promise<PtyBridge> {
  const nodePty = (await import('node-pty')) as typeof import('node-pty');

  const terminal = new Terminal({
    cols: options.cols,
    rows: options.rows,
    allowProposedApi: true,
  });

  const spawnArgs = [...(options.prefixArgs ?? []), 'start', '--pty', '--agent', options.agent];
  const child = nodePty.spawn(options.ironcurtainBin, spawnArgs, {
    cols: options.cols,
    rows: options.rows,
    name: 'xterm-256color',
    env: process.env as Record<string, string>,
  });

  const outputCallbacks: Array<() => void> = [];
  const exitCallbacks: Array<(exitCode: number) => void> = [];
  const sessionCallbacks: Array<(reg: PtySessionRegistration | null) => void> = [];

  let _alive = true;
  let _exitCode: number | undefined;
  let _sessionId: string | undefined;
  let _escalationDir: string | undefined;

  // Wire child output to headless terminal
  child.onData((data: string) => {
    terminal.write(data);
    for (const cb of outputCallbacks) cb();
  });

  child.onExit(({ exitCode }: { exitCode: number }) => {
    _alive = false;
    _exitCode = exitCode;
    for (const cb of exitCallbacks) cb(exitCode);
  });

  // Start session discovery
  void discoverSessionRegistration(child.pid).then((registration) => {
    if (registration) {
      _sessionId = registration.sessionId;
      _escalationDir = registration.escalationDir;
    }
    for (const cb of sessionCallbacks) cb(registration);
  });

  return {
    get terminal() {
      return terminal;
    },
    get sessionId() {
      return _sessionId;
    },
    get escalationDir() {
      return _escalationDir;
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
      if (_alive) child.kill();
    },

    onOutput(callback: () => void): void {
      outputCallbacks.push(callback);
    },

    onExit(callback: (exitCode: number) => void): void {
      exitCallbacks.push(callback);
    },

    onSessionDiscovered(callback: (reg: PtySessionRegistration | null) => void): void {
      // If already discovered, call immediately
      if (_sessionId !== undefined || !_alive) {
        const reg =
          _sessionId && _escalationDir
            ? ({ sessionId: _sessionId, escalationDir: _escalationDir } as PtySessionRegistration)
            : null;
        callback(reg);
        return;
      }
      sessionCallbacks.push(callback);
    },
  };
}

/**
 * Polls the PTY registry for a registration matching the child PID.
 */
async function discoverSessionRegistration(childPid: number): Promise<PtySessionRegistration | null> {
  const registryDir = getPtyRegistryDir();
  const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const registrations = readActiveRegistrations(registryDir);
    const match = registrations.find((r) => r.pid === childPid);
    if (match) return match;
    await new Promise((r) => setTimeout(r, DISCOVERY_POLL_MS));
  }
  return null;
}
