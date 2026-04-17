# Tool Call Coordinator & Pipeline

## Architecture (post-refactor)
- `src/trusted-process/tool-call-pipeline.ts` -- core security pipeline: `handleCallTool`, `extractTextFromContent`, `buildAuditEntry`, `validateToolArguments`, `buildToolMap`, `isUserContextTrusted`, all escalation/auto-approve logic, roots expansion. Single source of truth for policy evaluation.
- `src/trusted-process/tool-call-coordinator.ts` -- `ToolCallCoordinator` class; single host-side owner of PolicyEngine, AuditLog, CallCircuitBreaker, ApprovalWhitelist, ServerContextMap, auto-approve model, MCPClientManager. Wraps `handleCallTool` from the pipeline.
- `src/trusted-process/mcp-proxy-server.ts` -- thin subprocess: MCP transport + OAuth + sandbox wrapping + pass-through CallTool handler. NO policy evaluation, NO AuditLog, NO security kernel. Re-exports pipeline types for backward compat.
- `src/trusted-process/async-mutex.ts` -- `AsyncMutex` with `acquire()` and `withLock()`; FIFO fair, non-reentrant
- `src/sandbox/ironcurtain-protocol.ts` -- custom UTCP `CommunicationProtocol` with `call_template_type: 'ironcurtain'`
- Two mutexes on coordinator:
  - `callMutex`: serializes concurrent `handleToolCall` invocations
  - `policyMutex`: reserved for future `loadPolicy` swaps (Step 2)

## Subprocess is ALWAYS pass-through
- `PROXY_ROUTER_MODE` env var has been removed entirely
- `mcp-proxy-server.ts` always acts as a pure MCP relay: forwards CallTool to backend, returns raw result
- Still keeps OAuth injection, srt wrapping, stdio/UDS/TCP transport, virtual-proxy handling for `SERVER_FILTER=proxy`
- `MCPClientManager.getClientState(serverName)` returns the live `ClientState` (moved to `mcp-client-manager.ts`, re-exported from `tool-call-pipeline.ts`). Callers share this reference so `addRootToClient` mutates the same `roots` array the manager returns from its `roots/list` handler.

## Roots bridging across the relay subprocess (security-critical)
- Coordinator is authoritative for MCP roots. On escalation approval, `addRootToClient` pushes a root and calls `sendRootsListChanged()` on the manager's client → hits the relay's MCP Server.
- Relay's `setNotificationHandler(RootsListChangedNotificationSchema, ...)` fetches the new list via `server.listRoots()`, replaces a **single shared mutable `relayRoots` array** (each backend ClientState points at it), then calls `sendRootsListChanged()` on every backend client.
- Backend MCP servers re-query via `roots/list` on relay's client → relay's existing `ListRootsRequestSchema` handler returns the updated `relayRoots`.
- Initial roots for each relay connection come from `extractPolicyRoots`+`toMcpRoots` and are passed via `manager.connect(name, cfg, initialRoots)`. `buildCoordinator()` in `src/sandbox/index.ts` returns `{ coordinator, initialRoots }` so `connectBackendSubprocesses` can thread them through.
- Previous bug (fixed): relay never observed roots updates; backend stayed pinned to startup roots, so approved-but-outside-sandbox filesystem calls failed with "outside allowed directories".
- Regression test: `test/roots-expansion-bridging.integration.test.ts` (spawns real relay subprocess + real filesystem MCP).

## Key types (in tool-call-pipeline.ts)
- `CallToolDeps` -- injected dependencies for `handleCallTool`
- `CallToolDeps.onEscalation` (function): when set, supersedes file-IPC
- `CallToolDeps.escalationDir` (string path): file-IPC via `waitForEscalationDecision`
- `ToolCallResponse` -- MCP response with `_policyDecision?: PolicyDecision` internal-only field
- `ProxiedTool`, `ClientState` -- tool registry and MCP client state

## Sandbox wiring (`src/sandbox/index.ts`)
- `Sandbox.initialize()`:
  1. Registers the IronCurtain UTCP protocol (idempotent, also auto-registered at module load)
  2. Builds the coordinator (`buildCoordinator` helper)
  3. `bindCoordinatorToManual('tools', coordinator)` -- MUST happen before `registerManual`
  4. Spawns pass-through subprocesses via `connectBackendSubprocesses` using `coordinator.getMcpManager()`
  5. Registers one virtual UTCP manual (`registerManual({ name: 'tools', call_template_type: 'ironcurtain' })`)
- `Sandbox.shutdown()` calls `unbindCoordinatorFromManual` then `coordinator.close()`

## UTCP SDK Variable Substitutor gotcha (CRITICAL)
- `UtcpClient.registerManual()` calls `substituteCallTemplateVariables()` which deep-clones any object into a plain `{}`, losing class identity
- Solution: keep class instances in a module-level `Map<manualName, instance>` and look them up by name in the protocol's `registerManual`/`callTool`

## TrustedProcess changes
- `src/trusted-process/index.ts` wraps `ToolCallCoordinator` internally
- `TrustedProcess.handleToolCall` delegates to `coordinator.handleStructuredToolCall`
- In-process mode: `TrustedProcess` constructs its own `MCPClientManager` and injects it into the coordinator via `options.mcpManager`
