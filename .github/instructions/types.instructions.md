---
applyTo: "src/types/**"
---

# Types Review Rules

Types in this directory define security-critical contracts shared across the codebase.

## Mandatory Checks

- `PolicyDecisionStatus` must remain a three-state union: `allow | deny | escalate`. Adding or removing states changes the security model.
- `ArgumentRole` is a union type with a compile-time completeness check (`_ROLE_COMPLETENESS_CHECK`). Adding a new role requires updating: the union type, the registry map, the completeness check record, and any relevant tool annotations.
- `resolveRealPath()` in `argument-roles.ts` is the canonical path resolution function. It must try `realpathSync()` first (symlink resolution), then parent-based resolution, then `path.resolve()` fallback. Simplifying the fallback chain removes symlink protection.
- `SANDBOX_SAFE_PATH_ROLES` controls which path roles bypass compiled rule evaluation when inside the sandbox. Only `read-path`, `write-path`, and `delete-path` should be in this set. Adding `write-history` or `delete-history` would allow dangerous git operations to skip policy evaluation.
- `SessionId` uses a branded type pattern. Do not remove the `__brand` property or accept plain `string` where `SessionId` is expected.
- `RoleDefinition.serverNames` controls which servers see a role in annotation prompts. Universal roles (no `serverNames`) appear for all servers. Accidental removal of `serverNames` would expose server-specific roles globally.
