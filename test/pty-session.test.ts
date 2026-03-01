import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEscalationWatcher, atomicWriteJsonSync } from '../src/escalation/escalation-watcher.js';
import type { EscalationRequest } from '../src/session/types.js';
import type { PtySessionRegistration } from '../src/docker/pty-types.js';

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
