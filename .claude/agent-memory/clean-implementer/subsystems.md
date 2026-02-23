# Subsystem Details

## Execution Containment (TB0)
- **Sandbox integration module**: `src/trusted-process/sandbox-integration.ts` -- wraps MCP servers in `srt` CLI processes
- **Key exports**: `checkSandboxAvailability()`, `resolveSandboxConfig()`, `writeServerSettings()`, `wrapServerCommand()`, `cleanupSettingsFiles()`, `annotateSandboxViolation()`
- **Types**: `ResolvedSandboxConfig` (discriminated union: sandboxed true/false), `ResolvedSandboxParams`, `SandboxAvailabilityResult`
- **Config types** (in `src/config/types.ts`): `SandboxNetworkConfig`, `SandboxFilesystemConfig`, `ServerSandboxConfig`, `SandboxAvailabilityPolicy`
- **MCPServerConfig**: has `sandbox?: ServerSandboxConfig` (false = opt-out, object = overrides, omitted = restrictive defaults)
- **IronCurtainConfig**: has `sandboxPolicy?: SandboxAvailabilityPolicy` (default 'warn')
- **AuditEntry**: has `sandboxed?: boolean` field
- **Per-server srt processes**: each sandboxed server gets its own `srt` CLI process with independent proxy infrastructure (true network isolation)
- **Settings files**: `{tempDir}/{serverName}.srt-settings.json` with `network` and `filesystem` sections
- **Command wrapping**: `srt -s <settingsPath> -c <shell-quoted-cmd>` via `shell-quote` for escaping
- **srt binary**: `resolve('node_modules/.bin/srt')` -- from `@anthropic-ai/sandbox-runtime`
- **Shell-quote types**: `src/types/shell-quote.d.ts` (no `@types/shell-quote` available)
- **Sandbox-by-default**: omitted sandbox field = sandboxed with restrictive defaults (no network, only session sandbox dir writable)
- **Default denyRead**: `['~/.ssh', '~/.gnupg', '~/.aws']`
- **Env var**: `SANDBOX_POLICY` passed from `src/sandbox/index.ts` to proxy process
- **Env passing fix**: proxy always passes `{ ...process.env, ...config.env }` to StdioClientTransport (never undefined)
- **Violation annotation**: `annotateSandboxViolation()` prefixes EPERM/EACCES errors with `[SANDBOX BLOCKED]` for sandboxed servers
- **mcp-servers.json**: filesystem server has `"sandbox": false` (opt-out, mediated by policy engine)
- **Tests**: `test/sandbox-integration.test.ts` -- 32 unit tests + 3 integration tests (gated behind platform check)
- **Design spec**: `docs/designs/execution-containment.md`

## Escalation Auto-Approver
- **Module**: `src/trusted-process/auto-approver.ts` -- `autoApprove()`, `readUserContext()`, types
- **Config**: `autoApprove: { enabled: boolean, modelId: string }` in `ResolvedUserConfig` (off by default)
- **Config schema**: `autoApproveSchema` in `src/config/user-config.ts` -- mirrors `autoCompactSchema` pattern
- **Model creation**: `createLanguageModelFromEnv(qualifiedId, apiKey)` in `src/config/model-provider.ts` -- for proxy env-var-only usage
- **API key resolution**: `resolveApiKeyForProvider(provider, config)` extracts correct key from `ResolvedUserConfig`
- **Proxy env vars**: `AUTO_APPROVE_ENABLED`, `AUTO_APPROVE_MODEL_ID`, `AUTO_APPROVE_API_KEY`, `AUTO_APPROVE_LLM_LOG_PATH`
- **User context IPC**: `user-context.json` written to escalation dir by `AgentSession.sendMessage()`, read by proxy on escalation
- **Audit trail**: `autoApproved?: boolean` on `AuditEntry` in `src/types/audit.ts`
- **Log path**: `getSessionAutoApproveLlmLogPath()` in `src/config/paths.ts` -- `{sessionDir}/auto-approve-llm.jsonl`
- **IronCurtainConfig**: has `autoApproveLlmLogPath?: string` for per-session auto-approve LLM logging
- **Security invariants**: can only return `approve` or `escalate` (never `deny`); all errors fail-open to human; tool args excluded from LLM prompt
- **In-process mode**: `TrustedProcess.setLastUserMessage()` + `autoApproveModel` field; model created in `initialize()`
- **Tests**: `test/auto-approver.test.ts` -- 17 unit tests using `MockLanguageModelV3`; config tests in `test/user-config.test.ts`
- **Test config gotcha**: `ResolvedUserConfig` now requires `autoApprove` field -- all test files creating this type must include it

## Session Logging System
- **Logger module**: `src/logger.ts` -- module-level singleton with `setup()`/`teardown()` lifecycle
- **Log file**: `~/.ironcurtain/sessions/{id}/session.log` (path via `getSessionLogPath()` in `src/config/paths.ts`)
- **API**: `logger.debug/info/warn/error()` -- no-ops when not set up (safe for code running outside sessions)
- **Console interception**: `setup()` patches `console.log/error/warn/debug` to redirect to log file; `teardown()` restores originals
- **User-facing output**: must use `process.stdout.write()` / `process.stderr.write()` to bypass interception
- **Lifecycle**: `createSession()` calls `setup()` after mkdirSync; `AgentSession.close()` calls `teardown()` at the end
- **Excluded**: `mcp-proxy-server.ts` (separate process) and `pipeline/compile.ts` (standalone CLI)
- **Test gotcha**: session tests must call `logger.teardown()` in `afterEach` to prevent "Logger already set up" errors
- **Design spec**: `docs/logging-design.md`
