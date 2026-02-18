# Design: Policy Compilation Pipeline

**Status:** Draft v4
**Date:** 2026-02-17

## Problem

The current policy engine (`policy-engine.ts`) hardcodes filesystem tool names in `READ_TOOLS`, `WRITE_TOOLS`, and `DELETE_TOOLS` sets. Adding a new MCP server (Gmail, Slack, Calendar) requires manually updating these sets -- it doesn't scale. Additionally, `constitution.md` exists but is never read by the system; the policy rules that happen to reflect it are hand-written code.

We need:
1. Automatic discovery and classification of MCP tool capabilities.
2. A compilation pipeline that turns the English-language constitution into enforceable declarative policy rules, verified against real policy engine execution.
3. Persistent configuration artifacts produced by a dedicated command, not regenerated on every startup.

## Design Overview

The pipeline is a **separate offline command** (`ironcurtain compile-policy`) that produces three persistent configuration files:

```
constitution.md + MCP tool schemas
        |
        v
+---------------------+
|  Tool Annotator LLM |  -->  tool-annotations.json
+---------------------+
        |
        v
+--------------------------+
| Constitution Compiler LLM |  -->  compiled-policy.json
+--------------------------+
        |
        v
+------------------------------+
| Test Scenario Generator LLM  |  -->  test-scenarios.json
+------------------------------+
        |
        v
+---------------------------+
| Policy Verifier            |  -->  pass/fail + diagnostics
| (real engine + LLM judge)  |
+---------------------------+
```

If the verifier passes, the artifacts are written to `src/config/generated/`. At runtime, `PolicyEngine` loads `compiled-policy.json` and `tool-annotations.json` and evaluates declaratively -- no hardcoded tool sets.

**Critical architectural constraint:** Structural invariants are **never** part of the compiled policy. They are hardcoded in the PolicyEngine and evaluated before any compiled rules. See Section 7 for details.

**Packaging:** During development, `npm run compile-policy`. When published as a package, `npx ironcurtain compile-policy`. The CLI entry point dispatches subcommands.

## Component Details

### 1. Tool Annotation Schema

Each MCP tool is annotated with its **effect**, whether it has **side effects**, and the **roles** of its arguments. An argument can carry multiple roles (e.g., the source of a move is both a read-path and a delete-path).

```typescript
type ArgumentRole = 'read-path' | 'write-path' | 'delete-path' | 'none';

interface ToolAnnotation {
  toolName: string;
  serverName: string;
  effect: 'read' | 'write' | 'delete' | 'move' | 'other';
  sideEffects: boolean;           // false = no security-relevant side effects (no state changes, no information disclosure)
  args: Record<string, ArgumentRole[]>;
}

// Per-server annotations file
interface ToolAnnotationsFile {
  generatedAt: string;
  constitutionHash: string;
  servers: Record<string, {
    tools: ToolAnnotation[];
  }>;
}
```

**Argument role semantics:**

| Role | Meaning | Policy check |
|------|---------|-------------|
| `read-path` | Argument is a path that will be read | Checked against permitted directories |
| `write-path` | Argument is a path that will be written | Checked against permitted directories |
| `delete-path` | Argument is a path that will be deleted | Subject to delete policy |
| `none` | Not a resource path | No path-based policy check |

**Side effects:** `sideEffects` is framed in security terms, not just state mutation. A tool has `sideEffects: true` if it modifies state OR can disclose information from resource paths (information disclosure is a security-relevant side effect). Only tools with NO path arguments AND no state changes qualify as `sideEffects: false` -- e.g., `list_allowed_directories` which returns system configuration the agent already knows. Tools like `read_file` are `sideEffects: true` because they can disclose file contents from arbitrary paths. The compiled policy can allow `sideEffects: false` tools unconditionally (subject to structural invariants), while path-taking tools always go through path-based rules.

**Example annotations:**

```json
{
  "toolName": "move_file",
  "serverName": "filesystem",
  "effect": "move",
  "sideEffects": true,
  "args": {
    "source": ["read-path", "delete-path"],
    "destination": ["write-path"]
  }
}
```

The `source` of a move carries both `read-path` and `delete-path` roles. This means a compiled rule matching on `delete-path` will catch `move_file` -- the move tool cannot be used as a backdoor around delete policies.

```json
{
  "toolName": "list_allowed_directories",
  "serverName": "filesystem",
  "effect": "read",
  "sideEffects": false,
  "args": {}
}
```

No arguments, no side effects. The compiled policy can include a rule allowing side-effect-free tools without path constraints.

### 2. Tool Annotator (`src/pipeline/tool-annotator.ts`)

**Input:** MCP tool schemas (from `listTools()` for each configured server).

**Process:** Single LLM call per server. The prompt provides:
- The tool name, description, and input schema for every tool on that server.
- The `ToolAnnotation` output schema with role definitions.
- Instructions to classify each tool's effect, determine whether it has side effects (in security terms: state changes OR information disclosure from resource paths), and map argument names to roles. An argument may have multiple roles. Tools with path arguments should be marked `sideEffects: true` even if they only read.

**Output:** `ToolAnnotation[]` for the server.

**Compile-time validation:** After the LLM returns annotations, a heuristic check runs against each tool's schema. For every argument whose default value or schema examples suggest a filesystem path (strings starting with `/` or `.`), the validator checks that the annotation includes an appropriate path role. If the heuristic finds potential paths not covered by any role, the pipeline emits a warning and halts. This catches annotation errors at compile time rather than leaving gaps at runtime.

**Design notes:**
- Single-pass (no verifier for annotations). The constitution verifier downstream validates the overall pipeline.
- The annotator does not see the constitution. It classifies tools purely by their schemas and descriptions.
- Module exports a function with signature:

```typescript
async function annotateTools(
  serverName: string,
  tools: Tool[],               // MCP Tool type from listTools()
  llm: LanguageModel            // AI SDK model instance (injectable for testing)
): Promise<ToolAnnotation[]>
```

### 3. Constitution Compiler (`src/pipeline/constitution-compiler.ts`)

**Input:** Constitution text + tool annotations + system config (concrete directory paths for sandbox, documents, etc.).

**Process:** Single LLM call. The prompt provides:
- The full constitution text.
- All tool annotations (so the LLM knows what tools exist, what they do, and which have side effects).
- The `CompiledRule` schema (see below).
- The concrete directory paths referenced by the constitution (e.g., sandbox directory, documents directory). These are resolved from system configuration before being passed to the compiler.
- An explicit instruction that structural invariants (protected paths, audit log protection, unknown tool denial) are handled separately and must NOT be included in the compiled rules.
- Instructions to produce an ordered rule chain (first match wins) that faithfully implements the constitution's non-structural principles. Rules must reference concrete absolute paths, not abstract labels.

**Output:** `CompiledRule[]`

```typescript
interface PathCondition {
  roles: ArgumentRole[];           // which argument roles to check
  within: string;                  // concrete absolute directory path
  // True if ALL extracted paths resolve to within this directory.
  // Zero extracted paths = condition not satisfied (rule does not match).
}

interface CompiledRule {
  name: string;
  description: string;
  principle: string;               // which constitution principle this implements
  if: {
    effect?: string[];             // tool effects to match (read/write/delete/move/other)
    server?: string[];             // server names to match (omit = all)
    tool?: string[];               // specific tool names (omit = all matching effects)
    sideEffects?: boolean;         // match on side-effect annotation (omit = don't filter)
    paths?: PathCondition;         // if present, rule only fires when path condition is met
  };
  then: 'allow' | 'deny' | 'escalate';
  reason: string;
}

interface CompiledPolicyFile {
  generatedAt: string;
  constitutionHash: string;
  rules: CompiledRule[];
}
```

**Rule evaluation semantics:**

1. Rules are evaluated in order. First matching rule wins.
2. A rule **matches** if ALL conditions in the `if` block are true:
   - `effect` is absent OR the tool's annotated effect is in the list.
   - `server` is absent OR the request's server is in the list.
   - `tool` is absent OR the request's tool is in the list.
   - `sideEffects` is absent OR the tool's `sideEffects` annotation matches the value.
   - `paths` is absent OR the path condition evaluates to true (see below).
3. If no rule matches, default deny.

**Path condition evaluation:**

For each argument in the request whose annotated roles include any role in `paths.roles`, extract the path value. Then:

- **Zero paths extracted:** The condition is **not satisfied** -- the rule does not match. Tools with no path arguments need a separate rule without a `paths` condition (e.g., matching on `sideEffects: false`).
- **`within`:** True if **ALL** extracted paths resolve to within the specified directory. (Conservative: one path outside fails the whole check.)

Path resolution uses `node:path.resolve()` to neutralize traversal attacks.

The "outside a directory" semantics are handled by rule ordering: a rule with `within: "/some/dir"` matches the inside case; the next rule without a `paths` condition catches everything else as a fallthrough. This eliminates the need for an explicit `outside` operator.

**Example compiled policy for the current constitution:**

In this example, the sandbox is at `/tmp/ironcurtain-sandbox`. A richer constitution might also grant read access to `/home/user/Documents`.

```json
{
  "rules": [
    {
      "name": "allow-side-effect-free-tools",
      "description": "Pure query tools can always be called",
      "principle": "Least privilege",
      "if": { "sideEffects": false },
      "then": "allow",
      "reason": "Tool has no side effects"
    },
    {
      "name": "deny-delete-operations",
      "description": "Block all tools that delete data",
      "principle": "No destruction",
      "if": { "effect": ["delete"] },
      "then": "deny",
      "reason": "Delete operations are never permitted"
    },
    {
      "name": "allow-move-within-sandbox",
      "description": "Allow moves where all paths (source and destination) are in sandbox",
      "principle": "Containment",
      "if": {
        "effect": ["move"],
        "paths": { "roles": ["read-path", "write-path", "delete-path"], "within": "/tmp/ironcurtain-sandbox" }
      },
      "then": "allow",
      "reason": "Move within sandbox directory"
    },
    {
      "name": "deny-move-elsewhere",
      "description": "Moves involving paths outside sandbox are denied (source deletion = destruction)",
      "principle": "No destruction",
      "if": { "effect": ["move"] },
      "then": "deny",
      "reason": "Move outside sandbox would delete source file outside controlled directory"
    },
    {
      "name": "allow-read-in-sandbox",
      "description": "Allow reading files within the sandbox directory",
      "principle": "Containment",
      "if": {
        "effect": ["read"],
        "paths": { "roles": ["read-path"], "within": "/tmp/ironcurtain-sandbox" }
      },
      "then": "allow",
      "reason": "Read within sandbox directory"
    },
    {
      "name": "deny-read-elsewhere",
      "description": "Deny reading files outside permitted directories",
      "principle": "Containment",
      "if": { "effect": ["read"] },
      "then": "deny",
      "reason": "Read outside permitted directories"
    },
    {
      "name": "allow-write-in-sandbox",
      "description": "Allow writes where all paths are within sandbox",
      "principle": "Containment",
      "if": {
        "effect": ["write"],
        "paths": { "roles": ["write-path"], "within": "/tmp/ironcurtain-sandbox" }
      },
      "then": "allow",
      "reason": "Write within sandbox directory"
    },
    {
      "name": "escalate-write-elsewhere",
      "description": "Writes outside sandbox need human approval",
      "principle": "Human oversight",
      "if": { "effect": ["write"] },
      "then": "escalate",
      "reason": "Write outside sandbox requires human approval"
    }
  ]
}
```

Note how move is handled with two rules: the first allows moves only when ALL paths (source with `read-path` + `delete-path` roles, destination with `write-path`) are within the sandbox. Any move involving an external path falls through to `deny-move-elsewhere`, which denies because moving implies deleting the source -- a destructive operation outside the controlled directory. This works because `source` is annotated with `["read-path", "delete-path"]`.

A richer constitution allowing read access to a documents folder would add a rule before `deny-read-elsewhere`:

```json
{
  "name": "allow-read-documents",
  "description": "Allow reading files in the user's documents folder",
  "principle": "Containment",
  "if": {
    "effect": ["read"],
    "paths": { "roles": ["read-path"], "within": "/home/user/Documents" }
  },
  "then": "allow",
  "reason": "Read access to documents folder"
}
```

### 4. Test Scenario Generator (`src/pipeline/scenario-generator.ts`)

**Input:** Constitution text + tool annotations + mandatory handwritten scenarios.

**Process:** Single LLM call. The prompt instructs the LLM to:
- Read the constitution's principles.
- Generate test scenarios: concrete tool call examples with expected policy decisions.
- Cover positive cases (should be allowed), negative cases (should be denied), and edge cases (boundary conditions, path traversal attempts).
- Include scenarios for side-effect-free tools.
- Include scenarios for multi-role arguments (e.g., `move_file` with all permutations: sandbox-to-sandbox, sandbox-to-external, external-to-sandbox, external-to-external).

**Output:** `TestScenario[]`

```typescript
interface TestScenario {
  description: string;
  request: {
    serverName: string;
    toolName: string;
    arguments: Record<string, unknown>;
  };
  expectedDecision: 'allow' | 'deny' | 'escalate';
  reasoning: string;              // why this decision follows from the constitution
  source: 'generated' | 'handwritten';
}

interface TestScenariosFile {
  generatedAt: string;
  constitutionHash: string;
  scenarios: TestScenario[];
}
```

**Mandatory handwritten scenarios:** The pipeline includes a set of handwritten test scenarios derived from the existing `policy-engine.test.ts` test cases. These are hardcoded in the scenario generator module and always included in the output alongside LLM-generated scenarios. They provide human-authored ground truth that the verifier checks against, mitigating the circular reasoning risk where the compiler and scenario generator share the same blind spots.

The handwritten scenarios cover:
- Read inside sandbox, allow
- Read outside sandbox, deny
- Write inside sandbox, allow
- Write outside sandbox, escalate
- Delete, deny
- Path traversal attempts, deny
- Protected path access, deny (structural invariant)
- Move sandbox-to-sandbox, allow
- Move sandbox-to-external, escalate
- Move external-to-sandbox, deny (source deletion outside sandbox)
- Side-effect-free tool, allow
- Unknown tool, deny

### 5. Policy Verifier (`src/pipeline/policy-verifier.ts`)

The verifier is a **multi-round loop** that executes test scenarios against the real PolicyEngine and uses an LLM judge to analyze results and probe for gaps.

**Round 1 -- Execute and judge:**

1. Instantiate a real `PolicyEngine` with the compiled policy, tool annotations, and structural invariant config.
2. Run every test scenario (handwritten + LLM-generated) through the engine.
3. Collect execution results: for each scenario, the actual decision, matching rule, and whether it matches the expected decision.
4. Send to Verifier LLM: the constitution, the compiled rules, the tool annotations, and the full execution results table. The LLM is asked to:
   a. Analyze any discrepancies (expected != actual). Is the rule wrong, or is the expectation wrong?
   b. Identify suspicious patterns (e.g., a broad allow rule shadowing a narrow deny).
   c. Identify missing coverage -- scenarios the constitution implies that weren't tested.
   d. If gaps are suspected, output **additional test scenarios** to probe them.

**Round 2+ -- Probe gaps (if the verifier generated new scenarios):**

5. Run the new scenarios through the real PolicyEngine.
6. Send results back to the Verifier LLM alongside previous context.
7. Verifier makes updated judgment, potentially generating more scenarios.

**Exit condition:** The verifier reports pass/fail, or the maximum round count is reached (cap at 3 rounds for the tracer bullet to bound LLM cost).

```typescript
interface ExecutionResult {
  scenario: TestScenario;
  actualDecision: 'allow' | 'deny' | 'escalate';
  matchingRule: string;            // which rule fired (structural or compiled)
  pass: boolean;                   // actualDecision === expectedDecision
}

interface VerifierRound {
  round: number;
  executionResults: ExecutionResult[];
  llmAnalysis: string;
  newScenarios: TestScenario[];    // additional scenarios to probe (empty if none)
}

interface VerificationResult {
  pass: boolean;
  rounds: VerifierRound[];
  summary: string;
  failedScenarios: ExecutionResult[];
}
```

**Why execute the real engine:** An LLM simulating first-match-wins evaluation over ordered rules is unreliable. By running the actual PolicyEngine, we get ground truth about what the compiled policy does. The LLM judge then focuses on what it's good at: reasoning about whether those outcomes are correct according to the constitution's intent.

**Design notes:**
- The verifier is told about structural invariants so it understands the complete policy stack.
- If verification fails, the command prints diagnostics and exits with a non-zero code.
- The multi-round loop lets the verifier probe edges it's suspicious about, similar to an engineer running tests, reading failures, and writing more targeted tests.
- Future enhancement: feed failures back to the compiler for a re-compilation attempt. Not in tracer bullet scope.

### 6. Declarative PolicyEngine (refactored `src/trusted-process/policy-engine.ts`)

The refactored engine evaluates in two phases: hardcoded structural invariants first, then compiled rules.

```typescript
class PolicyEngine {
  constructor(
    compiledPolicy: CompiledPolicyFile,
    toolAnnotations: ToolAnnotationsFile,
    protectedPaths: string[]       // from system config, not compiled
  )

  evaluate(request: ToolCallRequest): EvaluationResult
}
```

**Evaluation algorithm:**

**Phase 1 -- Structural invariants (hardcoded, never LLM-generated):**

1. Extract ALL paths from request arguments using both role-based extraction (from annotations) and the conservative heuristic (any string value starting with `/` or `.`). Take the union.
2. Resolve all extracted paths to absolute form via `path.resolve()`.
3. Check each resolved path against `protectedPaths`. If any path is a protected path or is within a protected directory, return `{ decision: 'deny', rule: 'structural-protected-path', reason: '...' }`.
4. If the tool has no annotation (unknown tool), return `{ decision: 'deny', rule: 'structural-unknown-tool', reason: '...' }`.

**Phase 2 -- Compiled rules:**

5. Look up `ToolAnnotation` for `request.serverName + request.toolName`.
6. For each rule in `compiledPolicy.rules` (in order):
   a. Check `if.effect` -- does the tool's effect match?
   b. Check `if.server` -- does the server match?
   c. Check `if.tool` -- does the tool name match?
   d. Check `if.sideEffects` -- does the tool's side-effect annotation match?
   e. If `if.paths` present:
      - Extract paths from `request.arguments` where any of the argument's annotated roles appears in `paths.roles`.
      - If zero paths extracted, condition not satisfied, rule does not match.
      - Resolve all extracted paths via `path.resolve()`.
      - Evaluate: true if ALL resolved paths are within `paths.within` directory.
   f. If all conditions met, return this rule's decision.
7. No rule matched, return `{ decision: 'deny', rule: 'default-deny', reason: 'No matching policy rule' }`.

### 7. Structural Invariants -- Hardcoded, Never Compiled

The architecture document states that structural invariants are "hardcoded, never overridden." They form the trust foundation that makes all other policy compilation trustworthy.

**What structural invariants enforce:**

- The agent cannot read, write, or delete protected paths (constitution, compiled policy artifacts, audit log, server configuration).
- Unknown tools (no annotation) are denied.

**Protected paths** are concrete filesystem paths (not substring patterns) configured at system level:

```typescript
interface StructuralConfig {
  protectedPaths: string[];       // absolute paths or directories
}
```

For the current system, protected paths include:
- The constitution file (e.g., `src/config/constitution.md`)
- The generated policy directory (e.g., `src/config/generated/`) -- directory: everything within is protected
- The MCP server configuration (e.g., `src/config/mcp-servers.json`)
- The audit log file path (from `AUDIT_LOG_PATH` config)

**Why paths, not patterns:** The previous `PROTECTED_PATTERNS` used substring matching (`p.includes('constitution.md')`), which is both over-broad (blocks a sandbox file named `my-constitution.md-notes`) and under-specific (doesn't protect by location, only by name). Protected paths use exact path comparison and directory containment via `path.resolve()`, the same mechanism used for sandbox directory checks. A path is protected if it equals a protected path or is contained within a protected directory.

**Where protected paths come from:** They are derived from system configuration at `PolicyEngine` construction time -- the config already knows the constitution path, the generated directory path, the MCP servers config path, and the audit log path. These are not compiled by the LLM and are not stored in `compiled-policy.json`.

**Interaction with compiled rules:** The structural invariant check runs first. If a request touches a protected path, it is denied before any compiled rule is evaluated. The compiler prompt explicitly instructs the LLM to NOT generate rules for protected path checking, as the hardcoded layer handles it.

**Security property:** Even if `compiled-policy.json` is corrupted or adversarially crafted, the structural invariants still protect the system's core files. The compiled rules can only make policy decisions about non-protected resources.

### 8. CLI Command (`src/pipeline/compile.ts`)

Entry point for `ironcurtain compile-policy`. Orchestrates the full pipeline:

```
1.  Load config (mcp-servers.json, constitution.md, directory paths, protected paths)
2.  Connect to each MCP server, list tools
3.  For each server: annotateTools() -> ToolAnnotation[]
4.  Validate annotations against heuristic (flag potential paths not annotated with roles)
5.  compileConstitution(constitution, annotations, config) -> CompiledRule[]
6.  Load mandatory handwritten scenarios
7.  generateScenarios(constitution, annotations, handwrittenScenarios) -> TestScenario[]
8.  verifyPolicy(constitution, rules, annotations, structuralConfig, scenarios) -> VerificationResult
    - Instantiate real PolicyEngine
    - Execute scenarios, collect results
    - LLM judge analyzes results (up to 3 rounds)
9.  If verification passes:
    - Write src/config/generated/tool-annotations.json
    - Write src/config/generated/compiled-policy.json
    - Write src/config/generated/test-scenarios.json
    - Print success summary
10. If verification fails:
    - Print diagnostics (which scenarios failed, why, LLM analysis)
    - Exit with code 1
    - Do NOT write/overwrite config files
11. Disconnect MCP servers, clean up
```

**Development vs published usage:**
```bash
# During development
npm run compile-policy

# When published as a package
npx ironcurtain compile-policy
```

**Security invariant:** The `src/config/generated/` directory must NOT overlap with any directory permitted by the compiled policy (e.g., the sandbox directory). This is validated at startup. The sandbox defaults to `/tmp/ironcurtain-sandbox`; the generated config lives in the source tree. This is also enforced by the structural invariants (protected paths).

## File Layout

```
src/pipeline/
  compile.ts                  # CLI entry point
  tool-annotator.ts           # Step 2: LLM annotates tools
  constitution-compiler.ts    # Step 3: LLM compiles rules
  scenario-generator.ts       # Step 4: LLM generates test scenarios
  policy-verifier.ts          # Step 5: real engine execution + LLM judge
  types.ts                    # Shared types (ToolAnnotation, CompiledRule, etc.)
  handwritten-scenarios.ts    # Mandatory test scenarios from existing tests

src/config/
  constitution.md             # (existing) English-language principles
  mcp-servers.json            # (existing) MCP server definitions
  generated/                  # Output of compile-policy command
    tool-annotations.json
    compiled-policy.json
    test-scenarios.json

src/trusted-process/
  policy-engine.ts            # Refactored: structural invariants + compiled rules
  policy-types.ts             # Updated: declarative rule types
```

## Testing Strategy

Each pipeline component is independently testable:

- **Tool Annotator tests:** Provide mock tool schemas, mock LLM returning canned responses, verify annotations have correct effects, side-effect flags, and argument roles (including multi-role args like move source). Test the compile-time heuristic validator catches unannotated path arguments.
- **Constitution Compiler tests:** Provide constitution + annotations, mock LLM, verify compiled rules cover expected cases. Assert that structural invariant rules are NOT present in output. Verify the `principle` field links back to the constitution.
- **Scenario Generator tests:** Provide constitution + annotations + handwritten scenarios, mock LLM, verify output includes both generated and handwritten scenarios with valid structure.
- **Policy Verifier tests:** Provide known-good and known-bad rule sets. For known-bad rules (e.g., missing delete denial), verify that executing scenarios against the real engine produces failures and the verifier reports them.
- **PolicyEngine tests -- structural invariants:** Directly test that protected paths are denied regardless of compiled rules. Test with an empty compiled rule set to confirm invariants work standalone.
- **PolicyEngine tests -- compiled rules:** Load compiled artifacts, run existing test cases. Test zero-path-extraction behavior (side-effect-free tools). Test unknown tools (no annotation, deny). Test path traversal attacks.
- **PolicyEngine tests -- move matrix:** Test all four permutations (sandbox-to-sandbox allow, sandbox-to-external escalate, external-to-sandbox deny via delete-path, external-to-external deny/escalate) to verify correct decisions.

**Integration test:** Run the full pipeline against the filesystem MCP server with a real LLM and verify the compiled policy produces identical decisions to the current hardcoded policy for all existing test cases in `policy-engine.test.ts`.

## Tracer Bullet Scope

**In scope:**
- All five pipeline stages (annotator, compiler, scenario generator, verifier with real engine execution, CLI command).
- Structural invariants with protected paths (replacing PROTECTED_PATTERNS).
- Declarative PolicyEngine with if/then rules replacing hardcoded rules.
- Side-effect annotations on tools.
- Multi-role argument annotations (move source = read-path + delete-path).
- Mandatory handwritten scenarios.
- Multi-round verifier (capped at 3 rounds).
- Compile-time heuristic validation of annotations.
- Filesystem MCP server only.
- Existing tests adapted to pass with compiled policy.

**Deferred:**
- Non-filesystem MCPs (Gmail, Slack, Calendar) -- the design supports them, but tracer bullet only exercises filesystem.
- Per-task policy layer -- future enhancement on top of compiled constitution policy.
- LLM assessment rules (semantic checks like PII detection) -- all rules are deterministic for now.
- Retry loop feeding verifier failures back to the compiler for re-compilation.
- Caching / incremental recompilation -- full recompile each time the command is run.
- Runtime constitution hash verification -- generated files record the hash; runtime check is deferred.

## Resolved Design Decisions

1. **Heuristic fallback:** Compile-time validation only (not runtime). The annotator's output is checked against the heuristic during `compile-policy`. The structural invariants use both heuristic and role-based extraction as defense-in-depth for protected path checks. Compiled rules trust annotations.

2. **Move semantics:** The `source` argument of `move_file` carries `["read-path", "delete-path"]` roles. This prevents the move tool from being used as a backdoor around delete policies. The compiled rules can match on `delete-path` to catch moves that implicitly delete.

3. **Side-effect-free tools:** `sideEffects` is framed as security-relevant side effects, not just state mutation. Tools that take path arguments are `sideEffects: true` even if they only read (information disclosure is a side effect). Only argument-less query tools like `list_allowed_directories` get `sideEffects: false`. The LLM compiler generates an explicit allow rule for them (e.g., `"if": { "sideEffects": false }, "then": "allow"`). This is a compiled rule, not a structural invariant, because which tools are side-effect-free is determined by the annotator LLM and may vary by MCP server.

4. **Verifier executes real engine:** The verifier instantiates the actual PolicyEngine and runs scenarios through it. The LLM judge analyzes execution results rather than simulating rule evaluation. Multi-round: the LLM can generate additional probe scenarios, capped at 3 rounds.

5. **Policy format:** Predicate rules with `if`/`then` structure. Links each rule to a constitution `principle`. Easier to read than match/pathConstraint while maintaining the same expressiveness.

6. **Protected paths, not patterns:** Structural invariants use concrete filesystem paths and directory containment, not substring matching. Derived from system configuration at construction time.

7. **Concrete paths in compiled rules:** `PathCondition` uses `within: "/absolute/path"` with concrete directory paths, not abstract labels like `sandbox` or `external`. The compiler resolves directory names from the constitution (e.g., "sandbox directory," "documents folder") to concrete paths using system configuration. This means compiled policies are environment-specific; changing paths requires recompilation. The `CompiledPolicyFile` has no `allowedDirectory` field -- each rule carries its own path. "Outside" semantics are handled by rule ordering: the `within` rule matches the inside case, and the fallthrough rule catches everything else.

## Open Considerations

### Adversarial tool descriptions

An MCP tool could have a description designed to mislead the annotation LLM. Example: a tool that deletes files but describes itself as "safely archives data for later retrieval."

For the tracer bullet, not a concern -- we control the filesystem MCP server. Future mitigations:
- Human review of annotations before acceptance.
- Annotation verifier that cross-checks descriptions against observed behavior.
- Treating new MCP server onboarding as a security boundary requiring explicit human approval.

### Determinism and reproducibility

LLM outputs are non-deterministic. Two runs of `compile-policy` with the same inputs may produce different rules. The verifier with real engine execution provides a strong safety net, and the persistent files mean we only accept a compilation that passes verification.

Future improvements: temperature=0, seed parameters, structured output constraints. Could also cache and only recompile when inputs change (constitution hash + tool schema hash).
