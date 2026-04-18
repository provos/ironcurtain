// src/logger.ts
//
// Module-level singleton: the process has one `console` object, so
// hijacking it requires a single claimant at a time. Lifecycle is
// "rented resource" semantics — a caller claims the singleton via
// `setup()`, releases it via `teardown()`.
//
// Typical claimants: a session (from `createDockerSession` /
// `createBuiltinSession`) or a long-lived daemon process
// (`ironcurtain daemon`). The daemon is a valid claimant because its
// entrypoint is the outermost owner of the process; it hands off to
// per-session claims when spawning work, then re-claims the
// singleton afterwards.
//
// Concurrent claims are NOT supported. In workflows with multiple
// per-state sessions, each session must tear down before the next
// one calls `setup()`. As a defense against missed teardown,
// `setup()` tolerates retargeting: called while another path is
// active, it redirects subsequent writes to the new path without
// dropping the console hijack.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerOptions {
  readonly logFilePath: string;
}

// --- Module state ---

let logFilePath: string | null = null;

/** Saved originals for restoration on teardown. */
let originalConsole: {
  log: typeof console.log;
  error: typeof console.error;
  warn: typeof console.warn;
  debug: typeof console.debug;
} | null = null;

// --- Lifecycle ---

export function setup(options: LoggerOptions): void {
  // Retargeting: if already active with a different path, redirect
  // subsequent writes to the new file but keep the existing console
  // hijack in place (no re-patching needed; writeEntry reads
  // logFilePath at call time). Same-path calls are a no-op.
  if (logFilePath !== null) {
    if (logFilePath === options.logFilePath) return;
    logFilePath = options.logFilePath;
    mkdirSync(dirname(logFilePath), { recursive: true });
    writeEntry('info', 'Logger retargeted');
    return;
  }

  logFilePath = options.logFilePath;

  // Ensure parent directory exists
  mkdirSync(dirname(logFilePath), { recursive: true });

  // Save originals before patching
  originalConsole = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    debug: console.debug,
  };

  // Intercept console methods -- redirect to log file
  console.log = (...args: unknown[]) => {
    writeEntry('info', `[console.log] ${formatArgs(args)}`);
  };
  console.error = (...args: unknown[]) => {
    writeEntry('error', `[console.error] ${formatArgs(args)}`);
  };
  console.warn = (...args: unknown[]) => {
    writeEntry('warn', `[console.warn] ${formatArgs(args)}`);
  };
  console.debug = (...args: unknown[]) => {
    writeEntry('debug', `[console.debug] ${formatArgs(args)}`);
  };

  writeEntry('info', 'Logger initialized');
}

export function teardown(): void {
  if (originalConsole) {
    console.log = originalConsole.log;
    console.error = originalConsole.error;
    console.warn = originalConsole.warn;
    console.debug = originalConsole.debug;
    originalConsole = null;
  }
  logFilePath = null;
}

export function isActive(): boolean {
  return logFilePath !== null;
}

// --- Logging functions ---

export function debug(message: string): void {
  writeEntry('debug', message);
}

export function info(message: string): void {
  writeEntry('info', message);
}

export function warn(message: string): void {
  writeEntry('warn', message);
}

export function error(message: string): void {
  writeEntry('error', message);
}

// --- Internal helpers ---

const LEVEL_PAD: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
};

function writeEntry(level: LogLevel, message: string): void {
  if (!logFilePath) return; // no-op when not set up
  const timestamp = new Date().toISOString();
  const line = `${timestamp} ${LEVEL_PAD[level]} ${message}\n`;
  try {
    appendFileSync(logFilePath, line);
  } catch {
    // Cannot log if the file is gone or disk is full.
    // Swallow to avoid crashing the agent over a logging failure.
  }
}

/**
 * Formats console.* arguments into a single string, mimicking
 * Node's util.format behavior for the common cases.
 */
function formatArgs(args: unknown[]): string {
  return args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
}
