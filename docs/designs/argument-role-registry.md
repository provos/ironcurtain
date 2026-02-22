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
  readonly canonicalize: (value: string) => string;
  readonly extractPolicyValue?: (value: string) => string;
}

export const ARGUMENT_ROLE_REGISTRY: ReadonlyMap<ArgumentRole, RoleDefinition>;
```

Each role definition provides:

- **`description`** -- Human-readable explanation of the role's security semantics.
- **`isResourceIdentifier`** -- True if the role tags an argument that names an external resource (filesystem path, URL, etc.). False for `'none'`. Replaces all `role !== 'none'` checks in the codebase.
- **`canonicalize`** -- Canonicalizes a string argument value for transport to the MCP server. For path roles: tilde expansion + symlink-aware `resolveRealPath()` (follows symlinks via `realpathSync`, with fallbacks for non-existent paths). For `'none'`: identity function. Must be pure and must not throw.
- **`extractPolicyValue`** -- Optional. Transforms the already-canonicalized value into a form suitable for policy evaluation. When absent, the policy engine sees the canonicalized value directly. When present, the policy engine sees the transformed value while the MCP server still receives the `canonicalize`-only value. Must be pure and must not throw.

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

| Role | isResourceIdentifier | canonicalize | extractPolicyValue | Description |
|------|---------------------|-----------|-----------------|-------------|
| `read-path` | true | tilde expand + `resolveRealPath()` | -- | Filesystem path that will be read |
| `write-path` | true | tilde expand + `resolveRealPath()` | -- | Filesystem path that will be written to |
| `delete-path` | true | tilde expand + `resolveRealPath()` | -- | Filesystem path that will be deleted |
| `none` | false | identity (no-op) | -- | Argument carries no resource-identifier semantics |

For path roles, `canonicalize` uses `resolveRealPath()` which follows symlinks to produce the canonical real path. This neutralizes both path traversal attacks (via `resolve`) and symlink-escape attacks (via `realpathSync`). The function has a three-tier fallback: (1) `realpathSync(path)` for existing paths, (2) `realpathSync(dirname) + basename` for new files in existing directories, (3) `path.resolve()` for entirely new paths. No `extractPolicyValue` is needed because the resolved real path is the correct form for both.

Future roles may use `extractPolicyValue` to diverge the two views. For example, a `content` role might use `canonicalize = identity` (the MCP server receives the original text) and `extractPolicyValue = stripSpecialChars` (the policy engine evaluates a sanitized version to resist prompt injection from rogue agents).

## Annotation-Driven Normalization

### New function: `prepareToolArgs(args, annotation)`

Located in `src/trusted-process/path-utils.ts`. Returns two argument objects: one for transport (MCP server) and one for policy evaluation.

For each argument in `args`:

1. Look up `annotation.args[argName]` to get the role array
2. Find the first role where `getRoleDefinition(role).isResourceIdentifier === true`
3. If found: apply `canonicalize` to produce the transport value, then apply `extractPolicyValue` (if defined) to produce the policy value
4. If not found (roles are all `'none'`, or argument not in annotation): pass through unchanged to both outputs
5. If `annotation` is `undefined` (unknown tool): fall back to the heuristic `normalizeToolArgPaths()` for both outputs

The input object is never mutated; new objects are returned.

```typescript
interface PreparedToolArgs {
  /** Canonical args sent to the real MCP server. */
  argsForTransport: Record<string, unknown>;
  /** Args presented to the policy engine (may differ if extractPolicyValue is defined). */
  argsForPolicy: Record<string, unknown>;
}

function prepareToolArgs(
  args: Record<string, unknown>,
  annotation: ToolAnnotation | undefined,
): PreparedToolArgs;
```

For the current path roles (no `extractPolicyValue` defined), both outputs are identical -- the resolved absolute path. The dual-output structure is a zero-cost extension point that avoids a breaking interface change when `extractPolicyValue` is needed in the future.

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
     |       |     extractPolicyValue?(value) → argsForPolicy[key]
     |       |     (if no extractPolicyValue, argsForPolicy = argsForTransport)
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

### Diverging policy and transport views

The `extractPolicyValue` extension point enables roles where the policy engine needs to see a different value than the MCP server. This is designed for future scenarios such as:

- **Content sanitization**: A `content` role with `canonicalize = identity` (MCP server receives original text) and `extractPolicyValue = stripInjectionPatterns` (policy engine evaluates a sanitized version to resist prompt injection from rogue agents).
- **URL canonicalization**: A `url` role with `canonicalize = resolveRedirects` (MCP server gets the final URL) and `extractPolicyValue = extractDomain` (policy engine evaluates only the domain for allowlist checks).
- **Credential redaction**: A `secret` role with `canonicalize = identity` (MCP server receives the real credential) and `extractPolicyValue = redact` (policy engine never sees the actual secret, only a placeholder).

The dual-output `prepareToolArgs` function handles this transparently. Callers always receive `{ argsForTransport, argsForPolicy }` and route each to the right destination. When `extractPolicyValue` is not defined on a role, both outputs are identical -- no overhead or behavioral change for existing roles.

## Migration Plan

Four incremental steps, each independently testable:

1. **Registry module + re-export** -- Create `src/types/argument-roles.ts`, update `src/pipeline/types.ts` to re-export. Zero behavioral change.
2. **Pipeline hardcoded strings** -- Update `tool-annotator.ts` and `constitution-compiler.ts` to use registry accessors. Zero behavioral change.
3. **Policy engine hardcoded strings** -- Update `policy-engine.ts` to use `getResourceRoles()` and `getRoleDefinition()`. Add `getAnnotation()` method. Zero behavioral change.
4. **Annotation-driven normalization** -- Add `prepareToolArgs()` returning `{ argsForTransport, argsForPolicy }`. Update proxy and TrustedProcess to route `argsForTransport` to `callTool()` and `argsForPolicy` to `PolicyEngine.evaluate()`. Only step with a behavioral change (correct: `'none'`-role args stop being normalized).
