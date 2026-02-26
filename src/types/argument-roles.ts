/**
 * ArgumentRole Registry -- Central definition of argument role semantics.
 *
 * Each role is paired with metadata describing its security semantics
 * and a normalizer function for canonicalizing argument values. This
 * eliminates scattered hardcoded role strings and enables annotation-driven
 * normalization instead of fragile heuristics.
 *
 * Roles are organized into categories that determine which structural
 * invariant applies in the policy engine:
 *   - path: filesystem path containment checks
 *   - url: domain allowlist checks
 *   - opaque: no structural invariant (semantic meaning only)
 */

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname, basename, join } from 'node:path';
import { normalizeUrl, normalizeGitUrl } from '../trusted-process/domain-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RoleCategory = 'path' | 'url' | 'opaque';

export type ArgumentRole =
  // Path roles -- sandbox-safe (filesystem sandbox containment auto-resolves these)
  | 'read-path'
  | 'write-path'
  | 'delete-path'
  // Path roles -- not sandbox-safe (require compiled rule evaluation even in sandbox)
  | 'write-history'
  | 'delete-history'
  // URL roles
  | 'fetch-url'
  | 'git-remote-url'
  // Opaque roles (semantic meaning but not resource identifiers)
  | 'branch-name'
  | 'commit-message'
  // Catch-all
  | 'none';

export interface RoleDefinition {
  readonly description: string;
  readonly isResourceIdentifier: boolean;
  readonly category: RoleCategory;
  /** Produce canonical form (symlink resolution, URL normalization). Security-critical. */
  readonly canonicalize: (value: string) => string;
  /**
   * Guidance for the LLM annotation prompt. Built into the prompt
   * dynamically from the registry -- no manual prompt maintenance.
   */
  readonly annotationGuidance: string;
  /**
   * When set, this role is only relevant for the named MCP servers.
   * Roles without serverNames are universal (included for all servers).
   */
  readonly serverNames?: readonly string[];
}

// ---------------------------------------------------------------------------
// Normalizer functions
// ---------------------------------------------------------------------------

/** Expands a leading `~` or `~/` to the current user's home directory. */
export function expandTilde(filePath: string): string {
  if (filePath === '~') return homedir();
  if (filePath.startsWith('~/')) return homedir() + filePath.slice(1);
  return filePath;
}

/**
 * Resolves a filesystem path to its canonical real path, following symlinks.
 *
 * Tries three strategies in order:
 * 1. `realpathSync(path)` — works for existing paths, follows all symlinks
 * 2. `realpathSync(parent) + basename` — works for new files in existing dirs
 * 3. `path.resolve(path)` — fallback for entirely new paths
 *
 * This is security-critical: without symlink resolution, a symlinked
 * directory inside the sandbox could escape containment checks.
 */
export function resolveRealPath(filePath: string): string {
  const absolute = resolve(expandTilde(filePath));
  try {
    return realpathSync(absolute);
  } catch {
    // Walk up to find the deepest existing ancestor, resolve it, then reattach the tail.
    // This handles cases like /tmp/nonexistent/file.txt on macOS where /tmp → /private/tmp
    // but the intermediate directory doesn't exist yet.
    let current = absolute;
    const tail: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- loop exits via return
    while (true) {
      const parent = dirname(current);
      tail.unshift(basename(current));
      if (parent === current) {
        // Reached filesystem root without finding an existing path
        return absolute;
      }
      current = parent;
      try {
        return join(realpathSync(current), ...tail);
      } catch {
        // Continue walking up
      }
    }
  }
}

/** Identity function -- returns the value unchanged. */
function identity(value: string): string {
  return value;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registryEntries: [ArgumentRole, RoleDefinition][] = [
  [
    'read-path',
    {
      description: 'Filesystem path that will be read',
      isResourceIdentifier: true,
      category: 'path',
      canonicalize: resolveRealPath,
      annotationGuidance:
        'Assign to arguments that are filesystem paths the tool will read from. ' +
        'Includes file and directory paths used for input.',
      serverNames: ['filesystem', 'git'],
    },
  ],
  [
    'write-path',
    {
      description: 'Filesystem path that will be written to',
      isResourceIdentifier: true,
      category: 'path',
      canonicalize: resolveRealPath,
      annotationGuidance:
        'Assign to arguments that are filesystem paths the tool will write or create. ' +
        'Includes destination paths for file creation and modification.',
      serverNames: ['filesystem', 'git'],
    },
  ],
  [
    'delete-path',
    {
      description: 'Filesystem path that will be deleted',
      isResourceIdentifier: true,
      category: 'path',
      canonicalize: resolveRealPath,
      annotationGuidance:
        'Assign to arguments that are filesystem paths the tool will delete or remove. ' +
        'Also assign to the source argument of move operations (source is deleted after copy).',
      serverNames: ['filesystem', 'git'],
    },
  ],
  [
    'write-history',
    {
      description: 'Filesystem path where git history will be rewritten',
      isResourceIdentifier: true,
      category: 'path',
      canonicalize: resolveRealPath,
      annotationGuidance:
        'Assign to the repository path argument of git operations that rewrite history or modify refs. ' +
        'Includes git_reset, git_rebase, git_merge, git_cherry_pick, and similar operations. ' +
        'These operations are dangerous even within the sandbox and require human oversight.',
      serverNames: ['git'],
    },
  ],
  [
    'delete-history',
    {
      description: 'Filesystem path where git refs or history will be deleted',
      isResourceIdentifier: true,
      category: 'path',
      canonicalize: resolveRealPath,
      annotationGuidance:
        'Assign to the repository path argument of git operations that delete refs (branches, tags). ' +
        'Includes git_branch (delete mode), git_tag (delete mode), and similar operations. ' +
        'These operations are dangerous even within the sandbox and require human oversight.',
      serverNames: ['git'],
    },
  ],
  [
    'fetch-url',
    {
      description: 'URL that will be fetched via HTTP(S)',
      isResourceIdentifier: true,
      category: 'url',
      canonicalize: normalizeUrl,
      annotationGuidance:
        'Assign to arguments that are HTTP(S) URLs the tool will fetch. ' +
        'Typically applies to web-fetch server tools.',
      serverNames: ['fetch'],
    },
  ],
  [
    'git-remote-url',
    {
      description: 'Git remote URL or named remote for network operations',
      isResourceIdentifier: true,
      category: 'url',
      canonicalize: normalizeGitUrl,
      annotationGuidance:
        'Assign to arguments that identify a git remote (URL or named remote like "origin"). ' +
        'Typically applies to git server tools like git_clone, git_push, git_pull, git_fetch, git_remote.',
      serverNames: ['git'],
    },
  ],
  [
    'branch-name',
    {
      description: 'Git branch name',
      isResourceIdentifier: false,
      category: 'opaque',
      canonicalize: identity,
      annotationGuidance:
        'Assign to arguments that are git branch names. ' +
        'Typically applies to git server tools like git_branch, git_checkout, git_merge, git_push.',
      serverNames: ['git'],
    },
  ],
  [
    'commit-message',
    {
      description: 'Git commit message text',
      isResourceIdentifier: false,
      category: 'opaque',
      canonicalize: identity,
      annotationGuidance: 'Assign to arguments that are git commit messages. ' + 'Typically applies to git_commit.',
      serverNames: ['git'],
    },
  ],
  [
    'none',
    {
      description: 'Argument carries no resource-identifier semantics',
      isResourceIdentifier: false,
      category: 'opaque',
      canonicalize: identity,
      annotationGuidance:
        'Assign to arguments that have no resource-identifier semantics. ' +
        'Use for flags, counts, patterns, messages, and other non-path, non-URL values.',
    },
  ],
];

export const ARGUMENT_ROLE_REGISTRY: ReadonlyMap<ArgumentRole, RoleDefinition> = new Map(registryEntries);

// ---------------------------------------------------------------------------
// Compile-time completeness check
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _ROLE_COMPLETENESS_CHECK: Record<ArgumentRole, true> = {
  'read-path': true,
  'write-path': true,
  'delete-path': true,
  'write-history': true,
  'delete-history': true,
  'fetch-url': true,
  'git-remote-url': true,
  'branch-name': true,
  'commit-message': true,
  none: true,
};

// ---------------------------------------------------------------------------
// Convenience accessors
// ---------------------------------------------------------------------------

/** Returns the RoleDefinition for a role. Throws if not registered. */
export function getRoleDefinition(role: ArgumentRole): RoleDefinition {
  const def = ARGUMENT_ROLE_REGISTRY.get(role);
  if (!def) {
    throw new Error(`No registry entry for role: ${role}`);
  }
  return def;
}

/** Returns all roles where isResourceIdentifier is true. */
export function getResourceRoles(): ArgumentRole[] {
  return Array.from(ARGUMENT_ROLE_REGISTRY)
    .filter(([, def]) => def.isResourceIdentifier)
    .map(([role]) => role);
}

/** Type guard: returns true if the value is a valid ArgumentRole string. */
export function isArgumentRole(value: string): value is ArgumentRole {
  return ARGUMENT_ROLE_REGISTRY.has(value as ArgumentRole);
}

/** All role values as a tuple for z.enum() compatibility. */
export function getArgumentRoleValues(): [ArgumentRole, ...ArgumentRole[]] {
  const roles = [...ARGUMENT_ROLE_REGISTRY.keys()];
  return roles as [ArgumentRole, ...ArgumentRole[]];
}

/**
 * Returns roles relevant to a specific MCP server.
 * Universal roles (no serverNames) are always included.
 * Server-specific roles are included only when the server matches.
 */
export function getRolesForServer(serverName: string): [ArgumentRole, RoleDefinition][] {
  return Array.from(ARGUMENT_ROLE_REGISTRY).filter(
    ([, def]) => !def.serverNames || def.serverNames.includes(serverName),
  );
}

/** Returns all roles with the given category. */
export function getRolesByCategory(category: RoleCategory): ArgumentRole[] {
  return Array.from(ARGUMENT_ROLE_REGISTRY)
    .filter(([, def]) => def.category === category)
    .map(([role]) => role);
}

/** Returns path-category roles only. Used by protected path check / filesystem sandbox containment. */
export function getPathRoles(): ArgumentRole[] {
  return getRolesByCategory('path');
}

/** Returns url-category roles only. Used by untrusted domain gate. */
export function getUrlRoles(): ArgumentRole[] {
  return getRolesByCategory('url');
}

/**
 * Path roles that filesystem sandbox containment is allowed to auto-resolve.
 *
 * Basic filesystem operations (read, write, delete) are safe within the
 * sandbox boundary. Higher-risk path roles like `write-history` and
 * `delete-history` are NOT sandbox-safe: even when the repo path is inside
 * the sandbox, these operations require compiled rule evaluation (and
 * typically human approval) because they can destroy git history.
 */
export const SANDBOX_SAFE_PATH_ROLES: ReadonlySet<ArgumentRole> = new Set(['read-path', 'write-path', 'delete-path']);
