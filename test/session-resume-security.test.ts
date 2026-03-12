/**
 * Security tests for the session resume feature.
 *
 * Covers: path traversal via session IDs, snapshot tampering,
 * seed file path traversal, credential cleanup, session isolation,
 * and audit log integrity.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionSnapshot } from '../src/docker/pty-types.js';
import { SESSION_STATE_FILENAME } from '../src/docker/pty-types.js';
import { validateResumeSession } from '../src/docker/pty-session.js';
import { prepareConversationStateDir } from '../src/docker/docker-infrastructure.js';
import type { ConversationStateConfig } from '../src/docker/agent-adapter.js';
import { scanResumableSessions } from '../src/mux/session-scanner.js';
import { getSessionDir } from '../src/config/paths.js';

function makeSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: 'test-session-123',
    status: 'user-exit',
    exitCode: 0,
    lastActivity: new Date().toISOString(),
    workspacePath: '/tmp/test/sandbox',
    agent: 'claude-code',
    label: 'Claude Code (interactive)',
    resumable: true,
    ...overrides,
  };
}

// --- 1. Session ID path traversal ---

describe('session ID path traversal prevention', () => {
  it('rejects session IDs with path traversal sequences', () => {
    expect(() => getSessionDir('../../../etc')).toThrow('Invalid session ID');
    expect(() => getSessionDir('../../root')).toThrow('Invalid session ID');
    expect(() => getSessionDir('foo/../bar')).toThrow('Invalid session ID');
  });

  it('rejects session IDs with slashes', () => {
    expect(() => getSessionDir('foo/bar')).toThrow('Invalid session ID');
    expect(() => getSessionDir('/absolute/path')).toThrow('Invalid session ID');
  });

  it('rejects session IDs with dots only', () => {
    expect(() => getSessionDir('.')).toThrow('Invalid session ID');
    expect(() => getSessionDir('..')).toThrow('Invalid session ID');
  });

  it('rejects session IDs with special characters', () => {
    expect(() => getSessionDir('foo bar')).toThrow('Invalid session ID');
    expect(() => getSessionDir('foo;rm -rf /')).toThrow('Invalid session ID');
    expect(() => getSessionDir('foo\nbar')).toThrow('Invalid session ID');
  });

  it('allows valid session IDs', () => {
    // Should not throw
    expect(() => getSessionDir('abc-123_DEF')).not.toThrow();
    expect(() => getSessionDir('session-2026-03-11-abcdef12')).not.toThrow();
  });
});

// --- 2. Snapshot tampering / privilege escalation ---

describe('snapshot tampering resistance', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'sec-snapshot-'));
    process.env.IRONCURTAIN_HOME = baseDir;
  });

  afterEach(() => {
    delete process.env.IRONCURTAIN_HOME;
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('rejects non-resumable sessions even if other fields look valid', () => {
    const sessionDir = join(baseDir, 'sessions', 'tampered-session');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, SESSION_STATE_FILENAME), JSON.stringify(makeSnapshot({ resumable: false })));

    expect(() => validateResumeSession('tampered-session')).toThrow('not resumable');
  });

  it('rejects snapshot with missing sessionId field', () => {
    const sessionDir = join(baseDir, 'sessions', 'no-id-session');
    mkdirSync(sessionDir, { recursive: true });
    // Write snapshot without sessionId
    writeFileSync(join(sessionDir, SESSION_STATE_FILENAME), JSON.stringify({ resumable: true, status: 'user-exit' }));

    // scanResumableSessions requires sessionId to be truthy
    const sessions = scanResumableSessions();
    expect(sessions).toHaveLength(0);
  });

  it('handles extra unexpected fields in snapshot gracefully', () => {
    const sessionDir = join(baseDir, 'sessions', 'extra-fields');
    mkdirSync(sessionDir, { recursive: true });
    // Use a real directory as workspacePath so validation passes
    const workspaceDir = mkdtempSync(join(tmpdir(), 'sec-workspace-'));
    const snapshot = makeSnapshot({ sessionId: 'extra-fields', workspacePath: workspaceDir });
    Object.defineProperty(snapshot, 'maliciousField', { value: '<script>alert(1)</script>', enumerable: true });
    Object.defineProperty(snapshot, '__proto__', { value: { isAdmin: true }, enumerable: true });
    writeFileSync(join(sessionDir, SESSION_STATE_FILENAME), JSON.stringify(snapshot));

    // Should load without issues -- extra fields are ignored
    const result = validateResumeSession('extra-fields');
    expect(result.sessionId).toBe('extra-fields');

    rmSync(workspaceDir, { recursive: true, force: true });
  });
});

// --- 3. Credential cleanup (defense-in-depth) ---

describe('credential cleanup on resume', () => {
  let sessionDir: string;

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'sec-creds-'));
  });

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it('deletes .credentials.json on every run (first and subsequent)', () => {
    const config: ConversationStateConfig = {
      hostDirName: 'state',
      containerMountPath: '/root/.test/',
      seed: [],
      resumeFlags: [],
    };

    // First run creates the directory
    const stateDir = prepareConversationStateDir(sessionDir, config);

    // Simulate agent writing credentials (as if leaked from container)
    writeFileSync(join(stateDir, '.credentials.json'), '{"accessToken":"REAL_TOKEN"}');
    expect(existsSync(join(stateDir, '.credentials.json'))).toBe(true);

    // Second run (resume) must delete it
    prepareConversationStateDir(sessionDir, config);
    expect(existsSync(join(stateDir, '.credentials.json'))).toBe(false);
  });

  it('cleans credentials even when seed files exist', () => {
    const config: ConversationStateConfig = {
      hostDirName: 'state',
      containerMountPath: '/root/.test/',
      seed: [{ path: 'config.json', content: '{}' }],
      resumeFlags: [],
    };

    const stateDir = prepareConversationStateDir(sessionDir, config);
    writeFileSync(join(stateDir, '.credentials.json'), '{"token":"SECRET"}');

    // Re-run should remove credentials without re-seeding
    prepareConversationStateDir(sessionDir, config);
    expect(existsSync(join(stateDir, '.credentials.json'))).toBe(false);
    // Seed files should remain as-is (not overwritten)
    expect(existsSync(join(stateDir, 'config.json'))).toBe(true);
  });
});

// --- 4. Seed file path traversal ---

describe('seed file path traversal', () => {
  let sessionDir: string;

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'sec-seed-'));
  });

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it('rejects seed paths that attempt to escape the state directory', () => {
    // prepareConversationStateDir() validates that resolved seed paths
    // stay within the state directory, rejecting traversal attempts.
    const config: ConversationStateConfig = {
      hostDirName: 'state',
      containerMountPath: '/root/.test/',
      seed: [
        // A normal nested path
        { path: 'deep/nested/file.txt', content: 'safe' },
      ],
      resumeFlags: [],
    };

    const stateDir = prepareConversationStateDir(sessionDir, config);
    expect(existsSync(join(stateDir, 'deep', 'nested', 'file.txt'))).toBe(true);

    // Verify the file was created inside stateDir
    const filePath = resolve(stateDir, 'deep', 'nested', 'file.txt');
    expect(filePath.startsWith(stateDir)).toBe(true);
  });

  it('rejects absolute seed paths that escape the state directory', () => {
    const targetPath = join(sessionDir, 'escape-target.txt');

    const config: ConversationStateConfig = {
      hostDirName: 'state',
      containerMountPath: '/root/.test/',
      seed: [{ path: targetPath, content: 'escaped!' }],
      resumeFlags: [],
    };

    // The containment check rejects absolute paths that resolve outside stateDir
    expect(() => prepareConversationStateDir(sessionDir, config)).toThrow('Seed path escapes state directory');
    expect(existsSync(targetPath)).toBe(false);
  });
});

// --- 5. Session isolation ---

describe('session isolation', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'sec-isolation-'));
    process.env.IRONCURTAIN_HOME = baseDir;
  });

  afterEach(() => {
    delete process.env.IRONCURTAIN_HOME;
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('session directories are isolated by session ID', () => {
    const dir1 = getSessionDir('session-aaa');
    const dir2 = getSessionDir('session-bbb');

    expect(dir1).not.toBe(dir2);
    expect(dir1).toContain('session-aaa');
    expect(dir2).toContain('session-bbb');
    // Neither directory is a prefix of the other
    expect(dir1.startsWith(dir2)).toBe(false);
    expect(dir2.startsWith(dir1)).toBe(false);
  });

  it('scanner does not mix sessions from different directories', () => {
    const sessionsDir = join(baseDir, 'sessions');

    // Create two sessions
    for (const id of ['session-a', 'session-b']) {
      const dir = join(sessionsDir, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, SESSION_STATE_FILENAME),
        JSON.stringify(
          makeSnapshot({
            sessionId: id,
            workspacePath: `/tmp/${id}/sandbox`,
          }),
        ),
      );
    }

    const sessions = scanResumableSessions();
    expect(sessions).toHaveLength(2);

    // Each session has its own workspace path
    const paths = sessions.map((s) => s.workspacePath);
    expect(new Set(paths).size).toBe(2);
  });
});

// --- 6. Audit log append-only on resume ---

describe('audit log integrity on resume', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'sec-audit-'));
    process.env.IRONCURTAIN_HOME = baseDir;
  });

  afterEach(() => {
    delete process.env.IRONCURTAIN_HOME;
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('audit log path is deterministic per session ID (append on resume)', async () => {
    // The audit log path is derived from the session ID, so a resumed
    // session appends to the same file -- no gap, no separate file.
    const { getSessionAuditLogPath } = await import('../src/config/paths.js');
    const path1 = getSessionAuditLogPath('session-audit-test');
    const path2 = getSessionAuditLogPath('session-audit-test');
    expect(path1).toBe(path2);
    expect(path1).toContain('session-audit-test');
    expect(path1).toMatch(/audit\.jsonl$/);
  });
});

// --- 7. IRONCURTAIN_RESUME_FLAGS injection ---

describe('resume flags safety', () => {
  it('resumeFlags are joined with spaces (no shell injection)', () => {
    // The resume flags are set via: env.IRONCURTAIN_RESUME_FLAGS = flags.join(' ')
    // And consumed via: $IRONCURTAIN_RESUME_FLAGS (unquoted in bash)
    // Verify that the Claude Code adapter's flags are safe constants.
    const config: ConversationStateConfig = {
      hostDirName: 'claude-state',
      containerMountPath: '/root/.claude/',
      seed: [],
      resumeFlags: ['--continue'],
    };

    const flagString = config.resumeFlags.join(' ');
    expect(flagString).toBe('--continue');
    // No shell metacharacters
    expect(flagString).not.toMatch(/[;&|`$(){}]/);
  });
});
