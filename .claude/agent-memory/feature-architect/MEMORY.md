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
