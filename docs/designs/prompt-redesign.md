# Prompt and Workflow Definition Redesign

## 1. Problem Statement

The current prompt builder and workflow definition have four architectural problems:

**P1: File content inlined into CLI arguments.** `buildAgentCommand()` reads ALL artifact files recursively, concatenates their content, and passes the result as the `-p` message to `claude`. Binary files cause null byte crashes. Large codebases exceed `ARG_MAX` (~256KB on macOS). This is unnecessary because the artifact directory IS the agent's workspace (mounted at `/workspace` in Docker) -- the agent can read files directly.

**P2: Role prompts hardcoded in TypeScript.** `ROLE_PROMPTS` in `workflow-real-spike.ts` defines what each persona does. Different workflows need different prompts, but there is no way to express this without changing TypeScript code. The workflow definition JSON has no prompt field.

**P3: `systemPromptAugmentation` carries role instructions.** The spike injects role instructions via `--append-system-prompt`. With `claude --continue`, the system prompt from the first invocation is already baked into the conversation. Re-applying it on subsequent rounds is redundant. Worse, it couples the session factory to workflow-specific knowledge (the `ROLE_PROMPTS` map).

**P4: No inter-agent communication channel.** When different roles run in separate Docker sessions (planner -> architect, critic -> coder), the new agent has NO shared conversation history. It cannot see what the previous agent actually said. Artifact files on disk are necessary but insufficient -- the previous agent's reasoning, caveats, and explanations are lost.

## 2. New `AgentStateDefinition` Schema

### Type Definition

```typescript
export interface AgentStateDefinition {
  readonly type: 'agent';
  /**
   * Persona name. Used only for session identity (session-per-role
   * continuity via sessionsByRole). NOT used for prompt content --
   * all prompt content comes from the `prompt` field.
   */
  readonly persona: string;
  /**
   * Input artifact names. The prompt builder lists these as directory
   * paths the agent should read. Trailing `?` marks optional inputs.
   */
  readonly inputs: readonly string[];
  /** Output artifact names the agent is expected to produce. */
  readonly outputs: readonly string[];
  /**
   * Prompt template sent to the agent on FIRST invocation of this state.
   *
   * Contains the role's instructions, responsibilities, and output
   * expectations. The orchestrator appends standard context sections
   * (task, previous agent output, artifacts, status format) AFTER
   * this template.
   *
   * On re-invocation of the same state (round 2+ via --continue),
   * only the new information is sent (previous agent output, round
   * number, human feedback, status format). The role instructions
   * are already in the conversation history.
   *
   * The template is static text -- no variable substitution is
   * performed on it. All dynamic content is appended as structured
   * sections by the prompt builder.
   */
  readonly prompt: string;
  readonly transitions: readonly AgentTransitionDefinition[];
  readonly parallelKey?: string;
  readonly worktree?: boolean;
}
```

### Workflow Definition Extension

```typescript
export interface WorkflowDefinition {
  readonly name: string;
  readonly description: string;
  readonly initial: string;
  readonly states: Record<string, WorkflowStateDefinition>;
  readonly settings?: WorkflowSettings;
  /**
   * Optional system prompt text appended to the base system prompt
   * for ALL agent states in this workflow. Use for workspace
   * conventions, project-level context, or shared instructions that
   * apply regardless of role. Sent via --append-system-prompt.
   *
   * If absent, only the default IronCurtain system prompt is used.
   */
  readonly systemPrompt?: string;
}
```

### Key Design Decision: No Template Variables

The `prompt` field is static text with NO variable interpolation. The prompt builder appends dynamic context as structured sections AFTER the template. This is deliberately simpler than a templating approach because:

1. **No escaping hazards.** Template variables like `{{task}}` require escaping if the task description itself contains `{{`. Static concatenation has no escaping concerns.
2. **Consistent structure.** Every agent invocation gets the same context sections in the same order. The workflow author controls the role instructions; the orchestrator controls the context format. Neither can break the other.
3. **No combinatorial complexity.** With templates, you must decide which variables are available in which states, document them, validate them. With append-only sections, the prompt builder always appends the same set of sections (skipping empty ones).
4. **Easier debugging.** The assembled prompt is predictable and easy to inspect.

## 3. Context Tracking

The orchestrator needs three new fields to support inter-agent communication and prompt mode selection.

### New `WorkflowContext` Fields

```typescript
export interface WorkflowContext {
  // ... existing fields ...

  /**
   * Response text from the last completed agent state. Captured from
   * session.sendMessage() return value. Used to give the next agent
   * visibility into what the previous agent said.
   *
   * Reset to null when consumed by the next agent's prompt.
   */
  readonly previousAgentOutput: string | null;

  /**
   * The state name that produced `previousAgentOutput`. Used to label
   * the output in the next agent's prompt (e.g., "The planner produced
   * the following output:").
   */
  readonly previousStateName: string | null;

  /**
   * Per-state visit counter. Maps state ID to the number of times that
   * state has been entered. Used for:
   * - First-visit vs re-visit: `visitCounts[stateId] > 1` means re-visit
   * - Per-state round display: the coder's round is
   *   `visitCounts['implement']`, not the global `round`
   * - Round limit checking: `isRoundLimitReached` compares
   *   `visitCounts[currentStateId]` against `maxRounds`
   *
   * The global `round` field is retained for total budget tracking
   * (e.g., "the entire workflow has executed N agent steps") but is NOT
   * used for round display or limit checking.
   */
  readonly visitCounts: Readonly<Record<string, number>>;
}
```

### Orchestrator Tracking Logic

After each `sendMessage()` completes:

```typescript
// In executeAgentState(), after getting responseText:
// The machine-builder's updateContextFromAgentResult action stores these:
context = {
  ...context,
  previousAgentOutput: truncateAgentOutput(responseText),
  previousStateName: stateId,
  visitCounts: {
    ...context.visitCounts,
    [stateId]: (context.visitCounts[stateId] ?? 0) + 1,
  },
  // Human feedback is consumed by exactly one agent state -- the one
  // immediately after the gate. Clear it so subsequent states don't
  // see stale feedback.
  humanPrompt: null,
};
```

#### `previousAgentOutput` Truncation

The full response text from an agent (especially the coder) can be very large -- reasoning traces, tool call results, code snippets. Passing it via `-p` to `docker exec` risks the same `ARG_MAX` problem that P1 fixes for artifact content.

When storing `previousAgentOutput`, truncate at **32KB** (32,768 bytes). If the text exceeds the limit, truncate and append:

```
\n\n[Output truncated. Read the artifact directories for full details.]
```

This truncation happens in the context update logic (`updateContextFromAgentResult` action), NOT in the prompt builder. The prompt builder receives already-truncated text.

```typescript
const MAX_AGENT_OUTPUT_BYTES = 32_768;
const TRUNCATION_NOTICE =
  '\n\n[Output truncated. Read the artifact directories for full details.]';

function truncateAgentOutput(text: string): string {
  if (Buffer.byteLength(text, 'utf-8') <= MAX_AGENT_OUTPUT_BYTES) {
    return text;
  }
  // Truncate by characters, then verify byte length. This is a
  // conservative approach -- UTF-8 multi-byte chars mean we may
  // end up slightly under the limit, which is fine.
  const budget = MAX_AGENT_OUTPUT_BYTES - Buffer.byteLength(TRUNCATION_NOTICE, 'utf-8');
  let truncated = text;
  while (Buffer.byteLength(truncated, 'utf-8') > budget) {
    // Remove ~10% at a time for efficiency, then fine-tune
    truncated = truncated.slice(0, Math.floor(truncated.length * 0.9));
  }
  return truncated + TRUNCATION_NOTICE;
}
```

#### `humanPrompt` Clearing

`humanPrompt` is set when a human gate fires with `FORCE_REVISION` and feedback text. Previously it persisted in context until the next gate event, meaning an agent two states after a gate could still see stale human feedback.

Now `humanPrompt` is set to `null` in `updateContextFromAgentResult`. This means human feedback is consumed by **exactly one agent state** -- the one immediately after the gate. If the user wants feedback to persist longer, they can use `FORCE_REVISION` to re-enter the same state.

The `previousAgentOutput` is the raw response text from `session.sendMessage()`. It includes the agent's reasoning, explanations, and the `agent_status` block. The prompt builder includes it verbatim -- the receiving agent can parse or ignore the status block as it sees fit.

## 4. Prompt Assembly Algorithm

The prompt builder has TWO modes, selected by whether the current state has been visited before.

### 4a. First-Visit Prompt (Cross-State Transition)

Used when entering a state for the first time. The agent has no prior conversation context for this role.

```
function buildFirstVisitPrompt(stateConfig, context):
  sections = []

  // 1. Role instructions from the workflow definition
  sections.push(stateConfig.prompt)

  // 2. Task description
  sections.push("## Task\n\n" + context.taskDescription)

  // 3. Previous agent's output (if any)
  if context.previousAgentOutput:
    label = context.previousStateName ?? "previous agent"
    sections.push(
      "## Output from " + label + "\n\n" +
      "The " + label + " agent produced the following output:\n\n" +
      context.previousAgentOutput
    )

  // 4. Input artifacts as PATH REFERENCES (not content)
  for each input in stateConfig.inputs:
    name = stripOptionalSuffix(input)
    sections.push(
      "## Input: " + name + "\n\n" +
      "Read the contents of the `" + name + "/` directory " +
      "in your workspace using your file reading tools."
    )

  // 5. Expected outputs
  if stateConfig.outputs is non-empty:
    outputList = stateConfig.outputs.map(o => "- `" + o + "/`").join("\n")
    sections.push(
      "## Expected Outputs\n\n" +
      "Create the following artifact directories in your workspace:\n" +
      outputList
    )

  // 6. Human feedback (from FORCE_REVISION gate, if this is a first
  //    visit triggered by a gate revision -- e.g., plan_review -> plan
  //    when the planner has never run before is impossible, but
  //    design_review -> design when design was previously visited
  //    would use the re-visit path. This covers edge cases.)
  if context.humanPrompt:
    sections.push("## Human Feedback\n\n" + context.humanPrompt)

  // 7. Status block format (always last)
  sections.push(STATUS_BLOCK_INSTRUCTIONS)

  return sections.join("\n\n---\n\n")
```

### 4b. Re-Visit Prompt (Same-State Re-Invocation)

Used when a state is entered for the second (or later) time. The session is resumed via `--continue`, so the agent already has its role instructions and prior conversation history. The prompt only contains what's NEW.

```
function buildReVisitPrompt(stateId, stateConfig, context):
  sections = []

  // 1. What's new: previous agent's output
  if context.previousAgentOutput:
    label = context.previousStateName ?? "previous agent"
    sections.push(
      "## New Input from " + label + "\n\n" +
      "The " + label + " agent reviewed your work and " +
      "produced the following output:\n\n" +
      context.previousAgentOutput
    )

  // 2. Round number (per-state, not global)
  const stateRound = context.visitCounts[stateId] ?? 1
  sections.push(
    "## Round\n\n" +
    "This is round " + stateRound +
    " of " + context.maxRounds + "." +
    " Please address the feedback above and update your outputs."
  )

  // 3. Human feedback (from FORCE_REVISION gate)
  if context.humanPrompt:
    sections.push("## Human Feedback\n\n" + context.humanPrompt)

  // 4. Status block format (always last)
  sections.push(STATUS_BLOCK_INSTRUCTIONS)

  return sections.join("\n\n---\n\n")
```

### 4c. Dispatch Logic

```typescript
export function buildAgentCommand(
  stateId: string,
  stateConfig: AgentStateDefinition,
  context: WorkflowContext,
): string {
  const isReVisit = (context.visitCounts[stateId] ?? 0) > 1;
  if (isReVisit) {
    return buildReVisitPrompt(stateId, stateConfig, context);
  }
  return buildFirstVisitPrompt(stateConfig, context);
}
```

The `stateId` is passed through to `buildReVisitPrompt` so it can look up the per-state visit count for the round display.

### What Changed

| Before | After |
|--------|-------|
| Reads artifact files with `readFileSync` | No file I/O at all |
| Concatenates file content into command | Lists directory paths the agent should read |
| No role instructions (relies on `systemPromptAugmentation`) | Role instructions come from `stateConfig.prompt` (first visit only) |
| Single prompt format for all invocations | Two formats: first-visit (full) and re-visit (delta only) |
| No inter-agent communication | Previous agent's response text included in prompt |
| `reviewHistory` accumulated across rounds | Not needed; previous agent output + `--continue` history suffices |
| `artifactDir` parameter required | No longer needed |

## 5. Updated `workflow-real-demo.json`

The `prompt` fields contain role instructions and output expectations. They do NOT reference previous agent output or task descriptions -- the orchestrator handles those dynamically.

```json
{
  "name": "real-agent-workflow",
  "description": "Plan -> Design -> Implement -> Validate -> Review workflow using Docker agent sessions",
  "initial": "plan",
  "settings": {
    "mode": "docker",
    "dockerAgent": "claude-code",
    "maxRounds": 3
  },
  "systemPrompt": "When creating artifact directories, place them directly in your workspace root (e.g., `plan/`, `spec/`, `code/`). Do not nest them inside subdirectories.",
  "states": {
    "plan": {
      "type": "agent",
      "persona": "planner",
      "prompt": "You are a project planner. Break down the task into a clear, actionable plan.\n\nYour responsibilities:\n- Analyze the task requirements\n- Identify components, dependencies, and implementation order\n- Note key design decisions and trade-offs\n\nOutput: Create a `plan/` directory in your workspace with a `plan.md` file.\nWrite a structured markdown document with numbered steps.\nDo NOT write any code -- only the plan.",
      "inputs": [],
      "outputs": ["plan"],
      "transitions": [{ "to": "plan_review" }]
    },
    "plan_review": {
      "type": "human_gate",
      "acceptedEvents": ["APPROVE", "FORCE_REVISION", "ABORT"],
      "present": ["plan"],
      "transitions": [
        { "to": "design", "event": "APPROVE" },
        { "to": "plan", "event": "FORCE_REVISION" },
        { "to": "aborted", "event": "ABORT" }
      ]
    },
    "design": {
      "type": "agent",
      "persona": "architect",
      "prompt": "You are a software architect. Produce a technical design specification.\n\nYour responsibilities:\n- Define module structure, interfaces, and data flow\n- Specify function signatures with TypeScript types\n- Document key design decisions and rationale\n\nOutput: Create a `spec/` directory in your workspace with a `spec.md` file.\nWrite a structured markdown document with interface definitions and architecture notes.\nDo NOT write implementation code.\n\nYou have access to the plan created by the planner. Read the `plan/` directory for context.",
      "inputs": ["plan"],
      "outputs": ["spec"],
      "transitions": [{ "to": "design_review" }]
    },
    "design_review": {
      "type": "human_gate",
      "acceptedEvents": ["APPROVE", "FORCE_REVISION", "ABORT"],
      "present": ["spec"],
      "transitions": [
        { "to": "implement", "event": "APPROVE" },
        { "to": "design", "event": "FORCE_REVISION" },
        { "to": "aborted", "event": "ABORT" }
      ]
    },
    "implement": {
      "type": "agent",
      "persona": "coder",
      "prompt": "You are an implementation engineer. Write working code based on the plan and spec.\n\nYour responsibilities:\n- Implement all modules described in the spec\n- Write clean, well-typed TypeScript\n- Create unit tests using Node.js built-in assert module\n- Ensure all tests pass by running them\n\nOutput: Create a `code/` directory in your workspace containing all source files and tests.\nRun the tests to verify they pass before finishing.\n\nRead the `plan/` and `spec/` directories for context on what to build.",
      "inputs": ["plan", "spec"],
      "outputs": ["code"],
      "transitions": [{ "to": "review" }]
    },
    "review": {
      "type": "agent",
      "persona": "critic",
      "prompt": "You are a code reviewer. Review the implementation against the specification.\n\nYour responsibilities:\n- Verify correctness: does the code match the spec?\n- Check edge cases and error handling\n- Evaluate code quality, naming, and structure\n- Assess test coverage and test quality\n\nOutput: Create a `reviews/` directory with a `review.md` file.\nIf issues are found, set verdict to \"rejected\" with specific, actionable feedback.\nIf the code is solid, set verdict to \"approved\".\n\nRead the `code/` and `spec/` directories to perform your review.",
      "inputs": ["code", "spec"],
      "outputs": ["reviews"],
      "transitions": [
        { "to": "done", "guard": "isApproved" },
        { "to": "escalate_gate", "guard": "isRoundLimitReached" },
        { "to": "implement", "guard": "isRejected" }
      ]
    },
    "escalate_gate": {
      "type": "human_gate",
      "acceptedEvents": ["APPROVE", "FORCE_REVISION", "ABORT"],
      "present": ["code", "reviews"],
      "transitions": [
        { "to": "done", "event": "APPROVE" },
        { "to": "implement", "event": "FORCE_REVISION" },
        { "to": "aborted", "event": "ABORT" }
      ]
    },
    "done": {
      "type": "terminal",
      "outputs": ["code", "reviews"]
    },
    "aborted": {
      "type": "terminal"
    }
  }
}
```

## 6. Concrete Prompt Examples

### Example A: Planner (first state, no previous agent)

The planner is the initial state. There is no previous agent output. The assembled prompt:

```
You are a project planner. Break down the task into a clear, actionable plan.
[... role instructions from prompt field ...]

---

## Task

Build a CLI tool that converts CSV files to JSON, supporting streaming for large files.

---

## Expected Outputs

Create the following artifact directories in your workspace:
- `plan/`

---

[STATUS_BLOCK_INSTRUCTIONS]
```

### Example B: Architect (cross-state from planner)

The architect enters for the first time. The planner's response text is included:

```
You are a software architect. Produce a technical design specification.
[... role instructions from prompt field ...]

---

## Task

Build a CLI tool that converts CSV files to JSON, supporting streaming for large files.

---

## Output from plan

The plan agent produced the following output:

I've created a comprehensive plan for the CSV-to-JSON CLI tool. Here's my analysis:

The tool needs three main components: a streaming CSV parser, a JSON serializer,
and the CLI entry point. I've broken this down into 5 implementation steps...

[... full planner response text including reasoning and status block ...]

---

## Input: plan

Read the contents of the `plan/` directory in your workspace using your file reading tools.

---

## Expected Outputs

Create the following artifact directories in your workspace:
- `spec/`

---

[STATUS_BLOCK_INSTRUCTIONS]
```

### Example C: Coder round 2 (re-visit after critic rejection)

The coder ran in round 1, then the critic rejected. The coder's session is resumed via `--continue`. Only new information is sent.

Note: "round 2 of 3" here comes from `visitCounts['implement']` (which is 2), NOT from the global `round` counter (which would be 4 after planner + architect + coder + critic). This is the per-state visit count for the `implement` state specifically:

```
## New Input from review

The review agent reviewed your work and produced the following output:

I've reviewed the implementation against the spec. There are two issues:

1. The streaming parser doesn't handle quoted fields containing newlines (CSV RFC 4180 section 2.6).
2. The error handling in `cli.ts` swallows parse errors silently instead of reporting them.

I've written detailed feedback in `reviews/review.md`.

```agent_status
completed: true
verdict: rejected
confidence: high
notes: Two issues found - streaming parser and error handling
```

---

## Round

This is round 2 of 3. Please address the feedback above and update your outputs.

---

[STATUS_BLOCK_INSTRUCTIONS]
```

### Example D: Coder re-visit after human gate with feedback

The coder ran, the critic rejected, the escalate gate fired, and the human provided feedback via FORCE_REVISION:

```
## New Input from review

The review agent reviewed your work and produced the following output:

[... critic's response text ...]

---

## Round

This is round 2 of 3. Please address the feedback above and update your outputs.

---

## Human Feedback

Focus on the streaming parser issue first. The error handling can use a simple console.error for now.

---

[STATUS_BLOCK_INSTRUCTIONS]
```

## 7. New `prompt-builder.ts`

Complete replacement. No file I/O, no `readFileSync`, no `collectFilesRecursive`. Two prompt modes.

```typescript
import type { AgentStateDefinition, WorkflowContext } from './types.js';
import { STATUS_BLOCK_INSTRUCTIONS } from './status-parser.js';

/**
 * Assembles the command string sent to an agent session.
 *
 * Two modes:
 * - **First visit**: Full prompt with role instructions, task, previous
 *   agent output, artifact path references, expected outputs, and status
 *   format. Used when entering a state for the first time.
 * - **Re-visit**: Abbreviated prompt with only what's new: previous agent
 *   output, round number, human feedback, and status format. The agent
 *   already has role instructions and task context via --continue.
 *
 * No file I/O is performed. The agent reads artifact content itself
 * using its filesystem tools.
 */
export function buildAgentCommand(
  stateId: string,
  stateConfig: AgentStateDefinition,
  context: WorkflowContext,
): string {
  const isReVisit = (context.visitCounts[stateId] ?? 0) > 1;
  if (isReVisit) {
    return buildReVisitPrompt(stateId, context);
  }
  return buildFirstVisitPrompt(stateConfig, context);
}

/**
 * Full prompt for the first time an agent state is entered.
 * Includes role instructions, task, previous agent output, artifact
 * references, expected outputs, human feedback, and status format.
 */
function buildFirstVisitPrompt(
  stateConfig: AgentStateDefinition,
  context: WorkflowContext,
): string {
  const sections: string[] = [];

  // 1. Role instructions from workflow definition
  sections.push(stateConfig.prompt);

  // 2. Task description
  sections.push(`## Task\n\n${context.taskDescription}`);

  // 3. Previous agent's output
  if (context.previousAgentOutput && context.previousStateName) {
    sections.push(
      `## Output from ${context.previousStateName}\n\n` +
      `The ${context.previousStateName} agent produced the following output:\n\n` +
      context.previousAgentOutput
    );
  }

  // 4. Input artifacts as path references
  for (const inputRef of stateConfig.inputs) {
    const isOptional = inputRef.endsWith('?');
    const name = isOptional ? inputRef.slice(0, -1) : inputRef;
    sections.push(
      `## Input: ${name}\n\n` +
      `Read the contents of the \`${name}/\` directory ` +
      `in your workspace using your file reading tools.`
    );
  }

  // 5. Expected outputs
  if (stateConfig.outputs.length > 0) {
    const outputList = stateConfig.outputs
      .map((o) => `- \`${o}/\``)
      .join('\n');
    sections.push(
      `## Expected Outputs\n\nCreate the following artifact ` +
      `directories in your workspace:\n${outputList}`
    );
  }

  // 6. Human feedback from gate
  if (context.humanPrompt) {
    sections.push(`## Human Feedback\n\n${context.humanPrompt}`);
  }

  // 7. Status block instructions (always last)
  sections.push(STATUS_BLOCK_INSTRUCTIONS);

  return sections.join('\n\n---\n\n');
}

/**
 * Abbreviated prompt for re-entering a previously visited state.
 * The agent already has role instructions and task context in its
 * conversation history via --continue. Only new information is sent.
 */
function buildReVisitPrompt(
  stateId: string,
  context: WorkflowContext,
): string {
  const sections: string[] = [];

  // 1. What's new: previous agent's output
  if (context.previousAgentOutput && context.previousStateName) {
    sections.push(
      `## New Input from ${context.previousStateName}\n\n` +
      `The ${context.previousStateName} agent reviewed your work and ` +
      `produced the following output:\n\n` +
      context.previousAgentOutput
    );
  }

  // 2. Round number (per-state count, not global)
  const stateRound = context.visitCounts[stateId] ?? 1;
  sections.push(
    `## Round\n\nThis is round ${stateRound} ` +
    `of ${context.maxRounds}. ` +
    `Please address the feedback above and update your outputs.`
  );

  // 3. Human feedback from gate
  if (context.humanPrompt) {
    sections.push(`## Human Feedback\n\n${context.humanPrompt}`);
  }

  // 4. Status block instructions (always last)
  sections.push(STATUS_BLOCK_INSTRUCTIONS);

  return sections.join('\n\n---\n\n');
}

/**
 * Builds a re-prompt for missing artifacts. Uses relative paths only
 * (no host-absolute paths, since Docker agents see /workspace).
 */
export function buildArtifactReprompt(
  missing: readonly string[]
): string {
  const paths = missing.map((name) => `  - \`${name}/\``);
  return (
    'The following required output artifacts were not created ' +
    'in your workspace:\n' +
    paths.join('\n') +
    '\n\nPlease create them now. Each artifact should be a ' +
    'directory containing at least one file.\n\n' +
    STATUS_BLOCK_INSTRUCTIONS
  );
}
```

### What Was Removed

- `readArtifactContent()` -- deleted entirely
- `readFileSync` import -- no longer needed
- `resolve` import -- no longer needed
- `collectFilesRecursive` import -- no longer needed
- The `artifactDir` parameter on `buildAgentCommand()` -- no longer needed
- `formatReviewHistory()` -- no longer needed; `--continue` carries history, and inter-round feedback uses `previousAgentOutput`

### What Was Added

- `stateId` parameter on `buildAgentCommand()` -- needed to check `visitCounts`
- `buildFirstVisitPrompt()` -- full prompt with role instructions and all context
- `buildReVisitPrompt()` -- abbreviated prompt with only new information
- Previous agent output section in both prompt modes

## 8. Impact on Each File

### `src/workflow/types.ts`

**Changes:**
- Add `prompt: string` to `AgentStateDefinition`
- Add `systemPrompt?: string` to `WorkflowDefinition`
- Add `previousAgentOutput: string | null` to `WorkflowContext`
- Add `previousStateName: string | null` to `WorkflowContext`
- Add `visitCounts: Readonly<Record<string, number>>` to `WorkflowContext`
- `reviewHistory` field remains (used by existing guards/actions) but is no longer consumed by the prompt builder

**Magnitude:** Small. Field additions only, no removals.

**Note:** `previousAgentOutput` is truncated at 32KB by the `updateContextFromAgentResult` action (see section 3). `humanPrompt` is cleared to `null` by the same action after each agent completion.

### `src/workflow/validate.ts`

**Changes:**
- Add `prompt: z.string().min(1)` to `agentStateSchema`
- Add `systemPrompt: z.string().optional()` to `workflowDefinitionSchema`
- No new semantic validation needed (prompt is free-form text)

**Magnitude:** Small. Two schema field additions.

### `src/workflow/prompt-builder.ts`

**Changes:** Complete rewrite (simpler). See section 7 above.

**Removals:**
- `readArtifactContent()` function
- `formatReviewHistory()` function
- `readFileSync`, `resolve`, `collectFilesRecursive` imports
- `artifactDir` parameter from `buildAgentCommand()`

**Additions:**
- `stateId` parameter on `buildAgentCommand()`
- `buildFirstVisitPrompt()` -- full prompt for first visit
- `buildReVisitPrompt()` -- abbreviated prompt for re-visit
- Previous agent output section

**Net:** The file gets shorter. No file I/O. Two focused internal functions instead of one monolithic one.

### `src/workflow/orchestrator.ts`

**Changes:**

1. `buildAgentCommand()` call gains `stateId`, drops `artifactDir`:
   ```typescript
   // Before:
   const command = buildAgentCommand(stateConfig, context, instance.artifactDir);
   // After:
   const command = buildAgentCommand(stateId, stateConfig, context);
   ```

2. After `sendMessage()`, capture response text for context update. The `AgentInvokeResult` already flows back to the XState machine, so we add `responseText` to it:
   ```typescript
   // In AgentInvokeResult (machine-builder.ts):
   export interface AgentInvokeResult {
     // ... existing fields ...
     readonly responseText: string;
   }

   // In executeAgentState():
   return {
     output: agentOutput,
     sessionId: session.getInfo().id,
     artifacts,
     outputHash,
     responseText,  // <-- NEW: raw response from sendMessage()
   };
   ```

3. The `updateContextFromAgentResult` action in `machine-builder.ts` stores the new context fields:
   ```typescript
   // In the assign action:
   previousAgentOutput: (_, event) =>
     truncateAgentOutput(event.output.responseText),
   previousStateName: (_, event) => stateId,  // from the invoke input
   visitCounts: (ctx) => ({
     ...ctx.visitCounts,
     [stateId]: (ctx.visitCounts[stateId] ?? 0) + 1,
   }),
   humanPrompt: () => null,  // consumed by one agent state only
   ```

4. The `systemPrompt` from the workflow definition is passed to the session factory:
   ```typescript
   const session = await this.deps.createSession({
     persona: stateConfig.persona,
     mode,
     resumeSessionId: previousSessionId,
     workspacePath: instance.artifactDir,
     systemPromptAugmentation: definition.systemPrompt,
   });
   ```

5. Initial context in `buildWorkflowMachine` adds default values for new fields:
   ```typescript
   previousAgentOutput: null,
   previousStateName: null,
   visitCounts: {},
   ```

**Magnitude:** Medium. The core change is threading `responseText` through the invoke result and storing it in context. The prompt builder call site is a one-line change.

### `src/workflow/machine-builder.ts`

**Changes:**
- Add `responseText: string` to `AgentInvokeResult`
- Add `previousAgentOutput`, `previousStateName`, `visitCounts` to initial context
- Update `updateContextFromAgentResult` action to store the new fields, truncate `previousAgentOutput` at 32KB, clear `humanPrompt`
- Add `truncateAgentOutput()` helper (can be a module-private function in `machine-builder.ts`)

**Magnitude:** Small-medium. Three new context field assignments in the action, one new result field, one truncation helper.

### `examples/workflow-real-demo.json`

**Changes:** Add `prompt` field to each agent state. Add optional top-level `systemPrompt` field. See section 5 for the full updated file.

**Magnitude:** Medium. Each agent state grows by one field containing the role instructions that were previously in `ROLE_PROMPTS`.

### `examples/workflow-real-spike.ts`

**Changes:**
1. Delete the entire `ROLE_PROMPTS` map (~40 lines)
2. Simplify the session factory -- it no longer maps persona to role prompt:

   ```typescript
   // Before:
   const rolePrompt = persona ? ROLE_PROMPTS[persona] : undefined;
   const systemPromptAugmentation = [rolePrompt, opts.systemPromptAugmentation]
     .filter(Boolean).join('\n\n');
   const effectiveOpts: SessionOptions = {
     ...opts,
     config: haiku,
     persona: undefined,
     systemPromptAugmentation: systemPromptAugmentation || undefined,
   };

   // After:
   const effectiveOpts: SessionOptions = {
     ...opts,
     config: haiku,
     persona: undefined,
     // systemPromptAugmentation is passed through from the orchestrator,
     // which reads it from the workflow definition's systemPrompt field.
   };
   ```

**Magnitude:** Medium. Net deletion of ~50 lines.

### `src/workflow/guards.ts`

**Changes:**

The `isRoundLimitReached` guard currently uses the global `context.round` counter:

```typescript
// Current (incorrect for per-state semantics):
const isRoundLimitReached: GuardFunction = ({ context }) => {
  return context.round >= context.maxRounds;
};
```

This must be updated to use per-state visit counts. The guard needs access to the current state ID, which is available via the XState event (the `AGENT_COMPLETED` event carries the `stateId` that just completed):

```typescript
// Updated:
const isRoundLimitReached: GuardFunction = ({ context, event }) => {
  if (event.type !== 'AGENT_COMPLETED') return false;
  const stateId = event.stateId; // Added to AGENT_COMPLETED event type
  return (context.visitCounts[stateId] ?? 0) >= context.maxRounds;
};
```

However, `isRoundLimitReached` fires on the *critic's* completion (the `review` state's transition), not the *coder's* completion. The question is: should it check the critic's visit count or the coder's? The intent is "has the coder had enough rounds?" -- so it should check the coder's (the target state, `implement`). Two options:

**Option A (simpler):** Check the target state's visit count. Since the guard fires on the `review` -> `implement` transition, look up `visitCounts['implement']`. This requires the guard to know the target state name, which it can infer from the transition definition. The machine builder can supply this as guard metadata.

**Option B (pragmatic):** In the typical workflow, the coder and critic alternate -- so `visitCounts['review']` is a close proxy for `visitCounts['implement']`. Check the current state's (reviewer's) visit count. This is slightly imprecise but simpler.

**Recommendation:** Option A. The machine builder already has access to the transition's `to` field when wiring guards. It should pass the target state ID as guard context. This is a one-line change in the machine builder.

**Magnitude:** Small. One guard function updated, one event type field added.

### `src/workflow/artifacts.ts`

**No changes.** `collectFilesRecursive()` and `hasAnyFiles()` are still used by the orchestrator for artifact verification (`findMissingArtifacts()`) and hash computation (`computeOutputHash()`). The prompt builder no longer imports them, but the orchestrator still does.

## 9. Data Flow Summary

```
                    +-----------+
                    |  Workflow  |
                    | Definition|
                    | (JSON)    |
                    +-----+-----+
                          |
                          | prompt field (static role instructions)
                          v
+----------+     +----------------+     +-------------+
| Previous |---->| Prompt Builder |---->| Agent       |
| Agent    |     | (no file I/O)  |     | Session     |
| Output   |     +----------------+     +------+------+
| (string) |           ^                       |
+----------+           |                       | responseText
                       |                       v
              +--------+--------+     +--------+--------+
              | WorkflowContext |<----| Orchestrator    |
              | .previousAgent  |     | (stores output  |
              |  Output         |     |  in context)    |
              | .previousState  |     +-----------------+
              |  Name           |
              | .visitCounts  |
              +-----------------+
```

**Cross-state flow** (planner -> architect):
1. Planner runs, produces `responseText`
2. Orchestrator stores truncated `responseText` in `context.previousAgentOutput`, `"plan"` in `context.previousStateName`, increments `visitCounts['plan']` to 1, clears `humanPrompt`
3. Architect session created (new session, no `--continue`)
4. `buildFirstVisitPrompt()` includes role instructions + task + planner's output + artifact paths

**Same-state re-visit** (coder round 1 -> critic -> coder round 2):
1. Coder round 1 runs, `visitCounts['implement']` set to 1
2. Critic runs, stores its truncated `responseText` in context, `"review"` in `previousStateName`, clears `humanPrompt`
3. Coder round 2: `visitCounts['implement']` is 1 (> 0), so session is resumed via `--continue`; visit count incremented to 2
4. `buildReVisitPrompt()` includes only critic's output + round number

## 10. Migration Notes

### Backward Compatibility

The `prompt` field is **required** on `AgentStateDefinition`. Existing workflow JSON files that lack `prompt` will fail Zod validation with a clear error. This is intentional -- there are no production workflow definitions yet (only the spike's `workflow-real-demo.json`), so a breaking schema change is acceptable.

### `systemPromptAugmentation` Disposition

`systemPromptAugmentation` on `SessionOptions` is NOT removed. It remains available for non-workflow use cases (cron jobs, personas, interactive sessions). For workflows specifically:

- The workflow definition's optional `systemPrompt` field maps to `SessionOptions.systemPromptAugmentation` when the orchestrator creates a session.
- Role-specific instructions move OUT of `systemPromptAugmentation` and INTO the per-invocation command (via the `prompt` field in the workflow definition).
- This is the correct split: `--append-system-prompt` carries persistent context (workspace conventions, environment description); `-p` carries per-invocation instructions (role, task, artifacts, previous agent output).

### `--continue` Behavior

With `claude --continue`, the system prompt from the first invocation persists. The per-invocation `-p` message changes each round. This redesign aligns with that model:

- System prompt (via `--append-system-prompt`): Set once from `definition.systemPrompt`. Stable across rounds.
- Command (via `-p`): Changes each round. On first visit: full context. On re-visit: only what's new.

### `reviewHistory` Disposition

The `reviewHistory` field on `WorkflowContext` is NOT removed. It may still be useful for guards (e.g., checking how many review rounds have occurred) or for audit logging. However, the prompt builder no longer reads it. Inter-round feedback is now carried by `previousAgentOutput` -- the critic's full response text, not a summary extracted from it.

### Migration Steps

1. **Add context fields** (`types.ts`) -- `previousAgentOutput`, `previousStateName`, `visitCounts` with null/empty defaults.
2. **Add schema fields** (`types.ts`, `validate.ts`) -- `prompt` on agent states, `systemPrompt` on definition.
3. **Rewrite prompt builder** (`prompt-builder.ts`) -- two-mode dispatch, no file I/O, add `stateId` parameter.
4. **Update machine builder** (`machine-builder.ts`) -- `responseText` on `AgentInvokeResult`, store new context fields in action.
5. **Update orchestrator** (`orchestrator.ts`) -- pass `stateId` to prompt builder, capture `responseText`, pass `systemPrompt` to session factory.
6. **Update workflow JSON** (`workflow-real-demo.json`) -- add `prompt` to each agent state, add optional `systemPrompt`.
7. **Simplify spike** (`workflow-real-spike.ts`) -- delete `ROLE_PROMPTS`, simplify session factory.

Steps 1-5 form a single coherent PR. Steps 6-7 can be the same PR or a follow-up.

### Testing

The existing `prompt-builder.test.ts` needs updates:

- Remove test fixtures that set up artifact directories with file content
- Add tests for first-visit mode: verify `stateConfig.prompt` appears as first section, `previousAgentOutput` included when present, artifact path references (not content) appear
- Add tests for re-visit mode: verify role instructions are NOT included, `previousAgentOutput` labeled with state name, round info present, human feedback included when present
- Add tests for dispatch: `visitCounts[stateId] > 1` triggers re-visit mode
- Verify `buildAgentCommand()` performs no file I/O (can mock `fs` and assert no calls)
- Verify `buildArtifactReprompt()` is unchanged

The orchestrator tests need:
- Verify `responseText` is captured, truncated at 32KB, and stored in context after `sendMessage()`
- Verify `visitCounts` is incremented for the correct state after each agent execution
- Verify `previousStateName` matches the state that just ran
- Verify `humanPrompt` is cleared to `null` after each agent execution
- Verify `systemPromptAugmentation` is passed from the definition

The guards tests need:
- Verify `isRoundLimitReached` checks `visitCounts[targetStateId]`, not global `round`
- Verify the guard returns `false` when `visitCounts` for the target state is below `maxRounds`
- Verify the guard returns `true` when `visitCounts` for the target state meets or exceeds `maxRounds`
