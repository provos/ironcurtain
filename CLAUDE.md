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
A standalone MCP server spawned by Code Mode as a child process. This is the security boundary. Uses the low-level `Server` class (not `McpServer`) to pass through raw JSON schemas. For each tool call: evaluates policy → forwards allowed calls to real MCP servers → logs to audit. Escalations are auto-denied in proxy mode (no stdin access for CLI prompts).

### Trusted Process (`src/trusted-process/`)
The security kernel. Two modes of operation:
1. **Proxy mode** (`mcp-proxy-server.ts`) — standalone process for Code Mode. Has its own PolicyEngine and AuditLog instances.
2. **In-process mode** (`index.ts`) — `TrustedProcess` class used by integration tests and the direct-tool-call fallback. Orchestrates PolicyEngine, MCPClientManager, EscalationHandler, and AuditLog.

**PolicyEngine** (`policy-engine.ts`) — evaluates requests against an ordered rule chain. First matching rule wins. Rules: protect structural files → deny deletes → allow reads in sandbox → deny reads outside → allow writes in sandbox → escalate writes outside → default deny.

**EscalationHandler** (`escalation.ts`) — CLI-based human approval for escalated requests. Can be overridden via `onEscalation` callback (used in tests).

**MCPClientManager** (`mcp-client-manager.ts`) — manages stdio-based MCP client connections.

**AuditLog** (`audit-log.ts`) — append-only JSONL logging.

### Configuration (`src/config/`)
`loadConfig()` reads from environment variables (`ANTHROPIC_API_KEY`, `AUDIT_LOG_PATH`, `ALLOWED_DIRECTORY`) and `src/config/mcp-servers.json` for MCP server definitions. The `ALLOWED_DIRECTORY` (default `/tmp/ironcurtain-sandbox`) defines the sandbox boundary for policy evaluation. Requires a `.env` file (loaded via `dotenv/config` in `src/index.ts`).

### Types (`src/types/`)
Shared types: `ToolCallRequest`/`ToolCallResult`/`PolicyDecision` in `mcp.ts`, `AuditEntry` in `audit.ts`. Policy decisions have three states: `allow`, `deny`, `escalate`.

## Key Conventions

- ESM modules throughout (`.js` extensions in imports, `"type": "module"` in package.json)
- TypeScript strict mode, target ES2022, Node16 module resolution
- Integration tests spawn real MCP server processes (`@modelcontextprotocol/server-filesystem`) — they need ~30s timeout and create/clean up temp directories in `/tmp/`
- The policy engine uses `node:path.resolve()` to normalize paths before directory containment checks — path traversal attacks are handled by resolving before comparison
