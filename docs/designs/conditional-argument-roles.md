# Design: Conditional Argument Role Assignment

**Status:** Proposed (revised)
**Date:** 2026-03-04

## 1. Problem

Tool annotations assign argument roles statically. Every invocation of a tool is evaluated against the same set of roles regardless of what the tool call actually does. Many MCP tools are multi-mode: a single tool covers read, write, and delete operations gated by a `mode`, `operation`, or boolean flag argument. The annotator currently assigns the **union** of all possible roles, making the policy overly restrictive.

### Concrete impact

Today, `git_branch` has `path: ["read-path", "write-history", "delete-history"]`. When the agent calls `git_branch` with `operation: "list"` (a pure read), the policy engine evaluates the `write-history` and `delete-history` roles. Because those roles are not sandbox-safe, they fall through to compiled rule evaluation and trigger the `escalate-git-branch-management` rule. The user gets an unnecessary escalation prompt for a read-only operation.

The same problem affects at least seven other tools in the current git server alone:

| Tool | Mode argument | Read-only mode | Destructive mode | Current static roles on `path` |
|------|--------------|----------------|------------------|-------------------------------|
| `git_branch` | `operation` | `list` | `delete` | `read-path, write-history, delete-history` |
| `git_tag` | `mode` | `list` | `delete` | `read-path, write-history, delete-history` |
| `git_stash` | `mode` | `list` | `drop` | `read-path, write-history` |
| `git_worktree` | `mode` | `list` | `remove` | `read-path, write-path, delete-path` |
| `git_reset` | `mode` | (none) | `hard` | `read-path, write-history` |
| `git_clean` | `dryRun` | `true` | `false` | `read-path, delete-path` |
| `edit_file` | `dryRun` | `true` | `false` | `read-path, write-path` |

Without conditional roles, the policy compiler must either over-restrict (escalate all uses of these tools) or under-restrict (allow all uses and lose mode-specific enforcement). Both outcomes undermine the policy engine's value.

## 2. Design Overview

**Core principle: resolve conditionals at the lookup boundary, not at every consumer.**

The stored annotation format (JSON file, Zod schema, LLM output) gains a conditional role syntax. But the `ToolAnnotation` type that every consumer already uses (`prepareToolArgs`, `extractAnnotatedPaths`, `extractArgsForAutoApprove`, `collectDistinctRoles`, `evaluateStructuralInvariants`, `evaluateCompiledRules`, etc.) does not change. A new `StoredToolAnnotation` type represents what the JSON file contains. When the policy engine looks up an annotation for a tool call, it resolves conditionals against the actual tool call arguments right there at lookup time and returns a plain `ToolAnnotation`.

```
JSON file (StoredToolAnnotation):
  path: {
    default: ["read-path", "write-history", "delete-history"],
    when: [
      { condition: { arg: "operation", equals: "list" },  roles: ["read-path"] },
      { condition: { arg: "operation", equals: "delete" }, roles: ["read-path", "delete-history"] }
    ]
  }

                     |
                     v  resolveStoredAnnotation(stored, callArgs)
                     |
Consumer-facing (ToolAnnotation):
  path: ["read-path"]              // when operation === "list"
  path: ["read-path", "delete-history"]  // when operation === "delete"
```

This means:

- `ToolAnnotation` interface -- **unchanged** (`args: Record<string, ArgumentRole[]>`)
- `prepareToolArgs()` -- **unchanged**
- `extractAnnotatedPaths()` -- **unchanged**
- `extractArgsForAutoApprove()` -- **unchanged**
- `collectDistinctRoles()` -- **unchanged**
- `evaluateStructuralInvariants()` -- **unchanged**
- `evaluateCompiledRules()` -- **unchanged**
- `ruleMatches()` and all sub-methods -- **unchanged**

The only things that change:

1. **`src/pipeline/types.ts`** -- New `StoredToolAnnotation`, `StoredToolAnnotationsFile`, conditional role types
2. **`src/trusted-process/policy-engine.ts`** -- Annotation map stores `StoredToolAnnotation`, resolves on lookup
3. **`src/pipeline/tool-annotator.ts`** -- LLM prompt, Zod schema, heuristic validation
4. **`src/types/argument-roles.ts`** -- `resolveStoredAnnotation()` function
5. **Test fixtures** -- Updated for conditional annotations

## 3. Condition Language

### 3.1 Condition types

The condition language covers the three patterns that appear across MCP tool schemas:

```typescript
/**
 * A condition on a sibling argument's value.
 *
 * Exactly one of `equals`, `in`, or `is` must be set.
 * The `arg` field names the sibling argument to inspect.
 */
interface RoleCondition {
  /** The name of the sibling argument whose value determines the roles. */
  arg: string;

  /** Match when the argument value equals this exact value. */
  equals?: string | number | boolean;

  /** Match when the argument value is one of these values. */
  in?: Array<string | number | boolean>;

  /**
   * Match when the argument satisfies a type predicate.
   * - "present": argument exists and is not undefined/null
   * - "absent": argument is undefined, null, or not provided
   * - "truthy": argument is present and truthy (not false, 0, "", null, undefined)
   * - "falsy": argument is absent, false, 0, "", or null
   */
  is?: 'present' | 'absent' | 'truthy' | 'falsy';
}
```

Design rationale for limiting the condition language:

- **No nested conditions or boolean combinators (and/or/not).** Every real-world multi-mode tool we examined uses a single discriminant argument. Combinators would increase schema complexity and LLM error rate for negligible practical benefit. If a future tool genuinely requires compound conditions, the `when` array already provides implicit OR (first match wins), and a two-argument dispatch can be handled by flattening the combinations into explicit entries.

- **No regex or pattern matching.** The condition values are drawn from the tool's input schema, which defines them as enums, booleans, or constants. Regex would be a footgun for the LLM annotator.

- **The `in` operator handles enum-style grouping.** When multiple mode values share the same role profile (e.g., `operation: "create"` and `operation: "rename"` both map to `write-history`), `in` avoids duplicating entries.

### 3.2 Evaluation semantics

A `ConditionalRoles` block contains a `default` role array and zero or more `when` clauses. Evaluation is first-match-wins:

1. Iterate through the `when` array in order.
2. For each clause, evaluate its `RoleCondition` against the tool call arguments.
3. If the condition matches, return the clause's `roles` array. Stop.
4. If no clause matches, return the `default` roles.

The `default` roles provide the conservative fallback -- they must be the **most restrictive** role set (the union of all possible roles). This ensures that if a new mode value is added to the tool but the annotation is not updated, the tool call is evaluated under the most restrictive interpretation.

### 3.3 Condition evaluation rules

For `equals`:
- Compare the argument value with strict equality (`===`).
- If the argument is not present in the tool call, the condition does not match.

For `in`:
- Check if the argument value is present in the array using `===`.
- If the argument is not present in the tool call, the condition does not match.

For `is`:
- `"present"`: matches if the argument key exists in the tool call arguments and its value is not `null` or `undefined`.
- `"absent"`: matches if the argument key does not exist in the tool call arguments, or its value is `null` or `undefined`.
- `"truthy"`: matches if the argument is present and its value is truthy in the JavaScript sense.
- `"falsy"`: matches if the argument is absent, or its value is falsy.

## 4. Type Definitions

### 4.1 New types in `src/pipeline/types.ts`

```typescript
/**
 * A condition on a sibling argument that determines which roles apply.
 * Exactly one of equals/in/is must be set.
 */
export interface RoleCondition {
  readonly arg: string;
  readonly equals?: string | number | boolean;
  readonly in?: ReadonlyArray<string | number | boolean>;
  readonly is?: 'present' | 'absent' | 'truthy' | 'falsy';
}

/**
 * A conditional role assignment: when the condition matches,
 * these roles apply instead of the default.
 */
export interface ConditionalRoleEntry {
  readonly condition: RoleCondition;
  readonly roles: ArgumentRole[];
}

/**
 * Roles for an argument that depend on the values of sibling arguments.
 * The `default` roles apply when no `when` clause matches.
 *
 * Invariant: each `when` entry's `roles` must be a subset of `default`.
 * This ensures conditional resolution can only narrow, never expand.
 */
export interface ConditionalRoles {
  readonly default: ArgumentRole[];
  readonly when: ConditionalRoleEntry[];
}

/**
 * An argument's roles in the stored (on-disk) format: either a static
 * array (backward compatible) or a conditional block with default + when.
 */
export type ArgumentRoleSpec = ArgumentRole[] | ConditionalRoles;
```

### 4.2 `StoredToolAnnotation` -- what the JSON file contains

```typescript
/**
 * A tool annotation as stored in tool-annotations.json.
 * Args may contain conditional role specs that need resolution
 * against actual tool call arguments before use.
 */
export interface StoredToolAnnotation {
  toolName: string;
  serverName: string;
  comment: string;
  sideEffects: boolean;
  args: Record<string, ArgumentRoleSpec>;
}

/**
 * The tool-annotations.json file format.
 * Uses StoredToolAnnotation because the file may contain conditional specs.
 */
export interface StoredToolAnnotationsFile {
  generatedAt: string;
  servers: Record<string, { inputHash: string; tools: StoredToolAnnotation[] }>;
}
```

### 4.3 `ToolAnnotation` -- unchanged

The existing `ToolAnnotation` interface does not change. It continues to use `args: Record<string, ArgumentRole[]>`:

```typescript
// EXISTING -- no change
export interface ToolAnnotation {
  toolName: string;
  serverName: string;
  comment: string;
  sideEffects: boolean;
  args: Record<string, ArgumentRole[]>;
}

export interface ToolAnnotationsFile {
  generatedAt: string;
  servers: Record<string, { inputHash: string; tools: ToolAnnotation[] }>;
}
```

Both `ToolAnnotation` and `ToolAnnotationsFile` are retained alongside the `Stored` variants. `ToolAnnotation` is the resolved form that all consumers use. `ToolAnnotationsFile` may be used by code that loads pre-resolved annotations (e.g., tests with static fixtures).

### 4.4 Backward compatibility

The `ArgumentRoleSpec` type is a union: `ArgumentRole[] | ConditionalRoles`. This means:

- **Existing annotations work without changes.** The bare array form is the first union member. Old `tool-annotations.json` files (bare arrays only) parse correctly with the new schema.
- **Consumers of `ToolAnnotation` are completely unaffected.** They never see `ArgumentRoleSpec`. The boundary resolution in the policy engine guarantees they receive `Record<string, ArgumentRole[]>`.
- **The `tool-annotations.json` format is a strict superset.** No migration step is needed for existing artifacts.

A type guard distinguishes the two forms:

```typescript
export function isConditionalRoles(spec: ArgumentRoleSpec): spec is ConditionalRoles {
  return !Array.isArray(spec) && 'default' in spec;
}
```

### 4.5 JSON artifact format

The `tool-annotations.json` format extends naturally. Static annotations remain unchanged (bare arrays). Conditional annotations use the object form:

```json
{
  "toolName": "git_branch",
  "comment": "Lists, creates, deletes, or renames git branches.",
  "sideEffects": true,
  "args": {
    "path": {
      "default": ["read-path", "write-history", "delete-history"],
      "when": [
        {
          "condition": { "arg": "operation", "equals": "list" },
          "roles": ["read-path"]
        },
        {
          "condition": { "arg": "operation", "in": ["create", "rename"] },
          "roles": ["read-path", "write-history"]
        },
        {
          "condition": { "arg": "operation", "equals": "delete" },
          "roles": ["read-path", "delete-history"]
        }
      ]
    },
    "operation": ["none"],
    "name": ["branch-name"],
    "newName": ["branch-name"],
    "startPoint": ["none"],
    "force": ["none"]
  }
}
```

More examples:

```json
{
  "toolName": "git_clean",
  "args": {
    "path": {
      "default": ["read-path", "delete-path"],
      "when": [
        {
          "condition": { "arg": "dryRun", "equals": true },
          "roles": ["read-path"]
        }
      ]
    },
    "dryRun": ["none"],
    "force": ["none"],
    "directories": ["none"],
    "ignored": ["none"]
  }
}
```

```json
{
  "toolName": "edit_file",
  "args": {
    "path": {
      "default": ["read-path", "write-path"],
      "when": [
        {
          "condition": { "arg": "dryRun", "equals": true },
          "roles": ["read-path"]
        }
      ]
    },
    "edits": ["none"],
    "dryRun": ["none"]
  }
}
```

## 5. Resolution Function

### 5.1 `resolveStoredAnnotation()`

New function in `src/types/argument-roles.ts` (co-located with role definitions since it is role-semantics logic):

```typescript
/**
 * Resolves a StoredToolAnnotation (which may contain conditional role specs)
 * into a plain ToolAnnotation (where all args are ArgumentRole[]).
 *
 * This is the sole boundary where conditionals are evaluated. Every consumer
 * downstream receives a ToolAnnotation with static role arrays.
 *
 * @param stored - The stored annotation (from JSON file / annotation map)
 * @param callArgs - The actual tool call arguments
 * @returns A ToolAnnotation with all conditional specs resolved
 */
export function resolveStoredAnnotation(
  stored: StoredToolAnnotation,
  callArgs: Record<string, unknown>,
): ToolAnnotation {
  const resolvedArgs: Record<string, ArgumentRole[]> = {};
  for (const [argName, spec] of Object.entries(stored.args)) {
    if (Array.isArray(spec)) {
      resolvedArgs[argName] = spec;
    } else {
      resolvedArgs[argName] = evaluateConditionalRoles(spec, callArgs);
    }
  }
  return {
    toolName: stored.toolName,
    serverName: stored.serverName,
    comment: stored.comment,
    sideEffects: stored.sideEffects,
    args: resolvedArgs,
  };
}
```

### 5.2 Internal helpers

```typescript
function evaluateConditionalRoles(
  spec: ConditionalRoles,
  callArgs: Record<string, unknown>,
): ArgumentRole[] {
  for (const entry of spec.when) {
    if (evaluateCondition(entry.condition, callArgs)) {
      return entry.roles;
    }
  }
  return spec.default;
}

function evaluateCondition(
  cond: RoleCondition,
  callArgs: Record<string, unknown>,
): boolean {
  const value = callArgs[cond.arg];

  if (cond.equals !== undefined) {
    return value === cond.equals;
  }

  if (cond.in !== undefined) {
    return cond.in.includes(value as string | number | boolean);
  }

  if (cond.is !== undefined) {
    switch (cond.is) {
      case 'present':
        return cond.arg in callArgs && value !== null && value !== undefined;
      case 'absent':
        return !(cond.arg in callArgs) || value === null || value === undefined;
      case 'truthy':
        return cond.arg in callArgs && !!value;
      case 'falsy':
        return !(cond.arg in callArgs) || !value;
    }
  }

  // No condition operator set -- should be caught by Zod validation
  return false;
}
```

### 5.3 `extractDefaultRoles()`

For pipeline consumers that need to inspect annotations without a tool call context (heuristic validation, constitution compiler), a helper extracts the default (most-restrictive) roles:

```typescript
/**
 * Extracts the static/default roles from an ArgumentRoleSpec.
 * For static arrays, returns them directly.
 * For conditional specs, returns the default (most-restrictive) roles.
 *
 * Used by pipeline stages that inspect annotations without a tool call context.
 */
export function extractDefaultRoles(spec: ArgumentRoleSpec): ArgumentRole[] {
  if (Array.isArray(spec)) return spec;
  return spec.default;
}
```

### 5.4 Performance

The resolution function is O(A * W) where A is the number of arguments and W is the max number of `when` clauses on any argument. In practice, A < 15 and W < 10 for all known tools. This is negligible compared to the filesystem I/O in `resolveRealPath()`.

## 6. Policy Engine Changes

### 6.1 Annotation map stores `StoredToolAnnotation`

The `PolicyEngine.annotationMap` changes from `Map<string, ToolAnnotation>` to `Map<string, StoredToolAnnotation>`. The constructor and `buildAnnotationMap` accept `StoredToolAnnotationsFile`:

```typescript
private annotationMap: Map<string, StoredToolAnnotation>;

constructor(
  compiledPolicy: CompiledPolicyFile,
  toolAnnotations: StoredToolAnnotationsFile,  // was: ToolAnnotationsFile
  ...
)

private buildAnnotationMap(
  annotations: StoredToolAnnotationsFile,     // was: ToolAnnotationsFile
): Map<string, StoredToolAnnotation> { ... }
```

Since `ToolAnnotationsFile` (with `Record<string, ArgumentRole[]>` args) is structurally compatible with `StoredToolAnnotationsFile` (with `Record<string, ArgumentRoleSpec>` args) -- because `ArgumentRole[]` is the first member of the `ArgumentRoleSpec` union -- existing test fixtures that use plain arrays continue to work without changes. TypeScript's structural typing ensures this.

### 6.2 Resolution in `evaluate()`

The only change to `evaluate()` is resolving the annotation before passing it to the existing methods:

```typescript
evaluate(request: ToolCallRequest): EvaluationResult {
  const stored = this.annotationMap.get(
    `${request.serverName}__${request.toolName}`
  );
  // Resolve conditional roles against this specific tool call's arguments.
  // After this point, `annotation` has the same shape as always:
  // args: Record<string, ArgumentRole[]>
  const annotation = stored
    ? resolveStoredAnnotation(stored, request.arguments)
    : undefined;

  const structural = this.evaluateStructuralInvariants(request, annotation);
  if (structural.decision) return structural.decision;
  return this.evaluateCompiledRules(request, structural.sandboxResolvedRoles, annotation);
}
```

Wait -- the current `evaluateStructuralInvariants` and `evaluateCompiledRules` do their own `this.annotationMap.get()` internally. The cleanest approach is to have `evaluate()` resolve the annotation once and pass it down, replacing the internal lookups. This is a mechanical refactor: instead of each method looking up the annotation from the map, they receive it as a parameter. The annotation type they work with remains `ToolAnnotation | undefined` -- unchanged.

```typescript
evaluate(request: ToolCallRequest): EvaluationResult {
  const stored = this.annotationMap.get(
    `${request.serverName}__${request.toolName}`
  );
  const annotation = stored
    ? resolveStoredAnnotation(stored, request.arguments)
    : undefined;

  const structural = this.evaluateStructuralInvariants(request, annotation);
  if (structural.decision) return structural.decision;
  return this.evaluateCompiledRules(request, structural.sandboxResolvedRoles, annotation);
}
```

The internal methods already receive `annotation` from their lookups and pass it around. The refactor replaces internal `this.annotationMap.get()` calls with the pre-resolved `annotation` parameter. The `ToolAnnotation` type used by these methods (with `args: Record<string, ArgumentRole[]>`) does not change.

### 6.3 External API: `getAnnotation()` and `getResolvedAnnotation()`

The existing `getAnnotation()` method is used by three call sites in `mcp-proxy-server.ts` and `index.ts`:

1. `prepareToolArgs(rawArgs, annotation, ...)` -- reads `annotation.args[key]` as `ArgumentRole[]`
2. `extractArgsForAutoApprove(argsForPolicy, annotation)` -- reads `annotation.args[argName]` as `ArgumentRole[]`
3. `extractAnnotatedPaths(argsForTransport, annotation, ...)` -- reads `annotation.args` entries

All three need a resolved `ToolAnnotation`, not a `StoredToolAnnotation`. We add a new method and update callers:

```typescript
/**
 * Returns the stored (unresolved) annotation for a tool.
 * Conditional role specs are not evaluated.
 * Used by pipeline stages that need the raw conditional structure.
 */
getStoredAnnotation(serverName: string, toolName: string): StoredToolAnnotation | undefined {
  return this.annotationMap.get(`${serverName}__${toolName}`);
}

/**
 * Returns the resolved annotation for a specific tool call,
 * with conditional role specs evaluated against the call arguments.
 * Returns undefined for unknown tools.
 *
 * This is the primary lookup method for runtime consumers.
 */
getAnnotation(
  serverName: string,
  toolName: string,
  callArgs: Record<string, unknown>,
): ToolAnnotation | undefined {
  const stored = this.annotationMap.get(`${serverName}__${toolName}`);
  if (!stored) return undefined;
  return resolveStoredAnnotation(stored, callArgs);
}
```

The call sites in `mcp-proxy-server.ts` and `index.ts` change from:

```typescript
const annotation = deps.policyEngine.getAnnotation(toolInfo.serverName, toolInfo.name);
```

to:

```typescript
const annotation = deps.policyEngine.getAnnotation(toolInfo.serverName, toolInfo.name, rawArgs);
```

Since they already have `rawArgs` in scope, this is a one-line change per call site. Everything downstream (`prepareToolArgs`, `extractArgsForAutoApprove`, `extractAnnotatedPaths`) receives a plain `ToolAnnotation` and works unchanged.

### 6.4 No changes to compiled rules

Compiled rules continue to use role names (`"read-path"`, `"write-history"`, etc.) as conditions. The conditional role resolution happens **before** rules are consulted. From the rule evaluation perspective, a `git_branch` call with `operation: "list"` simply has `path: ["read-path"]` and matches the `allow-git-read-ops` rule (or similar). The rules do not need to know about mode arguments.

### 6.5 `sideEffects` and conditional roles

The `sideEffects` field remains unconditional. A tool like `git_clean` has `sideEffects: true` even when `dryRun: true`. This is conservative and correct: `sideEffects` is an intrinsic property of the tool's capability, not the specific invocation's behavior. The conditional role system handles the per-invocation distinction through role assignment rather than through `sideEffects` toggling.

## 7. Annotator Pipeline Changes

### 7.1 Zod schema update

The `buildAnnotationsResponseSchema` function in `tool-annotator.ts` must accept both static and conditional role specs:

```typescript
const conditionalEntrySchema = z.object({
  condition: z.object({
    arg: z.string(),
    equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
    in: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
    is: z.enum(['present', 'absent', 'truthy', 'falsy']).optional(),
  }).refine(
    (c) => {
      const count = [c.equals !== undefined, c.in !== undefined, c.is !== undefined]
        .filter(Boolean).length;
      return count === 1;
    },
    { message: 'Exactly one of equals, in, or is must be set' },
  ),
  roles: rolesArraySchema,
});

const conditionalRolesSchema = z.object({
  default: rolesArraySchema,
  when: z.array(conditionalEntrySchema),
}).refine(
  (spec) => {
    const defaultSet = new Set(spec.default);
    return spec.when.every((entry) =>
      entry.roles.every((role) => defaultSet.has(role)),
    );
  },
  { message: 'Conditional roles must be a subset of the default roles' },
);

const argumentRoleSpecSchema = z.union([
  rolesArraySchema,
  conditionalRolesSchema,
]);
```

The `toolAnnotationSchema` changes from:

```typescript
args: z.record(z.string(), rolesArraySchema),
```

to:

```typescript
args: z.record(z.string(), argumentRoleSpecSchema),
```

The return type of the annotator becomes `StoredToolAnnotation[]` instead of `ToolAnnotation[]`.

### 7.2 Prompt update

The annotation prompt in `buildAnnotationPrompt` gains conditional role guidance after the existing role description section:

```
## Conditional Roles

When a tool has a mode/operation argument that changes its behavior, use
conditional role assignment instead of assigning the union of all possible
roles. This produces more precise policy evaluation.

Use conditional roles when:
- A tool has an operation/mode/type argument that selects between read,
  write, and delete behavior
- A boolean flag (like dryRun or force) changes whether the tool modifies
  state

Format for conditional roles:
{
  "default": ["read-path", "write-history", "delete-history"],
  "when": [
    { "condition": { "arg": "operation", "equals": "list" }, "roles": ["read-path"] },
    { "condition": { "arg": "operation", "in": ["create", "rename"] }, "roles": ["read-path", "write-history"] },
    { "condition": { "arg": "operation", "equals": "delete" }, "roles": ["read-path", "delete-history"] }
  ]
}

Rules for conditional roles:
- The "default" MUST be the MOST RESTRICTIVE role set (the union of all
  possible roles). This is the fallback when no condition matches.
- Each "when" entry narrows the roles for a specific mode/flag value.
- The "arg" in a condition must reference another argument in the same
  tool's input schema.
- Use "equals" for single-value matching, "in" for multiple values with
  the same roles, and "is" for presence/truthiness checks.
- Only use conditional roles when the mode argument genuinely changes the
  security profile. Do not add conditions for arguments that do not affect
  which resources are accessed.
- Most arguments will still use static role arrays. Only use conditional
  roles where the tool is clearly multi-mode.

Example: A tool with dryRun flag:
{
  "path": {
    "default": ["read-path", "write-path"],
    "when": [
      { "condition": { "arg": "dryRun", "equals": true }, "roles": ["read-path"] }
    ]
  },
  "dryRun": ["none"]
}
```

### 7.3 Heuristic validation update

The `validateAnnotationsHeuristic` function in `tool-annotator.ts` checks that path-like arguments have path roles. It currently reads `annotation.args[argName]` as `ArgumentRole[]`. Since the annotator now produces `StoredToolAnnotation`, this function works with `StoredToolAnnotation` and uses `extractDefaultRoles`:

```typescript
// Before (current):
const roles = annotation.args[argName] as ArgumentRole[] | undefined;
const hasPathRole = roles && roles.some((r) => getRoleDefinition(r).isResourceIdentifier);

// After:
const spec = annotation.args[argName];
const roles = spec ? extractDefaultRoles(spec) : undefined;
const hasPathRole = roles && roles.some((r) => getRoleDefinition(r).isResourceIdentifier);
```

This is correct for heuristic validation: if the default (most restrictive) role set includes a path role, the argument is properly annotated. The same change applies to the `hasAnyPathRole` check.

### 7.4 Cross-argument validation

A new Zod `superRefine` validator checks that conditional role conditions reference valid sibling argument names:

```typescript
// Inside the toolAnnotationSchema superRefine
for (const [argName, spec] of Object.entries(a.args)) {
  if (!Array.isArray(spec) && 'when' in spec) {
    for (const entry of spec.when) {
      const condArg = entry.condition.arg;
      if (!(condArg in a.args)) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'args', argName],
          message: `Conditional role on "${argName}" references unknown argument "${condArg}". ` +
            `The condition argument must be another argument in the same tool's input schema.`,
        });
      }
    }
  }
}
```

### 7.5 Cache invalidation

The annotation pipeline uses `inputHash` (SHA-256 of the tool schemas + prompt text) for caching. Since the prompt text changes to include conditional role guidance, the hash will change, and all annotations will be regenerated on the next `annotate-tools` run. This is the desired behavior.

## 8. Impact on Other Pipeline Stages

### 8.1 Constitution compiler

The constitution compiler reads role names from annotations to understand what roles exist. With conditional roles, it should look at the **default** roles (which are the union of all possible roles) when reasoning about what rules to generate. The `extractDefaultRoles` helper serves this need. No format change is needed in compiled rules.

The constitution compiler currently receives `ToolAnnotationsFile`. It would receive `StoredToolAnnotationsFile` instead, and use `extractDefaultRoles` where it iterates over annotation args. If it currently only passes annotations through to the LLM as context (stringified JSON), no code change is needed -- the LLM sees the richer conditional structure and can reason about it.

### 8.2 Scenario generator

The scenario generator creates test scenarios that exercise policy rules. With conditional roles, it can generate more targeted scenarios:

```json
{
  "description": "List branches in sandbox -- allowed (read-only mode)",
  "request": {
    "serverName": "git",
    "toolName": "git_branch",
    "arguments": { "path": "/sandbox/repo", "operation": "list" }
  },
  "expectedDecision": "allow"
}
```

No schema change is needed for scenarios. The scenario generator prompt should be updated to mention that tools with conditional roles should have separate scenarios for each mode value.

### 8.3 Policy verifier

The policy verifier executes scenarios through the `PolicyEngine` and checks results. Since the engine handles conditional role resolution internally, the verifier requires no changes.

### 8.4 Handwritten scenarios

Existing handwritten scenarios do not set mode arguments. They continue to work because when no mode argument is provided, the `default` (most restrictive) roles apply. No new handwritten scenarios are needed for conditional role behavior -- coverage is provided by policy engine unit tests (see Section 12).

## 9. Files Changed

### New types/functions (in existing files)

| File | Addition |
|------|----------|
| `src/pipeline/types.ts` | `RoleCondition`, `ConditionalRoleEntry`, `ConditionalRoles`, `ArgumentRoleSpec`, `StoredToolAnnotation`, `StoredToolAnnotationsFile` |
| `src/types/argument-roles.ts` | `resolveStoredAnnotation()`, `isConditionalRoles()`, `extractDefaultRoles()` |

### Modified files

| File | Change | Scope |
|------|--------|-------|
| `src/trusted-process/policy-engine.ts` | `annotationMap` stores `StoredToolAnnotation`; constructor accepts `StoredToolAnnotationsFile`; `evaluate()` resolves once and passes down; `getAnnotation()` gains `callArgs` parameter; new `getStoredAnnotation()` method | Moderate -- mechanical type threading |
| `src/trusted-process/mcp-proxy-server.ts` | `getAnnotation()` call gains `rawArgs` argument (2 lines) | Minimal |
| `src/trusted-process/index.ts` | `getAnnotation()` call gains `rawArgs` argument (1 line) | Minimal |
| `src/pipeline/tool-annotator.ts` | Zod schema accepts `ArgumentRoleSpec`; prompt text; heuristic validation uses `extractDefaultRoles`; return type becomes `StoredToolAnnotation[]` | Moderate |
| `test/fixtures/test-policy.ts` | `git_branch` annotation updated with conditional specs (optional -- can be a separate PR) | Minimal |
| `test/policy-engine.test.ts` | New tests for conditional role behavior | Additive |

### Unchanged files

| File | Why unchanged |
|------|--------------|
| `src/pipeline/types.ts` (ToolAnnotation) | The `ToolAnnotation` interface itself does not change |
| `src/trusted-process/path-utils.ts` | `prepareToolArgs` receives resolved `ToolAnnotation` -- no change |
| `src/trusted-process/auto-approver.ts` | `extractArgsForAutoApprove` receives resolved `ToolAnnotation` -- no change |
| `src/config/generated/compiled-policy.json` | Rules use role names, not mode values |
| `src/pipeline/constitution-compiler.ts` | Receives annotations as context; may use `extractDefaultRoles` but no structural change |
| `src/pipeline/scenario-generator.ts` | Prompt update only (can be deferred) |
| `src/pipeline/policy-verifier.ts` | Executes through `PolicyEngine.evaluate()`; no direct role access |
| `src/pipeline/compile.ts` | Orchestrator; loads/passes `StoredToolAnnotationsFile` (structural subtype of what it loads today) |
| `src/types/argument-roles.ts` (existing code) | No changes to `ArgumentRole`, `RoleDefinition`, registry, or accessors |

## 10. Security Considerations

### 10.1 Conservative defaults

The `default` role set must be the **most restrictive** (union of all possible roles). If the LLM annotator fails to produce a conditional spec, or produces one with incomplete coverage, the default ensures that unrecognized mode values get the strictest treatment. This is the same security posture as today's static annotations.

### 10.2 Subset invariant (enforced by Zod)

The key security property is: **for any possible argument values, the resolved roles are a subset of the default roles.** This is enforced by the Zod schema refinement:

```typescript
conditionalRolesSchema.refine(
  (spec) => {
    const defaultSet = new Set(spec.default);
    return spec.when.every((entry) =>
      entry.roles.every((role) => defaultSet.has(role)),
    );
  },
  { message: 'Conditional roles must be a subset of the default roles' },
);
```

This invariant ensures that conditional role resolution can only **reduce** the set of roles, never expand it. An attacker who manipulates the mode argument can at most cause a *less restrictive* role assignment, which is then still evaluated against compiled policy rules and structural invariants.

### 10.3 Missing mode argument

When a multi-mode tool is called without the mode argument (e.g., `git_branch` without `operation`), no condition matches and the default roles apply. This is the correct behavior: the tool might do anything, so the most restrictive interpretation is appropriate.

### 10.4 Untrusted argument values

The condition evaluation reads argument values from the tool call request. These values come from the LLM agent and are untrusted. However, the condition system only uses these values to **narrow** the role set from the most-restrictive default. An attacker cannot introduce new roles or bypass structural invariants through mode argument manipulation.

### 10.5 Mode argument spoofing

The agent could provide `operation: "list"` but the tool might internally do a delete operation if the tool's implementation ignores the `operation` argument. This risk exists today (the agent could call any tool with any arguments) and is not worsened by conditional roles. The defense is that the MCP server is the trusted implementation -- if it claims `operation: "list"` is read-only, the policy engine trusts that classification.

### 10.6 Resolution happens exactly once

A subtle but important property: conditional resolution happens once per tool call, in `evaluate()` (and once more in `getAnnotation()` for the proxy's own uses). The resolved `ToolAnnotation` is then passed through the entire evaluation pipeline. There is no risk of inconsistent resolution where different parts of the pipeline see different role sets for the same tool call.

## 11. Migration Strategy

### Phase 1: Types and resolution function

1. Add `RoleCondition`, `ConditionalRoleEntry`, `ConditionalRoles`, `ArgumentRoleSpec`, `StoredToolAnnotation`, `StoredToolAnnotationsFile` to `src/pipeline/types.ts`.
2. Add `resolveStoredAnnotation()`, `isConditionalRoles()`, `extractDefaultRoles()` to `src/types/argument-roles.ts`.
3. Add unit tests for `resolveStoredAnnotation` covering all condition operators and edge cases.

**Zero behavioral change.** Existing annotations use only `ArgumentRole[]`. No consumers are modified yet.

### Phase 2: Policy engine integration

1. Change `annotationMap` type from `Map<string, ToolAnnotation>` to `Map<string, StoredToolAnnotation>`.
2. Change constructor to accept `StoredToolAnnotationsFile` (structurally compatible with `ToolAnnotationsFile`).
3. Update `evaluate()` to resolve the stored annotation once and pass the resolved `ToolAnnotation` to internal methods (replacing their internal `annotationMap.get()` calls).
4. Update `getAnnotation()` signature to accept `callArgs` and return resolved annotation.
5. Add `getStoredAnnotation()` for raw access.
6. Update 3 call sites in `mcp-proxy-server.ts` and `index.ts` to pass `rawArgs` to `getAnnotation()`.
7. Add policy engine tests for conditional role evaluation using test fixtures with conditional annotations.

**Existing tests pass without changes** because test fixtures use bare `ArgumentRole[]` arrays, which are valid `ArgumentRoleSpec` values.

### Phase 3: Annotator pipeline

1. Update Zod schema in `buildAnnotationsResponseSchema` to accept `ArgumentRoleSpec`.
2. Update prompt in `buildAnnotationPrompt` with conditional role guidance.
3. Update `validateAnnotationsHeuristic` to use `extractDefaultRoles`.
4. Add cross-argument validation in Zod superRefine.
5. Run `npm run annotate-tools` to regenerate annotations with conditional roles.

**Behavioral change:** Regenerated annotations include conditional role specs for multi-mode tools. The policy engine evaluates them using the resolution function from Phase 2.

### Phase 4: Scenario generator prompt (optional, can be deferred)

1. Update scenario generator prompt to generate mode-specific scenarios for tools with conditional roles.
2. Run `npm run compile-policy` to verify.

## 12. Test Plan

### Unit tests for `resolveStoredAnnotation`

```
resolveStoredAnnotation
  - returns static roles unchanged (bare arrays pass through)
  - returns default roles when no conditions match
  - matches equals condition (string)
  - matches equals condition (boolean true)
  - matches equals condition (boolean false)
  - matches in condition
  - matches is:present condition
  - matches is:absent condition for missing arg
  - matches is:absent condition for null arg
  - matches is:truthy condition
  - matches is:falsy condition for false value
  - matches is:falsy condition for missing arg
  - first matching condition wins (order matters)
  - does not match equals when arg is absent
  - does not match in when arg is absent
  - handles mixed static and conditional specs in same annotation
```

### Policy engine integration tests

```
PolicyEngine with conditional roles
  - allows git_branch operation:list in sandbox (resolves to read-path only)
  - escalates git_branch operation:delete in sandbox (resolves to delete-history)
  - escalates git_branch with no operation in sandbox (default: union of all roles)
  - allows edit_file with dryRun:true in sandbox (resolves to read-path only)
  - allows git_clean with dryRun:true in sandbox (resolves to read-path only)
  - escalates git_stash mode:drop in sandbox (resolves to delete-history)
```

### Annotator Zod schema tests

```
annotation schema validation
  - accepts static role arrays (backward compatible)
  - accepts conditional role objects
  - rejects conditional with no condition operator
  - rejects conditional with multiple condition operators
  - rejects conditional referencing non-existent argument
  - rejects conditional roles that are not a subset of default
  - accepts conditional with equals string
  - accepts conditional with equals boolean
  - accepts conditional with in array
  - accepts conditional with is predicate
```

### End-to-end pipeline tests (manual/CI)

1. Run `npm run annotate-tools` -- verify conditional roles appear for multi-mode git tools.
2. Run `npm run compile-policy` -- verify scenarios pass with conditional role resolution.
3. Manually test: `ironcurtain start "list the git branches"` in a workspace -- verify no escalation prompt for the `git_branch` call with `operation: "list"`.

## 13. Alternatives Considered

### A. Change `ToolAnnotation.args` to `Record<string, ArgumentRoleSpec>`

The previous version of this design changed the `ToolAnnotation` interface directly, making `args` use `ArgumentRoleSpec` instead of `ArgumentRole[]`. This cascaded into every consumer: `prepareToolArgs`, `extractAnnotatedPaths`, `extractArgsForAutoApprove`, `collectDistinctRoles`, `evaluateStructuralInvariants`, `evaluateCompiledRules`, `ruleMatches`, `ruleMatchesNonPathConditions`, and `extractAnnotatedUrls` -- all needed to handle the new union type. Each consumer would need a `resolveEffectiveRoles` call or type guard, creating:

- **Unnecessary complexity**: 10+ functions need changes for what is fundamentally an annotation-layer concern.
- **Security risk**: Each consumer must correctly handle conditional specs. A missed call site silently gets the wrong type.
- **Circular import risk**: Conditional role types would need to be imported by `argument-roles.ts` and `policy-engine.ts`, creating potential cycles.

The boundary-resolution approach eliminates all of this by keeping the conditional specs contained in two files (types and engine).

### B. Tool-level `sideEffects` conditional

Instead of conditional roles on arguments, make `sideEffects` conditional on mode arguments. Rejected because `sideEffects` is a coarse binary signal. Multi-mode tools have a spectrum of effects (read vs. write-history vs. delete-path) that a boolean cannot express.

### C. Virtual tool splitting

Transform `git_branch` into virtual tools `git_branch_list`, `git_branch_create`, `git_branch_delete` at the proxy layer. Rejected because:
- Requires the proxy to understand tool semantics, which is the annotation pipeline's job.
- The LLM agent generates tool calls matching the real MCP tool schema.
- The number of virtual tools would explode (28 git tools x 3-5 modes each).

### D. Rule-level argument conditions

Instead of conditional roles in annotations, add argument conditions to compiled rules. Rejected because:
- This mixes annotation concerns (what roles apply) with policy concerns (what to do about roles).
- The LLM constitution compiler would need to understand individual tool argument schemas.
- Rule argument conditions would not benefit from the structural invariant layer (sandbox containment, protected paths) which operates on roles.
