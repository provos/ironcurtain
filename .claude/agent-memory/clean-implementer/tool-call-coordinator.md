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
- `MCPClientManager` has `getClient(serverName)` and `getRoots(serverName)` so the coordinator can wire an existing client into a `ClientState` for the pipeline's escalation/root-expansion path

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
