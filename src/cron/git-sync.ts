import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Allowlisted git URI schemes. Git's ext:: protocol allows arbitrary
 * command execution and must never be accepted.
 *
 * Accepted forms:
 *   - https://host/repo.git
 *   - http://host/repo.git
 *   - ssh://user@host/repo.git
 *   - git://host/repo.git
 *   - git@host:org/repo.git  (SCP-style shorthand for SSH)
 *   - file:///path/to/repo
 */
const SAFE_URI_PATTERNS: ReadonlyArray<RegExp> = [
  /^https:\/\//i,
  /^http:\/\//i,
  /^ssh:\/\//i,
  /^git:\/\//i,
  /^file:\/\//i,
  /^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+:/, // SCP-style: user@host:path
];

/**
 * Validates that a git URI uses a safe transport protocol.
 *
 * Rejects dangerous protocols like ext:: which allow arbitrary
 * command execution, and any other unrecognized scheme.
 *
 * @throws {Error} if the URI uses a disallowed protocol
 */
export function validateGitUri(uri: string): void {
  const trimmed = uri.trim();
  if (!trimmed) {
    throw new Error('Git URI must not be empty');
  }

  const isSafe = SAFE_URI_PATTERNS.some((pattern) => pattern.test(trimmed));
  if (!isSafe) {
    throw new Error(
      `Rejected git URI with disallowed protocol: "${trimmed}". ` +
        `Only https, http, ssh, git, file, and SCP-style (user@host:path) URIs are allowed.`,
    );
  }
}

/**
 * Determines the remote's default branch by inspecting origin/HEAD.
 * Falls back to 'main' if the symbolic ref is not set.
 */
function resolveDefaultBranch(dir: string, env: NodeJS.ProcessEnv): string {
  try {
    // origin/HEAD is set automatically on clone; resolve it to a branch name.
    const ref = execFileSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
      cwd: dir,
      stdio: 'pipe',
      env,
    })
      .toString()
      .trim();
    // ref is "origin/main" or "origin/master" — strip the "origin/" prefix.
    return ref.replace(/^origin\//, '');
  } catch {
    // origin/HEAD may not exist if the repo was cloned with an old git version
    // or if HEAD was never set. Probe for common default branch names.
    for (const candidate of ['main', 'master']) {
      try {
        execFileSync('git', ['rev-parse', '--verify', `origin/${candidate}`], {
          cwd: dir,
          stdio: 'pipe',
          env,
        });
        return candidate;
      } catch {
        // Branch doesn't exist, try next
      }
    }
    return 'main';
  }
}

/**
 * Clones or refreshes a git repository in the given directory.
 *
 * - First call: clones the repo into dir (dir must exist and be empty)
 * - Subsequent calls: fetches from origin and resets tracked files to
 *   FETCH_HEAD, leaving untracked files (agent artifacts) intact.
 *
 * @param verbose Pass true to inherit stdio (show git output in terminal)
 * @returns diff --stat of tracked-file changes discarded by a hard reset,
 *          or null on first clone / when there are no local changes.
 * @throws {Error} if the URI uses a disallowed protocol
 */
export function syncGitRepo(uri: string, dir: string, verbose = false): string | null {
  validateGitUri(uri);

  const stdio = verbose ? ('inherit' as const) : ('pipe' as const);
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_ALLOW_PROTOCOL: 'https:http:ssh:git:file' };
  if (existsSync(resolve(dir, '.git'))) {
    execFileSync('git', ['fetch', 'origin'], { cwd: dir, stdio, env });

    // Resolve the remote's default branch (e.g., main, master).
    const defaultBranch = resolveDefaultBranch(dir, env);
    const target = `origin/${defaultBranch}`;

    // Capture tracked-file changes that will be discarded by the hard reset.
    let discarded: string | null = null;
    try {
      const diff = execFileSync('git', ['diff', '--stat', target], { cwd: dir, stdio: 'pipe', env });
      const diffStr = diff.toString().trim();
      if (diffStr) {
        discarded = diffStr;
      }
    } catch {
      // Non-fatal: proceed with reset even if diff fails
    }

    // Ensure the default branch is checked out, then reset to latest remote.
    execFileSync('git', ['checkout', '-B', defaultBranch, target], { cwd: dir, stdio, env });
    return discarded;
  } else {
    execFileSync('git', ['clone', '--', uri, '.'], { cwd: dir, stdio, env });
    return null;
  }
}
