# MCP Proxy Server & Trusted Process (`src/trusted-process/`)

## MCP Proxy Server (`mcp-proxy-server.ts`)

A standalone MCP server spawned by Code Mode as a child process. This is the security boundary. Uses the low-level `Server` class (not `McpServer`) to pass through raw JSON schemas. For each tool call: evaluates policy → forwards allowed calls to real MCP servers → logs to audit. In single-shot mode, escalations are auto-denied (no escalation handler). In interactive sessions, escalations are routed via file-based IPC for human approval through `/approve` or `/deny` commands.

**Sandbox Integration** (`sandbox-integration.ts`) - wraps sandboxed MCP servers in `srt` (sandbox-runtime CLI) processes for OS-level containment. Each sandboxed server gets its own `srt` process with independent proxy infrastructure for per-server network isolation. Uses `shell-quote` for safe command string construction. Sandbox-blocked operations are annotated with `[SANDBOX BLOCKED]` in MCP error responses. Config: `"sandbox": false` to opt out, omit for restrictive defaults (no network, session-dir-only writes), or specify `{ filesystem, network }` overrides. `sandboxPolicy: "enforce" | "warn"` controls behavior when bubblewrap/socat are unavailable.

## Trusted Process

The security kernel. Two modes of operation:
1. **Proxy mode** (`mcp-proxy-server.ts`) - standalone process for Code Mode. Has its own PolicyEngine and AuditLog instances.
2. **In-process mode** (`index.ts`) - `TrustedProcess` class used by integration tests and the direct-tool-call fallback. Orchestrates PolicyEngine, MCPClientManager, EscalationHandler, and AuditLog.

**PolicyEngine** (`policy-engine.ts`) - two-phase evaluation with default-deny. Structural checks: structural invariants (hardcoded) - protected paths, unknown tool denial, and per-role sandbox containment. For mixed-path operations (e.g., `move_file` from sandbox to external), roles whose paths are all within the sandbox are resolved during structural checks and skipped during compiled rule evaluation. Compiled rule evaluation: compiled declarative rules from `compiled-policy.json` - rules are allow/escalate only (deny is the default when no rule matches). Each role is evaluated independently; path extraction is scoped to the evaluating role so different roles can be discharged by different rules (e.g., a move from Downloads to Documents where read-path/delete-path match a Downloads rule and write-path matches a Documents rule). The most restrictive result across roles wins (deny > escalate > allow).

**AutoApprover** (`auto-approver.ts`) - optional LLM-based intent matcher that can auto-approve escalations when the user's most recent message clearly authorizes the action. Uses a cheap model (default: Haiku 4.5), configurable via `autoApprove` in user config. Can only return `approve` or `escalate` (never deny). Runs in the proxy process; reads the user's message from `user-context.json` in the escalation directory (written by the session at the start of each turn). Errors fail-open to human escalation. Off by default.

**EscalationHandler** (`escalation.ts`) - CLI-based human approval for escalated requests. Can be overridden via `onEscalation` callback (used in tests).

**MCPClientManager** (`mcp-client-manager.ts`) - manages stdio-based MCP client connections. Connection failures are graceful: unavailable servers (e.g., Docker not running for the GitHub server) are logged as warnings and skipped, allowing the session to proceed with whatever servers connected successfully.

**AuditLog** (`audit-log.ts`) - append-only JSONL logging with optional PII/credential redaction (`audit-redactor.ts`). When `auditRedaction.enabled` is true, masks credit cards, SSNs, and API keys in tool arguments and results before writing.
