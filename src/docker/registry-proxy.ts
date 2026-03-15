/**
 * Registry proxy: URL parsing, metadata filtering, and tarball backstop
 * for npm and PyPI package registries.
 *
 * This module provides:
 * - URL parsers that extract PackageIdentity from HTTP request paths
 * - Metadata filtering functions that remove disallowed versions
 * - Tarball backstop logic that blocks direct tarball URL access
 * - Built-in registry configurations for npm and PyPI
 */

import * as http from 'node:http';
import * as https from 'node:https';
import { promises as fs } from 'node:fs';
import type {
  PackageIdentity,
  PackageDecision,
  PackageValidator,
  PackageAuditEntry,
  AllowedVersionCache,
  RegistryConfig,
  RegistryType,
} from './package-types.js';
import { packageCacheKey, canonicalPackageName } from './package-validator.js';
import * as logger from '../logger.js';

// ── Built-in registry configs ───────────────────────────────────────

export const npmRegistry: RegistryConfig = {
  host: 'registry.npmjs.org',
  displayName: 'npm',
  type: 'npm',
};

export const pypiRegistry: RegistryConfig = {
  host: 'pypi.org',
  displayName: 'PyPI',
  type: 'pypi',
  mirrorHosts: ['files.pythonhosted.org'],
};

export const debianRegistry: RegistryConfig = {
  host: 'deb.debian.org',
  displayName: 'Debian APT',
  type: 'debian',
  mirrorHosts: ['security.debian.org'],
};

// ── PyPI sidecar suffixes (PEP 658 metadata, PEP 714 provenance) ────

const PYPI_SIDECAR_SUFFIXES = ['.metadata', '.provenance'];

/**
 * Strips known PEP 658/714 sidecar suffixes from a PyPI filename.
 * e.g. "numpy-1.26.0-cp312-cp312-manylinux_2_17_x86_64.whl.metadata"
 *   -> "numpy-1.26.0-cp312-cp312-manylinux_2_17_x86_64.whl"
 * Returns the filename unchanged if no known suffix matches.
 */
function stripPypiSidecarSuffix(filename: string): string {
  for (const suffix of PYPI_SIDECAR_SUFFIXES) {
    if (filename.endsWith(suffix)) {
      return filename.slice(0, -suffix.length);
    }
  }
  return filename;
}

// ── URL Parsers ─────────────────────────────────────────────────────

/**
 * Parses an npm registry URL path into a PackageIdentity.
 * Returns undefined if the path doesn't match a known pattern.
 *
 * Patterns:
 *   GET /@scope/name           -> metadata (scope + name)
 *   GET /@scope%2fname         -> metadata (URL-encoded scope)
 *   GET /name                  -> metadata (unscoped)
 *   GET /name/-/name-1.0.0.tgz -> tarball (unscoped)
 *   GET /@scope/name/-/name-1.0.0.tgz -> tarball (scoped)
 */
export function parseNpmUrl(path: string): PackageIdentity | undefined {
  // Clean query string
  const cleanPath = path.split('?')[0];

  // Handle URL-encoded scoped packages: /@scope%2fname -> /@scope/name
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(cleanPath);
  } catch {
    // Malformed percent-encoding (e.g., %E0%A4) -- fail-closed
    return undefined;
  }

  // Tarball request: contains /-/
  const tarballIndex = decodedPath.indexOf('/-/');
  if (tarballIndex >= 0) {
    const packagePart = decodedPath.substring(1, tarballIndex); // strip leading /
    const filename = decodedPath.substring(tarballIndex + 3); // after /-/
    const version = extractVersionFromNpmTarball(filename, packagePart);

    const parsed = parseNpmPackagePart(packagePart);
    if (!parsed) return undefined;

    return { registry: 'npm', ...parsed, version };
  }

  // Metadata request: /@scope/name or /name
  const packagePart = decodedPath.substring(1); // strip leading /
  if (!packagePart || packagePart === '-') return undefined;

  const parsed = parseNpmPackagePart(packagePart);
  if (!parsed) return undefined;

  return { registry: 'npm', ...parsed };
}

/**
 * Parses the package part of an npm URL (without leading /).
 * Returns { name, scope? } or undefined.
 */
function parseNpmPackagePart(packagePart: string): { name: string; scope?: string } | undefined {
  if (packagePart.startsWith('@')) {
    const slashIdx = packagePart.indexOf('/');
    if (slashIdx < 0) return undefined;
    const scope = packagePart.substring(1, slashIdx);
    const name = packagePart.substring(slashIdx + 1);
    if (!scope || !name) return undefined;
    return { name, scope };
  }
  // Ensure we don't parse paths with extra segments as metadata
  // /name/something should not be a metadata request (except /-/ which is handled above)
  if (packagePart.includes('/')) return undefined;
  if (!packagePart) return undefined;
  return { name: packagePart };
}

/**
 * Extracts version from an npm tarball filename.
 * Format: {name}-{version}.tgz
 */
function extractVersionFromNpmTarball(filename: string, packagePart: string): string | undefined {
  // For scoped packages, filename is just name-version.tgz (no scope prefix)
  const name = packagePart.includes('/') ? (packagePart.split('/').pop() ?? packagePart) : packagePart;
  const prefix = `${name}-`;
  if (!filename.startsWith(prefix) || !filename.endsWith('.tgz')) return undefined;
  return filename.slice(prefix.length, -4); // remove prefix and .tgz
}

/**
 * Parses a PyPI Simple Repository URL path into a PackageIdentity.
 * Returns undefined if the path doesn't match.
 *
 * Pattern: GET /simple/{name}/
 */
export function parsePypiSimpleUrl(path: string): PackageIdentity | undefined {
  const cleanPath = path.split('?')[0];
  // Match /simple/package-name/ (with or without trailing slash)
  const match = cleanPath.match(/^\/simple\/([a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?)\/?$/);
  if (!match) return undefined;
  return { registry: 'pypi', name: normalizePypiName(match[1]) };
}

/**
 * Parses a PyPI tarball URL path into a PackageIdentity.
 * Returns undefined if the path doesn't match.
 *
 * Tarball URLs on files.pythonhosted.org:
 *   /packages/.../numpy-1.26.0.tar.gz
 *   /packages/.../numpy-1.26.0-cp312-cp312-manylinux_2_17_x86_64.whl
 */
export function parsePypiTarballUrl(path: string): PackageIdentity | undefined {
  const cleanPath = path.split('?')[0];
  const filename = cleanPath.split('/').pop();
  if (!filename) return undefined;

  return extractPypiPackageFromFilename(filename);
}

/**
 * Extracts package name and version from a PyPI distribution filename.
 *
 * Handles both sdist and wheel formats:
 *   numpy-1.26.0.tar.gz -> { name: 'numpy', version: '1.26.0' }
 *   numpy-1.26.0-cp312-*.whl -> { name: 'numpy', version: '1.26.0' }
 */
export function extractPypiPackageFromFilename(filename: string): PackageIdentity | undefined {
  // Strip known sidecar suffixes (e.g. .whl.metadata -> .whl) before parsing
  const baseFilename = stripPypiSidecarSuffix(filename);

  // Wheel format: {name}-{version}(-{tags}).whl
  // Sdist format: {name}-{version}.tar.gz or {name}-{version}.zip
  // The name-version boundary is the first hyphen followed by a digit
  const match = baseFilename.match(
    /^([a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?)-(\d[^-]*?)(?:\.tar\.gz|\.zip|-[a-zA-Z].*\.whl)$/,
  );
  if (!match) return undefined;

  return {
    registry: 'pypi',
    name: normalizePypiName(match[1]),
    version: match[2],
  };
}

/**
 * Normalizes a PyPI package name to lowercase with hyphens.
 * PEP 503: package names are case-insensitive and treat
 * hyphens, underscores, and dots as equivalent.
 */
export function normalizePypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

// ── Debian URL parsing ──────────────────────────────────────────────

/**
 * Extracts package name and version from a Debian `.deb` filename.
 *
 * Format: {name}_{version}_{arch}.deb
 * Examples:
 *   libssl3_3.0.11-1~deb12u2_arm64.deb -> name='libssl3', version='3.0.11-1~deb12u2'
 *   gcc-14-base_14.2.0-19_arm64.deb    -> name='gcc-14-base', version='14.2.0-19'
 *
 * Epoch versions (e.g., 1:2.3-4) use %3a URL-encoding for the colon.
 */
export function extractDebianPackageFromFilename(filename: string): PackageIdentity | undefined {
  // Must end with .deb
  if (!filename.endsWith('.deb')) return undefined;

  // Strip .deb suffix
  const base = filename.slice(0, -4);

  // Split on underscores: name_version_arch
  const firstUnderscore = base.indexOf('_');
  if (firstUnderscore < 1) return undefined;

  const lastUnderscore = base.lastIndexOf('_');
  if (lastUnderscore <= firstUnderscore) return undefined;

  const name = base.substring(0, firstUnderscore);
  let version = base.substring(firstUnderscore + 1, lastUnderscore);

  // Decode URL-encoded epoch (e.g., 1%3a2.3-4 -> 1:2.3-4)
  try {
    version = decodeURIComponent(version);
  } catch {
    // Malformed encoding -- use as-is
  }

  if (!name || !version) return undefined;

  return { registry: 'debian', name, version };
}

/**
 * Parses a Debian repository URL path into a PackageIdentity.
 * Returns undefined for non-.deb paths (metadata, Release files, etc.).
 *
 * Matches any URL whose last path segment ends with `.deb` — not restricted
 * to `/pool/` paths, since mirrors and security repos may use different layouts.
 * Non-.deb paths (Release, Packages.gz, GPG keys) return undefined for pass-through.
 */
export function parseDebianPackageUrl(path: string): PackageIdentity | undefined {
  const cleanPath = path.split('?')[0];
  const filename = cleanPath.split('/').pop();
  if (!filename || !filename.endsWith('.deb')) return undefined;

  return extractDebianPackageFromFilename(filename);
}

// ── Request classification ──────────────────────────────────────────

/** Returns true if the URL path is an npm metadata request (no /-/ segment). */
export function isNpmMetadataRequest(path: string): boolean {
  return parseNpmUrl(path) !== undefined && !path.includes('/-/');
}

/** Returns true if the URL path is an npm tarball download. */
export function isNpmTarballRequest(path: string): boolean {
  return path.includes('/-/') && parseNpmUrl(path)?.version !== undefined;
}

/** Returns true if the URL path is a PyPI Simple Repository request. */
export function isPypiSimpleRequest(path: string): boolean {
  return parsePypiSimpleUrl(path) !== undefined;
}

// ── npm Packument types (minimal) ───────────────────────────────────

/** Minimal npm packument structure for filtering. */
export interface NpmPackument {
  readonly name: string;
  readonly versions: Record<string, unknown>;
  readonly 'dist-tags'?: Record<string, string>;
  readonly time?: Record<string, string>;
  readonly [key: string]: unknown;
}

// ── Metadata filtering ─────────────────────────────────────────────

/**
 * Filters an npm packument to remove disallowed versions.
 *
 * The filtered packument has:
 * - Disallowed versions removed from `versions` and `time`
 * - `dist-tags.latest` updated to point to the newest remaining version
 * - `created` and `modified` timestamps preserved in `time`
 */
export function filterNpmPackument(
  packument: NpmPackument,
  validator: PackageValidator,
  packageName: string,
  scope?: string,
): { filtered: NpmPackument; denied: Array<{ version: string; reason: string }> } {
  const denied: Array<{ version: string; reason: string }> = [];
  const filteredVersions: Record<string, unknown> = {};
  const filteredTime: Record<string, string> = {};

  // Always keep 'created' and 'modified' timestamps
  if (packument.time?.created) filteredTime.created = packument.time.created;
  if (packument.time?.modified) filteredTime.modified = packument.time.modified;

  for (const [version, manifest] of Object.entries(packument.versions)) {
    const rawDate = packument.time?.[version] ? new Date(packument.time[version]) : undefined;
    // Treat invalid dates (NaN) as missing — prevents fail-open on garbage timestamps
    const publishedAt = rawDate && Number.isFinite(rawDate.getTime()) ? rawDate : undefined;

    const decision = validator.validate({ registry: 'npm', name: packageName, scope, version }, { publishedAt });

    if (decision.status === 'allow') {
      filteredVersions[version] = manifest;
      if (packument.time?.[version]) {
        filteredTime[version] = packument.time[version];
      }
    } else {
      denied.push({ version, reason: decision.reason });
    }
  }

  // Update dist-tags to point to allowed versions only
  const filteredDistTags: Record<string, string> = {};
  for (const [tag, version] of Object.entries(packument['dist-tags'] ?? {})) {
    if (version in filteredVersions) {
      filteredDistTags[tag] = version;
    }
  }

  // If 'latest' was removed, recalculate as newest remaining version
  if (!filteredDistTags.latest && Object.keys(filteredVersions).length > 0) {
    const newestVersion = Object.keys(filteredTime)
      .filter((k) => k !== 'created' && k !== 'modified')
      .sort((a, b) => new Date(filteredTime[b]).getTime() - new Date(filteredTime[a]).getTime())[0];
    if (newestVersion) {
      filteredDistTags.latest = newestVersion;
    }
  }

  return {
    filtered: {
      ...packument,
      versions: filteredVersions,
      'dist-tags': filteredDistTags,
      time: filteredTime,
    },
    denied,
  };
}

/**
 * Filters a PyPI Simple Repository HTML page to remove disallowed versions.
 *
 * The HTML contains <a> elements with hrefs pointing to tarballs/wheels.
 * Version is extracted from the filename in each href.
 *
 * Returns the filtered HTML, denied version list, and the set of allowed
 * versions (collected during filtering to avoid re-parsing the HTML).
 */
export function filterPypiIndex(
  html: string,
  validator: PackageValidator,
  packageName: string,
  versionTimestamps: Map<string, Date>,
): { filtered: string; denied: Array<{ version: string; reason: string }>; allowedVersions: Set<string> } {
  const denied: Array<{ version: string; reason: string }> = [];
  const allowedVersions = new Set<string>();
  // Track which versions we've already denied (avoid duplicate entries)
  const deniedVersions = new Set<string>();

  // Match <a> tags with href attributes pointing to distribution files
  const filtered = html.replace(/<a\s+[^>]*href="[^"]*"[^>]*>[^<]*<\/a>\s*/gi, (match) => {
    const hrefMatch = match.match(/href="([^"]*)"/);
    if (!hrefMatch) return match;

    const href = hrefMatch[1];
    const filename = href.split('/').pop()?.split('#')[0]; // strip fragment
    if (!filename) return match;

    const parsed = extractPypiPackageFromFilename(filename);
    if (!parsed || !parsed.version) return match;

    const publishedAt = versionTimestamps.get(parsed.version);
    const decision = validator.validate(
      { registry: 'pypi', name: packageName, version: parsed.version },
      publishedAt !== undefined ? { publishedAt } : undefined,
    );

    if (decision.status === 'allow') {
      allowedVersions.add(parsed.version);
      return match;
    }

    // Only add to denied list once per version (multiple files per version)
    if (!deniedVersions.has(parsed.version)) {
      deniedVersions.add(parsed.version);
      denied.push({ version: parsed.version, reason: decision.reason });
    }
    return ''; // Remove the link
  });

  return { filtered, denied, allowedVersions };
}

// ── AllowedVersionCache helpers ─────────────────────────────────────

/** Cache TTL: 1 hour. */
const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Gets allowed versions from cache, returning undefined on miss or expiry.
 */
export function getCachedVersions(cache: AllowedVersionCache, pkg: PackageIdentity): ReadonlySet<string> | undefined {
  const key = packageCacheKey(pkg);
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt.getTime() > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return entry.allowedVersions;
}

/**
 * Stores allowed versions in the cache.
 */
export function setCachedVersions(
  cache: AllowedVersionCache,
  pkg: PackageIdentity,
  versions: ReadonlySet<string>,
): void {
  const key = packageCacheKey(pkg);
  cache.set(key, { allowedVersions: versions, cachedAt: new Date() });
}

// ── Registry request handler ────────────────────────────────────────

/** Options for the registry request handler. */
export interface RegistryHandlerOptions {
  readonly validator: PackageValidator;
  readonly cache: AllowedVersionCache;
  readonly auditLogPath?: string;
}

/**
 * Handles an HTTP request routed to a registry host.
 * Dispatches to metadata filtering or tarball backstop based on URL pattern.
 */
export async function handleRegistryRequest(
  registry: RegistryConfig,
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  host: string,
  port: number,
  options: RegistryHandlerOptions,
): Promise<void> {
  const path = clientReq.url ?? '/';

  switch (registry.type) {
    case 'npm':
      if (isNpmMetadataRequest(path)) {
        await handleNpmMetadata(registry, path, clientReq, clientRes, host, port, options);
      } else if (path.includes('/-/') && !path.startsWith('/-/')) {
        // Tarball download: /-/ appears after package name (e.g., /express/-/express-1.0.0.tgz)
        await handleTarballDownload(registry, path, clientRes, host, port, options, 'npm');
      } else {
        // npm internal endpoints (/-/ping, /-/v1/security/...) or unknown paths -- pass through
        await forwardUpstream(clientReq, clientRes, host, port);
      }
      break;
    case 'pypi':
      if (isPypiSimpleRequest(path)) {
        await handlePypiSimple(registry, path, clientReq, clientRes, host, port, options);
      } else if (registry.mirrorHosts?.includes(host)) {
        // Mirror hosts serve tarballs
        await handleTarballDownload(registry, path, clientRes, host, port, options, 'pypi');
      } else {
        // All other pypi.org paths -- pass through
        await forwardUpstream(clientReq, clientRes, host, port);
      }
      break;
    case 'debian':
      await handleDebianRequest(registry, path, clientReq, clientRes, host, port, options);
      break;
    default: {
      const _exhaustive: never = registry.type;
      throw new Error(`Unknown registry type: ${String(_exhaustive)}`);
    }
  }
}

// ── Internal handlers ───────────────────────────────────────────────

async function handleNpmMetadata(
  _registry: RegistryConfig,
  path: string,
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  host: string,
  port: number,
  options: RegistryHandlerOptions,
): Promise<void> {
  const pkg = parseNpmUrl(path);
  if (!pkg) {
    await forwardUpstream(clientReq, clientRes, host, port);
    return;
  }

  try {
    const upstream = await fetchUpstreamJson<NpmPackument>(host, port, path);
    if (!upstream) {
      clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
      clientRes.end('Failed to fetch package metadata from upstream');
      return;
    }

    const { filtered, denied } = filterNpmPackument(upstream, options.validator, pkg.name, pkg.scope);

    // Cache allowed versions
    const allowedVersions = new Set(Object.keys(filtered.versions));
    setCachedVersions(options.cache, pkg, allowedVersions);

    // Audit log denied versions
    for (const d of denied) {
      writeAuditEntry(options.auditLogPath, {
        timestamp: new Date().toISOString(),
        registry: pkg.registry,
        packageName: pkg.name,
        packageScope: pkg.scope,
        packageVersion: d.version,
        decision: 'deny',
        reason: d.reason,
        source: 'metadata-filter',
        requestPath: path,
      });
    }

    // Audit log allowed versions (summary to avoid per-version verbosity)
    if (allowedVersions.size > 0) {
      writeAuditEntry(options.auditLogPath, {
        timestamp: new Date().toISOString(),
        registry: pkg.registry,
        packageName: pkg.name,
        packageScope: pkg.scope,
        packageVersion: `${allowedVersions.size} version(s)`,
        decision: 'allow',
        reason: 'Passed all validation checks',
        source: 'metadata-filter',
        requestPath: path,
      });
    }

    if (denied.length > 0) {
      logger.info(
        `[registry-proxy] npm ${canonicalPackageName(pkg)}: filtered ${denied.length} version(s), ${allowedVersions.size} allowed`,
      );
    }

    const body = JSON.stringify(filtered);
    clientRes.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    });
    clientRes.end(body);
  } catch (err) {
    logger.info(
      `[registry-proxy] npm metadata error for ${canonicalPackageName(pkg)}: ${err instanceof Error ? err.message : String(err)}`,
    );
    clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
    clientRes.end('Failed to process package metadata');
  }
}

async function handlePypiSimple(
  _registry: RegistryConfig,
  path: string,
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  host: string,
  port: number,
  options: RegistryHandlerOptions,
): Promise<void> {
  const pkg = parsePypiSimpleUrl(path);
  if (!pkg) {
    await forwardUpstream(clientReq, clientRes, host, port);
    return;
  }

  try {
    // Fetch Simple Repository HTML and version timestamps concurrently
    const [html, versionTimestamps] = await Promise.all([
      fetchUpstreamText(host, port, path, 'text/html'),
      fetchPypiVersionTimestamps(host, port, pkg.name),
    ]);

    if (html === undefined) {
      clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
      clientRes.end('Failed to fetch package index from upstream');
      return;
    }

    const { filtered, denied, allowedVersions } = filterPypiIndex(html, options.validator, pkg.name, versionTimestamps);

    // Cache allowed versions (collected during filtering)
    setCachedVersions(options.cache, pkg, allowedVersions);

    // Audit log denied versions
    for (const d of denied) {
      writeAuditEntry(options.auditLogPath, {
        timestamp: new Date().toISOString(),
        registry: pkg.registry,
        packageName: pkg.name,
        packageVersion: d.version,
        decision: 'deny',
        reason: d.reason,
        source: 'metadata-filter',
        requestPath: path,
      });
    }

    // Audit log allowed versions (summary to avoid per-version verbosity)
    if (allowedVersions.size > 0) {
      writeAuditEntry(options.auditLogPath, {
        timestamp: new Date().toISOString(),
        registry: pkg.registry,
        packageName: pkg.name,
        packageVersion: `${allowedVersions.size} version(s)`,
        decision: 'allow',
        reason: 'Passed all validation checks',
        source: 'metadata-filter',
        requestPath: path,
      });
    }

    if (denied.length > 0) {
      logger.info(
        `[registry-proxy] PyPI ${pkg.name}: filtered ${denied.length} version(s), ${allowedVersions.size} allowed`,
      );
    }

    clientRes.writeHead(200, {
      'Content-Type': 'text/html',
      'Content-Length': Buffer.byteLength(filtered),
    });
    clientRes.end(filtered);
  } catch (err) {
    logger.info(
      `[registry-proxy] PyPI metadata error for ${pkg.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
    clientRes.end('Failed to process package index');
  }
}

async function handleTarballDownload(
  registry: RegistryConfig,
  path: string,
  clientRes: http.ServerResponse,
  host: string,
  port: number,
  options: RegistryHandlerOptions,
  registryType: RegistryType,
): Promise<void> {
  const pkg = registryType === 'npm' ? parseNpmUrl(path) : parsePypiTarballUrl(path);
  if (!pkg || !pkg.version) {
    // Can't parse -- fail-closed
    logger.info(`[registry-proxy] tarball backstop: can't parse URL, denying: ${path}`);
    clientRes.writeHead(403, { 'Content-Type': 'text/plain' });
    clientRes.end('Forbidden: unable to identify package from URL — ensure the package name and version are correct');
    return;
  }

  // Check allowed version cache
  const cached = getCachedVersions(options.cache, pkg);
  if (cached !== undefined) {
    if (cached.has(pkg.version)) {
      // Allowed -- forward upstream
      writeAuditEntry(options.auditLogPath, {
        timestamp: new Date().toISOString(),
        registry: pkg.registry,
        packageName: pkg.name,
        packageScope: pkg.scope,
        packageVersion: pkg.version,
        decision: 'allow',
        reason: 'Version in allowed cache from metadata filtering',
        source: 'tarball-backstop',
        requestPath: path,
      });
      await forwardToUpstream(clientRes, host, port, path, { timeoutMs: 60_000 });
      return;
    }
    // In cache but not in allowed set -- was filtered during metadata validation
    const name = canonicalPackageName(pkg);
    logger.info(`[registry-proxy] tarball backstop: denied ${name}@${pkg.version}`);
    writeAuditEntry(options.auditLogPath, {
      timestamp: new Date().toISOString(),
      registry: pkg.registry,
      packageName: pkg.name,
      packageScope: pkg.scope,
      packageVersion: pkg.version,
      decision: 'deny',
      reason: 'Version not in allowed cache (filtered from metadata)',
      source: 'tarball-backstop',
      requestPath: path,
    });
    clientRes.writeHead(403, { 'Content-Type': 'text/plain' });
    clientRes.end(
      `Forbidden: ${name}@${pkg.version} was filtered during metadata validation (may be too new, denylisted, or otherwise disallowed). Try an older version.`,
    );
    return;
  }

  // Cache miss -- need to fetch metadata and validate
  try {
    const decision = await fetchAndValidateVersion(registry, pkg, options);
    if (decision.status === 'allow') {
      writeAuditEntry(options.auditLogPath, {
        timestamp: new Date().toISOString(),
        registry: pkg.registry,
        packageName: pkg.name,
        packageScope: pkg.scope,
        packageVersion: pkg.version,
        decision: 'allow',
        reason: 'Version passed validation on cache miss',
        source: 'tarball-backstop',
        requestPath: path,
      });
      await forwardToUpstream(clientRes, host, port, path, { timeoutMs: 60_000 });
    } else {
      const name = canonicalPackageName(pkg);
      logger.info(`[registry-proxy] tarball backstop (cache miss): denied ${name}@${pkg.version}: ${decision.reason}`);
      writeAuditEntry(options.auditLogPath, {
        timestamp: new Date().toISOString(),
        registry: pkg.registry,
        packageName: pkg.name,
        packageScope: pkg.scope,
        packageVersion: pkg.version,
        decision: 'deny',
        reason: decision.reason,
        source: 'tarball-backstop',
        requestPath: path,
      });
      clientRes.writeHead(403, { 'Content-Type': 'text/plain' });
      clientRes.end(`Forbidden: ${name}@${pkg.version} — ${decision.reason}. Try a different version.`);
    }
  } catch (err) {
    // Fail-closed
    logger.info(`[registry-proxy] tarball backstop error: ${err instanceof Error ? err.message : String(err)}`);
    clientRes.writeHead(403, { 'Content-Type': 'text/plain' });
    clientRes.end(
      'Forbidden: unable to validate package version (upstream metadata fetch failed). This is a fail-closed response — retry later or use an allowlisted package.',
    );
  }
}

async function handleDebianRequest(
  _registry: RegistryConfig,
  path: string,
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  host: string,
  port: number,
  options: RegistryHandlerOptions,
): Promise<void> {
  // parseDebianPackageUrl returns undefined for non-.deb paths (metadata,
  // Release files, GPG keys) — those pass through unmodified since apt
  // verifies them with GPG signatures.
  const pkg = parseDebianPackageUrl(path);
  if (!pkg) {
    // Distinguish "not a .deb file" (pass-through) from "malformed .deb" (fail-closed)
    const filename = path.split('?')[0].split('/').pop() ?? '';
    if (filename.endsWith('.deb')) {
      logger.info(`[registry-proxy] debian backstop: can't parse .deb filename, denying: ${path}`);
      clientRes.writeHead(403, { 'Content-Type': 'text/plain' });
      clientRes.end('Forbidden: unable to identify Debian package from URL');
      return;
    }
    await forwardUpstream(clientReq, clientRes, host, port);
    return;
  }

  // Debian packages are distro-curated — bypass quarantine by providing
  // an epoch publish date. Only allow/denylist checks apply.
  const decision = options.validator.validate(pkg, { publishedAt: new Date(0) });

  writeAuditEntry(options.auditLogPath, {
    timestamp: new Date().toISOString(),
    registry: 'debian',
    packageName: pkg.name,
    packageVersion: pkg.version,
    decision: decision.status,
    reason: decision.reason,
    source: 'deb-backstop',
    requestPath: path,
  });

  if (decision.status === 'allow') {
    await forwardUpstream(clientReq, clientRes, host, port);
  } else {
    logger.info(`[registry-proxy] debian backstop: denied ${pkg.name}_${pkg.version}: ${decision.reason}`);
    clientRes.writeHead(403, { 'Content-Type': 'text/plain' });
    clientRes.end(`Forbidden: Debian package ${pkg.name} (${pkg.version}) — ${decision.reason}`);
  }
}

/**
 * Fetches metadata for a package on cache miss and validates the
 * requested version. Populates the cache as a side effect.
 */
async function fetchAndValidateVersion(
  registry: RegistryConfig,
  pkg: PackageIdentity,
  options: RegistryHandlerOptions,
): Promise<PackageDecision> {
  if (registry.type === 'npm') {
    const metadataPath = pkg.scope ? `/@${pkg.scope}/${pkg.name}` : `/${pkg.name}`;
    const packument = await fetchUpstreamJson<NpmPackument>(registry.host, 443, metadataPath);
    if (!packument) return { status: 'deny', reason: 'Failed to fetch package metadata from upstream' };

    const { filtered, denied } = filterNpmPackument(packument, options.validator, pkg.name, pkg.scope);
    const allowedVersions = new Set(Object.keys(filtered.versions));
    setCachedVersions(options.cache, pkg, allowedVersions);

    if (pkg.version !== undefined && allowedVersions.has(pkg.version)) {
      return { status: 'allow', reason: 'Version passed validation' };
    }
    const deniedEntry = denied.find((d) => d.version === pkg.version);
    return { status: 'deny', reason: deniedEntry?.reason ?? 'Version not found in package metadata' };
  }

  // PyPI: fetch JSON API for timestamps, validate ALL versions, populate cache
  const versionTimestamps = await fetchPypiVersionTimestamps(registry.host, 443, pkg.name);
  const allowedVersions = new Set<string>();
  let requestedVersionReason: string | undefined;

  for (const [version, publishedAt] of versionTimestamps) {
    const decision = options.validator.validate({ registry: 'pypi', name: pkg.name, version }, { publishedAt });
    if (decision.status === 'allow') {
      allowedVersions.add(version);
    } else if (version === pkg.version) {
      requestedVersionReason = decision.reason;
    }
  }

  setCachedVersions(options.cache, pkg, allowedVersions);

  if (pkg.version !== undefined && allowedVersions.has(pkg.version)) {
    return { status: 'allow', reason: 'Version passed validation' };
  }
  return { status: 'deny', reason: requestedVersionReason ?? 'Version not found in package metadata' };
}

// ── HTTP helpers ────────────────────────────────────────────────────

/**
 * Fetches a response body from upstream registry via HTTPS.
 * Returns the raw Buffer, or undefined on non-200 or error.
 */
async function fetchUpstream(host: string, port: number, path: string, accept: string): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: host,
        port,
        path,
        method: 'GET',
        headers: { accept, host },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve(undefined);
            return;
          }
          resolve(Buffer.concat(chunks));
        });
        res.on('error', () => resolve(undefined));
      },
    );
    req.on('error', () => resolve(undefined));
    req.setTimeout(30_000, () => {
      req.destroy();
      resolve(undefined);
    });
    req.end();
  });
}

/**
 * Fetches JSON from upstream registry via HTTPS.
 */
async function fetchUpstreamJson<T>(host: string, port: number, path: string): Promise<T | undefined> {
  const buf = await fetchUpstream(host, port, path, 'application/json');
  if (!buf) return undefined;
  try {
    return JSON.parse(buf.toString()) as T;
  } catch {
    return undefined;
  }
}

/**
 * Fetches text content from upstream registry via HTTPS.
 */
async function fetchUpstreamText(
  host: string,
  port: number,
  path: string,
  accept: string,
): Promise<string | undefined> {
  const buf = await fetchUpstream(host, port, path, accept);
  return buf?.toString();
}

/**
 * Fetches PyPI version timestamps from the JSON API.
 * Returns a map of version -> publish date.
 */
async function fetchPypiVersionTimestamps(host: string, port: number, packageName: string): Promise<Map<string, Date>> {
  const timestamps = new Map<string, Date>();
  const data = await fetchUpstreamJson<PypiJsonApi>(host, port, `/pypi/${packageName}/json`);
  if (!data?.releases) return timestamps;

  for (const [version, files] of Object.entries(data.releases)) {
    // Use the earliest upload timestamp among the version's files
    let earliest: Date | undefined;
    for (const file of files) {
      if (file.upload_time_iso_8601) {
        const date = new Date(file.upload_time_iso_8601);
        if (!earliest || date < earliest) earliest = date;
      }
    }
    if (earliest) timestamps.set(version, earliest);
  }

  return timestamps;
}

interface PypiJsonApi {
  releases: Record<string, Array<{ upload_time_iso_8601?: string }>>;
}

// ── Upstream forwarding ─────────────────────────────────────────────

/** Options for forwardToUpstream. */
interface ForwardOptions {
  /** Pipe the client request body to upstream (pass-through mode). */
  readonly clientReq?: http.IncomingMessage;
  /** Forward all client headers (when clientReq is set). Otherwise uses minimal headers. */
  readonly forwardHeaders?: boolean;
  /** Timeout in milliseconds. Default: 30s. */
  readonly timeoutMs?: number;
}

/**
 * Forwards a request to the upstream HTTPS server and pipes the response
 * back to the client. Supports both pass-through (with client request
 * body piping) and simple GET forwarding modes.
 */
async function forwardToUpstream(
  clientRes: http.ServerResponse,
  host: string,
  port: number,
  path: string,
  options: ForwardOptions = {},
): Promise<void> {
  const { clientReq, forwardHeaders = !!clientReq, timeoutMs = 30_000 } = options;

  return new Promise((resolve) => {
    const headers = forwardHeaders && clientReq ? { ...clientReq.headers, host } : { host };

    const upstreamReq = https.request(
      {
        hostname: host,
        port,
        method: clientReq?.method ?? 'GET',
        path: clientReq?.url ?? path,
        headers,
      },
      (upstreamRes) => {
        clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
        upstreamRes.on('end', resolve);
        upstreamRes.on('error', () => {
          if (!clientRes.headersSent) {
            clientRes.writeHead(502);
            clientRes.end('Upstream error');
          }
          resolve();
        });
      },
    );
    upstreamReq.on('error', () => {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502);
        clientRes.end('Upstream connection error');
      }
      resolve();
    });
    upstreamReq.setTimeout(timeoutMs, () => {
      upstreamReq.destroy();
      if (!clientRes.headersSent) {
        clientRes.writeHead(504);
        clientRes.end('Upstream timeout');
      }
      resolve();
    });

    if (clientReq) {
      clientReq.pipe(upstreamReq);
    } else {
      upstreamReq.end();
    }
  });
}

/**
 * Forwards a request upstream without modification (pass-through).
 * Pipes the client request body and forwards all client headers.
 */
async function forwardUpstream(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  host: string,
  port: number,
): Promise<void> {
  await forwardToUpstream(clientRes, host, port, clientReq.url ?? '/', {
    clientReq,
    forwardHeaders: true,
  });
}

// ── Audit logging ───────────────────────────────────────────────────

/**
 * Writes a package audit entry to the JSONL audit log.
 * Fire-and-forget: callers should not await the returned promise.
 */
function writeAuditEntry(auditLogPath: string | undefined, entry: PackageAuditEntry): void {
  if (!auditLogPath) return;
  fs.appendFile(auditLogPath, JSON.stringify(entry) + '\n').catch((err: unknown) => {
    logger.warn(`[registry-proxy] Failed to write audit entry: ${err instanceof Error ? err.message : String(err)}`);
  });
}
