import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createMuxEscalationManager } from '../src/mux/mux-escalation-manager.js';
import { atomicWriteJsonSync } from '../src/escalation/escalation-watcher.js';

describe('MuxEscalationManager', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-mux-esc-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('starts with empty state', () => {
    const manager = createMuxEscalationManager();
    expect(manager.pendingCount).toBe(0);
    expect(manager.state.sessions.size).toBe(0);
    manager.stop();
  });

  it('adding a session updates state', () => {
    const manager = createMuxEscalationManager();
    const escalationDir = resolve(tempDir, 'session1');
    mkdirSync(escalationDir, { recursive: true });

    manager.addSession({
      sessionId: 'session-1',
      escalationDir,
      label: 'test session',
      startedAt: new Date().toISOString(),
      pid: process.pid,
    });
    expect(manager.state.sessions.size).toBe(1);
    expect(manager.state.sessions.get('session-1')).toBeDefined();
    manager.stop();
  });

  it('removing a session updates state', () => {
    const manager = createMuxEscalationManager();
    const escalationDir = resolve(tempDir, 'session1');
    mkdirSync(escalationDir, { recursive: true });

    manager.addSession({
      sessionId: 'session-1',
      escalationDir,
      label: 'test session',
      startedAt: new Date().toISOString(),
      pid: process.pid,
    });
    manager.removeSession('session-1');
    expect(manager.state.sessions.size).toBe(0);
    manager.stop();
  });

  it('fires change callback on session add', () => {
    const manager = createMuxEscalationManager();
    let changed = false;
    manager.onChange(() => {
      changed = true;
    });

    const escalationDir = resolve(tempDir, 'session1');
    mkdirSync(escalationDir, { recursive: true });
    manager.addSession({
      sessionId: 'session-1',
      escalationDir,
      label: 'test session',
      startedAt: new Date().toISOString(),
      pid: process.pid,
    });

    expect(changed).toBe(true);
    manager.stop();
  });

  it('fires change callback on session remove', () => {
    const manager = createMuxEscalationManager();
    const escalationDir = resolve(tempDir, 'session1');
    mkdirSync(escalationDir, { recursive: true });
    manager.addSession({
      sessionId: 'session-1',
      escalationDir,
      label: 'test session',
      startedAt: new Date().toISOString(),
      pid: process.pid,
    });

    let changed = false;
    manager.onChange(() => {
      changed = true;
    });
    manager.removeSession('session-1');
    expect(changed).toBe(true);
    manager.stop();
  });

  it('detects pending escalation via watcher', async () => {
    const manager = createMuxEscalationManager();
    const escalationDir = resolve(tempDir, 'session1');
    mkdirSync(escalationDir, { recursive: true });
    manager.addSession({
      sessionId: 'session-1',
      escalationDir,
      label: 'test session',
      startedAt: new Date().toISOString(),
      pid: process.pid,
    });

    // Write an escalation request file
    const requestFile = resolve(escalationDir, 'request-test-123.json');
    atomicWriteJsonSync(requestFile, {
      escalationId: 'test-123',
      serverName: 'filesystem',
      toolName: 'write_file',
      arguments: { path: '/test' },
      reason: 'Test escalation',
    });

    // Wait for the watcher to poll (default 300ms)
    await new Promise((r) => setTimeout(r, 500));

    expect(manager.pendingCount).toBe(1);
    manager.stop();
  });

  it('resolve returns message for non-existent escalation', () => {
    const manager = createMuxEscalationManager();
    const result = manager.resolve(999, 'approved');
    expect(result).toContain('No pending escalation #999');
    manager.stop();
  });

  it('resolveAll returns message when no pending escalations', () => {
    const manager = createMuxEscalationManager();
    const result = manager.resolveAll('approved');
    expect(result).toBe('No pending escalations');
    manager.stop();
  });
});
