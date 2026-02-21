# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

IronCurtain is a secure agent runtime that mediates between an AI agent and MCP (Model Context Protocol) servers. Every tool call from the agent passes through a trusted process that evaluates it against policy rules (allow/deny/escalate) before routing to the real MCP server. This is a proof-of-concept implementation.

## Commands

- `ironcurtain start "your task"` — run the agent with a task (or `npm start "your task"` during development)
- `ironcurtain annotate-tools` — classify MCP tool arguments via LLM (or `npm run annotate-tools`)
- `ironcurtain compile-policy` — compile constitution into policy rules (or `npm run compile-policy`)
- `npm run build` — TypeScript compilation + copy config assets to `dist/`
- `npm test` — run all tests (vitest)
- `npx vitest run test/policy-engine.test.ts` — run a single test file
- `npx vitest run -t "denies delete_file"` — run a single test by name
- `npm run lint` — run ESLint

## Architecture

The system has four layers: **Agent → Code Mode Sandbox → MCP Proxy (Trusted Process) → MCP Servers**.

### Agent (`src/agent/`)
Uses Vercel AI SDK v6 (`ai` package) with Anthropic's Claude. The agent has a single `execute_code` tool that sends TypeScript to the Code Mode sandbox. Uses `stepCountIs()` for loop control (not `maxSteps`). The AI SDK v6 API uses `inputSchema` (not `parameters`), `stopWhen` (not `maxSteps`), and `toolCalls[].input` (not `.args`).

`tools.ts` provides a fallback direct-tool-call mode (used by integration tests) where MCP tools are bridged into AI SDK tools with `execute` functions routing through `TrustedProcess.handleToolCall()`. Tool names use `serverName__toolName` format.

### Sandbox (`src/sandbox/`)
UTCP Code Mode (`@utcp/code-mode`) provides a V8-isolated TypeScript execution environment. The LLM writes TypeScript that calls typed function stubs (e.g., `filesystem.read_file({path: '...'})`). These stubs produce MCP requests that exit the sandbox to the MCP proxy. Requires `@utcp/mcp` to be imported for the MCP call template type. Tool functions inside the sandbox are **synchronous** (no `await`).

### MCP Proxy Server (`src/trusted-process/mcp-proxy-server.ts`)
A standalone MCP server spawned by Code Mode as a child process. This is the security boundary. Uses the low-level `Server` class (not `McpServer`) to pass through raw JSON schemas. For each tool call: evaluates policy → forwards allowed calls to real MCP servers → logs to audit. In single-shot mode, escalations are auto-denied (no escalation handler). In interactive sessions, escalations are routed via file-based IPC for human approval through `/approve` or `/deny` commands.

**Sandbox Integration** (`sandbox-integration.ts`) — wraps sandboxed MCP servers in `srt` (sandbox-runtime CLI) processes for OS-level containment. Each sandboxed server gets its own `srt` process with independent proxy infrastructure for per-server network isolation. Uses `shell-quote` for safe command string construction. Sandbox-blocked operations are annotated with `[SANDBOX BLOCKED]` in MCP error responses. Config: `"sandbox": false` to opt out, omit for restrictive defaults (no network, session-dir-only writes), or specify `{ filesystem, network }` overrides. `sandboxPolicy: "enforce" | "warn"` controls behavior when bubblewrap/socat are unavailable.

### Trusted Process (`src/trusted-process/`)
The security kernel. Two modes of operation:
1. **Proxy mode** (`mcp-proxy-server.ts`) — standalone process for Code Mode. Has its own PolicyEngine and AuditLog instances.
2. **In-process mode** (`index.ts`) — `TrustedProcess` class used by integration tests and the direct-tool-call fallback. Orchestrates PolicyEngine, MCPClientManager, EscalationHandler, and AuditLog.

**PolicyEngine** (`policy-engine.ts`) — two-phase evaluation. Phase 1: structural invariants (hardcoded) — protected paths, unknown tool denial, and per-role sandbox containment. For mixed-path operations (e.g., `move_file` from sandbox to external), roles whose paths are all within the sandbox are resolved in Phase 1 and skipped in Phase 2. Phase 2: compiled declarative rules from `compiled-policy.json` — first match wins per role, most restrictive across roles. Multi-role arguments (e.g., `edit_file` with read-path + write-path) are evaluated independently per role; the most restrictive result wins (deny > escalate > allow).

**AutoApprover** (`auto-approver.ts`) — optional LLM-based intent matcher that can auto-approve escalations when the user's most recent message clearly authorizes the action. Uses a cheap model (default: Haiku 4.5), configurable via `autoApprove` in user config. Can only return `approve` or `escalate` (never deny). Runs in the proxy process; reads the user's message from `user-context.json` in the escalation directory (written by the session at the start of each turn). Errors fail-open to human escalation. Off by default.

**EscalationHandler** (`escalation.ts`) — CLI-based human approval for escalated requests. Can be overridden via `onEscalation` callback (used in tests).

**MCPClientManager** (`mcp-client-manager.ts`) — manages stdio-based MCP client connections.

**AuditLog** (`audit-log.ts`) — append-only JSONL logging.

### Policy Compilation Pipeline (`src/pipeline/`)
Two-command offline pipeline that produces generated artifacts in `src/config/generated/`:

1. **`npm run annotate-tools`** (`annotate.ts`) — Developer task. Connects to MCP servers, classifies tool arguments via LLM, writes **tool-annotations.json**. Only needs re-running when servers, tools, or the argument role registry change. Roles are filtered per-server via `serverNames` on `RoleDefinition`.
2. **`npm run compile-policy`** (`compile.ts`) — User task. Loads annotations from disk, compiles the constitution into **compiled-policy.json**, generates **test-scenarios.json**, and verifies via LLM judge. Requires `tool-annotations.json` to exist.

All artifacts use content-hash caching (`inputHash`) to skip unnecessary LLM calls. The LLM prompt text is included in the hash so template changes invalidate the cache. Artifacts are written to disk immediately after each step (not gated on verification). When verification fails, a compile-verify-repair loop feeds failures back to the compiler for targeted repair (up to 2 attempts). LLM interactions logged to `llm-interactions.jsonl`.

### Session (`src/session/`)
**ResourceBudgetTracker** (`resource-budget-tracker.ts`) — enforces per-session limits: tokens, steps, wall-clock time, estimated cost. Three enforcement points: StopCondition (between agent steps), AbortSignal (wall-clock timeout), pre-check in `execute_code`. Throws `BudgetExhaustedError` when any limit is exceeded. Configured via `resourceBudget` field in `~/.ironcurtain/config.json` (all fields nullable to disable individual limits). Defaults: 1M tokens, 200 steps, 30min, $5.

### Configuration (`src/config/`)
`loadConfig()` reads from environment variables (`ANTHROPIC_API_KEY`, `AUDIT_LOG_PATH`, `ALLOWED_DIRECTORY`) and `src/config/mcp-servers.json` for MCP server definitions. The `ALLOWED_DIRECTORY` defines the sandbox boundary for policy evaluation. In multi-turn sessions, each session gets its own sandbox at `~/.ironcurtain/sessions/{sessionId}/sandbox/`. The fallback default is `$IRONCURTAIN_HOME/sandbox` (where `IRONCURTAIN_HOME` defaults to `~/.ironcurtain`). Requires a `.env` file (loaded via `dotenv/config` in `src/index.ts`). `loadGeneratedPolicy()` loads compiled artifacts from `src/config/generated/`.

### Types (`src/types/`)
Shared types: `ToolCallRequest`/`ToolCallResult`/`PolicyDecision` in `mcp.ts`, `AuditEntry` in `audit.ts`. Policy decisions have three states: `allow`, `deny`, `escalate`.

## Key Conventions

- ESM modules throughout (`.js` extensions in imports, `"type": "module"` in package.json)
- TypeScript strict mode, target ES2022, Node16 module resolution
- Integration tests spawn real MCP server processes (`@modelcontextprotocol/server-filesystem`) — they need ~30s timeout and create/clean up temp directories in `/tmp/`
- The policy engine uses symlink-aware `resolveRealPath()` (from `src/types/argument-roles.ts`) to normalize paths before directory containment checks — both path traversal and symlink-escape attacks are neutralized by resolving to canonical real paths before comparison
