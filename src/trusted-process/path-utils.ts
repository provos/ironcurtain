/**
 * Path normalization utilities for the trusted process security boundary.
 *
 * Provides annotation-driven normalization via `prepareToolArgs()` and a
 * legacy heuristic fallback via `normalizeToolArgPaths()`. The heuristic
 * is retained for defense-in-depth and as a fallback when annotations are
 * unavailable.
 */

import { resolve } from 'node:path';
import { getRoleDefinition, resolveRealPath, expandTilde } from '../types/argument-roles.js';
import type { ToolAnnotation, ArgumentRole } from '../pipeline/types.js';
import type { RoleDefinition } from '../types/argument-roles.js';

export { expandTilde } from '../types/argument-roles.js';

/** Returns true if the string looks like a filesystem path. */
function looksLikePath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('.') || value.startsWith('~');
}

/** Resolves a path-like string to its canonical real path, following symlinks. */
function normalizePath(value: string): string {
  return resolveRealPath(expandTilde(value));
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
 *
 * @deprecated Use `prepareToolArgs()` with annotation-driven normalization.
 * Retained as a fallback when annotations are unavailable.
 */
export function normalizeToolArgPaths(args: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && looksLikePath(value)) {
      result[key] = normalizePath(value);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) => (typeof item === 'string' && looksLikePath(item) ? normalizePath(item) : item));
    } else {
      result[key] = value;
    }
  }

  return result;
}

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
  /** Args presented to the policy engine (may differ if prepareForPolicy is defined). */
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
    return value.map((item) => (typeof item === 'string' ? normalize(item) : item));
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
  return normalizeArgValue(value, (v) => (isAbsolutePath(v) ? def.normalize(v) : v));
}

/**
 * Normalizes a single path argument for policy evaluation. Absolute
 * paths get full normalization; relative paths are resolved against
 * the sandbox (allowedDirectory) so the policy engine can perform
 * containment checks with absolute canonical paths.
 */
function normalizePathForPolicy(value: unknown, def: RoleDefinition, allowedDirectory: string): unknown {
  return normalizeArgValue(value, (v) =>
    isAbsolutePath(v) ? def.normalize(v) : resolveAgainstSandbox(v, allowedDirectory),
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
 * When `annotation` is undefined (unknown tool), falls back to the
 * heuristic `normalizeToolArgPaths()` for both outputs.
 *
 * The input object is never mutated.
 */
export function prepareToolArgs(
  args: Record<string, unknown>,
  annotation: ToolAnnotation | undefined,
  allowedDirectory?: string,
): PreparedToolArgs {
  if (!annotation) {
    const fallback = normalizeToolArgPaths(args);
    return { argsForTransport: fallback, argsForPolicy: fallback };
  }

  const argsForTransport: Record<string, unknown> = {};
  const argsForPolicy: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    const roles = annotation.args[key];
    const resourceRole = roles ? findResourceRole(roles) : undefined;

    if (resourceRole) {
      const def = getRoleDefinition(resourceRole);

      if (def.category === 'path' && allowedDirectory) {
        // Path roles with sandbox context: split relative vs absolute
        argsForTransport[key] = normalizePathForTransport(value, def);
        argsForPolicy[key] = normalizePathForPolicy(value, def, allowedDirectory);
      } else {
        // Non-path roles (URLs, opaque) or no sandbox: normalize for both
        const transportValue = normalizeArgValue(value, def.normalize);
        argsForTransport[key] = transportValue;
        // Domain extraction (prepareForPolicy) is handled later by
        // the policy engine's resolveUrlForDomainCheck().
        argsForPolicy[key] = transportValue;
      }
    } else {
      argsForTransport[key] = value;
      argsForPolicy[key] = value;
    }
  }

  return { argsForTransport, argsForPolicy };
}
