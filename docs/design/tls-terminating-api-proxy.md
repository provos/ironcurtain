# TLS-Terminating API Proxy Design

## 1. Overview

The current Docker agent architecture passes real API keys into the untrusted container environment and uses a passthrough CONNECT proxy that tunnels raw TCP bytes without inspecting them. This design replaces that proxy with a **TLS-terminating MITM proxy** that:

1. **Keeps secrets out of the container** — the container receives a format-matching fake API key; the real key never leaves the host process
2. **Filters API requests** — only allows specific LLM completion endpoints, blocking attempts to use the connection for web fetches or other unintended purposes
3. **Swaps credentials transparently** — replaces the fake key with the real one in the appropriate header before forwarding upstream
4. **Streams responses without buffering** — SSE completion streams pipe through with zero parsing overhead

### Motivation

The passthrough CONNECT proxy in `connect-proxy.ts` restricts *which hosts* the agent can reach, but once a tunnel is established, all traffic is opaque encrypted bytes. This means:

- The real API key must be given to the container (it's in the TLS-encrypted payload)
- A compromised agent could use the API connection for anything the provider's API supports, not just completions
- There is no audit trail of what HTTP requests are actually being made

TLS termination solves all three problems by making the HTTP layer visible to the proxy.

## 2. Architecture

```
Docker Container (--network=none)
+--------------------------------------------------+
|                                                  |
|  Agent (Claude Code)                             |
|    ANTHROPIC_API_KEY=sk-ant-api03-FAKE-xxxxx     |
|    HTTPS_PROXY=http://127.0.0.1:18080            |
|    NODE_EXTRA_CA_CERTS=<path to baked-in cert>   |
|         |                                        |
|    CONNECT api.anthropic.com:443                 |
|         |                                        |
|    socat TCP:18080 <-> UDS:mitm-proxy.sock       |
+--------------------------------------------------+
          |
    Unix Domain Socket
          |
+--------------------------------------------------+
|  Host: MITM Proxy                                |
|                                                  |
|  1. Receive CONNECT, check host allowlist        |
|  2. Reply 200, wrap client socket in TLS         |
|     (present cert signed by IronCurtain CA)      |
|  3. Read plaintext HTTP request                  |
|  4. Validate: POST /v1/messages? ✓               |
|  5. Validate: x-api-key matches fake sentinel? ✓ |
|  6. Swap: x-api-key: FAKE → REAL                 |
|  7. Forward via https.request() to real API      |
|  8. Pipe response stream back (SSE passthrough)  |
+--------------------------------------------------+
          |
    Real TLS to api.anthropic.com:443
          |
+--------------------------------------------------+
|  Anthropic API                                   |
|  Sees: x-api-key: sk-ant-api03-REAL-xxxxx        |
+--------------------------------------------------+
```

### What Changes from the Current Design

| Aspect | Before (connect-proxy) | After (mitm-proxy) |
|--------|----------------------|-------------------|
| TLS termination | None (raw tunnel) | Yes (decrypt, inspect, re-encrypt) |
| API key in container | Real key | Fake sentinel key |
| Request visibility | Opaque bytes | Full HTTP method/path/headers/body |
| Endpoint filtering | Host-only allowlist | Host + method + path allowlist |
| Certificate trust | System CAs only | IronCurtain CA added to system store + `NODE_EXTRA_CA_CERTS` |
| Dependencies | None | `node-forge` (cert generation) |

## 3. CA Certificate Management

### Persistent CA (Generated Once)

A self-signed CA key/cert pair is generated on first run and stored persistently. This CA signs per-host leaf certificates at runtime.

**Storage:** `~/.ironcurtain/ca/`
```
~/.ironcurtain/ca/
  ca-cert.pem          # CA certificate (baked into Docker image)
  ca-key.pem           # CA private key (host-only, never enters container)
```

**Generation** (first run only):
```typescript
// src/docker/ca.ts
import forge from 'node-forge';

export interface CertificateAuthority {
  readonly certPem: string;
  readonly keyPem: string;
  readonly certPath: string;
  readonly keyPath: string;
}

/**
 * Loads or generates the IronCurtain CA.
 *
 * On first invocation, generates a 2048-bit RSA CA with:
 * - CN = "IronCurtain MITM CA"
 * - 10-year validity
 * - Basic Constraints: CA=true
 * - Key Usage: keyCertSign, cRLSign
 *
 * Stores cert + key in ~/.ironcurtain/ca/ with 0600 permissions on key.
 * On load, verifies ca-key.pem has 0600 permissions and warns if not.
 * Subsequent calls load from disk.
 */
export function loadOrCreateCA(caDir: string): CertificateAuthority;
```

**Why 2048-bit RSA:** We use `node-forge` (pure JS) for cert generation. 2048-bit keys generate in ~200-500ms, which is acceptable for a one-time operation. Per-host leaf certs also use 2048-bit but are pre-warmed at startup (see Section 5).

### Docker Image Integration

The CA certificate (not the key) is baked into the Docker base image so the container's system TLS stack trusts it:

```dockerfile
# docker/Dockerfile.base (extended)
FROM mcr.microsoft.com/devcontainers/universal:latest

USER root
RUN apt-get update && apt-get install -y --no-install-recommends socat \
    && rm -rf /var/lib/apt/lists/*

# IronCurtain CA (for MITM proxy trust)
# This file is copied into a temporary build context by ensureImage().
COPY ironcurtain-ca-cert.pem /usr/local/share/ca-certificates/ironcurtain-ca.crt
RUN update-ca-certificates

RUN mkdir -p /workspace /etc/ironcurtain /run/ironcurtain \
    && chown codespace:codespace /workspace /etc/ironcurtain /run/ironcurtain

WORKDIR /workspace
USER codespace
```

**Build context:** The `ensureImage()` method creates a **temporary directory** as the Docker build context, copying the Dockerfile, entrypoint scripts, and the CA cert into it. This avoids writing the cert into the source tree (which would dirty the git working directory). The temp directory is cleaned up after the build.

```typescript
// In DockerAgentSession.ensureImage() — pseudocode
const tmpContext = mkdtempSync(join(tmpdir(), 'ironcurtain-build-'));
copyFileSync(resolve(dockerDir, 'Dockerfile.base'), join(tmpContext, 'Dockerfile.base'));
copyFileSync(ca.certPath, join(tmpContext, 'ironcurtain-ca-cert.pem'));
// ... copy other files ...
await this.docker.buildImage(baseImage, join(tmpContext, 'Dockerfile.base'), tmpContext);
rmSync(tmpContext, { recursive: true });
```

**Staleness detection:** The base image is built with a label containing the CA cert's SHA-256 hash: `LABEL ironcurtain.ca-hash=<hex>`. On subsequent `ensureImage()` calls, the label is read via `docker inspect` and compared against the current cert. If they differ (user deleted `~/.ironcurtain/ca/` and a new CA was generated), the image is rebuilt. If the `docker inspect` check fails for any reason, a rebuild is triggered as a safe default.

### Node.js CA Trust

**Important:** Node.js does **not** use the system certificate store by default. It bundles its own Mozilla CA certificates and ignores `/etc/ssl/certs/`. The `update-ca-certificates` call in the Dockerfile handles curl, wget, Python, Go, and other tools that use the system OpenSSL store, but Node.js-based agents (like Claude Code) also need `NODE_EXTRA_CA_CERTS` pointing at the baked-in cert.

The adapter's `buildEnv()` sets this automatically:

```typescript
// All adapters running Node.js-based agents must include:
NODE_EXTRA_CA_CERTS: '/usr/local/share/ca-certificates/ironcurtain-ca.crt',
```

This is a belt-and-suspenders approach:
- **System CA store** (`update-ca-certificates`): curl, wget, Python requests, Go, etc.
- **`NODE_EXTRA_CA_CERTS`**: Node.js (Claude Code, npm, etc.)

## 4. Provider Configuration

### Provider Registry

Each LLM API provider has a configuration that tells the proxy how to handle its traffic:

```typescript
// src/docker/provider-config.ts

/**
 * Configuration for an LLM API provider, describing how the MITM proxy
 * should handle traffic to this provider's API.
 */
export interface ProviderConfig {
  /** Hostname of the API endpoint (e.g., 'api.anthropic.com'). */
  readonly host: string;

  /** Human-readable provider name for logging. */
  readonly displayName: string;

  /**
   * Allowed HTTP endpoints. Requests not matching any pattern get 403.
   * Patterns use exact method match and path matching (see EndpointPattern).
   */
  readonly allowedEndpoints: readonly EndpointPattern[];

  /**
   * How the API key is transmitted in requests.
   * Determines where the proxy looks for the fake key and injects the real one.
   */
  readonly keyInjection: KeyInjection;

  /**
   * Prefix for generating fake sentinel keys that pass client-side validation.
   * Example: 'sk-ant-api03-' for Anthropic.
   */
  readonly fakeKeyPrefix: string;
}

export interface EndpointPattern {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /**
   * Path pattern. Supports two forms:
   * - Exact match: '/v1/messages' (compared after stripping query string)
   * - Glob with '*' segments: '/v1beta/models/ * /generateContent'
   *   (each '*' matches exactly one path segment [^/]+)
   *
   * Non-glob characters are regex-escaped before matching to prevent
   * metacharacters in paths (e.g., '.') from being interpreted as regex.
   */
  readonly path: string;
}

/**
 * How the API key is transmitted in requests.
 *
 * Note: Query-parameter injection (e.g., Google's ?key=) is not yet
 * implemented. It can be added later by extending this type and
 * adding URL rewriting to the request handler. For now, Google uses
 * x-goog-api-key header injection.
 */
export type KeyInjection =
  | { readonly type: 'header'; readonly headerName: string }
  | { readonly type: 'bearer' };
```

### Built-in Providers

```typescript
// src/docker/providers/

export const anthropicProvider: ProviderConfig = {
  host: 'api.anthropic.com',
  displayName: 'Anthropic',
  allowedEndpoints: [
    { method: 'POST', path: '/v1/messages' },
  ],
  keyInjection: { type: 'header', headerName: 'x-api-key' },
  fakeKeyPrefix: 'sk-ant-api03-ironcurtain-',
};

export const openaiProvider: ProviderConfig = {
  host: 'api.openai.com',
  displayName: 'OpenAI',
  allowedEndpoints: [
    { method: 'POST', path: '/v1/chat/completions' },
    { method: 'GET', path: '/v1/models' },
  ],
  keyInjection: { type: 'bearer' },
  fakeKeyPrefix: 'sk-ironcurtain-',
};

export const googleProvider: ProviderConfig = {
  host: 'generativelanguage.googleapis.com',
  displayName: 'Google',
  allowedEndpoints: [
    { method: 'POST', path: '/v1beta/models/*/generateContent' },
    { method: 'POST', path: '/v1beta/models/*/streamGenerateContent' },
  ],
  keyInjection: { type: 'header', headerName: 'x-goog-api-key' },
  fakeKeyPrefix: 'AIzaSy-ironcurtain-',
};
```

### Agent Adapter Changes

The `AgentAdapter` interface is extended with a method that returns the providers the agent needs. **This is a breaking change** to the interface — all adapters must be updated simultaneously. With only one adapter currently (Claude Code), this is a single-commit change.

```typescript
// In agent-adapter.ts
export interface AgentAdapter {
  // ... existing methods ...

  /**
   * Returns LLM provider configurations for this agent.
   * Replaces getAllowedApiHosts() with richer provider-level config.
   *
   * The MITM proxy uses these to:
   * 1. Build the host allowlist
   * 2. Generate fake API keys per provider
   * 3. Know how to swap keys in requests
   * 4. Filter allowed endpoints
   */
  getProviders(): readonly ProviderConfig[];

  /**
   * Constructs environment variables for the container.
   * Receives fake keys instead of real keys — the real keys never
   * enter the container.
   *
   * @param fakeKeys - map of provider host → fake sentinel key
   */
  buildEnv(config: IronCurtainConfig, fakeKeys: ReadonlyMap<string, string>): Readonly<Record<string, string>>;
}
```

**Claude Code adapter updated:**

```typescript
// In adapters/claude-code.ts
getProviders(): readonly ProviderConfig[] {
  return [anthropicProvider];
},

buildEnv(config: IronCurtainConfig, fakeKeys: ReadonlyMap<string, string>): Record<string, string> {
  return {
    ANTHROPIC_API_KEY: fakeKeys.get('api.anthropic.com') ?? '',
    CLAUDE_CODE_DISABLE_UPDATE_CHECK: '1',
    // Node.js does not use the system CA store — must set this explicitly
    NODE_EXTRA_CA_CERTS: '/usr/local/share/ca-certificates/ironcurtain-ca.crt',
  };
},
```

Note: `getAllowedApiHosts()` is removed — the host allowlist is derived from `getProviders().map(p => p.host)`.

## 5. MITM Proxy Implementation

### Core Module: `src/docker/mitm-proxy.ts`

The MITM proxy replaces `connect-proxy.ts`. It uses the same UDS-based listening pattern and interface shape, but instead of tunneling raw bytes, it terminates TLS and inspects HTTP traffic.

```typescript
// src/docker/mitm-proxy.ts

export interface MitmProxy {
  /** Start listening on the UDS. Pre-warms cert cache for all providers. */
  start(): Promise<{ socketPath: string }>;
  /** Stop the proxy and close all connections. */
  stop(): Promise<void>;
}

export interface MitmProxyOptions {
  /** Absolute path for the Unix domain socket. */
  readonly socketPath: string;
  /** CA certificate and key for signing per-host certs. */
  readonly ca: CertificateAuthority;
  /**
   * Provider configurations with real API keys.
   * The proxy uses these for host allowlisting, key swapping, and endpoint filtering.
   */
  readonly providers: readonly ProviderKeyMapping[];
}

export interface ProviderKeyMapping {
  readonly config: ProviderConfig;
  /** The fake sentinel key given to the container. */
  readonly fakeKey: string;
  /** The real API key to inject in upstream requests. */
  readonly realKey: string;
}

export function createMitmProxy(options: MitmProxyOptions): MitmProxy;
```

### Internal Architecture

The proxy is built from Node.js builtins (`http`, `tls`, `https`, `net`) plus `node-forge` for certificate generation:

```
┌─────────────────────────────────────────────────────┐
│  outerServer: http.createServer (UDS listener)      │
│    on('connect') → CONNECT handler                  │
│                                                     │
│  CONNECT handler:                                   │
│    1. Check host against provider allowlist          │
│    2. Reply "200 Connection Established"             │
│    3. Unshift head buffer back into socket           │
│    4. Wrap clientSocket in tls.TLSSocket             │
│       (SNICallback → cached SecureContext per host)  │
│    5. Store socket metadata, track in activeConns    │
│    6. Emit TLS socket into shared innerServer        │
│                                                     │
│  innerServer: http.createServer (not listening)      │
│    Shared across ALL decrypted connections.          │
│    Receives connections via emit('connection', tls). │
│    Looks up provider from socketMetadata WeakMap.    │
│                                                     │
│  Request handler (on innerServer):                  │
│    1. Validate method + path against provider        │
│    2. Validate fake key matches expected sentinel    │
│    3. Swap fake key → real key in headers            │
│    4. https.request() to real upstream               │
│    5. Stream response back with flushHeaders()       │
│    6. On client close → abort upstream request       │
│    7. On upstream error after headers → destroy      │
└─────────────────────────────────────────────────────┘
```

### Connection Tracking and Cleanup

The proxy tracks all active resources for clean shutdown and disconnect handling:

```typescript
// Active resource tracking
const activeTlsSockets = new Set<tls.TLSSocket>();
const activeUpstreamRequests = new Set<http.ClientRequest>();
const socketMetadata = new WeakMap<tls.TLSSocket, {
  provider: ProviderKeyMapping;
  host: string;
  port: number;
}>();
```

**On `stop()`:**
```typescript
async stop() {
  // 1. Abort all in-flight upstream requests
  for (const req of activeUpstreamRequests) {
    req.destroy();
  }
  activeUpstreamRequests.clear();

  // 2. Destroy all active TLS sockets
  for (const sock of activeTlsSockets) {
    sock.destroy();
  }
  activeTlsSockets.clear();

  // 3. Close the inner HTTP server (no-op since it isn't listening)
  innerServer.close();

  // 4. Close the outer UDS server
  await new Promise<void>(resolve => outerServer.close(() => resolve()));

  // 5. Clean up socket file
  try { unlinkSync(options.socketPath); } catch { /* ignore */ }
}
```

### CONNECT Handler

```typescript
outerServer.on('connect', (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
  const { host, port } = parseConnectTarget(req.url);
  const connId = ++connectionCounter;

  // 1. Check allowlist
  const provider = providersByHost.get(host);
  if (!provider) {
    logger.info(`[mitm-proxy] #${connId} DENIED CONNECT ${host}:${port}`);
    clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    clientSocket.destroy();
    return;
  }

  logger.info(`[mitm-proxy] #${connId} CONNECT ${host}:${port} → MITM`);

  // 2. Acknowledge the CONNECT
  clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

  // 3. Push back any bytes that arrived after the CONNECT request line.
  //    Without this, TLS ClientHello bytes in `head` would be lost because
  //    they were already read from the underlying socket before our handler
  //    was called. unshift() makes them available to the TLSSocket wrapper.
  if (head.length > 0) {
    clientSocket.unshift(head);
  }

  // 4. Upgrade to TLS (MITM)
  const tlsSocket = new tls.TLSSocket(clientSocket, {
    isServer: true,
    SNICallback: (servername, cb) => {
      const ctx = getOrCreateSecureContext(servername);
      cb(null, ctx);
    },
  });

  // 5. TLS handshake timeout — if the client stalls the handshake, clean up
  //    after 10 seconds to prevent resource leaks.
  const handshakeTimeout = setTimeout(() => {
    if (!tlsSocket.encrypted) {
      logger.info(`[mitm-proxy] #${connId} TLS handshake timeout`);
      tlsSocket.destroy();
    }
  }, 10_000);
  tlsSocket.once('secure', () => clearTimeout(handshakeTimeout));

  // 6. Track the connection
  activeTlsSockets.add(tlsSocket);
  socketMetadata.set(tlsSocket, { provider, host, port });

  tlsSocket.on('error', (err) => {
    logger.info(`[mitm-proxy] #${connId} TLS error: ${err.message}`);
    tlsSocket.destroy();
  });
  tlsSocket.on('close', () => {
    activeTlsSockets.delete(tlsSocket);
  });

  // 7. Emit into shared inner HTTP server for request handling.
  //    The inner server handles HTTP keep-alive (multiple requests per
  //    connection) automatically via Node.js's HTTP parser.
  innerServer.emit('connection', tlsSocket);
});
```

### Shared Inner HTTP Server

A single `http.createServer` instance handles all decrypted HTTP requests. It is never bound to a port — connections are fed to it via `emit('connection', tlsSocket)`. This avoids per-connection server leaks and ensures clean shutdown via a single `innerServer.close()`.

```typescript
// Created once during proxy initialization — shared across all connections
const innerServer = http.createServer((clientReq, clientRes) => {
  const tlsSock = clientReq.socket as tls.TLSSocket;
  const meta = socketMetadata.get(tlsSock);
  if (!meta) {
    clientRes.writeHead(500);
    clientRes.end('Internal error: unknown connection');
    return;
  }

  const { provider, host: targetHost, port: targetPort } = meta;
  const { method, url: path, headers } = clientReq;

  // 1. Endpoint filtering
  if (!isEndpointAllowed(provider.config, method, path)) {
    logger.info(`[mitm-proxy] BLOCKED ${method} ${targetHost}${path}`);
    clientRes.writeHead(403, { 'Content-Type': 'text/plain' });
    clientRes.end(`Blocked: ${method} ${path} is not an allowed endpoint.`);
    return;
  }

  // 2. Fake key validation + swap
  const modifiedHeaders = { ...headers };
  if (!validateAndSwapApiKey(modifiedHeaders, provider)) {
    logger.info(`[mitm-proxy] REJECTED ${method} ${targetHost}${path} — invalid API key`);
    clientRes.writeHead(403, { 'Content-Type': 'text/plain' });
    clientRes.end('Rejected: API key does not match expected sentinel.');
    return;
  }
  modifiedHeaders.host = targetHost;

  // 3. Forward to real API
  const upstreamReq = https.request({
    hostname: targetHost,
    port: targetPort,
    method,
    path,
    headers: modifiedHeaders,
  }, (upstreamRes) => {
    // 4. Stream response back (SSE passthrough)
    clientRes.writeHead(upstreamRes.statusCode!, upstreamRes.headers);
    // Flush headers immediately so the client knows the response has started.
    clientRes.flushHeaders();
    // Disable Nagle's algorithm to minimize SSE chunk latency.
    clientRes.socket?.setNoDelay(true);
    upstreamRes.pipe(clientRes);
  });

  // Track upstream request for cleanup on stop()
  activeUpstreamRequests.add(upstreamReq);
  upstreamReq.on('close', () => activeUpstreamRequests.delete(upstreamReq));

  // Handle upstream errors
  upstreamReq.on('error', (err) => {
    logger.info(`[mitm-proxy] upstream error: ${err.message}`);
    activeUpstreamRequests.delete(upstreamReq);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
      clientRes.end(`Upstream error: ${err.message}`);
    } else {
      // Headers already sent — can't send a clean error. Destroy the socket
      // so the client sees a broken stream rather than silently truncated data.
      clientRes.socket?.destroy();
    }
  });

  // If the client disconnects mid-request, abort the upstream request
  // to avoid wasting resources on a response nobody will read.
  clientRes.on('close', () => {
    if (!upstreamReq.destroyed) {
      upstreamReq.destroy();
    }
  });

  // Pipe request body to upstream (for POST requests with JSON body)
  clientReq.pipe(upstreamReq);

  logger.info(`[mitm-proxy] ${method} ${targetHost}${path} → FORWARDED`);
});
```

### Per-Host Certificate Generation

Leaf certificates are generated on-demand and cached for the session lifetime. The cert cache is **pre-warmed** during `start()` for all configured provider hosts to avoid ~200-500ms latency on the first real request.

```typescript
// Certificate cache: hostname → tls.SecureContext
const certCache = new Map<string, tls.SecureContext>();

/**
 * Returns a cached SecureContext for the hostname, generating one if needed.
 *
 * CONCURRENCY NOTE: This function is synchronous because node-forge's
 * RSA key generation is synchronous (pure JS). This means concurrent
 * SNICallback invocations for the same uncached hostname block the event
 * loop sequentially — the first call generates and caches, the second
 * finds the cache populated. If key generation is ever made async,
 * a Map<string, Promise<SecureContext>> deduplication pattern should
 * be used to prevent redundant generation.
 */
function getOrCreateSecureContext(hostname: string): tls.SecureContext {
  const cached = certCache.get(hostname);
  if (cached) return cached;

  // Generate leaf cert signed by IronCurtain CA
  const leafKeys = forge.pki.rsa.generateKeyPair(2048);
  const leafCert = forge.pki.createCertificate();

  leafCert.publicKey = leafKeys.publicKey;
  leafCert.serialNumber = randomSerialNumber();
  leafCert.validity.notBefore = new Date();
  leafCert.validity.notAfter = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

  leafCert.setSubject([{ name: 'commonName', value: hostname }]);
  leafCert.setIssuer(caCert.subject.attributes);
  leafCert.setExtensions([
    { name: 'subjectAltName', altNames: [{ type: 2, value: hostname }] },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
  ]);

  leafCert.sign(caKey, forge.md.sha256.create());

  const ctx = tls.createSecureContext({
    key: forge.pki.privateKeyToPem(leafKeys.privateKey),
    cert: forge.pki.certificateToPem(leafCert),
  });

  certCache.set(hostname, ctx);
  return ctx;
}
```

**Pre-warming in `start()`:**

```typescript
async start() {
  // Clean up stale socket file from a previous run
  if (existsSync(options.socketPath)) {
    unlinkSync(options.socketPath);
  }

  // Pre-warm cert cache for all configured providers.
  // This moves the ~200-500ms per-host RSA generation out of the
  // request hot path and into session initialization.
  for (const mapping of options.providers) {
    getOrCreateSecureContext(mapping.config.host);
  }

  return new Promise((resolve, reject) => {
    outerServer.listen(options.socketPath, () => {
      resolve({ socketPath: options.socketPath });
    });
    outerServer.once('error', reject);
  });
}
```

### API Key Validation and Swapping

The proxy validates that the incoming API key matches the expected fake sentinel before swapping. This prevents:
- A compromised agent from sending requests without credentials and having them auto-authenticated
- A compromised agent from using a different stolen key and having it laundered through the proxy

```typescript
/**
 * Validates that the request carries the expected fake key, then replaces
 * it with the real key. Returns false if the fake key does not match.
 */
function validateAndSwapApiKey(
  headers: Record<string, string | string[] | undefined>,
  provider: ProviderKeyMapping,
): boolean {
  const { keyInjection } = provider.config;

  switch (keyInjection.type) {
    case 'header': {
      // Anthropic: x-api-key, Google: x-goog-api-key
      // Node.js lowercases all header names
      const headerName = keyInjection.headerName.toLowerCase();
      const currentValue = headers[headerName];
      if (currentValue !== provider.fakeKey) return false;
      headers[headerName] = provider.realKey;
      return true;
    }
    case 'bearer': {
      // OpenAI: Authorization: Bearer <key>
      const authHeader = headers['authorization'];
      if (authHeader !== `Bearer ${provider.fakeKey}`) return false;
      headers['authorization'] = `Bearer ${provider.realKey}`;
      return true;
    }
  }
}
```

### Endpoint Filtering

```typescript
/**
 * Checks whether a request method+path is in the provider's allowlist.
 *
 * Path matching:
 * - Exact: '/v1/messages' matches only '/v1/messages' (query string stripped)
 * - Glob: '/v1beta/models/ * /generateContent' — each '*' matches one path
 *   segment. Non-glob characters are regex-escaped to prevent metacharacters
 *   like '.' from being interpreted as regex wildcards.
 */
function isEndpointAllowed(
  config: ProviderConfig,
  method: string | undefined,
  path: string | undefined,
): boolean {
  if (!method || !path) return false;
  const cleanPath = path.split('?')[0]; // strip query string

  return config.allowedEndpoints.some((ep) => {
    if (ep.method !== method.toUpperCase()) return false;
    if (ep.path.includes('*')) {
      // Escape regex metacharacters in non-glob segments, then replace
      // '*' with [^/]+ to match exactly one path segment.
      const escaped = ep.path
        .split('*')
        .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]+');
      const regex = new RegExp('^' + escaped + '$');
      return regex.test(cleanPath);
    }
    return cleanPath === ep.path;
  });
}
```

### Logging

Every request is logged with decision and timing:

```
[mitm-proxy] #1 CONNECT api.anthropic.com:443 → MITM
[mitm-proxy] POST api.anthropic.com/v1/messages → FORWARDED
[mitm-proxy] #2 DENIED CONNECT evil.com:443
[mitm-proxy] BLOCKED GET api.anthropic.com/v1/other → endpoint not allowed
[mitm-proxy] REJECTED POST api.anthropic.com/v1/messages → invalid API key
[mitm-proxy] #3 TLS handshake timeout
```

## 6. Fake API Key Generation

### Sentinel Key Format

Each provider gets a unique fake key that matches the provider's key format to pass client-side validation:

```typescript
// src/docker/fake-keys.ts
import { randomBytes } from 'node:crypto';

/**
 * Generate a fake API key that matches the provider's format.
 *
 * The key is structurally valid (passes prefix/format checks) but
 * is not a real key — the provider will reject it with 401.
 * The MITM proxy swaps it before it reaches the provider.
 */
export function generateFakeKey(prefix: string): string {
  const suffix = randomBytes(24).toString('base64url');
  return `${prefix}${suffix}`;
}
```

**Examples:**
- Anthropic: `sk-ant-api03-ironcurtain-abc123def456...`
- OpenAI: `sk-ironcurtain-abc123def456...`
- Google: `AIzaSy-ironcurtain-abc123def456...`

The fake key is generated once per session during initialization and passed to the container via `buildEnv()`. The MITM proxy holds the mapping from fake → real. The fake key is a sentinel — it is not secret, and its appearance in container logs is expected and harmless.

### Key Lifecycle

```
Session initialization:
  1. For each provider in adapter.getProviders():
     a. fakeKey = generateFakeKey(provider.fakeKeyPrefix)
     b. realKey = config.userConfig.{providerApiKey}
     c. Store mapping in MitmProxyOptions.providers
  2. Pass fakeKeys map to adapter.buildEnv()
  3. Container receives only fake keys in env vars
  4. MITM proxy holds fake→real mapping in memory
  5. MITM proxy validates incoming keys match expected fakes before swapping

Session teardown:
  - Fake keys are discarded (never persisted to disk)
  - Real keys remain in host config only
```

## 7. Session Integration

### Updated `DockerAgentSession.initialize()` Flow

```
1. loadOrCreateCA(~/.ironcurtain/ca/)
2. Generate fake keys for each provider
3. Start MCP proxy (UDS) — unchanged
4. Start MITM proxy (UDS) with:
   - CA cert/key
   - Provider configs with fake→real key mappings
   - Pre-warms cert cache for all provider hosts
5. Query MCP proxy for tools — unchanged
6. Generate orientation — unchanged
7. Build Docker image (with CA cert baked in, using temp build context)
8. Create container with:
   - Fake API keys in env (NOT real keys)
   - NODE_EXTRA_CA_CERTS pointing to baked-in cert path
   - MITM proxy socket mounted (replaces connect-proxy socket)
9. Start container
10. Start watchers — unchanged
```

### Updated Deps

```typescript
export interface DockerAgentSessionDeps {
  // ... existing fields ...
  readonly mitmProxy: MitmProxy;     // replaces connectProxy
  readonly ca: CertificateAuthority; // for image build + staleness detection
}
```

### Entrypoint Script Update

The entrypoint script changes only the socket name:

```bash
#!/bin/bash
# Bridge MITM proxy UDS to local TCP for HTTPS_PROXY
MITM_SOCK="/run/ironcurtain/mitm-proxy.sock"
PROXY_PORT=18080
if [ -S "$MITM_SOCK" ]; then
  socat TCP-LISTEN:$PROXY_PORT,fork,reuseaddr UNIX-CONNECT:$MITM_SOCK &
fi

exec sleep infinity
```

## 8. What Gets Blocked

### Request-Level Filtering

With TLS terminated, we can see the full HTTP request. The proxy applies a default-deny policy at the endpoint level:

| Provider | Allowed | Blocked (examples) |
|----------|---------|-------------------|
| Anthropic | `POST /v1/messages` | `GET /v1/messages/*`, `POST /v1/complete`, any other path |
| OpenAI | `POST /v1/chat/completions`, `GET /v1/models` | `POST /v1/images/*`, `POST /v1/audio/*`, any other path |
| Google | `POST .../generateContent`, `POST .../streamGenerateContent` | `POST .../embedContent`, any other path |

### What This Prevents

1. **Web fetch tunneling**: Claude Code's built-in web fetch tools route through Anthropic's API. With endpoint filtering, only `/v1/messages` is allowed — if Anthropic introduces a separate endpoint for web proxy functionality, it would be blocked by default.

2. **API key exfiltration via non-completion endpoints**: A compromised agent cannot use the API key to access other provider services (image generation, embeddings, file uploads, etc.) since those endpoints are blocked.

3. **Data exfiltration via API key reuse**: Even if the agent extracts the fake API key from its environment, the key is useless — it's a random sentinel that no provider will accept.

4. **Unauthenticated request injection**: The proxy validates that the incoming request carries the expected fake key before swapping. Requests without the correct sentinel are rejected with 403, preventing the proxy from blindly authenticating arbitrary requests.

## 9. SSE Streaming

### How It Works

The proxy uses `upstreamRes.pipe(clientRes)` for response streaming, with explicit optimizations for low-latency SSE delivery:

1. The upstream sends `Content-Type: text/event-stream` with `Transfer-Encoding: chunked`
2. `clientRes.flushHeaders()` sends headers immediately so the client knows the response has started
3. `clientRes.socket?.setNoDelay(true)` disables Nagle's algorithm, preventing small SSE chunks from being batched
4. `pipe()` forwards each chunk as it arrives from the upstream socket
5. The client receives SSE events with minimal latency

No SSE parsing is needed — the proxy is a transparent pipe at the HTTP level.

### Timeout Handling

SSE connections are long-lived. The proxy does not impose idle timeouts on individual HTTP connections. The session-level timeout (via `docker exec` timeout) handles runaway sessions. The only timeout is the 10-second TLS handshake timeout, which only applies before the connection is established.

## 10. Security Analysis

### What the Container Can See

| Item | Before | After |
|------|--------|-------|
| API key | Real key in env var | Fake sentinel (useless outside the MITM proxy) |
| TLS traffic | Encrypted to real API | Encrypted to MITM proxy (different cert chain) |
| HTTP requests | Not inspectable | Still not inspectable by the container |

### What the MITM Proxy Can See

- Full HTTP request: method, path, headers, body
- Full HTTP response: status, headers, body (including streamed completions)
- The real API key (held in memory, never written to disk during session)

### Attack Vectors

**1. Agent extracts fake key and tries to use it externally**
- The fake key is not valid with any provider → 401 Unauthorized
- The container has `--network=none` anyway; only the MITM proxy is reachable

**2. Agent tries to reach non-API endpoints on the provider**
- Endpoint filtering returns 403 for anything not in the allowlist
- Agent sees: `Blocked: GET /v1/some-endpoint is not an allowed endpoint`

**3. Agent sends requests without the expected fake key**
- The proxy validates the key before swapping — requests with a missing or non-matching key are rejected with 403
- This prevents the proxy from blindly authenticating arbitrary requests

**4. Agent tries to exfiltrate data in the request body**
- The completion request body goes to the real API (this is the intended use)
- The proxy could optionally log/inspect request bodies for audit, but this is out of scope for the initial implementation

**5. Agent tries to reach other hosts**
- CONNECT to non-allowlisted host → 403 at the CONNECT level (before TLS even starts)

**6. Agent bypasses HTTPS_PROXY and connects directly**
- Container is `--network=none` — no direct connections possible
- The only path out is through the mounted UDS → socat → MITM proxy

**7. Agent detects the MITM and refuses to operate**
- The IronCurtain CA is trusted via both the system CA store (`update-ca-certificates`) and `NODE_EXTRA_CA_CERTS`
- Standard TLS clients trust it. Claude Code uses Node.js which respects `NODE_EXTRA_CA_CERTS`.
- The agent has no reason to pin certificates

**8. CA key is compromised**
- If `~/.ironcurtain/ca/ca-key.pem` is stolen, an attacker could forge certs for any domain
- Mitigation: file permissions (0600, verified on load), and the CA is only trusted inside IronCurtain containers (not system-wide on the host)
- The CA cert is a self-signed root that is only installed in the Docker image, not in the host's trust store

## 11. Implementation Plan

### Phase 1: CA Certificate Generation

**Files:**
- New: `src/docker/ca.ts` — CA generation/loading using `node-forge`, permission verification
- New: `test/ca.test.ts`
- Modified: `package.json` — add `node-forge` + `@types/node-forge` dependencies

**Deliverable:** `loadOrCreateCA()` generates a CA, stores it with correct permissions, and loads it on subsequent calls.

### Phase 2: MITM Proxy Core

**Files:**
- New: `src/docker/mitm-proxy.ts` — TLS-terminating proxy with:
  - Single shared inner HTTP server (not per-connection)
  - Connection tracking (`Set<TLSSocket>`, `Set<ClientRequest>`, `WeakMap` metadata)
  - TLS `head` buffer handling via `unshift()`
  - TLS handshake timeout (10s)
  - Stale UDS cleanup on start
  - Cert cache pre-warming for all configured provider hosts
  - `flushHeaders()` + `setNoDelay(true)` for SSE
  - Client disconnect → abort upstream request
  - Upstream error after headers sent → destroy client socket
- New: `src/docker/provider-config.ts` — provider config types and built-in providers, with regex-safe endpoint matching
- New: `src/docker/fake-keys.ts` — sentinel key generation
- New: `test/mitm-proxy.test.ts`

**Deliverable:** A proxy that accepts CONNECT on UDS, terminates TLS, validates + swaps API keys, filters endpoints, and streams responses.

**Testing approach:** Start the MITM proxy, create a mock HTTPS server (playing the role of an LLM API), configure the proxy to forward to it, and verify:
- Correct fake key → real key is swapped in the forwarded request
- Wrong/missing fake key → 403
- Allowed endpoints pass through
- Blocked endpoints get 403
- SSE responses stream correctly (verify chunk-by-chunk delivery)
- Non-allowlisted hosts get 403 at CONNECT level
- Client disconnect aborts upstream request
- TLS handshake timeout fires
- Clean shutdown destroys all connections

### Phase 3: Agent Adapter + Session Integration

**Files:**
- Modified: `src/docker/agent-adapter.ts` — add `getProviders()`, change `buildEnv()` signature (breaking change; remove `getAllowedApiHosts()`)
- Modified: `src/docker/adapters/claude-code.ts` — implement new methods, add `NODE_EXTRA_CA_CERTS`
- Modified: `src/docker/docker-agent-session.ts` — replace `connectProxy` with `mitmProxy`, generate fake keys, use temp build context for image builds
- Removed: `src/docker/connect-proxy.ts` (replaced by mitm-proxy.ts)
- Modified: `docker/Dockerfile.base` — add CA cert via `COPY` + `update-ca-certificates`
- Modified: `docker/entrypoint-claude-code.sh` — update socket name

**Deliverable:** End-to-end flow where the container gets a fake key and the real key never leaves the host.

### Phase 4: Docker Image Rebuild Logic

**Files:**
- Modified: `DockerAgentSession.ensureImage()` — use temp build context (not source tree), add CA cert hash label to image, detect staleness via `docker inspect`, force rebuild on mismatch or inspect failure

**Deliverable:** Images are automatically rebuilt when the CA cert changes. Source tree is never dirtied by the build process.

### Phase 5: Testing and Hardening

**Unit tests** (in `test/mitm-proxy.test.ts`, Phase 2):
- Verify cert cache behavior under concurrent requests
- Verify error handling: upstream timeout, upstream connection refused, malformed requests, client disconnect mid-stream
- Verify TLS handshake timeout
- Verify clean shutdown under active connections

**Docker integration test** (`test/mitm-proxy-docker.integration.test.ts`):

An end-to-end test that proves the full chain works: container `curl` → socat → UDS → MITM proxy → mock HTTPS server. No real API key or API call needed.

```
Docker Container (--network=none)
  curl --proxy http://127.0.0.1:18080 \
       -H "x-api-key: <fake-key>" \
       https://127.0.0.1:<mockPort>/v1/messages
        |
  socat TCP:18080 <-> UDS:mitm-proxy.sock
        |
Host: MITM Proxy
  Terminates TLS, validates fake key, swaps to real key, forwards
        |
Host: Mock HTTPS Server (node:https)
  Records received requests for assertion
  Cert signed by the same test CA
```

**Setup:**

1. Generate a fresh CA in a temp directory using `loadOrCreateCA()`
2. Start a mock HTTPS server on `127.0.0.1` with a cert signed by the same CA (so the proxy's upstream `https.request()` trusts it via `NODE_EXTRA_CA_CERTS`)
3. Start the MITM proxy on UDS with a provider config for `127.0.0.1:<mockPort>` mapping `FAKE_KEY` → `REAL_KEY`
4. Start a `--network=none` container from `ironcurtain-base:latest` with the proxy socket and CA cert bind-mounted
5. Run `socat TCP-LISTEN:18080,fork,reuseaddr UNIX-CONNECT:/run/ironcurtain/mitm-proxy.sock &` inside the container

**Test cases:**

| Test | curl command inside container | Expected |
|------|------------------------------|----------|
| TLS termination works | `curl -X POST -H "x-api-key: <fake>" ... /v1/messages` | HTTP 200 from mock server |
| Key swap works | Same as above, inspect mock server's `receivedRequests` | Mock sees `x-api-key: REAL_KEY`, not `FAKE_KEY` |
| Endpoint filtering | `curl -X GET ... /v1/some-other-endpoint` | HTTP 403 from proxy, mock server receives nothing |
| Wrong key rejected | `curl -X POST -H "x-api-key: wrong" ... /v1/messages` | HTTP 403 from proxy, mock server receives nothing |
| Non-allowlisted host | `curl https://evil.example.com/` | curl error (proxy returns 403 on CONNECT) |

**Test patterns:** Follows existing `test/network-isolation.integration.test.ts` conventions — gated by `INTEGRATION_TEST=1`, `describe.skipIf`, 60s setup timeout, 30s per-test timeout, `docker rm -f` cleanup in `afterAll`.

**SSE streaming test** (in `test/mitm-proxy.test.ts`):
- Mock upstream sends `Content-Type: text/event-stream` with chunked SSE events at timed intervals
- Verify proxy delivers chunks with low latency (not buffered until response ends)

**Manual smoke test:**
- Verify that Claude Code actually works through the MITM proxy with a real API key

## 12. Dependencies

| Dependency | Purpose | Size | Weekly Downloads |
|------------|---------|------|-----------------|
| `node-forge` | RSA key generation + X.509 cert signing | ~2MB | 7M+ |
| `@types/node-forge` | TypeScript types | Minimal | — |

No other new dependencies. Everything else uses Node.js builtins: `http`, `https`, `tls`, `net`, `crypto`, `fs`.

## 13. Open Questions

1. **Request body inspection.** The proxy currently only inspects method/path/headers. Should we also inspect request bodies? For example, we could block requests with specific model names, or requests that appear to be data exfiltration. This adds complexity (must buffer the body before forwarding) and is deferred.

2. **Response logging for audit.** The proxy could log all requests to a MITM-specific audit log (separate from the MCP audit log). This would provide a complete record of all LLM API calls. Deferred for now; the MCP audit log already captures tool calls.

3. **HTTP/2.** The current design handles HTTP/1.1 only. LLM API providers currently support HTTP/1.1. If they switch to HTTP/2-only, the proxy would need updating. Node.js `http2` module could handle this, but it's a different wire format.

4. **Anthropic web search/fetch tools.** Claude Code has built-in tools that route through Anthropic's API (e.g., web search). These go through `/v1/messages` as normal completion requests with tool use. The MITM proxy allows them because the endpoint is `/v1/messages`. If we want to block these specifically, we'd need to inspect the request body for tool use patterns — this is a future enhancement.

5. **Query-parameter key injection.** Some providers (e.g., Google) support API keys in query parameters (`?key=`). The current implementation only supports header-based injection. Query-parameter support can be added by extending `KeyInjection` with a `query` variant and rewriting `clientReq.url` in the request handler. Deferred until a provider requires it.
