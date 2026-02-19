# IronCurtain Clean Implementer Memory

## Project Architecture
- **Pipeline types**: `src/pipeline/types.ts` -- shared types for all pipeline modules
- **PolicyEngine**: `src/trusted-process/policy-engine.ts` -- two-phase: structural invariants + compiled rules
- **Constructor**: `new PolicyEngine(compiledPolicy, toolAnnotations, protectedPaths)`
- **Generated artifacts**: `src/config/generated/{compiled-policy,tool-annotations}.json`
- **Config**: `src/config/types.ts` has `IronCurtainConfig` with `protectedPaths`, `generatedDir`, `constitutionPath`

## Session Architecture (multi-turn)
- **Path utilities**: `src/config/paths.ts` -- `getIronCurtainHome()`, `getSessionDir()`, etc.
- **Session types**: `src/session/types.ts` -- `Session` interface, `SessionId`, `SessionOptions`, etc.
- **Session errors**: `src/session/errors.ts` -- `SessionError`, `SessionNotReadyError`, `SessionClosedError`
- **Transport interface**: `src/session/transport.ts` -- `Transport` with `run(session): Promise<void>`
- **AgentSession**: `src/session/agent-session.ts` -- concrete Session impl (not exported publicly)
- **Session factory**: `src/session/index.ts` -- `createSession()` factory + re-exports
- **CLI transport**: `src/session/cli-transport.ts` -- `CliTransport` with single-shot + interactive REPL
- **System prompt**: `src/agent/prompts.ts` -- `buildSystemPrompt()` extracted from `src/agent/index.ts`
- **Design spec**: `docs/multi-turn-session-design.md` -- full design with 13-step migration plan
- **Home dir**: `~/.ironcurtain/` (overridable via `IRONCURTAIN_HOME`), per-session dirs under `sessions/{id}/`

## AI SDK v6 Type Gotchas
- `ToolSet` type (not `Record<string, ReturnType<typeof tool>>`) for tool collections -- avoids `Tool<never, never>` inference
- `LanguageModelUsage` uses `inputTokens`/`outputTokens`/`totalTokens` (NOT `promptTokens`/`completionTokens`)
- `onStepFinish` callback receives `(stepResult: StepResult<TOOLS>)` -- no `stepIndex` parameter
- `ModelMessage` importable from both `ai` and `@ai-sdk/provider-utils`

## ArgumentRole Registry
- **Canonical location**: `src/types/argument-roles.ts` -- type, registry, normalizers, accessors
- **Re-exported from**: `src/pipeline/types.ts` (backward compat: `ArgumentRole`, `isArgumentRole`, `getArgumentRoleValues`)
- **Key exports**: `ARGUMENT_ROLE_REGISTRY`, `getRoleDefinition()`, `getResourceRoles()`, `isArgumentRole()`, `getArgumentRoleValues()`, `expandTilde()`, `normalizePath()`
- **Normalizers**: path roles use `normalizePath` (tilde expand + resolve), `none` uses identity
- **prepareToolArgs()**: in `src/trusted-process/path-utils.ts` -- annotation-driven normalization, returns `{ argsForTransport, argsForPolicy }`
- **PolicyEngine.getAnnotation()**: public method to look up ToolAnnotation for a tool
- **Heuristic fallback**: `normalizeToolArgPaths()` is `@deprecated` but retained for defense-in-depth and fallback when no annotation

## ToolAnnotation shape (post-refactor)
- Fields: `toolName`, `serverName`, `comment` (string), `sideEffects` (boolean), `args` (Record<string, ArgumentRole[]>)
- No `effect` field -- argument roles are the single source of truth

## CompiledRuleCondition shape (post-refactor)
- `roles?: ArgumentRole[]` -- match tools with any argument having these roles (blanket rules)
- `paths?: PathCondition` -- extract paths from args with matching roles, check within directory
- `roles` and `paths` serve different purposes; should not both appear in same rule
- No `effect` field

## AI SDK v6 Mock Pattern (MockLanguageModelV3)
When mocking `generateText` with `Output.object` using `MockLanguageModelV3` from `ai/test`:
```typescript
new MockLanguageModelV3({
  doGenerate: async () => ({
    content: [{ type: 'text', text: JSON.stringify(responseData) }],
    finishReason: { unified: 'stop', raw: 'stop' },  // V3 format
    usage: {
      inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 50, text: undefined, reasoning: undefined },
    },
    warnings: [],  // REQUIRED
    request: {},
    response: { id: 'test-id', modelId: 'test-model', timestamp: new Date() },
  }),
});
```
CRITICAL: `finishReason` must use `{ unified, raw }` (V3). Old `{ type, reason }` causes "No output generated" error.
CRITICAL: `response` not `responseData`. Field name changed in V3.

## Integration Test Pattern
Integration tests use dynamic sandbox dirs (`/tmp/ironcurtain-test-<pid>`). The compiled-policy.json has `/tmp/ironcurtain-sandbox`. Must load, rewrite `within` paths, and write to a temp dir for the test.

## Protected Paths vs Patterns
Engine uses concrete filesystem paths with `path.resolve()` and directory containment. Test paths must use actual project paths like `resolve(projectRoot, 'src/config/constitution.md')`.

## Key File Inventory (post-pipeline)
- `src/pipeline/types.ts` -- all shared types
- `src/pipeline/tool-annotator.ts` -- LLM tool classification
- `src/pipeline/constitution-compiler.ts` -- LLM rule compilation
- `src/pipeline/scenario-generator.ts` -- LLM test generation
- `src/pipeline/policy-verifier.ts` -- multi-round real engine + LLM judge
- `src/pipeline/handwritten-scenarios.ts` -- 15 mandatory test scenarios
- `src/pipeline/compile.ts` -- CLI entry point (`npm run compile-policy`)
- `src/config/index.ts` -- `loadConfig()` and `loadGeneratedPolicy()`

## validateCompiledRules Signature
`validateCompiledRules(rules: CompiledRule[])` -- no longer takes annotations parameter.

## Zod v4 Strict Mode
Zod v4 (^4.3.6) strict by default. Mock response JSON must exactly match Zod schema -- no extra properties.

## Move Operations Policy
All moves denied via `deny-delete-operations` rule (move_file source has `delete-path` role). No move-specific rules.

## Design Documents
- `docs/designs/policy-compilation-pipeline.md` -- design spec (updated to match implementation)
- `docs/designs/policy-compilation-implementation-plan.md` -- implementation plan (marked as completed)
- Both updated 2026-02-17 to reflect: no `effect` field, `roles` instead, `inputHash` caching, `escalate-read-elsewhere`, all moves denied, artifacts always written

## LLM Interaction Logging
- `src/pipeline/llm-logger.ts` -- AI SDK middleware that captures all LLM prompts and responses
- Uses `wrapLanguageModel()` with `LanguageModelMiddleware.wrapGenerate` to intercept calls
- Writes JSONL to `src/config/generated/llm-interactions.jsonl` (covered by `*.jsonl` in .gitignore)
- Caller sets `LlmLogContext.stepName` before each pipeline phase (mutable context pattern)
- Each entry: timestamp, stepName, modelId, prompt, responseText, usage, durationMs
- Middleware `specificationVersion: 'v3'` required for AI SDK v6

## Session Test Mocking Pattern
When mocking `generateText` for session tests:
- Use `vi.mock('ai', ...)` to replace `generateText` with `vi.fn()`
- Also mock `@ai-sdk/anthropic` (anthropic function) and `@utcp/code-mode` (CodeModeUtcpClient)
- Mock `generateText` result shape: `{ text, response: { messages: [...] }, totalUsage: { inputTokens, outputTokens, totalTokens } }`
- GOTCHA: `messages` array is passed by reference to `generateText`. Inspecting `mock.calls[n][0].messages` after the test shows mutated state. Snapshot with `[...opts.messages]` at call time.
- Use `IRONCURTAIN_HOME` env var pointed at `/tmp/ironcurtain-test-<pid>` for isolation
- `createSession` factory adds `escalationDir` to session config (required for sandbox to pass ESCALATION_DIR to proxy)

## Entry Point Architecture (post-session refactor)
- `src/index.ts` uses `createSession()` + `CliTransport` (backward compatible)
- `npm start "task"` = single-shot mode, `npm start` = interactive REPL
- `runAgent()` in `src/agent/index.ts` is deprecated (still used by integration tests)
- `loadConfig()` default ALLOWED_DIRECTORY uses `getIronCurtainHome()/sandbox` (not `/tmp/ironcurtain-sandbox`)
- Session factory overrides `allowedDirectory`, `auditLogPath`, and `escalationDir` per-session

## MCP Roots Integration
- **Policy roots module**: `src/trusted-process/policy-roots.ts` -- `extractPolicyRoots()`, `toMcpRoots()`, `directoryForPath()`
- **MCPClientManager**: `connect()` takes optional `roots?: McpRoot[]` param, `addRoot()` with sync wait pattern
- **McpRoot interface**: exported from `mcp-client-manager.ts` -- `{ uri: string; name: string }`
- **Root sync pattern**: `addRoot` registers `rootsRefreshed` callback, calls `sendRootsListChanged()`, awaits callback when `roots/list` handler fires
- **Proxy server**: uses inline `ClientState` interface (not MCPClientManager) for roots management
- **TrustedProcess**: computes roots in constructor via `extractPolicyRoots` + `toMcpRoots`, passes to `connect()`, calls `addRoot()` after escalation approval
- **Node.js resolve() gotcha**: `resolve('/path/')` strips trailing slash; check for trailing slash *before* resolve
- **MCP SDK**: `ListRootsRequestSchema` from `@modelcontextprotocol/sdk/types.js`, `sendRootsListChanged()` on Client, `setRequestHandler()` on Client
- **Tests**: `test/policy-roots.test.ts` -- unit tests for extraction/conversion/directory functions

## User Configuration
- **User config module**: `src/config/user-config.ts` -- `loadUserConfig()`, `UserConfig`, `ResolvedUserConfig`, `USER_CONFIG_DEFAULTS`
- **Config path**: `src/config/paths.ts` -- `getUserConfigPath()` returns `{home}/config.json`
- **Config file**: `~/.ironcurtain/config.json` -- auto-created with defaults if missing
- **Fields**: `agentModelId`, `policyModelId`, `apiKey`, `escalationTimeoutSeconds` (all optional in file)
- **Resolution order**: env var > config file > defaults
- **IronCurtainConfig**: now has `agentModelId: string` and `escalationTimeoutSeconds: number` (required)
- **Proxy escalation timeout**: passed via `ESCALATION_TIMEOUT_SECONDS` env var from sandbox to proxy child process
- **Pipeline model**: `compile.ts` calls `loadUserConfig()` directly (standalone CLI, Option A from design)
- **Tests**: `test/user-config.test.ts` -- uses `IRONCURTAIN_HOME` temp dirs for isolation
- **Zod validation**: unknown fields warn to stderr, invalid types/values throw

## Session Logging System
- **Logger module**: `src/logger.ts` -- module-level singleton with `setup()`/`teardown()` lifecycle
- **Log file**: `~/.ironcurtain/sessions/{id}/session.log` (path via `getSessionLogPath()` in `src/config/paths.ts`)
- **API**: `logger.debug/info/warn/error()` -- no-ops when not set up (safe for code running outside sessions)
- **Console interception**: `setup()` patches `console.log/error/warn/debug` to redirect to log file; `teardown()` restores originals
- **User-facing output**: must use `process.stdout.write()` / `process.stderr.write()` to bypass interception
- **Lifecycle**: `createSession()` calls `setup()` after mkdirSync; `AgentSession.close()` calls `teardown()` at the end
- **Excluded**: `mcp-proxy-server.ts` (separate process) and `pipeline/compile.ts` (standalone CLI)
- **Test gotcha**: session tests must call `logger.teardown()` in `afterEach` to prevent "Logger already set up" errors when creating multiple sessions across tests
- **Design spec**: `docs/logging-design.md`
