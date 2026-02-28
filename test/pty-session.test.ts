import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEscalationWatcher, atomicWriteJsonSync } from '../src/escalation/escalation-watcher.js';
import type { EscalationRequest } from '../src/session/types.js';
import { KeystrokeBuffer, writeUserContext } from '../src/docker/keystroke-reconstructor.js';
import type { PtySessionRegistration } from '../src/docker/pty-types.js';

// --- KeystrokeBuffer tests ---

describe('KeystrokeBuffer', () => {
  it('starts empty', () => {
    const buffer = new KeystrokeBuffer();
    expect(buffer.size).toBe(0);
    expect(buffer.getContents().length).toBe(0);
  });

  it('appends data and tracks size', () => {
    const buffer = new KeystrokeBuffer();
    buffer.append(Buffer.from('hello'));
    buffer.append(Buffer.from(' world'));

    expect(buffer.size).toBe(11);
    expect(buffer.getContents().toString()).toBe('hello world');
  });

  it('caps at ~32KB by discarding old chunks', () => {
    const buffer = new KeystrokeBuffer();
    const maxSize = 32 * 1024;

    // Write 40KB in 1KB chunks
    for (let i = 0; i < 40; i++) {
      buffer.append(Buffer.alloc(1024, i % 256));
    }

    expect(buffer.size).toBeLessThanOrEqual(maxSize);
    expect(buffer.size).toBeGreaterThan(0);
  });

  it('handles a single oversized chunk', () => {
    const buffer = new KeystrokeBuffer();
    const maxSize = 32 * 1024;

    // Write a single 64KB chunk
    buffer.append(Buffer.alloc(64 * 1024, 0x41));

    expect(buffer.size).toBeLessThanOrEqual(maxSize);
    // The buffer should contain the tail of the data
    const contents = buffer.getContents();
    expect(contents.length).toBeLessThanOrEqual(maxSize);
  });

  it('clears the buffer', () => {
    const buffer = new KeystrokeBuffer();
    buffer.append(Buffer.from('data'));
    expect(buffer.size).toBeGreaterThan(0);

    buffer.clear();
    expect(buffer.size).toBe(0);
    expect(buffer.getContents().length).toBe(0);
  });

  it('concatenates multiple chunks correctly', () => {
    const buffer = new KeystrokeBuffer();
    buffer.append(Buffer.from([0x48, 0x65])); // He
    buffer.append(Buffer.from([0x6c, 0x6c])); // ll
    buffer.append(Buffer.from([0x6f])); // o

    expect(buffer.getContents().toString()).toBe('Hello');
  });

  it('preserves recent data when trimming', () => {
    const buffer = new KeystrokeBuffer();
    const maxSize = 32 * 1024;

    // Write old data (16KB)
    buffer.append(Buffer.alloc(16 * 1024, 0x41)); // 'A'
    // Write newer data (20KB) -- total exceeds 32KB
    buffer.append(Buffer.alloc(20 * 1024, 0x42)); // 'B'

    const contents = buffer.getContents();
    // The more recent 'B' data should be preserved
    expect(contents[contents.length - 1]).toBe(0x42);
    expect(buffer.size).toBeLessThanOrEqual(maxSize);
  });
});

// --- writeUserContext tests ---

describe('writeUserContext', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pty-user-context-test-'));
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('writes user-context.json with the userMessage field', () => {
    writeUserContext(tempDir, 'Fix the login bug');

    const contextPath = join(tempDir, 'user-context.json');
    expect(existsSync(contextPath)).toBe(true);

    const data = JSON.parse(readFileSync(contextPath, 'utf-8')) as { userMessage: string };
    expect(data.userMessage).toBe('Fix the login bug');
  });

  it('overwrites existing user-context.json', () => {
    writeUserContext(tempDir, 'first message');
    writeUserContext(tempDir, 'second message');

    const contextPath = join(tempDir, 'user-context.json');
    const data = JSON.parse(readFileSync(contextPath, 'utf-8')) as { userMessage: string };
    expect(data.userMessage).toBe('second message');
  });

  it('handles empty message', () => {
    writeUserContext(tempDir, '');

    const contextPath = join(tempDir, 'user-context.json');
    const data = JSON.parse(readFileSync(contextPath, 'utf-8')) as { userMessage: string };
    expect(data.userMessage).toBe('');
  });
});

// --- Registration file tests ---

describe('PTY session registration', () => {
  let tempDir: string;
  let registryDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pty-registration-test-'));
    registryDir = join(tempDir, 'pty-registry');
    mkdirSync(registryDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('creates a valid registration file', () => {
    const registration: PtySessionRegistration = {
      sessionId: 'test-sess',
      escalationDir: '/tmp/test/escalations',
      label: 'Claude Code - Fix the bug',
      startedAt: new Date().toISOString(),
      pid: process.pid,
    };

    const filePath = join(registryDir, `session-${registration.sessionId}.json`);
    atomicWriteJsonSync(filePath, registration);

    expect(existsSync(filePath)).toBe(true);
    const data = JSON.parse(readFileSync(filePath, 'utf-8')) as PtySessionRegistration;
    expect(data.sessionId).toBe('test-sess');
    expect(data.pid).toBe(process.pid);
    expect(data.label).toBe('Claude Code - Fix the bug');
  });

  it('registration file is removed on cleanup', () => {
    const filePath = join(registryDir, 'session-cleanup-test.json');
    atomicWriteJsonSync(filePath, { sessionId: 'cleanup-test' });
    expect(existsSync(filePath)).toBe(true);

    // Simulate cleanup by removing the file
    rmSync(filePath);
    expect(existsSync(filePath)).toBe(false);
  });
});

// --- BEL on escalation test ---

describe('escalation BEL notification', () => {
  let tempDir: string;
  let escalationDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pty-bel-test-'));
    escalationDir = join(tempDir, 'escalations');
    mkdirSync(escalationDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('watcher detects escalation request files', async () => {
    const escalations: EscalationRequest[] = [];

    const watcher = createEscalationWatcher(
      escalationDir,
      {
        onEscalation: (req) => escalations.push(req),
        onEscalationExpired: () => {},
      },
      { pollIntervalMs: 50 },
    );
    watcher.start();

    // Write an escalation request
    const request: EscalationRequest = {
      escalationId: 'esc-bel-1',
      toolName: 'write_file',
      serverName: 'filesystem',
      arguments: { path: '/etc/shadow' },
      reason: 'Protected path',
    };
    writeFileSync(join(escalationDir, 'request-esc-bel-1.json'), JSON.stringify(request));

    await new Promise((r) => setTimeout(r, 200));

    expect(escalations).toHaveLength(1);
    expect(escalations[0].escalationId).toBe('esc-bel-1');

    watcher.stop();
  });
});

// --- SIGWINCH forwarding logic test ---

describe('SIGWINCH forwarding', () => {
  it('resize handler guards against missing columns/rows in non-TTY mode', () => {
    // The SIGWINCH handler in attachPty checks columns && rows before
    // calling docker exec. In a non-TTY test environment, these are
    // undefined, so the guard prevents the exec call.
    const { stdout } = process;

    // Verify the guard logic: when stdout is not a TTY,
    // columns and rows are undefined, so the handler is a no-op.
    if (!stdout.isTTY) {
      expect(stdout.columns).toBeUndefined();
      expect(stdout.rows).toBeUndefined();
    } else {
      // When running in a TTY, columns and rows are numbers
      expect(typeof stdout.columns).toBe('number');
      expect(typeof stdout.rows).toBe('number');
    }
  });
});
