# Design: Dynamic Lists for Policy Rules

**Status:** Implemented
**Date:** 2026-02-20

## Problem

The constitution is plain English. It references categories of things that can't be hardcoded into static policy rules:

- "collect news from the major news sites" -- which domains count as "major news sites"?
- "send email to people in my contacts without asking" -- which email addresses are in my contacts?
- "get financial data for major tech stocks" -- which ticker symbols? which data provider domains?

Today, the constitution compiler must either inline concrete values (making constitutions brittle and verbose) or produce overly broad rules (allowing all domains when only a category was intended). Neither is acceptable: the first defeats the purpose of plain-English constitutions, and the second defeats the purpose of policy enforcement.

We need a mechanism where the compiler recognizes categorical references, emits symbolic list names in compiled rules, and a resolution step populates those lists from LLM knowledge or live MCP tool calls. The resolved lists are user-inspectable, user-editable, and refreshable.

## Design Overview

Dynamic lists are an extension to the policy compilation pipeline. The compiler emits `@list-name` symbolic references in rule conditions wherever it encounters a categorical reference in the constitution. Alongside the rules, it emits a **list definition** for each symbolic name: a name, a type, and a generation prompt. A new pipeline sub-step resolves each list definition by running its prompt through an LLM that optionally has access to MCP servers (for data-backed lists like contacts). Resolved values are written to a separate artifact (`dynamic-lists.json`) that users can inspect and edit. At policy load time, `@list-name` references are expanded to concrete values, keeping the policy engine's hot path unchanged.

```
Constitution text + tool annotations
        |
        v
+----------------------------+
| Constitution Compiler LLM  |  -->  compiled-policy.json (rules with @list-name refs)
+----------------------------+       + list definitions
        |
        v
+----------------------------+
| List Resolver (LLM + MCP)  |  -->  dynamic-lists.json (resolved concrete values)
+----------------------------+
        |
        v
+----------------------------+
| Policy Engine (load time)  |      @list-name -> concrete values (inline expansion)
+----------------------------+
```

The list definitions are persisted in `compiled-policy.json` (the authoritative source) so that `ironcurtain refresh-lists` can re-resolve them without re-running the full compilation pipeline.

## Key Design Decisions

1. **The compiler decides what needs a list, not the user.** The constitution stays plain English. The compiler prompt instructs the LLM to identify categorical references and emit `@list-name` symbolic names in rule conditions. No special syntax or markers are needed in the constitution text. The compiler's judgment about what constitutes a "category" is validated by the existing verification pipeline.

2. **Lists are typed for matching semantics.** Each list has a `type` field from a fixed (but extensible) taxonomy. The type determines how values in the list are compared against tool call arguments at evaluation time. This prevents a domain-pattern list from being accidentally used for email matching or vice versa. The initial types are `domains`, `emails`, and `identifiers`. New types are added by extending the `ListType` union and adding a matcher function to the registry.

3. **Resolution is a sub-step of `compile-policy`, not a separate command.** After rules are compiled and list definitions are extracted, the resolver runs as step 1.5 (between compilation and scenario generation). This ensures that resolved lists are available for scenario generation and verification. The resolver can optionally connect to MCP servers for data-backed lists (e.g., querying a contacts server). If MCP connections are unavailable, knowledge-based lists still resolve via the LLM's training data.

4. **Resolved lists are a separate, user-editable artifact.** `dynamic-lists.json` is distinct from `compiled-policy.json`. Users can inspect resolved lists, add or remove entries, and the edits persist across `compile-policy` runs (the resolver respects manual overrides via a `manualOverrides` field). This gives users a concrete, auditable view of what "major news sites" means for their policy.

5. **`@list-name` expansion happens at policy load time, not evaluation time.** When `PolicyEngine` loads `compiled-policy.json`, it resolves all `@list-name` references by substituting concrete values from `dynamic-lists.json`. The expanded rules are structurally identical to today's rules (concrete `allowed` arrays in `DomainCondition`, etc.). This means zero changes to the evaluation hot path. If a list is missing at load time, the engine fails loudly rather than silently allowing or denying.

6. **Refresh is a targeted command, not a full recompile.** `ironcurtain refresh-lists` re-resolves list definitions from `dynamic-lists.json` using their persisted generation prompts. It does not re-run the constitution compiler or re-generate scenarios. The refresh can optionally connect to MCP servers (for data-backed lists) and can use web search (for freshness). Manual overrides are preserved during refresh.

7. **List definitions are part of the compiled policy artifact.** The `CompiledPolicyFile` gains a `listDefinitions` field. This keeps the list definitions co-located with the rules that reference them and ensures they are versioned together. The resolved values live in the separate `dynamic-lists.json` artifact.

## Data Model

### List Type Registry

```typescript
// src/pipeline/dynamic-list-types.ts

/**
 * Taxonomy of list value types. Each type determines:
 * - How values are matched against tool call arguments
 * - What format the resolved values should be in
 * - How the values are displayed to users
 */
export type ListType = 'domains' | 'emails' | 'identifiers';

export interface ListTypeDef {
  readonly description: string;

  /**
   * Validates that a resolved value is well-formed for this type.
   * Used during resolution to filter out malformed LLM output.
   */
  readonly validate: (value: string) => boolean;

  /**
   * Suffix mechanically appended to the generation prompt when the
   * resolver LLM is called. The compiler LLM does NOT include format
   * instructions in its generationPrompt -- the type registry handles
   * this automatically based on the list type.
   */
  readonly formatGuidance: string;
}

export const LIST_TYPE_REGISTRY: ReadonlyMap<ListType, ListTypeDef>;
```

Initial type definitions:

| Type | Validate | Format guidance | Matching semantics |
|------|----------|----------------|-------------------|
| `domains` | Valid hostname or `*.hostname` | "Return domain names or wildcard patterns like `*.example.com`" | Uses existing `domainMatchesAllowlist()` |
| `emails` | Contains `@`, valid-ish format | "Return email addresses in `user@domain` format" | Exact match (case-insensitive local part, case-insensitive domain) |
| `identifiers` | Non-empty string, no whitespace | "Return identifiers as plain strings, one per entry" | Exact match (case-sensitive) |

### List Definition (emitted by compiler)

```typescript
// Addition to src/pipeline/types.ts

/**
 * A symbolic list definition emitted by the constitution compiler.
 * The compiler creates these when it encounters categorical references
 * in the constitution text.
 *
 * Invariant: the `name` matches the @list-name reference in compiled rules.
 * Invariant: the `type` determines matching semantics at evaluation time.
 */
export interface ListDefinition {
  /** Symbolic name, e.g., "major-news-sites". Used as @major-news-sites in rules. */
  readonly name: string;

  /** Determines matching semantics and value validation. */
  readonly type: ListType;

  /**
   * The constitution text that motivated this list.
   * Used for provenance tracking and display to users.
   */
  readonly principle: string;

  /**
   * Prompt for the resolver LLM to generate concrete values.
   * Written by the compiler LLM based on the constitution context.
   * Example: "List the 20 most popular English-language news websites
   *           by domain name, including their main domains."
   */
  readonly generationPrompt: string;

  /**
   * When true, the resolver should connect to MCP servers to resolve
   * this list (e.g., querying a contacts database). When false, the
   * resolver uses only LLM knowledge (and optionally web search).
   */
  readonly requiresMcp: boolean;

  /**
   * Optional: which MCP server to query for data-backed resolution.
   * Only meaningful when requiresMcp is true.
   */
  readonly mcpServerHint?: string;
}
```

### Resolved List Artifact

```typescript
// src/pipeline/types.ts

/**
 * A single resolved dynamic list with its values and metadata.
 *
 * Note: does NOT embed the ListDefinition. The authoritative definitions
 * live in CompiledPolicyFile.listDefinitions. This avoids duplication
 * and drift between the two artifacts. The refresh-lists command reads
 * definitions from compiled-policy.json, not from this file.
 */
export interface ResolvedList {
  /** The concrete resolved values. */
  readonly values: string[];

  /**
   * User-supplied additions that are always included regardless
   * of what the resolver produces. Survives refresh cycles.
   */
  readonly manualAdditions: string[];

  /**
   * User-supplied removals that are always excluded regardless
   * of what the resolver produces. Survives refresh cycles.
   */
  readonly manualRemovals: string[];

  /** ISO timestamp of last resolution. */
  readonly resolvedAt: string;

  /** Content hash of inputs that produced this resolution. */
  readonly inputHash: string;
}

/**
 * The dynamic-lists.json artifact.
 */
export interface DynamicListsFile {
  readonly generatedAt: string;
  readonly lists: Record<string, ResolvedList>; // keyed by list name
}
```

The effective values for a list at load time are:

```
effective = (resolved.values + manualAdditions) - manualRemovals
```

### Compiled Policy Extension

```typescript
// Extension to CompiledPolicyFile (src/pipeline/types.ts)

export interface CompiledPolicyFile {
  generatedAt: string;
  constitutionHash: string;
  inputHash: string;
  rules: CompiledRule[];

  /** List definitions emitted by the compiler. Empty if no dynamic lists needed. */
  listDefinitions?: ListDefinition[];
}
```

### Rule Condition Extension

The `@list-name` syntax is used exclusively in `DomainCondition.allowed` arrays and a new `ListCondition`:

```typescript
// Extension to CompiledRuleCondition

export interface CompiledRuleCondition {
  roles?: ArgumentRole[];
  server?: string[];
  tool?: string[];
  sideEffects?: boolean;
  paths?: PathCondition;
  domains?: DomainCondition; // allowed[] may contain "@list-name" entries
}
```

A `@list-name` entry in `DomainCondition.allowed` is expanded at load time to the concrete domain values from the corresponding resolved list. This means the existing `domainMatchesAllowlist()` function works unchanged -- it never sees `@` prefixed strings.

For non-domain list types (emails, identifiers), the `@list-name` reference appears in a new condition type:

```typescript
/**
 * Condition that matches argument values against a dynamic list.
 * Used for non-domain list types (emails, identifiers).
 *
 * At load time, @list-name is resolved to concrete values.
 * At evaluation time, the values are matched using the list type's semantics.
 */
export interface ListCondition {
  /** Which argument roles to extract values from. */
  readonly roles: ArgumentRole[];

  /**
   * Allowed values or @list-name references.
   * After load-time expansion, contains only concrete values.
   */
  readonly allowed: string[];

  /** How to match values. Determines comparison semantics. */
  readonly matchType: ListType;
}
```

And `CompiledRuleCondition` gains:

```typescript
export interface CompiledRuleCondition {
  // ... existing fields ...
  lists?: ListCondition[]; // for email, identifier, and other non-domain lists
}
```

`lists` is an array so that a single rule can reference multiple list conditions with different roles and match types (e.g., checking both an email recipient list and an identifier list). Each `ListCondition` in the array must be satisfied for the rule to match (AND semantics, consistent with how multiple conditions interact elsewhere).

## Compiler Changes

### Return Type Changes

The existing `compileConstitution()` function returns only `CompiledRule[]`, discarding everything else from the LLM response. It must be extended to return both rules and list definitions:

```typescript
// constitution-compiler.ts

export interface CompilationOutput {
  rules: CompiledRule[];
  listDefinitions: ListDefinition[];
}

export async function compileConstitution(
  constitutionText: string,
  annotations: ToolAnnotation[],
  config: CompilerConfig,
  llm: LanguageModel,
  repairContext?: RepairContext,
  onProgress?: (message: string) => void,
): Promise<CompilationOutput> {
  // ... existing code ...
  return { rules: output.rules, listDefinitions: output.listDefinitions ?? [] };
}
```

This change cascades through the compilation pipeline in `compile.ts`:

- **`CompilationResult`** gains a `listDefinitions: ListDefinition[]` field alongside `rules` and `inputHash`.
- **`compilePolicyRules()`** returns list definitions from the compiler output.
- **`compilePolicyRulesWithRepair()`** likewise carries list definitions through. The `RepairContext.previousRules` already contains the full rule set; list definitions do not change during repair (they are derived from the constitution, not from rule structure), so the repair loop does not need to pass them back. If the repaired output includes different list definitions, the new ones are used.
- **`buildPolicyArtifact()`** includes `listDefinitions` in the `CompiledPolicyFile` output.
- **`validateCompiledRules()`** is extended to also accept `listDefinitions` and validate cross-references (see Validation below).

### Prompt Extension

The constitution compiler prompt is extended with instructions for emitting list definitions:

```
## Dynamic Lists

When the constitution references a CATEGORY of things (e.g., "major news sites",
"my contacts", "tech stocks"), do NOT hardcode specific values. Instead:

1. Choose a descriptive kebab-case name for the category (e.g., "major-news-sites").
2. In the rule condition, use "@major-news-sites" as an entry in the allowed list.
3. In the listDefinitions output, emit a ListDefinition with:
   - name: the symbolic name (without @)
   - type: "domains" for website/domain categories, "emails" for email address
     categories, "identifiers" for other value categories
   - principle: the constitution text that references this category
   - generationPrompt: a clear prompt describing WHAT to list (quantity, scope).
     Do NOT include format instructions (e.g., "return domain names only") --
     format guidance is added mechanically based on the list type.
   - requiresMcp: true ONLY if the list requires querying live data from an
     MCP server (e.g., "my contacts" needs a contacts database).
     false for knowledge-based lists (e.g., "major news sites").
   - mcpServerHint: the MCP server name if requiresMcp is true

When the constitution says something like "any domain" or "all", do NOT create a
list. Use the wildcard pattern "*" directly.

Examples:
- "major news sites" -> @major-news-sites (type: domains, requiresMcp: false)
- "people in my contacts" -> @my-contacts (type: emails, requiresMcp: true)
- "major tech stocks" -> @tech-stock-tickers (type: identifiers, requiresMcp: false)
```

### Schema Extension

The compiler's Zod response schema is extended to accept `listDefinitions`:

```typescript
const listDefinitionSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  type: z.enum(['domains', 'emails', 'identifiers']),
  principle: z.string(),
  generationPrompt: z.string(),
  requiresMcp: z.boolean(),
  mcpServerHint: z.string().optional(),
});

// Extended response schema
const responseSchema = z.object({
  rules: z.array(compiledRuleSchema),
  listDefinitions: z.array(listDefinitionSchema).optional(),
});
```

### Validation

Post-compilation validation (`validateCompiledRules`) is extended to accept `listDefinitions` alongside rules:

1. Every `@list-name` reference in rule conditions must have a corresponding entry in `listDefinitions`.
2. Every entry in `listDefinitions` must be referenced by at least one rule.
3. **Domain lists go in `DomainCondition.allowed` only.** A `@list-name` reference to a `type: 'domains'` list must appear in `DomainCondition.allowed`, never in `ListCondition`. Conversely, `ListCondition` must only reference non-domain list types. This prevents two code paths for the same matching semantics and is enforced as a validation error.
4. When a `ListCondition` references `@list-name`, its `matchType` must equal the referenced list definition's `type`. A mismatch (e.g., `matchType: 'identifiers'` referencing a `type: 'emails'` list) would cause semantically incorrect matching and is a validation error.

## Resolution Pipeline

### New Module: `src/pipeline/list-resolver.ts`

```typescript
import type { LanguageModel } from 'ai';
import type { ListDefinition, ResolvedList, DynamicListsFile } from './types.js';

export interface ListResolverConfig {
  /** Pre-created LLM for resolution prompts. */
  readonly model: LanguageModel;

  /**
   * Optional MCP client manager for data-backed lists.
   * When undefined, lists with requiresMcp: true are resolved
   * with a warning using LLM knowledge only.
   */
  readonly mcpClients?: MCPClientManager;
}

/**
 * Resolves a list definition to concrete values.
 *
 * For knowledge-based lists (requiresMcp: false): sends the generation
 * prompt to the LLM and parses the response.
 *
 * For data-backed lists (requiresMcp: true): gives the LLM access to
 * MCP tools (via tool-use) so it can query live data sources.
 *
 * Applies type-specific validation to filter malformed values.
 * Preserves manual overrides from any existing resolution.
 */
export async function resolveList(
  definition: ListDefinition,
  config: ListResolverConfig,
  existing?: ResolvedList,
  onProgress?: (message: string) => void,
): Promise<ResolvedList>;

/**
 * Resolves all list definitions, respecting content-hash caching.
 * Skips resolution for lists whose inputs haven't changed and whose
 * existing resolution is still valid.
 */
export async function resolveAllLists(
  definitions: ListDefinition[],
  config: ListResolverConfig,
  existingLists?: DynamicListsFile,
  onProgress?: (message: string) => void,
): Promise<DynamicListsFile>;
```

### Resolution Flow

The resolver uses a Zod schema to get structured output from the LLM, ensuring the response is a typed array of strings rather than free-form text that needs fragile parsing:

```typescript
const listResponseSchema = z.object({
  values: z.array(z.string()).describe('The list of resolved values'),
});
```

For a knowledge-based list (e.g., "major news sites"):

```
LLM prompt:
  "List the 20 most popular English-language news websites by domain name.
   Return domain names or wildcard patterns like *.example.com."

LLM structured response (via Zod schema):
  { "values": ["cnn.com", "bbc.com", "nytimes.com", "reuters.com", ...] }

Post-processing:
  1. Validate each value with LIST_TYPE_REGISTRY['domains'].validate()
  2. Deduplicate
  3. Apply manual overrides: add manualAdditions, remove manualRemovals
```

For a data-backed list (e.g., "my contacts"):

```
LLM has access to MCP tools (e.g., contacts__list_contacts)

LLM prompt:
  "Query the contacts database and return all email addresses.
   Return email addresses in user@domain format."

LLM tool call: contacts__list_contacts({})
LLM receives: [{name: "Alice", email: "alice@example.com"}, ...]

LLM structured response (via Zod schema):
  { "values": ["alice@example.com", "bob@company.org", ...] }

Post-processing: same as above but with email validation
```

### Pipeline Integration

The resolution step slots into `compile.ts` after rule compilation:

```
[1/4] Compiling constitution         (existing, now emits listDefinitions)
[1.5/4] Resolving dynamic lists      (NEW -- only runs if listDefinitions present)
[2/4] Generating test scenarios       (existing, receives resolved list values)
[3/4] Verifying policy                (existing, PolicyEngine receives dynamicLists)
```

When no `listDefinitions` are present in the compiled output, step 1.5 is skipped entirely. The pipeline numbering adjusts dynamically.

### Integration with Scenario Generation and Verification

Both downstream pipeline steps need access to resolved lists:

**Scenario generation** (`generateScenarios()`) must produce test scenarios that exercise list-based rules. The scenario generator prompt is extended with a summary of resolved lists and their effective values, so the LLM can generate both positive scenarios (e.g., "fetch cnn.com — expect allow") and negative scenarios (e.g., "fetch evil.com — expect deny"). The resolved list values become part of the scenario hash, so a list refresh invalidates cached scenarios.

**Verification** constructs `PolicyEngine` instances at three points in `compile.ts`:
1. `filterEngine` (line 472) — for filtering structural conflicts from scenarios
2. `verifyCompiledPolicy()` which calls `verifyPolicy()` in `policy-verifier.ts` (line 151) — the main verification engine
3. During repair loop iterations — reuses `verifyCompiledPolicy()`

All three must pass the `DynamicListsFile` so that `@list-name` references are expanded before evaluation. The `verifyCompiledPolicy()` function gains a `dynamicLists` parameter that is threaded through to the `PolicyEngine` constructor. The `filterEngine` in `compile.ts` is constructed with the same `dynamicLists`.

### Caching

Each resolved list has an `inputHash` computed from:
- The list definition (name, type, generationPrompt, requiresMcp)
- The resolver prompt template

If the hash matches the existing resolution, the LLM call is skipped. Manual overrides are never part of the hash -- they are always preserved.

## Policy Engine Changes

### Loading Dynamic Lists at Runtime

The existing `loadGeneratedPolicy()` in `src/config/index.ts` returns `{ compiledPolicy, toolAnnotations }`. It must be extended to also load `dynamic-lists.json` when present:

```typescript
export function loadGeneratedPolicy(generatedDir: string, fallbackDir?: string): {
  compiledPolicy: CompiledPolicyFile;
  toolAnnotations: ToolAnnotationsFile;
  dynamicLists: DynamicListsFile | undefined;  // NEW
} {
  // ... existing loading ...
  const dynamicLists = loadOptionalGeneratedFile<DynamicListsFile>(
    generatedDir, 'dynamic-lists.json', fallbackDir,
  );
  return { compiledPolicy, toolAnnotations, dynamicLists };
}
```

The three runtime call sites that construct `PolicyEngine` must pass the loaded `dynamicLists`:

1. **`mcp-proxy-server.ts`** (line 258-261) — the standalone MCP proxy process
2. **`trusted-process/index.ts`** (line 33-36) — the in-process `TrustedProcess` class
3. **`pipeline/policy-verifier.ts`** (line 151) — the verification step during compilation

All three follow the same pattern: destructure `dynamicLists` from `loadGeneratedPolicy()` and pass it as the new final argument to `new PolicyEngine(...)`.

### Load-Time Expansion

`PolicyEngine` constructor gains a new optional parameter:

```typescript
class PolicyEngine {
  constructor(
    compiledPolicy: CompiledPolicyFile,
    toolAnnotations: ToolAnnotationsFile,
    protectedPaths: string[],
    allowedDirectory?: string,
    serverDomainAllowlists?: ReadonlyMap<string, readonly string[]>,
    dynamicLists?: DynamicListsFile,  // NEW
  ) {
    // ... existing setup ...
    this.compiledPolicy = dynamicLists
      ? this.expandListReferences(compiledPolicy, dynamicLists)
      : compiledPolicy;
  }
}
```

The `expandListReferences` method walks all rules and replaces `@list-name` entries:

```typescript
private expandListReferences(
  policy: CompiledPolicyFile,
  lists: DynamicListsFile,
): CompiledPolicyFile {
  const expandedRules = policy.rules.map(rule => {
    let expandedRule = rule;

    // Expand @list-name in domains.allowed
    if (rule.if.domains?.allowed) {
      const expandedAllowed = rule.if.domains.allowed.flatMap(entry =>
        entry.startsWith('@')
          ? this.getEffectiveListValues(entry.slice(1), lists)
          : [entry]
      );
      expandedRule = {
        ...expandedRule,
        if: {
          ...expandedRule.if,
          domains: { ...expandedRule.if.domains!, allowed: expandedAllowed },
        },
      };
    }

    // Expand @list-name in each lists[] entry
    if (rule.if.lists) {
      const expandedLists = rule.if.lists.map(listCond => {
        const expandedAllowed = listCond.allowed.flatMap(entry =>
          entry.startsWith('@')
            ? this.getEffectiveListValues(entry.slice(1), lists)
            : [entry]
        );
        return { ...listCond, allowed: expandedAllowed };
      });
      expandedRule = {
        ...expandedRule,
        if: { ...expandedRule.if, lists: expandedLists },
      };
    }

    return expandedRule;
  });

  return { ...policy, rules: expandedRules };
}
```

The `getEffectiveListValues` method computes:

```typescript
private getEffectiveListValues(
  listName: string,
  lists: DynamicListsFile,
): string[] {
  const list = lists.lists[listName];
  if (!list) {
    throw new Error(
      `Dynamic list "@${listName}" referenced in policy but not found in dynamic-lists.json. ` +
      `Run "ironcurtain compile-policy" to resolve lists.`
    );
  }

  const removals = new Set(list.manualRemovals);
  return [...new Set([...list.values, ...list.manualAdditions])]
    .filter(v => !removals.has(v));
}
```

### New Extraction Function

The existing module-level extraction functions are type-specific: `extractAnnotatedPaths()` returns raw string values for path-category roles, and `extractAnnotatedUrls()` returns `{ value, role, roleDef }` tuples with URL-specific resolution. For `ListCondition`, we need a generic extraction function that pulls raw string values from arguments whose annotated roles match the target roles. This is structurally identical to `extractAnnotatedPaths()` but without the path-specific naming:

```typescript
// policy-engine.ts (module-level, alongside extractAnnotatedPaths and extractAnnotatedUrls)

/**
 * Extracts raw string values from arguments based on annotation roles.
 * Generic version of extractAnnotatedPaths -- no type-specific normalization.
 * Used by ListCondition evaluation.
 */
function extractAnnotatedValues(
  args: Record<string, unknown>,
  annotation: ToolAnnotation,
  targetRoles: ArgumentRole[],
): string[] {
  // Same logic as extractAnnotatedPaths: iterate annotation.args,
  // check role intersection with targetRoles, collect string values.
}
```

Note: `extractAnnotatedPaths()` could be refactored to delegate to this function, but that is a cleanup opportunity, not a requirement for the initial implementation.

### New Condition Evaluation: `lists`

The `ruleMatches` method in `PolicyEngine` is extended to handle the `lists` condition:

```typescript
// In ruleMatches(), after domains check:
if (cond.lists !== undefined) {
  for (const listCond of cond.lists) {
    const extractedValues = extractAnnotatedValues(
      request.arguments, annotation, listCond.roles,
    );

    if (extractedValues.length === 0) return false;

    const matcher = getListMatcher(listCond.matchType);
    const allMatch = extractedValues.every(v =>
      listCond.allowed.some(pattern => matcher(v, pattern))
    );
    if (!allMatch) return false;
  }
}
```

Matcher functions by type:

```typescript
function getListMatcher(type: ListType): (value: string, pattern: string) => boolean {
  switch (type) {
    case 'domains':
      return (v, p) => domainMatchesAllowlist(v, [p]);
    case 'emails':
      return (v, p) => v.toLowerCase() === p.toLowerCase();
    case 'identifiers':
      return (v, p) => v === p;
  }
}
```

### Interaction with Existing Conditions

The `lists` condition follows the same semantics as `domains`:

- Zero extracted values = condition not satisfied, rule does not match.
- All extracted values must match at least one entry in `allowed`.
- The condition is role-scoped: only arguments with matching annotated roles are checked.

**Critical: per-role evaluation integration.** The `lists` condition must be recognized by `hasRoleConditions()` and `ruleRelevantToRole()`. Without this, a rule with only a `lists` condition would be treated as role-agnostic, causing it to match during evaluation of unrelated roles — a correctness bug. The required changes:

```typescript
function hasRoleConditions(rule: CompiledRule): boolean {
  return rule.if.roles !== undefined
    || rule.if.paths !== undefined
    || rule.if.domains !== undefined
    || (rule.if.lists !== undefined && rule.if.lists.length > 0);  // NEW
}

function ruleRelevantToRole(rule: CompiledRule, role: ArgumentRole): boolean {
  const cond = rule.if;
  if (cond.roles !== undefined && !cond.roles.includes(role)) return false;
  if (cond.paths !== undefined && !cond.paths.roles.includes(role)) return false;
  if (cond.domains !== undefined && !cond.domains.roles.includes(role)) return false;
  // NEW: rule is relevant if ANY list condition references this role
  if (cond.lists !== undefined && !cond.lists.some(lc => lc.roles.includes(role))) return false;
  return true;
}
```

## Refresh Mechanism

### CLI Command: `ironcurtain refresh-lists`

```
ironcurtain refresh-lists [--list <name>] [--with-mcp]
```

- Without `--list`: refreshes all lists.
- With `--list <name>`: refreshes only the named list.
- Without `--with-mcp`: resolves knowledge-based lists only. Data-backed lists (`requiresMcp: true`) are skipped with a warning — their existing resolution is preserved.
- With `--with-mcp`: connects to MCP servers to also refresh data-backed lists. Fails with a descriptive error if the required MCP server is unavailable.

The refresh command:

1. Loads list definitions from `compiled-policy.json` (the authoritative source — not duplicated in `dynamic-lists.json`).
2. Loads `dynamic-lists.json` for existing resolutions and manual overrides.
3. For each list to refresh, runs `resolveList()` with the definition and existing resolution (preserving manual overrides).
4. Writes the updated `dynamic-lists.json`.
5. Does NOT re-run compilation, scenario generation, or verification.

### Caching During Refresh

Refresh always re-runs resolution (bypasses the `inputHash` cache). This is the explicit intent -- the user asked for a refresh because they want fresh data. The new resolution gets a new `inputHash` and `resolvedAt` timestamp.

## Error Handling

### Missing List at Load Time

If `PolicyEngine` encounters a `@list-name` reference but no corresponding entry exists in `dynamic-lists.json`, it throws a descriptive error. This is a hard failure -- the policy cannot be evaluated with unresolved symbolic references. The error message tells the user to run `ironcurtain compile-policy`.

### Resolution Failure

If the LLM fails to resolve a list (network error, malformed output, empty result), the resolver:

1. Logs a warning with the failure details.
2. Falls back to the existing resolution if one exists (stale but available).
3. If no existing resolution exists, emits an empty list with a warning. An empty list in a `domains.allowed` condition means the condition never matches, which makes the rule never fire. This is fail-safe for allow rules (the action falls through to deny/escalate). For deny rules with list conditions, an empty list means the denial does not trigger — this is technically fail-open for that specific deny rule, but the default escalate-all fallthrough at the end of the rule chain catches unmatched requests, so the overall policy remains safe. Deny rules with dynamic list conditions are expected to be rare (most list use cases are for allow rules).

### MCP Unavailable for Data-Backed Lists

If a list has `requiresMcp: true` but no MCP connections are available (e.g., during `refresh-lists` without `--with-mcp`), the resolver fails with a descriptive error. Data-backed lists require live data -- an LLM guess at "my contacts" would be meaningless and potentially dangerous (allowing email to fabricated addresses or missing real contacts). The error message tells the user to run with `--with-mcp` or ensure the required MCP server is configured and reachable.

### Validation Failures

Values that fail type-specific validation are filtered out with a warning:

```
Warning: Dropped invalid domain value "not a domain" from @major-news-sites
```

## Constitution Examples

### Example 1: News and Finance

Constitution:
```
You are allowed to collect news from the major news sites.
You are allowed to get financial data for major tech stocks.
You are not allowed to reach out to the Internet for other purposes.
```

Compiled rules (relevant excerpt):
```json
{
  "rules": [
    {
      "name": "allow-news-sites",
      "description": "Allow fetching from major news sites",
      "principle": "collect news from the major news sites",
      "if": {
        "domains": {
          "roles": ["fetch-url"],
          "allowed": ["@major-news-sites"]
        }
      },
      "then": "allow",
      "reason": "Constitution permits collecting news from major sites"
    },
    {
      "name": "allow-financial-data",
      "description": "Allow fetching financial data for tech stocks",
      "principle": "get financial data for major tech stocks",
      "if": {
        "domains": {
          "roles": ["fetch-url"],
          "allowed": ["@financial-data-providers"]
        }
      },
      "then": "allow",
      "reason": "Constitution permits financial data access"
    },
    {
      "name": "deny-other-internet",
      "description": "Deny all other internet access",
      "principle": "not allowed to reach out to the Internet for other purposes",
      "if": {
        "roles": ["fetch-url"]
      },
      "then": "deny",
      "reason": "Constitution forbids internet access beyond permitted categories"
    }
  ],
  "listDefinitions": [
    {
      "name": "major-news-sites",
      "type": "domains",
      "principle": "collect news from the major news sites",
      "generationPrompt": "List the 30 most widely-read English-language news websites. Include major newspapers, wire services, and broadcast news sites.",
      "requiresMcp": false
    },
    {
      "name": "financial-data-providers",
      "type": "domains",
      "principle": "get financial data for major tech stocks",
      "generationPrompt": "List the major financial data provider websites commonly used for stock market data, including Yahoo Finance, Google Finance, Bloomberg, MarketWatch, and similar.",
      "requiresMcp": false
    }
  ]
}
```

Resolved `dynamic-lists.json` (excerpt):
```json
{
  "lists": {
    "major-news-sites": {
      "values": [
        "cnn.com", "bbc.com", "nytimes.com", "reuters.com",
        "apnews.com", "theguardian.com", "washingtonpost.com",
        "wsj.com", "*.bbc.com", "*.cnn.com"
      ],
      "manualAdditions": [],
      "manualRemovals": [],
      "resolvedAt": "2026-02-20T10:00:00.000Z",
      "inputHash": "abc123..."
    }
  }
}
```

### Example 2: Email Contacts

Constitution:
```
The agent may read all my email. It may send email to people in my
contacts without asking. For anyone else, ask me first. Never delete
anything permanently.
```

Compiled rules (relevant excerpt):
```json
{
  "rules": [
    {
      "name": "allow-send-to-contacts",
      "description": "Allow sending email to known contacts",
      "principle": "send email to people in my contacts without asking",
      "if": {
        "server": ["email"],
        "tool": ["send_email"],
        "lists": [{
          "roles": ["email-recipient"],
          "allowed": ["@my-contacts"],
          "matchType": "emails"
        }]
      },
      "then": "allow",
      "reason": "Recipient is in the user's contacts"
    },
    {
      "name": "escalate-send-to-unknown",
      "description": "Escalate sending email to unknown recipients",
      "principle": "For anyone else, ask me first",
      "if": {
        "server": ["email"],
        "tool": ["send_email"]
      },
      "then": "escalate",
      "reason": "Recipient not in contacts; requires human approval"
    }
  ],
  "listDefinitions": [
    {
      "name": "my-contacts",
      "type": "emails",
      "principle": "send email to people in my contacts",
      "generationPrompt": "Query the contacts database and return all email addresses.",
      "requiresMcp": true,
      "mcpServerHint": "contacts"
    }
  ]
}
```

Note: this example assumes an `email-recipient` argument role has been added to the argument role registry for the email MCP server. The role registry is extensible by design -- adding `email-recipient` follows the same pattern as the existing `fetch-url` or `git-remote-url` roles.

## File Layout

```
src/pipeline/
  dynamic-list-types.ts      # NEW: ListType taxonomy and type registry
  list-resolver.ts           # NEW: LLM-driven list resolution
  types.ts                   # MODIFIED: ListDefinition, ResolvedList, DynamicListsFile
  constitution-compiler.ts   # MODIFIED: prompt + schema for list emission
  compile.ts                 # MODIFIED: list resolution sub-step

src/trusted-process/
  policy-engine.ts           # MODIFIED: load-time expansion, ListCondition eval

src/config/
  generated/
    dynamic-lists.json       # NEW artifact (written to ~/.ironcurtain/generated/)
```

## Testing Strategy

### Unit Tests

- **List type registry**: validate/reject test values for each type. Verify matcher functions for edge cases (wildcard domains, case-insensitive emails, exact identifiers).

- **Compiler list emission**: provide a constitution with categorical references, mock LLM, verify that `listDefinitions` are emitted and `@list-name` references appear in rules. Verify validation catches orphaned references and orphaned definitions.

- **List resolver**: mock LLM returning various response formats (numbered lists, bare lines, mixed with explanations). Verify post-processing produces clean value arrays. Verify type validation filters malformed values. Verify manual overrides are preserved.

- **Policy engine expansion**: construct a `CompiledPolicyFile` with `@list-name` references and a `DynamicListsFile` with resolved values. Verify expansion produces correct concrete rules. Verify missing list throws descriptive error. Verify manual additions and removals are applied correctly.

- **ListCondition evaluation**: construct rules with `lists` conditions and verify matching semantics for each type. Verify zero-extraction behavior. Verify interaction with per-role evaluation.

### Integration Tests

- **End-to-end pipeline**: run `compile-policy` with a constitution containing categorical references against a real LLM. Verify list definitions are emitted, resolved, and the expanded policy passes verification.

- **Refresh**: resolve a list, modify `dynamic-lists.json` with manual overrides, run refresh, verify overrides are preserved and values are updated.

## Extensibility

### Adding a New List Type

Adding a new list type (e.g., `file-patterns` for glob patterns) requires:

1. Add the type to the `ListType` union.
2. Add an entry to `LIST_TYPE_REGISTRY` with validate, formatGuidance.
3. Add a case to `getListMatcher()`.
4. Update the compiler prompt to mention the new type.

All validation, resolution, and evaluation flows pick up the new type automatically via the registry.

### Adding MCP-Backed Resolution

The resolver's MCP integration is optional. When available, it creates an AI SDK `generateText` call with MCP tools bridged as AI SDK tools (same pattern as the existing agent). This means any MCP server can be used for list resolution -- contacts, CRM, inventory, etc. -- without resolver-specific integration code.

### Future: List Freshness Policies

The `ListDefinition` type could be extended with a `refreshPolicy` field:

```typescript
readonly refreshPolicy?: {
  readonly maxAge: number;    // seconds
  readonly autoRefresh: boolean;
};
```

The policy engine could check `resolvedAt` against `maxAge` and trigger a background refresh. This is not in scope for the initial implementation.

## Migration Notes

### Backward Compatibility

- `compiled-policy.json` without `listDefinitions` is valid and works identically to today. The field is optional.
- `PolicyEngine` without `dynamicLists` parameter works identically to today.
- Existing constitutions that reference no categories produce no list definitions.
- No changes to the `annotate-tools` pipeline step.
- No changes to the argument role registry (new roles like `email-recipient` are orthogonal and would be added via the existing extension mechanism when an email MCP server is onboarded).

### Incremental Implementation

1. **Phase 1 -- Types and compiler emission**: Add `ListDefinition` types, extend compiler prompt and schema, extend validation. No resolution yet -- lists are emitted but not resolved. The verification step would fail if lists are referenced, providing a natural checkpoint.

2. **Phase 2 -- Resolution and expansion**: Add `list-resolver.ts` and `dynamic-list-types.ts`. Wire resolution into `compile.ts`. Add load-time expansion to `PolicyEngine`. End-to-end pipeline works for knowledge-based lists.

3. **Phase 3 -- MCP-backed resolution**: Add MCP client integration to the resolver. Wire `--with-mcp` flag. Data-backed lists work.

4. **Phase 4 -- Refresh command**: Add `ironcurtain refresh-lists` CLI command. Standalone refresh without full recompilation.

## Open Considerations

### Quality of LLM-Generated Lists

The resolver LLM produces best-effort lists from its training data. "Major news sites" is subjective and the LLM's list may not match the user's expectations. Mitigation: the resolved list is written to a user-inspectable artifact, and the user can add or remove entries via `manualAdditions`/`manualRemovals`. The refresh mechanism allows periodic updates as the LLM's knowledge improves or web search becomes available.

### Security of MCP-Backed Resolution

When the resolver connects to MCP servers and gives the LLM tool-use capabilities, the LLM could potentially be manipulated by adversarial tool responses (e.g., a compromised contacts server returning attacker-controlled email addresses). Mitigation: the resolved list is user-inspectable, and the policy engine treats list values the same as any other policy condition -- they determine what is allowed, denied, or escalated, but the overall policy structure (including structural invariants) remains intact. A compromised list can at worst expand the set of allowed values, not bypass deny rules or structural protections.

### List Size Limits

Very large lists (thousands of entries) could impact policy load time and memory. For the initial implementation, no explicit size limit is enforced -- the existing domain allowlist mechanism handles lists of reasonable size efficiently. If this becomes a problem, a Bloom filter or sorted-array binary search could replace the linear scan in `domainMatchesAllowlist()`.
