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
import { getIronCurtainHome } from '../config/paths.js';
import { getPersonasDir } from '../persona/resolve.js';

/** Returns true when `child` is equal to or nested inside `parent`. */
export function isEqualOrInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const prefix = parent === '/' ? '/' : parent + '/';
  return child.startsWith(prefix);
}

export interface ValidateWorkspaceOptions {
  /** Allow persona workspace paths inside IronCurtain home (e.g., ~/.ironcurtain/personas/{name}/workspace). */
  readonly allowPersonaWorkspace?: boolean;
}

/**
 * Validates and canonicalizes a workspace path.
 *
 * @param rawPath - The user-provided path (may be relative, contain ~, etc.)
 * @param protectedPaths - The list of protected paths from config
 * @param options - Optional validation overrides
 * @returns The canonical absolute path
 * @throws {Error} if the path fails any validation check
 */
export function validateWorkspacePath(
  rawPath: string,
  protectedPaths: string[],
  options: ValidateWorkspaceOptions = {},
): string {
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

  const ironCurtainHome = resolveRealPath(getIronCurtainHome());
  if (isEqualOrInside(canonical, ironCurtainHome)) {
    // Persona workspaces live inside IronCurtain home by design
    // (~/.ironcurtain/personas/{name}/workspace/) — allow them when opted in.
    // Strict check: must be exactly {personasDir}/{single-segment}/workspace
    const personasBase = resolveRealPath(getPersonasDir());
    const relative = isEqualOrInside(canonical, personasBase) ? canonical.slice(personasBase.length + 1) : undefined;
    const isPersonaWorkspace =
      options.allowPersonaWorkspace && relative !== undefined && /^[^/]+\/workspace$/.test(relative);
    if (!isPersonaWorkspace) {
      throw new Error(`Workspace path is inside the IronCurtain home directory: ${canonical}`);
    }
  }

  // Check that workspace is not inside a protected path.
  // The reverse direction (protected path inside workspace) is intentionally
  // NOT checked here — the PolicyEngine already protects those paths at
  // runtime regardless of the allowedDirectory, so a workspace that happens
  // to contain e.g. src/config/generated/ is perfectly safe.
  for (const pp of protectedPaths) {
    const protectedCanonical = resolveRealPath(pp);

    if (isEqualOrInside(canonical, protectedCanonical)) {
      throw new Error(`Workspace path overlaps with protected path: ${protectedCanonical}`);
    }
  }

  return canonical;
}
