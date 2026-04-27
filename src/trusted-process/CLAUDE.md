# Trusted Process (`src/trusted-process/`)

## Overview

The security kernel of IronCurtain. Every tool call from the agent passes through this layer for policy evaluation, audit logging, and routing to real MCP servers.

**`ToolCallCoordinator`** (`tool-call-coordinator.ts`) — centralizes all security-kernel components as single instances: PolicyEngine, AuditLog, CallCircuitBreaker, ApprovalWhitelist, AutoApprover, and ServerContextMap. Instantiated once per session in the Sandbox/CodeModeProxy layer. Two mutexes serialize concurrent access: a call mutex (protects RMW caches during `handleToolCall`) and a policy mutex (taken by `loadPolicy` to swap the active `PolicyEngine` between workflow states). A `currentPersona` field tracks the persona that installed the active policy; the security pipeline stamps it onto every `AuditEntry`.

**`tool-call-pipeline.ts`** — the security pipeline. Contains `handleCallTool` and all helpers: argument validation, `prepareToolArgs` normalization, git enrichment, policy evaluation, escalation flow, audit write, circuit breaker check, and `ServerContext` post-success update.

**`mcp-proxy-server.ts`** — pure MCP relay subprocess. Spawned per-backend-server by `MCPClientManager`. Handles OAuth credential injection, sandbox-runtime wrapping, and stdio MCP transport. Forwards `CallTool` requests to the real backend and returns raw results. No policy evaluation, no audit writes, no escalation handling. Bridges roots: when the coordinator sends `notifications/roots/list_changed`, the relay fetches the new list via `server.listRoots()`, updates the shared `relayRoots` array, and forwards the notification to each backend client so they re-query.

**`TrustedProcess`** (`index.ts`) — thin wrapper around `ToolCallCoordinator` used by integration tests and the direct-tool-call fallback.

**`ControlServer`** (`control-server.ts`) — small HTTP server bound to a Unix domain socket (or loopback TCP) that exposes `POST /__ironcurtain/policy/load`. The workflow orchestrator hits this endpoint between agent states to hot-swap the coordinator's active `PolicyEngine` and `currentPersona` via `ToolCallCoordinator.loadPolicy({persona, policyDir})`. The control server only runs in workflow shared-container mode; `DockerProxy.getPolicySwapTarget()` is the narrow seam that exposes `startControlServer(opts)` without leaking the rest of the coordinator. Single-session CLI / daemon / cron paths never construct it. See [`docs/designs/workflow-container-lifecycle.md`](../../docs/designs/workflow-container-lifecycle.md).

## Policy Engine

**PolicyEngine** (`policy-engine.ts`) - two-phase evaluation with default-deny:

- **Structural invariants** (hardcoded): protected paths, unknown tool denial, per-role sandbox containment, and domain allowlist checks for URL-role args.
- **Compiled rules**: declarative rules from `compiled-policy.json` (allow/escalate only; deny is the default when no rule matches). Each role is evaluated independently; the most restrictive result across roles wins (deny > escalate > allow).

The annotation map stores `StoredToolAnnotation` (may contain conditional role specs for multi-mode tools). `resolveStoredAnnotation()` resolves conditionals against call arguments, producing a plain `ToolAnnotation`. `getAnnotation(server, tool, callArgs)` returns the resolved annotation; `getStoredAnnotation()` provides raw access for pipeline tools.

**Supporting modules:**

- `policy-types.ts` - `EvaluationResult` type with `escalatedRoles` for whitelist candidate extraction.
- `policy-roots.ts` - `extractPolicyRoots()` derives MCP Roots from `allow`/`escalate` rules with `paths.within` conditions. `extractRequiredServers()` derives the set of MCP server names referenced by the compiled policy; the standalone session path and the workflow infrastructure factory both use it to skip spawning proxy subprocesses for unreferenced servers (default-deny would reject every call to them anyway).
- `domain-utils.ts` - domain matching (`domainMatchesAllowlist`, `isIpAddress`), URL normalization, git remote resolution. Shared by the engine and dynamic list type registry.
- `path-utils.ts` - annotation-driven path normalization via `prepareToolArgs()`, producing separate `argsForTransport` and `argsForPolicy`.

## Approval & Escalation

**ApprovalWhitelist** (`approval-whitelist.ts`) - session-scoped in-memory store of approval patterns extracted from user-approved escalations. Only converts `escalate` to `allow`, never overrides `deny`. Entries are never persisted to disk. Constraints are typed by kind: `directory`, `domain`, or `exact`.

**AutoApprover** (`auto-approver.ts`) - optional LLM-based intent matcher that auto-approves escalations when the user's message clearly authorizes the action. Uses a cheap model (default: Haiku 4.5), configurable via `autoApprove` in user config. Can only return `approve` or `escalate` (never deny). Off by default.

**EscalationHandler** (`escalation.ts`) - CLI-based human approval for escalated requests. Can be overridden via `onEscalation` callback (used in tests).

**ServerContext** (`server-context.ts`) - tracks per-server state (e.g., git working directory) from successful tool calls to enrich escalation requests for human reviewers.

**Atomic file writes:** All file writes in the escalation IPC protocol use `atomicWriteJsonSync()` from `src/escalation/escalation-watcher.ts` (write to `.tmp`, then rename).

## MCP Client & Transport

**MCPClientManager** (`mcp-client-manager.ts`) - manages stdio-based MCP client connections. Unavailable servers are logged as warnings and skipped gracefully.

**CallCircuitBreaker** (`call-circuit-breaker.ts`) - centralized rate limiter managed by the ToolCallCoordinator. Denies repeated identical (tool, argsHash) calls exceeding a sliding-window threshold (default: 20 calls per 60s). Runs after policy evaluation so every call is audited.

**Transport layers** for Docker Agent Mode:

- `uds-server-transport.ts` - Unix domain socket transport (Linux containers with bind mounts).
- `tcp-server-transport.ts` - TCP transport (macOS Docker Desktop where VirtioFS does not support UDS in bind mounts).

**PermissiveOutputValidator** (`permissive-output-validator.ts`) - bypasses MCP SDK client-side `structuredContent` schema validation. IronCurtain proxies responses as-is, so strict validation would hide real error messages from servers that return non-conforming error content.

**MCP error handling** (`mcp-error-utils.ts`) - `extractMcpErrorMessage()` digs into schema validation error `data` to surface the original server error.

## Audit

**AuditLog** (`audit-log.ts`) - append-only JSONL logging with PII/credential redaction enabled by default (`audit-redactor.ts`). Masks credit cards (Luhn-validated), SSNs, and API keys. Disable with `auditRedaction.enabled: false`. The audit file is fixed at coordinator construction; workflows produce a single `audit.jsonl` per run and `loadPolicy` does not rotate it — each `AuditEntry` carries a `persona` field instead, so per-persona slices are reconstructed by scanning. Stream errors latch and surface synchronously on the next `log()` call.

## Sandbox & Credentials

**Sandbox Integration** (`sandbox-integration.ts`) - wraps sandboxed MCP servers in `srt` (sandbox-runtime CLI) processes for OS-level containment. Each sandboxed server gets its own `srt` process with per-server network isolation. Config: `"sandbox": false` to opt out, omit for restrictive defaults, or specify `{ filesystem, network }` overrides. `sandboxPolicy: "enforce" | "warn"` controls behavior when bubblewrap/socat are unavailable.

**Google Workspace credentials** (`gworkspace-credentials.ts`) - writes OAuth credential files for `@alanse/mcp-server-google-workspace`. Intentionally omits `refresh_token` to prevent token rotation races; IronCurtain's OAuthTokenProvider is the sole token authority.

**TokenFileRefresher** (`token-file-refresher.ts`) - proactive OAuth credential file refresher running in the proxy process. Periodically checks token expiry and writes fresh files before access tokens expire (default: check every 5 min, refresh at 10 min before expiry).

## Tool Description Hints

**ToolDescriptionHints** (`tool-description-hints.ts`) - loads hints from `src/config/tool-description-hints.json` and appends them to proxied tool descriptions. Helps agents use MCP tool parameters correctly (e.g., avoiding CLI flags in structured parameters).
