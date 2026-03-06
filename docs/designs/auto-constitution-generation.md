# Auto-Constitution Generation for Cron Jobs

## Overview

This feature auto-generates a task constitution from a cron job's task description by running an LLM through Code Mode with a **read-only policy**. The LLM can explore MCP servers (list files, read repos, check git status, fetch URLs) to gather context, then produces a draft constitution. After generation, the user enters an optional interactive edit session (reusing the existing `constitution-customizer.ts` patterns) to refine the draft. The edit session is available both during `add-job` and via `edit-job`.

The key architectural insight is that we already have all the pieces -- Code Mode sandbox, MCP proxy with policy enforcement, and the constitution customizer -- we just need to compose them with a read-only policy and a new LLM prompt.

## 1. Architecture Overview

```
                          add-job CLI
                              |
                    [task description entered]
                              |
                  +-----------v-----------+
                  | Constitution Generator |  (new module)
                  | - LLM with execute_code|
                  +-----------+-----------+
                              |
                    Code Mode Sandbox (V8)
                              |
                    MCP Proxy Server
                    (read-only policy)
                              |
              +-------+-------+-------+
              |       |       |       |
           filesystem  git   github  fetch
           (read-only) (read) (read) (read)
                              |
                  [LLM returns draft constitution]
                              |
                  +-----------v-----------+
                  | Interactive Customizer |  (existing, adapted)
                  | - accept/refine/reject |
                  +-----------+-----------+
                              |
                  [final constitution saved]
                              |
                  +-----------v-----------+
                  | compileTaskPolicy()   |  (existing)
                  +-----------+-----------+
```

The constitution generator runs a full Code Mode session with a restricted policy that allows only read/list/search operations. This is the same infrastructure the regular agent uses, just with a different policy and system prompt. The policy engine enforces read-only access as defense-in-depth -- even if the LLM attempts a write operation, the policy engine will deny or escalate it.

## 2. Read-Only Policy

### 2.1 Design Decision: Constitution-Compiled Read-Only Policy

The read-only policy is derived from a **read-only constitution** (`src/config/constitution-readonly.md`) that is compiled into policy rules using `compile-policy` with custom CLI flags. This approach:

1. Uses the same compilation pipeline as every other policy -- no special-case hand-authored JSON.
2. The constitution is human-readable and auditable -- it IS the documentation.
3. Compilation happens at build/dev time, not at runtime. The compiled artifact ships with the package.
4. The same CLI extension (`--constitution`, `--output-dir`) is useful for users who want custom policies.

### 2.2 File Layout

```
src/config/
  constitution-readonly.md          # Read-only constitution (source of truth)
  generated-readonly/
    compiled-policy.json            # Compiled from constitution-readonly.md
    tool-annotations.json -> ../generated/tool-annotations.json  # Symlink or copy
```

The read-only policy lives in the package source tree under `src/config/generated-readonly/`. It ships in `dist/config/generated-readonly/` after build. There is no user-local copy -- the read-only policy is immutable.

### 2.3 Read-Only Constitution

The constitution at `src/config/constitution-readonly.md` expresses the read-only policy in natural language:

```markdown
# Read-Only Constitution

## Guiding Principles

1. **Read-only exploration**: The agent may only observe and query -- never modify, create, or delete.
2. **Broad read access**: Reading files, listing directories, and querying metadata is permitted anywhere.
3. **Network read access**: Fetching URLs and querying remote APIs (GitHub, git remotes) is permitted for reading.
4. **No mutations**: Any operation that creates, modifies, or deletes data must be escalated for human approval.

## Concrete Guidance

 - The agent is allowed to read files and list directories anywhere on the filesystem
 - The agent is allowed to search file contents
 - The agent is allowed to read git log, status, diff, and branch information
 - The agent is allowed to fetch URLs for reading web content
 - The agent is allowed to list and read GitHub issues, pull requests, and repository metadata
 - The agent must ask for approval before any write, create, delete, or push operation
 - The agent must ask for approval before modifying git state (commit, checkout, merge, rebase)
```

This constitution is compiled into `compiled-policy.json` by running:

```bash
ironcurtain compile-policy --constitution src/config/constitution-readonly.md --output-dir src/config/generated-readonly
```

The compiled output follows the standard `CompiledPolicyFile` format. The default-deny fallthrough handles anything not explicitly allowed. Write/delete operations escalate (rather than silently deny) so the LLM gets a clear signal about what is not permitted, which may inform what it includes in the constitution.

### 2.4 Tool Annotations

The read-only policy reuses the same `tool-annotations.json` from the global generated directory. The `PolicyEngine` already supports loading annotations and policy from different directories, and `SessionOptions.policyDir` controls where compiled policy is loaded from while annotations always come from the global location.

### 2.5 Extending compile-policy CLI

The `compile-policy` command gains two new CLI flags:

- `--constitution <path>` -- path to an alternative constitution file (instead of the default `src/config/constitution.md`)
- `--output-dir <path>` -- directory to write compiled artifacts (instead of the default user generated dir)

These flags are wired through to the existing `loadPipelineConfig()` and `PipelineRunner.run()` which already accept `constitutionInput` and `outputDir` as parameters. The change is purely CLI argument parsing in `compile.ts`:

```typescript
// In compile.ts main()
function parseCompilePolicyArgs(): { constitution?: string; outputDir?: string } {
  const args = process.argv.slice(2);
  const result: { constitution?: string; outputDir?: string } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--constitution' && args[i + 1]) {
      result.constitution = resolve(args[++i]);
    } else if (args[i] === '--output-dir' && args[i + 1]) {
      result.outputDir = resolve(args[++i]);
    }
  }
  return result;
}
```

When `--constitution` is provided, `loadPipelineConfig()` uses that path instead of the default. When `--output-dir` is provided, it overrides the `generatedDir` in the returned config.

This extension is used both for:
1. Compiling the read-only constitution at build/dev time.
2. Future user workflows where custom constitutions are compiled to custom output directories.

## 3. Constitution Generation Flow

### 3.1 Step-by-Step Flow During add-job

```
1. User enters task description in add-job wizard
2. User enters optional git repo URI
3. (Git repo cloned if specified)
4. CLI offers: "Generate constitution from task description? [Y/n]"
   - If no: fall through to manual editor (existing behavior)
   - If yes: continue to step 5
5. Start constitution generation:
   a. Create a temporary Code Mode session with read-only policy
   b. LLM explores MCP servers using execute_code
   c. LLM returns structured constitution text
   d. Session is closed (resources released)
6. Display generated constitution to user
7. Offer interactive customizer session (optional):
   - "Looks good" -> accept as-is
   - "Refine" -> enter interactive customizer loop
   - "Start over" -> back to manual editor
8. Final constitution saved to job.taskConstitution
9. compileTaskPolicy() compiles it into policy rules
10. Job saved
```

### 3.2 New Module: `src/cron/constitution-generator.ts`

This is the core new module. It orchestrates a Code Mode session with the read-only policy to generate a draft constitution.

```typescript
/**
 * Constitution Generator -- uses an LLM with Code Mode access to
 * MCP servers (under read-only policy) to generate a draft task
 * constitution from a task description.
 */

import type { LanguageModel } from 'ai';

/** Result of constitution generation. */
export interface ConstitutionGenerationResult {
  /** The generated constitution text. */
  readonly constitution: string;
  /** Summary of what the LLM discovered and why it chose these rules. */
  readonly reasoning: string;
  /** Tools/servers the LLM explored during generation. */
  readonly exploredServers: readonly string[];
}

/** Options for constitution generation. */
export interface ConstitutionGeneratorOptions {
  /** The task description to generate a constitution for. */
  readonly taskDescription: string;
  /** Path to the job workspace (for filesystem exploration). */
  readonly workspacePath: string;
  /** Optional git repo URI (included in context for the LLM). */
  readonly gitRepo?: string;
  /** Progress callback for spinner updates. */
  readonly onProgress?: (message: string) => void;
}

/**
 * Generates a draft constitution by running an LLM through Code Mode
 * with a read-only policy. The LLM can explore MCP servers to
 * understand the task context before writing policy.
 *
 * @returns The generated constitution and reasoning.
 */
export async function generateConstitution(
  options: ConstitutionGeneratorOptions,
): Promise<ConstitutionGenerationResult>;
```

### 3.3 Implementation Strategy: Code Mode Session with Read-Only Policy

The constitution generator creates a full Code Mode session -- the same infrastructure the regular agent uses -- with the read-only compiled policy. This means the LLM's exploration goes through:

1. **V8 sandbox** (UTCP Code Mode) -- the LLM writes TypeScript that calls tool stubs
2. **MCP proxy server** -- tool calls exit the sandbox and reach the proxy
3. **Policy engine** -- every tool call is evaluated against the read-only compiled policy

This provides **defense-in-depth**: even if the LLM attempts a write operation via `execute_code`, the policy engine will escalate it (and since there is no interactive user during generation, escalation effectively means denial).

The implementation:

1. Create a session via `createSession()` with:
   - `policyDir` pointing to `src/config/generated-readonly/` (the read-only compiled policy)
   - `workspacePath` pointing to the job workspace (for filesystem exploration)
   - `disableAutoApprove: true` (no auto-approver during exploration)
   - A constitution-generation system prompt (see Section 4)
2. Send a single message with the task description and structured output instructions
3. Parse the LLM's response for the constitution text
4. Close the session (releases sandbox, proxy, MCP connections)

```typescript
async function generateConstitution(
  options: ConstitutionGeneratorOptions,
): Promise<ConstitutionGenerationResult> {
  const readOnlyPolicyDir = getReadOnlyPolicyDir(); // resolves to generated-readonly/

  const session = await createSession({
    policyDir: readOnlyPolicyDir,
    workspacePath: options.workspacePath,
    disableAutoApprove: true,
    systemPromptExtra: buildConstitutionGeneratorSystemPrompt(
      options.taskDescription,
      options.workspacePath,
      options.gitRepo,
    ),
  });

  try {
    const response = await session.sendMessage(
      buildConstitutionGenerationUserMessage(options.taskDescription),
    );
    return parseConstitutionResponse(response);
  } finally {
    await session.close();
  }
}
```

**Key design decision**: Using Code Mode rather than direct tool bridging means the policy engine enforces read-only access as a security invariant, not just an annotation-based filter. The LLM cannot bypass the policy by crafting tool calls -- every call goes through the same evaluation path as production tool calls. This is the same defense-in-depth principle used throughout IronCurtain.

### 3.4 Read-Only Policy Dir Resolution

The read-only policy directory is resolved at runtime to the package-bundled `generated-readonly/` directory:

```typescript
/**
 * Returns the path to the read-only policy directory.
 * This is always the package-bundled version -- not user-local.
 */
export function getReadOnlyPolicyDir(): string {
  return resolve(__dirname, '..', 'config', 'generated-readonly');
}
```

This is added to `src/config/paths.ts` alongside the existing path helpers.

## 4. Prompt Design

### 4.1 System Prompt for Constitution Generator

The constitution-generation system prompt is injected via `SessionOptions.systemPromptExtra`, which appends to the standard Code Mode system prompt. This means the LLM gets both the standard `execute_code` instructions AND the constitution-specific instructions.

```typescript
export function buildConstitutionGeneratorSystemPrompt(
  taskDescription: string,
  workspacePath: string,
  gitRepo?: string,
): string;
```

The prompt instructs the LLM to:

```
You are generating a security policy (constitution) for an automated scheduled job.
The policy describes what the agent IS and IS NOT permitted to do when executing
the task. You have read-only access to MCP servers to explore the task's context.

## Task Description

${taskDescription}

## Workspace

The job workspace is: ${workspacePath}
${gitRepo ? `Git repository: ${gitRepo}` : 'No git repository configured.'}

## Your Process

1. **Explore**: Use execute_code to call MCP tools and understand the task context:
   - List files in the workspace to understand the project structure
   - Read key files (README, package.json, config files) to understand the project
   - Check git status/log to understand the development workflow
   - List GitHub issues/PRs if the task involves GitHub
   - Fetch any relevant URLs if the task involves web resources

2. **Analyze**: Based on what you discovered, determine:
   - Which tools does this task require?
   - Which paths/directories need read access? Write access?
   - Which domains need to be accessible?
   - Which GitHub operations are needed (read-only? create issues? push code?)
   - What should require human approval vs. be automatic?

3. **Generate**: Write a constitution that follows these principles:
   - Be specific: name concrete tools, paths, domains, and operations
   - Apply least privilege: only grant what the task explicitly needs
   - Use "allow" for safe, routine operations the task clearly requires
   - Use "require approval" for consequential operations (deletes, pushes, etc.)
   - Use natural language that the policy compiler can translate to rules
   - Reference categories for groups (e.g., "popular news sites") not individual items

## Output Format

When you have finished exploring and are ready to generate the constitution,
output a JSON block with:
- "constitution": The constitution text (multi-line string, one rule per line,
   each prefixed with " - ")
- "reasoning": Brief explanation of what you discovered and why you chose these rules
- "exploredServers": Array of server names you queried during exploration

## Example Constitution

 - The agent is allowed to read and write files in the workspace
 - The agent is allowed to read files in ~/src/myproject (read-only)
 - The agent is allowed to perform local git operations (commit, branch, status)
 - The agent must ask for approval before pushing to git remotes
 - The agent may fetch web content from api.github.com
 - The agent may list and read GitHub issues and pull requests
 - The agent must ask for approval before creating or closing GitHub issues
```

### 4.2 Structured Output Parsing

Since the LLM generates its response through Code Mode (multi-turn with `execute_code`), the final response is a free-form text. The constitution is extracted by parsing the JSON block from the LLM's final message:

```typescript
function parseConstitutionResponse(response: string): ConstitutionGenerationResult {
  // Extract JSON block from the response (```json ... ``` or raw JSON)
  const jsonMatch = response.match(/```json\s*([\s\S]*?)```/) ?? response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('LLM did not produce a valid constitution response');
  }
  const parsed = JSON.parse(jsonMatch[1] ?? jsonMatch[0]);
  return {
    constitution: parsed.constitution,
    reasoning: parsed.reasoning ?? '',
    exploredServers: parsed.exploredServers ?? [],
  };
}
```

## 5. Interactive Edit Integration

### 5.1 Reuse from Existing Customizer

The following are reused directly from `constitution-customizer.ts`:

- `CustomizerResponseSchema` -- the changes/question discriminated union
- `applyChanges()` -- merges LLM-proposed changes into constitution text
- `computeLineDiff()` / `formatDiff()` -- visual diff display
- `buildSystemPrompt()` -- system prompt for the customizer LLM (with modifications)
- `buildUserMessage()` -- user message formatting
- `formatAnnotationsForPrompt()` -- tool annotation formatting

### 5.2 New: Job-Scoped Customizer Session

The existing customizer operates on the global `constitution-user.md`. For cron jobs, we need a variant that operates on a job's `taskConstitution` string without touching any files until the user confirms.

```typescript
/**
 * Runs an interactive constitution customizer session for a job.
 * Operates on an in-memory constitution string (not the global file).
 *
 * @param initialConstitution - Starting constitution text (from generator or existing job)
 * @param taskDescription - The task description (context for the LLM)
 * @returns The final constitution text, or undefined if the user cancelled
 */
export async function runJobConstitutionCustomizer(
  initialConstitution: string,
  taskDescription: string,
): Promise<string | undefined>;
```

This function:
1. Loads tool annotations (same as existing customizer)
2. Discovers GitHub identity (same as existing customizer)
3. Builds a system prompt that includes the task description as additional context
4. Runs the accept/refine/reject loop (same UI pattern as existing customizer)
5. Returns the final constitution text (no file I/O -- the caller saves it)

### 5.3 Customizer System Prompt Adaptation

The job customizer's system prompt extends the existing `buildSystemPrompt()` with task context:

```typescript
export function buildJobCustomizerSystemPrompt(
  baseConstitution: string,
  toolAnnotations: ToolAnnotation[],
  taskDescription: string,
  githubIdentity?: GitHubIdentity | null,
): string;
```

This adds a `## Task Context` section:

```
## Task Context

This constitution is for a scheduled job with the following task:

${taskDescription}

Focus your suggestions on what THIS SPECIFIC TASK needs. Do not suggest
broad permissions unless the task requires them.
```

## 6. Job Command Integration

### 6.1 Changes to `runJobReviewLoop()` in `job-commands.ts`

Add two new menu options in the review loop -- one for auto-generation and one for interactive customization:

```typescript
{
  value: 'generateConstitution',
  label: `Generate constitution from task${descIsEmpty ? '  (set task first)' : ''}`,
},
{
  value: 'customizeConstitution',
  label: `Customize constitution interactively${hasConstitution ? '' : '  (set constitution first)'}`,
},
```

The **generate** action creates a draft from scratch using Code Mode exploration:

```typescript
case 'generateConstitution': {
  if (descIsEmpty) {
    log.warn('Set the task description first.');
    break;
  }
  const spinner = p.spinner();
  spinner.start('Generating constitution...');
  try {
    const result = await generateConstitution({
      taskDescription: job.taskDescription,
      workspacePath: getJobWorkspaceDir(job.id),
      gitRepo: job.gitRepo,
      onProgress: (msg) => { spinner.message = msg; },
    });
    spinner.stop('Constitution generated.');
    log.info(result.reasoning);

    // Offer refinement
    const action = await select({
      message: 'What would you like to do with the generated constitution?',
      options: [
        { value: 'accept', label: 'Accept as-is' },
        { value: 'refine', label: 'Refine interactively' },
        { value: 'discard', label: 'Discard and write manually' },
      ],
    });

    if (action === 'accept') {
      job = { ...job, taskConstitution: result.constitution };
    } else if (action === 'refine') {
      const refined = await runJobConstitutionCustomizer(
        result.constitution,
        job.taskDescription,
      );
      if (refined) {
        job = { ...job, taskConstitution: refined };
      }
    }
    // 'discard' falls through without changing job
  } catch (err) {
    spinner.stop('Generation failed.');
    log.error(`Constitution generation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  break;
}
```

The **customize** action launches the interactive LLM-assisted customizer on the existing constitution -- whether it was auto-generated, hand-written, or previously customized:

```typescript
case 'customizeConstitution': {
  if (!job.taskConstitution) {
    log.warn('Set or generate a constitution first.');
    break;
  }
  const refined = await runJobConstitutionCustomizer(
    job.taskConstitution,
    job.taskDescription,
  );
  if (refined) {
    job = { ...job, taskConstitution: refined };
  }
  break;
}
```

This makes the interactive customizer a **first-class action** independent of how the constitution was created. Users who hand-write a constitution can still get LLM-assisted refinement suggestions without going through auto-generation first.

### 6.2 Changes to add-job Flow

After the task description is entered and before entering the review loop, offer auto-generation:

```typescript
// In runAddJobWizard(), after the user has set taskDescription
if (job.taskDescription && !job.taskConstitution) {
  const shouldGenerate = await confirm({
    message: 'Generate constitution automatically from the task description?',
    initialValue: true,
  });
  if (shouldGenerate) {
    // Run generation and optional refinement
    // (same flow as the generateConstitution action above)
  }
}
```

### 6.3 Edit-Job: Same Review Loop

The `edit-job` command reuses the same `runJobReviewLoop()`, so all three actions -- manual edit (`taskConstitution`), auto-generate (`generateConstitution`), and interactive customize (`customizeConstitution`) -- are available for existing jobs as well. No separate edit-job logic is needed.

## 7. Key Interfaces and Module Boundaries

### 7.1 New Files

| File | Responsibility |
|------|---------------|
| `src/cron/constitution-generator.ts` | Core generation logic: create Code Mode session with read-only policy, run LLM, parse result |
| `src/cron/job-customizer.ts` | `runJobConstitutionCustomizer()` -- interactive edit session adapted for jobs |
| `src/config/constitution-readonly.md` | Read-only constitution in natural language (source of truth for read-only policy) |
| `src/config/generated-readonly/compiled-policy.json` | Compiled from constitution-readonly.md via `compile-policy` |

### 7.2 Modified Files

| File | Changes |
|------|---------|
| `src/cron/job-commands.ts` | Add generate/refine menu options in review loop |
| `src/pipeline/compile.ts` | Add `--constitution` and `--output-dir` CLI argument parsing |
| `src/pipeline/pipeline-shared.ts` | `loadPipelineConfig()` accepts overrides from CLI args |
| `src/config/paths.ts` | Add `getReadOnlyPolicyDir()` helper |
| `src/pipeline/constitution-customizer.ts` | Extract `buildJobCustomizerSystemPrompt()`, export `callLlm()` |

### 7.3 New Types

```typescript
// In src/cron/constitution-generator.ts

export interface ConstitutionGenerationResult {
  readonly constitution: string;
  readonly reasoning: string;
  readonly exploredServers: readonly string[];
}

export interface ConstitutionGeneratorOptions {
  readonly taskDescription: string;
  readonly workspacePath: string;
  readonly gitRepo?: string;
  readonly onProgress?: (message: string) => void;
}
```

### 7.4 Dependency Graph

```
job-commands.ts
  ├── constitution-generator.ts  (NEW)
  │     ├── session/index.ts     (existing -- createSession with policyDir)
  │     └── config/paths.ts      (existing -- getReadOnlyPolicyDir)
  ├── job-customizer.ts          (NEW)
  │     ├── constitution-customizer.ts  (existing -- schema, applyChanges, diff, callLlm)
  │     └── pipeline-shared.ts   (existing -- createPipelineLlm)
  └── compile-task-policy.ts     (existing -- final compilation)

compile.ts (MODIFIED)
  └── pipeline-shared.ts         (existing -- loadPipelineConfig with CLI overrides)
```

The constitution generator depends on `createSession()` from the session module, which handles all the Code Mode setup (sandbox, proxy, policy engine). It does NOT directly depend on MCP connection utilities, tool annotations, or the policy engine -- those are encapsulated by the session.

## 8. Error Handling

### 8.1 MCP Servers Unavailable

If MCP servers fail to connect during the Code Mode session:
- **Graceful degradation**: The session will still function -- the LLM simply won't be able to call tools from unavailable servers. It generates a constitution based on the task description alone.
- **Warning to user**: "Could not connect to X MCP server(s). The generated constitution may be less specific."
- The generation does not fail -- it produces a best-effort draft.

### 8.2 LLM Fails or Returns Invalid Output

- **Retry once** with a repair prompt asking the LLM to produce valid JSON output.
- If still invalid, fall back to a **template constitution** derived from the task description using heuristics:
  - If task mentions "git": include git read rules
  - If task mentions "GitHub": include GitHub read rules
  - If task mentions "file" or "code": include filesystem read/write in workspace
  - Always include: workspace read/write, require approval for everything else

### 8.3 Tool Annotations Missing

If `tool-annotations.json` does not exist:
- The Code Mode session will still work but the policy engine will have limited annotation data.
- Constitution generation proceeds with reduced context.
- Warn: "Run 'ironcurtain annotate-tools' first for better constitution generation."

### 8.4 Generation Timeout

The Code Mode session is bounded by `ResourceBudgetTracker` limits (step count, wall-clock time). If the LLM exhausts its budget without producing a final answer, we take whatever partial exploration it did and ask it to produce the constitution in a follow-up call without tools (a direct `generateText()` call with the exploration context summarized).

### 8.5 Interactive Customizer Errors

LLM errors during the interactive customizer loop are handled the same as the existing customizer: the error is displayed, the failed user message is removed from history, and the user can retry.

## 9. File Layout Summary

```
src/
  config/
    constitution-readonly.md                    # Read-only constitution (source of truth)
    generated-readonly/
      compiled-policy.json                      # Compiled from constitution-readonly.md
    paths.ts                                    # MODIFIED: add getReadOnlyPolicyDir()
  cron/
    constitution-generator.ts                   # NEW: Code Mode session -> draft constitution
    job-customizer.ts                           # NEW: Interactive refinement for job constitutions
    job-commands.ts                             # MODIFIED: integrate generation + customizer
    compile-task-policy.ts                      # UNCHANGED: compiles final constitution
  pipeline/
    compile.ts                                  # MODIFIED: --constitution and --output-dir CLI flags
    pipeline-shared.ts                          # MODIFIED: loadPipelineConfig accepts CLI overrides
    constitution-customizer.ts                  # MODIFIED: export callLlm, add buildJobCustomizerSystemPrompt
    mcp-connections.ts                          # UNCHANGED
```

## 10. Testing Strategy

### 10.1 Unit Tests

**`constitution-generator.test.ts`**:
- `buildConstitutionGeneratorSystemPrompt()` includes task description, workspace, git repo
- `parseConstitutionResponse()` handles valid JSON, JSON in code fences, malformed JSON, missing fields
- Graceful fallback when LLM response cannot be parsed

**`job-customizer.test.ts`**:
- `buildJobCustomizerSystemPrompt()` includes task context section
- `runJobConstitutionCustomizer()` with mock LLM returns refined constitution

**`compile.test.ts`** (new or extended):
- `parseCompilePolicyArgs()` correctly parses `--constitution` and `--output-dir` flags
- `--constitution` overrides the default constitution path
- `--output-dir` overrides the default generated dir
- Missing argument values produce clear errors

### 10.2 Integration Tests

- End-to-end generation with a real filesystem MCP server (read-only operations only)
- Verify that the read-only policy engine denies/escalates write operations during the Code Mode session
- Verify that the generated constitution can be successfully compiled by `compileTaskPolicy()`
- Compile the read-only constitution with `--constitution` and `--output-dir` and verify the output

### 10.3 Dependency Substitution

- `generateConstitution()` accepts an optional `model` parameter for test injection
- The session is created via `createSession()` which supports `config` override for testing
- The interactive customizer uses `@clack/prompts` which requires TTY -- integration tests use the non-interactive `generateConstitution()` path only

## 11. Migration Plan

### Phase 1: compile-policy CLI Extension + Read-Only Constitution

- Add `--constitution` and `--output-dir` flag parsing to `compile.ts`
- Wire flags through `loadPipelineConfig()` overrides
- Write `src/config/constitution-readonly.md`
- Run `ironcurtain compile-policy --constitution src/config/constitution-readonly.md --output-dir src/config/generated-readonly` to produce the compiled policy
- Add `generated-readonly/` to build copy step
- Add `getReadOnlyPolicyDir()` to `src/config/paths.ts`
- Unit tests for CLI argument parsing

### Phase 2: Constitution Generator Module

- Implement `src/cron/constitution-generator.ts`
- Create Code Mode session with read-only `policyDir` and `disableAutoApprove`
- Add system prompt construction and response parsing
- Unit tests for prompt construction and response parsing
- Integration test verifying read-only enforcement during generation

### Phase 3: Job Customizer

- Implement `src/cron/job-customizer.ts`
- Extract/export helpers from `constitution-customizer.ts`
- Unit tests for the customizer session

### Phase 4: CLI Integration

- Modify `job-commands.ts` review loop
- Add auto-generation prompt to `add-job`
- Add customizer option to `edit-job`
- Manual testing of the interactive flows

Each phase is independently shippable and testable.
