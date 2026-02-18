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

  it('throws if setup() called twice without teardown()', () => {
    logger.setup({ logFilePath: logFile });
    expect(() => logger.setup({ logFilePath: logFile })).toThrow(
      'Logger already set up',
    );
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
