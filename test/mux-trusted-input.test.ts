import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { writeTrustedUserContext } from '../src/mux/trusted-input.js';

describe('writeTrustedUserContext', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-mux-trusted-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes correct JSON', () => {
    writeTrustedUserContext(tempDir, 'push my changes to origin');

    const contextPath = resolve(tempDir, 'user-context.json');
    const data = JSON.parse(readFileSync(contextPath, 'utf-8')) as Record<string, unknown>;

    expect(data.userMessage).toBe('push my changes to origin');
  });

  it('includes source: "mux-trusted-input"', () => {
    writeTrustedUserContext(tempDir, 'test message');

    const contextPath = resolve(tempDir, 'user-context.json');
    const data = JSON.parse(readFileSync(contextPath, 'utf-8')) as Record<string, unknown>;

    expect(data.source).toBe('mux-trusted-input');
  });

  it('includes ISO 8601 timestamp', () => {
    const before = new Date().toISOString();
    writeTrustedUserContext(tempDir, 'test message');
    const after = new Date().toISOString();

    const contextPath = resolve(tempDir, 'user-context.json');
    const data = JSON.parse(readFileSync(contextPath, 'utf-8')) as Record<string, unknown>;

    expect(typeof data.timestamp).toBe('string');
    expect((data.timestamp as string) >= before).toBe(true);
    expect((data.timestamp as string) <= after).toBe(true);
  });

  it('uses atomic write (no .tmp file left behind)', () => {
    writeTrustedUserContext(tempDir, 'test message');

    const files = readdirSync(tempDir);
    const tmpFiles = files.filter((f) => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('overwrites previous context file', () => {
    writeTrustedUserContext(tempDir, 'first message');
    writeTrustedUserContext(tempDir, 'second message');

    const contextPath = resolve(tempDir, 'user-context.json');
    const data = JSON.parse(readFileSync(contextPath, 'utf-8')) as Record<string, unknown>;

    expect(data.userMessage).toBe('second message');
  });
});
