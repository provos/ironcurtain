/**
 * Path normalization utilities for the trusted process security boundary.
 *
 * Provides annotation-driven normalization via `prepareToolArgs()` and a
 * legacy heuristic fallback via `normalizeToolArgPaths()`. The heuristic
 * is retained for defense-in-depth and as a fallback when annotations are
 * unavailable.
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { getRoleDefinition } from '../types/argument-roles.js';
import type { ToolAnnotation, ArgumentRole } from '../pipeline/types.js';

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
 *
 * @deprecated Use `prepareToolArgs()` with annotation-driven normalization.
 * Retained as a fallback when annotations are unavailable.
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
  return roles.find(r => getRoleDefinition(r).isResourceIdentifier);
}

/**
 * Normalizes a single argument value using a role's normalizer.
 * Handles both string and string-array values. Non-string values
 * pass through unchanged.
 */
function normalizeArgValue(
  value: unknown,
  normalize: (v: string) => string,
): unknown {
  if (typeof value === 'string') {
    return normalize(value);
  }
  if (Array.isArray(value)) {
    return value.map(item =>
      typeof item === 'string' ? normalize(item) : item,
    );
  }
  return value;
}

/**
 * Annotation-driven normalization of tool call arguments.
 *
 * For each argument, looks up its annotated roles and applies the
 * corresponding normalizer from the registry. Returns two argument
 * objects: one for transport (MCP server) and one for policy evaluation.
 *
 * When `annotation` is undefined (unknown tool), falls back to the
 * heuristic `normalizeToolArgPaths()` for both outputs.
 *
 * The input object is never mutated.
 */
export function prepareToolArgs(
  args: Record<string, unknown>,
  annotation: ToolAnnotation | undefined,
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
      const transportValue = normalizeArgValue(value, def.normalize);
      argsForTransport[key] = transportValue;

      if (def.prepareForPolicy) {
        argsForPolicy[key] = normalizeArgValue(transportValue, def.prepareForPolicy);
      } else {
        argsForPolicy[key] = transportValue;
      }
    } else {
      argsForTransport[key] = value;
      argsForPolicy[key] = value;
    }
  }

  return { argsForTransport, argsForPolicy };
}
