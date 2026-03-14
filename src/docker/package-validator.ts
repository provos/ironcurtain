/**
 * Package validation logic for the registry proxy.
 *
 * Evaluates packages against allowlist, denylist, and age gate rules.
 * Decisions are binary: allow or deny. No escalation.
 *
 * Validation order (first match wins):
 * 1. Denylist match    -> DENY
 * 2. Allowlist match   -> ALLOW (bypasses age gate)
 * 3. Version too new   -> DENY
 * 4. No metadata       -> DENY (fail-closed)
 * 5. Default           -> ALLOW
 */

import { minimatch } from 'minimatch';
import type { PackageIdentity, PackageDecision, VersionMetadata, PackageValidator } from './package-types.js';

/** Fallback validator that denies all packages. Used when no validator is configured. */
export const DENY_ALL_VALIDATOR: PackageValidator = {
  validate: () => ({ status: 'deny' as const, reason: 'No validator configured' }),
};

/** Default quarantine period in days. */
const DEFAULT_QUARANTINE_DAYS = 2;

/** Milliseconds per day, used for age calculations. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface PackageValidatorConfig {
  /** Packages always allowed (bypass age gate). Supports glob patterns. */
  readonly allowedPackages?: readonly string[];
  /** Packages always denied. Takes precedence over allowedPackages. Supports glob patterns. */
  readonly deniedPackages?: readonly string[];
  /** Days a version must age before auto-allow. 0 disables age gate. */
  readonly quarantineDays?: number;
}

/**
 * Returns the canonical display name for a package.
 * Scoped npm packages use '@scope/name' format.
 */
export function canonicalPackageName(pkg: PackageIdentity): string {
  return pkg.scope ? `@${pkg.scope}/${pkg.name}` : pkg.name;
}

/**
 * Returns the canonical cache key for a package.
 * Format: 'npm:express', 'npm:@types/node', 'pypi:numpy'.
 */
export function packageCacheKey(pkg: PackageIdentity): string {
  return `${pkg.registry}:${canonicalPackageName(pkg)}`;
}

/**
 * Checks if a package name matches any pattern in the given list.
 * Supports glob patterns via minimatch.
 */
function matchesPatternList(packageName: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => minimatch(packageName, pattern, { nocase: true }));
}

/**
 * Creates a PackageValidator from configuration.
 *
 * The validator is stateless -- all configuration is captured at
 * construction time. Thread-safe for concurrent use.
 */
export function createPackageValidator(config: PackageValidatorConfig = {}): PackageValidator {
  const allowedPackages = config.allowedPackages ?? [];
  const deniedPackages = config.deniedPackages ?? [];
  const quarantineDays = config.quarantineDays ?? DEFAULT_QUARANTINE_DAYS;

  return {
    validate(pkg: PackageIdentity, metadata: VersionMetadata | undefined): PackageDecision {
      const name = canonicalPackageName(pkg);

      // 1. Denylist (takes precedence over everything)
      if (deniedPackages.length > 0 && matchesPatternList(name, deniedPackages)) {
        return { status: 'deny', reason: `Package "${name}" is on the deny list` };
      }

      // 2. Allowlist (bypasses age gate)
      if (allowedPackages.length > 0 && matchesPatternList(name, allowedPackages)) {
        return { status: 'allow', reason: `Package "${name}" is on the allow list` };
      }

      // 3. Age gate (only when quarantineDays > 0)
      if (quarantineDays > 0) {
        if (!metadata) {
          // 4. No metadata -> fail-closed
          return { status: 'deny', reason: `No metadata available for "${name}" (fail-closed)` };
        }

        if (!metadata.publishedAt) {
          // No publish timestamp -> fail-closed
          return { status: 'deny', reason: `No publish timestamp for "${name}" (fail-closed)` };
        }

        const ageMs = Math.max(0, Date.now() - metadata.publishedAt.getTime());
        const ageDays = ageMs / MS_PER_DAY;

        if (ageDays < quarantineDays) {
          const daysOld = Math.floor(ageDays);
          return {
            status: 'deny',
            reason: `Version "${pkg.version ?? 'unknown'}" of "${name}" is only ${daysOld} day(s) old (quarantine: ${quarantineDays} days)`,
          };
        }
      }

      // 5. Default -> allow
      return { status: 'allow', reason: 'Passed all validation checks' };
    },
  };
}
