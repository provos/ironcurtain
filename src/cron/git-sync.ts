import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Clones or refreshes a git repository in the given directory.
 *
 * - First call: clones the repo into dir (dir must exist and be empty)
 * - Subsequent calls: fetches from origin and resets tracked files to
 *   FETCH_HEAD, leaving untracked files (agent artifacts) intact.
 *
 * @param verbose Pass true to inherit stdio (show git output in terminal)
 */
export function syncGitRepo(uri: string, dir: string, verbose = false): void {
  const stdio = verbose ? ('inherit' as const) : ('pipe' as const);
  if (existsSync(resolve(dir, '.git'))) {
    execFileSync('git', ['fetch', 'origin'], { cwd: dir, stdio });
    execFileSync('git', ['reset', '--hard', 'FETCH_HEAD'], { cwd: dir, stdio });
  } else {
    execFileSync('git', ['clone', uri, '.'], { cwd: dir, stdio });
  }
}
