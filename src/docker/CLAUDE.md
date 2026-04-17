# Docker Agent Mode (`src/docker/`)

An alternative session type that runs external coding agents (Claude Code, Goose, etc.) inside Docker containers with no network egress. On Linux, containers use `--network=none` with UDS-mounted proxies. On macOS, containers run on a Docker `--internal` network with a socat sidecar that forwards only the MCP and MITM proxy ports to the host — the agent cannot reach the internet or arbitrary host services.

## Core session files

- `docker-agent-session.ts` - Session implementation. Manages container lifecycle, starts proxies, handles escalations. `ensureImage()` uses content-hash labels for staleness detection.
- `docker-infrastructure.ts` - Shared `prepareDockerInfrastructure()` helper used by both `createDockerSession()` and `runPtySession()`. Sets up proxies, orientation, CA, fake keys, and image resolution.
- `docker-manager.ts` - Docker CLI wrapper. `getImageLabel()` reads labels for staleness detection. `buildImage()` accepts optional labels.
- `types.ts` - Type definitions for Docker container lifecycle (`DockerContainerConfig`, `DockerMount`, etc.).
- `platform.ts` - Platform detection for transport selection. macOS uses TCP (VirtioFS doesn't support UDS); Linux uses UDS.
- `orientation.ts` - Generates MCP client configuration and system prompt files for the agent container. Written to a read-only bind-mounted orientation directory.
- `audit-log-tailer.ts` - Tails JSONL audit log and emits `DiagnosticEvent` callbacks for new entries via `fs.watchFile()`.

## MITM proxy & credentials

- `mitm-proxy.ts` - TLS-terminating MITM proxy. Outer HTTP server on UDS handles CONNECT (host allowlist). Inner HTTP server processes decrypted requests (endpoint filtering, fake-key-to-real-key swap, upstream forwarding with SSE streaming). Uses `node-forge` for per-host cert generation with SNI callbacks.
- `ca.ts` - `loadOrCreateCA()` generates/loads a 2048-bit RSA CA at `~/.ironcurtain/ca/`. Key file has `0600` permissions. Cert is baked into Docker images; key never enters containers.
- `provider-config.ts` - `ProviderConfig` interface and built-in providers (Anthropic, OpenAI, Google). `isEndpointAllowed()` does strict path matching with glob support (`*` matches one path segment). Query strings are stripped before matching.
- `fake-keys.ts` - `generateFakeKey(prefix)` creates sentinel keys with `crypto.randomBytes(24)` (192 bits).
- `oauth-credentials.ts` - OAuth credential detection and macOS Keychain extraction. `detectAuthMethod()` determines whether to use OAuth or API key auth for Docker sessions.
- `oauth-token-manager.ts` - Proactive/reactive OAuth token refresh. Coordinates with the host Claude Code process; on macOS operates read-only (re-reads Keychain, never refreshes itself to avoid invalidating the host's refresh token). Shares a single in-flight refresh promise across concurrent callers.

## Proxy tools & package registry

- `proxy-tools.ts` - Hardcoded MCP tool definitions, annotations, and policy rules for domain management. Injected into the ToolCallCoordinator during construction for policy evaluation and audit logging.
- `code-mode-proxy.ts` - MCP server exposing a single `execute_code` tool backed by the UTCP Code Mode sandbox. Docker agents send TypeScript via this tool, sharing the same V8 execution engine as builtin Code Mode sessions. Implements the `DockerProxy` interface.
- `registry-proxy.ts` - URL parsing, metadata filtering, and tarball backstop for npm, PyPI, and Debian package registries. Built-in registry configs for each.
- `package-types.ts` - Shared types for the package installation proxy (`RegistryConfig`, `PackageIdentity`, `PackageValidator`, etc.).
- `package-validator.ts` - Package validation against allowlist/denylist/age-gate rules. First-match semantics: denylist > allowlist > age gate > default allow.

## Proxy passthrough (domain management)

The `proxy` virtual MCP server (`proxy-tools.ts`) exposes `add_proxy_domain`, `remove_proxy_domain`, and `list_proxy_domains`. These are hardcoded tool definitions (not LLM-generated) with hardcoded policy rules: `add` → escalate, `remove` → allow, `list` → allow. Injected into the ToolCallCoordinator during construction alongside compiled rules.

**Domain validation** (`validateDomain()` in `proxy-tools.ts`): Rejects IP addresses, `localhost`, `*.docker.internal`, names >253 chars, and invalid format. Runs before policy evaluation.

**Two connection modes in `mitm-proxy.ts`:**
- **Provider/registry CONNECT** → TLS-terminating MITM (credential swap, endpoint filtering, request rewriting). Used for LLM API providers and package registries.
- **Passthrough CONNECT** → Raw TCP tunnel via `net.connect()`. No TLS termination, no content inspection. Supports HTTP, HTTPS, and WebSocket. Used for dynamically added domains.

**Plain HTTP WebSocket upgrade** (`outerServer.on('upgrade')`) handles `ws://` connections via `HTTP_PROXY`. The `bridgeWebSocketUpgrade()` helper forwards the upgrade to the upstream and pipes both sockets bidirectionally.

**Lifecycle:** Domains are session-scoped (in-memory `passthroughHosts` Set). Tunneled socket pairs are tracked in `activeTunnelPairs` and destroyed on `stop()`.

## Agent adapters

- `agent-adapter.ts` - `AgentAdapter` interface. `getProviders(authKind?)` returns required LLM providers (OAuth or API key). `buildEnv(config, fakeKeys)` builds container env vars with fake keys instead of real ones.
- `agent-registry.ts` - Simple `Map`-based registry of agent adapters. `registerBuiltinAdapters()` lazily loads Claude Code and Goose adapters.
- `adapters/claude-code.ts` - Claude Code adapter. Auth-aware `buildEnv()` sets `CLAUDE_CODE_OAUTH_TOKEN` or API key. `getProviders()` returns OAuth or API key providers based on `authKind`.
- `adapters/goose.ts` - Goose adapter. Generates Goose YAML config for MCP extension discovery, orientation scripts for PTY mode, and provider-specific env vars (Anthropic, OpenAI, Google).
- `adapters/shared-scripts.ts` - Shared shell script generators (e.g., `resize-pty.sh`) and prompt sections used by both adapters.
- `claude-md-seed.ts` - Builds `CLAUDE.md` content seeded into the container's `~/.claude/` for Claude Code sessions. Contains memory behavioral rules (pre-response MCP tool call protocol).

## Dual session modes: keep in sync

`docker-agent-session.ts` (batch mode) and `pty-session.ts` (PTY mode) have parallel initialization paths that share adapter infrastructure but assemble container configs independently. When adding a mount, env var, or container lifecycle feature to one mode, always check the other mode and apply the same change if applicable. Past bug: conversation state mount was added to PTY mode but missed in batch mode, breaking `claude --continue` across container recreations.

## PTY mode

- `pty-session.ts` - PTY session orchestration. Node.js PTY proxy bridges the user's terminal to Claude Code inside the container via a socket (UDS on Linux, TCP on macOS). Handles terminal raw mode enter/exit, SIGWINCH forwarding for resize, BEL on escalation, and registration file lifecycle.
- `pty-types.ts` - Type definitions for PTY sessions (`PtySessionRegistration`, socket/port constants).

**PTY transport:** On Linux, the container-side socat listens on a UDS in the bind-mounted `sockets/` directory. On macOS, it uses TCP through the socat sidecar. Only the `sockets/` subdirectory is mounted into the container -- not the full session directory -- so the container cannot access escalation files, audit logs, or other session data.

## Security model

Real credentials (API keys or OAuth tokens) never enter the container. The agent receives a fake sentinel key; the MITM proxy validates it and swaps for the real credential on the host side. OAuth is auto-detected from `~/.claude/.credentials.json` and preferred over API keys; override with `IRONCURTAIN_DOCKER_AUTH=apikey`. Endpoint filtering ensures only specific API paths are accessible (e.g., `POST /v1/messages`).

Package installations are mediated by the registry proxy, which validates packages against allowlist/denylist rules and an age gate (quarantine period for new versions) before allowing downloads from npm, PyPI, or Debian repositories.
