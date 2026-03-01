import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createEscalationWatcher,
  atomicWriteJsonSync,
  type EscalationWatcherEvents,
} from '../src/escalation/escalation-watcher.js';
import type { EscalationRequest } from '../src/session/types.js';

describe('atomicWriteJsonSync', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'atomic-write-test-'));
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('writes JSON atomically via temp-then-rename', () => {
    const filePath = join(tempDir, 'test.json');
    const data = { foo: 'bar', count: 42 };

    atomicWriteJsonSync(filePath, data);

    const content = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(content).toEqual(data);
  });

  it('does not leave temp file after successful write', () => {
    const filePath = join(tempDir, 'clean.json');
    atomicWriteJsonSync(filePath, { clean: true });

    expect(existsSync(`${filePath}.tmp`)).toBe(false);
    expect(existsSync(filePath)).toBe(true);
  });

  it('overwrites existing file', () => {
    const filePath = join(tempDir, 'overwrite.json');
    atomicWriteJsonSync(filePath, { version: 1 });
    atomicWriteJsonSync(filePath, { version: 2 });

    const content = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(content).toEqual({ version: 2 });
  });
});

describe('createEscalationWatcher', () => {
  let tempDir: string;
  let escalationDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    tempDir = mkdtempSync(join(tmpdir(), 'escalation-watcher-test-'));
    escalationDir = join(tempDir, 'escalations');
    mkdirSync(escalationDir, { recursive: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function writeRequest(escalationId: string, request?: Partial<EscalationRequest>): void {
    const full: EscalationRequest = {
      escalationId,
      toolName: 'write_file',
      serverName: 'filesystem',
      arguments: { path: '/etc/passwd' },
      reason: 'Protected path',
      ...request,
    };
    writeFileSync(join(escalationDir, `request-${escalationId}.json`), JSON.stringify(full));
  }

  /** Advance fake timers enough to trigger at least one poll cycle. */
  function advancePastPoll(): void {
    vi.advanceTimersByTime(60);
  }

  it('detects new escalation request via polling', () => {
    const escalations: EscalationRequest[] = [];
    const events: EscalationWatcherEvents = {
      onEscalation: (req) => escalations.push(req),
      onEscalationExpired: () => {},
    };

    const watcher = createEscalationWatcher(escalationDir, events, { pollIntervalMs: 50 });
    watcher.start();

    writeRequest('esc-001');

    advancePastPoll();

    expect(escalations).toHaveLength(1);
    expect(escalations[0].escalationId).toBe('esc-001');
    expect(watcher.getPending()?.escalationId).toBe('esc-001');

    watcher.stop();
  });

  it('does not emit the same escalation twice', () => {
    const escalations: EscalationRequest[] = [];
    const events: EscalationWatcherEvents = {
      onEscalation: (req) => escalations.push(req),
      onEscalationExpired: () => {},
    };

    const watcher = createEscalationWatcher(escalationDir, events, { pollIntervalMs: 50 });
    watcher.start();

    writeRequest('esc-002');
    advancePastPoll();

    // Resolve the escalation so the watcher can look for new ones
    watcher.resolve('esc-002', 'approved');
    advancePastPoll();

    // The same request file is still there but should not be emitted again
    expect(escalations).toHaveLength(1);

    watcher.stop();
  });

  it('resolves escalation by writing response file atomically', () => {
    const events: EscalationWatcherEvents = {
      onEscalation: () => {},
      onEscalationExpired: () => {},
    };

    const watcher = createEscalationWatcher(escalationDir, events, { pollIntervalMs: 50 });
    watcher.start();

    writeRequest('esc-003');
    advancePastPoll();

    expect(watcher.getPending()?.escalationId).toBe('esc-003');

    const accepted = watcher.resolve('esc-003', 'approved');
    expect(accepted).toBe(true);

    // Response file was written atomically (no leftover .tmp)
    const responsePath = join(escalationDir, 'response-esc-003.json');
    expect(existsSync(responsePath)).toBe(true);
    expect(existsSync(`${responsePath}.tmp`)).toBe(false);

    const response = JSON.parse(readFileSync(responsePath, 'utf-8'));
    expect(response.decision).toBe('approved');

    // Pending cleared after resolve
    expect(watcher.getPending()).toBeUndefined();

    watcher.stop();
  });

  it('resolve writes response file and returns true when request exists', () => {
    const events: EscalationWatcherEvents = {
      onEscalation: () => {},
      onEscalationExpired: () => {},
    };

    const watcher = createEscalationWatcher(escalationDir, events, { pollIntervalMs: 50 });
    watcher.start();

    writeRequest('esc-004');
    advancePastPoll();

    expect(watcher.getPending()).toBeDefined();
    const accepted = watcher.resolve('esc-004', 'denied');

    expect(accepted).toBe(true);

    const responsePath = join(escalationDir, 'response-esc-004.json');
    expect(existsSync(responsePath)).toBe(true);
    const response = JSON.parse(readFileSync(responsePath, 'utf-8'));
    expect(response.decision).toBe('denied');

    // No temp file left
    expect(existsSync(`${responsePath}.tmp`)).toBe(false);

    // Pending cleared
    expect(watcher.getPending()).toBeUndefined();

    watcher.stop();
  });

  it('resolve returns false when request has been cleaned up (expired)', () => {
    const events: EscalationWatcherEvents = {
      onEscalation: () => {},
      onEscalationExpired: () => {},
    };

    const watcher = createEscalationWatcher(escalationDir, events, { pollIntervalMs: 50 });
    watcher.start();

    writeRequest('esc-005');
    advancePastPoll();

    // Simulate proxy timeout cleanup: remove the request file
    rmSync(join(escalationDir, 'request-esc-005.json'));

    const accepted = watcher.resolve('esc-005', 'approved');
    expect(accepted).toBe(false);

    watcher.stop();
  });

  it('throws when resolving unknown escalation', () => {
    const events: EscalationWatcherEvents = {
      onEscalation: () => {},
      onEscalationExpired: () => {},
    };

    const watcher = createEscalationWatcher(escalationDir, events);
    expect(() => watcher.resolve('nonexistent', 'approved')).toThrow('No pending escalation');
  });

  it('detects escalation expiry when files are removed', () => {
    const expiredIds: string[] = [];
    const events: EscalationWatcherEvents = {
      onEscalation: () => {},
      onEscalationExpired: (id) => expiredIds.push(id),
    };

    const watcher = createEscalationWatcher(escalationDir, events, { pollIntervalMs: 50 });
    watcher.start();

    writeRequest('esc-006');
    advancePastPoll();

    expect(watcher.getPending()).toBeDefined();

    // Simulate proxy-side cleanup (both files removed = expired)
    rmSync(join(escalationDir, 'request-esc-006.json'));

    advancePastPoll();

    expect(expiredIds).toContain('esc-006');
    expect(watcher.getPending()).toBeUndefined();

    watcher.stop();
  });

  it('does not detect expiry when response file exists', () => {
    const expiredIds: string[] = [];
    const events: EscalationWatcherEvents = {
      onEscalation: () => {},
      onEscalationExpired: (id) => expiredIds.push(id),
    };

    const watcher = createEscalationWatcher(escalationDir, events, { pollIntervalMs: 50 });
    watcher.start();

    writeRequest('esc-007');
    advancePastPoll();

    // Remove request but leave a response (not expired -- response was written)
    rmSync(join(escalationDir, 'request-esc-007.json'));
    writeFileSync(join(escalationDir, 'response-esc-007.json'), JSON.stringify({ decision: 'approved' }));

    advancePastPoll();

    // Should NOT be considered expired because response exists
    expect(expiredIds).toHaveLength(0);

    watcher.stop();
  });

  it('start is idempotent', () => {
    const events: EscalationWatcherEvents = {
      onEscalation: () => {},
      onEscalationExpired: () => {},
    };

    const watcher = createEscalationWatcher(escalationDir, events);
    watcher.start();
    watcher.start(); // Should not throw or create duplicate intervals

    watcher.stop();
  });

  it('stop is idempotent', () => {
    const events: EscalationWatcherEvents = {
      onEscalation: () => {},
      onEscalationExpired: () => {},
    };

    const watcher = createEscalationWatcher(escalationDir, events);
    watcher.start();
    watcher.stop();
    watcher.stop(); // Should not throw
  });

  it('handles missing escalation directory gracefully', () => {
    const nonExistentDir = join(tempDir, 'does-not-exist');
    const events: EscalationWatcherEvents = {
      onEscalation: () => {},
      onEscalationExpired: () => {},
    };

    const watcher = createEscalationWatcher(nonExistentDir, events, { pollIntervalMs: 50 });
    watcher.start();

    // Should not throw during polling
    advancePastPoll();

    expect(watcher.getPending()).toBeUndefined();
    watcher.stop();
  });

  it('picks up next escalation after resolving previous', () => {
    const escalations: EscalationRequest[] = [];
    const events: EscalationWatcherEvents = {
      onEscalation: (req) => escalations.push(req),
      onEscalationExpired: () => {},
    };

    const watcher = createEscalationWatcher(escalationDir, events, { pollIntervalMs: 50 });
    watcher.start();

    writeRequest('esc-008');
    advancePastPoll();

    watcher.resolve('esc-008', 'approved');

    // Write a second escalation
    writeRequest('esc-009', { toolName: 'delete_file' });
    advancePastPoll();

    expect(escalations).toHaveLength(2);
    expect(escalations[1].escalationId).toBe('esc-009');

    watcher.stop();
  });
});
