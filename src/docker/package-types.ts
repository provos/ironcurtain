/**
 * Type definitions for the secure package installation proxy.
 *
 * These types are shared across the package validator, registry proxy,
 * and MITM proxy integration layers.
 */

/**
 * Supported package registry types.
 * Each type determines how package names and versions are extracted
 * from HTTP request paths, and how metadata responses are filtered.
 */
export type RegistryType = 'npm' | 'pypi' | 'debian';

/**
 * Configuration for a package registry host.
 *
 * Unlike ProviderConfig (which handles credential swap and endpoint
 * filtering for LLM APIs), RegistryConfig handles package-level
 * validation for software registries.
 *
 * No key injection is needed -- package registries are public.
 */
export interface RegistryConfig {
  /** Registry hostname (e.g., 'registry.npmjs.org'). */
  readonly host: string;

  /** Human-readable name for logging. */
  readonly displayName: string;

  /** Registry type, determines URL parsing and metadata filtering strategy. */
  readonly type: RegistryType;

  /**
   * Additional hosts that serve package tarballs for this registry.
   * For PyPI, this includes 'files.pythonhosted.org'.
   * These hosts are added to the MITM proxy's allowlist and their
   * requests are validated using the same rules as the main host.
   */
  readonly mirrorHosts?: readonly string[];
}

/**
 * Parsed package identity extracted from a registry HTTP request.
 *
 * Invariant: scope is only present for npm scoped packages
 * (e.g., @types/node). PyPI packages never have a scope.
 */
export interface PackageIdentity {
  /** Registry type this package belongs to. */
  readonly registry: RegistryType;
  /** Package name (e.g., 'express', 'numpy'). */
  readonly name: string;
  /** npm scope without @, if scoped (e.g., 'types' for @types/node). */
  readonly scope?: string;
  /** Package version, if parseable from the URL or metadata. */
  readonly version?: string;
}

/**
 * Result of a package validation check.
 * Binary: allow or deny. No escalation.
 */
export type PackageDecision =
  | { readonly status: 'allow'; readonly reason: string }
  | { readonly status: 'deny'; readonly reason: string };

/**
 * Per-version metadata from the registry, focused on the fields
 * needed for security validation.
 *
 * Intentionally minimal -- we only extract what we check.
 */
export interface VersionMetadata {
  /** When this specific version was published. */
  readonly publishedAt?: Date;
  /** Whether this version has been deprecated. */
  readonly deprecated?: boolean;
}

/**
 * Validates whether a package version should be allowed.
 *
 * Used in two contexts:
 * 1. Metadata filtering: called per-version to decide which versions
 *    to include in the filtered metadata response.
 * 2. Tarball backstop: called when a tarball download is requested,
 *    as a defense-in-depth check.
 */
export interface PackageValidator {
  /**
   * Validates a package version against configured rules.
   *
   * @param pkg - Parsed package identity (name, version, scope).
   * @param metadata - Per-version metadata from the registry, if available.
   *   Undefined when metadata could not be fetched (treated as deny).
   * @returns Decision: allow or deny.
   */
  validate(pkg: PackageIdentity, metadata: VersionMetadata | undefined): PackageDecision;
}

/**
 * In-memory cache of allowed versions per package.
 * Populated during metadata filtering, consulted during tarball downloads.
 *
 * Keyed by canonical package identifier: 'npm:express', 'npm:@types/node',
 * 'pypi:numpy'.
 */
export type AllowedVersionCache = Map<
  string,
  {
    /** Set of version strings that passed validation. */
    readonly allowedVersions: ReadonlySet<string>;
    /** When this cache entry was populated. */
    readonly cachedAt: Date;
  }
>;

/**
 * Audit log entry for package installation decisions.
 * Written to package-audit.jsonl in the session directory.
 */
export interface PackageAuditEntry {
  readonly timestamp: string;
  /** Package identity. */
  readonly registry: RegistryType;
  readonly packageName: string;
  readonly packageVersion?: string;
  readonly packageScope?: string;
  /** Decision made by the validator. */
  readonly decision: 'allow' | 'deny';
  readonly reason: string;
  /** Whether this was a metadata filter or tarball backstop decision. */
  readonly source: 'metadata-filter' | 'tarball-backstop' | 'deb-backstop';
  /** The HTTP request path that triggered this check. */
  readonly requestPath: string;
}
