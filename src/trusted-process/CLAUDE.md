# MCP Proxy Server & Trusted Process (`src/trusted-process/`)

## Overview

The security kernel of IronCurtain. Every tool call from the agent passes through this layer for policy evaluation, audit logging, and routing to real MCP servers. Two modes of operation:

1. **Proxy mode** (`mcp-proxy-server.ts`) - standalone MCP server process for Code Mode. Has its own PolicyEngine, AuditLog, and approval whitelist instances. Uses the low-level `Server` class (not `McpServer`) to pass through raw JSON schemas. In single-shot mode, escalations are auto-denied. In interactive sessions, escalations are routed via file-based IPC for human approval.
2. **In-process mode** (`index.ts`) - `TrustedProcess` class used by integration tests and the direct-tool-call fallback. Orchestrates PolicyEngine, MCPClientManager, EscalationHandler, and AuditLog.

## Policy Engine

**PolicyEngine** (`policy-engine.ts`) - two-phase evaluation with default-deny:
- **Structural invariants** (hardcoded): protected paths, unknown tool denial, per-role sandbox containment, and domain allowlist checks for URL-role args.
- **Compiled rules**: declarative rules from `compiled-policy.json` (allow/escalate only; deny is the default when no rule matches). Each role is evaluated independently; the most restrictive result across roles wins (deny > escalate > allow).

The annotation map stores `StoredToolAnnotation` (may contain conditional role specs for multi-mode tools). `resolveStoredAnnotation()` resolves conditionals against call arguments, producing a plain `ToolAnnotation`. `getAnnotation(server, tool, callArgs)` returns the resolved annotation; `getStoredAnnotation()` provides raw access for pipeline tools.

**Supporting modules:**
- `policy-types.ts` - `EvaluationResult` type with `escalatedRoles` for whitelist candidate extraction.
- `policy-roots.ts` - `extractPolicyRoots()` derives MCP Roots from `allow`/`escalate` rules with `paths.within` conditions.
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

**CallCircuitBreaker** (`call-circuit-breaker.ts`) - proxy-level rate limiter. Denies repeated identical (tool, argsHash) calls exceeding a sliding-window threshold (default: 20 calls per 60s). Runs after policy evaluation so every call is audited.

**Transport layers** for Docker Agent Mode:
- `uds-server-transport.ts` - Unix domain socket transport (Linux containers with bind mounts).
- `tcp-server-transport.ts` - TCP transport (macOS Docker Desktop where VirtioFS does not support UDS in bind mounts).

**PermissiveOutputValidator** (`permissive-output-validator.ts`) - bypasses MCP SDK client-side `structuredContent` schema validation. IronCurtain proxies responses as-is, so strict validation would hide real error messages from servers that return non-conforming error content.

**MCP error handling** (`mcp-error-utils.ts`) - `extractMcpErrorMessage()` digs into schema validation error `data` to surface the original server error.

## Audit

**AuditLog** (`audit-log.ts`) - append-only JSONL logging with PII/credential redaction enabled by default (`audit-redactor.ts`). Masks credit cards (Luhn-validated), SSNs, and API keys. Disable with `auditRedaction.enabled: false`.

## Sandbox & Credentials

**Sandbox Integration** (`sandbox-integration.ts`) - wraps sandboxed MCP servers in `srt` (sandbox-runtime CLI) processes for OS-level containment. Each sandboxed server gets its own `srt` process with per-server network isolation. Config: `"sandbox": false` to opt out, omit for restrictive defaults, or specify `{ filesystem, network }` overrides. `sandboxPolicy: "enforce" | "warn"` controls behavior when bubblewrap/socat are unavailable.

**Google Workspace credentials** (`gworkspace-credentials.ts`) - writes OAuth credential files for `@alanse/mcp-server-google-workspace`. Intentionally omits `refresh_token` to prevent token rotation races; IronCurtain's OAuthTokenProvider is the sole token authority.

**TokenFileRefresher** (`token-file-refresher.ts`) - proactive OAuth credential file refresher running in the proxy process. Periodically checks token expiry and writes fresh files before access tokens expire (default: check every 5 min, refresh at 10 min before expiry).

## Tool Description Hints

**ToolDescriptionHints** (`tool-description-hints.ts`) - loads hints from `src/config/tool-description-hints.json` and appends them to proxied tool descriptions. Helps agents use MCP tool parameters correctly (e.g., avoiding CLI flags in structured parameters).
