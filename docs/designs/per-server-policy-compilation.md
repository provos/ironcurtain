# Per-Server Policy Compilation

## Motivation

The current policy compilation pipeline compiles a single `constitution.md` into one `compiled-policy.json` containing rules for all MCP servers in a single LLM call. This creates several scaling problems:

1. **LLM context window pressure.** As servers are added, the tool annotations summary grows. With 4 servers and 85 tools, the system prompt is already substantial. Adding servers with tens or hundreds of tools will push against context limits and degrade output quality.

2. **No incremental recompilation.** Changing one server's tools (e.g., adding a tool to the fetch server) invalidates the entire `inputHash` and forces recompilation of rules for all servers. This wastes LLM calls and time.

3. **Monolithic repair loops.** When verification fails, the repair loop operates on the full rule set. The LLM must reason about all 23+ rules across all servers simultaneously, increasing the chance of regressions in unrelated servers' rules during repair.

4. **Scenario quality.** The scenario generator must cover all servers in one pass. With many servers, coverage becomes thin per server.

The tool annotator (`annotate.ts`) already solves the analogous problem: it processes each server independently with per-server content-hash caching. This design extends the same pattern to policy compilation.

### Behavioral Change: From Cross-Cutting Rules to Server-Scoped Rules

This is a **deliberate behavioral change**, not a transparent refactoring. The current monolithic compiler produces cross-cutting rules — for example, a single rule `escalate-write-history-outside-sandbox` with `"roles": ["write-history"]` that matches any server's tool with that role. Under per-server compilation, each server independently produces its own server-scoped version of such rules.

**Example — current monolithic output:**
```json
{
  "name": "escalate-write-history-outside-sandbox",
  "if": { "roles": ["write-history"] },
  "then": "escalate"
}
```

**Equivalent per-server output (one rule per server that has write-history tools):**
```json
// From git server compilation:
{
  "name": "escalate-git-write-history",
  "if": { "server": ["git"], "roles": ["write-history"] },
  "then": "escalate"
}
// From github server compilation:
{
  "name": "escalate-github-write-history",
  "if": { "server": ["github"], "roles": ["write-history"] },
  "then": "escalate"
}
```

Each server's compiler independently applies the same constitutional principle to its own tools. The per-server rules are more explicit (always server-scoped) but may use different condition patterns for the same principle — e.g., the filesystem compiler might use `roles`-based conditions while the GitHub compiler uses `tool`-based conditions. This is acceptable: what matters is that each server's rules correctly implement the constitution for that server's tools.

### Incremental Recompilation: Scope and Limitations

The primary incremental benefit comes from **tool annotation changes**: when one server's tools change, only that server recompiles. However, the constitution text is included in every server's cache key, so **constitution changes invalidate all server caches**. Since the constitution is not structured per-server (it uses cross-cutting principles), there is no clean way to scope constitution changes to individual servers. This is an acceptable tradeoff — constitution changes are infrequent compared to tool changes, and the per-server compilation is still faster than monolithic because each LLM call processes fewer tools.

## High-Level Approach

Split the pipeline into three phases:

```
Phase 1: Per-server compilation (parallelizable)
  For each server S with tools:
    - Build system prompt with constitution + S's annotations only
    - Compile rules (LLM call, cached per server)
    - Generate scenarios for S (LLM call, cached)
    - Verify S's rules against S's scenarios (compile-verify-repair loop)
    - Write per-server artifacts to generated/servers/{S}/

Phase 2: Merge
  - Concatenate all per-server rule sets into one ordered list
  - Merge list definitions from all servers
  - Write final compiled-policy.json (same format as today)

Phase 3: Global post-processing (unchanged)
  - Resolve dynamic lists (global, post-merge)
  - Final cross-server verification (optional, lightweight)
```

The PolicyEngine consumes the merged `compiled-policy.json` unchanged. No runtime changes needed.

## Detailed Design

### Per-Server Compilation Unit

Each server's compilation is a self-contained unit with its own compile-verify-repair cycle. Introduce a type to represent the inputs and outputs of a single server's compilation:

```typescript
/**
 * Inputs for compiling a single server's policy rules.
 */
interface ServerCompilationUnit {
  /** The server name (e.g., "filesystem", "git", "github"). */
  readonly serverName: string;

  /** Tool annotations for this server only. */
  readonly annotations: ToolAnnotation[];

  /** Full constitution text (shared across all servers). */
  readonly constitutionText: string;

  /** Sandbox boundary for structural invariant checks. */
  readonly allowedDirectory: string;

  /** Protected paths for structural invariant injection. */
  readonly protectedPaths: string[];

  /** MCP server config for this server (for domain allowlist extraction). */
  readonly mcpServerConfig?: MCPServerConfig;

  /**
   * Handwritten scenarios scoped to this server.
   * Currently only filesystem has handwritten scenarios; other servers get [].
   */
  readonly handwrittenScenarios: TestScenario[];
}

/**
 * Output from a single server's compilation cycle.
 * Stored as a per-server artifact for caching.
 */
interface ServerCompilationResult {
  readonly serverName: string;
  readonly rules: CompiledRule[];
  readonly listDefinitions: ListDefinition[];
  readonly scenarios: TestScenario[];
  readonly inputHash: string;
  readonly constitutionHash: string;
  readonly generatedAt: string;
}
```

### Per-Server Artifact Layout

Per-server artifacts are stored in subdirectories under the generated directory:

```
~/.ironcurtain/generated/
  servers/
    filesystem/
      compiled-policy.json    # ServerCompilationResult (per-server rules)
      test-scenarios.json     # Per-server test scenarios
    git/
      compiled-policy.json
      test-scenarios.json
    fetch/
      compiled-policy.json
      test-scenarios.json
    github/
      compiled-policy.json
      test-scenarios.json
  compiled-policy.json        # Merged final artifact (unchanged format)
  tool-annotations.json       # Unchanged (already per-server internally)
  dynamic-lists.json          # Unchanged (global, post-merge)
  test-scenarios.json         # Merged scenarios from all servers
```

The per-server `compiled-policy.json` uses a new `ServerCompiledPolicyFile` type that is a subset of the existing `CompiledPolicyFile`:

```typescript
/**
 * Per-server compiled policy artifact.
 * Written to generated/servers/{serverName}/compiled-policy.json.
 */
interface ServerCompiledPolicyFile {
  readonly generatedAt: string;
  readonly serverName: string;
  readonly constitutionHash: string;
  readonly inputHash: string;
  readonly rules: CompiledRule[];
  readonly listDefinitions?: ListDefinition[];
}
```

The merged `compiled-policy.json` retains the existing `CompiledPolicyFile` type exactly. No change to the runtime contract.

### Per-Server Content-Hash Caching

Each server's `inputHash` is computed from:

```typescript
function computeServerPolicyHash(
  serverName: string,
  constitutionText: string,
  annotations: ToolAnnotation[],
  compilerPromptTemplate: string,  // the prompt template text (not filled)
): string {
  return computeHash(
    serverName,
    constitutionText,
    JSON.stringify(annotations),
    compilerPromptTemplate,
  );
}
```

This means a server's cached rules are invalidated when:
- The constitution changes (affects all servers)
- The server's tool annotations change (affects only that server)
- The compiler prompt template changes (affects all servers, but rare)

When only the `git` server's annotations change, only `git` is recompiled. The other three servers hit cache and skip LLM calls entirely.

### Schema Enforcement: Server Scoping as a Zod Invariant

The primary enforcement mechanism for server scoping is the **Zod response schema**. Since the compiler only receives one server's tool annotations and the schema only permits that server's name, invalid output is rejected at parse time before it ever enters the system. No post-hoc filtering or validation is needed for correctness — the schema makes it structurally impossible to produce cross-server rules.

**1. Schema restriction (primary enforcement).** The `buildCompilerResponseSchema()` already accepts `serverNames` and `toolNames` as parameters. For per-server compilation, pass single-server values:

   ```typescript
   const serverNames = [serverName] as [string, ...string[]];
   const toolNames = [...new Set(serverAnnotations.map(a => a.toolName))] as [string, ...string[]];
   const schema = buildCompilerResponseSchema(serverNames, toolNames);
   ```

   The Zod `z.enum(serverNames)` restricts the `server` field to exactly `[serverName]`. The `z.enum(toolNames)` restricts `tool` to only that server's tools. Any LLM output referencing other servers or tools fails schema validation and triggers the existing schema repair flow.

**2. Make `server` required in per-server mode.** Currently `server` is optional in the schema (`.optional()`). For per-server compilation, make it required so the LLM cannot omit it:

   ```typescript
   function buildCompilerResponseSchema(
     serverNames: [string, ...string[]],
     toolNames: [string, ...string[]],
     options?: { requireServer?: boolean },
   ) {
     const serverField = z.array(z.enum(serverNames));
     const conditionSchema = z.object({
       // ...
       server: options?.requireServer
         ? serverField        // required — schema rejects rules without server
         : serverField.optional(),
       // ...
     });
   }
   ```

   Per-server compilation passes `{ requireServer: true }`. Monolithic and task-policy compilation continue with `requireServer: false` (backward compatible). This ensures the LLM cannot produce rules without a `server` condition.

**3. Prompt reinforcement (belt-and-suspenders).** Add a directive to the system prompt. This guides the LLM to produce valid output on the first attempt, reducing schema repair round-trips:

   ```
   ## Server Scope

   You are compiling rules for the "{serverName}" server ONLY.
   Every rule you emit MUST include "server": ["{serverName}"] in the "if" condition.
   Only the following tools are available: {toolNames}.
   Do NOT emit rules for other servers or tools.
   ```

**4. Tool annotations scoping (input restriction).** The compiler receives only the target server's annotations. The `buildCompilerSystemPrompt()` formats only those annotations in the "Tool Annotations" section. The LLM never sees other servers' tools, making cross-server references unlikely even before schema validation.

The combination of input restriction (only one server's annotations), schema enforcement (Zod rejects invalid output), and prompt guidance (reduces repair round-trips) provides defense in depth. The `validateServerScoping()` function described later is a **debug assertion**, not a correctness requirement — if the schema is correct, it cannot fail.

### Per-Server Verification: Full Scoping Requirements

Per-server verification must scope **all** components to the single server being compiled. This is more than just passing fewer annotations — every verification subsystem needs scoping:

1. **PolicyEngine construction.** Create a per-server `PolicyEngine` with:
   - A `CompiledPolicyFile` containing only that server's rules
   - A `ToolAnnotationsFile` containing only that server's annotations (wrap in the `servers` record structure)
   - The same `protectedPaths` and `allowedDirectory` (structural invariants are global)
   - Per-server dynamic lists (only lists referenced by this server's rules, if any)

2. **PolicyVerifierSession scoping.** The `PolicyVerifierSession` constructor accepts `serverNames` and `toolNames` arrays that restrict the Zod schema for probe scenario generation. For per-server verification:
   ```typescript
   const verifierSession = new PolicyVerifierSession({
     system: verifierSystem,
     model: this.model,
     serverNames: [serverName] as [string, ...string[]],
     toolNames: serverToolNames,  // only this server's tools
   });
   ```
   This prevents the verifier from generating probe scenarios for other servers.

3. **Judge system prompt scoping.** The `buildJudgeSystemPrompt()` accepts `allAvailableTools` and the compiled policy. For per-server verification, pass only that server's tools and rules:
   ```typescript
   const judgeSystem = buildJudgeSystemPrompt(
     constitutionText,
     serverPolicyFile,         // only this server's rules
     protectedPaths,
     serverTools,              // only this server's tools
     serverDynamicLists,       // only lists referenced by this server
     allowedDirectory,
   );
   ```

4. **Structural conflict filtering.** The `filterStructuralConflicts()` function creates a `PolicyEngine` internally. It must use the per-server engine (same tool annotations and rules), not a merged one.

5. **Scenario generation scoping.** The `ScenarioGeneratorSession` receives annotations and generates scenarios only for tools it can see. For per-server compilation this is naturally scoped since we pass only that server's annotations.

**Cost implication:** Each server runs its own independent repair loop (up to 2 repair attempts per server). With N servers, the worst case is N × 2 repair cycles. For 4 servers, that's potentially 8 repair LLM calls instead of the current 2. In practice, most servers' rules are simpler in isolation and less likely to need repair.

### Handwritten Scenario Routing

The current `getHandwrittenScenarios()` returns scenarios only for the `filesystem` server (sandbox containment invariants). For per-server compilation, filter by server name to keep the approach general as new handwritten scenarios may be added for other servers in the future:

```typescript
function getHandwrittenScenariosForServer(
  serverName: string,
  sandboxDir: string,
): TestScenario[] {
  return getHandwrittenScenarios(sandboxDir)
    .filter(s => s.request.serverName === serverName);
}
```

This is safe because handwritten scenarios are already tagged with `serverName` in their `request` field. No new scenarios need to be created.

### Merge Phase

After all per-server compilations complete, merge results into the final `compiled-policy.json`:

```typescript
function mergeServerResults(
  results: ServerCompilationResult[],
  constitutionHash: string,
): CompiledPolicyFile {
  // Concatenate rules in a deterministic order (alphabetical by server name)
  const sortedResults = [...results].sort(
    (a, b) => a.serverName.localeCompare(b.serverName)
  );

  const allRules: CompiledRule[] = sortedResults.flatMap(r => r.rules);
  const allListDefs: ListDefinition[] = sortedResults.flatMap(r => r.listDefinitions);

  // Deduplicate list definitions by name (same list may be referenced by multiple servers)
  const uniqueListDefs = deduplicateListDefinitions(allListDefs);

  // Compute a merged inputHash from all per-server hashes
  const mergedInputHash = computeHash(
    ...sortedResults.map(r => r.inputHash)
  );

  return {
    generatedAt: new Date().toISOString(),
    constitutionHash,
    inputHash: mergedInputHash,
    rules: allRules,
    listDefinitions: uniqueListDefs.length > 0 ? uniqueListDefs : undefined,
  };
}
```

**Rule ordering within the merged file.** Since every rule has a `server` condition, rules from different servers never interfere with each other. A tool call for server X will never match a rule scoped to server Y. Therefore, the relative ordering of server blocks is irrelevant to correctness. We use alphabetical server order for determinism.

**Rule ordering within a server.** Each server's rules retain their LLM-generated order (first-match-wins within a server). This is preserved by `flatMap` on the sorted results.

**No cross-server conflict by construction.** The key insight: since compiled rules only use `allow` and `escalate` (never `deny`), and each rule is scoped to exactly one server via `server: [serverName]`, rules from different servers cannot conflict. A tool call is evaluated against the full rule chain, but only rules matching the call's server name can fire. Default-deny handles the rest.

### List Definition Deduplication

Multiple servers could independently reference the same constitutional category (e.g., "major news sites"). The merge phase deduplicates by list name. Since list definitions are produced by independent LLM calls, two servers may produce textually different `generationPrompt` values for the same named list (e.g., "List 50 popular news site domains" vs. "List major international news websites"). The deduplication uses first-wins (alphabetical server order) but **logs a warning** when definitions diverge, so the user knows that compilation order affected the outcome:

```typescript
function deduplicateListDefinitions(defs: ListDefinition[]): ListDefinition[] {
  const seen = new Map<string, ListDefinition>();
  for (const def of defs) {
    const existing = seen.get(def.name);
    if (!existing) {
      seen.set(def.name, def);
    } else if (existing.generationPrompt !== def.generationPrompt) {
      console.error(
        `  Warning: list "${def.name}" has divergent generation prompts ` +
        `across servers. Using first definition (from ${existing.type} context).`
      );
    }
  }
  return [...seen.values()];
}
```

### PipelineRunner Changes

The `PipelineRunner.run()` method is restructured into three internal methods:

```typescript
class PipelineRunner {
  /**
   * Runs the full pipeline. New orchestration: per-server then merge.
   */
  async run(config: PipelineRunConfig): Promise<CompiledPolicyFile> {
    const toolAnnotationsFile = /* load as before */;
    const constitutionHash = computeHash(config.constitutionInput);

    // Phase 1: Per-server compilation
    const serverResults = await this.compileAllServers(config, toolAnnotationsFile, constitutionHash);

    // Phase 2: Merge
    const mergedPolicy = mergeServerResults(serverResults, constitutionHash);
    writeArtifact(config.outputDir, 'compiled-policy.json', mergedPolicy);

    // Merge scenarios for the global artifact
    const allScenarios = serverResults.flatMap(r => r.scenarios);
    writeArtifact(config.outputDir, 'test-scenarios.json', {
      generatedAt: new Date().toISOString(),
      constitutionHash,
      inputHash: mergedPolicy.inputHash,
      scenarios: allScenarios,
    });

    // Phase 3: Dynamic list resolution (unchanged)
    const dynamicLists = await this.resolveDynamicLists(mergedPolicy, config);

    // Optional: cross-server verification sanity check
    // (lightweight, uses merged policy + all scenarios)

    return mergedPolicy;
  }

  /**
   * Compiles rules for all servers. Currently sequential; can be
   * parallelized in a future PR.
   */
  private async compileAllServers(
    config: PipelineRunConfig,
    toolAnnotationsFile: ToolAnnotationsFile,
    constitutionHash: string,
  ): Promise<ServerCompilationResult[]> {
    const results: ServerCompilationResult[] = [];

    for (const [serverName, serverData] of Object.entries(toolAnnotationsFile.servers)) {
      const result = await this.compileServer({
        serverName,
        annotations: serverData.tools,
        constitutionText: config.constitutionInput,
        allowedDirectory: config.allowedDirectory,
        protectedPaths: config.protectedPaths,
        mcpServerConfig: config.mcpServers?.[serverName],
        handwrittenScenarios: getHandwrittenScenariosForServer(
          serverName, config.allowedDirectory
        ),
      }, config.outputDir, constitutionHash);
      results.push(result);
    }

    return results;
  }

  /**
   * Compiles a single server: compile -> generate scenarios -> verify -> repair.
   * Self-contained compile-verify-repair loop per server.
   */
  private async compileServer(
    unit: ServerCompilationUnit,
    outputDir: string,
    constitutionHash: string,
  ): Promise<ServerCompilationResult> {
    const serverOutputDir = resolve(outputDir, 'servers', unit.serverName);

    // Check per-server cache
    const existing = loadExistingArtifact<ServerCompiledPolicyFile>(
      serverOutputDir, 'compiled-policy.json'
    );
    const inputHash = computeServerPolicyHash(/* ... */);

    if (existing && existing.inputHash === inputHash) {
      // Cache hit: skip LLM calls entirely
      return { /* from existing */ };
    }

    // Build per-server system prompt (only this server's annotations)
    const compilerPrompt = buildCompilerSystemPrompt(
      unit.constitutionText,
      unit.annotations,  // <-- only this server's annotations
      { protectedPaths: unit.protectedPaths },
      unit.handwrittenScenarios.length > 0 ? unit.handwrittenScenarios : undefined,
    );

    // Per-server compile-verify-repair loop:
    //
    // 1. Compile: ConstitutionCompilerSession with per-server schema
    //    (requireServer: true, single serverName enum, single server's toolNames)
    // 2. Generate scenarios: ScenarioGeneratorSession with this server's annotations only
    // 3. Verify: PolicyVerifierSession scoped to this server
    //    (single-server PolicyEngine, single-server judge prompt, single-server probe schema)
    // 4. Repair (up to 2 attempts): recompile + re-verify, all scoped to this server
    //
    // Each server gets its own independent sessions — no shared state between servers.
    // The repair loop logic is extracted from the existing PipelineRunner.run() method
    // into a reusable per-server method.
    // ...

    // Write per-server artifacts
    writeArtifact(serverOutputDir, 'compiled-policy.json', serverPolicyFile);
    writeArtifact(serverOutputDir, 'test-scenarios.json', serverScenariosFile);

    return result;
  }
}
```

### Parallel Server Compilation

Per-server compilations are independent and can run in parallel. The initial implementation should be **sequential** (for simpler debugging and progress reporting), with a `--parallel` flag or config option to enable concurrent compilation:

```typescript
// Future: parallel compilation
private async compileAllServersParallel(/* ... */): Promise<ServerCompilationResult[]> {
  const units = Object.entries(toolAnnotationsFile.servers).map(/* ... */);
  return Promise.all(units.map(unit => this.compileServer(unit, outputDir, constitutionHash)));
}
```

Parallel compilation is safe because:
- Each server writes to its own subdirectory (no file conflicts)
- Each server gets its own `ConstitutionCompilerSession` (no shared state)
- The LLM model object is stateless (AI SDK models are safe to call concurrently)
- Progress reporting will need adjustment (interleaved spinners or a summary mode)

However, parallel compilation should be deferred to a follow-up PR because:
- Progress reporting needs a different UX (cannot interleave multiple spinners)
- Error handling needs careful design (what to do if one server fails while others are in-flight)
- Rate limits on the LLM API may cause failures under parallel load

### Task-Policy Mode

The `compileTaskPolicy()` function (used by cron jobs) compiles whitelist rules from a task description. This mode should **not** use per-server compilation because:

1. Task policies are narrow whitelists, not broad constitution-derived rules
2. The task description is short and the LLM benefits from seeing all tools at once to select the minimal set
3. Task policies are compiled once per job, not incrementally

The per-server path is gated on `constitutionKind === 'constitution'`. Task-policy compilation continues to use the existing monolithic path.

```typescript
async run(config: PipelineRunConfig): Promise<CompiledPolicyFile> {
  if (config.constitutionKind === 'task-policy') {
    return this.runMonolithic(config);  // existing logic, renamed
  }
  return this.runPerServer(config);     // new per-server logic
}
```

### Server Name Enforcement Validation (Debug Assertion)

Since the Zod schema enforces `server: [serverName]` as a required field in per-server mode, this validation should never fail. It exists as a debug assertion to catch bugs in the pipeline itself (e.g., if someone passes the wrong schema options). It runs before merge at negligible cost:

```typescript
function validateServerScoping(
  serverName: string,
  rules: CompiledRule[],
): void {
  for (const rule of rules) {
    if (!rule.if.server || !rule.if.server.includes(serverName)) {
      throw new Error(
        `Rule "${rule.name}" from server "${serverName}" is missing ` +
        `server: ["${serverName}"] in its condition. This is a compiler bug.`
      );
    }
    if (rule.if.server.length !== 1 || rule.if.server[0] !== serverName) {
      throw new Error(
        `Rule "${rule.name}" from server "${serverName}" has unexpected ` +
        `server scope: ${JSON.stringify(rule.if.server)}. Expected exactly ["${serverName}"].`
      );
    }
  }
}
```

This validation runs before merge. If it fails, the pipeline reports the error and aborts -- the LLM produced rules that violate the server scoping contract.

### Cross-Server Verification (Not Needed)

Cross-server verification after merging is unnecessary because per-server rules compose correctly by construction:

1. **Server scoping is a Zod invariant.** Every rule has `server: [serverName]` enforced by the schema (`requireServer: true` in per-server mode). Rules from server A structurally cannot reference server B.
2. **Engine enforces server matching.** The PolicyEngine checks `cond.server.includes(request.serverName)` before evaluating any rule. A rule scoped to server A will never fire for a server B tool call.
3. **No deny rules means no cross-server interference.** Compiled rules only use `allow` and `escalate`. The default-deny fallback handles everything else. There is no mechanism by which server A's rules could weaken server B's security posture.
4. **Structural invariants are global and evaluated first.** Path containment and domain allowlist checks run before compiled rules, independent of server scoping.

If each server's rules verify correctly in isolation (which the per-server compile-verify-repair loop ensures), the merged rule set behaves identically to the union of independent per-server evaluations.

## Changes to Existing Modules

### `src/pipeline/pipeline-runner.ts` (major changes)

- `PipelineRunner.run()` becomes a dispatcher: per-server for `'constitution'`, monolithic for `'task-policy'`
- Existing `run()` logic moves to `runMonolithic()` (private, backward-compatible)
- New `runPerServer()` orchestrates per-server compilation + merge
- New `compileServer()` method handles a single server's compile-verify-repair cycle
- New `mergeServerResults()` and `validateServerScoping()` helper functions
- `PipelineRunConfig` gains an optional `serverFilter?: string[]` field to compile only specific servers (useful during development)

### `src/pipeline/constitution-compiler.ts` (moderate changes)

- `buildCompilerSystemPrompt()` gains an optional `serverScope?: string` parameter that, when provided, appends the "Server Scope" section to the system prompt
- `buildCompilerResponseSchema()` gains an `options?: { requireServer?: boolean }` parameter. When `requireServer: true`, the `server` field in `CompiledRuleCondition` is **required** (not optional), ensuring the Zod schema rejects rules without server scoping at parse time. The existing monolithic and task-policy paths pass `requireServer: false` (default) for backward compatibility.

### `src/pipeline/scenario-generator.ts` (minor changes)

- `buildGeneratorSystemPrompt()` already accepts `annotations: ToolAnnotation[]`; per-server compilation passes only the server's annotations
- `buildGeneratorResponseSchema()` already accepts `serverNames` and `toolNames`; no change needed

### `src/pipeline/policy-verifier.ts` (no code changes, different usage)

- `verifyPolicy()` already accepts a `CompiledPolicyFile` and `ToolAnnotationsFile` — per-server verification passes single-server versions of both
- `buildJudgeSystemPrompt()` already accepts `allAvailableTools` — per-server passes only that server's tools
- `PolicyVerifierSession` constructor already accepts `serverNames` and `toolNames` — per-server passes single-server arrays to restrict probe scenario generation
- No code changes needed in this file; all scoping is achieved by the caller passing scoped inputs

### `src/pipeline/handwritten-scenarios.ts` (no changes)

- Scenarios already have `serverName` in their request; filtering is done by the caller

### `src/pipeline/pipeline-shared.ts` (minor changes)

- `writeArtifact()` already handles `mkdirSync({ recursive: true })`; works for nested `servers/{name}/` directories
- New `loadServerArtifact()` convenience function for loading per-server cached artifacts

### `src/pipeline/compile.ts` (minor changes)

- Progress banner updated to show per-server compilation progress
- New `--server <name>` CLI flag to compile only a specific server (for development/debugging)

### `src/pipeline/types.ts` (additions only)

- New `ServerCompiledPolicyFile` interface
- New `ServerCompilationUnit` and `ServerCompilationResult` interfaces (or these could live in `pipeline-runner.ts` as they are internal)

### `src/trusted-process/policy-engine.ts` (no changes)

The PolicyEngine consumes `CompiledPolicyFile` which has the same format after merge. No changes needed.

### `src/config/generated/` (directory structure change)

New `servers/` subdirectory with per-server artifacts. The top-level `compiled-policy.json` remains the merged output, consumed by the runtime.

## Migration Path

### Phase 1: Extract monolithic logic into `runMonolithic()`

Rename the existing `run()` body to `runMonolithic()`. The public `run()` delegates to it. This is a pure refactor with no behavioral change. Tests continue to pass.

### Phase 2: Add per-server infrastructure

- Add `ServerCompiledPolicyFile` type
- Add `mergeServerResults()`, `validateServerScoping()`, `getHandwrittenScenariosForServer()`
- Add `compileServer()` method (extracts and adapts the compile-verify-repair loop)
- Add the `serverScope` parameter to `buildCompilerSystemPrompt()`
- Add per-server artifact I/O (`servers/{name}/` directory)

### Phase 3: Wire up `runPerServer()`

- Implement `runPerServer()` that orchestrates per-server compilation + merge
- Gate on `constitutionKind === 'constitution'` in `run()`
- Add `--server <name>` CLI flag

### Phase 4: Validate and tune

- Run full pipeline end-to-end, compare merged output quality to monolithic
- Verify that caching works (change one server's annotations, confirm only that server recompiles)
- Verify that task-policy mode is unaffected

### Backward Compatibility

- The merged `compiled-policy.json` has the same `CompiledPolicyFile` format
- Existing tests that use `PipelineRunner.run()` continue to work
- Task-policy compilation is completely unaffected
- The per-server artifacts in `servers/` are new and don't conflict with anything
- Users can delete `servers/` to force full recompilation

## Type Changes Summary

New types (all in `src/pipeline/types.ts` or `pipeline-runner.ts`):

```typescript
// Per-server compiled policy artifact
interface ServerCompiledPolicyFile {
  readonly generatedAt: string;
  readonly serverName: string;
  readonly constitutionHash: string;
  readonly inputHash: string;
  readonly rules: CompiledRule[];
  readonly listDefinitions?: ListDefinition[];
}
```

Modified types:

```typescript
// PipelineRunConfig -- one new optional field
interface PipelineRunConfig {
  // ... existing fields ...

  /** Compile only these servers (default: all servers in annotations). */
  readonly serverFilter?: string[];
}
```

No existing types are modified in breaking ways. The `CompiledPolicyFile` format is unchanged.

## Risks and Mitigations

**Risk: Per-server rules differ structurally from monolithic rules.** This is a deliberate behavioral change (see "Behavioral Change" section above). Each server's compiler independently interprets constitutional principles, which may produce different condition patterns across servers for the same principle. **Mitigation:** This is acceptable — correctness is per-server (each server's rules correctly implement the constitution for that server's tools). Cross-server consistency is nice-to-have, not required. The cross-server verification step confirms merged behavior is correct.

**Risk: Increased total LLM cost.** Multiple LLM calls instead of one, and each server may need independent repair loops (up to 2 repairs × N servers). **Mitigation:** Each call is smaller (fewer tokens in prompt and response). Incremental caching means most servers skip LLM calls entirely when nothing changes. Per-server rules are simpler in isolation and less likely to need repair. Net cost should be similar or lower over time.

**Risk: Rule ordering sensitivity across servers.** If server A and B both produce rules that could match the same tool call, ordering matters. **Mitigation:** This is structurally impossible because the Zod schema enforces `server: [serverName]` as a required field in per-server mode. Rules from server A literally cannot match tool calls for server B. Schema validation rejects any non-compliant LLM output at parse time.

**Risk: LLM ignores the server scope instruction.** The LLM might try to emit rules without the `server` field or with the wrong server. **Mitigation:** The Zod schema makes `server` required and restricts it to a single-element enum. Invalid output fails schema validation immediately and triggers the existing schema repair flow. The prompt reinforces this to reduce repair round-trips. The `validateServerScoping()` debug assertion provides a final safety net.

**Risk: Divergent dynamic list definitions across servers.** Two independent LLM calls may produce different `generationPrompt` values for the same named list. **Mitigation:** The merge phase uses first-wins (deterministic alphabetical server order) and logs a warning when definitions diverge. In practice, most lists are only referenced by one server's rules (e.g., domain lists by the fetch server).
