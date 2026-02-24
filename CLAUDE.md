# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

IronCurtain is a secure agent runtime that mediates between an AI agent and MCP (Model Context Protocol) servers. Every tool call from the agent passes through a trusted process that evaluates it against policy rules (allow/deny/escalate) before routing to the real MCP server. This is a proof-of-concept implementation.

## Commands

- `ironcurtain start "your task"` - run the agent with a task (or `npm start "your task"` during development)
- `ironcurtain config` - interactively edit `~/.ironcurtain/config.json` (or `npm run config`)
- `ironcurtain annotate-tools` - classify MCP tool arguments via LLM (or `npm run annotate-tools`)
- `ironcurtain compile-policy` - compile constitution into policy rules (or `npm run compile-policy`)
- `ironcurtain refresh-lists [--list <name>] [--with-mcp]` - re-resolve dynamic lists without full recompilation
- `npm run build` - TypeScript compilation + copy config assets to `dist/`
- `npm test` - run all tests (vitest)
- `npm test -- test/policy-engine.test.ts` - run a single test file
- `npm test -- -t "denies delete_file"` - run a single test by name
- `npm run lint` - run ESLint
- `npm run format` - format code with Prettier (`format:check` for CI validation)

## Architecture

IronCurtain has two session modes. **Code Mode** (builtin agent) runs LLM-generated TypeScript in a V8 sandbox - IronCurtain controls the agent, the sandbox, and the policy engine. **Docker Agent Mode** runs an external agent (Claude Code, etc.) in a Docker container with `--network=none` - IronCurtain doesn't control the agent, it only mediates external access through host-side proxies.

### Code Mode: Agent (`src/agent/`)
Uses Vercel AI SDK v6 (`ai` package) with Anthropic's Claude. The agent has a single `execute_code` tool that sends TypeScript to the Code Mode sandbox. Uses `stepCountIs()` for loop control (not `maxSteps`). The AI SDK v6 API uses `inputSchema` (not `parameters`), `stopWhen` (not `maxSteps`), and `toolCalls[].input` (not `.args`).

`tools.ts` provides a fallback direct-tool-call mode (used by integration tests) where MCP tools are bridged into AI SDK tools with `execute` functions routing through `TrustedProcess.handleToolCall()`. Tool names use `serverName__toolName` format.

### Code Mode: Sandbox (`src/sandbox/`)
UTCP Code Mode (`@utcp/code-mode`) provides a V8-isolated TypeScript execution environment. The LLM writes TypeScript that calls typed function stubs (e.g., `filesystem.read_file({path: '...'})`). These stubs produce MCP requests that exit the sandbox to the MCP proxy. Requires `@utcp/mcp` to be imported for the MCP call template type. Tool functions inside the sandbox are **synchronous** (no `await`).

### Trusted Process (`src/trusted-process/`)
The security kernel - MCP proxy server, PolicyEngine (two-phase default-deny evaluation), AutoApprover, EscalationHandler, and AuditLog. See [`src/trusted-process/CLAUDE.md`](src/trusted-process/CLAUDE.md) for details.

### Policy Compilation Pipeline (`src/pipeline/`)
Two-command offline pipeline (`annotate-tools` + `compile-policy`) that produces generated artifacts with content-hash caching and dynamic list resolution. See [`src/pipeline/CLAUDE.md`](src/pipeline/CLAUDE.md) for details.

### Session (`src/session/`)
**ResourceBudgetTracker** (`resource-budget-tracker.ts`) - enforces per-session limits: tokens, steps, wall-clock time, estimated cost. Three enforcement points: StopCondition (between agent steps), AbortSignal (wall-clock timeout), pre-check in `execute_code`. Throws `BudgetExhaustedError` when any limit is exceeded. Configured via `resourceBudget` field in `~/.ironcurtain/config.json` (all fields nullable to disable individual limits). Defaults: 1M tokens, 200 steps, 30min, $5.

### Docker Agent Mode (`src/docker/`)
Runs external agents in Docker containers with `--network=none`, communicating via UDS-mounted MITM and MCP proxies. Real API keys never enter the container - fake sentinel keys are swapped host-side. See [`src/docker/CLAUDE.md`](src/docker/CLAUDE.md) for details.

### Configuration (`src/config/`)
**Interactive Config Editor** (`config-command.ts`) - `ironcurtain config` subcommand. Uses `@clack/prompts` for a terminal UI to view and modify `~/.ironcurtain/config.json`. Covers models, security settings, resource budgets, and auto-compaction. API keys are excluded (use env vars). Changes are tracked as a partial `UserConfig`, diffed against the resolved config, and saved via `saveUserConfig()`.

`loadConfig()` reads from environment variables (`ANTHROPIC_API_KEY`, `AUDIT_LOG_PATH`, `ALLOWED_DIRECTORY`) and `src/config/mcp-servers.json` for MCP server definitions. The `ALLOWED_DIRECTORY` defines the sandbox boundary for policy evaluation. In multi-turn sessions, each session gets its own sandbox at `~/.ironcurtain/sessions/{sessionId}/sandbox/`. The fallback default is `$IRONCURTAIN_HOME/sandbox` (where `IRONCURTAIN_HOME` defaults to `~/.ironcurtain`). Requires a `.env` file (loaded via `dotenv/config` in `src/index.ts`). `loadGeneratedPolicy()` loads compiled artifacts (`compiled-policy.json`, `tool-annotations.json`, and optionally `dynamic-lists.json`) from `src/config/generated/`.

### Types (`src/types/`)
Shared types: `ToolCallRequest`/`ToolCallResult`/`PolicyDecision` in `mcp.ts`, `AuditEntry` in `audit.ts`. Policy decisions have three outcomes: `allow`, `deny`, `escalate`. The engine can produce all three, but compiled rules only use `allow` and `escalate` - `deny` comes from the default fallthrough when no rule matches.

## Key Conventions

- ESM modules throughout (`.js` extensions in imports, `"type": "module"` in package.json)
- TypeScript strict mode, target ES2022, Node16 module resolution
- Integration tests spawn real MCP server processes (`@modelcontextprotocol/server-filesystem`) - they need ~30s timeout and create/clean up temp directories in `/tmp/`
- The policy engine uses symlink-aware `resolveRealPath()` (from `src/types/argument-roles.ts`) to normalize paths before directory containment checks - both path traversal and symlink-escape attacks are neutralized by resolving to canonical real paths before comparison
