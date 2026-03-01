# Docker Agent Mode Details

## Key Files
- `src/docker/docker-agent-session.ts` -- Session impl, container lifecycle, escalation polling
- `src/docker/agent-adapter.ts` -- AgentAdapter interface; `buildCommand()`, `buildEnv()`, `extractResponse()`
- `src/docker/mitm-proxy.ts` -- TLS-terminating proxy; outer HTTP handles CONNECT, inner processes decrypted requests
- `src/docker/provider-config.ts` -- ProviderConfig per LLM provider (host, endpoints, keyInjection, fakeKeyPrefix)
- `src/docker/fake-keys.ts` -- `generateFakeKey(prefix)` with 192-bit random suffix
- `src/docker/docker-infrastructure.ts` -- `prepareDockerInfrastructure()` shared setup for standard + PTY modes
- `src/docker/adapters/claude-code.ts` -- Claude Code adapter impl
- `src/docker/orientation.ts` -- `prepareSession()` writes MCP config + orientation files
- `src/docker/ca.ts` -- `loadOrCreateCA()` for TLS cert generation
- `docker/entrypoint-claude-code.sh` -- Container entrypoint; writes .claude.json, settings.json, socat bridge

## Platform Modes
- `src/docker/platform.ts` -- `useTcpTransport()` returns true on macOS (VirtioFS no UDS)
- macOS: socat sidecar on bridge network forwards MCP+MITM ports to host.docker.internal
- Linux: `--network=none`, sockets dir bind-mounted for UDS access
- Container runs `sleep infinity`; agent commands via `docker exec`

## Credential Flow (API Key)
1. `resolveRealApiKey()` maps provider host -> config.userConfig.{anthropicApiKey,openaiApiKey,googleApiKey}
2. `generateFakeKey(provider.fakeKeyPrefix)` creates sentinel
3. `ProviderKeyMapping { config, fakeKey, realKey }` assembled
4. `adapter.buildEnv()` passes fake key via `IRONCURTAIN_API_KEY` env var
5. Container entrypoint writes `apiKeyHelper: echo $IRONCURTAIN_API_KEY` to settings.json
6. Claude Code calls apiKeyHelper, gets fake key, sends `x-api-key: <fake>`
7. MITM `validateAndSwapApiKey()` validates fake, replaces with real

## MITM Proxy Architecture
- Outer server: http.createServer on UDS/TCP, handles CONNECT
- Inner server: shared http.createServer receives decrypted TLS connections
- Per-host cert generation with node-forge (SNI callback)
- `isEndpointAllowed()` does strict path+method matching with glob support
- `shouldRewriteBody()` + `stripServerSideTools()` for request body rewriting

## Providers
- `anthropicProvider`: host=api.anthropic.com, x-api-key header, prefix=sk-ant-api03-
- `claudePlatformProvider`: host=platform.claude.com, x-api-key header (hello endpoint only)
- `openaiProvider`: host=api.openai.com, bearer auth
- `googleProvider`: host=generativelanguage.googleapis.com, x-goog-api-key header

## PTY Mode
- `--pty` flag: attaches user terminal to Claude Code PTY via socat bridge
- `src/docker/pty-session.ts` -- PTY session orchestration
- Container runs socat PTY command instead of sleep infinity
- Terminal resize via docker exec resize-pty.sh
- Escalation listener: `src/escalation/escalation-watcher.ts`
- Session registration in `~/.ironcurtain/pty-registry/`
