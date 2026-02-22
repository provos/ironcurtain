# IronCurtain Copilot Review Instructions

IronCurtain is a secure agent runtime that mediates between an AI agent and MCP servers. Every tool call passes through a trusted process that evaluates it against policy rules before forwarding. The policy engine and MCP proxy are the security boundary.

## Security Invariants

- Every tool call MUST pass through `policyEngine.evaluate()` before forwarding to a real MCP server. Any code path that skips evaluation is a security bypass.
- Path containment checks MUST use `resolveRealPath()` (symlink resolution) before comparison. Raw `path.resolve()` is a symlink-escape vulnerability.
- `isWithinDirectory()` appends a trailing `/` before `startsWith()`. Without it, `/tmp/sandbox-evil` matches `/tmp/sandbox`.
- Multi-role evaluation uses most-restrictive-wins (deny > escalate > allow). Least-restrictive is a privilege escalation.
- Unknown tools (without annotations) MUST be denied. Allowing them bypasses the annotation requirement.
- The auto-approver can only return `approve` or `escalate`, never `deny`. Error paths must return `escalate` (fail-open to human).
- `SERVER_CREDENTIALS` must be deleted from `process.env` immediately after parsing to prevent child process leakage.
- Audit logging must occur for every tool call outcome. No code path should skip it.

## AI SDK v6 API (Breaking Changes)

This project uses AI SDK v6. Any use of the old API will fail at runtime:

- `tool()` uses `inputSchema` (NOT `parameters`)
- `generateText()` uses `stopWhen: [stepCountIs(n)]` (NOT `maxSteps`)
- Tool call results use `toolCalls[].input` (NOT `.args`)
- `CoreTool` is now `ToolSet`

## Code Conventions

- All imports MUST use `.js` extensions (Node16 module resolution). Missing extensions cause runtime failures.
- `PolicyDecisionStatus` is a three-state union: `allow | deny | escalate`. Code handling only `allow`/`deny` without `escalate` has a missing case.
- User-facing output uses `process.stdout.write()` / `process.stderr.write()`, NOT `console.log()` (intercepted by logger module).
- Shell commands must use `shell-quote` for construction, not string concatenation or template literals.

## Common Mistakes

1. Missing `.js` extension in imports
2. Using old AI SDK v4/v5 API (`parameters`, `maxSteps`, `.args`, `CoreTool`)
3. Path comparison without symlink resolution (`path.resolve()` instead of `resolveRealPath()`)
4. Handling only `allow`/`deny` without `escalate`
5. Skipping audit logging in proxy or trusted process code paths
6. Passing raw arguments to policy engine instead of `argsForPolicy` from `prepareToolArgs()`
7. String concatenation for shell commands instead of `shell-quote`
8. Using `console.log` in session/transport code
