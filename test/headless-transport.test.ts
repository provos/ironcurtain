/**
 * Tests for HeadlessTransport -- the minimal single-shot transport
 * used by cron sessions.
 *
 * Mocks only the Session interface (minimal stub) and patches
 * getSessionInteractionLogPath to avoid writing to real session dirs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { HeadlessTransport } from '../src/cron/headless-transport.js';
import type { Session, SessionInfo } from '../src/session/types.js';

const TEST_DIR = resolve(`/tmp/ironcurtain-headless-test-${process.pid}`);

/** Minimal Session stub that records sendMessage calls. */
function stubSession(responseText = 'done'): Session {
  return {
    getInfo: () =>
      ({
        id: 'test-session-id',
        status: 'ready',
        turnCount: 0,
        createdAt: new Date().toISOString(),
      }) as SessionInfo,
    sendMessage: vi.fn().mockResolvedValue(responseText),
    getHistory: vi.fn().mockReturnValue([]),
    getDiagnosticLog: vi.fn().mockReturnValue([]),
    resolveEscalation: vi.fn(),
    getPendingEscalation: vi.fn(),
    getBudgetStatus: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  // Point IRONCURTAIN_HOME to a temp dir so interaction log doesn't
  // write to the real home directory.
  process.env.IRONCURTAIN_HOME = TEST_DIR;
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  delete process.env.IRONCURTAIN_HOME;
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('HeadlessTransport', () => {
  it('sends the task message and stores the response', async () => {
    const transport = new HeadlessTransport({ taskMessage: 'Label all open issues' });
    const session = stubSession('Labeled 12 issues');

    await transport.run(session);

    expect(session.sendMessage).toHaveBeenCalledWith('Label all open issues');
    expect(transport.getResponse()).toBe('Labeled 12 issues');
  });

  it('getResponse is undefined before run()', () => {
    const transport = new HeadlessTransport({ taskMessage: 'test' });
    expect(transport.getResponse()).toBeUndefined();
  });

  it('propagates errors from session.sendMessage', async () => {
    const session = stubSession();
    (session.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('LLM failure'));

    const transport = new HeadlessTransport({ taskMessage: 'do stuff' });
    await expect(transport.run(session)).rejects.toThrow('LLM failure');
  });

  it('does nothing if closed before run()', async () => {
    const transport = new HeadlessTransport({ taskMessage: 'test' });
    transport.close();

    const session = stubSession();
    await transport.run(session);

    expect(session.sendMessage).not.toHaveBeenCalled();
    expect(transport.getResponse()).toBeUndefined();
  });

  it('close() is idempotent', () => {
    const transport = new HeadlessTransport({ taskMessage: 'test' });
    expect(() => {
      transport.close();
      transport.close();
    }).not.toThrow();
  });
});
