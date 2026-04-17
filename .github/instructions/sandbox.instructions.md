---
applyTo: "src/sandbox/**"
---

# Sandbox Review Rules

The sandbox registers a custom UTCP communication protocol (`ironcurtain-protocol.ts`) that routes tool calls in-process to the `ToolCallCoordinator`. It is the integration point between the agent's V8 isolate and the security boundary.

## Mandatory Checks

- The sandbox MUST route tool calls through the `ToolCallCoordinator` via the custom IronCurtain UTCP protocol (`ironcurtain-protocol.ts`). Never register real MCP servers directly with UTCP — that bypasses the entire policy engine.
- MCP proxy subprocesses (`mcp-proxy-server.ts`) are pure relay transports spawned by `MCPClientManager`. Security is enforced upstream in the coordinator, not in the proxy. `PROXY_COMMAND` and `PROXY_ARGS` still exist for starting relay subprocesses.
- Each backend MCP server gets its own relay subprocess via `SERVER_FILTER` env var. This ensures credential isolation (OAuth tokens, sandbox-runtime wrapping).
- The per-sandbox unique manual name (e.g., `tools_<uuid>`) in the UTCP registration prevents cross-sandbox collision when multiple sandboxes run in the same process (daemon mode). Never hardcode the manual name.
- The `Protocol.request` timeout monkey-patch must execute before `CodeModeUtcpClient.create()`. Moving it later leaves client instances with the wrong timeout.
- Tool functions inside the sandbox are synchronous. Do not add `await` to sandbox tool calls.
- `@utcp/mcp` must be imported (side-effect import) to register the MCP call template type. Removing this import breaks MCP functionality.
