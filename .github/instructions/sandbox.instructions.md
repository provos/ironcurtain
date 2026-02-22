---
applyTo: "src/sandbox/**"
---

# Sandbox Review Rules

The sandbox registers MCP proxy servers with UTCP Code Mode. It is the integration point between the agent's V8 isolate and the security boundary.

## Mandatory Checks

- The sandbox MUST register the MCP proxy server (`mcp-proxy-server.ts`), never a real MCP server directly. Registering real servers bypasses the entire policy engine.
- `PROXY_COMMAND` and `PROXY_ARGS` must resolve to `mcp-proxy-server.ts` (or its compiled `.js` equivalent). Verify no changes point to other server scripts.
- Each backend MCP server must get its own proxy instance via `SERVER_FILTER` env var. This ensures credential isolation -- each proxy only receives its own server's credentials.
- The `Protocol.request` timeout monkey-patch must execute before `CodeModeUtcpClient.create()`. Moving it later leaves client instances with the wrong timeout.
- Tool functions inside the sandbox are synchronous. Do not add `await` to sandbox tool calls.
- `@utcp/mcp` must be imported (side-effect import) to register the MCP call template type. Removing this import breaks MCP functionality.
