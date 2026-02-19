import { dirname } from 'node:path';
import type { CompiledPolicyFile } from '../pipeline/types.js';
import { resolveRealPath } from '../types/argument-roles.js';

/**
 * Root entry for the MCP Roots protocol.
 * Mirrors the MCP SDK's Root type without importing it directly,
 * keeping this module free of SDK dependencies.
 */
export interface PolicyRoot {
  /** Absolute directory path (not a file:// URI yet -- callers convert). */
  readonly path: string;
  /** Human-readable label for debugging and audit logs. */
  readonly name: string;
}

/**
 * Extracts the set of directories that the compiled policy references
 * in `allow` or `escalate` rules with `paths.within` conditions.
 * These directories, plus the sandbox, form the initial roots that
 * MCP servers should accept.
 *
 * `deny` rules are excluded -- they never grant access, so exposing
 * denied directories as roots would widen the server-side boundary
 * without purpose.
 *
 * Catch-all rules without `paths.within` (like
 * `escalate-read-outside-permitted-areas`) are also excluded from
 * initial roots. Those are handled dynamically: when a human approves
 * an escalation, the target directory is added as a root at that time.
 *
 * @param compiledPolicy - The loaded compiled policy artifact.
 * @param allowedDirectory - The sandbox directory (always included).
 * @returns Deduplicated array of PolicyRoot entries, sandbox first.
 */
export function extractPolicyRoots(
  compiledPolicy: CompiledPolicyFile,
  allowedDirectory: string,
): PolicyRoot[] {
  const seen = new Set<string>();
  const roots: PolicyRoot[] = [];

  // Sandbox is always the first root.
  const resolvedSandbox = resolveRealPath(allowedDirectory);
  seen.add(resolvedSandbox);
  roots.push({ path: resolvedSandbox, name: 'sandbox' });

  for (const rule of compiledPolicy.rules) {
    if (rule.then === 'deny') continue;
    if (!rule.if.paths?.within) continue;

    const dir = resolveRealPath(rule.if.paths.within);
    if (seen.has(dir)) continue;

    seen.add(dir);
    roots.push({ path: dir, name: rule.name });
  }

  return roots;
}

/**
 * Converts PolicyRoot entries to MCP Root objects with `file://` URIs.
 */
export function toMcpRoots(
  policyRoots: PolicyRoot[],
): Array<{ uri: string; name: string }> {
  return policyRoots.map(r => ({
    uri: `file://${r.path}`,
    name: r.name,
  }));
}

/**
 * Extracts the containing directory for a filesystem path.
 * Used to derive the root directory when a human approves an
 * escalation -- the approved path's parent directory becomes a root
 * so the filesystem server will accept the forwarded call.
 *
 * If the path ends with a trailing slash, it is treated as a directory
 * and returned as-is (without the trailing slash) after resolution.
 * Otherwise dirname is used to get the containing directory.
 */
export function directoryForPath(filePath: string): string {
  // Check for trailing slash before resolving, since resolveRealPath() strips it.
  if (filePath.endsWith('/')) return resolveRealPath(filePath);
  return dirname(resolveRealPath(filePath));
}
