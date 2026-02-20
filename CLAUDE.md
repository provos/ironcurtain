# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

IronCurtain is a secure agent runtime that mediates between an AI agent and MCP (Model Context Protocol) servers. Every tool call from the agent passes through a trusted process that evaluates it against policy rules (allow/deny/escalate) before routing to the real MCP server. This is a proof-of-concept implementation.

## Commands

- `npm test` — run all tests (vitest)
- `npx vitest run test/policy-engine.test.ts` — run a single test file
- `npx vitest run -t "denies delete_file"` — run a single test by name
- `npm run lint` — run ESLint
- `npm start "your task"` — run the agent with a task (requires `ANTHROPIC_API_KEY` in `.env` or environment)

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

**EscalationHandler** (`escalation.ts`) — CLI-based human approval for escalated requests. Can be overridden via `onEscalation` callback (used in tests).

**MCPClientManager** (`mcp-client-manager.ts`) — manages stdio-based MCP client connections.

**AuditLog** (`audit-log.ts`) — append-only JSONL logging.

### Policy Compilation Pipeline (`src/pipeline/`)
Offline pipeline (`npm run compile-policy`) that produces generated artifacts in `src/config/generated/`:
- **tool-annotations.json** — LLM-classified tool capabilities (argument roles: read-path, write-path, delete-path, none)
- **compiled-policy.json** — declarative rules compiled from `src/config/constitution.md` via LLM
- **test-scenarios.json** — LLM-generated + handwritten test scenarios

All artifacts use content-hash caching (`inputHash`) to skip unnecessary LLM calls. The LLM prompt text is included in the hash so template changes invalidate the cache. Artifacts are written to disk immediately after each step (not gated on verification). When verification fails, a compile-verify-repair loop feeds failures back to the compiler for targeted repair (up to 2 attempts). LLM interactions logged to `llm-interactions.jsonl`.

### Configuration (`src/config/`)
`loadConfig()` reads from environment variables (`ANTHROPIC_API_KEY`, `AUDIT_LOG_PATH`, `ALLOWED_DIRECTORY`) and `src/config/mcp-servers.json` for MCP server definitions. The `ALLOWED_DIRECTORY` defines the sandbox boundary for policy evaluation. In multi-turn sessions, each session gets its own sandbox at `~/.ironcurtain/sessions/{sessionId}/sandbox/`. The fallback default is `$IRONCURTAIN_HOME/sandbox` (where `IRONCURTAIN_HOME` defaults to `~/.ironcurtain`). Requires a `.env` file (loaded via `dotenv/config` in `src/index.ts`). `loadGeneratedPolicy()` loads compiled artifacts from `src/config/generated/`.

### Types (`src/types/`)
Shared types: `ToolCallRequest`/`ToolCallResult`/`PolicyDecision` in `mcp.ts`, `AuditEntry` in `audit.ts`. Policy decisions have three states: `allow`, `deny`, `escalate`.

## Key Conventions

- ESM modules throughout (`.js` extensions in imports, `"type": "module"` in package.json)
- TypeScript strict mode, target ES2022, Node16 module resolution
- Integration tests spawn real MCP server processes (`@modelcontextprotocol/server-filesystem`) — they need ~30s timeout and create/clean up temp directories in `/tmp/`
- The policy engine uses symlink-aware `resolveRealPath()` (from `src/types/argument-roles.ts`) to normalize paths before directory containment checks — both path traversal and symlink-escape attacks are neutralized by resolving to canonical real paths before comparison
