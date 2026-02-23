/**
 * Path normalization utilities for the trusted process security boundary.
 *
 * Provides annotation-driven normalization via `prepareToolArgs()`.
 */

import { resolve } from 'node:path';
import { getRoleDefinition, resolveRealPath, expandTilde } from '../types/argument-roles.js';
import type { ToolAnnotation, ArgumentRole } from '../pipeline/types.js';
import type { RoleDefinition } from '../types/argument-roles.js';

export { expandTilde } from '../types/argument-roles.js';

// ---------------------------------------------------------------------------
// Absolute vs relative path detection
// ---------------------------------------------------------------------------

/** Returns true if the path is absolute (starts with `/` or `~`). */
function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('~');
}

/**
 * Resolves a relative path against the sandbox directory for policy evaluation.
 * Applies tilde expansion first, then resolves against the sandbox base,
 * then follows symlinks via resolveRealPath.
 */
function resolveAgainstSandbox(value: string, sandboxDir: string): string {
  const expanded = expandTilde(value);
  const absolute = resolve(sandboxDir, expanded);
  return resolveRealPath(absolute);
}

// ---------------------------------------------------------------------------
// Annotation-driven normalization
// ---------------------------------------------------------------------------

export interface PreparedToolArgs {
  /** Canonical args sent to the real MCP server. */
  argsForTransport: Record<string, unknown>;
  /** Args presented to the policy engine (may differ for relative paths when allowedDirectory is set). */
  argsForPolicy: Record<string, unknown>;
}

/**
 * Finds the first resource-identifier role in a role array, or undefined
 * if all roles are non-resource (e.g., 'none').
 */
function findResourceRole(roles: ArgumentRole[]): ArgumentRole | undefined {
  return roles.find((r) => getRoleDefinition(r).isResourceIdentifier);
}

/**
 * Normalizes a single argument value using a role's normalizer.
 * Handles both string and string-array values. Non-string values
 * pass through unchanged.
 */
function normalizeArgValue(value: unknown, normalize: (v: string) => string): unknown {
  if (typeof value === 'string') {
    return normalize(value);
  }
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item: unknown) => (typeof item === 'string' ? normalize(item) : item));
  }
  return value;
}

/**
 * Normalizes a single path argument for transport, handling the
 * absolute/relative split. Absolute paths get full normalization;
 * relative paths pass through unchanged (the MCP server resolves
 * them against its own CWD, which is the sandbox directory).
 */
function normalizePathForTransport(value: unknown, def: RoleDefinition): unknown {
  return normalizeArgValue(value, (v) => (isAbsolutePath(v) ? def.canonicalize(v) : v));
}

/**
 * Normalizes a single path argument for policy evaluation. Absolute
 * paths get full normalization; relative paths are resolved against
 * the sandbox (allowedDirectory) so the policy engine can perform
 * containment checks with absolute canonical paths.
 */
function normalizePathForPolicy(value: unknown, def: RoleDefinition, allowedDirectory: string): unknown {
  return normalizeArgValue(value, (v) =>
    isAbsolutePath(v) ? def.canonicalize(v) : resolveAgainstSandbox(v, allowedDirectory),
  );
}

/**
 * Annotation-driven normalization of tool call arguments.
 *
 * For each argument, looks up its annotated roles and applies the
 * corresponding normalizer from the registry. Returns two argument
 * objects: one for transport (MCP server) and one for policy evaluation.
 *
 * For path-category roles, relative paths (not starting with `/` or `~`)
 * are treated differently:
 *   - Transport: passed through unchanged (the MCP server resolves them
 *     against its own sandbox CWD)
 *   - Policy: resolved against `allowedDirectory` so the policy engine
 *     has absolute canonical paths for containment checks
 *
 * The input object is never mutated.
 */
export function prepareToolArgs(
  args: Record<string, unknown>,
  annotation: ToolAnnotation,
  allowedDirectory?: string,
): PreparedToolArgs {
  const argsForTransport: Record<string, unknown> = {};
  const argsForPolicy: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    const roles = annotation.args[key] as ArgumentRole[] | undefined;
    const resourceRole = roles ? findResourceRole(roles) : undefined;

    if (resourceRole) {
      const def = getRoleDefinition(resourceRole);

      if (def.category === 'path' && allowedDirectory) {
        // Path roles with sandbox context: split relative vs absolute
        argsForTransport[key] = normalizePathForTransport(value, def);
        argsForPolicy[key] = normalizePathForPolicy(value, def, allowedDirectory);
      } else {
        // Non-path roles (URLs, opaque) or no sandbox: normalize for both
        const transportValue = normalizeArgValue(value, def.canonicalize);
        argsForTransport[key] = transportValue;
        // Domain extraction is handled later by the policy engine's
        // resolveUrlForDomainCheck() (uses functions from domain-utils.ts).
        argsForPolicy[key] = transportValue;
      }
    } else {
      argsForTransport[key] = value;
      argsForPolicy[key] = value;
    }
  }

  return { argsForTransport, argsForPolicy };
}
