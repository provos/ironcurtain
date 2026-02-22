---
applyTo: "src/trusted-process/**"
---

# Security Boundary Review Rules

Files in `src/trusted-process/` form the security kernel of IronCurtain. Every change here requires careful review against these invariants.

## Mandatory Checks

- Every tool call must pass through `policyEngine.evaluate()` before forwarding. Look for code paths that skip evaluation.
- `prepareToolArgs()` must be called to normalize arguments before policy evaluation. Raw `request.arguments` must not be passed to `policyEngine.evaluate()`.
- Audit logging must occur for every tool call outcome. Verify no code path exits without calling the audit log.
- The three-state decision (`allow | deny | escalate`) must be fully handled. Check switch statements and if/else chains for missing `escalate` handling.
- Path operations must use `resolveRealPath()` from `src/types/argument-roles.ts`, not raw `path.resolve()`. The symlink resolution is security-critical.
- `isWithinDirectory()` must use `resolvedDir + '/'` in the `startsWith()` check. Without the trailing slash, `/tmp/sandbox-evil` would match `/tmp/sandbox`.
- Protected path checks must resolve both sides through symlinks before comparison.
- The `SERVER_CREDENTIALS` env var must be deleted from `process.env` immediately after parsing to prevent child process inheritance.
- Error paths in the auto-approver must return `escalate`, never `approve`. The auto-approver can never return `deny`.
- The circuit breaker must run AFTER policy evaluation to ensure every call is audited.

## Structural Invariant Order

The structural invariant evaluation order is security-critical and must not be reordered:
1. Protected path check (immediate deny)
2. Filesystem sandbox containment (allow for filesystem server only, partial resolution for mixed-path tools)
3. Untrusted domain gate (escalate for unrecognized URL domains)
4. Unknown tool denial (deny tools without annotations)

Any early return added before the protected path check is a security defect.
