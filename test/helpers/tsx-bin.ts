import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Finds the `tsx` CLI the way npm resolves binaries: the nearest
 * `node_modules/.bin/tsx` at or above `fromDir`. Hardcoding
 * `<repo>/node_modules/.bin/tsx` breaks in git worktrees, which share the
 * main checkout's `node_modules` from a parent directory.
 */
export function findTsxBin(fromDir: string): string {
  for (let dir = resolve(fromDir); ; dir = dirname(dir)) {
    const candidate = resolve(dir, 'node_modules', '.bin', 'tsx');
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) throw new Error(`tsx not found in any node_modules/.bin at or above ${fromDir}`);
  }
}
