# Secure Package Installation Proxy for Docker Agent Mode

## Overview

This design extends IronCurtain's Docker Agent Mode to support secure package
installation (npm, pip/PyPI, uv) inside network-isolated containers. The
existing MITM proxy -- which already terminates TLS, allowlists hosts, and
swaps sentinel credentials -- is extended with a **registry proxy** layer that
**rewrites package metadata responses** to remove disallowed versions before the
package manager ever sees them, and **blocks tarball downloads** as a
defense-in-depth backstop. All decisions are binary: allow or deny (no
escalation). The design preserves IronCurtain's core security invariants:
default-deny, credential isolation, and a complete audit trail.

## Architecture Context

Today's Docker Agent Mode data flow:

```
Container (agent)
  |  HTTP CONNECT (HTTPS_PROXY)
  v
MITM Proxy (host)
  |  host allowlist: api.anthropic.com, api.openai.com, ...
  |  TLS termination, endpoint filtering, key swap
  v
Upstream LLM API
```

The MITM proxy uses a `providersByHost` map to allowlist CONNECT targets.
Any host not in the map gets a `403 Forbidden` on CONNECT. This is the
primary network isolation enforcement point for Docker sessions.

**Package registries are currently blocked** because `registry.npmjs.org`,
`pypi.org`, and `files.pythonhosted.org` are not in the allowlist.

## Key Design Decisions

### 1. Extend the MITM proxy rather than create a new MCP tool

**Decision:** Package installation flows through the existing MITM proxy as
HTTP traffic, not through the MCP proxy as a tool call.

**Rationale:**
- Package managers (npm, pip, uv) are complex CLI tools that make dozens of
  HTTP requests per install (dependency resolution, tarball downloads, metadata
  fetches). Wrapping them in an MCP tool would require re-implementing
  resolution logic or shelling out inside the trusted process.
- The MITM proxy already has all the infrastructure: TLS termination,
  per-host cert generation, host allowlisting, request buffering, and
  connection tracking.
- Agents call `npm install` or `pip install` naturally through their shell
  access -- no special tool invocation needed.
- Package managers respect `HTTPS_PROXY`, which is already set in the
  container environment.

**Trade-off:** We lose the MCP-level policy engine evaluation (which operates
on structured `ToolCallRequest` objects). Instead, package validation happens
inside the MITM proxy itself, operating on HTTP request/response metadata.
This is acceptable because: (a) the security-relevant decision is whether a
specific package version is safe to download, not whether the agent is
"allowed to install packages" (which is always yes -- they need packages to
do their work), and (b) the MITM proxy already makes similar allow/deny
decisions via endpoint filtering.

### 2. Proactive metadata filtering (primary gate)

**Decision:** The proxy rewrites registry metadata responses to remove
disallowed versions **before** the package manager resolves dependencies.
This is the primary security enforcement point.

**Rationale:**
- npm and pip resolve versions from metadata, then download tarballs for
  the resolved versions. If we only block at the tarball download level,
  the package manager has already committed to a specific version and will
  fail with a confusing error (403/404 after retries, hard install failure).
- By filtering metadata, the package manager never sees disallowed versions.
  It resolves to the best allowed version naturally, or produces a clean
  "no matching version" error if all versions are filtered.
- This approach is proven: [npm-registry-firewall](https://github.com/antongolub/npm-registry-firewall)
  uses the same pattern.

**npm metadata filtering:**
1. Proxy fetches the full packument JSON from upstream (`GET /{package}`)
2. Removes disallowed versions from the `versions` object
3. Removes corresponding entries from the `time` object
4. Updates `dist-tags.latest` to point to the newest remaining version
5. Returns the filtered packument to npm

**PyPI metadata filtering:**
1. Proxy fetches the Simple Repository HTML from upstream (`GET /simple/{package}/`)
2. Removes `<a>` links for disallowed version tarballs/wheels
3. Returns the filtered HTML to pip/uv

**Failure modes:**
- If a transitive dependency requires `foo@^2.0.0` and all 2.x versions are
  filtered, npm produces a clean `ETARGET` error. pip/uv produce
  "No matching distribution found." These are clear, actionable errors.

### 3. Tarball download blocking (defense-in-depth backstop)

**Decision:** Even though metadata filtering is the primary gate, the proxy
also validates tarball download requests and returns 403 for disallowed
versions. This is a defense-in-depth measure.

**Rationale:**
- An agent could construct a tarball URL directly (guessing or from cached
  data) without going through the metadata endpoint.
- The tarball check uses the same `PackageValidator` as the metadata filter,
  ensuring consistent decisions.
- The tarball check also catches any bugs in the metadata filtering logic.

**Implementation:** When a tarball download request arrives, the proxy:
1. Parses the package name and version from the URL
2. Checks the in-memory metadata cache (populated during metadata filtering)
3. If the version was filtered from metadata, returns 403
4. If the version is unknown (cache miss), fetches metadata from upstream
   and validates before forwarding

### 4. Binary allow/deny decisions (no escalation)

**Decision:** All package decisions are binary: allow or deny. No escalation
to the user.

**Rationale:**
- Escalation over HTTP is awkward: package managers have tight request
  timeouts (npm: 30s, pip: 15s), and holding HTTP connections open while
  waiting for human input is fragile.
- For a PoC, binary decisions are sufficient. Denied versions simply
  disappear from the package manager's view.
- Users control behavior through configuration (allowlist, denylist,
  quarantine period).

### 5. Validation scope for PoC

**Decision:** Implement two validation checks:

| Check | Description |
|-------|-------------|
| Package allowlist/denylist | User-configured lists in `config.json` |
| Version age gate | Versions published < N days ago are denied |

**Deferred checks (future work):**

| Check | Description |
|-------|-------------|
| Typosquatting detection | Requires a corpus of popular package names |
| Dependency confusion | Requires knowledge of internal package names |
| Malware signatures | Requires threat intel feed integration |

**Rationale:** Aikido safe-chain's full threat intelligence stack is a
production system with maintained signature databases. For a PoC, the
version age gate (which only requires reading the package metadata timestamp)
combined with an allowlist gives meaningful security value with minimal
complexity.

### 6. Version age gate: 2 days (configurable)

**Decision:** Deny versions whose publish timestamp is less than 2 days old.
Allowlisted packages bypass this check.

**Rationale:**
- Most malicious packages are detected and removed within 24-72 hours.
  A 2-day window provides margin without being so long that it blocks
  legitimate new packages indefinitely.
- This specifically targets new *versions* of packages (including brand-new
  packages where all versions are new), not established packages getting
  routine updates -- unless those updates are very recent.
- Configurable via `quarantineDays` in user config (default: 2, set to 0
  to disable).

### 7. Pre-install uv and ruff in base image

**Decision:** Install `uv` and `ruff` in `Dockerfile.base` (and
`Dockerfile.base.arm64`), not in agent-specific Dockerfiles.

**Rationale:**
- Both tools are useful regardless of which agent runs in the container.
- `uv` is a fast Python package manager that agents may use instead of pip.
- `ruff` is a fast Python linter (commonly requested by agents).
- Installing in the base image avoids re-downloading on every agent image
  rebuild.
- Both are single-binary installs with minimal image size impact.

### 8. Audit logging for package operations

**Decision:** Package install decisions are logged to a new
`package-audit.jsonl` file alongside the existing MCP audit log.

**Rationale:**
- Package operations are not MCP tool calls, so they do not fit the existing
  `AuditEntry` schema (which requires `serverName`, `toolName`, etc.).
- A separate audit stream avoids schema pollution and can be analyzed
  independently.
- The entry format mirrors `AuditEntry`'s spirit: timestamp, what was
  requested, what decision was made, and why.

## Component Architecture

```
Container
  |
  |  npm install express    (or pip install, uv add)
  |  -> HTTPS_PROXY=http://...
  |
  v
MITM Proxy (host-side)
  |
  |  CONNECT registry.npmjs.org:443
  |
  +--> Host Allowlist Check
  |      registry.npmjs.org -> RegistryConfig
  |      (registered alongside LLM providers)
  |
  +--> TLS Termination (per-host cert, same as LLM providers)
  |
  +--> Registry Request Handler (new)
  |      |
  |      +-- GET /{package} (npm metadata request)
  |      |     |
  |      |     +-- Fetch full packument from upstream
  |      |     +-- Filter versions: remove denylisted + too-new
  |      |     +-- Update dist-tags.latest to newest allowed version
  |      |     +-- Cache allowed version set in memory
  |      |     +-- Return filtered packument to container
  |      |     +-- Log filtered versions to package-audit.jsonl
  |      |
  |      +-- GET /simple/{package}/ (PyPI metadata request)
  |      |     |
  |      |     +-- Fetch HTML index from upstream
  |      |     +-- Remove <a> links for disallowed versions
  |      |     +-- Cache allowed version set in memory
  |      |     +-- Return filtered HTML to container
  |      |     +-- Log filtered versions to package-audit.jsonl
  |      |
  |      +-- GET /{package}/-/{tarball} (npm tarball download)
  |      +-- GET /packages/.../{tarball} (PyPI tarball download)
  |      |     |
  |      |     +-- Parse package name + version from URL
  |      |     +-- Check against cached allowed versions
  |      |     +-- If allowed -> forward upstream response
  |      |     +-- If denied  -> return 403
  |      |     +-- If unknown -> fetch metadata, validate, then decide
  |      |     +-- Log decision to package-audit.jsonl
  |      |
  |      +-- All other paths -> pass through
  |
  +--> Upstream Forward (same as LLM providers)
  |
  v
registry.npmjs.org / pypi.org / files.pythonhosted.org
```

## Interface Definitions

### Registry Provider Configuration

The existing `ProviderConfig` interface is designed for LLM APIs (key
injection, endpoint filtering). Registry proxies need different semantics:
no key injection, but package-level validation. Rather than overloading
`ProviderConfig`, we introduce a parallel `RegistryConfig` type and extend
the MITM proxy to handle both.

```typescript
/**
 * Supported package registry types.
 * Each type determines how package names and versions are extracted
 * from HTTP request paths, and how metadata responses are filtered.
 */
type RegistryType = 'npm' | 'pypi';

/**
 * Configuration for a package registry host.
 *
 * Unlike ProviderConfig (which handles credential swap and endpoint
 * filtering for LLM APIs), RegistryConfig handles package-level
 * validation for software registries.
 *
 * No key injection is needed -- package registries are public.
 */
interface RegistryConfig {
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
```

### Built-in Registry Configs

```typescript
const npmRegistry: RegistryConfig = {
  host: 'registry.npmjs.org',
  displayName: 'npm',
  type: 'npm',
};

const pypiRegistry: RegistryConfig = {
  host: 'pypi.org',
  displayName: 'PyPI',
  type: 'pypi',
  mirrorHosts: ['files.pythonhosted.org'],
};
```

### Package Validation Types

```typescript
/**
 * Parsed package identity extracted from a registry HTTP request.
 *
 * Invariant: scope is only present for npm scoped packages
 * (e.g., @types/node). PyPI packages never have a scope.
 */
interface PackageIdentity {
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
type PackageDecision =
  | { readonly status: 'allow'; readonly reason: string }
  | { readonly status: 'deny'; readonly reason: string };
```

### Package Validator Interface

```typescript
/**
 * Validates whether a package version should be allowed.
 *
 * Used in two contexts:
 * 1. Metadata filtering: called per-version to decide which versions
 *    to include in the filtered metadata response.
 * 2. Tarball backstop: called when a tarball download is requested,
 *    as a defense-in-depth check.
 *
 * Implementations are stateless -- all configuration is provided
 * at construction time.
 */
interface PackageValidator {
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
 * Per-version metadata from the registry, focused on the fields
 * needed for security validation.
 *
 * Intentionally minimal -- we only extract what we check.
 */
interface VersionMetadata {
  /** When this specific version was published. */
  readonly publishedAt?: Date;
  /** Whether this version has been deprecated. */
  readonly deprecated?: boolean;
}
```

### Allowed Version Cache

```typescript
/**
 * In-memory cache of allowed versions per package.
 * Populated during metadata filtering, consulted during tarball downloads.
 *
 * Keyed by canonical package identifier: 'npm:express', 'npm:@types/node',
 * 'pypi:numpy'.
 */
type AllowedVersionCache = Map<string, {
  /** Set of version strings that passed validation. */
  readonly allowedVersions: ReadonlySet<string>;
  /** When this cache entry was populated. */
  readonly cachedAt: Date;
}>;
```

### Package Audit Entry

```typescript
/**
 * Audit log entry for package installation decisions.
 * Written to package-audit.jsonl in the session directory.
 */
interface PackageAuditEntry {
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
  readonly source: 'metadata-filter' | 'tarball-backstop';
  /** The HTTP request path that triggered this check. */
  readonly requestPath: string;
}
```

### User Configuration Extension

```typescript
// Added to the existing UserConfig schema in user-config.ts

interface PackageInstallConfig {
  /** Enable package installation support. Default: true. */
  readonly enabled?: boolean;

  /**
   * Days a version must age before auto-allow.
   * Versions published less than this many days ago are denied
   * (filtered from metadata). Allowlisted packages bypass this.
   * Default: 2. Set to 0 to disable the age gate.
   */
  readonly quarantineDays?: number;

  /**
   * Packages always allowed (bypass age gate).
   * Format: 'express', '@types/node', 'numpy'.
   * Supports glob patterns: '@types/*', 'eslint-*'.
   */
  readonly allowedPackages?: readonly string[];

  /**
   * Packages always denied (all versions filtered from metadata).
   * Takes precedence over allowedPackages.
   */
  readonly deniedPackages?: readonly string[];
}
```

## URL Parsing Strategy

Each registry type requires a different URL parser to extract package identity
from HTTP request paths.

### npm Registry

npm uses a flat URL structure:

```
Metadata:   GET /express                      -> { name: 'express' }
            GET /@types%2fnode               -> { name: 'node', scope: 'types' }
            GET /@types/node                  -> { name: 'node', scope: 'types' }
Tarball:    GET /express/-/express-4.18.2.tgz -> { name: 'express', version: '4.18.2' }
            GET /@types/node/-/node-20.0.0.tgz -> { name: 'node', scope: 'types', version: '20.0.0' }
```

**Metadata requests** are intercepted, fetched from upstream, filtered, and
returned. The proxy identifies metadata requests by the absence of the `/-/`
path segment.

**Tarball requests** (containing `/-/`) are checked against the allowed
version cache. If the version is not in the cache, the tarball is blocked
with 403.

### PyPI Registry

PyPI splits across two hosts:

```
Metadata:  GET https://pypi.org/simple/numpy/     -> { name: 'numpy' }
Tarball:   GET https://files.pythonhosted.org/packages/.../numpy-1.26.0.tar.gz
                                                   -> { name: 'numpy', version: '1.26.0' }
           GET https://files.pythonhosted.org/packages/.../numpy-1.26.0-*.whl
                                                   -> { name: 'numpy', version: '1.26.0' }
```

**Metadata** on `pypi.org` (Simple Repository HTML) is intercepted and
filtered. The proxy removes `<a>` links for disallowed versions.

**Tarball downloads** on `files.pythonhosted.org` are checked against the
allowed version cache. The package name and version are extracted from the
filename (last path segment).

### PyPI Metadata for Version Timestamps

To determine version age, the proxy fetches the JSON API metadata:
`GET https://pypi.org/pypi/{name}/json`. This returns a document with
`releases` containing per-version upload timestamps. This fetch happens
once per package (cached), triggered when the Simple Repository HTML is
requested.

## Metadata Filtering Implementation

### npm Packument Filtering

```typescript
/**
 * Filters an npm packument to remove disallowed versions.
 *
 * @param packument - Raw JSON from GET /{package}
 * @param validator - Package validator instance
 * @param registry - Registry type ('npm')
 * @param packageName - Parsed package name
 * @param scope - Parsed scope (if scoped package)
 * @returns Filtered packument JSON and list of denied versions
 */
function filterNpmPackument(
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
    const publishedAt = packument.time?.[version]
      ? new Date(packument.time[version])
      : undefined;

    const decision = validator.validate(
      { registry: 'npm', name: packageName, scope, version },
      { publishedAt },
    );

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
      .filter(k => k !== 'created' && k !== 'modified')
      .sort((a, b) => new Date(filteredTime[b]).getTime() - new Date(filteredTime[a]).getTime())
      [0];
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
```

### PyPI Simple Index Filtering

```typescript
/**
 * Filters a PyPI Simple Repository HTML page to remove disallowed versions.
 *
 * The HTML contains <a> elements with hrefs pointing to tarballs/wheels.
 * Version is extracted from the filename in each href.
 *
 * @param html - Raw HTML from GET /simple/{package}/
 * @param validator - Package validator instance
 * @param packageName - Parsed package name
 * @param versionTimestamps - Map of version -> publish timestamp
 *   (from GET /pypi/{package}/json)
 * @returns Filtered HTML and list of denied versions
 */
function filterPypiIndex(
  html: string,
  validator: PackageValidator,
  packageName: string,
  versionTimestamps: Map<string, Date>,
): { filtered: string; denied: Array<{ version: string; reason: string }> } {
  // Parse <a> elements, extract version from filename, validate each,
  // remove denied links, return modified HTML.
  // ...
}
```

## Tarball Backstop Implementation

The tarball backstop is a simple check that runs on every tarball download
request. It ensures that even if an agent constructs a tarball URL directly
(bypassing metadata), the download is blocked if the version is not allowed.

```
Tarball request arrives (GET /express/-/express-4.18.2.tgz)
  |
  +-- Parse package name + version from URL
  |
  +-- Look up in AllowedVersionCache
  |     |
  |     +-- Cache HIT, version in allowed set -> FORWARD to upstream
  |     +-- Cache HIT, version NOT in allowed set -> 403 (was filtered)
  |     +-- Cache MISS -> fetch metadata, run validator
  |           |
  |           +-- Version allowed -> populate cache, FORWARD
  |           +-- Version denied -> populate cache, 403
  |           +-- Metadata fetch failed -> 403 (fail-closed)
  |
  +-- Log decision to package-audit.jsonl
```

The cache miss path is the defense-in-depth case: the agent somehow has a
tarball URL for a package whose metadata was never requested through the
proxy. This could happen if:
- The agent guesses a tarball URL based on package naming conventions
- The agent has cached package information from a previous session
- A bug in the metadata filtering allowed a version through metadata but
  the tarball check catches it

## Validation Logic

The `PackageValidator` evaluates rules in this order (first match wins):

```
1. Denylist match?     -> DENY  (takes precedence over everything)
2. Allowlist match?    -> ALLOW (bypasses age gate)
3. Version too new?    -> DENY  (published < quarantineDays ago)
4. No metadata?        -> DENY  (fail-closed)
5. Default             -> ALLOW
```

Allowlist and denylist support glob patterns via [minimatch](https://github.com/isaacs/minimatch)
or similar. Examples: `@types/*`, `eslint-*`, `react-*`.

## MITM Proxy Integration

### Changes to `createMitmProxy`

The `MitmProxyOptions` interface gains an optional `registries` field:

```typescript
interface MitmProxyOptions {
  // ... existing fields ...

  /**
   * Package registry configurations.
   * When present, the proxy allows CONNECT to registry hosts and
   * validates/filters package metadata and tarball downloads.
   */
  readonly registries?: readonly RegistryConfig[];

  /**
   * Package validation configuration.
   * Only meaningful when registries is non-empty.
   */
  readonly packageValidation?: {
    readonly validator: PackageValidator;
    readonly auditLogPath: string;
  };
}
```

### Host Allowlist Extension

The CONNECT handler's `providersByHost` map currently only contains LLM
provider hosts. Registry hosts are added to a parallel
`registriesByHost: Map<string, RegistryConfig>` map. The CONNECT handler
checks both maps:

```typescript
// In CONNECT handler:
const provider = providersByHost.get(host);
const registry = registriesByHost.get(host);

if (!provider && !registry) {
  // DENIED
  clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
  clientSocket.destroy();
  return;
}
```

Registry connections get TLS-terminated identically to provider connections
(same `getOrCreateSecureContext` path). The difference is in the inner
server's request handler, where registry requests are routed to the
metadata filtering / tarball backstop pipeline instead of the API key swap
pipeline.

The `socketMetadata` WeakMap is extended to include an optional `registry`
field so the inner server can distinguish registry requests from provider
requests:

```typescript
// Extended metadata:
interface ConnectionMeta {
  readonly provider?: ProviderKeyMapping;
  readonly registry?: RegistryConfig;
  readonly host: string;
  readonly port: number;
}
```

### Inner Server Request Dispatch

```typescript
innerServer.on('request', (clientReq, clientRes) => {
  const meta = socketMetadata.get(clientReq.socket as tls.TLSSocket);

  if (meta?.provider) {
    // Existing LLM API path: endpoint filter -> key swap -> forward
    handleProviderRequest(meta.provider, clientReq, clientRes);
  } else if (meta?.registry) {
    // New registry path: metadata filter or tarball backstop
    handleRegistryRequest(meta.registry, clientReq, clientRes);
  } else {
    clientRes.writeHead(500);
    clientRes.end('Internal error');
  }
});
```

### Registry Request Handler

```typescript
async function handleRegistryRequest(
  registry: RegistryConfig,
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
): Promise<void> {
  const path = clientReq.url ?? '/';

  if (registry.type === 'npm') {
    if (isNpmMetadataRequest(path)) {
      // Fetch from upstream, filter versions, return filtered response
      await handleNpmMetadata(registry, path, clientReq, clientRes);
    } else if (isNpmTarballRequest(path)) {
      // Check against allowed version cache, forward or 403
      await handleTarballDownload(registry, path, clientReq, clientRes);
    } else {
      // Unknown path -- pass through (e.g., /-/ping, /-/npm/v1/security)
      await forwardUpstream(registry, clientReq, clientRes);
    }
  } else if (registry.type === 'pypi') {
    if (isPypiSimpleRequest(path)) {
      // Fetch from upstream, filter links, return filtered response
      await handlePypiSimple(registry, path, clientReq, clientRes);
    } else {
      // All other pypi.org paths -- pass through
      await forwardUpstream(registry, clientReq, clientRes);
    }
  }
}
```

For `files.pythonhosted.org` (mirror host), all requests are tarball
downloads and go through `handleTarballDownload()`.

## Dockerfile Changes

### `Dockerfile.base` and `Dockerfile.base.arm64`

Add uv and ruff installation after the existing `apt-get` block:

```dockerfile
# Python tooling: uv (fast package manager) and ruff (linter)
# Install as root before switching to codespace user.
# Uses the official install scripts for platform-appropriate binaries.
RUN curl -LsSf https://astral.sh/uv/install.sh | sh && \
    curl -LsSf https://astral.sh/ruff/install.sh | sh && \
    mv /root/.local/bin/uv /usr/local/bin/uv && \
    mv /root/.local/bin/ruff /usr/local/bin/ruff && \
    rm -rf /root/.local
```

For `Dockerfile.base.arm64` (which already purges curl after Goose download),
curl must be retained or re-installed. The simplest approach is to install
uv/ruff before the curl purge step, or to use the static binary downloads
directly:

```dockerfile
# Direct binary download (no curl dependency at runtime)
RUN ARCH=$(dpkg --print-architecture) && \
    case "$ARCH" in \
      amd64) UV_ARCH=x86_64;; \
      arm64) UV_ARCH=aarch64;; \
    esac && \
    curl -fsSL "https://github.com/astral-sh/uv/releases/latest/download/uv-${UV_ARCH}-unknown-linux-gnu.tar.gz" | \
      tar -xz -C /usr/local/bin/ --strip-components=1 && \
    curl -fsSL "https://github.com/astral-sh/ruff/releases/latest/download/ruff-${UV_ARCH}-unknown-linux-gnu.tar.gz" | \
      tar -xz -C /usr/local/bin/
```

Note: `Dockerfile.base` uses the `devcontainers/universal` image which
already has Python and curl. `Dockerfile.base.arm64` uses `node:22-bookworm`
which needs `curl` (already installed for git/socat). The uv/ruff install
should happen while curl is still available, before the apt purge in
agent-specific Dockerfiles.

## Session Lifecycle Integration

### `prepareDockerInfrastructure()` Changes

The infrastructure setup function gains registry configuration:

1. Read `packageInstall` config from `ResolvedUserConfig`.
2. If enabled, construct `RegistryConfig[]` for npm and PyPI.
3. Construct a `PackageValidator` from the allowlist/denylist/quarantine config.
4. Pass registries and validator to `createMitmProxy()`.
5. Write the package audit log path into the session directory.

### Container Environment

No container-side changes are needed beyond what already exists. The
`HTTPS_PROXY` environment variable is already set, and package managers
honor it. The IronCurtain CA certificate is already trusted (installed in
the base image via `update-ca-certificates`).

npm, pip, and uv all support HTTPS proxies via the `HTTPS_PROXY`
environment variable and will route registry traffic through the MITM
proxy automatically.

## New Files

| File | Purpose |
|------|---------|
| `src/docker/registry-proxy.ts` | `RegistryConfig`, URL parsers, `handleRegistryRequest()`, metadata filtering |
| `src/docker/package-validator.ts` | `PackageValidator` implementation, age gate/allowlist/denylist logic |
| `src/docker/package-types.ts` | `PackageIdentity`, `PackageDecision`, `VersionMetadata`, `PackageAuditEntry` |
| `test/docker/registry-proxy.test.ts` | URL parsing, metadata filtering, tarball backstop |
| `test/docker/package-validator.test.ts` | Validation logic: allowlist, denylist, age gate |

## Modified Files

| File | Change |
|------|--------|
| `src/docker/mitm-proxy.ts` | Add `registries` to options, extend CONNECT handler and inner server dispatch |
| `src/docker/docker-infrastructure.ts` | Build registry configs and validator, pass to MITM proxy |
| `src/config/user-config.ts` | Add `packageInstall` config schema and defaults |
| `docker/Dockerfile.base` | Install uv and ruff |
| `docker/Dockerfile.base.arm64` | Install uv and ruff |

## Extension Points

### Future: Full Aikido-style Threat Intelligence

The `PackageValidator` interface is deliberately narrow. A future implementation
could:

1. Call an external threat intelligence API (e.g., Socket.dev, Snyk, OSV)
   during the `validate()` step, with results cached.
2. Check for known CVEs in the specific version being downloaded.
3. Perform typosquatting detection by computing edit distance against a
   corpus of top-1000 packages.
4. Detect dependency confusion by checking if the package name matches
   any known private registry package.

These would be additional `PackageValidator` implementations composed via
a chain-of-responsibility pattern:

```typescript
function createCompositeValidator(
  validators: readonly PackageValidator[]
): PackageValidator {
  return {
    validate(pkg, metadata) {
      for (const v of validators) {
        const decision = v.validate(pkg, metadata);
        if (decision.status !== 'allow') return decision;
      }
      return { status: 'allow', reason: 'All validators passed' };
    },
  };
}
```

### Future: Escalation Support

The current binary allow/deny model could be extended to support escalation
for borderline cases (e.g., recently published versions of established
packages). This would require solving the HTTP timeout problem -- either
by increasing package manager timeouts in the container environment, or by
using a pre-flight validation model where packages are approved before
installation begins.

### Future: Private Registry Support

The `RegistryConfig` type can be extended with authentication fields
(similar to `ProviderConfig.keyInjection`) for private npm registries
or Artifactory/Nexus instances. This would follow the same credential
isolation pattern: the container gets a fake token, the MITM proxy
swaps it for the real one.

### Future: Dependency Lock File Validation

Instead of checking individual package downloads, a more holistic approach
would validate the entire dependency tree against a lock file
(`package-lock.json`, `uv.lock`) that was approved before the session
started. This is orthogonal to the per-download validation designed here
and could be layered on top.

## Testing Strategy

### Unit Tests

The design's modular structure enables clean unit testing:

- **URL parsers** (`registry-proxy.ts`): Pure functions, tested with tables
  of npm/PyPI URL patterns mapped to expected `PackageIdentity` values.
- **Metadata filters** (`registry-proxy.ts`): Given a raw packument/HTML
  and a validator config, verify correct version removal and dist-tags update.
- **PackageValidator** (`package-validator.ts`): Stateless validation logic
  tested with various `PackageIdentity` + `VersionMetadata` combinations
  against different allowlist/denylist/quarantine configs.
- **Tarball backstop**: Given a URL and an allowed version cache, verify
  correct allow/deny decisions.

### Integration Tests

- Spawn a real MITM proxy with registry configs enabled.
- Use a mock registry server (plain HTTP) as the "upstream."
- Verify: (a) allowed versions appear in filtered metadata, (b) denied
  versions are removed from metadata, (c) tarball downloads for denied
  versions return 403, (d) tarball downloads for allowed versions succeed.

### Manual Testing

- Build a container with uv/ruff pre-installed.
- Run `npm install express` inside a Docker agent session.
- Verify the package audit log contains the expected entries.
- Run `uv add numpy` (a package old enough to pass the age gate).
- Verify that very recently published package versions are filtered out.

## Security Considerations

### No Credential Injection for Registries

Unlike LLM providers, public package registries do not require
authentication. The MITM proxy does not inject any credentials into
registry requests. This eliminates an entire class of credential
leakage risks.

### Fail-Closed Behavior

If the upstream metadata fetch fails (network error, invalid JSON,
timeout), the metadata handler returns a 502 error to the package
manager rather than serving unfiltered metadata. For tarball backstop
cache misses where metadata cannot be fetched, the download is denied
with a 403. This ensures that registry outages or parsing errors do
not silently allow potentially dangerous packages.

### Two-Layer Defense

The metadata filter + tarball backstop provides defense in depth:
1. **Primary**: Metadata filtering ensures package managers never
   resolve to disallowed versions.
2. **Backstop**: Tarball blocking catches direct URL construction,
   cache inconsistencies, or metadata filtering bugs.

### No Arbitrary Host Access

Adding registry hosts to the MITM proxy's allowlist does NOT give the
container general internet access. The container can only reach hosts
explicitly listed in the `providersByHost` or `registriesByHost` maps.
Each registry host's traffic is further filtered by the registry request
handler -- package metadata and tarball download paths are validated
and filtered; other registry paths (e.g., `/-/ping`) are forwarded
upstream without filtering.

### Post-Install Script Mitigation

Package install scripts (`preinstall`, `postinstall` for npm; `setup.py`
for pip) can execute arbitrary code. While the container's network
isolation limits their damage, the container environment should be
configured to skip install scripts by default where possible:
- npm: Set `NPM_CONFIG_IGNORE_SCRIPTS=true` in container environment
- pip: Use `--no-build-isolation` cautiously; prefer wheels over sdists

This is a container configuration concern, not a proxy concern, but is
noted here for completeness.

## Migration Plan

### Phase 1: Types and Validator (no runtime changes)
- Add `package-types.ts` with all type definitions.
- Implement `PackageValidator` with allowlist/denylist/age gate.
- Add URL parsers for npm and PyPI.
- Add metadata filtering functions (npm packument, PyPI simple index).
- Full test coverage for validator, parsers, and filters.

### Phase 2: MITM Proxy Extension
- Extend `MitmProxyOptions` with registry fields.
- Add `registriesByHost` map and CONNECT handler extension.
- Add inner server request dispatch for registry connections.
- Implement `handleRegistryRequest()` with metadata filtering and tarball
  backstop.
- Add `AllowedVersionCache` with 1-hour TTL.
- Integration tests with mock upstream.

### Phase 3: Session Integration
- Add `packageInstall` to user config schema.
- Wire registry configs into `prepareDockerInfrastructure()`.
- Add package audit log writing.

### Phase 4: Dockerfile and E2E
- Add uv/ruff to base Dockerfiles.
- End-to-end test: Docker session with package install.
- Documentation update.
