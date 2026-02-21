# Implementation Plan: Policy Compilation Pipeline

**Design spec:** `docs/designs/policy-compilation-pipeline.md`
**Date:** 2026-02-17
**Status:** Implemented -- all steps completed.

## Principles

This plan follows **tracer bullet methodology**: we get the simplest end-to-end working pipeline as early as possible, then fill in the LLM-driven stages one by one. The critical insight is that the PolicyEngine refactor (Step 2) and the compiled-policy JSON format are the core -- everything upstream (annotator, compiler, scenario generator, verifier) produces inputs for the engine. We can stub those inputs with hand-crafted JSON files first, prove the engine works, then build the generators.

## Critical Path

The minimum sequence to reach "it works end-to-end":

```
Step 1: Pipeline types
  --> Step 2: Refactored PolicyEngine (loads compiled JSON, structural invariants)
    --> Step 3: Existing tests pass with hand-crafted compiled-policy.json
      --> Step 4: Wiring changes (TrustedProcess, mcp-proxy-server)
        --> Step 5: Integration tests pass
```

After the critical path, the LLM pipeline stages (Steps 6-10) can be built and tested independently against the working engine.

---

## Step 1: Define Pipeline Types

**Goal:** Create the shared type definitions that all pipeline modules and the refactored PolicyEngine depend on. This is pure types with no runtime behavior -- it can be verified by `tsc --noEmit`.

**Files created:**
- `src/pipeline/types.ts`

**What it contains:**

```typescript
// Tool annotation types
type ArgumentRole = 'read-path' | 'write-path' | 'delete-path' | 'none';

interface ToolAnnotation {
  toolName: string;
  serverName: string;
  comment: string;               // LLM-generated description
  sideEffects: boolean;
  args: Record<string, ArgumentRole[]>;
}

interface ToolAnnotationsFile {
  generatedAt: string;
  servers: Record<string, { inputHash: string; tools: ToolAnnotation[] }>;
}

// Compiled policy types
interface PathCondition {
  roles: ArgumentRole[];
  within: string;
}

interface CompiledRuleCondition {
  roles?: ArgumentRole[];        // match tools with any argument having these roles
  server?: string[];
  tool?: string[];
  sideEffects?: boolean;
  paths?: PathCondition;
}

interface CompiledRule {
  name: string;
  description: string;
  principle: string;
  if: CompiledRuleCondition;
  then: 'allow' | 'deny' | 'escalate';
  reason: string;
}

interface CompiledPolicyFile {
  generatedAt: string;
  constitutionHash: string;
  inputHash: string;             // content hash for caching
  rules: CompiledRule[];
}

// Test scenario types
interface TestScenario {
  description: string;
  request: {
    serverName: string;
    toolName: string;
    arguments: Record<string, unknown>;
  };
  expectedDecision: 'allow' | 'deny' | 'escalate';
  reasoning: string;
  source: 'generated' | 'handwritten';
}

interface TestScenariosFile {
  generatedAt: string;
  constitutionHash: string;
  inputHash: string;             // content hash for caching
  scenarios: TestScenario[];
}

// Verifier types
interface ExecutionResult {
  scenario: TestScenario;
  actualDecision: 'allow' | 'deny' | 'escalate';
  matchingRule: string;
  pass: boolean;
}

interface VerifierRound {
  round: number;
  executionResults: ExecutionResult[];
  llmAnalysis: string;
  newScenarios: TestScenario[];
}

interface VerificationResult {
  pass: boolean;
  rounds: VerifierRound[];
  summary: string;
  failedScenarios: ExecutionResult[];
}
```

Note: The design originally included a `StructuralConfig` interface. In the implementation, `protectedPaths: string[]` is passed directly to the `PolicyEngine` constructor and to `CompilerConfig` -- no wrapper interface is needed.

**Files modified:**
- `src/trusted-process/policy-types.ts` -- add `import type` for `EvaluationResult` from here as needed, but keep the existing `EvaluationResult` interface (the refactored engine in Step 2 still returns it).

**Verification:**
```bash
npx tsc --noEmit
```

**Depends on:** Nothing.

---

## Step 2: Refactor PolicyEngine to Declarative Evaluation

**Goal:** Replace the hardcoded `buildRules()` function-based chain with a two-phase engine: (1) hardcoded structural invariants, (2) declarative compiled rules loaded from the `CompiledPolicyFile` structure. The constructor changes from `new PolicyEngine(allowedDirectory)` to `new PolicyEngine(compiledPolicy, toolAnnotations, protectedPaths)`.

This is the most important step. It is the architectural pivot point.

**Files modified:**
- `src/trusted-process/policy-engine.ts` -- complete rewrite of internals
- `src/trusted-process/policy-types.ts` -- update to re-export or import from pipeline types

**Key implementation details:**

1. **Constructor signature changes:**
   ```typescript
   class PolicyEngine {
     constructor(
       compiledPolicy: CompiledPolicyFile,
       toolAnnotations: ToolAnnotationsFile,
       protectedPaths: string[],
     )
   }
   ```

2. **Build an annotation lookup map** in the constructor: `Map<string, ToolAnnotation>` keyed by `"serverName__toolName"`.

3. **`evaluate(request)` implementation:**

   **Structural checks -- Structural invariants (hardcoded):**
   - Extract paths from `request.arguments` using BOTH the heuristic (any string starting with `/` or `.`) AND annotation-based role extraction (union of both sets).
   - Resolve all paths via `path.resolve()`.
   - Check each resolved path against `protectedPaths`: a path is protected if it equals a protected path exactly, or starts with `protectedPath + '/'` (directory containment).
   - If any path is protected, return `{ decision: 'deny', rule: 'structural-protected-path', reason: ... }`.
   - If the tool has no annotation entry, return `{ decision: 'deny', rule: 'structural-unknown-tool', reason: ... }`.

   **Compiled rule evaluation:**
   - Look up the `ToolAnnotation` for the request.
   - Iterate `compiledPolicy.rules` in order.
   - For each rule, check all conditions in the `if` block:
     - `roles`: absent or tool has at least one argument whose annotated roles include any role in the list.
     - `server`: absent or `request.serverName` is in the array.
     - `tool`: absent or `request.toolName` is in the array.
     - `sideEffects`: absent or matches annotation's `sideEffects` value.
     - `paths`: absent or path condition evaluates to true (see below).
   - First fully matching rule: return its `then` as the decision.
   - No match: return default deny.

   **Multi-role evaluation:** For tools with multiple distinct roles (e.g., `move_file` with `read-path`, `write-path`, `delete-path`), each role is evaluated independently through the rule chain. The most restrictive result wins: `deny > escalate > allow`.

   **Path condition evaluation:**
   - For each argument in `request.arguments`, look up the argument's roles from the annotation.
   - If any role appears in `paths.roles`, extract the argument value as a path.
   - If zero paths extracted, condition NOT satisfied (rule does not match).
   - Resolve all extracted paths via `path.resolve()`.
   - `within`: true if ALL resolved paths start with `paths.within + '/'` or equal `paths.within`.

4. **Keep `extractPaths()` as a private utility** for the heuristic fallback in structural invariant checks.

5. **Keep `isWithinDirectory()` as a private utility** -- used by both structural invariant checks and compiled rule path evaluation.

6. **Remove:** `PROTECTED_PATTERNS`, `READ_TOOLS`, `WRITE_TOOLS`, `DELETE_TOOLS`, `touchesProtectedFile()`, `buildRules()`.

**Verification:**
```bash
npx tsc --noEmit
# Tests will NOT pass yet -- Step 3 adapts them
```

**Depends on:** Step 1.

---

## Step 3: Create Hand-Crafted Artifacts and Adapt Tests

**Goal:** Create hand-written `compiled-policy.json` and `tool-annotations.json` files that replicate the behavior of the current hardcoded engine. Adapt all existing tests to use the new `PolicyEngine` constructor. Every existing test must pass.

This is the "tracer bullet moment" -- the new engine works with hand-crafted data, producing identical decisions to the old engine.

**Files created:**
- `src/config/generated/compiled-policy.json` -- hand-crafted rules matching the example in the design spec
- `src/config/generated/tool-annotations.json` -- hand-crafted annotations for the filesystem MCP server tools

**Files modified:**
- `test/policy-engine.test.ts` -- update `PolicyEngine` construction and test assertions

**Hand-crafted `tool-annotations.json`:**

Include annotations for all known filesystem tools (no `effect` field -- argument roles are the single source of truth):
- `read_file`: sideEffects=true, args: `{ path: ["read-path"] }`
- `read_text_file`: sideEffects=true, args: `{ path: ["read-path"] }`
- `read_media_file`: sideEffects=true, args: `{ path: ["read-path"] }`
- `read_multiple_files`: sideEffects=true, args: `{ paths: ["read-path"] }` -- note: this is an array argument, handled by the path extraction logic
- `list_directory`: sideEffects=true, args: `{ path: ["read-path"] }`
- `list_directory_with_sizes`: sideEffects=true, args: `{ path: ["read-path"] }`
- `directory_tree`: sideEffects=true, args: `{ path: ["read-path"] }`
- `search_files`: sideEffects=true, args: `{ path: ["read-path"] }`
- `get_file_info`: sideEffects=true, args: `{ path: ["read-path"] }`
- `list_allowed_directories`: sideEffects=false, args: `{}`
- `write_file`: sideEffects=true, args: `{ path: ["write-path"] }`
- `edit_file`: sideEffects=true, args: `{ path: ["write-path"] }`
- `create_directory`: sideEffects=true, args: `{ path: ["write-path"] }`
- `move_file`: sideEffects=true, args: `{ source: ["read-path", "delete-path"], destination: ["write-path"] }`
- `delete_file`: sideEffects=true, args: `{ path: ["delete-path"] }`
- `delete_directory`: sideEffects=true, args: `{ path: ["delete-path"] }`

**Note on `sideEffects`:** Read tools that take path arguments are marked `sideEffects: true` because they can disclose information from arbitrary paths (information disclosure is a security-relevant side effect). Only `list_allowed_directories` (no path arguments, returns system configuration the agent already knows) gets `sideEffects: false`. The `allow-side-effect-free-tools` compiled rule then only matches truly argument-less query tools. All path-bearing tools fall through to the role-based and path-based rules.

**Test adaptation details:**

The existing tests check specific rule names. The new engine uses different rule names (from compiled-policy.json). The test assertions need updating:

| Old rule name | New rule name |
|---|---|
| `structural-protect-policy-files` | `structural-protected-path` |
| `deny-delete-operations` | `deny-delete-operations` (same name in compiled rules) |
| `allow-read-in-allowed-dir` | `allow-sandbox-read` |
| `deny-read-outside-allowed-dir` | `escalate-read-elsewhere` (changed to escalate) |
| `allow-write-in-allowed-dir` | `allow-sandbox-write` |
| `escalate-write-outside-allowed-dir` | `escalate-write-elsewhere` |
| `default-deny` | `default-deny` (same) |

The test helper `makeRequest` stays the same. The `PolicyEngine` construction changes:

```typescript
// Old:
const engine = new PolicyEngine('/tmp/ironcurtain-sandbox');

// New:
import compiledPolicy from '../src/config/generated/compiled-policy.json';
import toolAnnotations from '../src/config/generated/tool-annotations.json';

const protectedPaths = [
  'src/config/constitution.md',
  'src/config/generated/',
  'src/config/mcp-servers.json',
  './audit.jsonl',
];
const engine = new PolicyEngine(compiledPolicy, toolAnnotations, protectedPaths);
```

Alternatively, to avoid importing JSON directly (which can be finicky with ESM/Node16), create a small loader utility. Or use `readFileSync` + `JSON.parse` in the test setup.

**Test for structural invariants -- protected paths vs. patterns:**

The old engine uses substring matching (`p.includes('constitution.md')`). The new engine uses exact path/directory containment. This changes behavior:

- Old: `{ path: '/tmp/ironcurtain-sandbox/constitution.md' }` -- denied because `constitution.md` substring matches.
- New: Depends on whether `/tmp/ironcurtain-sandbox/constitution.md` matches any protected path. The protected path `src/config/constitution.md` resolves to an absolute path in the project directory, NOT in the sandbox. So the test file `/tmp/ironcurtain-sandbox/constitution.md` would NOT be caught by the new structural invariant.

This is actually correct behavior -- the new engine protects the REAL constitution file, not any file that happens to contain "constitution.md" in its name. But the existing test expects this to be denied. We need to update the test:

- Change the constitution.md test to use the actual project path (e.g., resolve `src/config/constitution.md` relative to the project root).
- Or add the sandbox constitution.md test as a "this should now be ALLOWED" test to document the behavior change.
- For the integration test that checks `constitution.md` in the sandbox: this needs updating too.

**Decision:** Update the tests to use real protected paths. Add a comment documenting that files with protected-sounding names in the sandbox are no longer denied -- only the actual system files are protected. This is a deliberate security improvement (less false positives, precise protection).

However, for backward compatibility during the transition, we could also add the `constitutionHash` check or keep a heuristic. But the design spec is explicit: "Protected paths, not patterns." We follow the design spec.

**Specific test changes:**

1. The `denies access to constitution files` test currently uses `{ path: '/tmp/ironcurtain-sandbox/constitution.md' }`. Change to `{ path: '<project-root>/src/config/constitution.md' }` where `<project-root>` is resolved at test time.

2. The `denies access to policy engine files` test uses `{ path: '/some/path/policy-engine.ts' }`. This will no longer match because `/some/path/policy-engine.ts` is not a protected path. Change to use a path within `src/config/generated/` or the actual policy-engine.ts path.

3. The `denies write to audit log` test uses `{ path: '/tmp/ironcurtain-sandbox/audit-log.jsonl' }`. Change to use the actual audit log path.

4. The integration test `denies access to constitution files` uses `{ path: '${SANDBOX_DIR}/constitution.md' }`. Same issue -- update to use a real protected path.

**Protected paths for tests:** Resolve these at test setup time:
```typescript
const projectRoot = resolve(__dirname, '..');
const protectedPaths = [
  resolve(projectRoot, 'src/config/constitution.md'),
  resolve(projectRoot, 'src/config/generated'),
  resolve(projectRoot, 'src/config/mcp-servers.json'),
  './audit.jsonl',  // resolved relative to cwd
];
```

**Verification:**
```bash
npm test
# All tests pass, including policy-engine.test.ts and integration.test.ts
```

**Depends on:** Steps 1, 2.

---

## Step 4: Wire Refactored PolicyEngine into TrustedProcess and MCP Proxy

**Goal:** Update `TrustedProcess` and `mcp-proxy-server.ts` to construct the new `PolicyEngine` with compiled policy, tool annotations, and protected paths loaded from `src/config/generated/`.

**Files modified:**
- `src/trusted-process/index.ts` -- update PolicyEngine construction
- `src/trusted-process/mcp-proxy-server.ts` -- update PolicyEngine construction
- `src/config/index.ts` -- add loading of generated artifacts and protected paths computation
- `src/config/types.ts` -- extend `IronCurtainConfig` with generated artifact paths and protected paths

**Config changes (`src/config/types.ts`):**

```typescript
export interface IronCurtainConfig {
  anthropicApiKey: string;
  auditLogPath: string;
  allowedDirectory: string;
  mcpServers: Record<string, MCPServerConfig>;
  // New fields for compiled policy
  protectedPaths: string[];
  generatedDir: string;          // path to src/config/generated/
  constitutionPath: string;      // path to constitution.md
}
```

**Config loading changes (`src/config/index.ts`):**

```typescript
export function loadConfig(): IronCurtainConfig {
  // ... existing code ...

  const constitutionPath = resolve(__dirname, 'constitution.md');
  const generatedDir = resolve(__dirname, 'generated');
  const mcpServersPath = resolve(__dirname, 'mcp-servers.json');

  const protectedPaths = [
    constitutionPath,
    generatedDir,            // directory -- protects everything inside
    mcpServersPath,
    resolve(auditLogPath),   // audit log
  ];

  return {
    // ... existing fields ...
    protectedPaths,
    generatedDir,
    constitutionPath,
  };
}
```

Add a new function to load generated artifacts:

```typescript
export function loadGeneratedPolicy(generatedDir: string): {
  compiledPolicy: CompiledPolicyFile;
  toolAnnotations: ToolAnnotationsFile;
} {
  const compiledPolicy = JSON.parse(
    readFileSync(resolve(generatedDir, 'compiled-policy.json'), 'utf-8')
  );
  const toolAnnotations = JSON.parse(
    readFileSync(resolve(generatedDir, 'tool-annotations.json'), 'utf-8')
  );
  return { compiledPolicy, toolAnnotations };
}
```

**TrustedProcess changes (`src/trusted-process/index.ts`):**

```typescript
constructor(private config: IronCurtainConfig, options?: TrustedProcessOptions) {
  const { compiledPolicy, toolAnnotations } = loadGeneratedPolicy(config.generatedDir);
  this.policyEngine = new PolicyEngine(compiledPolicy, toolAnnotations, config.protectedPaths);
  // ... rest unchanged ...
}
```

**MCP Proxy changes (`src/trusted-process/mcp-proxy-server.ts`):**

The proxy gets its config from environment variables. Add two new env vars:
- `GENERATED_DIR` -- path to the generated artifacts directory
- `PROTECTED_PATHS` -- JSON-serialized array of protected paths

Or, simpler: pass the full config as `MCP_PROXY_CONFIG` (a superset of the current `MCP_SERVERS_CONFIG`). But this is a larger change. For now, add `GENERATED_DIR` and `PROTECTED_PATHS` env vars.

```typescript
const generatedDir = process.env.GENERATED_DIR;
if (!generatedDir) {
  process.stderr.write('GENERATED_DIR environment variable is required\n');
  process.exit(1);
}
const protectedPathsJson = process.env.PROTECTED_PATHS ?? '[]';
const protectedPaths: string[] = JSON.parse(protectedPathsJson);

const { compiledPolicy, toolAnnotations } = loadGeneratedPolicy(generatedDir);
const policyEngine = new PolicyEngine(compiledPolicy, toolAnnotations, protectedPaths);
```

Also update `src/sandbox/index.ts` (or wherever the proxy is spawned) to pass these new env vars.

**Verification:**
```bash
npm test
npm start "list the files in the sandbox"  # manual smoke test
```

**Depends on:** Steps 1, 2, 3.

---

## Step 5: Update Integration Tests

**Goal:** Ensure the integration test (`test/integration.test.ts`) works with the refactored TrustedProcess. The integration test constructs `IronCurtainConfig` directly, so it needs the new fields.

**Files modified:**
- `test/integration.test.ts` -- add `protectedPaths`, `generatedDir`, `constitutionPath` to config; update rule name assertions where needed.

**Key changes:**

```typescript
const config: IronCurtainConfig = {
  anthropicApiKey: 'not-needed-for-this-test',
  auditLogPath: AUDIT_LOG_PATH,
  allowedDirectory: SANDBOX_DIR,
  mcpServers: { /* ... same ... */ },
  protectedPaths: [
    resolve(__dirname, '..', 'src/config/constitution.md'),
    resolve(__dirname, '..', 'src/config/generated'),
    resolve(__dirname, '..', 'src/config/mcp-servers.json'),
    resolve(AUDIT_LOG_PATH),
  ],
  generatedDir: resolve(__dirname, '..', 'src/config/generated'),
  constitutionPath: resolve(__dirname, '..', 'src/config/constitution.md'),
};
```

Update the `denies access to constitution files` test to use a real protected path instead of a sandbox path.

**Verification:**
```bash
npm test
```

**Depends on:** Steps 3, 4.

---

**At this point, the critical path is complete.** The refactored PolicyEngine works with hand-crafted artifacts and all existing tests pass. The remaining steps build the LLM pipeline that GENERATES the artifacts automatically.

---

## Step 6: Handwritten Scenarios Module

**Goal:** Codify the existing test cases from `test/policy-engine.test.ts` as `TestScenario[]` in a dedicated module. These scenarios serve as human-authored ground truth that the verifier always checks.

**Files created:**
- `src/pipeline/handwritten-scenarios.ts`

**What it contains:**

A single exported function:

```typescript
export function getHandwrittenScenarios(sandboxDir: string): TestScenario[]
```

The function takes the sandbox directory as a parameter (since scenarios need concrete paths) and returns scenarios covering:

1. Read inside sandbox -> allow
2. Read outside sandbox -> escalate
3. List directory inside sandbox -> allow
4. Search files inside sandbox -> allow
5. Write inside sandbox -> allow
6. Write outside sandbox -> escalate
7. Delete inside sandbox -> deny
8. Delete outside sandbox -> deny
9. Path traversal attempt -> escalate (resolves outside sandbox)
10. Move sandbox-to-sandbox -> deny (source has delete-path role)
11. Move sandbox-to-external -> deny (source has delete-path role)
12. Move external-to-sandbox -> deny (source has delete-path role)
13. Move external-to-external -> deny (source has delete-path role)
14. Side-effect-free tool (`list_allowed_directories`) -> allow
15. Unknown tool -> deny (structural invariant)

Each scenario includes:
- `description`: human-readable description
- `request`: concrete `{ serverName, toolName, arguments }`
- `expectedDecision`: the expected policy verdict
- `reasoning`: why this follows from the constitution
- `source: 'handwritten'`

**Verification:**
```bash
npx tsc --noEmit
# Write a small unit test that imports and calls getHandwrittenScenarios, verifies count and structure
npx vitest run test/handwritten-scenarios.test.ts
```

**Depends on:** Step 1 (types only).

---

## Step 7: Tool Annotator

**Goal:** Implement the LLM-driven tool annotator that classifies MCP tools by their effects, side effects, and argument roles.

**Files created:**
- `src/pipeline/tool-annotator.ts`
- `test/tool-annotator.test.ts`

**Implementation:**

```typescript
import type { LanguageModel } from 'ai';
import { generateText, Output } from 'ai';
import type { ToolAnnotation } from './types.js';

export async function annotateTools(
  serverName: string,
  tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>,
  llm: LanguageModel,
): Promise<ToolAnnotation[]>
```

**Process:**
1. Build the prompt with all tool schemas for the server.
2. Call `generateText()` with `output: Output.object({ schema })` (AI SDK v6 pattern).
3. Validate the response: every tool from the input must appear in the output. Warn on missing tools.
4. Run the compile-time heuristic validator: for each tool, examine the schema for string arguments with path-like defaults or examples. If any look like paths but aren't annotated with a path role, emit a warning and return an error.

**Prompt design notes:**
- Provide the `ArgumentRole` definitions and semantics.
- Provide the `ToolAnnotation` interface.
- Instruct the LLM that an argument may have MULTIPLE roles (e.g., move source = read-path + delete-path).
- Instruct that `sideEffects: false` means the tool makes no state changes (pure query).

**Heuristic validator:**
```typescript
export function validateAnnotationsHeuristic(
  tools: Array<{ name: string; inputSchema: Record<string, unknown> }>,
  annotations: ToolAnnotation[],
): { valid: boolean; warnings: string[] }
```

Checks:
- For each tool argument of type `string`, if the argument name contains "path", "file", "dir", "directory", or "source" or "destination", the annotation should include a path role.
- If the schema has `default` or `examples` with values starting with `/` or `.`, the annotation should include a path role.

**Testing:**
- Mock the LLM with canned responses (use a `LanguageModel` stub that returns predetermined objects).
- Test with filesystem server tools.
- Test heuristic catches unannotated path args.
- Test multi-role annotations (move_file source).

**Verification:**
```bash
npx vitest run test/tool-annotator.test.ts
```

**Depends on:** Step 1.

---

## Step 8: Constitution Compiler

**Goal:** Implement the LLM-driven constitution compiler that produces `CompiledRule[]` from the constitution text, tool annotations, and system config.

**Files created:**
- `src/pipeline/constitution-compiler.ts`
- `test/constitution-compiler.test.ts`

**Implementation:**

```typescript
import type { LanguageModel } from 'ai';
import { generateText, Output } from 'ai';
import type { ToolAnnotation, CompiledRule } from './types.js';

export interface CompilerConfig {
  sandboxDirectory: string;
  protectedPaths: string[];
}

export async function compileConstitution(
  constitutionText: string,
  annotations: ToolAnnotation[],
  config: CompilerConfig,
  llm: LanguageModel,
): Promise<CompiledRule[]>
```

The prompt builder `buildCompilerPrompt` is also exported for content-hash computation.

**Process:**
1. Build the prompt with:
   - Full constitution text.
   - All tool annotations (so the LLM knows what tools exist).
   - The `CompiledRule` schema.
   - Concrete directory paths and protected paths from config.
   - Explicit instruction: do NOT generate rules for protected path checking or unknown tool denial (handled by structural invariants).
2. Call `generateText()` with `output: Output.object({ schema })` (AI SDK v6 pattern).
3. Validate output: rules must use concrete absolute paths, must have valid `then` values, must reference roles that exist in the annotations.

**Post-processing validation:**
```typescript
export function validateCompiledRules(
  rules: CompiledRule[],
): RuleValidationResult   // { valid: boolean; errors: string[]; warnings: string[] }
```

Checks:
- Every role referenced in `roles` or `paths.roles` is a valid `ArgumentRole`.
- `within` paths are absolute.
- No rule references "protected" or "structural" concepts (these are not compiled).

**Testing:**
- Mock LLM with a canned compiled policy (the example from the design spec).
- Verify the output structure.
- Verify validation catches invalid rules (e.g., relative paths, invalid roles).

**Verification:**
```bash
npx vitest run test/constitution-compiler.test.ts
```

**Depends on:** Step 1.

---

## Step 9: Scenario Generator

**Goal:** Implement the LLM-driven test scenario generator that produces test cases to verify the compiled policy.

**Files created:**
- `src/pipeline/scenario-generator.ts`
- `test/scenario-generator.test.ts`

**Implementation:**

```typescript
import type { LanguageModel } from 'ai';
import { generateText, Output } from 'ai';
import type { ToolAnnotation, TestScenario } from './types.js';

export async function generateScenarios(
  constitutionText: string,
  annotations: ToolAnnotation[],
  handwrittenScenarios: TestScenario[],
  sandboxDirectory: string,
  protectedPaths: string[],
  llm: LanguageModel,
): Promise<TestScenario[]>
```

The prompt builder `buildGeneratorPrompt` is also exported for content-hash computation.

**Process:**
1. Build the prompt with constitution, annotations, protected paths, and instructions for edge case coverage.
2. Call `generateText()` with `output: Output.object({ schema })` (AI SDK v6 pattern).
3. Mark all LLM-generated scenarios with `source: 'generated'`.
4. Merge with handwritten scenarios (handwritten first, then generated).
5. Deduplicate: if a generated scenario is substantially similar to a handwritten one (same tool, same arguments), drop the generated one.
6. Return the merged list.

**Testing:**
- Mock LLM with canned scenarios.
- Verify handwritten scenarios are always included.
- Verify deduplication logic.
- Verify `source` field is correct.

**Verification:**
```bash
npx vitest run test/scenario-generator.test.ts
```

**Depends on:** Steps 1, 6.

---

## Step 10: Policy Verifier

**Goal:** Implement the multi-round policy verifier that executes test scenarios against the real PolicyEngine and uses an LLM judge to analyze results.

**Files created:**
- `src/pipeline/policy-verifier.ts`
- `test/policy-verifier.test.ts`

**Implementation:**

```typescript
import type { LanguageModel } from 'ai';
import { PolicyEngine } from '../trusted-process/policy-engine.js';
import type {
  CompiledPolicyFile,
  ToolAnnotationsFile,
  TestScenario,
  ExecutionResult,
  VerifierRound,
  VerificationResult,
} from './types.js';

export async function verifyPolicy(
  constitutionText: string,
  compiledPolicy: CompiledPolicyFile,
  toolAnnotations: ToolAnnotationsFile,
  protectedPaths: string[],
  scenarios: TestScenario[],
  llm: LanguageModel,
  maxRounds?: number,             // default 3
): Promise<VerificationResult>
```

**Process:**

1. Instantiate a real `PolicyEngine` with the compiled policy, annotations, and protected paths.
2. Run all scenarios through the engine, producing `ExecutionResult[]`.
3. Build the verifier prompt with:
   - The constitution text (for reference).
   - The compiled rules (so the judge can see the policy).
   - The tool annotations.
   - The full execution results table.
   - Instructions: analyze discrepancies, identify suspicious patterns, identify missing coverage, optionally produce additional test scenarios.
4. Call LLM judge via `generateText()` with `output: Output.object({ schema })`.
5. If the judge produces additional scenarios, run them through the engine (Round 2).
6. Repeat up to `maxRounds`.
7. Aggregate results into `VerificationResult`.

**Execute scenarios helper:**

```typescript
function executeScenarios(
  engine: PolicyEngine,
  scenarios: TestScenario[],
): ExecutionResult[] {
  return scenarios.map(scenario => {
    const request: ToolCallRequest = {
      requestId: 'verify-' + crypto.randomUUID(),
      serverName: scenario.request.serverName,
      toolName: scenario.request.toolName,
      arguments: scenario.request.arguments,
      timestamp: new Date().toISOString(),
    };
    const result = engine.evaluate(request);
    return {
      scenario,
      actualDecision: result.decision,
      matchingRule: result.rule,
      pass: result.decision === scenario.expectedDecision,
    };
  });
}
```

**Testing:**
- Test with a known-good policy (all scenarios pass) -- verifier should report pass.
- Test with a known-bad policy (remove delete denial rule) -- verifier should report failures on delete scenarios.
- Mock the LLM judge to return predetermined analyses.
- Test multi-round: mock judge generates additional scenarios in Round 1, verifier runs Round 2.

**Verification:**
```bash
npx vitest run test/policy-verifier.test.ts
```

**Depends on:** Steps 1, 2, 3 (needs a working PolicyEngine with compiled rules).

---

## Step 11: CLI Entry Point and npm Scripts

**Goal:** Create the `compile-policy` CLI command that orchestrates the full pipeline, and add npm scripts.

**Files created:**
- `src/pipeline/compile.ts` -- CLI entry point

**Files modified:**
- `package.json` -- add `compile-policy` script and `bin` entry
- `src/index.ts` -- optionally dispatch subcommands (or keep separate entry point)

**CLI implementation (`src/pipeline/compile.ts`):**

```typescript
import 'dotenv/config';
import { createAnthropic } from '@ai-sdk/anthropic';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { annotateTools, validateAnnotationsHeuristic } from './tool-annotator.js';
import { compileConstitution, validateCompiledRules } from './constitution-compiler.js';
import { generateScenarios } from './scenario-generator.js';
import { verifyPolicy } from './policy-verifier.js';
import { getHandwrittenScenarios } from './handwritten-scenarios.js';
import type { MCPServerConfig } from '../config/types.js';
import type { ToolAnnotation, ToolAnnotationsFile, CompiledPolicyFile, TestScenariosFile } from './types.js';
import { createHash } from 'node:crypto';

async function main() {
  // 1. Load config
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const configDir = resolve(__dirname, '..', 'config');
  const constitutionPath = resolve(configDir, 'constitution.md');
  const constitutionText = readFileSync(constitutionPath, 'utf-8');
  const constitutionHash = createHash('sha256').update(constitutionText).digest('hex');
  const mcpServersPath = resolve(configDir, 'mcp-servers.json');
  const mcpServers: Record<string, MCPServerConfig> = JSON.parse(
    readFileSync(mcpServersPath, 'utf-8')
  );
  const generatedDir = resolve(configDir, 'generated');
  const allowedDirectory = process.env.ALLOWED_DIRECTORY ?? '/tmp/ironcurtain-sandbox';
  const auditLogPath = process.env.AUDIT_LOG_PATH ?? './audit.jsonl';

  const protectedPaths = [
    constitutionPath,
    generatedDir,
    mcpServersPath,
    resolve(auditLogPath),
  ];

  // 2. Create LLM instance
  const anthropic = createAnthropic();
  const llm = anthropic('claude-sonnet-4-6');

  // 3. Connect to MCP servers and list tools
  const allAnnotations: ToolAnnotation[] = [];
  const clients = new Map<string, Client>();

  for (const [serverName, config] of Object.entries(mcpServers)) {
    console.error(`Connecting to MCP server: ${serverName}...`);
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env
        ? { ...(process.env as Record<string, string>), ...config.env }
        : undefined,
    });
    const client = new Client({ name: 'ironcurtain-compiler', version: '0.1.0' });
    await client.connect(transport);
    clients.set(serverName, client);

    const toolsResult = await client.listTools();
    console.error(`  Found ${toolsResult.tools.length} tools on ${serverName}`);

    // 4. Annotate tools
    console.error(`  Annotating tools for ${serverName}...`);
    const annotations = await annotateTools(serverName, toolsResult.tools, llm);

    // 5. Validate annotations
    const validation = validateAnnotationsHeuristic(toolsResult.tools, annotations);
    if (!validation.valid) {
      console.error('Annotation validation failed:');
      for (const w of validation.warnings) console.error(`  - ${w}`);
      process.exit(1);
    }

    allAnnotations.push(...annotations);
  }

  // 6. Compile constitution
  console.error('Compiling constitution...');
  const compiledRules = await compileConstitution(
    constitutionText,
    allAnnotations,
    { sandboxDirectory: allowedDirectory, protectedPaths },
    llm,
  );

  // 7. Validate compiled rules
  const ruleValidation = validateCompiledRules(compiledRules);
  if (!ruleValidation.valid) {
    console.error('Compiled rule validation failed:');
    for (const e of ruleValidation.errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  // 8. Build artifacts (in the actual implementation, each artifact includes
  //    an inputHash for content-hash caching)
  const toolAnnotationsFile: ToolAnnotationsFile = {
    generatedAt: new Date().toISOString(),
    servers: {},    // per-server entries include inputHash
  };
  for (const ann of allAnnotations) {
    if (!toolAnnotationsFile.servers[ann.serverName]) {
      toolAnnotationsFile.servers[ann.serverName] = { inputHash: '...', tools: [] };
    }
    toolAnnotationsFile.servers[ann.serverName].tools.push(ann);
  }

  const compiledPolicyFile: CompiledPolicyFile = {
    generatedAt: new Date().toISOString(),
    constitutionHash,
    inputHash: '...',     // content hash for caching
    rules: compiledRules,
  };

  // 9. Generate test scenarios
  console.error('Generating test scenarios...');
  const handwrittenScenarios = getHandwrittenScenarios(allowedDirectory);
  const scenarios = await generateScenarios(
    constitutionText,
    allAnnotations,
    handwrittenScenarios,
    allowedDirectory,
    protectedPaths,
    llm,
  );

  // 10. Verify policy
  console.error('Verifying policy...');
  const verificationResult = await verifyPolicy(
    constitutionText,
    compiledPolicyFile,
    toolAnnotationsFile,
    protectedPaths,
    scenarios,
    llm,
    3,  // max rounds
  );

  // Note: In the actual implementation, artifacts are written to disk
  // immediately after each step (not only on success). This ensures
  // they're available for inspection even when verification fails,
  // and enables content-hash caching on subsequent runs.
  // LLM interactions are logged to llm-interactions.jsonl via AI SDK middleware.

  if (!verificationResult.pass) {
    console.error('\nVerification FAILED -- artifacts written but policy may need review.');
    process.exit(1);
  }

  console.error('\nPolicy compilation successful!');
  console.error(`  Rules: ${compiledRules.length}`);
  console.error(`  Scenarios tested: ${scenarios.length}`);
  console.error(`  Verification rounds: ${verificationResult.rounds.length}`);
  console.error(`  Artifacts written to: ${generatedDir}/`);

  // 12. Cleanup MCP connections
  for (const client of clients.values()) {
    try { await client.close(); } catch { /* ignore */ }
  }
}

main().catch((err) => {
  console.error('Policy compilation failed:', err);
  process.exit(1);
});
```

**package.json changes:**

```json
{
  "scripts": {
    "compile-policy": "tsx src/pipeline/compile.ts"
  },
  "bin": {
    "ironcurtain": "dist/index.js"
  }
}
```

**Verification:**
```bash
npm run compile-policy
# Should connect to filesystem MCP server, run pipeline, produce artifacts
# Then verify:
npm test
```

**Depends on:** Steps 6, 7, 8, 9, 10 (all pipeline modules).

---

## Step 12: End-to-End Verification

**Goal:** Run the full pipeline and verify that the LLM-generated artifacts produce identical decisions to the hand-crafted ones for all existing test cases.

**Process:**
1. Run `npm run compile-policy` -- this produces new generated artifacts.
2. Run `npm test` -- all existing tests must pass against the LLM-generated artifacts.
3. Compare the LLM-generated `compiled-policy.json` with the hand-crafted version to understand differences.
4. If tests fail, iterate on prompts in the annotator, compiler, or scenario generator.

**Files created:**
- `test/pipeline-integration.test.ts` -- an integration test that runs the full pipeline with a real LLM and verifies the output artifacts. This test is expensive (LLM calls) and should be tagged or skipped in normal CI.

**Verification:**
```bash
npm run compile-policy && npm test
```

**Depends on:** Step 11.

---

## Dependency Graph

```
Step 1: Pipeline types
  |
  +---> Step 2: Refactored PolicyEngine
  |       |
  |       +---> Step 3: Hand-crafted artifacts + test adaptation
  |               |
  |               +---> Step 4: Wiring changes (TrustedProcess, mcp-proxy-server)
  |               |       |
  |               |       +---> Step 5: Integration test updates
  |               |
  |               +---> Step 10: Policy verifier (needs working engine)
  |
  +---> Step 6: Handwritten scenarios
  |       |
  |       +---> Step 9: Scenario generator
  |
  +---> Step 7: Tool annotator
  |
  +---> Step 8: Constitution compiler
  |
  Steps 6-10 -----> Step 11: CLI entry point
                      |
                      +---> Step 12: End-to-end verification
```

**Parallelization opportunities:**
- Steps 6, 7, 8 can be implemented in parallel (all depend only on Step 1).
- Step 9 depends on Step 6 but not on 7 or 8.
- Step 10 depends on Steps 2 and 3.
- Steps 4 and 5 are sequential but independent of Steps 6-10.

---

## File Change Summary

### New files (in creation order):

| File | Step | Purpose |
|------|------|---------|
| `src/pipeline/types.ts` | 1 | Shared pipeline types (ToolAnnotation, CompiledRule, TestScenario, etc.) |
| `src/config/generated/tool-annotations.json` | 3 | Hand-crafted tool annotations (replaced by LLM output after Step 11) |
| `src/config/generated/compiled-policy.json` | 3 | Hand-crafted compiled policy (replaced by LLM output after Step 11) |
| `src/pipeline/handwritten-scenarios.ts` | 6 | Mandatory human-authored test scenarios |
| `test/handwritten-scenarios.test.ts` | 6 | Tests for the handwritten scenarios module |
| `src/pipeline/tool-annotator.ts` | 7 | LLM-driven tool annotation |
| `test/tool-annotator.test.ts` | 7 | Tool annotator tests |
| `src/pipeline/constitution-compiler.ts` | 8 | LLM-driven constitution compilation |
| `test/constitution-compiler.test.ts` | 8 | Constitution compiler tests |
| `src/pipeline/scenario-generator.ts` | 9 | LLM-driven test scenario generation |
| `test/scenario-generator.test.ts` | 9 | Scenario generator tests |
| `src/pipeline/policy-verifier.ts` | 10 | Multi-round policy verifier |
| `test/policy-verifier.test.ts` | 10 | Policy verifier tests |
| `src/pipeline/compile.ts` | 11 | CLI entry point |
| `test/pipeline-integration.test.ts` | 12 | End-to-end integration test |

### Modified files:

| File | Step | Changes |
|------|------|---------|
| `src/trusted-process/policy-engine.ts` | 2 | Complete rewrite: structural invariants + declarative compiled rule evaluation |
| `src/trusted-process/policy-types.ts` | 2 | Update imports, may re-export from pipeline types |
| `test/policy-engine.test.ts` | 3 | New PolicyEngine constructor, updated rule names, updated protected path tests |
| `src/config/types.ts` | 4 | Add `protectedPaths`, `generatedDir`, `constitutionPath` to IronCurtainConfig |
| `src/config/index.ts` | 4 | Compute protected paths, add `loadGeneratedPolicy()` function |
| `src/trusted-process/index.ts` | 4 | Use new PolicyEngine constructor |
| `src/trusted-process/mcp-proxy-server.ts` | 4 | Load generated artifacts, new env vars |
| `test/integration.test.ts` | 5 | New config fields, updated rule name assertions |
| `package.json` | 11 | Add `compile-policy` script and `bin` entry |

---

## Risks and Mitigations

### Risk 1: Protected path behavior change breaks expectations
The shift from substring patterns to exact path matching changes what gets caught. A file named `constitution.md` in the sandbox was previously denied; now it is allowed (unless it matches an actual protected path).

**Mitigation:** Step 3 explicitly updates tests to document the behavior change. This is a security improvement (fewer false positives). Add a comment in the test file explaining the design decision.

### Risk 2: LLM non-determinism produces bad annotations or rules
Different runs may produce different (and possibly wrong) compiled policies.

**Mitigation:** The verifier (Step 10) with real engine execution catches policy errors. The handwritten scenarios (Step 6) provide human-authored ground truth. The hand-crafted artifacts (Step 3) remain as a reference. If the LLM pipeline fails verification, the old artifacts are not overwritten.

### Risk 3: `sideEffects: false` rule allows too much
As analyzed in Step 3, a blanket `sideEffects: false -> allow` rule would allow reads outside the sandbox.

**Mitigation:** The hand-crafted artifacts use conservative annotations (only truly argument-less query tools get `sideEffects: false`). The handwritten scenarios include "read outside sandbox -> deny" which will catch this regression during verification.

### Risk 4: `read_multiple_files` has an array argument
The `read_multiple_files` tool takes a `paths` argument that is an array of strings, not a single string. The path extraction logic in the PolicyEngine needs to handle array arguments.

**Mitigation:** In Step 2, implement path extraction to handle both string and string array arguments:
```typescript
function extractAnnotatedPaths(
  args: Record<string, unknown>,
  annotation: ToolAnnotation,
  targetRoles: ArgumentRole[],
): string[] {
  const paths: string[] = [];
  for (const [argName, roles] of Object.entries(annotation.args)) {
    if (roles.some(r => targetRoles.includes(r))) {
      const value = args[argName];
      if (typeof value === 'string') {
        paths.push(value);
      } else if (Array.isArray(value)) {
        for (const v of value) {
          if (typeof v === 'string') paths.push(v);
        }
      }
    }
  }
  return paths;
}
```

### Risk 5: Proxy server env var proliferation
Adding `GENERATED_DIR` and `PROTECTED_PATHS` to the proxy server's env var interface is awkward.

**Mitigation:** Consider bundling all proxy config into a single `IRONCURTAIN_CONFIG` JSON env var in a future step. For the tracer bullet, individual env vars are acceptable.

---

## Estimated Effort Per Step

| Step | Estimate | Notes |
|------|----------|-------|
| 1 | Small | Pure types, no logic |
| 2 | Large | Core engine rewrite, most complex step |
| 3 | Medium | JSON crafting + test updates, requires care with protected path semantics |
| 4 | Medium | Wiring changes across multiple files |
| 5 | Small | Config additions to integration test |
| 6 | Small | Translating existing tests into scenario format |
| 7 | Medium | LLM integration, prompt design, heuristic validator |
| 8 | Medium | LLM integration, prompt design, rule validator |
| 9 | Small-Medium | LLM integration, deduplication logic |
| 10 | Medium-Large | Multi-round loop, LLM judge, execution harness |
| 11 | Medium | CLI orchestration, error handling, cleanup |
| 12 | Small | Run and verify |

**Critical path total:** Steps 1-5 (the engine refactor and wiring).
**Full pipeline total:** Steps 1-12.

---

## Checklist for Each Step

Before marking a step complete, verify:

- [ ] `npx tsc --noEmit` passes (no type errors)
- [ ] `npm run lint` passes
- [ ] `npm test` passes (all existing + new tests)
- [ ] No `any` types introduced without justification
- [ ] ESM conventions followed (`.js` extensions in imports)
- [ ] New files use `node:` prefix for Node.js built-ins
- [ ] Tests are independently runnable (`npx vitest run test/<file>.test.ts`)
