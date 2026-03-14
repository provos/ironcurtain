---
name: Docker MITM Proxy Architecture
description: Detailed notes on the MITM proxy internals, host allowlisting, and extension patterns for Docker Agent Mode
type: project
---

## MITM Proxy Architecture (`src/docker/mitm-proxy.ts`)

### Two-Layer Server
- **Outer server**: `http.createServer` on UDS (Linux) or TCP (macOS), handles CONNECT
- **Inner server**: shared `http.createServer` (not listening), receives decrypted TLS connections via `emit('connection', tlsSocket)`
- Connection metadata stored in `WeakMap<tls.TLSSocket, { provider, host, port }>`

### Host Allowlisting
- `providersByHost: Map<string, ProviderKeyMapping>` built from `MitmProxyOptions.providers`
- CONNECT handler checks this map; unknown hosts get `403 Forbidden`
- This is the primary network isolation enforcement for Docker sessions

### Per-Host TLS
- `getOrCreateSecureContext(hostname)` generates leaf certs signed by IronCurtain CA
- Cert cache with 24h lifetime, 1h renewal margin
- SNI callback dispatches to cached context
- CA cert baked into Docker images via `update-ca-certificates`

### Request Pipeline (inner server)
1. Endpoint filtering via `isEndpointAllowed(provider.config, method, path)`
2. Fake key validation + swap via `validateAndSwapApiKey(headers, provider)`
3. Optional body rewrite (e.g., strip server-side tools from Anthropic)
4. Proactive OAuth token refresh when tokenManager is present
5. Forward upstream with optional 401 retry

### Key Types
- `ProviderConfig`: host, allowedEndpoints, keyInjection (header|bearer), fakeKeyPrefix, requestRewriter
- `ProviderKeyMapping`: config + fakeKey + realKey + tokenManager
- `MitmProxyOptions`: socketPath|listenPort, ca, providers[]

### Platform Transport
- Linux: UDS (`socketPath`) -- sockets in `sessionDir/sockets/`
- macOS: TCP (`listenPort: 0` for OS-assigned port) -- socat sidecar bridges internal network to host

### Extension Pattern
To add new allowlisted hosts: add entries to `MitmProxyOptions.providers`.
The CONNECT handler and inner server dispatch are the two points requiring changes
when adding a fundamentally new host type (e.g., registries vs LLM providers).

### Docker Integration Points
- Container env: `HTTPS_PROXY=http://host.docker.internal:{port}` (macOS) or `http://127.0.0.1:18080` (Linux)
- Entrypoint scripts bridge UDS to local TCP: `socat TCP-LISTEN:18080,fork UNIX-CONNECT:/run/ironcurtain/mitm-proxy.sock`
- `prepareDockerInfrastructure()` in `docker-infrastructure.ts` constructs ProviderKeyMappings and starts the proxy

## Package Installation Proxy Design (2026-03-14)
- See `docs/designs/package-installation-proxy.md` for full spec
- Extends MITM proxy with `registriesByHost` map alongside `providersByHost`
- Registry connections: TLS termination same as providers, but no key injection
- npm/PyPI URL parsers extract PackageIdentity from request paths
- PackageValidator: allowlist/denylist + 2-day quarantine for new packages (configurable, binary allow/deny)
- Separate audit log: `package-audit.jsonl` in session directory
- Dockerfiles: uv and ruff pre-installed in base images
