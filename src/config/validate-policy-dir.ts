/**
 * Shared policyDir containment validator.
 *
 * Every entry point that loads a compiled policy from an arbitrary path
 * (CLI --workspace/--persona flags, the coordinator's loadPolicy RPC,
 * session creation, etc.) funnels its candidate `policyDir` through
 * `validatePolicyDir()` before trusting the files on disk. Any process
 * that can reach the coordinator's control socket or construct a session
 * can otherwise point the policy loader at an attacker-controlled
 * directory and effectively install arbitrary rules.
 *
 * The check canonicalizes via `realpathSync` (so symlink-escape cannot
 * bypass the containment test) and requires the resolved path to live
 * under one of the trusted roots:
 *   - the IronCurtain home (`~/.ironcurtain` or `$IRONCURTAIN_HOME`)
 *   - the package config dir (so bundled read-only policies ship safely)
 *
 * The function throws a plain `Error` so callers can rethrow as
 * domain-specific errors (e.g., `SessionError`) without this module
 * having to know about each.
 */
import { resolveRealPath } from '../types/argument-roles.js';
import { getIronCurtainHome, getPackageConfigDir } from './paths.js';

export class PolicyDirValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyDirValidationError';
  }
}

/**
 * Returns true when `child` is equal to or nested inside `parent`.
 * Both inputs are expected to be canonical (realpath-resolved) so the
 * check is a pure string prefix test. Duplicated from
 * `session/workspace-validation.ts` to avoid a session → config → session
 * import cycle — the function is four lines and unlikely to diverge.
 */
function isEqualOrInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const prefix = parent === '/' ? '/' : parent + '/';
  return child.startsWith(prefix);
}

/**
 * Validates that `policyDir` resolves (via `realpathSync`) to a location
 * under a trusted root. Returns the canonicalized path on success.
 *
 * @throws {PolicyDirValidationError} if the path escapes all trusted roots.
 */
export function validatePolicyDir(policyDir: string): string {
  const resolvedPolicy = resolveRealPath(policyDir);
  const trustedDirs = [getIronCurtainHome(), getPackageConfigDir()].map(resolveRealPath);

  if (!trustedDirs.some((dir) => isEqualOrInside(resolvedPolicy, dir))) {
    throw new PolicyDirValidationError(
      `policyDir must be under a trusted directory. ` +
        `Received: ${resolvedPolicy}; ` +
        `trusted: ${trustedDirs.join(', ')}`,
    );
  }
  return resolvedPolicy;
}
