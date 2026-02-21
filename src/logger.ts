// src/logger.ts

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
  if (logFilePath !== null) {
    throw new Error('Logger already set up. Call teardown() first.');
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
