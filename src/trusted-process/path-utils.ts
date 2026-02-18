/**
 * Path normalization utilities for the trusted process security boundary.
 *
 * Normalizes path-like tool arguments before policy evaluation so that
 * tilde paths, relative paths, and path traversals cannot bypass
 * containment checks.
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Expands a leading `~` or `~/` to the current user's home directory.
 * Non-tilde paths are returned unchanged.
 */
export function expandTilde(filePath: string): string {
  if (filePath === '~') return homedir();
  if (filePath.startsWith('~/')) return homedir() + filePath.slice(1);
  return filePath;
}

/** Returns true if the string looks like a filesystem path. */
function looksLikePath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('.') || value.startsWith('~');
}

/** Resolves a path-like string to an absolute normalized form. */
function normalizePath(value: string): string {
  return resolve(expandTilde(value));
}

/**
 * Returns a new arguments object with all path-like string values
 * fully resolved (tilde expanded, relative resolved, traversals collapsed).
 *
 * A string value is considered path-like if it starts with `/`, `.`, or `~`.
 * Array values have each string element checked individually.
 * Non-string and non-path values pass through unchanged.
 *
 * The input object is never mutated.
 */
export function normalizeToolArgPaths(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && looksLikePath(value)) {
      result[key] = normalizePath(value);
    } else if (Array.isArray(value)) {
      result[key] = value.map(item =>
        typeof item === 'string' && looksLikePath(item)
          ? normalizePath(item)
          : item,
      );
    } else {
      result[key] = value;
    }
  }

  return result;
}
