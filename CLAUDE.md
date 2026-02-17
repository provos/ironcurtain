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

The system has three layers connected in a pipeline: **Agent → Trusted Process → MCP Servers**.

### Agent (`src/agent/`)
Uses Vercel AI SDK (`ai` package) with Anthropic's Claude to run an agentic loop. `tools.ts` bridges MCP tools into AI SDK `CoreTool` objects — each tool's `execute` function sends a `ToolCallRequest` to the trusted process instead of calling MCP directly. Tool names are prefixed with the server name (e.g., `filesystem__read_file`).

### Trusted Process (`src/trusted-process/`)
The security kernel. `TrustedProcess` orchestrates the full request lifecycle:
1. **PolicyEngine** (`policy-engine.ts`) — evaluates requests against an ordered rule chain. First matching rule wins. Rules: protect structural files → deny deletes → allow reads in sandbox → deny reads outside → allow writes in sandbox → escalate writes outside → default deny.
2. **EscalationHandler** (`escalation.ts`) — CLI-based human approval prompt for escalated requests. Can be overridden via `onEscalation` callback (used in tests).
3. **MCPClientManager** (`mcp-client-manager.ts`) — manages stdio-based MCP client connections. Connects to MCP servers defined in `src/config/mcp-servers.json`.
4. **AuditLog** (`audit-log.ts`) — append-only JSONL logging of every request, policy decision, and result.

### Configuration (`src/config/`)
`loadConfig()` reads from environment variables (`ANTHROPIC_API_KEY`, `AUDIT_LOG_PATH`, `ALLOWED_DIRECTORY`) and `src/config/mcp-servers.json` for MCP server definitions. The `ALLOWED_DIRECTORY` (default `/tmp/ironcurtain-sandbox`) defines the sandbox boundary for policy evaluation.

### Types (`src/types/`)
Shared types: `ToolCallRequest`/`ToolCallResult`/`PolicyDecision` in `mcp.ts`, `AuditEntry` in `audit.ts`. Policy decisions have three states: `allow`, `deny`, `escalate`.

## Key Conventions

- ESM modules throughout (`.js` extensions in imports, `"type": "module"` in package.json)
- TypeScript strict mode, target ES2022, Node16 module resolution
- Integration tests spawn real MCP server processes (`@modelcontextprotocol/server-filesystem`) — they need ~30s timeout and create/clean up temp directories in `/tmp/`
- The policy engine uses `node:path.resolve()` to normalize paths before directory containment checks — path traversal attacks are handled by resolving before comparison
