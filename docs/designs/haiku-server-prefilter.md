# Design: Haiku Server Pre-Filter for Policy Compilation

## Overview

The policy compilation pipeline (`compile-policy`) runs a full compile-verify-repair cycle for every MCP server that has tool annotations. When the input text (user constitution, task description, or persona definition) has no specific guidance for a server, this cycle produces rules equivalent to default-deny -- an expensive no-op. This design adds a cheap pre-filter step that uses Haiku to determine whether each server can be skipped before invoking the expensive compilation model (Opus/Sonnet).

The pre-filter asks Haiku a single yes/no question per server. The question is mode-aware:
- **Constitution mode**: "Does this user guidance specifically allow any of this server's tools?"
- **Task-policy mode**: "Would accomplishing this task require any of this server's tools?"

If the answer is no, the server is skipped with a clear log message, and default-deny handles the rest.

## Key Design Decisions

### 1. Runs for all compilation modes (constitution, task-policy, persona)

**Decision**: The pre-filter runs for all callers of `PipelineRunner.run()`, not just the `compile-policy` CLI. It receives the pre-filter input text as a parameter, and each caller provides the appropriate text.

**Rationale**: The cost savings apply equally to all modes. A task description like "analyze CSV files in /data" only needs the filesystem server -- compiling policy for git, GitHub, fetch, and google-workspace is wasted work. Persona definitions are similarly scoped.

**Alternative considered**: Restrict to constitution mode only. Rejected because task-policy mode compiles for all annotated servers by default, and tasks are typically narrow in scope -- making the pre-filter even more valuable there.

### 2. Caller provides pre-filter text, not read from disk

**Decision**: The pre-filter function takes its input text as a parameter. Each caller decides what to pass:
- `compile.ts` (constitution mode): passes user constitution text only (via `loadUserConstitutionText()`), excluding base principles
- `compileTaskPolicy()`: passes the task description (same as `constitutionInput`)
- Persona compilation: passes the persona constitution (same as `constitutionInput`)

**Rationale**: The pre-filter module has no business knowing where the text comes from or how to load it. Taking a parameter makes it a pure function of its inputs, testable without filesystem mocking. The caller already has the text or knows where to get it.

**Alternative considered**: Have the pre-filter read user constitution from disk internally. Rejected because it creates a mismatch for task-policy/persona modes where the relevant text is `constitutionInput`, not the user constitution file.

### 3. For constitution mode, only the user constitution is evaluated (not base principles)

**Decision**: In constitution mode, the pre-filter receives only the user constitution text (from `~/.ironcurtain/constitution-user.md` or the bundled `constitution-user-base.md`), not the combined `base + user` text.

**Rationale**: The base constitution (`constitution.md`) contains three universal principles -- least privilege, no destruction, human oversight. These apply to every server equally and never produce server-specific allow rules on their own. Including them would add noise and could mislead Haiku into thinking "human oversight" means something should be allowed via escalate rules.

**Alternative considered**: Pass the full combined constitution. Rejected because it conflates universal structural principles (which the engine enforces independently) with user-specific guidance (which drives compiled rules).

### 4. Mode-aware prompt framing

**Decision**: The Haiku prompt is framed differently depending on `constitutionKind`:
- **Constitution**: "Does this guidance specifically allow any of this server's tools?"
- **Task-policy**: "Would accomplishing this task require any of this server's tools?"

The schema, function signature, and fail-open behavior are identical across modes.

**Rationale**: A constitution explicitly grants permissions ("the agent may read files"). A task description implicitly requires capabilities ("analyze the CSV files in /data"). The same question phrased one way would produce unreliable results for the other mode. "Does this task description allow filesystem tools?" is the wrong question -- it doesn't "allow" anything, it requires them.

**Alternative considered**: Single prompt that works for both modes. Rejected because the semantic difference between "grants permission" and "requires capability" is exactly the kind of nuance that matters for a cheap classification model. Being explicit about what to look for improves reliability.

### 5. Pre-filter runs per-server, not as a single batch call

**Decision**: One Haiku call per server. Each call receives the server name and its tool list from annotations.

**Rationale**: Each server's relevance depends on its specific tools matching the input text. Per-server calls are independently retriable, produce per-server reasons for logging, and keep individual prompt sizes small.

**Alternative considered**: Single Haiku call with all servers. Rejected because (a) prompt length scales with total tool count across all servers, (b) structured output with per-server results is more complex to validate, and (c) a single failure would block all servers rather than just one.

### 6. Empty/missing input text skips all servers without LLM call

**Decision**: If the input text is empty or whitespace-only, skip all servers immediately. No Haiku calls are made.

**Rationale**: An empty input means no specific guidance exists. No LLM call can discover permissions that aren't in the input. This avoids unnecessary API calls for a trivially decidable case.

### 7. `--server` flag bypasses pre-filter

**Decision**: When `--server <name>` is specified, the pre-filter is skipped entirely. The named server proceeds directly to full compilation.

**Rationale**: `--server` is a developer debugging tool. When a developer explicitly names a server, they want compilation to run regardless of pre-filter results. Skipping a server that was explicitly requested would be surprising.

### 8. Pre-filter failure defaults to "do not skip" (fail-open)

**Decision**: If the Haiku call fails (network error, rate limit, invalid response), log a warning and proceed with full compilation for that server.

**Rationale**: The pre-filter is an optimization, not a correctness requirement. A false-negative (incorrectly skipping) silently drops security policy. A false-positive (unnecessary compilation) wastes only money and time. The asymmetry strongly favors fail-open.

**Alternative considered**: Fail the pipeline on pre-filter error. Rejected because a Haiku outage should not block policy compilation.

### 9. No caching of skip decisions

**Decision**: The pre-filter result is not persisted to disk or cached between runs.

**Rationale**: Haiku is cheap (~$0.001 per call). Adding a cache layer introduces invalidation complexity for negligible savings. The existing per-server compilation cache (content-hash based) already handles the expensive compilation caching.

### 10. Skipped servers emit zero rules (no synthetic rules)

**Decision**: When a server is skipped, it contributes nothing to the merged policy. No synthetic "deny all" rules are generated.

**Rationale**: The policy engine implements default-deny as a structural invariant. Adding synthetic deny rules would be redundant, clutter the policy, and interfere with the engine's audit logging for default-deny decisions.

### 11. Skipped servers are recorded in compiled-policy.json metadata

**Decision**: The merged `compiled-policy.json` includes a `skippedServers` field listing servers skipped by the pre-filter, along with the reason.

**Rationale**: Without this, a user debugging "why doesn't my policy have rules for server X?" would need to re-run compilation to see the pre-filter log. A structured record in the artifact makes the decision inspectable after the fact.

**Alternative considered**: Only log to stderr. Rejected because stderr output is ephemeral and lost after the terminal session ends.

### 12. Pre-filter model created via PipelineModels, not a separate creation path

**Decision**: The pre-filter model (Haiku) is created alongside other pipeline models in `createPipelineModels()` and passed through `PipelineModels`. It reuses the same provider infrastructure (API key, logging middleware) as other pipeline models.

**Rationale**: Creating a separate model via a standalone helper would bypass the existing provider infrastructure. If the user has configured custom API endpoints or proxy settings, a separate helper might not pick them up. Centralizing model creation in `PipelineModels` ensures consistent configuration.

**Alternative considered**: Standalone `createPrefilterModel()` that calls `loadUserConfig()` independently. Rejected because (a) it loads user config a second time unnecessarily, and (b) it bypasses provider configuration that the main models respect.

### 13. Prompt includes explicit "when in doubt, do not skip" instruction

**Decision**: The Haiku prompt contains a safety bias instruction: "When in doubt, set skip to false."

**Rationale**: The fail-open philosophy should extend to the model's own uncertainty. Without this instruction, Haiku may confidently skip servers with oblique relevance (e.g., "the agent may access any REST API" -- does that apply to the fetch server? GitHub?). An explicit bias toward "do not skip" ensures ambiguous cases proceed to full compilation.

## Interface Definitions

### Pre-filter response schema (Zod)

```typescript
// In src/pipeline/server-prefilter.ts

import { z } from 'zod';

const serverRelevanceSchema = z.object({
  skip: z.boolean().describe(
    'true if the input text contains no specific guidance that would require or allow any of this server\'s tools. When in doubt, set to false.'
  ),
  reason: z.string().describe(
    'Brief explanation of why the server is or is not relevant to the input text'
  ),
});

type ServerRelevanceResult = z.infer<typeof serverRelevanceSchema>;
```

### Pre-filter function signatures

```typescript
// In src/pipeline/server-prefilter.ts

import type { LanguageModel } from 'ai';
import type { ToolAnnotation } from './types.js';
import type { ConstitutionKind } from './pipeline-runner.js';

/**
 * Result of the pre-filter for a single server.
 */
export interface PrefilterDecision {
  readonly serverName: string;
  readonly skip: boolean;
  readonly reason: string;
}

/**
 * Determines whether a server can be skipped during policy compilation.
 *
 * @param text - The input text to evaluate (user constitution, task description, or persona definition)
 * @param serverName - The MCP server name
 * @param tools - The server's annotated tools (from tool-annotations.json)
 * @param model - A Haiku LanguageModel instance
 * @param kind - Controls prompt framing ('constitution' vs 'task-policy')
 *
 * @throws Never -- errors are caught internally and result in skip: false
 */
export async function checkServerRelevance(
  text: string,
  serverName: string,
  tools: ReadonlyArray<ToolAnnotation>,
  model: LanguageModel,
  kind: ConstitutionKind,
): Promise<PrefilterDecision>;

/**
 * Runs the pre-filter for all servers concurrently.
 *
 * Short-circuits entirely when text is empty/whitespace
 * (returns skip: true for all servers without making any LLM calls).
 */
export async function prefilterServers(
  text: string,
  servers: Array<[string, ReadonlyArray<ToolAnnotation>]>,
  model: LanguageModel,
  kind: ConstitutionKind,
): Promise<PrefilterDecision[]>;
```

**Note on array interface**: `prefilterServers` takes and returns arrays (not Maps) to match the tuple-based flow in `compileAllServers()`, avoiding unnecessary Map/array conversions at the call site.

### Updated PipelineRunConfig

```typescript
export interface PipelineRunConfig {
  // ... existing fields ...

  /**
   * Text for the pre-filter to evaluate server relevance against.
   * Caller provides the appropriate text for the compilation mode:
   * - Constitution mode: user constitution only (without base principles)
   * - Task-policy mode: task description
   * - Persona mode: persona constitution
   *
   * When undefined, the pre-filter is skipped.
   */
  readonly prefilterText?: string;
}
```

**Rationale**: A single optional field controls the pre-filter. When the caller provides text, the pre-filter runs. When it omits the field (`undefined`), the pre-filter is skipped. The `--server` bypass is handled separately since it's an orthogonal concern (the text might be provided but the filter is skipped because a specific server was requested). All compilation modes (constitution, task-policy, persona) and all CLI flags (`--constitution`, default) provide pre-filter text — there is no case where the pre-filter should be silently disabled.

### Updated PipelineModels

```typescript
export interface PipelineModels {
  // ... existing fields ...

  /** Cheap model for pre-filter classification (Haiku). */
  readonly prefilterModel: LanguageModel;
}
```

### Updated CompiledPolicyFile metadata

```typescript
// Addition to CompiledPolicyFile in src/pipeline/types.ts
export interface CompiledPolicyFile {
  // ... existing fields ...

  /** Servers skipped by the pre-filter (all calls denied by default). */
  readonly skippedServers?: Array<{
    readonly serverName: string;
    readonly reason: string;
  }>;
}
```

## Prompt Design

The prompt structure is shared across modes, with the task framing varying by `constitutionKind`:

```typescript
function buildPrefilterPrompt(
  serverName: string,
  tools: ReadonlyArray<ToolAnnotation>,
  kind: ConstitutionKind,
): string {
  const toolList = tools
    .map((t) => `- ${t.toolName}: ${t.comment}`)
    .join('\n');

  const taskFraming = kind === 'constitution'
    ? `Based ONLY on the user guidance below, determine whether ANY of this server's tools would be specifically allowed or granted special permissions.

The user guidance is relevant to this server if it:
- Mentions the server by name
- Mentions capabilities that map to this server's tools (e.g., "read files" maps to a filesystem server, "search GitHub issues" maps to a GitHub server)
- Grants permissions for operations this server provides

The user guidance is NOT relevant if it:
- Contains no mention of this server's domain of functionality
- Only contains general principles that don't translate to specific allow rules for this server's tools

If the user guidance contains no specific permissions for this server, the server can be safely skipped — a default-deny policy will handle all its tools.`
    : `Based ONLY on the task description below, determine whether accomplishing this task would require ANY of this server's tools.

The task is relevant to this server if it:
- Describes work that directly requires this server's capabilities (e.g., "analyze CSV files" requires filesystem tools, "check open PRs" requires GitHub tools)
- References data, resources, or operations that this server provides access to

The task is NOT relevant to this server if it:
- Describes work entirely outside this server's domain of functionality
- Makes no reference to resources or operations this server provides

If the task does not require any of this server's tools, the server can be safely skipped — a default-deny policy will handle all its tools.`;

  return `You are evaluating whether an input text is relevant to a specific MCP server's tools.

## Server: "${serverName}"

### Available tools:
${toolList}

## Task

${taskFraming}

**Important: When in doubt, set skip to false.** It is better to compile rules unnecessarily than to skip a server that needs them.

Respond with a JSON object: { "skip": boolean, "reason": string }`;
}
```

The input text is provided as the user message:

```typescript
const userMessage = text.trim() || '(no guidance provided)';
```

## Where This Slots In

### File: `src/pipeline/server-prefilter.ts` (new)

Contains `checkServerRelevance()`, `prefilterServers()`, the Zod schema, and the prompt builder. No other module needs to know about the pre-filter schema.

### File: `src/config/paths.ts` (modified -- new export)

Add `loadUserConstitutionText()`. This extracts the user-constitution-reading logic into a helper that returns empty string when no file exists (instead of throwing like `loadConstitutionText()`).

```typescript
/**
 * Reads just the user constitution text (without base principles).
 * Returns empty string if no user constitution file exists.
 *
 * Shared by loadConstitutionText() (which combines base + user)
 * and the pre-filter (which evaluates user guidance only).
 */
export function loadUserConstitutionText(): string {
  const userPath = getUserConstitutionPath();
  const fallbackPath = getBaseUserConstitutionPath();
  if (existsSync(userPath)) {
    return readFileSync(userPath, 'utf-8');
  }
  if (existsSync(fallbackPath)) {
    return readFileSync(fallbackPath, 'utf-8');
  }
  return '';
}
```

**Note**: The existing `loadConstitutionText()` throws when neither user constitution file exists. This function returns empty string instead, because an absent user constitution is a valid state for the pre-filter (it means "skip all servers"). The divergent semantics are intentional.

### File: `src/pipeline/pipeline-shared.ts` (modified)

Add Haiku model creation to `createPipelineModels()`:

```typescript
export async function createPipelineModels(logPath: string): Promise<PipelineModels> {
  // ... existing model creation ...

  const prefilterModel = await createPrefilterModel(userConfig, logPath);

  return {
    // ... existing fields ...
    prefilterModel,
  };
}

async function createPrefilterModel(
  userConfig: UserConfig,
  logPath: string,
): Promise<LanguageModel> {
  const baseLlm = await createLanguageModel('anthropic:claude-haiku-4-5', userConfig);
  const logContext: LlmLogContext = { stepName: 'prefilter' };
  return wrapLanguageModel({
    model: baseLlm,
    middleware: createLlmLoggingMiddleware(logPath, logContext, {
      deltaLogging: false,
      appendOnly: true,
    }),
  });
}
```

### File: `src/pipeline/pipeline-runner.ts` (modified)

The pre-filter integrates into `compileAllServers()`, between the server filter application (line 652-655) and the handwritten scenario loading (line 664).

```typescript
private async compileAllServers(
  config: PipelineRunConfig,
  toolAnnotationsFile: ToolAnnotationsFile,
  constitutionHash: string,
  storedAnnotationsFile: StoredToolAnnotationsFile,
): Promise<ServerCompilationResult[]> {
  const serverEntries = Object.entries(toolAnnotationsFile.servers);

  // Apply server filter if provided (existing)
  const { serverFilter } = config;
  const filteredEntries = serverFilter
    ? serverEntries.filter(([name]) => serverFilter.includes(name))
    : serverEntries;

  if (config.serverFilter && filteredEntries.length === 0) {
    throw new Error(
      `No matching servers found for filter: ${config.serverFilter.join(', ')}. ` +
        `Available: ${serverEntries.map(([n]) => n).join(', ')}`,
    );
  }

  // --- NEW: Pre-filter with Haiku ---
  let entriesToCompile = filteredEntries;
  const skippedServers: Array<{ serverName: string; reason: string }> = [];

  if (config.prefilterText !== undefined && !config.serverFilter) {
    const prefilterText = config.prefilterText;

    if (prefilterText.trim() === '') {
      console.error(chalk.yellow(
        'Pre-filter input is empty. All servers skipped (default-deny applies).'
      ));
      return [];
    }

    const serverToolPairs = filteredEntries.map(
      ([name]) => [name, toolAnnotationsFile.servers[name].tools] as [string, ReadonlyArray<ToolAnnotation>]
    );
    const decisions = await prefilterServers(
      prefilterText, serverToolPairs, this.models.prefilterModel, config.constitutionKind,
    );

    const decisionMap = new Map(decisions.map(d => [d.serverName, d]));
    entriesToCompile = filteredEntries.filter(([name]) => {
      const decision = decisionMap.get(name);
      if (decision?.skip) {
        console.error(`  ${chalk.dim(name)}: ${chalk.yellow('skipped')} — ${decision.reason}`);
        skippedServers.push({ serverName: name, reason: decision.reason });
        return false;
      }
      return true;
    });

    const skippedCount = filteredEntries.length - entriesToCompile.length;
    if (skippedCount > 0) {
      console.error(
        `  Pre-filter: ${skippedCount} server(s) skipped, ${entriesToCompile.length} proceeding`
      );
    }
  }

  if (entriesToCompile.length === 0) {
    console.error(chalk.yellow('All servers skipped by pre-filter. Policy will use default-deny only.'));
    return [];
  }

  // --- Continue with existing compilation using entriesToCompile ---
  // ... (rest of method unchanged, but uses entriesToCompile instead of filteredEntries)
```

The `skippedServers` array is threaded through to `mergeServerResults()` and included in the final `compiled-policy.json`.

### File: `src/pipeline/compile.ts` (modified)

Provides pre-filter text appropriate to the source:

```typescript
// In the PipelineRunConfig construction
{
  // ... existing fields ...
  prefilterText: constitutionArg ? config.constitutionText : loadUserConstitutionText(),
}
```

When `--constitution` is specified, the override file's full text is used as pre-filter input (it IS the user's guidance). In normal mode, only the user constitution portion is used (excluding base principles).

### File: `src/cron/compile-task-policy.ts` (modified)

Provides the task description as `prefilterText`:

```typescript
return runner.run({
  constitutionInput: taskDescription,
  constitutionKind: 'task-policy',
  prefilterText: taskDescription,  // NEW
  // ... rest unchanged ...
});
```

### File: `src/persona/compile-persona-policy.ts` (modified)

Provides the persona constitution as `prefilterText`:

```typescript
return runner.run({
  constitutionInput: personaConstitution,
  constitutionKind: 'constitution', // or whatever kind persona uses
  prefilterText: personaConstitution,  // NEW
  // ... rest unchanged ...
});
```

## Component Diagram

```
compile.ts (CLI)                    compileTaskPolicy()         compilePersonaPolicy()
  |                                   |                           |
  | prefilterText =                   | prefilterText =           | prefilterText =
  |   loadUserConstitutionText()      |   taskDescription         |   personaConstitution
  |   (undefined if --constitution)   |                           |
  +-----------------------------------+---------------------------+
                                      |
                                      v
                            PipelineRunner.run()
                                      |
                                      v
                            compileAllServers()
                                      |
                      +---> [1] Apply --server filter (existing)
                      |
                      +---> [2] Guard: prefilterText !== undefined
                      |          && !serverFilter?
                      |     |
                      |     +-- NO --> skip pre-filter, compile all servers
                      |     |
                      |     +-- YES --> prefilterText empty?
                      |                 |
                      |                 +-- yes --> skip all, return []
                      |                 |
                      |                 +-- no --> prefilterServers(text, ..., kind)
                      |                             |
                      |                             +---> checkServerRelevance() x N
                      |                             |       (Haiku, mode-aware prompt)
                      |                             |
                      |                             +---> filter out skip:true
                      |                                    log skipped servers
                      |
                      +---> [3] Compile remaining servers (existing)
                      |
                      +---> [4] Merge results + skippedServers metadata
```

## Interaction with the Merge Phase

When servers are skipped:

1. **`mergeServerResults()`** receives fewer results. Fewer servers = fewer rules. Correct.
2. **`compiled-policy.json`** has no rules for skipped servers but includes `skippedServers` metadata.
3. **`test-scenarios.json`** has no scenarios for skipped servers.
4. **`dynamic-lists.json`** is unaffected.
5. **Per-server artifacts** under `generated/servers/{serverName}/` are not written for skipped servers. Stale artifacts from previous runs are harmless (they won't match the current inputHash).

## Interaction with Handwritten Scenarios

Handwritten scenarios (in `handwritten-scenarios.ts`) exist for filesystem and git servers to catch default-deny regressions. If the pre-filter skips these servers, those scenarios are never verified.

This is acceptable because: if the pre-filter skips a server, the compiled policy has no rules for it. Handwritten scenarios test that *compiled rules* produce the correct decisions. With no compiled rules, the policy engine's structural default-deny is the only behavior, and it's tested independently in `policy-engine.test.ts`. The handwritten scenarios would either pass trivially (for escalate/deny expectations) or fail pointlessly (for allow expectations that can't work without compiled rules).

## Error Handling

### Haiku call fails

`checkServerRelevance()` catches all errors and returns `{ skip: false, reason: 'Pre-filter error: <message>' }`. The server proceeds to full compilation.

```typescript
export async function checkServerRelevance(
  text: string,
  serverName: string,
  tools: ReadonlyArray<ToolAnnotation>,
  model: LanguageModel,
  kind: ConstitutionKind,
): Promise<PrefilterDecision> {
  try {
    const { output } = await generateObjectWithRepair({
      model,
      schema: serverRelevanceSchema,
      system: buildPrefilterPrompt(serverName, tools, kind),
      prompt: text,
      maxRepairAttempts: 1,
      maxOutputTokens: 256,
    });
    return { serverName, skip: output.skip, reason: output.reason };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      serverName,
      skip: false,
      reason: `Pre-filter error (proceeding with compilation): ${message}`,
    };
  }
}
```

**Note**: `generateObjectWithRepair` returns `{ output, repairAttempts }`, so the result is destructured as `{ output }` to access the parsed schema object.

### Haiku model not available

If the user's API key doesn't have access to Haiku (e.g., they use a different provider), `createLanguageModel` will fail during `createPipelineModels()`. This is a startup error that surfaces immediately with a clear error message, not a silent runtime failure.

### Input text is empty

The pre-filter short-circuits and skips all servers without any LLM calls.

### All servers are skipped

`compileAllServers()` returns an empty results array. The merge produces a policy with zero rules plus the `skippedServers` metadata. The pipeline completes successfully with a warning.

## Concurrency

`prefilterServers()` runs all per-server Haiku calls concurrently via `Promise.all`. Given that:
- Haiku has high rate limits
- Each call is tiny (~256 output tokens)
- There are typically 3-5 servers

No concurrency cap is needed. If server count grows significantly in the future, a `pLimit` cap can be added.

## Testing Strategy

### Unit tests for `server-prefilter.ts`

1. **Schema validation**: `serverRelevanceSchema` accepts valid inputs, rejects invalid.
2. **Prompt construction (constitution mode)**: `buildPrefilterPrompt()` with `'constitution'` includes "specifically allowed or granted special permissions".
3. **Prompt construction (task-policy mode)**: `buildPrefilterPrompt()` with `'task-policy'` includes "accomplishing this task would require".
4. **Empty text short-circuit**: `prefilterServers()` with empty string returns `skip: true` for all servers without invoking the model.
5. **Error handling**: `checkServerRelevance()` with a throwing model returns `{ skip: false }`.
6. **`generateObjectWithRepair` integration**: Mock model returns valid JSON, verify `{ output }` destructuring works correctly.

### Unit tests for pipeline-runner integration

1. **Pre-filter runs when `prefilterText` is provided**: Verify `prefilterServers()` is called.
2. **Pre-filter skipped when `prefilterText` is undefined**: Verify `prefilterServers()` is not called.
3. **Bypass for `--server`**: Verify pre-filter does not run when `serverFilter` is set, even if `prefilterText` is provided.
4. **Skipped servers excluded**: Mock `prefilterServers()` to skip one server, verify `compileServer()` is only called for the remaining.
5. **`skippedServers` in output**: Verify the merged `compiled-policy.json` contains the skipped server metadata.
6. **`constitutionKind` forwarded to prompt**: Verify the kind parameter reaches `buildPrefilterPrompt()`.

### Caller-level tests

1. **`compile.ts`**: `prefilterText` is always set — to the user constitution text in normal mode, or to the full override text when `--constitution` is specified.
2. **`compileTaskPolicy()`**: `prefilterText` is set to the task description.
3. **Persona compilation**: `prefilterText` is set to the persona constitution.

### Integration test (requires API key)

Run `compile-policy` with a narrow constitution mentioning only filesystem, verify other servers are logged as skipped and produce no rules.

## Migration Notes

This is a purely additive change:

1. **New file**: `src/pipeline/server-prefilter.ts`
2. **New export**: `loadUserConstitutionText()` in `src/config/paths.ts`
3. **Modified**: `createPipelineModels()` in `pipeline-runner.ts` -- adds `prefilterModel` to return value
4. **Modified**: `PipelineModels` interface -- adds `prefilterModel` field
5. **Modified**: `PipelineRunConfig` -- new optional `prefilterText` field
6. **Modified**: `CompiledPolicyFile` -- new optional `skippedServers` field
7. **Modified**: `compileAllServers()` in `pipeline-runner.ts` -- new guarded code path
8. **Modified**: `compile.ts` -- sets `prefilterText` from user constitution
9. **Modified**: `compile-task-policy.ts` -- sets `prefilterText` from task description
10. **Modified**: `compile-persona-policy.ts` -- sets `prefilterText` from persona constitution

Existing behavior is unchanged when `prefilterText` is not provided or `--server` is specified. The pre-filter activates only when callers explicitly opt in by providing text.
