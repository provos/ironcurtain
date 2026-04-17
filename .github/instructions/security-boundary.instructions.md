---
applyTo: "src/trusted-process/**"
---

# Security Boundary Review Rules

Files in `src/trusted-process/` form the security kernel of IronCurtain. Every change here requires careful review against these invariants.

## Mandatory Checks

- Every tool call must pass through `ToolCallCoordinator.handleToolCall()` (which invokes the `handleCallTool` pipeline in `tool-call-pipeline.ts`). Look for code paths that bypass the coordinator or route directly to proxy subprocesses.
- `prepareToolArgs()` must be called to normalize arguments before policy evaluation. Raw `request.arguments` must not be passed to `policyEngine.evaluate()`.
- Audit logging must occur for every tool call outcome. Verify no code path exits without calling the audit log. The single `AuditLog` instance lives in the coordinator — proxy subprocesses do not write audit entries.
- The three-state decision (`allow | deny | escalate`) must be fully handled. Check switch statements and if/else chains for missing `escalate` handling.
- Path operations must use `resolveRealPath()` from `src/types/argument-roles.ts`, not raw `path.resolve()`. The symlink resolution is security-critical.
- `isWithinDirectory()` must use `resolvedDir + '/'` in the `startsWith()` check. Without the trailing slash, `/tmp/sandbox-evil` would match `/tmp/sandbox`.
- Protected path checks must resolve both sides through symlinks before comparison.
- The `SERVER_CREDENTIALS` env var must be deleted from `process.env` immediately after parsing to prevent child process inheritance.
- Error paths in the auto-approver must return `escalate`, never `approve`. The auto-approver can never return `deny`.
- The circuit breaker (inside the coordinator) must run AFTER policy evaluation to ensure every call is audited.
- **Trust-boundary validation**: at every point where data crosses into the kernel from untrusted or out-of-process sources (file-IPC escalation responses, subprocess JSON, parsed config, env vars), runtime-validate every field you read. TypeScript `as` casts are erased at runtime and provide no security guarantee. Fail closed — unrecognized values must deny, never fall through to approve.
- **Authoritative over derived**: classify a response's outcome (allow / deny / escalate / error) from the authoritative decision field (e.g., `_policyDecision.status`), not from substring matching on human-readable error text. Text matching silently breaks when a new producer writes a message that doesn't match the expected prefixes.
- **Audit completeness**: every early return from `handleCallTool` must write an audit entry first. Silent early returns (unknown-tool, missing-annotation, internal errors) hide routing bugs, annotation drift, and unknown-tool probes from audit review.
- **Populated-in-production check**: optional fields used in security decisions (e.g., `resolvedSandboxConfigs` for `AuditEntry.sandboxed` and `[SANDBOX BLOCKED]` annotation) must be actually populated by every production wiring path, not just theoretically populatable. Verify with an end-to-end test that exercises the full wiring, not just unit tests with hand-built inputs.

## Structural Invariant Order

The structural invariant evaluation order is security-critical and must not be reordered:
1. Protected path check (immediate deny)
2. Filesystem sandbox containment (allow for filesystem server only, partial resolution for mixed-path tools)
3. Untrusted domain gate (escalate for unrecognized URL domains)
4. Unknown tool denial (deny tools without annotations)

Any early return added before the protected path check is a security defect.
