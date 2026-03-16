import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createMuxEscalationManager } from '../src/mux/mux-escalation-manager.js';
import { atomicWriteJsonSync } from '../src/escalation/escalation-watcher.js';
import type { PtySessionRegistration } from '../src/docker/pty-types.js';

// Mock modules used by registry polling
vi.mock('../src/escalation/session-registry.js', () => ({
  readActiveRegistrations: vi.fn().mockReturnValue([]),
}));

vi.mock('../src/config/paths.js', () => ({
  getListenerLockPath: vi.fn().mockReturnValue('/tmp/nonexistent-lock'),
  getPtyRegistryDir: vi.fn().mockReturnValue('/tmp/ironcurtain-test-registry'),
}));

// Partial mock: keep isPidAlive mockable while preserving acquireLock/releaseLock
vi.mock('../src/escalation/listener-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/escalation/listener-lock.js')>();
  return {
    ...actual,
    isPidAlive: vi.fn().mockReturnValue(true),
  };
});

// Partial mock for node:fs: keep real implementations except readFileSync for lock file checks
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    // readFileSync is overridden so isStandaloneListenerRunning() can be controlled
    readFileSync: vi.fn((...args: Parameters<typeof actual.readFileSync>) => {
      const path = typeof args[0] === 'string' ? args[0] : '';
      // Intercept only the lock file path reads
      if (path.includes('nonexistent-lock') || path.includes('escalation-listener.lock')) {
        throw new Error('ENOENT');
      }
      return actual.readFileSync(...args);
    }),
  };
});

describe('MuxEscalationManager', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-mux-esc-'));
    vi.clearAllMocks();
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

  it('re-adding a session stops the old watcher (no duplicate escalations)', async () => {
    const manager = createMuxEscalationManager();
    const escalationDir = resolve(tempDir, 'session1');
    mkdirSync(escalationDir, { recursive: true });

    const registration = {
      sessionId: 'session-1',
      escalationDir,
      label: 'test session',
      startedAt: new Date().toISOString(),
      pid: process.pid,
    };

    // Simulate the race: registry polling adds the session first
    manager.addSession(registration);
    // Then bridge discovery adds it again (same session ID)
    manager.addSession(registration);

    // Should still be just one session
    expect(manager.state.sessions.size).toBe(1);

    // Write an escalation request file
    const requestFile = resolve(escalationDir, 'request-dup-test.json');
    atomicWriteJsonSync(requestFile, {
      escalationId: 'dup-test',
      serverName: 'filesystem',
      toolName: 'write_file',
      arguments: { path: '/test' },
      reason: 'Test escalation',
    });

    // Wait for the watcher to poll (default 300ms)
    await new Promise((r) => setTimeout(r, 500));

    // Should only have 1 pending escalation, not 2
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

  describe('ownership filtering during registry polling', () => {
    const OUR_MUX_ID = 'mux-aaaa1111';
    const OTHER_MUX_ID = 'mux-bbbb2222';

    function makeRegistration(
      sessionId: string,
      overrides: Partial<PtySessionRegistration> = {},
    ): PtySessionRegistration {
      const escalationDir = resolve(tempDir, sessionId);
      mkdirSync(escalationDir, { recursive: true });
      return {
        sessionId,
        escalationDir,
        label: `test ${sessionId}`,
        startedAt: new Date().toISOString(),
        pid: process.pid,
        ...overrides,
      };
    }

    /** Triggers one registry poll tick by advancing the fake timer. */
    async function triggerPoll(): Promise<void> {
      vi.advanceTimersByTime(1100);
      // Flush microtasks so any async callbacks settle
      await vi.runAllTimersAsync().catch(() => {});
    }

    let readActiveRegistrationsMock: ReturnType<typeof vi.fn>;
    let isPidAliveMock: ReturnType<typeof vi.fn>;
    let readFileSyncMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      vi.useFakeTimers();
      const sessionRegistry = await import('../src/escalation/session-registry.js');
      readActiveRegistrationsMock = sessionRegistry.readActiveRegistrations as ReturnType<typeof vi.fn>;
      const listenerLock = await import('../src/escalation/listener-lock.js');
      isPidAliveMock = listenerLock.isPidAlive as ReturnType<typeof vi.fn>;
      const fs = await import('node:fs');
      readFileSyncMock = fs.readFileSync as ReturnType<typeof vi.fn>;
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('picks up registrations with matching muxId', async () => {
      const reg = makeRegistration('sess-own', { muxId: OUR_MUX_ID, muxPid: process.pid });
      readActiveRegistrationsMock.mockReturnValue([reg]);

      const manager = createMuxEscalationManager({ muxId: OUR_MUX_ID });
      manager.startRegistryPolling();

      await triggerPoll();

      expect(manager.state.sessions.size).toBe(1);
      expect(manager.state.sessions.has('sess-own')).toBe(true);
      manager.stop();
    });

    it('ignores registrations with different muxId when owning mux is alive', async () => {
      const reg = makeRegistration('sess-other', { muxId: OTHER_MUX_ID, muxPid: 12345 });
      readActiveRegistrationsMock.mockReturnValue([reg]);
      // The other mux process is alive
      isPidAliveMock.mockReturnValue(true);

      const manager = createMuxEscalationManager({ muxId: OUR_MUX_ID });
      manager.startRegistryPolling();

      await triggerPoll();

      expect(manager.state.sessions.size).toBe(0);
      manager.stop();
    });

    it('reclaims orphaned registrations (different muxId, dead muxPid)', async () => {
      const reg = makeRegistration('sess-orphan', { muxId: OTHER_MUX_ID, muxPid: 999999999 });
      readActiveRegistrationsMock.mockReturnValue([reg]);
      // The other mux process is dead
      isPidAliveMock.mockReturnValue(false);
      // No standalone listener running (lock file read throws)
      readFileSyncMock.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const manager = createMuxEscalationManager({ muxId: OUR_MUX_ID });
      manager.startRegistryPolling();

      await triggerPoll();

      expect(manager.state.sessions.size).toBe(1);
      expect(manager.state.sessions.has('sess-orphan')).toBe(true);
      manager.stop();
    });

    it('picks up unowned registrations (no muxId) when no standalone listener is running', async () => {
      const reg = makeRegistration('sess-unowned');
      readActiveRegistrationsMock.mockReturnValue([reg]);
      // No standalone listener running (lock file read throws)
      readFileSyncMock.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const manager = createMuxEscalationManager({ muxId: OUR_MUX_ID });
      manager.startRegistryPolling();

      await triggerPoll();

      expect(manager.state.sessions.size).toBe(1);
      expect(manager.state.sessions.has('sess-unowned')).toBe(true);
      manager.stop();
    });

    it('ignores unowned registrations when a standalone listener is running', async () => {
      const reg = makeRegistration('sess-unowned-skip');
      readActiveRegistrationsMock.mockReturnValue([reg]);
      // Standalone listener IS running: lock file contains a live PID
      readFileSyncMock.mockReturnValue(String(process.pid));
      isPidAliveMock.mockReturnValue(true);

      const manager = createMuxEscalationManager({ muxId: OUR_MUX_ID });
      manager.startRegistryPolling();

      await triggerPoll();

      expect(manager.state.sessions.size).toBe(0);
      manager.stop();
    });

    it('ignores orphaned registrations when a standalone listener is running', async () => {
      const reg = makeRegistration('sess-orphan-skip', { muxId: OTHER_MUX_ID, muxPid: 999999999 });
      readActiveRegistrationsMock.mockReturnValue([reg]);
      // Standalone listener IS running: lock file contains a live PID
      readFileSyncMock.mockReturnValue(String(process.pid));
      // isPidAlive is called for both the lock file PID and the muxPid.
      // Lock file PID (our process.pid) should be alive; muxPid (999999999) should be dead.
      isPidAliveMock.mockImplementation((pid: number) => {
        return pid !== 999999999;
      });

      const manager = createMuxEscalationManager({ muxId: OUR_MUX_ID });
      manager.startRegistryPolling();

      await triggerPoll();

      expect(manager.state.sessions.size).toBe(0);
      manager.stop();
    });
  });
});
