import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { scanResumableSessions, formatRelativeTime } from '../src/mux/session-scanner.js';
import type { SessionSnapshot } from '../src/mux/session-scanner.js';

describe('session-scanner', () => {
  const testDir = resolve('/tmp', `ironcurtain-scanner-test-${process.pid}`);
  const sessionsDir = resolve(testDir, 'sessions');

  beforeEach(() => {
    process.env.IRONCURTAIN_HOME = testDir;
    mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(() => {
    delete process.env.IRONCURTAIN_HOME;
    rmSync(testDir, { recursive: true, force: true });
  });

  function writeSnapshot(sessionId: string, snapshot: SessionSnapshot): void {
    const dir = resolve(sessionsDir, sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'session-state.json'), JSON.stringify(snapshot));
  }

  it('returns empty array when sessions dir does not exist', () => {
    rmSync(sessionsDir, { recursive: true, force: true });
    expect(scanResumableSessions()).toEqual([]);
  });

  it('returns empty array when sessions dir is empty', () => {
    expect(scanResumableSessions()).toEqual([]);
  });

  it('skips sessions without session-state.json', () => {
    mkdirSync(resolve(sessionsDir, 'orphan-session'), { recursive: true });
    expect(scanResumableSessions()).toEqual([]);
  });

  it('skips sessions with invalid JSON', () => {
    const dir = resolve(sessionsDir, 'bad-json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'session-state.json'), 'not json');
    expect(scanResumableSessions()).toEqual([]);
  });

  it('skips non-resumable sessions', () => {
    writeSnapshot('session-1', {
      sessionId: 'session-1',
      status: 'completed',
      exitCode: 0,
      lastActivity: '2026-03-10T12:00:00Z',

      workspacePath: '/workspace',
      agent: 'claude-code',
      label: 'Claude Code (interactive)',
      resumable: false,
    });
    expect(scanResumableSessions()).toEqual([]);
  });

  it('returns resumable sessions', () => {
    writeSnapshot('session-1', {
      sessionId: 'session-1',
      status: 'user-exit',
      exitCode: 0,
      lastActivity: '2026-03-10T12:00:00Z',

      workspacePath: '/workspace',
      agent: 'claude-code',
      label: 'Claude Code (interactive)',
      resumable: true,
    });

    const results = scanResumableSessions();
    expect(results).toHaveLength(1);
    expect(results[0].sessionId).toBe('session-1');
    expect(results[0].resumable).toBe(true);
  });

  it('sorts by lastActivity descending (most recent first)', () => {
    writeSnapshot('old-session', {
      sessionId: 'old-session',
      status: 'user-exit',
      exitCode: 0,
      lastActivity: '2026-03-09T12:00:00Z',

      workspacePath: '/workspace',
      agent: 'claude-code',
      label: 'Old session',
      resumable: true,
    });

    writeSnapshot('new-session', {
      sessionId: 'new-session',
      status: 'crashed',
      exitCode: 1,
      lastActivity: '2026-03-10T18:00:00Z',

      workspacePath: '/workspace',
      agent: 'claude-code',
      label: 'New session',
      resumable: true,
    });

    const results = scanResumableSessions();
    expect(results).toHaveLength(2);
    expect(results[0].sessionId).toBe('new-session');
    expect(results[1].sessionId).toBe('old-session');
  });

  it('filters mix of resumable and non-resumable', () => {
    writeSnapshot('resumable', {
      sessionId: 'resumable',
      status: 'auth-failure',
      exitCode: null,
      lastActivity: '2026-03-10T12:00:00Z',

      workspacePath: '/workspace',
      agent: 'claude-code',
      label: 'Resumable',
      resumable: true,
    });

    writeSnapshot('not-resumable', {
      sessionId: 'not-resumable',
      status: 'completed',
      exitCode: 0,
      lastActivity: '2026-03-10T13:00:00Z',

      workspacePath: '/workspace',
      agent: 'goose',
      label: 'Not resumable',
      resumable: false,
    });

    const results = scanResumableSessions();
    expect(results).toHaveLength(1);
    expect(results[0].sessionId).toBe('resumable');
  });
});

describe('formatRelativeTime', () => {
  it('formats recent time as "just now"', () => {
    const now = new Date().toISOString();
    expect(formatRelativeTime(now)).toBe('just now');
  });

  it('formats minutes ago', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(formatRelativeTime(fiveMinAgo)).toBe('5m ago');
  });

  it('formats hours ago', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(twoHoursAgo)).toBe('2h ago');
  });

  it('formats days ago', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(threeDaysAgo)).toBe('3d ago');
  });
});
