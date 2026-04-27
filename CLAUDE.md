# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## General Workflow

When asked to find a file or document, ask the user for the path after one failed search attempt rather than spending many tool calls searching.

## Git & Worktrees

When working with git worktrees, always verify the current working directory before making changes. Run `pwd` and confirm the target worktree path before any edits.

## Git Workflow

Always stage and verify all relevant files before committing. Run `git status` before `git commit` to confirm nothing is missing.

## Platform Considerations

When fixing bugs or implementing features for cross-platform code (macOS/Linux/Docker), ensure changes are scoped to the correct platform and do not break other platforms. Always ask if unsure.

## Safe Coding

- **No shell string concatenation.** Never use `child_process.exec()` or build command strings by concatenating/interpolating untrusted values. Always use `spawn()`/`execFile()` with argument arrays so the OS handles escaping. Untrusted values must only appear in the args array, never in the command string itself.
- **Encapsulate risky operations.** Security-critical operations (path resolution, credential handling, Docker command construction) must live in dedicated modules with safe public APIs. Application code should call the safe abstraction, not reimplement the logic inline.

## Project Overview

IronCurtain is a secure agent runtime that mediates between an AI agent and MCP (Model Context Protocol) servers. Every tool call from the agent passes through a trusted process that evaluates it against policy rules (allow/deny/escalate) before routing to the real MCP server. This is a proof-of-concept implementation.

## Commands

- `ironcurtain start "your task"` - run the agent with a task (or `npm start "your task"` during development)
- `ironcurtain start -w ./path "task"` - run the agent in an existing directory instead of a fresh sandbox
- `ironcurtain config` - interactively edit `~/.ironcurtain/config.json` (or `npm run config`)
- `ironcurtain annotate-tools --server <name>` - classify MCP tool arguments via LLM for a single server (or `npm run annotate-tools -- --server <name>`). Use `--all` to annotate all servers.
- `ironcurtain compile-policy` - compile constitution into policy rules (or `npm run compile-policy`). Supports `--constitution <path>`, `--output-dir <path>`, and `--server <name>` flags for alternative constitutions, output directories, and single-server debugging. The read-only policy is compiled via `npm run compile-policy -- --no-mcp --constitution src/config/constitution-readonly.md --output-dir src/config/generated-readonly`.
- `ironcurtain refresh-lists [--list <name>] [--with-mcp]` - re-resolve dynamic lists without full recompilation
- `ironcurtain workflow list` - list available workflow definitions
- `ironcurtain workflow start <name-or-path> "task" [--model <model>] [--workspace <path>]` - run a multi-agent workflow
- `ironcurtain workflow resume <baseDir> [--state <stateName>]` - resume a checkpointed workflow
- `ironcurtain workflow inspect <baseDir> [--all]` - inspect workflow status and message log
- `ironcurtain daemon --web-ui` - start daemon with web UI (opens on port 7400, prints auth URL to stderr)
- `npm run build` - TypeScript compilation + copy config assets + web UI to `dist/`
- `npm run build:web-ui` - build just the Svelte web UI to `dist/web-ui-static/`
- `npm test` - run all tests including web UI unit tests (vitest)
- `npm test -w packages/web-ui` - run web UI unit tests only (36 tests)
- `npm test -- test/policy-engine.test.ts` - run a single test file
- `npm test -- -t "denies delete_file"` - run a single test by name
- `npm run mock-server -w packages/web-ui` - start mock WS server for UI development without Docker/LLM
- `npm run lint` - run ESLint
- `npm run format` - format code with Prettier (`format:check` for CI validation)

## Architecture

IronCurtain has two session modes. **Code Mode** (builtin agent) runs LLM-generated TypeScript in a V8 sandbox - IronCurtain controls the agent, the sandbox, and the policy engine. **Docker Agent Mode** runs an external agent (Claude Code, Goose, etc.) in a Docker container with `--network=none` - IronCurtain doesn't control the agent, it only mediates external access through host-side proxies.

### Code Mode: Agent (`src/agent/`)

Uses Vercel AI SDK v6 (`ai` package) with Anthropic's Claude. The agent has a single `execute_code` tool that sends TypeScript to the Code Mode sandbox. Uses `stepCountIs()` for loop control (not `maxSteps`). The AI SDK v6 API uses `inputSchema` (not `parameters`), `stopWhen` (not `maxSteps`), and `toolCalls[].input` (not `.args`).

`tools.ts` provides a fallback direct-tool-call mode (used by integration tests) where MCP tools are bridged into AI SDK tools with `execute` functions routing through `TrustedProcess.handleToolCall()`. Tool names use `serverName__toolName` format.

### Code Mode: Sandbox (`src/sandbox/`)

UTCP Code Mode (`@utcp/code-mode`) provides a V8-isolated TypeScript execution environment. The LLM writes TypeScript that calls typed function stubs (e.g., `filesystem.read_file({path: '...'})`). A custom UTCP `CommunicationProtocol` (`ironcurtain-protocol.ts`) routes tool calls in-process to the `ToolCallCoordinator` for policy evaluation before forwarding to backend MCP servers. Requires `@utcp/mcp` to be imported for the MCP call template type. Tool functions inside the sandbox are **synchronous** (no `await`).

### Trusted Process (`src/trusted-process/`)

The security kernel. The `ToolCallCoordinator` (`tool-call-coordinator.ts`) centralizes PolicyEngine (two-phase default-deny evaluation), AuditLog, CallCircuitBreaker, ApprovalWhitelist, AutoApprover, and ServerContextMap as single instances in the Sandbox/CodeModeProxy layer. The security pipeline (`tool-call-pipeline.ts`) contains `handleCallTool` and all policy evaluation, escalation, audit, and argument normalization logic. MCP proxy server subprocesses (`mcp-proxy-server.ts`) are pure relay transports — they forward calls to backends without policy evaluation. The set of relays spawned per session is policy-derived: `extractRequiredServers(compiledPolicy)` walks `rule.if.server` and the standalone session path / workflow factory drop everything else from `mcpServers` before `Sandbox.connectBackendSubprocesses` runs (default-deny would reject every call to an unreferenced server anyway). In workflow shared-container mode the coordinator also runs an HTTP control server (`control-server.ts`) on a Unix domain socket for policy hot-swap between agent states; audit entries carry a `persona` field set from the coordinator's `currentPersona`. The workflow factory passes the per-scope union of required servers across all personas with that `containerScope`, so a hot-swap never needs a server that was not spawned. See [`src/trusted-process/CLAUDE.md`](src/trusted-process/CLAUDE.md) for details.

### Policy Compilation Pipeline (`src/pipeline/`)

Two-command offline pipeline (`annotate-tools` + `compile-policy`) that produces generated artifacts with content-hash caching and dynamic list resolution. See [`src/pipeline/CLAUDE.md`](src/pipeline/CLAUDE.md) for details.

### Session (`src/session/`)

**ResourceBudgetTracker** (`resource-budget-tracker.ts`) - enforces per-session limits: tokens, steps, wall-clock time, estimated cost. Three enforcement points: StopCondition (between agent steps), AbortSignal (wall-clock timeout), pre-check in `execute_code`. Throws `BudgetExhaustedError` when any limit is exceeded. Configured via `resourceBudget` field in `~/.ironcurtain/config.json` (all fields nullable to disable individual limits). Defaults: 1M tokens, 200 steps, 30min, $5.

### Docker Agent Mode (`src/docker/`)

Runs external agents in Docker containers with `--network=none`, communicating via UDS-mounted MITM and MCP proxies. Real credentials (API keys or OAuth tokens) never enter the container - fake sentinel keys are swapped host-side. OAuth is auto-detected from `~/.claude/.credentials.json` and preferred over API keys. The `DockerInfrastructure` bundle has two lifecycles: standalone sessions own their bundle (`ownsInfra: true`) and destroy it on `close()`, while workflow shared-container sessions borrow the orchestrator's bundle (`ownsInfra: false`) via `SessionOptions.workflowInfrastructure`. `DockerProxy.getPolicySwapTarget()` is the narrow seam the orchestrator uses to attach a control server to the sandbox's coordinator. See [`src/docker/CLAUDE.md`](src/docker/CLAUDE.md) for details.

### Google Workspace OAuth Token Lifecycle

The Google Workspace MCP server (`@alanse/mcp-server-google-workspace`) intentionally does **not** receive a refresh token. The credential file (`gworkspace-credentials.ts`) omits `refresh_token` to prevent the MCP server from independently refreshing tokens, which would cause refresh token rotation races. Instead, the proxy's `TokenFileRefresher` (`token-file-refresher.ts`) proactively refreshes the access token and rewrites the credential file before expiry. The MCP server re-reads the credential file on each tool call via `loadCredentialsQuietly()`, picking up the refreshed token transparently. The refresh lifecycle: `OAuthTokenProvider` (in `src/auth/`) holds the refresh token and calls Google's token endpoint; `TokenFileRefresher` checks every 5 minutes and force-refreshes via `OAuthTokenProvider.forceRefresh()` when within 10 minutes of expiry (bypassing the provider's normal 5-minute buffer); `writeGWorkspaceCredentialFile()` atomically writes the new access token.

### Configuration (`src/config/`)

**Interactive Config Editor** (`config-command.ts`) - `ironcurtain config` subcommand. Uses `@clack/prompts` for a terminal UI to view and modify `~/.ironcurtain/config.json`. Covers models, security settings, resource budgets, auto-compaction, and audit redaction. API keys are excluded (use env vars). Changes are tracked as a partial `UserConfig`, diffed against the resolved config, and saved via `saveUserConfig()`.

`loadConfig()` reads from environment variables (`ANTHROPIC_API_KEY`, `AUDIT_LOG_PATH`, `ALLOWED_DIRECTORY`) and `src/config/mcp-servers.json` for MCP server definitions. The `ALLOWED_DIRECTORY` defines the sandbox boundary for policy evaluation. In multi-turn sessions, each session gets its own sandbox at `~/.ironcurtain/sessions/{sessionId}/sandbox/`. When `--workspace <path>` is provided, the validated workspace replaces the session sandbox as `allowedDirectory` (see `src/session/workspace-validation.ts`). The fallback default is `$IRONCURTAIN_HOME/sandbox` (where `IRONCURTAIN_HOME` defaults to `~/.ironcurtain`). Workflow runs live under `~/.ironcurtain/workflow-runs/<workflowId>/` instead of the per-session tree (see [`WORKFLOWS.md`](WORKFLOWS.md) for the layout). Completed runs retain their `checkpoint.json` for post-hoc inspection; see `src/workflow/workflow-discovery.ts` for the unified directory-scan utility consumed by both the CLI `workflow inspect` command and the daemon's past-runs UI. `applyAllowedDirectoryToMcpArgs()` in `src/config/index.ts` is the single source of truth for keeping `mcpServers.filesystem.args` in sync with the active `allowedDirectory`; session, workflow factory, and pipeline all call it. `validatePolicyDir()` in `src/config/validate-policy-dir.ts` realpath-resolves candidate policy directories and enforces containment under the IronCurtain home or the package config dir. Requires a `.env` file (loaded via `dotenv/config` in `src/index.ts`). `loadGeneratedPolicy()` loads compiled artifacts (`compiled-policy.json`, `tool-annotations.json`, and optionally `dynamic-lists.json`) from `src/config/generated/`.

### Web UI (`src/web-ui/` + `packages/web-ui/`)

Opt-in Svelte 5 SPA served by the daemon via `--web-ui`. The daemon starts an HTTP+WS server (default port 7400) that serves compiled static assets and handles a JSON-RPC WebSocket protocol with bearer token auth. Backend modules: `WebUiServer` (HTTP/WS lifecycle), `json-rpc-dispatch` (19 methods with Zod validation mapping to `ControlRequestHandler` + `SessionManager`), `WebEventBus` (typed pub/sub), `WebSessionTransport` (follows `SignalSessionTransport` pattern). The frontend is a workspace package at `packages/web-ui/` built with Vite + Tailwind v3. Views: Dashboard, Sessions (with markdown rendering via `marked`), Escalations, Jobs. For development with hot reload: run `ironcurtain daemon --web-ui --web-ui-dev` in one terminal and `cd packages/web-ui && npm run dev` in another — Vite's dev server proxies `/ws` to the daemon.

### Types (`src/types/`)

Shared types: `ToolCallRequest`/`ToolCallResult`/`PolicyDecision` in `mcp.ts`, `AuditEntry` in `audit.ts`. Policy decisions have three outcomes: `allow`, `deny`, `escalate`. The engine can produce all three, but compiled rules only use `allow` and `escalate` - `deny` comes from the default fallthrough when no rule matches.

## Onboarding a New MCP Server

Adding a new MCP server requires changes across configuration, policy, and tests:

1. **`src/config/mcp-servers.json`** — Add server entry with `command`, `args`, and `sandbox` config. For Docker-based servers, use `"sandbox": false` (Docker provides isolation). Credential env vars use `-e VAR_NAME` (no `=value`) so Docker forwards from the host environment.
2. **`src/config/user-config.ts`** / **`src/config/config-command.ts`** — If the server needs credentials (API tokens), add a `SERVER_CREDENTIAL_HINTS` entry in `config-command.ts` for guided setup, and add a prompt step in `first-start.ts`. Credentials go in `serverCredentials.<serverName>.<ENV_VAR>` in `~/.ironcurtain/config.json`.
3. **`src/types/argument-roles.ts`** — Extend `serverNames` on any existing roles that apply to the new server (e.g., `branch-name` for GitHub). Add new roles only if the server introduces new resource-identifier semantics.
4. **`src/config/constitution.md`** — Add guiding principles for the new server's tools (e.g., read-only operations are safe, mutations require approval).
5. **`src/pipeline/handwritten-scenarios.ts`** — Add ground-truth scenarios for critical policy decisions involving the new server.
6. **`test/fixtures/test-policy.ts`** — Add representative tools to `testToolAnnotations.servers` and corresponding rules to `testCompiledPolicy.rules`.
7. **`test/policy-engine.test.ts`** — Add unit tests verifying the new server's tools are correctly allowed/escalated/denied.
8. **Run the pipeline** — `npm run annotate-tools -- --server <name>` (generates annotations for the new server, merging with existing), then `npm run compile-policy` (compiles policy rules). Use `--all` instead of `--server` to re-annotate all servers. Both commands gracefully skip servers that fail to connect (e.g., Docker not available).

## Publishing / Workspace Dependencies

This is an npm workspaces monorepo (`"workspaces": ["packages/*"]` in the root `package.json`). **Do not use `workspace:*`** for workspace package references — that protocol is pnpm-specific and breaks `npm install -g`. Instead, use a normal semver range (e.g., `"^0.1.3"`) pointing at the published version. npm workspaces will still resolve it to the local package during development, and `npm install` from the registry will pull the published version.

When bumping a workspace package version, remember to update the corresponding dependency range in the root `package.json`.

## Validating Policy Engine and Tool Annotations

Quick validation of compiled policies and annotations using the engine directly:

```bash
node --import tsx/esm -e "
import { PolicyEngine } from './src/trusted-process/policy-engine.js';
import { readFileSync } from 'fs';
const policy = JSON.parse(readFileSync('PATH_TO/compiled-policy.json', 'utf-8'));
const annotations = JSON.parse(readFileSync('src/config/generated/tool-annotations.json', 'utf-8'));
const engine = new PolicyEngine(policy, annotations, [], undefined);
const r = engine.evaluate({requestId: 't', serverName: 'git', toolName: 'git_branch',
  arguments: { path: '/some/path', operation: 'list' }, timestamp: ''});
console.log(r.decision, r.rule);
"
```

**Multi-mode tool annotations** — Tools with read AND mutation modes (e.g., `git_branch`, `git_stash`, `git_remote`, `git_worktree`, `git_tag`) must have conditional `when` clauses on their path/url arguments so the engine resolves `read-path` only for read operations. Without conditionals, the default roles include all modes (read + write + delete), causing escalate rules to fire even for read-only calls. The discriminator argument name must match the MCP tool's actual input schema (e.g., `operation` for `git_branch`, `mode` for `git_stash`). All arguments with mutation roles that are absent in read-only modes also need conditional specs (e.g., `git_worktree.newPath`, `git_remote.url`).

**Common validation failures and causes:**

- Read-only operation gets `escalate` → annotation missing conditional `when` clause; mutation roles always active
- Scenario uses wrong argument name (e.g., `mode` vs `operation`) → conditional roles fall to default (most restrictive). The `filterInvalidSchemaScenarios` validator catches this using `inputSchema`
- Unconditional allow rule on multi-mode tool → allows mutations too. Compiler prompt forbids this; allow rules must include `roles: ["read-path"]`

## Code Quality

Before committing, always run `npm run format` and `npm run lint` on new/modified files and fix any issues. The pre-commit hook runs `lint-staged` (Prettier + ESLint) and will reject the commit if there are violations. Common ESLint rules to watch for:

- No `require()` in ESM — use `import` or `readFileSync` + `JSON.parse`
- No unused variables or imports (`@typescript-eslint/no-unused-vars`)
- No non-null assertions (`!`) — use type guards or `as Type | undefined` instead
- No unnecessary optional chaining on non-nullish values
- No unnecessary type assertions (`as`) when the type is already correct

## Key Conventions

- ESM modules throughout (`.js` extensions in imports, `"type": "module"` in package.json)
- TypeScript strict mode, target ES2022, Node16 module resolution
- Integration tests spawn real MCP server processes (`@modelcontextprotocol/server-filesystem`) - they need ~30s timeout and create/clean up temp directories in `/tmp/`
- The policy engine uses symlink-aware `resolveRealPath()` (from `src/types/argument-roles.ts`) to normalize paths before directory containment checks - both path traversal and symlink-escape attacks are neutralized by resolving to canonical real paths before comparison
- NEVER add a generated by Claude line to commits or PRs
