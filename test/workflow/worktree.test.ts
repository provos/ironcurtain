import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { GitWorktreeManager } from '../../src/workflow/worktree.js';

const execFileAsync = promisify(execFileCb);

/** Run a git command in the given directory. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

/** Create a test git repo with an initial commit. Returns the default branch name. */
async function createTestRepo(dir: string): Promise<string> {
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@test.com');
  await git(dir, 'config', 'user.name', 'Test User');
  writeFileSync(resolve(dir, 'README.md'), '# Test Repo\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'Initial commit');
  return 'main';
}

describe('GitWorktreeManager', { timeout: 30_000 }, () => {
  let testDir: string;
  let repoDir: string;
  let worktreeBaseDir: string;
  let manager: GitWorktreeManager;

  beforeEach(async () => {
    testDir = resolve('/tmp', `ironcurtain-worktree-test-${process.pid}-${Date.now()}`);
    repoDir = resolve(testDir, 'repo');
    worktreeBaseDir = resolve(testDir, 'worktrees');
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(worktreeBaseDir, { recursive: true });

    await createTestRepo(repoDir);
    manager = new GitWorktreeManager(worktreeBaseDir);
  });

  afterEach(async () => {
    // Clean up any worktrees before removing the test directory
    const active = manager.listActive();
    for (const wt of active) {
      try {
        await execFileAsync('git', ['worktree', 'remove', wt.path, '--force'], { cwd: repoDir });
      } catch {
        // Already removed
      }
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  describe('create', () => {
    it('creates a worktree at the expected path', async () => {
      const path = await manager.create(repoDir, 'feature-a', 'main');
      expect(path).toBe(resolve(worktreeBaseDir, 'feature-a'));
    });

    it('creates the specified branch', async () => {
      await manager.create(repoDir, 'feature-b', 'main');
      const branches = await git(repoDir, 'branch', '--list');
      expect(branches).toContain('feature-b');
    });

    it('worktree directory contains repo files', async () => {
      const path = await manager.create(repoDir, 'feature-c', 'main');
      const { existsSync } = await import('node:fs');
      expect(existsSync(resolve(path, 'README.md'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // listActive
  // -------------------------------------------------------------------------

  describe('listActive', () => {
    it('starts empty', () => {
      expect(manager.listActive()).toEqual([]);
    });

    it('tracks created worktrees', async () => {
      await manager.create(repoDir, 'wt-1', 'main');
      await manager.create(repoDir, 'wt-2', 'main');

      const active = manager.listActive();
      expect(active).toHaveLength(2);
      expect(active.map((w) => w.branch)).toEqual(expect.arrayContaining(['wt-1', 'wt-2']));
    });
  });

  // -------------------------------------------------------------------------
  // remove
  // -------------------------------------------------------------------------

  describe('remove', () => {
    it('removes a worktree', async () => {
      const path = await manager.create(repoDir, 'to-remove', 'main');
      expect(manager.listActive()).toHaveLength(1);

      await manager.remove(path);
      expect(manager.listActive()).toHaveLength(0);
    });

    it('deletes the branch when requested', async () => {
      const path = await manager.create(repoDir, 'branch-to-delete', 'main');
      await manager.remove(path, true);

      const branches = await git(repoDir, 'branch', '--list');
      expect(branches).not.toContain('branch-to-delete');
    });

    it('keeps the branch by default', async () => {
      const path = await manager.create(repoDir, 'branch-to-keep', 'main');
      await manager.remove(path);

      const branches = await git(repoDir, 'branch', '--list');
      expect(branches).toContain('branch-to-keep');
    });
  });

  // -------------------------------------------------------------------------
  // merge
  // -------------------------------------------------------------------------

  describe('merge', () => {
    it('succeeds for non-conflicting changes', async () => {
      const wtPath = await manager.create(repoDir, 'clean-merge', 'main');

      // Make a change in the worktree branch
      writeFileSync(resolve(wtPath, 'new-file.txt'), 'new content');
      await git(wtPath, 'add', '.');
      await git(wtPath, 'commit', '-m', 'Add new file');

      const result = await manager.merge(repoDir, 'clean-merge', 'main');
      expect(result.status).toBe('clean');
      if (result.status === 'clean') {
        expect(result.commitHash).toMatch(/^[0-9a-f]+$/);
      }
    });

    it('reports conflicts correctly', async () => {
      const wtPath = await manager.create(repoDir, 'conflict-merge', 'main');

      // Make a change on main
      await git(repoDir, 'checkout', 'main');
      writeFileSync(resolve(repoDir, 'README.md'), '# Changed on main\n');
      await git(repoDir, 'add', '.');
      await git(repoDir, 'commit', '-m', 'Change on main');

      // Make a conflicting change in the worktree
      writeFileSync(resolve(wtPath, 'README.md'), '# Changed on branch\n');
      await git(wtPath, 'add', '.');
      await git(wtPath, 'commit', '-m', 'Change on branch');

      const result = await manager.merge(repoDir, 'conflict-merge', 'main');
      expect(result.status).toBe('conflict');
      if (result.status === 'conflict') {
        expect(result.conflictFiles).toContain('README.md');
      }
    });

    it('leaves repo in clean state after conflict', async () => {
      const wtPath = await manager.create(repoDir, 'conflict-clean', 'main');

      // Create conflict
      await git(repoDir, 'checkout', 'main');
      writeFileSync(resolve(repoDir, 'README.md'), '# main version\n');
      await git(repoDir, 'add', '.');
      await git(repoDir, 'commit', '-m', 'main change');

      writeFileSync(resolve(wtPath, 'README.md'), '# branch version\n');
      await git(wtPath, 'add', '.');
      await git(wtPath, 'commit', '-m', 'branch change');

      await manager.merge(repoDir, 'conflict-clean', 'main');

      // Repo should be in a clean state (merge aborted)
      const status = await git(repoDir, 'status', '--porcelain');
      expect(status).toBe('');
    });
  });
});
