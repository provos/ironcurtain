# Docker Agent Mode (`src/docker/`)

An alternative session type that runs external coding agents (Claude Code, Goose, etc.) inside containers with no network egress. On Linux Docker and Apple `container` (>= 1.1.0), containers use `--network none` with UDS-mounted proxies. On macOS Docker Desktop, containers run on a Docker `--internal` network with a socat sidecar that forwards only the MCP and MITM proxy ports to the host — the agent cannot reach the internet or arbitrary host services.

## Core session files

- `docker-agent-session.ts` - Session implementation. Manages container lifecycle, starts proxies, handles escalations. `ensureImage()` uses content-hash labels for staleness detection. Construction takes an `ownsInfra: boolean` flag that gates teardown: standalone sessions own the bundle and destroy it on `close()`; workflow shared-container sessions borrow a caller-supplied bundle (`ownsInfra: false`) and leave it alive.
- `docker-infrastructure.ts` - Shared `DockerInfrastructure` bundle used by single-session (`createDockerSession()`, `runPtySession()`) and workflow shared-container runs. The bundle holds proxies, orientation, CA, fake keys, and image resolution. In workflow mode the orchestrator builds one bundle per run via `createWorkflowInfrastructure` / `destroyWorkflowInfrastructure` (see `src/workflow/orchestrator.ts`) and hands it to every state's session via `SessionOptions.workflowInfrastructure`. Snapshot resume threads an optional `baseImageOverride` through the workflow factory so the main container can be created from a checkpointed digest while still ensuring the normal agent image for dependency-cache hashing.
  - **Active-profile config-stamping (OpenRouter, F1).** `prepareDockerInfrastructure` resolves the session's provider profile via `resolveActiveProfile(config.userConfig.modelProviders, providerProfileName)` and **stamps `config.activeProviderProfile`** as its **first step — before auth detection** (Claude Code's `detectCredential(config)` reads the stamped profile to return an API-key auth method for an OpenRouter-only user). An unknown `providerProfileName` throws (listing available profiles) before container launch. Everything downstream (`resolveRealKey`, adapters' `getProviders`/`buildEnv`) reads the per-session stamped `config.activeProviderProfile` — **binding the profile at adapter-factory/registry time is forbidden** (the registry caches adapter instances across sessions, so a factory-captured profile would leak between concurrent sessions).
- `docker-manager.ts` - Docker CLI wrapper implementing `ContainerRuntime`. `getImageLabel()` reads labels for staleness detection. `buildImage()` accepts optional labels. Workflow snapshot resume also uses `commit()`, `removeImage()`, `listImages()`, and `inspectImage()`; flattened snapshot commits use `docker export`/`docker import` so superseded snapshot digests can be removed without leaving the prior digest inspectable as an image parent.
- `container-runtime.ts` - Runtime selection seam: `createContainerRuntime(kind)` returns the `ContainerRuntime` implementation for a `ContainerRuntimeKind` (`docker` or `apple-container`, see `docs/designs/apple-container-runtime.md`). Agent-session infrastructure goes through this factory; Docker-specific host services (signal-cli, daemon orphan sweeps) call `createDockerManager()` directly.
- `apple-container-manager.ts` - Apple `container` CLI wrapper implementing `ContainerRuntime` (macOS 26+ on Apple silicon, VM per container, `container` >= 1.1.0). `checkAppleContainerAvailable()` is the availability probe. All mounts emit via `-v src:tgt[:ro]` (dirs, single files, and per-file UDS vsock relays uniformly); `--publish-socket` handles the guest-listens/host-connects PTY bridge. Docker-only mechanisms (`extraHosts`, `restartPolicy`, `connectNetwork`) throw instead of degrading silently. The only module allowed to spawn the `container` binary.
- `network-topology.ts` - Proxy-transport topology (`uds` | `tcp-sidecar` | `tcp-hostonly`). apple-container resolves to `uds` (per-file `-v` socket relays + `--network none`); Docker resolves to `uds` on Linux and `tcp-sidecar` on macOS. `tcp-hostonly` (host-only vmnet, 16-subnet pool, `0.0.0.0` proxies guarded by `makeSourceAddressGuard`, `checkHostOnlyConnectivity`, `writeHostOnlyAptProxyConfig`) is retained but not currently selected — it was the pre-1.1.0 apple-container path. Backend selection: `containerRuntime` config field (`auto` default — prefers apple-container when its probe passes; resolution memoized in `container-runtime.ts`), overridable via `IRONCURTAIN_CONTAINER_RUNTIME`. `buildUdsSocketMounts` in `docker-infrastructure.ts` is the runtime-keyed `uds` mount helper (dir mount on Docker, per-file on apple-container) shared by batch and PTY modes.
- `types.ts` - Type definitions for container lifecycle (`ContainerRuntime`, `DockerContainerConfig`, `DockerMount`, etc.).
- `platform.ts` - Platform detection for the **Docker** transport split. macOS Docker uses TCP (VirtioFS doesn't support UDS); Linux Docker uses UDS. Not consulted for apple-container.
- `orientation.ts` - Generates MCP client configuration and system prompt files for the agent container. Written to a read-only bind-mounted orientation directory.
- `audit-log-tailer.ts` - Tails JSONL audit log and emits `DiagnosticEvent` callbacks for new entries via `fs.watchFile()`.

## MITM proxy & credentials

- `mitm-proxy.ts` - TLS-terminating MITM proxy. Outer HTTP server on UDS handles CONNECT (host allowlist). Inner HTTP server processes decrypted requests (endpoint filtering, fake-key-to-real-key swap, upstream forwarding with SSE streaming). Uses `node-forge` for per-host cert generation with SNI callbacks.
- `ca.ts` - `loadOrCreateCA()` generates/loads a 2048-bit RSA CA at `~/.ironcurtain/ca/`. Key file has `0600` permissions. Cert is baked into Docker images; key never enters containers.
- `provider-config.ts` - `ProviderConfig` interface and built-in providers (Anthropic, OpenAI, Google). `isEndpointAllowed()` does strict path matching with glob support (`*` matches one path segment). Query strings are stripped before matching. The `RequestBodyRewriter` context carries an optional `cacheKey` (the stable conversation id) used for OpenRouter `session_id` injection.
- `openrouter.ts` - First-class OpenRouter transform module (see `docs/designs/openrouter-integration.md`). `makeOpenRouterProvider(kind, rewriter)` builds the **openrouterProvider** `ProviderConfig` for an agent's endpoint kind (`messages` / `chat` / `responses`) with bearer key injection and a per-agent allowlist; `makeOpenRouterProviderForProfile` / `rewriterConfigFromProfile` wire it from a resolved profile. `makeOpenRouterRewriter` rewrites the top-level `model` per the glob `modelMap`, injects the D3 soft z-ai pin + a stable `session_id` (cache affinity), and strips Anthropic-only beta fields; `globToRegExp` / `resolveMappedModel` do the glob lookup. All three agents talk to `openrouter.ai` natively — no upstream redirect.
- `fake-keys.ts` - `generateFakeKey(prefix)` creates sentinel keys with `crypto.randomBytes(24)` (192 bits).
- `oauth-credentials.ts` - OAuth credential detection and macOS Keychain extraction. `detectAuthMethod()` determines whether to use OAuth or API key auth for Docker sessions.
- `oauth-token-manager.ts` - Proactive/reactive OAuth token refresh. Coordinates with the host Claude Code process; on macOS operates read-only (re-reads Keychain, never refreshes itself to avoid invalidating the host's refresh token). Shares a single in-flight refresh promise across concurrent callers.

## Token-trajectory capture (opt-in, training data)

Verbatim, byte-faithful capture of the agent↔provider HTTP exchanges, written as per-session JSONL for SFT/RL training data. Off by default; enabled with `--capture-traces` (`start`, `workflow start`, `daemon`) or `capture.enabled` in config. Zero cost when disabled (no taps installed, no allocations). See the root [`TRAJECTORIES.md`](../../TRAJECTORIES.md) for usage and [`docs/designs/mitm-token-trajectory-capture.md`](../../docs/designs/mitm-token-trajectory-capture.md) for the design.

- `trajectory-types.ts` - `ExchangeRecord` schema, manifest entry types, `PoisonReason`, `CaptureConfig`, and the `redactHeaders` helper (strips `authorization` / `x-api-key` / `cookie` defensively).
- `trajectory-capture.ts` - `TrajectoryCaptureWriter` dispatcher: per-session file handles + a single append-only `manifest.jsonl`, single-flight `setImmediate` drain loop, watermark-defended unbounded queues, two-phase `endSession`, and the **binary session-poison model** (a flawed exchange poisons the whole session via `poisoned`/`poisonReason` on its `session-end` entry; never a partial record). Counters are bumped post-`appendFile` so manifest `exchanges` matches on-disk line count.
- `trajectory-reassembler.ts` - SSE → final-message reassembly with strict byte fidelity (no `JSON.parse`→`stringify` round-trip; `thinking` signatures, block order, and `redacted_thinking` preserved). `SseLineSplitter` decodes through a `StringDecoder` so multibyte UTF-8 split across chunks isn't corrupted. Anthropic implemented; OpenAI stubbed for v0. `providerForHost(host, path?)` is the host→provider classifier and `createReassembler(host, path?)` picks the reassembler; both are **path-aware** for `openrouter.ai` (one host, three wire formats): `/api/v1/messages` → Anthropic, `/api/v1/responses` → Responses reassembler, `/api/v1/chat/completions` → raw-bytes-only (no reassembler, v0). The token-stream tap's own classifier `resolveSseProvider(host, path?)` in `mitm-proxy.ts` is path-aware the same way — the two seams are independent — and `isLlmMessagesEndpoint` matches the three `/api/v1/*` OpenRouter paths.
- `trajectory-tap.ts` - Per-exchange capture tap: request-body tee, response-body fan-out, and `createResponseCaptureInlet` (decompresses per `content-encoding` — gzip/deflate/br — before the reassembler; unsupported encodings like zstd poison the session).
- `mitm-proxy.ts` (capture role) - The inner request handler snapshots `captureSessionId`/`capturePersona` (decoupled from `tokenSessionId`), gates on `isCapturableEndpoint` (completion endpoints only — see `provider-config.ts` `captureEndpoints`), and **fans out** the upstream response into a forwarding branch (raw bytes → agent, unchanged) and a capture branch (decompress → tap). The capture branch never applies backpressure to forwarding. Credential boundary: captures the agent-facing side only (sentinel keys), verified by `test/docker/trajectory-credential-leakage.unit.test.ts`.

Lifecycle is driven through `DockerInfrastructure.beginCaptureSession()` / `endCaptureSession()`; standalone sessions drive it in owns-infra mode, workflows from the orchestrator with `persona`/`fsmState`. The internal `MitmProxy.setCaptureSessionId` / `setCapturePersona` setters are wrapped by those bundle methods — orchestrators never call them directly.

## Proxy tools & package registry

- `proxy-tools.ts` - Hardcoded MCP tool definitions, annotations, and policy rules for domain management. Injected into the ToolCallCoordinator during construction for policy evaluation and audit logging.
- `code-mode-proxy.ts` - MCP server exposing a single `execute_code` tool backed by the UTCP Code Mode sandbox. Docker agents send TypeScript via this tool, sharing the same V8 execution engine as builtin Code Mode sessions. Implements the `DockerProxy` interface. `DockerProxy.getPolicySwapTarget()` returns a narrow `PolicySwapTarget` handle (only `startControlServer`) that the workflow orchestrator uses to attach a control server to the live coordinator; single-session callers never use it.
- `registry-proxy.ts` - URL parsing, metadata filtering, and tarball backstop for npm, PyPI, Debian, and cargo (crates.io) package registries. Built-in registry configs for each.
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

**Quota exhaustion contract:** adapters MUST populate `AgentResponse.quotaExhausted` when the underlying CLI surfaces a 429-class envelope; the workflow orchestrator short-circuits on this signal instead of retrying. See `adapters/claude-code.ts` for the canonical implementation.

## Dual session modes: keep in sync

`docker-agent-session.ts` (batch mode) and `pty-session.ts` (PTY mode) have parallel initialization paths that share adapter infrastructure but assemble container configs independently. When adding a mount, env var, or container lifecycle feature to one mode, always check the other mode and apply the same change if applicable. Past bug: conversation state mount was added to PTY mode but missed in batch mode, breaking `claude --continue` across container recreations.

## PTY mode

- `pty-session.ts` - PTY session orchestration. Node.js PTY proxy bridges the user's terminal to Claude Code inside the container via a socket (UDS on Linux, TCP on macOS). Handles terminal raw mode enter/exit, SIGWINCH forwarding for resize, BEL on escalation, and registration file lifecycle.
- `pty-types.ts` - Type definitions for PTY sessions (`PtySessionRegistration`, socket/port constants).

**PTY transport:** On Linux Docker, the container-side socat listens on a UDS in the bind-mounted `sockets/` directory. On apple-container it listens on `/tmp/ironcurtain-pty.sock` and `--publish-socket` bridges it to `<socketsDir>/pty.sock` on the host (same host-side path as Linux). On macOS Docker Desktop it uses TCP through the socat sidecar. Only the `sockets/` subdirectory (or its individual socket files on apple-container) is mounted into the container -- not the full session directory -- so the container cannot access escalation files, audit logs, or other session data.

## Security model

Real credentials (API keys or OAuth tokens) never enter the container. The agent receives a fake sentinel key; the MITM proxy validates it and swaps for the real credential on the host side. OAuth is auto-detected from `~/.claude/.credentials.json` and preferred over API keys; override with `IRONCURTAIN_DOCKER_AUTH=apikey`. Endpoint filtering ensures only specific API paths are accessible (e.g., `POST /v1/messages`).

Package installations are mediated by the registry proxy, which validates packages against allowlist/denylist rules and an age gate (quarantine period for new versions) before allowing downloads from npm, PyPI, Debian, or crates.io repositories.
