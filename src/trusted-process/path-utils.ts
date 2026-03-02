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
 * Rewrites a container-internal path to the corresponding host path.
 *
 * When Docker agent mode bind-mounts the host sandbox at `/workspace`
 * inside the container, the agent sends paths like `/workspace/foo`.
 * These must be translated to `{allowedDirectory}/foo` before reaching
 * host-side MCP servers.
 *
 * Only rewrites paths that exactly match or have a `/` after the prefix
 * (i.e. `/workspace` and `/workspace/...` but NOT `/workspacefoo`).
 * Relative paths and non-matching absolute paths pass through unchanged.
 */
function rewriteContainerPath(value: string, containerDir: string, hostDir: string): string {
  // Normalize trailing slashes so '/workspace' and '/workspace/' are equivalent.
  const normContainer = containerDir !== '/' && containerDir.endsWith('/') ? containerDir.slice(0, -1) : containerDir;
  const normValue = value !== '/' && value.endsWith('/') ? value.slice(0, -1) : value;
  if (normValue === normContainer) return hostDir;
  const prefix = normContainer + '/';
  if (value.startsWith(prefix)) return hostDir + '/' + value.slice(prefix.length);
  return value;
}

/**
 * Applies container-to-host path rewriting to a value (string or string array).
 * Non-string values pass through unchanged.
 */
function rewriteContainerPaths(value: unknown, containerDir: string, hostDir: string): unknown {
  if (typeof value === 'string') return rewriteContainerPath(value, containerDir, hostDir);
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item: unknown) =>
      typeof item === 'string' ? rewriteContainerPath(item, containerDir, hostDir) : item,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Reverse path rewriting: host sandbox → container workspace in results
// ---------------------------------------------------------------------------

/**
 * Rewrites host sandbox paths back to container workspace paths in MCP
 * result content blocks.
 *
 * When Docker agent mode bind-mounts the host sandbox at `/workspace`
 * inside the container, MCP server results may contain host-internal
 * paths (e.g. in `read_file` output, error messages, `list_directory`
 * results). This function replaces those paths so the agent sees
 * `/workspace/...` paths it can actually use.
 *
 * Only rewrites `text` fields in content blocks with `type: 'text'`.
 * Non-text blocks (images, resources) pass through unchanged.
 * The original content array is never mutated.
 */
export function rewriteResultContent(content: unknown, hostDir: string, containerDir: string): unknown {
  if (!Array.isArray(content)) return content;

  // Normalize trailing slash on hostDir so both `/foo` and `/foo/` match
  const normHost = hostDir !== '/' && hostDir.endsWith('/') ? hostDir.slice(0, -1) : hostDir;
  if (!normHost) return content;

  return content.map((block: unknown) => {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as Record<string, unknown>).type === 'text' &&
      typeof (block as Record<string, unknown>).text === 'string'
    ) {
      const text = (block as Record<string, unknown>).text as string;
      const replaced = text.replaceAll(normHost, containerDir);
      if (replaced === text) return block;
      return { ...block, text: replaced };
    }
    return block;
  });
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
 * When `containerWorkspaceDir` is set (Docker agent mode), path arguments
 * starting with that prefix are rewritten to host paths under
 * `allowedDirectory` before any other normalization.
 *
 * The input object is never mutated.
 */
export function prepareToolArgs(
  args: Record<string, unknown>,
  annotation: ToolAnnotation,
  allowedDirectory?: string,
  containerWorkspaceDir?: string,
): PreparedToolArgs {
  const argsForTransport: Record<string, unknown> = {};
  const argsForPolicy: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    const roles = annotation.args[key] as ArgumentRole[] | undefined;
    const resourceRole = roles ? findResourceRole(roles) : undefined;

    if (resourceRole) {
      const def = getRoleDefinition(resourceRole);

      // Rewrite container paths to host paths before normalization
      const rewritten =
        def.category === 'path' && containerWorkspaceDir && allowedDirectory
          ? rewriteContainerPaths(value, containerWorkspaceDir, allowedDirectory)
          : value;

      if (def.category === 'path' && allowedDirectory) {
        // Path roles with sandbox context: split relative vs absolute
        argsForTransport[key] = normalizePathForTransport(rewritten, def);
        argsForPolicy[key] = normalizePathForPolicy(rewritten, def, allowedDirectory);
      } else {
        // Non-path roles (URLs, opaque) or no sandbox: normalize for both
        const transportValue = normalizeArgValue(rewritten, def.canonicalize);
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
