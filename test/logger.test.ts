import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import * as logger from '../src/logger.js';

describe('Logger', () => {
  let logDir: string;
  let logFile: string;

  beforeEach(() => {
    logDir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-logger-'));
    logFile = resolve(logDir, 'test.log');
  });

  afterEach(() => {
    logger.teardown(); // Always restore console, even if a test fails
    rmSync(logDir, { recursive: true, force: true });
  });

  it('writes entries with timestamp and level', () => {
    logger.setup({ logFilePath: logFile });
    logger.info('hello world');
    logger.teardown();

    const content = readFileSync(logFile, 'utf-8');
    expect(content).toContain('INFO ');
    expect(content).toContain('hello world');
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO timestamp
  });

  it('intercepts console.log and redirects to file', () => {
    logger.setup({ logFilePath: logFile });
    console.log('third-party noise');
    logger.teardown();

    const content = readFileSync(logFile, 'utf-8');
    expect(content).toContain('[console.log] third-party noise');
  });

  it('intercepts console.error and redirects to file', () => {
    logger.setup({ logFilePath: logFile });
    console.error('some error');
    logger.teardown();

    const content = readFileSync(logFile, 'utf-8');
    expect(content).toContain('[console.error] some error');
  });

  it('restores console methods on teardown', () => {
    const originalLog = console.log;
    logger.setup({ logFilePath: logFile });
    expect(console.log).not.toBe(originalLog);
    logger.teardown();
    expect(console.log).toBe(originalLog);
  });

  it('is a no-op when not set up', () => {
    // Should not throw, should not write anywhere
    logger.info('this goes nowhere');
    logger.error('neither does this');
  });

  it('is idempotent when setup() called twice without teardown()', () => {
    logger.setup({ logFilePath: logFile });
    // Second call should be a no-op, not throw
    logger.setup({ logFilePath: logFile });
    logger.info('after double setup');
    logger.teardown();

    const content = readFileSync(logFile, 'utf-8');
    expect(content).toContain('after double setup');
  });

  it('retargets to a new path when setup() is called with a different path', () => {
    // Simulates workflow state transitions: state A sets up, forgets to
    // teardown, state B calls setup() with its own path. setup() must
    // redirect writes to state B's file without losing the console
    // hijack or requiring a full re-init.
    const logFileA = resolve(logDir, 'state-a.log');
    const logFileB = resolve(logDir, 'state-b.log');

    logger.setup({ logFilePath: logFileA });
    logger.info('goes to A');

    // Retarget without teardown
    logger.setup({ logFilePath: logFileB });
    logger.info('goes to B');
    logger.teardown();

    const contentA = readFileSync(logFileA, 'utf-8');
    const contentB = readFileSync(logFileB, 'utf-8');

    // State A's file has only state A's write (plus the init line).
    expect(contentA).toContain('goes to A');
    expect(contentA).not.toContain('goes to B');

    // State B's file has only state B's write (plus the retarget line).
    expect(contentB).toContain('goes to B');
    expect(contentB).not.toContain('goes to A');
    expect(contentB).toContain('Logger retargeted');
  });

  it('session-like handoff: teardown + re-setup routes writes to the new log', () => {
    // Session A claims logger, writes, tears down. Session B claims
    // logger with a new path, writes, tears down. Writes must not
    // co-mingle. This is the regression guard for the workflow
    // per-state log bug: previously state B's setup was a no-op
    // because the singleton was still marked active from state A.
    const logFileA = resolve(logDir, 'session-a.log');
    const logFileB = resolve(logDir, 'session-b.log');

    logger.setup({ logFilePath: logFileA });
    logger.info('from A');
    logger.teardown();

    logger.setup({ logFilePath: logFileB });
    logger.info('from B');
    logger.teardown();

    const contentA = readFileSync(logFileA, 'utf-8');
    const contentB = readFileSync(logFileB, 'utf-8');

    expect(contentA).toContain('from A');
    expect(contentA).not.toContain('from B');
    expect(contentB).toContain('from B');
    expect(contentB).not.toContain('from A');
  });

  it('teardown() is idempotent', () => {
    logger.setup({ logFilePath: logFile });
    logger.teardown();
    logger.teardown(); // Should not throw
  });

  it('teardown() is safe when never set up', () => {
    logger.teardown(); // Should not throw
  });

  it('formats non-string console arguments as JSON', () => {
    logger.setup({ logFilePath: logFile });
    console.log('count:', 42, { key: 'value' });
    logger.teardown();

    const content = readFileSync(logFile, 'utf-8');
    expect(content).toContain('[console.log] count: 42 {"key":"value"}');
  });

  it('writes all four log levels', () => {
    logger.setup({ logFilePath: logFile });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    logger.teardown();

    const content = readFileSync(logFile, 'utf-8');
    expect(content).toContain('DEBUG d');
    expect(content).toContain('INFO  i');
    expect(content).toContain('WARN  w');
    expect(content).toContain('ERROR e');
  });

  it('isActive() reflects lifecycle state', () => {
    expect(logger.isActive()).toBe(false);
    logger.setup({ logFilePath: logFile });
    expect(logger.isActive()).toBe(true);
    logger.teardown();
    expect(logger.isActive()).toBe(false);
  });
});
