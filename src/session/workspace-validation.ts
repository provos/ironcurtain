/**
 * Workspace path validation for the --workspace CLI flag.
 *
 * Validates that a user-provided workspace path is safe to use as the
 * agent's working directory. The workspace replaces the session sandbox
 * as the allowedDirectory, so it must not overlap with protected paths
 * or sensitive system directories.
 */

import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { expandTilde, resolveRealPath } from '../types/argument-roles.js';
import { getIronCurtainHome, getSessionsDir } from '../config/paths.js';
import { getPersonasDir } from '../persona/resolve.js';

/** Returns true when `child` is equal to or nested inside `parent`. */
export function isEqualOrInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const prefix = parent === '/' ? '/' : parent + '/';
  return child.startsWith(prefix);
}

/**
 * Checks whether a canonical path inside ~/.ironcurtain/ is one of the
 * managed workspace directories that should be allowed as a workspace:
 *   - personas/{name}/workspace[/...]
 *   - sessions/{id}/sandbox[/...]
 */
function isAllowedIronCurtainSubpath(canonical: string): boolean {
  const personasBase = resolveRealPath(getPersonasDir());
  if (isEqualOrInside(canonical, personasBase)) {
    const relative = canonical.slice(personasBase.length + 1);
    if (/^[^/]+\/workspace(\/.*)?$/.test(relative)) return true;
  }
  const sessionsBase = resolveRealPath(getSessionsDir());
  if (isEqualOrInside(canonical, sessionsBase)) {
    const relative = canonical.slice(sessionsBase.length + 1);
    if (/^[^/]+\/sandbox(\/.*)?$/.test(relative)) return true;
  }
  return false;
}

/**
 * Validates and canonicalizes a workspace path.
 *
 * @param rawPath - The user-provided path (may be relative, contain ~, etc.)
 * @param protectedPaths - The list of protected paths from config
 * @returns The canonical absolute path
 * @throws {Error} if the path fails any validation check
 */
export function validateWorkspacePath(rawPath: string, protectedPaths: string[]): string {
  const absolute = resolve(expandTilde(rawPath));
  const canonical = resolveRealPath(absolute);

  // Must exist and be a directory
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(canonical);
  } catch {
    throw new Error(`Workspace path does not exist: ${canonical}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${canonical}`);
  }

  if (canonical === '/') {
    throw new Error('Cannot use root directory as workspace');
  }

  if (canonical === resolveRealPath(homedir())) {
    throw new Error('Cannot use home directory as workspace');
  }

  // IronCurtain manages two kinds of internal workspace directories:
  // - Persona workspaces: ~/.ironcurtain/personas/{name}/workspace[/...]
  // - Session sandboxes:  ~/.ironcurtain/sessions/{id}/sandbox[/...]
  // These are always allowed. All other paths under ~/.ironcurtain/ are rejected.
  const ironCurtainHome = resolveRealPath(getIronCurtainHome());
  const isAllowedInternalPath = isEqualOrInside(canonical, ironCurtainHome) && isAllowedIronCurtainSubpath(canonical);

  if (isEqualOrInside(canonical, ironCurtainHome) && !isAllowedInternalPath) {
    throw new Error(`Workspace path is inside the IronCurtain home directory: ${canonical}`);
  }

  // Check that workspace is not inside a protected path.
  // The reverse direction (protected path inside workspace) is intentionally
  // NOT checked here — the PolicyEngine already protects those paths at
  // runtime regardless of the allowedDirectory, so a workspace that happens
  // to contain e.g. src/config/generated/ is perfectly safe.
  // Allowed internal paths are exempt — they live under ~/.ironcurtain/ by
  // design, and the PolicyEngine protects config/policy files at runtime.
  if (!isAllowedInternalPath) {
    for (const pp of protectedPaths) {
      const protectedCanonical = resolveRealPath(pp);

      if (isEqualOrInside(canonical, protectedCanonical)) {
        throw new Error(`Workspace path overlaps with protected path: ${protectedCanonical}`);
      }
    }
  }

  return canonical;
}
