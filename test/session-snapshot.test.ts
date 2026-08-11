import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionSnapshot } from '../src/docker/pty-types.js';
import { SESSION_STATE_FILENAME } from '../src/config/paths.js';
import { validateResumeSession, loadSessionSnapshot, resolveSnapshotResumability } from '../src/docker/pty-session.js';

/**
 * These tests verify session snapshot I/O and resume validation
 * without Docker. The functions under test only read/write JSON files.
 */

// Helper to create a fake session directory structure in /tmp
function createFakeSessionDir(baseDir: string, sessionId: string, snapshot?: SessionSnapshot): string {
  const sessionDir = join(baseDir, 'sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  if (snapshot) {
    writeFileSync(join(sessionDir, SESSION_STATE_FILENAME), JSON.stringify(snapshot));
  }
  return sessionDir;
}

function makeSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: 'test-session-123',
    status: 'completed',
    exitCode: 0,
    lastActivity: new Date().toISOString(),
    workspacePath: '/tmp/test/sandbox',
    agent: 'claude-code',
    label: 'Claude Code (interactive)',
    resumable: true,
    ...overrides,
  };
}

describe('SessionSnapshot type', () => {
  it('has all required fields', () => {
    const snapshot = makeSnapshot();
    expect(snapshot.sessionId).toBe('test-session-123');
    expect(snapshot.status).toBe('completed');
    expect(snapshot.exitCode).toBe(0);
    expect(snapshot.agent).toBe('claude-code');
    expect(snapshot.resumable).toBe(true);
    expect(snapshot.label).toContain('Claude Code');
  });

  it('supports all exit statuses', () => {
    const statuses: SessionSnapshot['status'][] = ['completed', 'crashed', 'auth-failure', 'user-exit'];
    for (const status of statuses) {
      const snapshot = makeSnapshot({ status });
      expect(snapshot.status).toBe(status);
    }
  });

  it('supports null exit code', () => {
    const snapshot = makeSnapshot({ exitCode: null });
    expect(snapshot.exitCode).toBeNull();
  });
});

describe('loadSessionSnapshot', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'snapshot-load-'));
    process.env.IRONCURTAIN_HOME = baseDir;
  });

  afterEach(() => {
    delete process.env.IRONCURTAIN_HOME;
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('loads a valid snapshot', () => {
    const snapshot = makeSnapshot();
    createFakeSessionDir(baseDir, 'test-session-123', snapshot);

    const loaded = loadSessionSnapshot('test-session-123');
    expect(loaded).toBeDefined();
    expect(loaded!.sessionId).toBe('test-session-123');
    expect(loaded!.resumable).toBe(true);
  });

  it('returns undefined when session dir does not exist', () => {
    const loaded = loadSessionSnapshot('nonexistent-session');
    expect(loaded).toBeUndefined();
  });

  it('returns undefined when snapshot file is missing', () => {
    createFakeSessionDir(baseDir, 'no-snapshot-session');
    const loaded = loadSessionSnapshot('no-snapshot-session');
    expect(loaded).toBeUndefined();
  });

  it('returns undefined when snapshot file is invalid JSON', () => {
    const sessionDir = createFakeSessionDir(baseDir, 'bad-json-session');
    writeFileSync(join(sessionDir, SESSION_STATE_FILENAME), 'not-json');
    const loaded = loadSessionSnapshot('bad-json-session');
    expect(loaded).toBeUndefined();
  });
});

describe('validateResumeSession', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'snapshot-validate-'));
    process.env.IRONCURTAIN_HOME = baseDir;
  });

  afterEach(() => {
    delete process.env.IRONCURTAIN_HOME;
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('returns snapshot for a valid resumable session', () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'snapshot-ws-'));
    const snapshot = makeSnapshot({ sessionId: 'valid-resume', resumable: true, workspacePath: workspaceDir });
    createFakeSessionDir(baseDir, 'valid-resume', snapshot);

    const result = validateResumeSession('valid-resume');
    expect(result.sessionId).toBe('valid-resume');
    expect(result.resumable).toBe(true);

    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('throws when session directory does not exist', () => {
    expect(() => validateResumeSession('nonexistent')).toThrow('session directory not found');
  });

  it('throws when snapshot file is missing', () => {
    createFakeSessionDir(baseDir, 'no-snapshot');
    expect(() => validateResumeSession('no-snapshot')).toThrow('no session state snapshot');
  });

  it('throws when session is not resumable', () => {
    const snapshot = makeSnapshot({ sessionId: 'not-resumable', resumable: false, status: 'crashed' });
    createFakeSessionDir(baseDir, 'not-resumable', snapshot);
    expect(() => validateResumeSession('not-resumable')).toThrow('not resumable');
  });
});

/**
 * A PTY session that ran with an admitted secure nested Docker-workload bundle
 * must never be written as resumable: the nested daemon's state is torn down
 * with the bundle. This mirrors the batch path, which rejects a resume whose
 * session metadata records a Docker workload (`src/session/index.ts`).
 */
describe('resolveSnapshotResumability (Docker-workload sessions are ephemeral)', () => {
  let baseDir: string;
  let conversationStateDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'snapshot-workload-'));
    process.env.IRONCURTAIN_HOME = baseDir;
    // Non-empty conversation state: an ordinary session with this dir resumes.
    conversationStateDir = join(baseDir, 'conversation-state');
    mkdirSync(conversationStateDir, { recursive: true });
    writeFileSync(join(conversationStateDir, 'history.jsonl'), '{}\n');
  });

  afterEach(() => {
    delete process.env.IRONCURTAIN_HOME;
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('refuses resume for a workload session even with conversation state on disk', () => {
    const verdict = resolveSnapshotResumability({ conversationStateDir, dockerWorkloadAdmitted: true });
    expect(verdict.resumable).toBe(false);
    expect(verdict.reason).toMatch(/ephemeral/u);
  });

  it('keeps an ordinary session with conversation state resumable', () => {
    const verdict = resolveSnapshotResumability({ conversationStateDir, dockerWorkloadAdmitted: false });
    expect(verdict).toEqual({ resumable: true, reason: undefined });
  });

  it('refuses resume when no conversation state was recorded', () => {
    const verdict = resolveSnapshotResumability({ conversationStateDir: undefined, dockerWorkloadAdmitted: false });
    expect(verdict.resumable).toBe(false);
    expect(verdict.reason).toMatch(/conversation state/u);
  });

  it('rejects the written workload snapshot at resume while the ordinary one is accepted', () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'snapshot-workload-ws-'));

    for (const [sessionId, dockerWorkloadAdmitted] of [
      ['workload-session', true],
      ['ordinary-session', false],
    ] as const) {
      const verdict = resolveSnapshotResumability({ conversationStateDir, dockerWorkloadAdmitted });
      createFakeSessionDir(
        baseDir,
        sessionId,
        makeSnapshot({ sessionId, resumable: verdict.resumable, workspacePath: workspaceDir }),
      );
    }

    expect(() => validateResumeSession('workload-session')).toThrow('not resumable');
    expect(validateResumeSession('ordinary-session').resumable).toBe(true);

    rmSync(workspaceDir, { recursive: true, force: true });
  });
});
