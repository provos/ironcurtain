# IronCurtain Clean Implementer Memory

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

## AI SDK v6 Type Gotchas
- `ToolSet` type (not `Record<string, ReturnType<typeof tool>>`) for tool collections -- avoids `Tool<never, never>` inference
- `LanguageModelUsage` uses `inputTokens`/`outputTokens`/`totalTokens` (NOT `promptTokens`/`completionTokens`)
- `onStepFinish` callback receives `(stepResult: StepResult<TOOLS>)` -- no `stepIndex` parameter
- `ModelMessage` importable from both `ai` and `@ai-sdk/provider-utils`

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

## validateCompiledRules Signature
`validateCompiledRules(rules: CompiledRule[], listDefinitions?: ListDefinition[])` -- validates rules + list cross-references.

## Zod v4 Strict Mode
Zod v4 (^4.3.6) strict by default. Mock response JSON must exactly match Zod schema -- no extra properties.

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
- **Tests**: `test/dynamic-lists.test.ts` -- 60 tests (Phase 1 validation/compiler + Phase 2 registry/resolver/engine + Phase 3 MCP-backed resolution)

## Constitution Customizer (TB1c) & Auto-Constitution Generation
- **Global customizer**: `src/pipeline/constitution-customizer.ts` -- LLM-assisted conversational CLI
- **Exports**: `buildSystemPrompt()`, `buildUserMessage()`, `formatAnnotationsForPrompt()`, `computeLineDiff()`, `formatDiff()`, `applyChanges()`, `callLlm()`, `loadAnnotations()`, `writeConstitution()`, `revertConstitution()`, `seedBaseConstitution()`
- **Job customizer**: `src/cron/job-customizer.ts` -- `runJobConstitutionCustomizer(initialConstitution, taskDescription)` returns `string | undefined`; operates in-memory (no file I/O)
- **Constitution generator**: `src/cron/constitution-generator.ts` -- `generateConstitution(options)` runs Code Mode session with read-only policy; exports `buildConstitutionGeneratorSystemPrompt()`, `parseConstitutionResponse()`
- **Read-only policy**: `src/config/constitution-readonly.md` + `src/config/generated-readonly/compiled-policy.json`
- **Path helpers**: `getReadOnlyPolicyDir()`, `getPackageConfigDir()` in `src/config/paths.ts`
- **CLI flags**: `compile-policy --constitution <path> --output-dir <path>` parsed by `parseCompilePolicyArgs()` in `compile.ts`
- **Pipeline config**: `loadPipelineConfig(overrides?)` accepts `PipelineConfigOverrides` with `constitution?` and `outputDir?`
- **Session policyDir validation**: `validatePolicyDir()` accepts paths under IronCurtain home OR package config dir
- **Job commands**: `job-commands.ts` review loop has `generateConstitution` and `customizeConstitution` menu options
- **Build**: `copy-assets.mjs` copies `constitution-readonly.md` + `generated-readonly/` to `dist/config/`
- **Tests**: `test/constitution-generator.test.ts`, `test/job-customizer.test.ts`, `test/compile-policy-cli.test.ts`, `test/readonly-policy-paths.test.ts`

## Scenario Generation & Repair
- **Batched generation**: `generateScenarios()` in scenario-generator.ts; batches of SCENARIO_BATCH_SIZE=25; per-batch scoped schema
- **repairScenarios()**: single-shot LLM call to replace structurally discarded scenarios; wired into `compileServer`
- **DiscardedScenario**: in `src/pipeline/types.ts`; has `scenario`, `actual`, `rule` fields
- **parseJsonWithSchema()**: exported from generate-with-repair.ts; shared extraction+validation
- **Design**: `docs/designs/scenario-generation-batching.md`

## Persona System
- **Design**: `docs/designs/persona-system.md`
- **Types**: `src/persona/types.ts` -- `PersonaName` (branded), `PersonaDefinition`, `PERSONA_NAME_PATTERN`, `createPersonaName()`
- **Resolver**: `src/persona/resolve.ts` -- path helpers, `loadPersona()`, `resolvePersona()`, `applyServerAllowlist()`
- **Compilation**: `src/persona/compile-persona-policy.ts` -- `compilePersonaPolicy(name)` wraps PipelineRunner with `constitutionKind: 'constitution'`
- **Prompt**: `src/persona/persona-prompt.ts` -- `buildPersonaSystemPromptAugmentation(persona, memoryPath)`
- **Customizer**: `src/persona/persona-customizer.ts` -- `runPersonaConstitutionCustomizer()` same pattern as job-customizer
- **CLI**: `src/persona/persona-command.ts` -- subcommands: create, list, compile, edit, delete, show
- **Session integration**: `persona?: string` in `SessionOptions`; resolved in `buildSessionConfig()` via static import of resolve.ts
- **Constitution generator**: `context?: 'cron' | 'persona'` added to `ConstitutionGeneratorOptions` in `src/cron/constitution-generator.ts`
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
- **PipelineModels**: now includes `baseLlm: LanguageModelV3` field for per-server model creation

## Design Documents
- `docs/designs/policy-compilation-pipeline.md` -- pipeline design spec
- `docs/designs/multi-server-onboarding.md` -- TB1a design spec (role extensibility + git server)
- `docs/designs/multi-provider-models.md` -- multi-provider model support design
- `docs/designs/dynamic-lists.md` -- dynamic lists for policy rules (4-phase)
- `docs/designs/tb1c-constitution-customizer.md` -- LLM-assisted constitution customization
- `docs/designs/scenario-generator-multi-turn.md` -- multi-turn scenario generation with prompt caching
- `docs/designs/pty-escalation-listener.md` -- PTY mode + escalation listener (see `pty-escalation.md`)
- `docs/designs/persona-system.md` -- persona system design spec

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
- **AI SDK v6**: use `maxOutputTokens` not `maxTokens` in generateText()

## TB1a: Domain Allowlists & Sandbox Containment Architecture
- **Untrusted domain gate**: structural invariant checks URL-role args against `serverDomainAllowlists` -- escalates (not denies) unknown domains
- **Domain allowlists source**: extracted from `mcp-servers.json` sandbox network `allowedDomains` (wildcards filtered out)
- **Domain matching**: `domainMatchesAllowlist()` exported from policy-engine -- exact match or `*.suffix` wildcard
- **Annotation-aware sandbox auto-allow**: only annotated path-category args trigger sandbox auto-allow and protected path checks; unannotated tools are denied as unknown
- **Git tool annotation strategy**: read-only ops (status/log/diff) use `path: ['read-path']` for sandbox containment; remote/destructive ops use `path: ['none']` to prevent sandbox auto-allow, letting compiled rules handle escalation
- **User constitution**: `getUserConstitutionPath()` in `src/config/paths.ts`; `loadConstitutionText()` in `src/pipeline/compile.ts` concatenates base + optional user constitution

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
- Mock `@ai-sdk/anthropic` with BOTH `anthropic` and `createAnthropic` (latter used by `createLanguageModel()` dynamic import)
- Also mock `@utcp/code-mode` (CodeModeUtcpClient)
- Mock `generateText` result shape: `{ text, response: { messages: [...] }, totalUsage: { inputTokens, outputTokens, totalTokens } }`
- Test config must include `userConfig: ResolvedUserConfig` with all 6 fields (agentModelId, policyModelId, anthropicApiKey, googleApiKey, openaiApiKey, escalationTimeoutSeconds)
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

## User Configuration & Multi-Provider Models
- **User config module**: `src/config/user-config.ts` -- `loadUserConfig()`, `UserConfig`, `ResolvedUserConfig`, `USER_CONFIG_DEFAULTS`
- **Config path**: `src/config/paths.ts` -- `getUserConfigPath()` returns `{home}/config.json`
- **Config file**: `~/.ironcurtain/config.json` -- auto-created with defaults if missing
- **Fields**: `agentModelId`, `policyModelId`, `anthropicApiKey`, `googleApiKey`, `openaiApiKey`, `escalationTimeoutSeconds` (all optional in file)
- **Resolution order**: env var > config file > defaults
- **IronCurtainConfig**: has `agentModelId`, `escalationTimeoutSeconds`, `userConfig: ResolvedUserConfig`; NO `anthropicApiKey` (removed)
- **Model provider module**: `src/config/model-provider.ts` -- `parseModelId()`, `createLanguageModel()`, `getKnownProviders()`
- **Qualified model ID format**: `"provider:model-id"` (e.g., `"anthropic:claude-sonnet-4-6"`, `"google:gemini-2.0-flash"`)
- **Bare model IDs** (no colon) default to `anthropic` for backward compat
- **Dynamic imports**: provider packages (`@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai`) loaded via `await import()`
- **Return type**: `createLanguageModel()` returns `Promise<LanguageModelV3>` (from `@ai-sdk/provider`), NOT `LanguageModel` (union with string)
- **LanguageModel type gotcha**: AI SDK v6 `LanguageModel = GlobalProviderModelId | LanguageModelV3 | LanguageModelV2` -- includes string. Use `LanguageModelV3` from `@ai-sdk/provider` for concrete model return types.
- **Zod validation**: `qualifiedModelId` refine validates known provider prefix before model creation
- **Env var overrides**: `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENAI_API_KEY`
- **Proxy escalation timeout**: passed via `ESCALATION_TIMEOUT_SECONDS` env var from sandbox to proxy child process
- **Pipeline model**: `compile.ts` calls `loadUserConfig()` + `createLanguageModel()` directly (standalone CLI)
- **Tests**: `test/user-config.test.ts` and `test/model-provider.test.ts` -- uses `IRONCURTAIN_HOME` temp dirs for isolation
- **Zod validation**: unknown fields warn to stderr, invalid types/values throw

## Docker Agent Broker (Phase 1-4 complete)
- **Design**: `docs/design/docker-agent-broker.md` -- full design spec
- **Session mode**: `SessionMode` in `src/session/types.ts` -- `{ kind: 'builtin' }` or `{ kind: 'docker', agent: AgentId }`
- **Session factory**: `createSession({ mode })` in `src/session/index.ts` -- delegates to `createBuiltinSession` or `createDockerSession`
- **Docker session**: `src/docker/docker-agent-session.ts` -- `DockerAgentSession` implements `Session`; `getBudgetStatus().tokenTrackingAvailable = false`
- **Agent adapter**: `src/docker/agent-adapter.ts` -- `AgentAdapter` interface, `AgentId` branded type, `ToolInfo`, `OrientationContext`
- **Agent registry**: `src/docker/agent-registry.ts` -- `registerAgent()`, `getAgent()`, `listAgents()`, `registerBuiltinAdapters()`
- **Claude Code adapter**: `src/docker/adapters/claude-code.ts` -- reference adapter; no self-registration (test compat)
- **Docker manager**: `src/docker/docker-manager.ts` -- `createDockerManager(execFileFn?)` with DI for testability
- **UDS transport**: `src/trusted-process/uds-server-transport.ts` -- MCP SDK server transport over Unix domain sockets
- **Managed proxy**: `src/docker/managed-proxy.ts` -- spawns MCP proxy with `PROXY_SOCKET_PATH`, polls socket readiness, `UdsClientTransport` for tool listing
- **CONNECT proxy**: `src/docker/connect-proxy.ts` -- domain-allowlisted HTTP CONNECT tunneling for LLM API access
- **Audit tailer**: `src/docker/audit-log-tailer.ts` -- tails JSONL audit log via `fs.watch()`, emits `DiagnosticEvent`s; file must exist before `start()`
- **Orientation**: `src/docker/orientation.ts` -- `prepareSession()` (sync), `extractAllowedDomains()`
- **CLI**: `--agent <name>` flag in `src/index.ts`, `--list-agents` to show registered adapters
- **Tests**: `test/docker-session.test.ts` (20), `test/docker-agent-adapter.test.ts` (15), `test/docker-manager.test.ts` (18), `test/connect-proxy.test.ts` (6), `test/uds-server-transport.test.ts` (8)

## Goose Agent Integration
- **Adapter**: `src/docker/adapters/goose.ts` -- `createGooseAdapter(userConfig?)` factory; provider-aware (anthropic/openai/google)
- **Config fields**: `gooseProvider`, `gooseModel`, `preferredDockerAgent` added to `UserConfig`/`ResolvedUserConfig`
- **AgentAdapter extensions**: `detectCredential?(config)` and `credentialHelpText?` added to interface in `agent-adapter.ts`
- **Credential detection**: `docker-infrastructure.ts` delegates to `adapter.detectCredential()` when present
- **Registry**: `registerBuiltinAdapters(userConfig?)` accepts optional config; imports goose adapter dynamically
- **Preflight**: `preflight.ts` checks provider-specific API key for `goose` agent; uses `preferredDockerAgent` for auto-detect
- **Docker files**: `docker/Dockerfile.goose` (Goose binary install), `docker/entrypoint-goose.sh` (bridge + config copy)
- **MCP config**: YAML format (`goose-config.yaml`); Goose extensions format with stdio/socat bridge
- **Response parsing**: heuristic `extractFinalResponse()` extracts last text block; `stripAnsi()` for ANSI removal
- **Heredoc safety**: `escapeHeredoc()` generates unique delimiters when content collides
- **Tests**: `test/goose-adapter.test.ts` -- 70 tests covering all adapter methods + helpers
- **Config UI**: `config-command.ts` has Goose section (provider, model, preferred agent)
- **Key test gotcha**: test configs with `userConfig: ResolvedUserConfig` must include `gooseProvider`, `gooseModel`, `preferredDockerAgent`

## Daemon Control Socket
- **Module**: `src/daemon/control-socket.ts` -- server + client + protocol types
- **Path helper**: `getDaemonSocketPath()` in `src/config/paths.ts` -- `{home}/daemon.sock`
- **Protocol**: newline-delimited JSON over Unix domain socket (one request line, one response line per connection)
- **Server**: `ControlSocketServer` -- takes `ControlRequestHandler` interface; started/stopped by `IronCurtainDaemon`
- **Client**: `sendControlRequest()` and `isDaemonRunning()` -- used by `daemon-command.ts` to detect+forward
- **Forwarded commands**: remove-job, enable-job, disable-job, recompile-job, run-job, list-jobs
- **Fallback**: CLI commands operate directly on filesystem when no daemon is running
- **Tests**: `test/control-socket.test.ts` -- 17 tests

## Subsystems (see subsystems.md for details)
- **Session Logging**: `src/logger.ts` -- singleton with `setup()`/`teardown()`; test gotcha: must call `teardown()` in `afterEach`
- **Execution Containment**: `src/trusted-process/sandbox-integration.ts` -- wraps MCP servers in `srt` processes
- **Auto-Approver**: `src/trusted-process/auto-approver.ts` -- `autoApprove()` with LLM; `autoApprove` field required in `ResolvedUserConfig`
