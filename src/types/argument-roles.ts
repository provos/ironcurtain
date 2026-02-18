/**
 * ArgumentRole Registry -- Central definition of argument role semantics.
 *
 * Each role is paired with metadata describing its security semantics
 * and a normalizer function for canonicalizing argument values. This
 * eliminates scattered hardcoded role strings and enables annotation-driven
 * normalization instead of fragile heuristics.
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ArgumentRole = 'read-path' | 'write-path' | 'delete-path' | 'none';

export interface RoleDefinition {
  readonly description: string;
  readonly isResourceIdentifier: boolean;
  readonly normalize: (value: string) => string;
  readonly prepareForPolicy?: (value: string) => string;
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

/** Tilde expansion + path.resolve() to produce an absolute canonical path. */
export function normalizePath(value: string): string {
  return resolve(expandTilde(value));
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
      normalize: normalizePath,
    },
  ],
  [
    'write-path',
    {
      description: 'Filesystem path that will be written to',
      isResourceIdentifier: true,
      normalize: normalizePath,
    },
  ],
  [
    'delete-path',
    {
      description: 'Filesystem path that will be deleted',
      isResourceIdentifier: true,
      normalize: normalizePath,
    },
  ],
  [
    'none',
    {
      description: 'Argument carries no resource-identifier semantics',
      isResourceIdentifier: false,
      normalize: identity,
    },
  ],
];

export const ARGUMENT_ROLE_REGISTRY: ReadonlyMap<ArgumentRole, RoleDefinition> =
  new Map(registryEntries);

// ---------------------------------------------------------------------------
// Compile-time completeness check
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _ROLE_COMPLETENESS_CHECK: Record<ArgumentRole, true> = {
  'read-path': true,
  'write-path': true,
  'delete-path': true,
  'none': true,
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
  const roles: ArgumentRole[] = [];
  for (const [role, def] of ARGUMENT_ROLE_REGISTRY) {
    if (def.isResourceIdentifier) {
      roles.push(role);
    }
  }
  return roles;
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
