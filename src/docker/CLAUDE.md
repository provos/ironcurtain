# Docker Agent Mode (`src/docker/`)

An alternative session type that runs external coding agents (Claude Code, etc.) inside Docker containers with `--network=none`. The agent communicates with IronCurtain via two Unix domain sockets: an MCP proxy (for tool calls) and a MITM proxy (for LLM API calls).

**Key files:**
- `docker-agent-session.ts` - Session implementation. Manages container lifecycle, starts proxies, handles escalations. `ensureImage()` uses content-hash labels for staleness detection.
- `mitm-proxy.ts` - TLS-terminating MITM proxy. Outer HTTP server on UDS handles CONNECT (host allowlist). Inner HTTP server processes decrypted requests (endpoint filtering, fake-key-to-real-key swap, upstream forwarding with SSE streaming). Uses `node-forge` for per-host cert generation with SNI callbacks.
- `ca.ts` - `loadOrCreateCA()` generates/loads a 2048-bit RSA CA at `~/.ironcurtain/ca/`. Key file has `0600` permissions. Cert is baked into Docker images; key never enters containers.
- `provider-config.ts` - `ProviderConfig` interface and built-in providers (Anthropic, OpenAI, Google). `isEndpointAllowed()` does strict path matching with glob support (`*` matches one path segment). Query strings are stripped before matching.
- `fake-keys.ts` - `generateFakeKey(prefix)` creates sentinel keys with `crypto.randomBytes(24)` (192 bits).
- `agent-adapter.ts` - `AgentAdapter` interface. `getProviders()` returns required LLM providers. `buildEnv(config, fakeKeys)` builds container env vars with fake keys instead of real ones.
- `adapters/claude-code.ts` - Claude Code adapter. Sets `NODE_EXTRA_CA_CERTS` for the IronCurtain CA.
- `docker-manager.ts` - Docker CLI wrapper. `getImageLabel()` reads labels for staleness detection. `buildImage()` accepts optional labels.

**Security model:** Real API keys never enter the container. The agent receives a fake sentinel key; the MITM proxy validates it and swaps for the real key on the host side. Endpoint filtering ensures only specific API paths are accessible (e.g., `POST /v1/messages`).
