# IronCurtain architecture notes (inlined detail moved out of MEMORY.md)

Durable pointers and hard-won gotchas. Much of the file-inventory here is also
derivable by reading the codebase; treat it as a fast map, and verify a named
symbol/path still exists before acting on it.

## Project Architecture
- **Pipeline types**: `src/pipeline/types.ts` -- shared types for all pipeline modules
- **PolicyEngine**: `src/trusted-process/policy-engine.ts` -- two-phase: structural invariants + compiled rules
- **Constructor**: `new PolicyEngine(compiledPolicy, toolAnnotations, protectedPaths, allowedDirectory?, serverDomainAllowlists?, dynamicLists?)`
- **Generated artifacts**: `src/config/generated/{compiled-policy,tool-annotations,dynamic-lists}.json`
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

## Entry Point Architecture (post-session refactor)
- `src/index.ts` uses `createSession()` + `CliTransport` (backward compatible)
- `npm start "task"` = single-shot mode, `npm start` = interactive REPL
- `runAgent()` in `src/agent/index.ts` is deprecated (still used by integration tests)
- `loadConfig()` default ALLOWED_DIRECTORY uses `getIronCurtainHome()/sandbox` (not `/tmp/ironcurtain-sandbox`)
- Session factory overrides `allowedDirectory`, `auditLogPath`, and `escalationDir` per-session

## AI SDK v6 Type Gotchas
- `ToolSet` type (not `Record<string, ReturnType<typeof tool>>`) for tool collections -- avoids `Tool<never, never>` inference
- `LanguageModelUsage` uses `inputTokens`/`outputTokens`/`totalTokens` (NOT `promptTokens`/`completionTokens`)
- `onStepFinish` callback receives `(stepResult: StepResult<TOOLS>)` -- no `stepIndex` parameter
- `ModelMessage` importable from both `ai` and `@ai-sdk/provider-utils`
- use `maxOutputTokens` not `maxTokens` in generateText()
- `LanguageModel` union includes string; use `LanguageModelV3` from `@ai-sdk/provider` for concrete return types

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
CRITICAL: `finishReason` must use `{ unified, raw }` (V3). Old `{ type, reason }` causes "No output generated".
CRITICAL: `response` not `responseData`. Field name changed in V3.

## ArgumentRole Registry (TB1a: extended)
- **Canonical location**: `src/types/argument-roles.ts` -- type, registry, normalizers, accessors, URL helpers
- **Re-exported from**: `src/pipeline/types.ts` (backward compat: `ArgumentRole`, `isArgumentRole`, `getArgumentRoleValues`)
- **8 roles**: `read-path`, `write-path`, `delete-path`, `fetch-url`, `git-remote-url`, `branch-name`, `commit-message`, `none`
- **RoleCategory**: `'path' | 'url' | 'opaque'` -- determines which structural invariant applies
- **RoleDefinition fields**: `description`, `isResourceIdentifier`, `category`, `canonicalize`, `annotationGuidance`
- **Category accessors**: `getRolesByCategory()`, `getPathRoles()`, `getUrlRoles()`, `getResourceRoles()`
- **URL normalizers** (in `src/trusted-process/domain-utils.ts`): `normalizeUrl()`, `extractDomain()`, `normalizeGitUrl()`, `extractGitDomain()`, `resolveGitRemote()`
- **resolveGitRemote()**: uses `execFileSync` (not `execSync`) for safety; resolves named remotes to URLs via `git remote get-url`
- **prepareToolArgs()**: in `src/trusted-process/path-utils.ts` -- annotation-driven normalization, returns `{ argsForTransport, argsForPolicy }`
- **PolicyEngine.getAnnotation()**: public method to look up ToolAnnotation for a tool
- **No heuristic path extraction**: `extractPathsHeuristic` removed; policy engine trusts annotations exclusively

## ToolAnnotation shape (post-refactor)
- Fields: `toolName`, `serverName`, `comment` (string), `sideEffects` (boolean), `args` (Record<string, ArgumentRole[]>)
- No `effect` field -- argument roles are the single source of truth

## CompiledRuleCondition shape (post-dynamic-lists)
- `roles?: ArgumentRole[]` -- match tools with any argument having these roles (blanket rules)
- `paths?: PathCondition` -- extract paths from args with matching roles, check within directory
- `domains?: DomainCondition` -- `{ roles, allowed }` -- URL-role args against domain allowlist; `allowed` may contain `@list-name` refs
- `lists?: ListCondition[]` -- `{ roles, allowed, matchType }` -- non-domain list matching (emails, identifiers); AND semantics across array
- `roles`, `paths`, `domains`, and `lists` serve different purposes; may coexist in same rule

## Integration Test Pattern
Integration tests use dynamic sandbox dirs (`/tmp/ironcurtain-test-<pid>`). The compiled-policy.json has `/tmp/ironcurtain-sandbox`. Must load, rewrite `within` paths, and write to a temp dir for the test.

## Protected Paths vs Patterns
Engine uses concrete filesystem paths with `path.resolve()` and directory containment. Test paths must use actual project paths like `resolve(projectRoot, 'src/config/constitution.md')`.

## Key File Inventory (post-pipeline)
- `src/pipeline/types.ts` -- all shared types (ListDefinition, ResolvedList, DynamicListsFile, ListCondition, ListType, DiscardedScenario, ScenarioFeedback)
- `src/pipeline/tool-annotator.ts` -- LLM tool classification
- `src/pipeline/constitution-compiler.ts` -- LLM rule compilation (emits listDefinitions)
- `src/pipeline/generate-with-repair.ts` -- `generateObjectWithRepair()`, `parseJsonWithSchema()`, `extractJson()`, `schemaToPromptHint()` (all exported)
- `src/pipeline/dynamic-list-types.ts` -- LIST_TYPE_REGISTRY, ListTypeDef, getListMatcher()
- `src/pipeline/list-resolver.ts` -- resolveList(), resolveAllLists()
- `src/pipeline/scenario-generator.ts` -- LLM test generation with batching + `repairScenarios()` for structural conflict replacements
- `src/pipeline/policy-verifier.ts` -- multi-round real engine + LLM judge (re-exports DiscardedScenario from types)
- `src/pipeline/handwritten-scenarios.ts` -- 26 mandatory test scenarios (15 filesystem + 11 git)
- `src/pipeline/compile.ts` -- CLI thin wrapper over PipelineRunner; re-exports `resolveRulePaths`; CLI flags: `--constitution`, `--output-dir`, `--server`
- `src/pipeline/pipeline-runner.ts` -- `PipelineRunner` class: per-server compilation for both 'constitution' and 'task-policy' modes; exports `mergeServerResults()`, `validateServerScoping()`, `deduplicateListDefinitions()`, `getHandwrittenScenariosForServer()`, `computeServerPolicyHash()`
- `src/pipeline/mcp-connections.ts` -- `connectMcpServersForLists()`, `disconnectMcpServers()`
- `src/pipeline/pipeline-shared.ts` -- shared utils: `resolveRulePaths()`, `loadPipelineConfig()`, `createPipelineLlm()`, caching, spinners
- `src/pipeline/constitution-customizer.ts` -- LLM-assisted conversational customizer CLI
- `src/config/index.ts` -- `loadConfig()` and `loadGeneratedPolicy()` (returns dynamicLists)
- `validateCompiledRules(rules: CompiledRule[], listDefinitions?: ListDefinition[])` -- validates rules + list cross-references

## Zod v4 Strict Mode
Zod v4 (^4.3.6) strict by default. Mock response JSON must exactly match Zod schema -- no extra properties. Unknown fields warn to stderr, invalid types/values throw.

## Deny-Default Policy Model
- **Engine default**: unmatched operations return `deny` / `default-deny` (not escalate)
- **Compiler schema**: `then` enum restricted to `['allow', 'escalate']` -- no deny rules emitted
- **Engine still accepts deny**: `CompiledRule.then` type is `Decision` (includes deny) for backward compat with legacy policy files
- **Design doc**: `docs/designs/deny-default-policy.md`
- **Catch-all prevention**: `.refine()` on `if` condition rejects empty conditions (no catch-all rules)
- **Move operations**: under deny-default, external deletes fall through to default-deny (no explicit deny rule needed)

## Dynamic Lists (Phase 1-3 complete)
- **Design**: `docs/designs/dynamic-lists.md` -- full 4-phase spec
- **Flow**: compiler emits `@list-name` in rules + `listDefinitions`; resolver produces `dynamic-lists.json`; engine expands at load time
- **List types**: `domains` (domainMatchesAllowlist), `emails` (case-insensitive), `identifiers` (case-sensitive exact)
- **Expansion**: `expandListReferences()` module-level fn in policy-engine.ts; `getEffectiveListValues()` = (values + manualAdditions) - manualRemovals
- **Evaluation**: `extractAnnotatedValues()` generic extraction; `getListMatcher()` local to policy-engine (avoids circular import with dynamic-list-types)
- **Per-role**: `hasRoleConditions()` and `ruleRelevantToRole()` both check `lists` conditions
- **Resolver**: knowledge-based uses `generateObjectWithRepair`; MCP-backed uses `generateText` with bridged tools + `parseValuesFromText`
- **MCP resolution**: `McpServerConnection` interface, `bridgeMcpTools()` bridges MCP tools as AI SDK tools, `selectMcpConnection()` prefers `mcpServerHint`
- **MCP connections**: `connectMcpServersForLists()` in `src/pipeline/mcp-connections.ts`; connects only needed servers; `disconnectMcpServers()` cleans up; uses try/finally pattern
- **Circular import gotcha**: `dynamic-list-types.ts` imports `domainMatchesAllowlist` from `domain-utils.ts`; policy-engine defines its own `getListMatcher()` to avoid reverse import
- **loadGeneratedPolicy**: returns `{ compiledPolicy, toolAnnotations, dynamicLists }` -- dynamicLists is optional (backward compatible)
- **Tests**: `test/dynamic-lists.test.ts` -- 60 tests

## Constitution Customizer (TB1c) & Auto-Constitution Generation
- **Global customizer**: `src/pipeline/constitution-customizer.ts` -- LLM-assisted conversational CLI
- **Exports**: `buildSystemPrompt()`, `buildUserMessage()`, `formatAnnotationsForPrompt()`, `computeLineDiff()`, `formatDiff()`, `applyChanges()`, `callLlm()`, `loadAnnotations()`, `writeConstitution()`, `revertConstitution()`, `seedBaseConstitution()`
- **Job customizer**: `src/cron/job-customizer.ts` -- `runJobConstitutionCustomizer(initialConstitution, taskDescription)` returns `string | undefined`; operates in-memory
- **Constitution generator**: `src/cron/constitution-generator.ts` -- `generateConstitution(options)` runs Code Mode session with read-only policy; exports `buildConstitutionGeneratorSystemPrompt()`, `parseConstitutionResponse()`; `context?: 'cron' | 'persona'` on `ConstitutionGeneratorOptions`
- **Read-only policy**: `src/config/constitution-readonly.md` + `src/config/generated-readonly/compiled-policy.json`
- **Path helpers**: `getReadOnlyPolicyDir()`, `getPackageConfigDir()` in `src/config/paths.ts`
- **CLI flags**: `compile-policy --constitution <path> --output-dir <path>` parsed by `parseCompilePolicyArgs()` in `compile.ts`
- **Pipeline config**: `loadPipelineConfig(overrides?)` accepts `PipelineConfigOverrides` with `constitution?` and `outputDir?`
- **Session policyDir validation**: `validatePolicyDir()` accepts paths under IronCurtain home OR package config dir
- **Build**: `copy-assets.mjs` copies `constitution-readonly.md` + `generated-readonly/` to `dist/config/`

## Scenario Generation & Repair
- **Batched generation**: `generateScenarios()` in scenario-generator.ts; batches of SCENARIO_BATCH_SIZE=25; per-batch scoped schema
- **repairScenarios()**: single-shot LLM call to replace structurally discarded scenarios; wired into `compileServer`
- **DiscardedScenario**: in `src/pipeline/types.ts`; has `scenario`, `actual`, `rule` fields
- **parseJsonWithSchema()**: exported from generate-with-repair.ts; shared extraction+validation
- **Design**: `docs/designs/scenario-generation-batching.md`

## Persona System
- **Design**: `docs/designs/persona-system.md`
- **Types**: `src/persona/types.ts` -- `PersonaName` (branded), `PersonaDefinition`, `PERSONA_NAME_PATTERN`, `createPersonaName()`, `PersonaMemoryConfig`
- **Resolver**: `src/persona/resolve.ts` -- path helpers, `loadPersona()`, `resolvePersona()`, `applyServerAllowlist()`
- **Compilation**: `src/persona/compile-persona-policy.ts` -- `compilePersonaPolicy(name)` wraps PipelineRunner with `constitutionKind: 'constitution'`
- **Prompt**: `src/persona/persona-prompt.ts` -- `buildPersonaSystemPromptAugmentation(persona, memoryPath)`
- **Customizer**: `src/persona/persona-customizer.ts` -- `runPersonaConstitutionCustomizer()` same pattern as job-customizer
- **CLI**: `src/persona/persona-command.ts` -- subcommands: create, list, compile, edit, delete, show
- **Session integration**: `persona?: string` in `SessionOptions`; resolved in `buildSessionConfig()` via static import of resolve.ts
- **Layout**: `~/.ironcurtain/personas/{name}/{persona.json, constitution.md, generated/, workspace/memory.md}`

## Per-Server Policy Compilation (with parallel support)
- **Design**: `docs/designs/per-server-policy-compilation.md`, `docs/designs/parallel-compilation.md`
- **Dispatch**: `run()` routes all modes through `runPerServer()` (monolithic path removed)
- **Parallel execution**: `compileAllServers()` uses `p-limit` for both server concurrency (10) and LLM call throttling (8)
- **Per-server model**: `createPerServerModel(baseLlm, logPath, serverName)` wraps base model with per-server logging middleware
- **Throttled model**: `createThrottledModel(model, semaphore)` wraps `doGenerate`/`doStream` with p-limit semaphore
- **Progress reporting**: `ServerProgressReporter` interface with `SpinnerProgressReporter` (sequential) and `ParallelProgressReporter` (parallel)
- **Parallel display**: `src/pipeline/parallel-progress.ts` -- multi-line TTY status table with ANSI escapes; non-TTY line-based fallback; buffer-and-flush for warnings
- **compileServer signature**: `(unit, config, hash, model, logContext, reporter)` -- per-server model+logContext enables safe concurrent execution
- **Per-server artifacts**: `generated/servers/{serverName}/compiled-policy.json` and `test-scenarios.json`
- **Schema enforcement**: `buildCompilerResponseSchema(names, tools, { requireServer: true })` makes `server` field required
- **Merge**: `mergeServerResults()` concatenates rules sorted alphabetically by server; `deduplicateListDefinitions()` first-wins
- **Types**: `ServerCompiledPolicyFile` in `types.ts`; `ServerCompilationUnit`/`ServerCompilationResult` internal to pipeline-runner
- **CLI**: `--server <name>` flag for single-server debugging via `serverFilter` on `PipelineRunConfig`
- **PipelineModels**: includes `baseLlm: LanguageModelV3` field for per-server model creation

## Memory Opt-In Helpers (per-persona memory)
- **Pure helper**: `src/memory/memory-policy.ts` -- `isMemoryEnabledFor(inputs)` + `MemoryGateInputs`; type-only imports of PersonaDefinition/JobDefinition/ResolvedUserConfig (no runtime cycle)
- **Loader-aware wrapper**: `src/persona/memory-gate.ts` -- `isMemoryEnabledForPersonaName(name, userConfig)`; fail-closed try/catch on loadPersona
- **Schema fields**: `PersonaMemoryConfig` in `src/persona/types.ts`, `JobMemoryConfig` in `src/cron/types.ts`; both `{ enabled: boolean }`, optional on parent
- **Cycle gotcha**: putting the loader-aware variant in `src/memory/` would close `memory/ -> persona/ -> memory/` cycle. Keep loader-aware on persona/ side
- **Orchestrator wiring**: `WorkflowOrchestratorDeps.userConfig: ResolvedUserConfig` required. `getRequiredServersForScope` adds `memory` when ANY persona in scope opts in. Test fixture `makeTestUserConfig()` in `test/workflow/test-helpers.ts`
- **Design**: `docs/designs/per-persona-memory-optin.md`

## OAuth Docker Support (Phase 1-2)
- **Module**: `src/docker/oauth-credentials.ts` -- credential detection, Keychain extraction, `detectAuthMethod()`
- **Providers**: `anthropicOAuthProvider`, `claudePlatformOAuthProvider` in `provider-config.ts` -- bearer injection
- **Config**: `IronCurtainConfig.dockerAuth?: { kind: 'oauth' | 'apikey' }` set by `prepareDockerInfrastructure()`
- **Adapter**: `getProviders(authKind?)` returns OAuth or API key providers; `buildEnv()` sets `CLAUDE_CODE_OAUTH_TOKEN` or `IRONCURTAIN_API_KEY`
- **DI pattern**: `detectAuthMethod(config, sources?)` -- `CredentialSources` interface for test injection (ESM can't spy on module-internal calls)
- **Env override**: `IRONCURTAIN_DOCKER_AUTH=apikey` forces API key mode
- **Design**: `docs/designs/oauth-docker-support.md`

## PTY Session & Escalation (see pty-escalation.md for details)
- **Shared infra**: `src/docker/docker-infrastructure.ts` -- `prepareDockerInfrastructure()` used by both createDockerSession() and runPtySession()
- **preBuiltInfrastructure**: DockerAgentSessionDeps field; skips proxy/orientation/image when set
- **Keystroke buffer**: `src/docker/keystroke-reconstructor.ts` -- KeystrokeBuffer (32KB cap) + LLM reconstruction
- **Escalation watcher**: `src/escalation/escalation-watcher.ts` -- shared module for polling + response writing

## TB1a: Domain Allowlists & Sandbox Containment Architecture
- **Untrusted domain gate**: structural invariant checks URL-role args against `serverDomainAllowlists` -- escalates (not denies) unknown domains
- **Domain allowlists source**: extracted from `mcp-servers.json` sandbox network `allowedDomains` (wildcards filtered out)
- **Domain matching**: `domainMatchesAllowlist()` exported from policy-engine -- exact match or `*.suffix` wildcard
- **Annotation-aware sandbox auto-allow**: only annotated path-category args trigger sandbox auto-allow and protected path checks; unannotated tools are denied as unknown
- **Git tool annotation strategy**: read-only ops (status/log/diff) use `path: ['read-path']` for sandbox containment; remote/destructive ops use `path: ['none']` to prevent sandbox auto-allow, letting compiled rules handle escalation
- **User constitution**: `getUserConstitutionPath()` in `src/config/paths.ts`; `loadConstitutionText()` in `src/pipeline/compile.ts` concatenates base + optional user constitution

## LLM Interaction Logging
- `src/pipeline/llm-logger.ts` -- AI SDK middleware capturing all LLM prompts/responses via `wrapLanguageModel()` + `LanguageModelMiddleware.wrapGenerate`
- Writes JSONL to `src/config/generated/llm-interactions.jsonl` (in .gitignore)
- Caller sets `LlmLogContext.stepName` before each phase (mutable context pattern)
- Middleware `specificationVersion: 'v3'` required for AI SDK v6

## Session Test Mocking Pattern
- `vi.mock('ai', ...)` to replace `generateText` with `vi.fn()`
- Mock `@ai-sdk/anthropic` with BOTH `anthropic` and `createAnthropic` (latter used by `createLanguageModel()` dynamic import)
- Also mock `@utcp/code-mode` (CodeModeUtcpClient)
- Mock result shape: `{ text, response: { messages: [...] }, totalUsage: { inputTokens, outputTokens, totalTokens } }`
- Test config must include `userConfig: ResolvedUserConfig` with all fields (agentModelId, policyModelId, anthropicApiKey, googleApiKey, openaiApiKey, escalationTimeoutSeconds, gooseProvider, gooseModel, preferredDockerAgent, autoApprove)
- GOTCHA: `messages` array passed by reference to `generateText`. Snapshot with `[...opts.messages]` at call time.
- Use `IRONCURTAIN_HOME` env var pointed at `/tmp/ironcurtain-test-<pid>` for isolation
- `createSession` factory adds `escalationDir` to session config

## MCP Roots Integration
- **Policy roots module**: `src/trusted-process/policy-roots.ts` -- `extractPolicyRoots()`, `toMcpRoots()`, `directoryForPath()`
- **MCPClientManager**: `connect()` takes optional `roots?: McpRoot[]` param, `addRoot()` with sync wait pattern
- **McpRoot interface**: exported from `mcp-client-manager.ts` -- `{ uri: string; name: string }`
- **Root sync pattern**: `addRoot` registers `rootsRefreshed` callback, calls `sendRootsListChanged()`, awaits callback when `roots/list` handler fires
- **TrustedProcess**: computes roots in constructor, passes to `connect()`, calls `addRoot()` after escalation approval
- **Node.js resolve() gotcha**: `resolve('/path/')` strips trailing slash; check for trailing slash *before* resolve

## User Configuration & Multi-Provider Models
- **User config module**: `src/config/user-config.ts` -- `loadUserConfig()`, `UserConfig`, `ResolvedUserConfig`, `USER_CONFIG_DEFAULTS`
- **Config path**: `src/config/paths.ts` -- `getUserConfigPath()` returns `{home}/config.json`; auto-created with defaults if missing
- **Resolution order**: env var > config file > defaults
- **IronCurtainConfig**: has `agentModelId`, `escalationTimeoutSeconds`, `userConfig: ResolvedUserConfig`; NO `anthropicApiKey`
- **Model provider module**: `src/config/model-provider.ts` -- `parseModelId()`, `createLanguageModel()`, `getKnownProviders()`
- **Qualified model ID format**: `"provider:model-id"`; bare IDs default to `anthropic`
- **Dynamic imports**: provider packages (`@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai`) via `await import()`
- **createLanguageModel()** returns `Promise<LanguageModelV3>` (from `@ai-sdk/provider`)
- **Env var overrides**: `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENAI_API_KEY`
- **Proxy escalation timeout**: passed via `ESCALATION_TIMEOUT_SECONDS` env var from sandbox to proxy child process

## Docker Agent Broker (Phase 1-4 complete)
- **Design**: `docs/design/docker-agent-broker.md`
- **Session mode**: `SessionMode` in `src/session/types.ts` -- `{ kind: 'builtin' }` or `{ kind: 'docker', agent: AgentId }`
- **Session factory**: `createSession({ mode })` -- delegates to `createBuiltinSession` or `createDockerSession`
- **Docker session**: `src/docker/docker-agent-session.ts` -- `DockerAgentSession` implements `Session`; `getBudgetStatus().tokenTrackingAvailable = false`
- **Agent adapter**: `src/docker/agent-adapter.ts` -- `AgentAdapter` interface, `AgentId` branded type, `ToolInfo`, `OrientationContext`, `detectCredential?`, `credentialHelpText?`
- **Agent registry**: `src/docker/agent-registry.ts` -- `registerAgent()`, `getAgent()`, `listAgents()`, `registerBuiltinAdapters(userConfig?)`
- **Claude Code adapter**: `src/docker/adapters/claude-code.ts`
- **Docker manager**: `src/docker/docker-manager.ts` -- `createDockerManager(execFileFn?)` with DI
- **UDS transport**: `src/trusted-process/uds-server-transport.ts` -- MCP SDK server transport over Unix domain sockets
- **Managed proxy**: `src/docker/managed-proxy.ts`; **CONNECT proxy**: `src/docker/connect-proxy.ts` (domain-allowlisted HTTP CONNECT)
- **Audit tailer**: `src/docker/audit-log-tailer.ts` -- tails JSONL via `fs.watch()`; file must exist before `start()`
- **Orientation**: `src/docker/orientation.ts` -- `prepareSession()` (sync), `extractAllowedDomains()`

## Goose Agent Integration
- **Adapter**: `src/docker/adapters/goose.ts` -- `createGooseAdapter(userConfig?)` factory; provider-aware
- **Config fields**: `gooseProvider`, `gooseModel`, `preferredDockerAgent` added to `UserConfig`/`ResolvedUserConfig`
- **Credential detection**: `docker-infrastructure.ts` delegates to `adapter.detectCredential()` when present
- **Preflight**: `preflight.ts` checks provider-specific API key for `goose`; uses `preferredDockerAgent` for auto-detect
- **Docker files**: `docker/Dockerfile.goose`, `docker/entrypoint-goose.sh`
- **MCP config**: YAML (`goose-config.yaml`); stdio/socat bridge
- **Response parsing**: `extractFinalResponse()` last text block; `stripAnsi()`; `escapeHeredoc()` unique delimiters
- **Test gotcha**: test configs must include `gooseProvider`, `gooseModel`, `preferredDockerAgent`

## Daemon Control Socket
- **Module**: `src/daemon/control-socket.ts` -- server + client + protocol types
- **Path helper**: `getDaemonSocketPath()` in `src/config/paths.ts` -- `{home}/daemon.sock`
- **Protocol**: newline-delimited JSON over Unix domain socket (one request/response per connection)
- **Server**: `ControlSocketServer` -- takes `ControlRequestHandler`; started/stopped by `IronCurtainDaemon`
- **Client**: `sendControlRequest()` and `isDaemonRunning()` -- used by `daemon-command.ts`
- **Forwarded commands**: remove-job, enable-job, disable-job, recompile-job, run-job, list-jobs; CLI falls back to filesystem when no daemon

## Tool Call Coordinator & Pipeline (see tool-call-coordinator.md)
- `src/trusted-process/tool-call-pipeline.ts` -- core security pipeline: `handleCallTool`, types, helpers
- `src/trusted-process/tool-call-coordinator.ts` owns PolicyEngine + AuditLog + CallCircuitBreaker + ApprovalWhitelist + ServerContextMap
- `src/trusted-process/mcp-proxy-server.ts` -- thin subprocess: MCP transport + OAuth + pass-through only
- Custom UTCP protocol at `src/sandbox/ironcurtain-protocol.ts` (`call_template_type: 'ironcurtain'`)
- **CRITICAL**: UTCP's `variableSubstitutor.substitute()` deep-clones class instances into plain objects. Use module-level `Map<manualName, instance>` for live references.
- `_policyDecision?` field on `ToolCallResponse` carries engine decision; used by `handleStructuredToolCall`

## Subsystems (see subsystems.md)
- **Session Logging**: `src/logger.ts` -- singleton with `setup()`/`teardown()`; test gotcha: must call `teardown()` in `afterEach`
- **Execution Containment**: `src/trusted-process/sandbox-integration.ts` -- wraps MCP servers in `srt` processes
- **Auto-Approver**: `src/trusted-process/auto-approver.ts` -- `autoApprove()` with LLM; `autoApprove` field required in `ResolvedUserConfig`

## Web UI Testing (see web-ui-testing.md)
- Svelte 5 stub-component pattern for `vi.mock`, App.svelte mocking, drawer query pattern
- Stub fixtures: `packages/web-ui/src/__test_stubs__/{RouteStub,Empty}.svelte`

## Design Documents
- `docs/designs/policy-compilation-pipeline.md`, `multi-server-onboarding.md` (TB1a), `multi-provider-models.md`, `dynamic-lists.md`, `tb1c-constitution-customizer.md`, `scenario-generator-multi-turn.md`, `pty-escalation-listener.md`, `persona-system.md`

## Testing Gotchas
- **createWriteStream sync vs async errors** (see `createWriteStream-sync-vs-async.md`) -- missing-parent paths emit async `'error'` events, NOT sync throws. Test with `vi.mock('node:fs', ...)` + path-scoped toggle.
