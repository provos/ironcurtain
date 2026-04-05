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

Agents communicate through artifacts on disk and by passing their response text to the next agent. The orchestrator manages the state machine, creates Docker sessions, parses agent output, and handles retries.

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

| Role | What it does | Reads | Writes |
|------|-------------|-------|--------|
| Planner | Breaks down the task into steps | Workspace (if existing code) | `.workflow/plan/plan.md` |
| Architect | Produces a technical design spec | Plan, workspace | `.workflow/spec/spec.md` |
| Coder | Implements the design | Plan, spec | Code at workspace root |
| Critic | Reviews code against the spec | Spec, code | `.workflow/reviews/review.md` |

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

### `ironcurtain workflow start`

Start a new workflow.

```bash
ironcurtain workflow start <definition.json> "task description" [options]
```

Options:
- `--model <model>` -- Override the model (e.g., `anthropic:claude-haiku-4-5`)
- `--workspace <path>` -- Use an existing directory instead of creating a new one

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
    { "to": "next_state", "guard": "isApproved" },
    { "to": "retry_state", "guard": "isRejected" }
  ]
}
```

- **`persona`** -- A label for the agent's role (used for session management, not IronCurtain personas)
- **`prompt`** -- Role instructions sent to the agent. Tell it what to do, where to read inputs, and where to write outputs. Use `.workflow/` prefix for artifact directories.
- **`inputs`** -- Artifact directories the agent should read (under `.workflow/`)
- **`outputs`** -- Artifact directories the agent must create (under `.workflow/`). Use `[]` for code-only states where the agent writes to the workspace root.
- **`transitions`** -- Where to go next, optionally gated by guards

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
  "run": [["npm", "test"], ["npm", "run", "lint"]],
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

### Available guards

| Guard | Checks |
|-------|--------|
| `isApproved` | Agent verdict is "approved" |
| `isRejected` | Agent verdict is "rejected" |
| `isLowConfidence` | Agent approved but with low confidence |
| `isRoundLimitReached` | Per-state visit count >= maxRounds |
| `isStalled` | Agent produced identical output as previous round |
| `hasTestCountRegression` | Test count dropped (agent may have deleted tests) |
| `isPassed` | Deterministic state commands all passed |

## Agent status block

Every agent must end its response with a YAML status block:

```yaml
agent_status:
  completed: true
  verdict: approved
  confidence: high
  escalation: null
  test_count: null
  notes: "Brief summary of what was done"
```

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
