---
applyTo: "src/types/**"
---

# Types Review Rules

Types in this directory define security-critical contracts shared across the codebase.

## Mandatory Checks

- `PolicyDecisionStatus` must remain a three-state union: `allow | deny | escalate`. Adding or removing states changes the security model.
- `ArgumentRole` is a union type with a compile-time completeness check (`_ROLE_COMPLETENESS_CHECK`). Adding a new role requires updating: the union type, the registry map, the completeness check record, and any relevant tool annotations.
- `resolveRealPath()` in `argument-roles.ts` is the canonical path resolution function. It must try `realpathSync()` first (symlink resolution), then parent-based resolution, then `path.resolve()` fallback. Simplifying the fallback chain removes symlink protection.
- `SANDBOX_SAFE_PATH_ROLES` controls which path roles bypass compiled rule evaluation when all paths resolve inside the sandbox. The set includes `read-path`, `write-path`, `delete-path`, `write-history`, and `delete-history`. The history roles are safe here because they only discharge the *path* component — git operations that also carry a `git-remote-url` role (e.g., `git_push`) still require compiled rule evaluation for the URL role. Do not add non-path roles (like `git-remote-url` or `github-repo`) to this set.
- `SessionId` uses a branded type pattern. Do not remove the `__brand` property or accept plain `string` where `SessionId` is expected.
- `RoleDefinition.serverNames` controls which servers see a role in annotation prompts. Universal roles (no `serverNames`) appear for all servers. Accidental removal of `serverNames` would expose server-specific roles globally.
- `resolveStoredAnnotation()` in `argument-roles.ts` is the sole boundary where conditional role specs are resolved into plain `ArgumentRole[]`. Conditional roles can only **narrow** from the default (subset invariant enforced by Zod). Do not add alternative resolution paths — all consumers must receive pre-resolved `ToolAnnotation`.
