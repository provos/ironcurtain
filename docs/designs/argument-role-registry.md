# ArgumentRole Registry Design

## Problem

Argument role definitions (`'read-path' | 'write-path' | 'delete-path' | 'none'`) are scattered as hardcoded string literals across six files. Path normalization in `path-utils.ts` uses fragile heuristics (checking if strings start with `/`, `.`, or `~`) instead of leveraging the tool annotations that already classify every argument. This creates two problems:

1. **Fragile normalization**: A `content` argument containing `/etc/passwd` gets normalized as if it were a path. A string like `./disclaimer text` is incorrectly treated as a path.
2. **Scattered role knowledge**: Adding a new role requires finding and updating every hardcoded reference across the codebase.

## Solution

A central **ArgumentRole registry** that pairs each role with its semantic metadata and normalizer function. Normalization becomes annotation-driven: for each tool call argument, the registry looks up the argument's annotated roles and applies the corresponding normalizer. The heuristic is retained only as defense-in-depth inside the policy engine.

## Registry Interface

### `src/types/argument-roles.ts`

```typescript
export type ArgumentRole = 'read-path' | 'write-path' | 'delete-path' | 'none';

export interface RoleDefinition {
  readonly description: string;
  readonly isResourceIdentifier: boolean;
  readonly category: RoleCategory;
  readonly canonicalize: (value: string) => string;
}

export const ARGUMENT_ROLE_REGISTRY: ReadonlyMap<ArgumentRole, RoleDefinition>;
```

Each role definition provides:

- **`description`** -- Human-readable explanation of the role's security semantics.
- **`isResourceIdentifier`** -- True if the role tags an argument that names an external resource (filesystem path, URL, etc.). False for `'none'`. Replaces all `role !== 'none'` checks in the codebase.
- **`canonicalize`** -- Canonicalizes a string argument value for transport to the MCP server. For path roles: tilde expansion + symlink-aware `resolveRealPath()` (follows symlinks via `realpathSync`, with fallbacks for non-existent paths). For `'none'`: identity function. Must be pure and must not throw.

Domain extraction and other policy-oriented value transformations are handled externally by helper functions in `domain-utils.ts`, rather than through additional methods on `RoleDefinition`.

### Convenience accessors

```typescript
/** Returns the RoleDefinition for a role. Throws if not registered. */
export function getRoleDefinition(role: ArgumentRole): RoleDefinition;

/** Returns all roles where isResourceIdentifier is true. */
export function getResourceRoles(): ArgumentRole[];

/** Type guard: returns true if the value is a valid ArgumentRole string. */
export function isArgumentRole(value: string): value is ArgumentRole;

/** All role values as a tuple for z.enum() compatibility. */
export function getArgumentRoleValues(): [ArgumentRole, ...ArgumentRole[]];
```

### Compile-time completeness check

A type-level assertion ensures every member of the `ArgumentRole` union has a registry entry. Forgetting to add a registry entry for a new role produces a compile error.

## Role Definitions

| Role | isResourceIdentifier | canonicalize | Description |
|------|---------------------|-----------|-------------|
| `read-path` | true | tilde expand + `resolveRealPath()` | Filesystem path that will be read |
| `write-path` | true | tilde expand + `resolveRealPath()` | Filesystem path that will be written to |
| `delete-path` | true | tilde expand + `resolveRealPath()` | Filesystem path that will be deleted |
| `none` | false | identity (no-op) | Argument carries no resource-identifier semantics |

For path roles, `canonicalize` uses `resolveRealPath()` which follows symlinks to produce the canonical real path. This neutralizes both path traversal attacks (via `resolve`) and symlink-escape attacks (via `realpathSync`). The function has a three-tier fallback: (1) `realpathSync(path)` for existing paths, (2) `realpathSync(dirname) + basename` for new files in existing directories, (3) `path.resolve()` for entirely new paths.

Policy-oriented transformations (e.g., domain extraction from URLs) are handled by helper functions in `domain-utils.ts` rather than through `RoleDefinition` methods.

## Annotation-Driven Normalization

### New function: `prepareToolArgs(args, annotation)`

Located in `src/trusted-process/path-utils.ts`. Returns two argument objects: one for transport (MCP server) and one for policy evaluation.

For each argument in `args`:

1. Look up `annotation.args[argName]` to get the role array
2. Find the first role where `getRoleDefinition(role).isResourceIdentifier === true`
3. If found: apply `canonicalize` to produce the canonical value for both transport and policy
4. If not found (roles are all `'none'`, or argument not in annotation): pass through unchanged to both outputs
5. If `annotation` is `undefined` (unknown tool): fall back to the heuristic `normalizeToolArgPaths()` for both outputs

The input object is never mutated; new objects are returned.

```typescript
interface PreparedToolArgs {
  /** Canonical args sent to the real MCP server. */
  argsForTransport: Record<string, unknown>;
  /** Args presented to the policy engine (may differ for relative paths when allowedDirectory is set). */
  argsForPolicy: Record<string, unknown>;
}

function prepareToolArgs(
  args: Record<string, unknown>,
  annotation: ToolAnnotation | undefined,
): PreparedToolArgs;
```

For path roles, both outputs are typically identical -- the resolved absolute path. The dual-output structure exists because `argsForPolicy` may differ when relative paths are resolved against `allowedDirectory`.

### Normalization flow

```
Tool Call arrives (raw args from sandbox/agent)
     |
     v
mcp-proxy-server.ts / TrustedProcess.handleToolCall()
     |
     +-- looks up ToolAnnotation via PolicyEngine.getAnnotation()
     |
     +-- calls prepareToolArgs(rawArgs, annotation)
     |       |
     |       +-- for each arg: looks up roles from annotation
     |       +-- for first resource-identifier role:
     |       |     canonicalize(value)         → argsForTransport[key]
     |       |     (argsForPolicy typically identical; may differ for relative paths)
     |       |
     |       +-- returns { argsForTransport, argsForPolicy }
     |
     +---+---+
     |       |
     v       v
  callTool(argsForTransport)    PolicyEngine.evaluate(argsForPolicy)
     |                               |
     |                          Structural checks
     |                               +-- extractPathsHeuristic() (defense-in-depth)
     |                               +-- extractAnnotatedPaths()
     |                               +-- uses getResourceRoles()
     |                          Compiled rule evaluation
     |                               +-- collectDistinctRoles() uses isResourceIdentifier
     |                               +-- per-role evaluation, most-restrictive-wins
     v                               v
  MCP result                    EvaluationResult
```

### Behavioral change

Arguments with role `'none'` that happen to look like paths (e.g., a `content` field containing `/etc/passwd`) will **no longer be normalized**. This is correct behavior -- normalizing non-path arguments was a side effect of the heuristic approach. The defense-in-depth heuristic in the policy engine's structural invariant phase still catches path-like strings regardless of annotation.

## PolicyEngine.getAnnotation()

New public method on `PolicyEngine`:

```typescript
getAnnotation(serverName: string, toolName: string): ToolAnnotation | undefined
```

Exposes read-only access to the annotation map so callers can look up annotations for normalization without duplicating the map. Used by `mcp-proxy-server.ts` and `TrustedProcess`.

## Hardcoded String Replacement

All hardcoded role references across the codebase are replaced with registry-derived values:

| Current pattern | Replacement |
|----------------|-------------|
| `['read-path', 'write-path', 'delete-path']` | `getResourceRoles()` |
| `role !== 'none'` | `getRoleDefinition(role).isResourceIdentifier` |
| `z.enum(['read-path', 'write-path', 'delete-path', 'none'])` | `z.enum(getArgumentRoleValues())` |
| `VALID_ROLES.includes(role)` | `isArgumentRole(role)` |

## Files Affected

### New files

| File | Purpose |
|------|---------|
| `src/types/argument-roles.ts` | Registry, type, normalizers, accessors |
| `test/argument-roles.test.ts` | Unit tests for registry and normalizers |

### Modified files

| File | Change |
|------|--------|
| `src/pipeline/types.ts` | Re-export `ArgumentRole` from canonical location |
| `src/trusted-process/path-utils.ts` | Add `prepareToolArgs()`, deprecate heuristic |
| `src/trusted-process/policy-engine.ts` | Use `getResourceRoles()`, `getRoleDefinition()`, add `getAnnotation()` |
| `src/trusted-process/mcp-proxy-server.ts` | Use annotation-driven normalization |
| `src/trusted-process/index.ts` | Use annotation-driven normalization |
| `src/pipeline/tool-annotator.ts` | Use `getArgumentRoleValues()` for Zod schema |
| `src/pipeline/constitution-compiler.ts` | Use `getArgumentRoleValues()`, `isArgumentRole()` |
| `test/path-utils.test.ts` | Add tests for annotation-driven normalization |

### Unchanged files

- Generated JSON artifacts (`tool-annotations.json`, `compiled-policy.json`) -- roles stay as plain strings, no format change
- `src/pipeline/scenario-generator.ts`, `handwritten-scenarios.ts`, `policy-verifier.ts`, `compile.ts` -- no direct role manipulation

## Extensibility

### Adding a new role

Adding a new role (e.g., `'url'`) requires exactly two changes in one file (`src/types/argument-roles.ts`):

1. Add `'url'` to the `ArgumentRole` union
2. Add an entry to `ARGUMENT_ROLE_REGISTRY` with its canonicalize function
3. Add to `_ROLE_COMPLETENESS_CHECK` (compile error if forgotten)

All Zod schemas, validation logic, and normalization flows pick up the new role automatically via registry accessors.

### Policy-oriented transformations

When the policy engine needs a different view of a value than the MCP server (e.g., domain extraction from URLs), this is handled by standalone helper functions in `domain-utils.ts` rather than through `RoleDefinition` methods. The policy engine calls these functions directly, dispatching by role identity (see `extractDomainForRole`, `resolveGitRemote`).

### Future: `sanitizeForLLM` on RoleDefinition

A future `sanitizeForLLM` method on `RoleDefinition` could enable roles where the value presented to LLM-based components (auto-approver, annotation prompt) differs from both the transport and policy views. Potential use cases:

- **Content sanitization**: A `content` role with `sanitizeForLLM = stripInjectionPatterns` (LLM sees a sanitized version to resist prompt injection from rogue agents).
- **Credential redaction**: A `secret` role with `sanitizeForLLM = redact` (LLM never sees the actual secret, only a placeholder).

## Migration Plan

Four incremental steps, each independently testable:

1. **Registry module + re-export** -- Create `src/types/argument-roles.ts`, update `src/pipeline/types.ts` to re-export. Zero behavioral change.
2. **Pipeline hardcoded strings** -- Update `tool-annotator.ts` and `constitution-compiler.ts` to use registry accessors. Zero behavioral change.
3. **Policy engine hardcoded strings** -- Update `policy-engine.ts` to use `getResourceRoles()` and `getRoleDefinition()`. Add `getAnnotation()` method. Zero behavioral change.
4. **Annotation-driven normalization** -- Add `prepareToolArgs()` returning `{ argsForTransport, argsForPolicy }`. Update proxy and TrustedProcess to route `argsForTransport` to `callTool()` and `argsForPolicy` to `PolicyEngine.evaluate()`. Only step with a behavioral change (correct: `'none'`-role args stop being normalized).
