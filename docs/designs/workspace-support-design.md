# Workspace Support for Workflows

## Overview

This design adds a `--workspace` flag to the workflow CLI and unifies how the orchestrator handles workspace directories. There is a single workspace model: the workspace is always a directory — either freshly created by the orchestrator or provided by the user via `--workspace`. Workflow artifacts (plans, specs, reviews) live under `.workflow/` inside the workspace. Code lives at the workspace root.

## Workspace Model

```
{workspace}/                          # The workspace root (fresh or existing repo)
  .workflow/                          # Workflow artifacts (gitignored)
    plan/plan.md                      # Planner output
    spec/spec.md                      # Architect output
    reviews/review.md                 # Critic output
    messages.jsonl                    # Message log (WARNING: agent-writable)
  .gitignore                          # Updated with .workflow/ entry
  src/                                # Code written by coder (or existing repo files)
  package.json
  ...

{baseDir}/{workflowId}/              # Orchestrator internals (outside workspace)
  checkpoint.json                     # XState checkpoint for resume
  definition.json                     # Copy of workflow definition
```

When no `--workspace` is provided, the orchestrator creates an empty directory at `{baseDir}/{workflowId}/workspace/`. When `--workspace` is provided, the orchestrator uses that path directly. Either way, the agent sees the same layout — a workspace root with `.workflow/` for structured artifacts.

## Artifact vs Code Output

Two kinds of agent output exist, distinguished by declaration:

### Workflow artifacts (declared in `outputs`)

Declared in a state's `outputs` array. The orchestrator creates and verifies these under `.workflow/{name}/`.

```json
{ "outputs": ["plan"] }
```

The orchestrator verifies `.workflow/plan/` contains at least one file. The agent is told to write to `.workflow/plan/`. The orchestrator hashes `.workflow/plan/` for stall detection.

### Code output (not declared)

Not declared in `outputs`. The agent writes files at the workspace root — `src/`, `package.json`, `tests/`, whatever. The orchestrator detects changes by hashing file metadata in the workspace root, excluding known directories.

A state can produce both: `outputs: ["reviews"]` declares a workflow artifact, while the agent might also modify code at the workspace root. A state with `outputs: []` produces only code output.

## Stall Detection

Stall detection uses a combined hash of workflow artifacts AND workspace root file metadata.

### Excluded directories

The following directories are excluded from workspace root hashing:

```typescript
const WORKSPACE_HASH_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  '.git',
  '.workflow',
  'node_modules',
  '__pycache__',
  '.next',
  'dist',
  'build',
  '.cache',
  '.venv',
  'venv',
]);
```

### Hash computation

`computeOutputHash` changes behavior based on whether `outputs` is empty:

- **Non-empty `outputs`**: Hash `.workflow/{name}/` for each declared output (current behavior, with `.workflow/` prefix).
- **Empty `outputs`**: Hash the workspace root file listing (paths + mtimes), excluding `WORKSPACE_HASH_EXCLUDED_DIRS`. This detects code-only changes without reading file contents.
- **Combined**: When `outputs` is non-empty, the declared artifact hash is sufficient — the orchestrator already verifies artifacts exist. Workspace-root hashing is only needed when `outputs` is empty and no artifacts provide a signal.

The `computeOutputHash` signature gains a `workspacePath` parameter:

```typescript
export function computeOutputHash(
  outputNames: readonly string[],
  artifactDir: string,
  workspacePath: string,
): string
```

When `outputNames` is empty, it hashes the workspace root file listing instead of producing an empty hash.

## Workspace Root Hashing (File Listing + mtime)

For code-only states, stall detection hashes file metadata — NOT file contents. This keeps hashing fast even on large repos.

The algorithm:

1. Walk the workspace root recursively, excluding directories in `WORKSPACE_HASH_EXCLUDED_DIRS`.
2. For each file, collect `relativePath + ':' + mtime.getTime()` (relative to workspace root).
3. Sort the collected entries lexicographically.
4. SHA-256 hash the concatenated sorted entries.

This produces a consistent hash that changes when any file is added, removed, or modified — without reading file contents.

```typescript
function hashWorkspaceRoot(hash: Hash, workspacePath: string): void {
  const entries: string[] = [];
  collectFileEntries(workspacePath, '', entries);
  entries.sort();
  for (const entry of entries) {
    hash.update(entry);
  }
}

function collectFileEntries(
  basePath: string,
  relativeTo: string,
  out: string[],
): void {
  const dirents = readdirSync(resolve(basePath, relativeTo), {
    withFileTypes: true,
  });
  for (const dirent of dirents) {
    const relPath = relativeTo ? `${relativeTo}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) {
      if (WORKSPACE_HASH_EXCLUDED_DIRS.has(dirent.name)) continue;
      collectFileEntries(basePath, relPath, out);
    } else if (dirent.isFile()) {
      const fullPath = resolve(basePath, relPath);
      const mtime = statSync(fullPath).mtimeMs;
      out.push(`${relPath}:${mtime}`);
    }
  }
}
```

The full `computeOutputHash` function:

```typescript
export function computeOutputHash(
  outputNames: readonly string[],
  artifactDir: string,
  workspacePath: string,
): string {
  const hash = createHash('sha256');

  if (outputNames.length > 0) {
    // Hash declared workflow artifacts
    for (const output of outputNames) {
      const dir = resolve(artifactDir, output);
      const files = collectFilesRecursive(dir);
      for (const file of files) {
        hash.update(file.relativePath);
        hash.update(readFileSync(file.fullPath));
      }
    }
  } else {
    // Hash workspace root file listing for code-only states
    hashWorkspaceRoot(hash, workspacePath);
  }

  return hash.digest('hex');
}
```

## .gitignore Management

When the orchestrator creates the `.workflow/` directory, it ensures `.workflow/` is listed in the workspace root's `.gitignore`. This always happens — there is no opt-out.

```typescript
function ensureWorkflowGitignored(workspacePath: string): void {
  const gitignorePath = resolve(workspacePath, '.gitignore');

  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf-8');
    const lines = content.split('\n');
    const alreadyListed = lines.some(
      (line) => line.trim() === '.workflow/' || line.trim() === '.workflow',
    );
    if (!alreadyListed) {
      const suffix = content.endsWith('\n') ? '' : '\n';
      appendFileSync(gitignorePath, `${suffix}.workflow/\n`);
    }
  } else {
    writeFileSync(gitignorePath, '.workflow/\n');
  }
}
```

This is called in `start()` immediately after creating the `.workflow/` directory. We read `.gitignore` anyway for exclusion purposes, so maintaining it is low-cost.

## Message Log

The message log lives at `{workspace}/.workflow/messages.jsonl`, alongside other workflow artifacts. This keeps all workflow-visible artifacts together in a single directory tree.

```typescript
// WARNING: messages.jsonl is inside the agent's workspace mount and is writable
// by the agent. This is acceptable for diagnostic purposes but the log should
// not be used for security-critical decisions.
const messageLogPath = resolve(artifactDir, 'messages.jsonl');
```

## Definition File Copy

During `start()`, the orchestrator copies the workflow definition JSON to `{baseDir}/{workflowId}/definition.json`. On `resume()`, the definition is read from this copy instead of the original path. This makes resume portable even if the original definition file is moved or deleted.

```typescript
// In start():
const definitionContent = readFileSync(definitionPath, 'utf-8');
const definition = JSON.parse(definitionContent);
writeFileSync(
  resolve(baseDir, workflowId, 'definition.json'),
  JSON.stringify(definition, null, 2),
);

// In resume():
const definition = JSON.parse(
  readFileSync(resolve(baseDir, workflowId, 'definition.json'), 'utf-8'),
);
```

## Orchestrator Changes

### `WorkflowInstance` gains `workspacePath`

```typescript
interface WorkflowInstance {
  // ... existing fields ...

  /**
   * Root directory where the agent session operates.
   * Either a fresh directory created by the orchestrator
   * or a user-provided path via --workspace.
   */
  readonly workspacePath: string;
}
```

The existing `artifactDir` field is repurposed to always point at `{workspacePath}/.workflow/`. This preserves all existing artifact I/O code (`findMissingArtifacts`, `computeOutputHash`, `collectArtifactPaths`, gate `present` paths).

### `start()` signature

```typescript
start(
  definitionPath: string,
  taskDescription: string,
  workspacePath?: string,
): Promise<WorkflowId>
```

Behavior:

1. If `workspacePath` is provided, validate it exists and is a directory (caller responsibility — CLI validates before calling). Use it directly.
2. If `workspacePath` is not provided, create `{baseDir}/{workflowId}/workspace/`.
3. In both cases:
   - Set `instance.workspacePath` to the resolved workspace path.
   - Set `instance.artifactDir` to `{workspacePath}/.workflow/`.
   - Create `.workflow/` and `.workflow/task/` directories.
   - Write `task/description.md` to `.workflow/task/`.
   - Call `ensureWorkflowGitignored(workspacePath)` to add `.workflow/` to `.gitignore`.
   - Copy definition JSON to `{baseDir}/{workflowId}/definition.json`.
   - Create metadata directory at `{baseDir}/{workflowId}/` for checkpoints.
   - Message log is written to `{workspacePath}/.workflow/messages.jsonl`.

### Session creation

The one-line change:

```typescript
// Before:
workspacePath: instance.artifactDir,

// After:
workspacePath: instance.workspacePath,
```

This gives the agent the workspace root as its working directory, not the `.workflow/` subdirectory.

### `findMissingArtifacts` — no change needed

Already works correctly: checks `{artifactDir}/{output}/` which resolves to `.workflow/{output}/`. The `artifactDir` reassignment handles the prefix.

### `computeOutputHash` — workspace fallback

When `outputs` is empty, hash the workspace root file listing instead of producing an empty hash. See the [Workspace Root Hashing](#workspace-root-hashing-file-listing--mtime) section for full implementation.

### Checkpoint changes

```typescript
interface WorkflowCheckpoint {
  // ... existing fields ...
  readonly workspacePath?: string;
}
```

On `resume`:
- If `checkpoint.workspacePath` is set, use it.
- Reconstruct `artifactDir` from the checkpoint: `resolve(checkpoint.workspacePath, '.workflow')`. Do NOT use `resolve(baseDir, workflowId, 'artifacts')`.
- Otherwise, fall back to `{baseDir}/{workflowId}/workspace/` (backward compat with any existing checkpoints that used `artifacts/`; can also check for `artifacts/` existence as a fallback).
- Read the workflow definition from `{baseDir}/{workflowId}/definition.json` instead of the original path.

```typescript
// In resume():
const workspacePath =
  checkpoint.workspacePath ?? resolve(baseDir, workflowId, 'workspace');
const artifactDir = resolve(workspacePath, '.workflow');
```

## Prompt Builder Changes

The `.workflow/` prefix is hardcoded. No mode flag, no `artifactPrefix` parameter.

### Input artifact references

```typescript
// Before:
`Read the contents of the \`${name}/\` directory in your workspace...`

// After:
`Read the contents of the \`.workflow/${name}/\` directory in your workspace...`
```

### Output artifact references

```typescript
// Before:
const outputList = stateConfig.outputs.map((o) => `- \`${o}/\``).join('\n');
sections.push(`## Expected Outputs\n\nCreate the following artifact directories in your workspace:\n${outputList}`);

// After:
const outputList = stateConfig.outputs.map((o) => `- \`.workflow/${o}/\``).join('\n');
sections.push(`## Expected Outputs\n\nCreate the following artifact directories in your workspace:\n${outputList}`);
```

### Artifact re-prompt

```typescript
// Before:
const paths = missing.map((name) => `  - \`${name}/\``);

// After:
const paths = missing.map((name) => `  - \`.workflow/${name}/\``);
```

### No code output instructions

When `outputs` is empty, the prompt builder does not add an "Expected Outputs" section. The agent's role prompt handles telling it where to write code (the workspace root). No change needed — the empty-array check already skips the section.

## Workflow Definition

A single workflow definition works for both fresh tasks and existing repos. The only difference is whether `--workspace` is provided at the CLI.

### Example: `workflow-real-demo.json`

```json
{
  "name": "real-agent-workflow",
  "description": "Plan -> Design -> Implement -> Review workflow",
  "initial": "plan",
  "settings": {
    "mode": "docker",
    "dockerAgent": "claude-code",
    "maxRounds": 3,
    "systemPrompt": "Workflow artifacts (plan, spec, reviews) go in `.workflow/`. Code goes directly at the workspace root."
  },
  "states": {
    "plan": {
      "type": "agent",
      "persona": "planner",
      "prompt": "You are a project planner.\n\nYour responsibilities:\n- Analyze the task requirements\n- If there is existing code in the workspace, read it to understand the current architecture\n- Identify components, dependencies, and implementation order\n- Note key design decisions and trade-offs\n\nOutput: Create a `.workflow/plan/` directory with a `plan.md` file.\nWrite a structured markdown document with numbered steps.\nDo NOT write any code -- only the plan.",
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
      "prompt": "You are a software architect. Produce a technical design specification.\n\nYour responsibilities:\n- Define module structure, interfaces, and data flow\n- Specify function signatures with TypeScript types\n- Document key design decisions and rationale\n- If there is existing code, design around it\n\nOutput: Create a `.workflow/spec/` directory with a `spec.md` file.\nDo NOT write implementation code.",
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
      "prompt": "You are an implementation engineer.\n\nYour responsibilities:\n- Implement all modules described in the spec\n- Write clean, well-typed TypeScript\n- Create unit tests\n- Run the tests to verify they pass\n\nWrite code directly at the workspace root (e.g., `src/`, `package.json`, `tests/`).\nDo NOT create a separate output directory for code.\nRun all tests to verify everything works.",
      "inputs": ["plan", "spec"],
      "outputs": [],
      "transitions": [{ "to": "review" }]
    },
    "review": {
      "type": "agent",
      "persona": "critic",
      "prompt": "You are a code reviewer.\n\nYour responsibilities:\n- Verify correctness: does the code at the workspace root match the spec?\n- Check edge cases and error handling\n- Evaluate code quality, naming, and structure\n- Assess test coverage and test quality\n\nOutput: Create a `.workflow/reviews/` directory with a `review.md` file.\nIf issues are found, set verdict to \"rejected\" with specific, actionable feedback.\nIf the code is solid, set verdict to \"approved\".",
      "inputs": ["spec"],
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
      "present": ["reviews"],
      "transitions": [
        { "to": "done", "event": "APPROVE" },
        { "to": "implement", "event": "FORCE_REVISION" },
        { "to": "aborted", "event": "ABORT" }
      ]
    },
    "done": {
      "type": "terminal",
      "outputs": ["reviews"]
    },
    "aborted": {
      "type": "terminal"
    }
  }
}
```

Key points:
- The planner and architect say "if there is existing code" — works for both fresh and existing workspaces.
- The coder has `outputs: []` — writes code at the workspace root, not under `.workflow/`.
- The reviewer reads code from the workspace root, writes reviews to `.workflow/reviews/`.
- The terminal `done` state lists `reviews` (not `code`) since code is at the workspace root.

## CLI Integration

```bash
# Fresh workspace (orchestrator creates an empty directory)
ironcurtain workflow start workflow.json "build a palindrome checker"

# Existing repo (user provides the path)
ironcurtain workflow start workflow.json "refactor auth module" --workspace ~/src/myproject
```

### Argument parsing

Add `workspace` to the CLI options:

```typescript
options: {
  model: { type: 'string' },
  workspace: { type: 'string' },
}
```

### Validation (in CLI layer, before calling orchestrator)

```typescript
if (workspaceArg) {
  const resolved = resolve(workspaceArg);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${resolved}`);
  }
  workspacePath = resolved;
}
```

### Resume

The workspace path is persisted in the checkpoint. On `resume`, the orchestrator reads it from the checkpoint automatically. No `--workspace` flag needed on resume.

## File Impact List

| File | Change |
|---|---|
| `src/workflow/types.ts` | Add `workspacePath?: string` to `WorkflowCheckpoint` |
| `src/workflow/orchestrator.ts` | Add `workspacePath: string` to `WorkflowInstance`. `start()` gains optional `workspacePath` param; creates workspace at `{baseDir}/{id}/workspace/` when not provided. `artifactDir` always set to `{workspacePath}/.workflow/`. Session creation uses `instance.workspacePath`. `computeOutputHash` gains `workspacePath` param and workspace-root hashing fallback (file listing + mtime, no content reads) for empty `outputs`. Add `WORKSPACE_HASH_EXCLUDED_DIRS` set, `collectFileEntries`, and `hashWorkspaceRoot` helpers. Checkpoint saves `workspacePath`. `resume()` restores `workspacePath` from checkpoint and reconstructs `artifactDir` as `resolve(workspacePath, '.workflow')`. Copy definition to `{baseDir}/{workflowId}/definition.json` in `start()`; read from there in `resume()`. Add `ensureWorkflowGitignored()` helper, called in `start()`. Message log written to `{workspacePath}/.workflow/messages.jsonl` with agent-writable warning comment. |
| `src/workflow/prompt-builder.ts` | All input path references get `.workflow/` prefix. All output path references get `.workflow/` prefix. Artifact re-prompt paths get `.workflow/` prefix. Remove `artifactPrefix` parameter (not needed — prefix is always `.workflow/`). |
| `src/workflow/validate.ts` | No changes needed (`outputs: []` already valid) |
| `examples/workflow-real-demo.json` | Update to unified model: coder gets `outputs: []`, prompts reference `.workflow/` for artifacts and workspace root for code, `systemPrompt` updated, terminal `done` drops `code` from outputs |
| `docs/designs/workflow-cli-design.md` | Add `--workspace` flag to help spec, examples, and argument table |
| `examples/workflow-real-spike.ts` | Parse `--workspace` flag, pass to `orchestrator.start()` |

Files explicitly NOT changed:
- `src/workflow/machine-builder.ts` — state machine logic is workspace-agnostic
- `src/workflow/guards.ts` — guard predicates are workspace-agnostic
- `src/workflow/status-parser.ts` — agent output parsing is workspace-agnostic
- `src/workflow/checkpoint.ts` — `FileCheckpointStore` serializes whatever `WorkflowCheckpoint` contains
- `src/workflow/artifacts.ts` — `collectFilesRecursive` and `hasAnyFiles` work on any directory path
- `src/workflow/transition.ts` — transition logic is workspace-agnostic

## Implementation Steps

### Step 1: Types and checkpoint

- Add `workspacePath?: string` to `WorkflowCheckpoint` in `types.ts`.
- Existing checkpoints without `workspacePath` fall back to `{baseDir}/{id}/workspace/` on resume.

### Step 2: Orchestrator workspace routing

- Add `workspacePath: string` to `WorkflowInstance`.
- Modify `start()` to accept optional `workspacePath`.
- When not provided: create `{baseDir}/{id}/workspace/`.
- When provided: use directly.
- Always: set `artifactDir = resolve(workspacePath, '.workflow')`, create `.workflow/task/`, write task description.
- Call `ensureWorkflowGitignored(workspacePath)` after creating `.workflow/`.
- Copy definition JSON to `{baseDir}/{workflowId}/definition.json`.
- Write message log to `{workspacePath}/.workflow/messages.jsonl` with agent-writable warning comment.
- Update `saveCheckpoint()` to persist `workspacePath`.
- Update `resume()` to restore `workspacePath` from checkpoint and reconstruct `artifactDir` as `resolve(checkpoint.workspacePath, '.workflow')`. Read definition from `{baseDir}/{workflowId}/definition.json`.
- Add `WORKSPACE_HASH_EXCLUDED_DIRS`, `collectFileEntries`, `hashWorkspaceRoot`, and update `computeOutputHash` to accept `workspacePath` and hash workspace root file listing (paths + mtimes) when `outputs` is empty.

### Step 3: Prompt builder updates

- Add `.workflow/` prefix to all input, output, and re-prompt path references.
- No new parameters needed.

### Step 4: Workflow definition update

- Update `examples/workflow-real-demo.json` to unified model.
- Coder state: `outputs: []`, prompt says "write code at the workspace root".
- All artifact references use `.workflow/` prefix.

### Step 5: CLI integration

- Add `--workspace` flag parsing and validation.
- Pass workspace path to `orchestrator.start()`.
- Update CLI design doc.

Steps 1-3 form a cohesive PR. Step 4 can be bundled with it or separate. Step 5 depends on the CLI command existing.
