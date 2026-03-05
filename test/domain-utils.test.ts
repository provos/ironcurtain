/**
 * Tests for resolveDefaultGitRemote in domain-utils.ts.
 *
 * Uses real temporary git repositories to verify tracking-branch priority,
 * origin fallback, SSH URL handling, and safe-fail behavior.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveDefaultGitRemote } from '../src/trusted-process/domain-utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REAL_TMP = realpathSync(tmpdir());

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@test.local',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@test.local',
};

function git(args: string[], cwd: string): void {
  execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 10_000,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: GIT_ENV,
  });
}

function initRepo(dir: string): void {
  git(['init', dir], REAL_TMP);
  git(['config', 'user.email', 'test@test.local'], dir);
  git(['config', 'user.name', 'Test'], dir);
}

function currentBranch(dir: string): string {
  return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: dir,
    encoding: 'utf-8',
    timeout: 5000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function emptyCommit(dir: string): void {
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], {
    cwd: dir,
    encoding: 'utf-8',
    timeout: 10_000,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: GIT_ENV,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveDefaultGitRemote', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = realpathSync(mkdtempSync(join(REAL_TMP, 'ic-domain-utils-test-')));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── Safe-fail cases ──────────────────────────────────────────────────────

  it('returns undefined for a non-existent path', () => {
    expect(resolveDefaultGitRemote(join(tempDir, 'does-not-exist-12345'))).toBeUndefined();
  });

  it('returns undefined for a plain directory (not a git repo)', () => {
    const plain = join(tempDir, 'plain-dir');
    mkdirSync(plain, { recursive: true });
    expect(resolveDefaultGitRemote(plain)).toBeUndefined();
  });

  it('returns undefined when the repo has no remotes configured', () => {
    const dir = join(tempDir, 'no-remotes');
    initRepo(dir);
    expect(resolveDefaultGitRemote(dir)).toBeUndefined();
  });

  // ── Origin fallback ──────────────────────────────────────────────────────

  it('returns the origin HTTPS URL via fallback when no tracking branch', () => {
    const dir = join(tempDir, 'origin-https');
    const originUrl = 'https://github.com/test-org/test-repo.git';
    initRepo(dir);
    git(['remote', 'add', 'origin', originUrl], dir);
    expect(resolveDefaultGitRemote(dir)).toBe(originUrl);
  });

  it('returns the origin SSH URL via fallback when no tracking branch', () => {
    const dir = join(tempDir, 'origin-ssh');
    const originUrl = 'git@github.com:test-org/test-repo.git';
    initRepo(dir);
    git(['remote', 'add', 'origin', originUrl], dir);
    expect(resolveDefaultGitRemote(dir)).toBe(originUrl);
  });

  it('returns origin even when other remotes also exist', () => {
    const dir = join(tempDir, 'multi-remote-no-tracking');
    const originUrl = 'https://github.com/mine/repo.git';
    initRepo(dir);
    git(['remote', 'add', 'origin', originUrl], dir);
    git(['remote', 'add', 'upstream', 'https://github.com/upstream/repo.git'], dir);
    // No tracking branch → falls back to origin
    expect(resolveDefaultGitRemote(dir)).toBe(originUrl);
  });

  // ── Tracking branch priority ─────────────────────────────────────────────

  it('returns the tracking remote URL (not origin) when branch has upstream configured', () => {
    const dir = join(tempDir, 'tracking-priority');
    const originUrl = 'https://github.com/fork/repo.git';
    const upstreamUrl = 'https://github.com/upstream/repo.git';
    initRepo(dir);
    git(['remote', 'add', 'origin', originUrl], dir);
    git(['remote', 'add', 'upstream', upstreamUrl], dir);
    emptyCommit(dir);
    const branch = currentBranch(dir);
    // Configure tracking: current branch → upstream/<branch>
    git(['config', `branch.${branch}.remote`, 'upstream'], dir);
    git(['config', `branch.${branch}.merge`, `refs/heads/${branch}`], dir);
    // Should prefer upstream over origin
    expect(resolveDefaultGitRemote(dir)).toBe(upstreamUrl);
  });

  it('returns the tracking remote URL for a custom (non-origin) remote name', () => {
    const dir = join(tempDir, 'custom-remote-tracking');
    const customUrl = 'https://gitlab.com/mygroup/myproject.git';
    initRepo(dir);
    git(['remote', 'add', 'gitlab', customUrl], dir);
    emptyCommit(dir);
    const branch = currentBranch(dir);
    git(['config', `branch.${branch}.remote`, 'gitlab'], dir);
    git(['config', `branch.${branch}.merge`, `refs/heads/${branch}`], dir);
    expect(resolveDefaultGitRemote(dir)).toBe(customUrl);
  });

  it('falls back to origin when tracking remote name exists but remote has been deleted', () => {
    const dir = join(tempDir, 'deleted-tracking-remote');
    const originUrl = 'https://github.com/org/repo.git';
    initRepo(dir);
    git(['remote', 'add', 'origin', originUrl], dir);
    git(['remote', 'add', 'ghost', 'https://ghost.example.com/repo.git'], dir);
    emptyCommit(dir);
    const branch = currentBranch(dir);
    // Configure tracking → 'ghost', then remove 'ghost'
    git(['config', `branch.${branch}.remote`, 'ghost'], dir);
    git(['config', `branch.${branch}.merge`, `refs/heads/${branch}`], dir);
    git(['remote', 'remove', 'ghost'], dir);
    // Tracking remote 'ghost' is gone → falls back to origin
    expect(resolveDefaultGitRemote(dir)).toBe(originUrl);
  });
});
