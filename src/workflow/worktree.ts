import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type MergeResult =
  | { readonly status: 'clean'; readonly commitHash: string }
  | { readonly status: 'conflict'; readonly conflictFiles: readonly string[] };

export interface WorktreeInfo {
  readonly path: string;
  readonly branch: string;
  readonly parallelKey: string;
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/** Manages git worktrees for parallel coding slots in workflows. */
export interface WorktreeManager {
  /** Create a worktree for a parallel slot. Returns the worktree path. */
  create(repoPath: string, branchName: string, baseBranch: string): Promise<string>;

  /** Merge a worktree branch into the base branch. */
  merge(repoPath: string, branchName: string, baseBranch: string): Promise<MergeResult>;

  /** Remove a worktree and optionally delete its branch. */
  remove(worktreePath: string, deleteBranch?: boolean): Promise<void>;

  /** List active worktrees managed by workflows. */
  listActive(): readonly WorktreeInfo[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Git worktree manager for parallel coding workflows. Uses `execFile`
 * with argument arrays exclusively -- never shell string concatenation.
 */
export class GitWorktreeManager implements WorktreeManager {
  private readonly activeWorktrees: WorktreeInfo[] = [];

  constructor(private readonly worktreeBaseDir: string) {}

  async create(repoPath: string, branchName: string, baseBranch: string): Promise<string> {
    const worktreePath = resolve(this.worktreeBaseDir, branchName);

    await execFileAsync('git', ['worktree', 'add', worktreePath, '-b', branchName, baseBranch], { cwd: repoPath });

    this.activeWorktrees.push({
      path: worktreePath,
      branch: branchName,
      parallelKey: branchName,
    });

    return worktreePath;
  }

  async merge(repoPath: string, branchName: string, baseBranch: string): Promise<MergeResult> {
    await execFileAsync('git', ['checkout', baseBranch], { cwd: repoPath });

    try {
      await execFileAsync('git', ['merge', '--no-ff', branchName], { cwd: repoPath });

      const commitHash = await this.getHeadCommitHash(repoPath);
      return { status: 'clean', commitHash };
    } catch (err) {
      const execErr = err as { stderr?: string; stdout?: string };
      const conflictFiles = parseConflictFiles(execErr.stdout ?? '', execErr.stderr ?? '');

      // Abort the failed merge to leave the repo in a clean state
      await execFileAsync('git', ['merge', '--abort'], { cwd: repoPath }).catch(() => {});

      return { status: 'conflict', conflictFiles };
    }
  }

  async remove(worktreePath: string, deleteBranch?: boolean): Promise<void> {
    const info = this.activeWorktrees.find((w) => w.path === worktreePath);
    const branchName = info?.branch;

    // Discover the main repo directory from the worktree before removing it
    const mainRepoDir = await this.findMainWorktree(worktreePath);

    await execFileAsync('git', ['worktree', 'remove', worktreePath, '--force'], {
      cwd: mainRepoDir,
    });

    // Remove from tracking
    const idx = this.activeWorktrees.findIndex((w) => w.path === worktreePath);
    if (idx >= 0) {
      this.activeWorktrees.splice(idx, 1);
    }

    if (deleteBranch && branchName) {
      try {
        await execFileAsync('git', ['branch', '-D', branchName], {
          cwd: mainRepoDir,
        });
      } catch {
        // Branch may already be deleted
      }
    }
  }

  listActive(): readonly WorktreeInfo[] {
    return [...this.activeWorktrees];
  }

  /**
   * Find the main working tree directory from any worktree path.
   * Uses `git rev-parse --git-common-dir` to locate the shared .git directory,
   * then resolves to its parent (the main working tree).
   */
  private async findMainWorktree(worktreePath: string): Promise<string> {
    // --git-common-dir returns the shared .git directory across all worktrees
    const { stdout: commonDir } = await execFileAsync('git', ['rev-parse', '--git-common-dir'], {
      cwd: worktreePath,
    });
    // commonDir is the path to the shared .git directory (e.g., /repo/.git)
    return resolve(worktreePath, commonDir.trim(), '..');
  }

  private async getHeadCommitHash(repoPath: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoPath });
    return stdout.trim();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse conflict file paths from git merge output. Git lists conflicting
 * files in both stdout (CONFLICT lines) and stderr.
 */
function parseConflictFiles(stdout: string, stderr: string): string[] {
  const combined = `${stdout}\n${stderr}`;
  const conflicts: string[] = [];

  // Match "CONFLICT (content): Merge conflict in <path>"
  const pattern = /CONFLICT\s+\([^)]+\):\s+Merge conflict in\s+(.+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(combined)) !== null) {
    conflicts.push(match[1].trim());
  }

  return conflicts;
}
