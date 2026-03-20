# Scenario Generation Batching

## Problem

The scenario generator fails for large MCP servers (100+ tools) in two ways:

1. **Output truncation.** With 128 tools and 20 rules, the LLM generates ~28K characters of JSON scenarios. The `DEFAULT_MAX_TOKENS = 8192` limit truncates the output mid-JSON, causing a hard parse failure. There is no recovery path because `ScenarioGeneratorSession.generate()` calls `generateText` directly and parses the result with `parseJsonWithSchema` -- a single truncated response is fatal.

2. **No repair loop for malformed JSON.** Unlike every other LLM call in the pipeline, `ScenarioGeneratorSession` does not use `generateObjectWithRepair`. If the LLM produces invalid JSON (truncated, schema violation, markdown-wrapped edge case), there is no retry-with-feedback mechanism. The tool annotator solved this exact problem by batching tools into groups of 25 and using `generateObjectWithRepair` for each batch.

These failures block onboarding of Google Workspace (128 tools), large GitHub servers, and any future server with >50 tools.

## Revised Flow

The key insight is that rules and scenarios are **both independent interpretations of the constitution**. Neither is ground truth -- the constitution is. The verifier/judge arbitrates by reasoning about the constitution directly and can identify issues in either.

The compile-verify-repair loop becomes:

```
1. Generate rules from constitution (per-server, already implemented)
2. Generate scenarios from constitution independently (batched by tools for large servers)
3. Verify scenarios against rules: collect feedback on rules AND scenarios, generate probes
4. If failed:
   a. Repair rules based on rule feedback
   b. Repair scenarios based on scenario feedback; insert probes into scenario set
   c. Go to step 3
5. Done or failed after max repair rounds.
```

Two critical differences from the previous design:

- **Scenarios are repaired, not regenerated from scratch.** After rule repair, scenarios are patched in-place based on the judge's scenario-specific feedback. Only broken scenarios change. The existing `applyScenarioCorrections` mechanism handles this already.
- **Probes are inserted during repair**, not on fresh regeneration. They accumulate across rounds as they do today.
- **Both channels are repaired symmetrically** in each iteration: scenario corrections first (cheap, no LLM call), then rule recompilation if needed (existing `compilePolicyRulesWithRepair`).

### Deliberate behavioral change: scenario correction replaces regeneration

The current repair loop uses `mergeReplacements` to **remove** corrected scenarios from the set and replace them with LLM-generated replacements via `ScenarioGeneratorSession.regenerate()`. This is wasteful and fragile: a scenario whose expectation the judge corrected is now *correct* -- throwing it away and hoping the LLM generates an equivalent replacement is strictly worse than keeping the corrected version.

The new design keeps corrected scenarios in-place with patched expectations (via `applyScenarioCorrections`). This is an intentional improvement:

1. **Correctness**: A scenario corrected by the judge has the right expectation by definition. Keeping it preserves verified test coverage.
2. **Stability**: No LLM call means no risk of the replacement introducing new errors or failing to cover the same ground.
3. **Simplicity**: Eliminates `mergeReplacements`, `ScenarioFeedback` construction, and the `ScenarioGeneratorSession` multi-turn state.

The only case that still requires an LLM call is generating replacements for structurally discarded scenarios (see "Targeted scenario repair" below).

## Key Design Decisions

### 1. Batch by tools, not rules

Scenarios are per-tool test cases (a tool call + expected decision). Batching by tools directly controls output size per LLM call because each batch generates scenarios only for its tools. Rules cannot be split -- deny scenarios (testing that no rule matches) inherently span all rules.

Each batch sees ALL rules (via the full constitution text in the system prompt) but only its batch's tool annotations. This ensures the LLM can reason about allow/deny/escalate correctly for the batch's tools.

### 2. Drop `ScenarioGeneratorSession` multi-turn class

Replace with:
- **Batched single-shot `generateObjectWithRepair` calls** for initial generation (step 2). Each batch gets its own system prompt with only its batch's annotations and a scoped Zod schema.
- **A targeted single-shot repair call** for scenario corrections (step 4b), if needed. This is small output (only the broken scenarios) and does not need batching.

The multi-turn session class is deleted. Rationale:

- **`ScenarioGeneratorSession` lacks the repair loop** that `generateObjectWithRepair` provides. This is the root cause of the truncation failure.
- **One code path for all server sizes.** A server with 10 tools goes through the same batching logic as one with 128 tools (it just has a single batch).
- **`formatFeedbackMessage` and `ScenarioFeedback` become unused.** Scenario repair now uses the existing `applyScenarioCorrections` (corrections from the judge) plus a targeted single-shot LLM call only when replacement scenarios are needed for discarded ones.

### 3. Per-batch system prompts with cache strategy threading

Each batch MUST have its own system prompt containing only that batch's annotations. The caller in `pipeline-runner.ts` should NOT pass a pre-built system prompt. Instead, `generateScenarios` builds per-batch prompts internally using `buildGeneratorSystemPrompt` with the batch's annotations slice.

The `system` parameter is removed from `generateScenarios`. The function receives the raw ingredients (constitution text, sandbox directory, permitted directories, dynamic lists) and constructs prompts per-batch.

**Cache strategy threading**: Since `generateScenarios` builds system prompts internally, it needs a way to apply provider-specific prompt caching. The function accepts an optional `wrapSystemPrompt` callback parameter typed as `(prompt: string) => string | SystemModelMessage`. This matches the signature of `PromptCacheStrategy.wrapSystemPrompt()` and allows the caller to pass `cacheStrategy.wrapSystemPrompt` directly. When omitted, the raw string prompt is passed through unchanged.

This is simpler than passing the full `PromptCacheStrategy` object (which has methods `generateScenarios` does not need) and avoids coupling the scenario generator to the cache strategy interface. The pipeline runner already has the cache strategy instance and just passes the bound method:

```typescript
const scenarios = await generateScenarios(
  unit.constitutionText,
  unit.annotations,
  unit.handwrittenScenarios,
  unit.allowedDirectory,
  this.model,
  permittedDirectories,
  onProgress,
  dynamicLists,
  (prompt) => this.cacheStrategy.wrapSystemPrompt(prompt),
);
```

### 4. Increase maxOutputTokens to 16384 for scenario generation

Belt-and-suspenders alongside batching. Even a 25-tool batch can generate substantial output. The increase is per-call (passed to `generateObjectWithRepair`), not a change to `DEFAULT_MAX_TOKENS`.

### 5. Keep the existing annotation format

With 25 tools per batch, the annotation summary is ~1,500-2,500 tokens -- well within limits. Stripping `none`-role arguments was considered but rejected: the savings are negligible with batching in place, and the full format gives the LLM better context for realistic test arguments.

### 6. Scenario repair is a targeted single-shot call

When the judge identifies scenarios with wrong expectations, the existing `extractScenarioCorrections` + `applyScenarioCorrections` flow handles corrections without any LLM call. The only case requiring an LLM call is when structurally discarded scenarios need replacement. This is a small, bounded output -- "here are N discarded scenarios, generate N replacements" -- so a single `generateObjectWithRepair` call suffices, no batching needed.

**Clarification on `discardedScenarios` source**: Structurally discarded scenarios come from `filterStructuralConflicts` -- a pre-loop one-time operation that removes scenarios conflicting with structural invariants (e.g., a scenario expects "allow" for a path outside the sandbox, but the engine would structurally deny it). These are NOT from the judge. The `repairScenarios` function handles these pre-loop discards. Inside the repair loop, the judge identifies scenario-blamed failures which are handled by `applyScenarioCorrections` (patching expectations), not by `repairScenarios`.

### 7. Reuse the `chunk` utility from tool-annotator

The `chunk<T>(items, size)` function in `tool-annotator.ts` is already exported and tested. The batch size constant is defined separately (`SCENARIO_BATCH_SIZE = 25`) since it could diverge from `ANNOTATION_BATCH_SIZE`.

## Interface Changes

### `src/pipeline/scenario-generator.ts`

**Deleted:**
- `ScenarioGeneratorSession` class (entire class, ~90 lines)
- `formatFeedbackMessage` function
- `INITIAL_USER_MESSAGE` constant

**Modified:**
- `generateScenarios` -- gains batching logic internally; `system` parameter removed (prompts built per-batch internally); adds `maxOutputTokens` parameter; adds `wrapSystemPrompt` callback parameter for prompt caching

**New:**
- `SCENARIO_BATCH_SIZE = 25` constant (exported for testing)
- `repairScenarios(brokenScenarios, feedback, constitution, annotations, ...)` -- targeted single-shot repair for structurally discarded scenarios that need replacement (not correction)

**Retained unchanged:**
- `buildGeneratorSystemPrompt` -- still builds a system prompt; called once per batch with the batch's annotations
- `buildGeneratorResponseSchema` -- builds Zod schema scoped to provided tool/server names
- `formatDynamicListsSection` -- unchanged
- `areSimilar` -- unchanged, used for cross-batch deduplication

### `src/pipeline/pipeline-runner.ts`

**Modified:**
- `generateTestScenarios` private method -- no longer creates a `ScenarioGeneratorSession`; calls `generateScenarios` directly. Return type drops the `session` field. The `system` parameter is removed; raw ingredients (constitution text, etc.) are passed instead. Passes `cacheStrategy.wrapSystemPrompt` as the `wrapSystemPrompt` callback.
- `compileServer` repair loop -- after rule repair, applies scenario corrections via `applyScenarioCorrections` (already happens), generates replacement scenarios for structurally discarded ones via `repairScenarios` if needed, inserts probes, then re-verifies. No fresh regeneration of all scenarios.

**No changes needed in `runPerServer` / `compileAllServers`:** These are merge/orchestration layers that delegate entirely to `compileServer`. All compile-verify-repair logic lives in `compileServer`.

**Deleted imports:**
- `ScenarioGeneratorSession` from `scenario-generator.js`
- `ScenarioFeedback` from `types.js` (no longer consumed)

**Deleted calls:**
- `scenarioSession.regenerate(feedback, ...)` -- replaced by `applyScenarioCorrections` + optional `repairScenarios`
- `mergeReplacements(...)` -- no longer needed; corrections are applied in-place, probes appended

### `src/pipeline/types.ts`

**Deprecated (candidates for removal):**
- `ScenarioFeedback` interface -- no longer consumed by scenario generator. Can be removed once `runMonolithic` is also deprecated (see below).

### `src/pipeline/generate-with-repair.ts`

**No changes.** `generateObjectWithRepair` already accepts `maxOutputTokens` as an option.

## Implementation Details

### Batch mechanics in `generateScenarios`

```typescript
import type { SystemModelMessage } from 'ai';

export const SCENARIO_BATCH_SIZE = 25;

export async function generateScenarios(
  constitutionText: string,
  annotations: ToolAnnotation[],
  handwrittenScenarios: TestScenario[],
  sandboxDirectory: string,
  llm: LanguageModel,
  permittedDirectories?: string[],
  onProgress?: (message: string) => void,
  dynamicLists?: DynamicListsFile,
  wrapSystemPrompt?: (prompt: string) => string | SystemModelMessage,
): Promise<TestScenario[]> {
  // Split annotations into batches
  const batches = chunk(annotations, SCENARIO_BATCH_SIZE);
  const allGenerated: TestScenario[] = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    if (batches.length > 1) {
      onProgress?.(`Batch ${i + 1}/${batches.length} (${batch.length} tools)`);
    }

    // Scoped schema: only this batch's server/tool names
    const serverNames = [...new Set(batch.map(a => a.serverName))] as [string, ...string[]];
    const toolNames = [...new Set(batch.map(a => a.toolName))] as [string, ...string[]];
    const schema = buildGeneratorResponseSchema(serverNames, toolNames);

    // Per-batch system prompt with only this batch's annotations
    const batchPromptText = buildGeneratorSystemPrompt(
      constitutionText, batch, sandboxDirectory,
      permittedDirectories, dynamicLists,
    );

    // Apply cache strategy wrapping if provided
    const batchSystem = wrapSystemPrompt
      ? wrapSystemPrompt(batchPromptText)
      : batchPromptText;

    // Filter handwritten scenarios to those relevant to this batch
    const toolNameSet = new Set(toolNames);
    const batchHandwritten = handwrittenScenarios.filter(
      s => toolNameSet.has(s.request.toolName),
    );

    const { output } = await generateObjectWithRepair({
      model: llm,
      schema,
      system: batchSystem,
      prompt: buildBatchPrompt(batchHandwritten),
      maxOutputTokens: 16384,
      onProgress: batches.length > 1
        ? (msg) => onProgress?.(`Batch ${i + 1}/${batches.length}: ${msg}`)
        : onProgress,
    });

    allGenerated.push(...output.scenarios.map(s => ({
      ...s,
      source: 'generated' as const,
    })));
  }

  // Deduplicate generated against handwritten AND across batches
  const seen = new Set<string>();
  const unique = allGenerated.filter(g => {
    if (handwrittenScenarios.some(h => areSimilar(g, h))) return false;
    const key = `${g.request.serverName}/${g.request.toolName}/${JSON.stringify(g.request.arguments)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return [...handwrittenScenarios, ...unique];
}
```

Note: `system` is NOT a parameter. Each batch builds its own system prompt via `buildGeneratorSystemPrompt` with the batch's annotation slice. This prevents the bug where a caller-provided system prompt contains all annotations, defeating the purpose of batching.

### `buildBatchPrompt` definition

The batch prompt is the user message sent with each batch's `generateObjectWithRepair` call. It is intentionally simple -- the system prompt already contains all the instructions, constitution, and annotations. The user message just triggers generation, optionally referencing the batch's handwritten scenarios so the LLM knows what ground is already covered:

```typescript
/**
 * Builds the user-message prompt for a single scenario generation batch.
 * When handwritten scenarios exist for this batch's tools, they are
 * included so the LLM avoids duplicating their coverage.
 */
function buildBatchPrompt(batchHandwritten: TestScenario[]): string {
  if (batchHandwritten.length === 0) {
    return 'Generate test scenarios following the instructions above.';
  }

  const handwrittenSummary = batchHandwritten.map(s =>
    `- ${s.request.serverName}/${s.request.toolName}: "${s.description}" (${s.expectedDecision})`
  ).join('\n');

  return `The following handwritten scenarios already exist for these tools. Generate additional scenarios that complement them without duplicating their coverage.

${handwrittenSummary}

Generate test scenarios following the instructions above.`;
}
```

This keeps the current behavior for batches without handwritten scenarios (identical prompt to today's `INITIAL_USER_MESSAGE`) while giving the LLM useful context for batches that have them.

### Targeted scenario repair

When structurally discarded scenarios need replacement, a single-shot LLM call generates replacements:

```typescript
export async function repairScenarios(
  discardedScenarios: { scenario: TestScenario; feedback: string }[],
  constitutionText: string,
  annotations: ToolAnnotation[],
  sandboxDirectory: string,
  llm: LanguageModel,
  permittedDirectories?: string[],
  dynamicLists?: DynamicListsFile,
  onProgress?: (message: string) => void,
): Promise<TestScenario[]> {
  // No batching needed -- discarded set is small (typically <10)
  const serverNames = [...new Set(annotations.map(a => a.serverName))] as [string, ...string[]];
  const toolNames = [...new Set(annotations.map(a => a.toolName))] as [string, ...string[]];
  const schema = buildGeneratorResponseSchema(serverNames, toolNames);

  const discardedList = discardedScenarios.map((b, i) =>
    `${i + 1}. "${b.scenario.description}" (${b.scenario.request.serverName}/${b.scenario.request.toolName}): ${b.feedback}`
  ).join('\n');

  const prompt = `The following scenarios were discarded because they conflict with structural invariants (hardcoded engine behavior that cannot be overridden by compiled rules).
Generate replacement scenarios that cover similar tools and decision types but with correct expectations.

${discardedList}

Generate one replacement scenario per discarded scenario.`;

  const system = buildGeneratorSystemPrompt(
    constitutionText, annotations, sandboxDirectory,
    permittedDirectories, dynamicLists,
  );

  const { output } = await generateObjectWithRepair({
    model: llm,
    schema,
    system,
    prompt,
    maxOutputTokens: DEFAULT_MAX_TOKENS,
    onProgress,
  });

  return output.scenarios.map(s => ({
    ...s,
    source: 'generated' as const,
  }));
}
```

This uses the full annotation set (not batched) since the discarded scenarios may span multiple tools. The output is small enough that `DEFAULT_MAX_TOKENS` suffices.

### Repair loop changes in `compileServer`

Before (current):
```
scenarioResult = generateTestScenarios(...)  // returns { scenarios, session }
discardedScenarios = filterStructuralConflicts(...)  // pre-loop, one-time
loop:
  verify(scenarios)
  if failed:
    extract attributions from judge
    applyScenarioCorrections(...)              // fix expectations in-place
    scenarioSession.regenerate(feedback)       // LLM multi-turn: generate replacements
    mergeReplacements(...)                     // splice replacements into scenario list
    repairRules(...)                           // recompile rules
    re-verify
```

After:
```
scenarios = generateTestScenarios(...)  // returns { scenarios, inputHash } (no session)
discardedScenarios = filterStructuralConflicts(...)  // pre-loop, one-time
if discardedScenarios.length > 0:
  replacements = repairScenarios(discardedScenarios)  // targeted single-shot LLM call
  append replacements to scenarios
loop:
  verify(scenarios + probes)
  if failed:
    extract attributions from judge
    applyScenarioCorrections(scenarios)        // fix expectations in-place (no LLM call)
    insert probes into accumulated probes
    if ruleBlamedFailures.length > 0:
      repairRules(...)                         // recompile rules via compiler session
    re-verify
```

The key simplification: no `ScenarioGeneratorSession` to manage, no `mergeReplacements`, no `ScenarioFeedback` construction. Scenario correction is handled by the existing `applyScenarioCorrections`. Replacement generation (for structurally discarded scenarios only) is a pre-loop single-shot call, not part of the repair loop.

### Prompt caching interaction

Prompt caching works per-batch during initial generation: each batch's system prompt is wrapped via the `wrapSystemPrompt` callback before being passed to `generateObjectWithRepair`. The callback is the caller's `cacheStrategy.wrapSystemPrompt` method, which for Anthropic adds `cacheControl: { type: 'ephemeral' }` metadata and for other providers is a no-op passthrough.

Across batches within the same run, the constitution and instruction text are shared but the annotation section differs, so caching provides partial benefit if the provider supports prefix-based caching.

During repair, `repairScenarios` uses a fresh system prompt with full annotations (not batched). The caller can wrap this prompt before passing to the function, or the function can accept the same `wrapSystemPrompt` callback. Since `repairScenarios` is called at most once (pre-loop), the caching benefit is minimal; adding the parameter is optional.

### Rule compilation token limits for large servers

With 128 tools, rule compilation also produces substantial output. The constitution compiler currently uses `DEFAULT_MAX_TOKENS = 8192`. For servers with many tools, rule compilation may hit the same truncation problem. This is noted as a concern but deferred: the compiler's output scales with constitution complexity (number of principles), not with tool count, since per-server compilation scopes to one server. If this becomes a problem, rule compilation could adopt the same batching pattern (batch by tool groups, merge rules). For now, increasing `maxOutputTokens` for the compiler call when tool count exceeds a threshold is a simpler mitigation.

## `runMonolithic` Deprecation

### Rationale

`runMonolithic` is the `task-policy` mode path that compiles all servers in a single monolithic LLM call with its own parallel repair loop. It should be deprecated and removed for three reasons:

1. **Duplicate code.** `runMonolithic` (lines 1060-1553 of `pipeline-runner.ts`) contains its own complete compile-verify-repair loop that is structurally identical to the one in `compileServer`, but with subtle differences in logging, caching, and dynamic list resolution. Any improvement to the repair loop (like this batching change) must be applied in both places or the paths diverge.

2. **Won't get batching improvements.** The scenario generation batching described in this design only modifies `generateTestScenarios` and the `compileServer` repair loop. `runMonolithic` would need its own parallel set of changes to benefit, further increasing the maintenance burden.

3. **The per-server path already handles the general case.** `compileAllServers` iterates over servers and calls `compileServer` for each. Task-policy mode can be handled by treating the task context as a single compilation unit -- all servers' annotations compiled together as one "virtual server" (or more precisely, without the `requireServer: true` Zod constraint).

### How task-policy mode works through the per-server path

Task-policy mode compiles all servers together because the LLM benefits from seeing the full tool landscape when generating a whitelist for a specific task. This can be modeled as a single compilation unit in the per-server path:

- **Single compilation unit**: Instead of iterating per server, `compileAllServers` creates one `ServerCompilationUnit` with `serverName: '__task__'` (or similar sentinel), all annotations concatenated, and the task description as `constitutionText`.
- **System prompt**: Uses `buildTaskCompilerSystemPrompt` instead of `buildCompilerSystemPrompt`. The `constitutionKind` field already exists on `PipelineRunConfig` and can be threaded to `compileServer`.
- **No `requireServer` constraint**: Task-policy rules are not scoped to a single server; the Zod schema omits the `requireServer: true` option.
- **No per-server caching**: The single unit caches as a whole, which matches the current monolithic behavior.

### Migration plan

This deprecation is a follow-up, not blocking the main batching work:

1. **Phase 1 (this PR)**: Implement scenario batching in `generateTestScenarios` and `compileServer`. `runMonolithic` continues working as-is but does not benefit from batching.
2. **Phase 2 (follow-up PR)**: Refactor `compileServer` to accept `constitutionKind` and use the appropriate compiler prompt. Route task-policy mode through the per-server path with a single compilation unit. Delete `runMonolithic`, `compilePolicyRules` (monolithic-only helper), and associated dead code.

## Testing Strategy

### Unit tests (`test/scenario-generator.test.ts`)

- **Batch splitting**: Verify that `generateScenarios` with >25 annotations calls `generateObjectWithRepair` multiple times (mock the LLM).
- **Single batch path**: Verify that <=25 annotations produces exactly one `generateObjectWithRepair` call.
- **Schema scoping**: Verify each batch's Zod schema only accepts tool names from that batch (a scenario referencing a tool from another batch should fail validation).
- **Per-batch system prompt**: Verify each batch's system prompt contains only that batch's annotations, not all annotations.
- **Handwritten filtering**: Verify handwritten scenarios are assigned to the correct batch by toolName.
- **Cross-batch dedup**: Verify that if two batches generate scenarios with identical tool+args, only one is kept.
- **No `system` parameter**: Verify that `generateScenarios` does not accept a system prompt parameter.
- **`wrapSystemPrompt` callback**: Verify that when provided, each batch's system prompt is passed through the callback before being sent to `generateObjectWithRepair`.
- **`buildBatchPrompt`**: Verify that batches with handwritten scenarios include them in the user message, and batches without use the simple default prompt.

### Repair tests

- **`repairScenarios` basic**: Mock LLM, verify it receives the discarded scenarios and returns replacements.
- **Correction-only repair**: When all failures are scenario-blamed, verify no recompilation occurs and `applyScenarioCorrections` handles the fix.
- **Mixed blame repair**: When some failures blame rules and some blame scenarios, verify both channels fire.
- **No `mergeReplacements`**: Verify that the repair loop does not call `mergeReplacements` -- corrected scenarios stay in-place.

### Integration tests

- **Large server simulation**: Create a fixture with 60+ mock tool annotations, run `generateScenarios` with a real LLM (or a deterministic mock), verify all tools are covered.
- **Repair loop**: Verify that after rule repair, scenarios are corrected in-place (not regenerated from scratch) and verification passes.

### Regression tests

- **Existing scenario files**: Run the pipeline against the existing filesystem and git servers, verify output is equivalent (same coverage, no regressions in pass rate).

## Future Considerations

- **Parallel batching**: Batches are currently sequential. They could run in parallel with `Promise.all` since they are independent. Deferred to avoid complexity in error handling and progress reporting, but the design is ready for it (no shared mutable state between batches).
- **Adaptive batch size**: If a batch still hits token limits, the batch size could be halved and retried. Not needed now since 25 tools at 16384 tokens provides ample headroom.
- **Rule compilation batching**: If per-server rule compilation hits output limits for very large servers, the same batch-by-tools pattern can be applied to the constitution compiler. This would require merging rule sets from multiple batches and resolving cross-batch rule ordering -- nontrivial but feasible.
- **Batch-aware verification**: Currently verification runs on the full concatenated scenario set. If verification becomes slow for very large sets, it could be batched too. Not a concern now since verification is fast (no LLM calls for execution, only for the judge rounds).
