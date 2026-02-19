# IronCurtain Architecture Notes

## Key Files
- `src/trusted-process/policy-engine.ts` - two-phase engine: structural invariants + compiled declarative rules
- `src/trusted-process/policy-types.ts` - EvaluationResult interface
- `src/types/mcp.ts` - ToolCallRequest, PolicyDecision, ToolCallResult
- `src/pipeline/types.ts` - ToolAnnotation, CompiledRule, TestScenario, etc.
- `src/pipeline/compile.ts` - CLI entry point for policy compilation
- `src/config/constitution.md` - 5 principles, filesystem-only
- `src/config/generated/` - LLM-generated artifacts (tool-annotations.json, compiled-policy.json, test-scenarios.json)
- `docs/secure-agent-runtime-v2.md` - vision doc (many features aspirational)
- `docs/ironcurtain-poc-handoff.md` - PoC handoff (significantly stale)
- `docs/designs/policy-compilation-pipeline.md` - pipeline design (mostly accurate, effect->roles drift)
- `docs/designs/policy-compilation-implementation-plan.md` - implementation plan (completed, some drift)

## Architecture Patterns
- **Policy evaluation**: two-phase: structural invariants, then compiled declarative rules
- **Multi-role evaluation**: each distinct role evaluated independently, most-restrictive-wins (deny > escalate > allow)
- **Three-state decisions**: `allow | deny | escalate` (PolicyDecisionStatus)
- **Tool naming**: `serverName__toolName` format
- **Path security**: `node:path.resolve()` before directory containment checks
- **Protected paths**: exact path + directory containment (not substring matching)
- **Tool classification**: via LLM-generated ToolAnnotation (args with ArgumentRole: read-path, write-path, delete-path, none)
- **Content-hash caching**: per-stage inputHash skips LLM calls when inputs unchanged

## Dual-Mode Trusted Process
1. **Proxy mode** (`mcp-proxy-server.ts`) - standalone child process for Code Mode
2. **In-process mode** (`index.ts`) - TrustedProcess class for tests/direct tool calls
Both use the same PolicyEngine with compiled artifacts.

## Policy Evaluation Order (actual implementation)
1. Structural invariants (hardcoded): protected paths + unknown tools
2. Compiled declarative rules (per-role evaluation, most-restrictive-wins)
3. Default deny

## Current Constitution Principles
1. Least privilege
2. No destruction
3. Sandbox freedom
4. Transparency
5. Human oversight

## Key Design Decisions (implemented)
- `effect` field was dropped from ToolAnnotation; rules use `roles` matching instead
- Only `list_allowed_directories` gets `sideEffects: false`; all path-taking tools are `sideEffects: true`
- Reads outside sandbox escalate (not deny) per "Human oversight" principle
- ALL move operations denied because source has delete-path role
- Artifacts always written to disk even on verification failure (for inspection/caching)
- AI SDK v6: `generateText()` with `Output.object({ schema })`, not `generateObject()`

## AI SDK v6 Message Types (for multi-turn)
- `ModelMessage = SystemModelMessage | UserModelMessage | AssistantModelMessage | ToolModelMessage` (from `@ai-sdk/provider-utils`)
- `ResponseMessage = AssistantModelMessage | ToolModelMessage` (from `ai`)
- `generateText()` accepts `messages: Array<ModelMessage>` OR `prompt: string` (mutually exclusive)
- `generateText()` result has `response.messages: Array<ResponseMessage>` -- these are what you append back for multi-turn
- `pruneMessages()` exported from `ai` for context window management
- `totalUsage` on result has `promptTokens` + `completionTokens`

## Multi-Turn Session Design (designed 2026-02-17, decisions finalized)
- See `docs/multi-turn-session-design.md` for full spec
- Session interface: `sendMessage(text) -> Promise<string>`, `getHistory()`, `getDiagnosticLog()`, `resolveEscalation()`, `getPendingEscalation()`, `close()`
- Transport interface: `run(session) -> Promise<void>` -- decouples I/O from session logic
- AgentSession owns: Sandbox, ModelMessage[] history, ConversationTurn[] log, DiagnosticEvent[] log, escalation dir
- Factory function `createSession()` is the only public constructor
- Single-shot mode = create session, send one message, close
- CliTransport handles both single-shot (with initialMessage) and interactive REPL
- Slash commands: /quit, /logs, /approve, /deny
- Escalation IPC: file-based rendezvous via per-session escalation directory (ESCALATION_DIR env var)
- Proxy writes request-{id}.json, polls for response-{id}.json; session watches dir, transport surfaces to user
- Per-session audit log: audit-{sessionId}.jsonl
- Sandbox injection: factory pattern via SessionOptions.sandboxFactory
- Diagnostic logging: delegated to transport via onDiagnostic callback + accumulated in getDiagnosticLog()
- buildSystemPrompt() extracted to src/agent/prompts.ts (shared utility)
- Context window: fail with clear error, no automatic pruning

## Logger Design (designed 2026-02-18)
- Module singleton at `src/logger.ts` with `setup()`/`teardown()` lifecycle
- File-based: `appendFileSync` to `~/.ironcurtain/sessions/{id}/session.log`
- Console interception: monkey-patches console.log/error/warn/debug, saves originals for restoration
- No-op when not set up (safe for code running both inside/outside sessions)
- User-facing output (escalation banners, agent responses) uses `process.stderr.write()`/`process.stdout.write()` to bypass interception
- Proxy process (`mcp-proxy-server.ts`) does NOT import logger (separate child process)
- Pipeline (`compile.ts`) does NOT import logger (standalone CLI tool)
- `getSessionLogPath()` added to `src/config/paths.ts`
- Session factory calls `setup()`, session close calls `teardown()`

## ArgumentRole Registry Design (designed 2026-02-18)
- See design spec in conversation for full details
- New file: `src/types/argument-roles.ts` -- canonical source for ArgumentRole type + RoleDefinition registry
- `src/pipeline/types.ts` re-exports ArgumentRole for backward compat
- `normalizeToolArgsFromAnnotation(args, annotation)` in path-utils.ts replaces heuristic normalization
- PolicyEngine gets `getAnnotation()` public method to expose annotation lookup
- Heuristic `normalizeToolArgPaths` retained (deprecated) for defense-in-depth in structural invariants
- Registry uses ReadonlyMap<ArgumentRole, RoleDefinition> with normalize function per role
- getResourceRoles() replaces hardcoded `['read-path', 'write-path', 'delete-path']`
- getArgumentRoleValues() returns tuple for z.enum() compatibility in Zod schemas
- Compile-time completeness check ensures every union member has a registry entry
- Generated JSON artifacts unchanged (roles stay as strings)
- 4-PR migration: (1) add registry, (2) pipeline strings, (3) engine strings, (4) annotation-driven normalization

## MCP Roots Integration Design (designed 2026-02-18)
- See `docs/designs/mcp-roots-integration.md` for full spec
- New file: `src/trusted-process/policy-roots.ts` -- `extractPolicyRoots()` + `toMcpRoots()`
- Extracts directories from compiled policy rules where `then` is `allow` or `escalate` and `paths.within` exists
- Sandbox directory always included as first root
- MCPClientManager.connect() gains optional `roots` parameter; declares `roots` capability, registers `ListRootsRequestSchema` handler
- Proxy mode: roots passed via `POLICY_ROOTS` env var (JSON array of `{ uri, name }`)
- In-process mode: TrustedProcess extracts roots in constructor, passes to MCPClientManager
- CLI args retained as fallback for servers without roots support
- No `notifications/roots/list_changed` -- roots are static per session

## MCP SDK Roots API
- `Client` constructor accepts `{ capabilities: { roots: { listChanged: boolean } } }`
- Server calls `roots/list` on client after init; client responds with `{ roots: [{ uri, name? }] }`
- `ListRootsRequestSchema` imported from `@modelcontextprotocol/sdk/types.js`
- `client.sendRootsListChanged()` sends notification (not needed for static roots)
- Filesystem server: when roots provided, they REPLACE CLI args entirely

## Current Constitution (updated 2026-02-18)
- Only 3 principles now: Least privilege, No destruction, Human oversight
- Concrete guidance: RWD in Downloads, read-only in Documents

## User Config File Design (designed 2026-02-19, implemented)
- See `docs/designs/config-file.md` for full spec
- File: `~/.ironcurtain/config.json`, auto-created with defaults
- `src/config/user-config.ts` -- `loadUserConfig()`, `UserConfig`, `ResolvedUserConfig`
- Settings: agentModelId, policyModelId, apiKey, escalationTimeoutSeconds
- Resolution order: env var > config file > defaults
- Pipeline loads user config directly (standalone CLI, not part of session layer)

## Multi-Provider Model Design (designed 2026-02-19)
- See `docs/designs/multi-provider-models.md` for full spec
- Qualified model IDs: `provider:model-id` format (e.g. `anthropic:claude-sonnet-4-6`)
- Bare model IDs (no colon) default to Anthropic for backward compatibility
- New file: `src/config/model-provider.ts` -- `parseModelId()`, `createLanguageModel()`
- Dynamic imports for provider packages (only used provider needs to be installed)
- Per-provider API keys: apiKey (Anthropic), googleApiKey, openaiApiKey
- Env var precedence: ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, OPENAI_API_KEY
- `anthropicApiKey` removed from IronCurtainConfig; replaced by `userConfig: ResolvedUserConfig`
- API key validation deferred to first LLM call (AI SDK gives better errors than we can)
- AI SDK's `createProviderRegistry` rejected: requires eager instantiation of all providers
- Only two callsites need changes: agent-session.ts:260 and compile.ts:588-589

## Dual-Feedback Repair Loop Design (designed 2026-02-19)
- Current repair loop only feeds failures to constitution compiler; fails when scenario expectations are wrong
- Judge gets `failureAttributions` array in response schema with `blame: 'rule' | 'scenario' | 'both'`
- New types: `FailureBlame` (discriminated union), `AttributedFailure`, `ScenarioCorrection`
- `applyScenarioCorrections()` does targeted patches on generated scenarios; handwritten scenarios never auto-corrected
- Repair loop: apply scenario corrections first, then conditionally recompile rules, then re-verify
- Both channels can fire in same iteration to prevent oscillation
- Corrected scenarios written to disk with `-corrected` hash suffix
- Files changed: `types.ts`, `policy-verifier.ts`, `compile.ts`; no new files needed
- Key invariant: handwritten scenarios are human ground truth, never mutated by LLM

## Execution Containment Design (TB0, designed 2026-02-19)
- See `docs/designs/execution-containment.md` for full spec
- Integrates `@anthropic-ai/sandbox-runtime` (npm) for OS-level process sandboxing
- Integration point: `mcp-proxy-server.ts` (proxy spawns MCP servers, so proxy wraps them)
- New module: `src/trusted-process/sandbox-integration.ts`
- `SandboxManager.wrapWithSandbox(cmd, binShell, customConfig)` returns shell string
- Shell bridge: `command='/bin/sh'`, `args=['-c', wrappedString]` for StdioClientTransport (which uses `shell:false`)
- Sandbox-by-default: omitted `sandbox` field = sandboxed with restrictive defaults
- Opt-out: `"sandbox": false` for mediated servers (e.g., filesystem)
- Per-command filesystem via `customConfig` param; network is process-wide (union of all servers' domains)
- Session sandbox dir auto-injected into `allowWrite`
- Platform degradation: `SandboxAvailabilityPolicy = 'enforce' | 'warn' | 'skip'` (default: warn)
- New types: `ServerSandboxConfig`, `SandboxNetworkConfig`, `SandboxFilesystemConfig`, `ResolvedSandboxConfig`
- New diagnostic event: `sandbox_violation` (heuristic EPERM detection)
- New audit field: `sandboxed?: boolean`
- 4-phase migration: (1) types+module, (2) proxy integration, (3) violation detection, (4) integration tests

### sandbox-runtime API Key Facts
- Singleton per process: one network config (HTTP/SOCKS proxy pair)
- `wrapWithSandbox(command, binShell?, customConfig?, abortSignal?)` -> `Promise<string>`
- `customConfig: Partial<SandboxRuntimeConfig>` allows per-command filesystem overrides
- `isSupportedPlatform()` and `checkDependencies()` for detection
- `initialize(config)`, `reset()`, `updateConfig(newConfig)`
- Linux: bubblewrap + seccomp-bpf + `--unshare-net` with socat bridges
- macOS: Seatbelt (sandbox-exec, deprecated but functional)
- No Windows support
- stdio passes through transparently (MCP compatible)

## NOT Implemented (aspirational in docs)
- Per-task policy layer
- Runtime LLM assessment (semantic checks)
- Agent identity / resource budgets / push notifications / policy learning
- Non-filesystem MCP servers

## Document Staleness (reviewed 2026-02-18)
- `ironcurtain-poc-handoff.md`: most stale (sandbox tech, policy engine, constitution, missing pipeline)
- `secure-agent-runtime-v2.md`: vision doc, many features aspirational
- `policy-compilation-pipeline.md`: mostly accurate, main drift is effect->roles, missing multi-role eval
- `policy-compilation-implementation-plan.md`: completed plan, same drift as pipeline doc
