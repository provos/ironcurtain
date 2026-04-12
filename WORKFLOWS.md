# Workflows

IronCurtain workflows orchestrate multiple AI agents through a state machine to plan, design, implement, and review code autonomously. Each agent runs in its own Docker container with IronCurtain's policy engine mediating tool access.

## Quick start

```bash
# Run the built-in design-and-code workflow on a new project
ironcurtain workflow start src/workflow/workflows/design-and-code.json \
  "Build a TypeScript CLI that converts CSV files to JSON"

# Run it on an existing codebase
ironcurtain workflow start src/workflow/workflows/design-and-code.json \
  "Add rate limiting to the API endpoints" \
  --workspace ~/src/my-api

# Use a cheaper model for experimentation
ironcurtain workflow start src/workflow/workflows/design-and-code.json \
  "Build a palindrome checker" \
  --model anthropic:claude-haiku-4-5
```

## Prerequisites

- Docker running with the `ironcurtain-claude-code:latest` image built
- `ANTHROPIC_API_KEY` in environment or `~/.ironcurtain/config.json`
- Global compiled policy (`npm run compile-policy`)

## How workflows work

A workflow is a JSON file that defines a state machine. Each state is one of:

- **`agent`** -- Runs an AI agent with a role-specific prompt. The agent can read/write files, run commands, and use all available MCP tools. The policy engine controls what's allowed.
- **`human_gate`** -- Pauses execution and asks for your input: approve, request revision, or abort.
- **`deterministic`** -- Runs shell commands (typecheck, lint, test) without an LLM.
- **`terminal`** -- End state (success or aborted).

### Sessions and workspace

Each agent state gets its own Docker session (container). All sessions share the same workspace directory — files written by one agent are visible to the next. The orchestrator passes the previous agent's response text to the next agent so it has context about what was done.

Within a state that runs multiple rounds (e.g., the coder running again after critic rejection), the session is resumed via `claude --continue`. The agent retains its full conversation history from prior rounds, so it knows what it already did and what feedback it received. A new container is created for each round, but the conversation state is persisted on disk and mounted into the new container.

Different states always get separate sessions — the planner, architect, coder, and critic each have their own conversation history and cannot see each other's internal reasoning. They communicate only through the shared workspace and the response text passed by the orchestrator.

## The design-and-code workflow

The built-in `design-and-code.json` workflow follows this flow:

```
plan --> [plan_review] --> design --> [design_review] --> implement --> review
  ^          |               ^            |                  ^          |
  |          |               |            |                  |          |
  +-- revision               +-- revision                   +-- rejected
                                                             |
                                                        [escalate_gate] --> done
```

States in brackets `[...]` are human gates where you review and approve.

**Agents:**

| Role      | What it does                     | Reads                        | Writes                        |
| --------- | -------------------------------- | ---------------------------- | ----------------------------- |
| Planner   | Breaks down the task into steps  | Workspace (if existing code) | `.workflow/plan/plan.md`      |
| Architect | Produces a technical design spec | Plan, workspace              | `.workflow/spec/spec.md`      |
| Coder     | Implements the design            | Plan, spec                   | Code at workspace root        |
| Critic    | Reviews code against the spec    | Spec, code                   | `.workflow/reviews/review.md` |

The coder and critic loop until the critic approves or the round limit is reached (default: 3 rounds). If the limit is reached, you're asked to intervene.

## Workspace layout

```
your-workspace/                  # Workspace root (new or existing repo)
  .workflow/                     # Workflow artifacts (gitignored automatically)
    plan/plan.md                 # Planner output
    spec/spec.md                 # Architect output
    reviews/review.md            # Critic output
    messages.jsonl               # Full message log
  src/                           # Code written by the coder
  package.json                   # (or whatever the project needs)
  ...
```

When you provide `--workspace`, the agents work in your existing directory. Workflow artifacts go into `.workflow/` which is automatically added to `.gitignore`. Code changes happen at the workspace root alongside your existing files.

When you don't provide `--workspace`, the orchestrator creates a fresh directory.

## CLI commands

### `ironcurtain workflow list`

List available workflow definitions (bundled and user-defined).

```bash
ironcurtain workflow list
```

### `ironcurtain workflow start`

Start a new workflow. The first argument can be a workflow name (looked up from bundled and user directories) or a path to a definition JSON file.

```bash
ironcurtain workflow start <name-or-path> "task description" [options]
```

Options:

- `--model <model>` -- Override the model (e.g., `anthropic:claude-haiku-4-5`)
- `--workspace <path>` -- Use an existing directory instead of creating a new one

Examples:

```bash
ironcurtain workflow start design-and-code "Build a REST API"
ironcurtain workflow start ./my-workflow.json "Build a REST API"
ironcurtain workflow start design-and-code "task" --model anthropic:claude-haiku-4-5
```

### `ironcurtain workflow resume`

Resume a failed or interrupted workflow from its last checkpoint.

```bash
ironcurtain workflow resume <baseDir> [options]
```

Options:

- `--state <stateName>` -- Resume from a specific state (synthesizes a checkpoint if none exists)
- `--model <model>` -- Override the model for the resumed run

### `ironcurtain workflow inspect`

View the status of a workflow without running it.

```bash
ironcurtain workflow inspect <baseDir> [--all]
```

Shows: workflow ID, current state, artifacts, and the last 20 message log entries. Use `--all` for the full log.

## Human gates

When a workflow reaches a human gate, you're prompted to choose:

- **Approve (`a`)** -- Continue to the next state
- **Force Revision (`f`)** -- Send the workflow back with feedback (you'll be asked to type your feedback)
- **Replan (`r`)** -- Go back to the planning stage
- **Abort (`x`)** -- Stop the workflow

Your feedback text is included in the next agent's prompt.

## Creating custom workflows

A workflow definition is a JSON file with this structure:

```json
{
  "name": "my-workflow",
  "description": "What this workflow does",
  "initial": "first_state",
  "settings": {
    "mode": "docker",
    "dockerAgent": "claude-code",
    "maxRounds": 3,
    "systemPrompt": "Optional persistent context for all agents"
  },
  "states": {
    "first_state": { ... },
    "second_state": { ... },
    "done": { "type": "terminal" }
  }
}
```

### Agent states

```json
{
  "type": "agent",
  "persona": "role-name",
  "prompt": "You are a ... Your responsibilities: ...",
  "inputs": ["plan", "spec"],
  "outputs": ["reviews"],
  "transitions": [
    { "to": "next_state", "when": { "verdict": "approved" } },
    { "to": "retry_state", "when": { "verdict": "rejected" } },
    { "to": "escalate", "guard": "isRoundLimitReached" }
  ]
}
```

- **`persona`** -- Either `"global"` (use the default global policy) or the name of an IronCurtain persona created via `ironcurtain persona create <name>`. When set to a real persona name, the agent session uses that persona's compiled policy, memory database, and system prompt augmentation. The orchestrator validates that all non-`"global"` personas exist before starting the workflow.
- **`prompt`** -- Role instructions sent to the agent. Tell it what to do, where to read inputs, and where to write outputs. Use `.workflow/` prefix for artifact directories.
- **`inputs`** -- Artifact directories the agent should read (under `.workflow/`)
- **`outputs`** -- Artifact directories the agent must create (under `.workflow/`). Use `[]` for code-only states where the agent writes to the workspace root.
- **`transitions`** -- Where to go next, using `when` for declarative conditions or `guard` for complex checks

### Human gate states

```json
{
  "type": "human_gate",
  "acceptedEvents": ["APPROVE", "FORCE_REVISION", "ABORT"],
  "present": ["plan"],
  "transitions": [
    { "to": "next", "event": "APPROVE" },
    { "to": "revise", "event": "FORCE_REVISION" },
    { "to": "aborted", "event": "ABORT" }
  ]
}
```

- **`acceptedEvents`** -- Which options to show the user. Choose from: `APPROVE`, `FORCE_REVISION`, `REPLAN`, `ABORT`.
- **`present`** -- Artifact names to show the user for review

### Deterministic states

```json
{
  "type": "deterministic",
  "run": [
    ["npm", "test"],
    ["npm", "run", "lint"]
  ],
  "transitions": [
    { "to": "next", "guard": "isPassed" },
    { "to": "fix", "guard": "isRejected" }
  ]
}
```

Commands are arrays of argument arrays (no shell strings). Use `isPassed` guard for success transitions.

### Terminal states

```json
{
  "type": "terminal",
  "outputs": ["reviews"]
}
```

Optional `outputs` lists artifacts to include in the final summary.

### Transition conditions

There are two ways to control transitions: declarative `when` conditions and code-based `guard` functions. Use `when` for simple checks against agent output fields, and `guard` for conditions that need workflow context.

**`when` — declarative conditions (preferred for simple checks):**

```json
{ "to": "done", "when": { "verdict": "approved" } }
{ "to": "fix", "when": { "verdict": "rejected" } }
{ "to": "validate", "when": { "verdict": "thesis_validate" } }
{ "to": "escalate", "when": { "verdict": "escalate" } }
{ "to": "review", "when": { "verdict": "approved", "confidence": "low" } }
```

`when` matches against the agent's status block output. All specified fields must match (AND semantics). Matchable fields: `completed`, `verdict`, `confidence`, `escalation`, `testCount`, `notes`.

The `verdict` field accepts any string value, enabling custom verdicts for direct routing (e.g., `"thesis_validate"`, `"escalate"`, `"reanalyze"`). Well-known values are `approved`, `rejected`, `blocked`, and `spec_flaw`. The `confidence` field is validated against its allowed values (`high`, `medium`, `low`) at definition load time, catching typos early.

`when` is only available on agent state transitions (not deterministic states). A transition cannot have both `when` and `guard`.

**`guard` — code-based conditions (for complex checks):**

| Guard                    | Checks                                            |
| ------------------------ | ------------------------------------------------- |
| `isApproved`             | Agent verdict is "approved"                       |
| `isRejected`             | Agent verdict is "rejected"                       |
| `isLowConfidence`        | Agent approved but with low confidence            |
| `isRoundLimitReached`    | Per-state visit count >= maxRounds                |
| `isStalled`              | Agent produced identical output as previous round |
| `hasTestCountRegression` | Test count dropped (agent may have deleted tests) |
| `isPassed`               | Deterministic state commands all passed           |

Use `guard` for conditions that depend on workflow context (round limits, stall detection, test count regression) or for deterministic state transitions (`isPassed`). The simple verdict guards (`isApproved`, `isRejected`, `isLowConfidence`) still work for the well-known verdict values but `when` is preferred for new workflows, especially when using custom verdict strings for direct routing.

## Agent status block

Every agent must end its response with a YAML status block:

```yaml
agent_status:
  completed: true
  verdict: approved
  confidence: high
  escalation: null
  test_count: null
  notes: 'Brief summary of what was done'
```

The `verdict` field is a free-form string. Well-known values are `approved`, `rejected`, `blocked`, and `spec_flaw`, but workflow definitions may instruct agents to use custom verdict strings for direct routing (e.g., `thesis_validate`, `escalate`).

The `prompt` field in your workflow definition should include instructions about what the agent does, but the orchestrator automatically appends status block format instructions. If the agent forgets the status block, the orchestrator retries once.

## Message log

Every workflow produces a `messages.jsonl` file in `.workflow/` containing all agent exchanges. Use `ironcurtain workflow inspect` to view it, or read it directly for debugging.

## Checkpointing and resume

The orchestrator saves a checkpoint after every state transition. If a workflow fails (agent error, Docker issue, Ctrl+C), you can resume from the last checkpoint:

```bash
ironcurtain workflow resume /path/to/base-dir
```

For workflows that ran before checkpointing was added, synthesize a checkpoint at a specific state:

```bash
ironcurtain workflow resume /path/to/base-dir --state review
```

Artifacts and conversation state survive across resume. Docker sessions use `claude --continue` to preserve conversation history within each role.

## Web UI

Workflows can also be managed from the browser using the daemon's web UI. Start the daemon with the `--web-ui` flag:

```bash
ironcurtain daemon --web-ui
```

The daemon prints an authenticated URL (e.g., `http://127.0.0.1:7400?token=<TOKEN>`). Open it in a browser and navigate to the Workflows page from the sidebar.

### Starting and resuming workflows

The Workflows page provides a form to start new workflows. Select a definition from the dropdown (bundled and user-defined workflows are auto-discovered), enter a task description, and optionally specify a workspace path. The web UI also lists resumable workflows -- previously checkpointed runs that can be continued with one click. You can import a workflow from an external directory by providing its base directory path.

### State machine visualization

When you select a running workflow, a state machine graph shows all states and transitions from the workflow definition. The current state is highlighted, and completed states are visually distinguished. The transition history table shows timestamps and durations for each state change.

### Gate review

When a workflow pauses at a human gate, the web UI shows a review panel with the gate's accepted actions (Approve, Force Revision, Replan, Abort). The panel includes:

- **Artifact browser** -- rendered markdown content from the `.workflow/` artifact directories (plan, spec, reviews) presented as tabs for quick comparison.
- **Feedback input** -- when choosing Force Revision, a text area lets you provide feedback that gets included in the next agent's prompt.

The Workflows page auto-selects a workflow when a gate is raised, so you are taken directly to the review panel when action is needed.

### Workspace browser

A collapsible file browser shows the workspace directory tree during and after workflow execution. You can navigate directories and view file contents with syntax highlighting. Binary files and files over 1MB are excluded. The `.git` and `node_modules` directories are filtered from listings.

### Persona viewer

The web UI includes a read-only Personas page (accessible from the sidebar) where you can view all configured personas, their constitutions (rendered as markdown), and compiled policy summaries. Personas are created and managed via the CLI (`ironcurtain persona create|compile|edit|delete`); the web UI provides a convenient way to review them.

### Development and testing

For frontend development without Docker or an API key, use the mock WebSocket server:

```bash
cd packages/web-ui && npm run mock-server   # Terminal 1
cd packages/web-ui && npm run dev            # Terminal 2
```

Open `http://localhost:5173?token=mock-dev-token`. The mock server simulates workflow lifecycle events with realistic timing. See [docs/e2e-workflow-testing.md](docs/e2e-workflow-testing.md) for the full E2E testing guide.

## User-defined workflows

Custom workflow definitions can be placed in `~/.ironcurtain/workflows/`. Files in this directory are discovered by both `ironcurtain workflow list` and the web UI's definition dropdown. User-defined workflows override bundled ones if they share the same name.
