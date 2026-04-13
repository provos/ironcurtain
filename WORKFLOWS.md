# Workflows

IronCurtain workflows orchestrate multiple AI agents through a state machine to plan, design, implement, and review code autonomously. Each agent runs in its own Docker container with IronCurtain's policy engine mediating tool access.

## Quick start

```bash
# Run the built-in design-and-code workflow on a new project
ironcurtain workflow start design-and-code \
  "Build a TypeScript CLI that converts CSV files to JSON"

# Run it on an existing codebase
ironcurtain workflow start design-and-code \
  "Add rate limiting to the API endpoints" \
  --workspace ~/src/my-api

# Use a cheaper model for experimentation
ironcurtain workflow start design-and-code \
  "Build a palindrome checker" \
  --model anthropic:claude-haiku-4-5
```

## Prerequisites

- Docker running with the `ironcurtain-claude-code:latest` image built
- `ANTHROPIC_API_KEY` in environment or `~/.ironcurtain/config.json`
- Global compiled policy (`npm run compile-policy`)

## How workflows work

A workflow is a YAML or JSON file that defines a state machine. Each state is one of:

- **`agent`** -- Runs an AI agent with a role-specific prompt. The agent can read/write files, run commands, and use all available MCP tools. The policy engine controls what's allowed.
- **`human_gate`** -- Pauses execution and asks for your input: approve, request revision, or abort.
- **`deterministic`** -- Runs shell commands (typecheck, lint, test) without an LLM.
- **`terminal`** -- End state (success or aborted).

### Sessions and workspace

Each agent state gets its own Docker session (container). All sessions share the same workspace directory — files written by one agent are visible to the next. The orchestrator passes the previous agent's response text to the next agent so it has context about what was done.

Within a state that runs multiple rounds (e.g., the coder running again after critic rejection), the session is resumed via `claude --continue`. The agent retains its full conversation history from prior rounds, so it knows what it already did and what feedback it received. A new container is created for each round, but the conversation state is persisted on disk and mounted into the new container.

Different states always get separate sessions — the planner, architect, coder, and critic each have their own conversation history and cannot see each other's internal reasoning. They communicate only through the shared workspace and the response text passed by the orchestrator.

## The design-and-code workflow

The built-in `design-and-code` workflow follows this flow:

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

Start a new workflow. The first argument can be a workflow name (looked up from bundled and user directories) or a path to a definition file (YAML or JSON).

```bash
ironcurtain workflow start <name-or-path> "task description" [options]
```

Options:

- `--model <model>` -- Override the model (e.g., `anthropic:claude-haiku-4-5`)
- `--workspace <path>` -- Use an existing directory instead of creating a new one

Examples:

```bash
ironcurtain workflow start design-and-code "Build a REST API"
ironcurtain workflow start ./my-workflow.yaml "Build a REST API"
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

A workflow definition is a YAML (preferred) or JSON file. YAML is recommended because prompts can use `|` literal blocks for multi-line strings instead of escaped newlines.

```yaml
name: my-workflow
description: What this workflow does
initial: first_state

settings:
  mode: docker
  dockerAgent: claude-code
  maxRounds: 3
  systemPrompt: Optional persistent context for all agents

states:
  first_state:
    # ...
  second_state:
    # ...
  done:
    type: terminal
    description: Workflow complete
```

### Agent states

```yaml
my_state:
  type: agent
  persona: role-name
  prompt: |
    You are a ... Your responsibilities: ...
  inputs:
    - plan
    - spec
  outputs:
    - reviews
  transitions:
    - to: next_state
      when:
        verdict: approved
    - to: retry_state
      when:
        verdict: rejected
    - to: escalate
      guard: isRoundLimitReached
```

- **`persona`** -- Either `"global"` (use the default global policy) or the name of an IronCurtain persona created via `ironcurtain persona create <name>`. When set to a real persona name, the agent session uses that persona's compiled policy, memory database, and system prompt augmentation. The orchestrator validates that all non-`"global"` personas exist before starting the workflow.
- **`prompt`** -- Role instructions sent to the agent. The orchestrator automatically appends workflow context (task description, previous agent output, artifact locations) and status block format instructions after your prompt. On re-invocation of the same state (round 2+ via `--continue`), only new information is sent (the role instructions are already in the conversation history).
- **`inputs`** -- Artifact directories the agent should read (under `.workflow/`). Trailing `?` marks optional inputs (e.g., `reviews?`).
- **`outputs`** -- Artifact directories the agent must create (under `.workflow/`). Use `[]` for code-only states where the agent writes to the workspace root.
- **`transitions`** -- Where to go next, using `when` for declarative conditions or `guard` for context-based checks

### Human gate states

```yaml
my_gate:
  type: human_gate
  description: Human review
  acceptedEvents:
    - APPROVE
    - FORCE_REVISION
    - ABORT
  present:
    - plan
  transitions:
    - to: next
      event: APPROVE
    - to: revise
      event: FORCE_REVISION
    - to: aborted
      event: ABORT
```

- **`acceptedEvents`** -- Which options to show the user. Choose from: `APPROVE`, `FORCE_REVISION`, `REPLAN`, `ABORT`.
- **`present`** -- Artifact names to show the user for review

### Deterministic states

```yaml
validate:
  type: deterministic
  description: Run tests and lint
  run:
    - - npm
      - test
    - - npm
      - run
      - lint
  transitions:
    - to: next
      guard: isPassed
    - to: fix
```

Commands are arrays of argument arrays (no shell strings). Use `isPassed` guard for success transitions.

### Terminal states

```yaml
done:
  type: terminal
  description: Workflow complete
  outputs:
    - reviews
```

Optional `outputs` lists artifacts to include in the final summary.

### Transition conditions

There are two ways to control transitions: declarative `when` conditions and code-based `guard` functions. `when` clauses with free-form verdict strings are the primary routing mechanism for agent states. Guards are reserved for conditions that require workflow context.

**`when` -- declarative conditions (preferred):**

```yaml
- to: done
  when: { verdict: approved }
- to: fix
  when: { verdict: rejected }
- to: validate
  when: { verdict: thesis_validate }
- to: escalate
  when: { verdict: escalate }
```

`when` matches against the agent's status block output. All specified fields must match (AND semantics). The primary matchable field is `verdict`. Other fields (`completed`, `confidence`, `escalation`, `testCount`, `notes`) are also available but are deprecated for routing -- use `verdict` and `notes` instead.

The `verdict` field accepts any string value, enabling custom verdicts for direct routing (e.g., `"thesis_validate"`, `"escalate"`, `"reanalyze"`). Well-known values are `approved`, `rejected`, `blocked`, and `spec_flaw`. This is the recommended pattern for new workflows: instruct the agent to use specific verdict strings in its prompt, then match on them with `when`.

`when` is only available on agent state transitions (not deterministic states). A transition cannot have both `when` and `guard`.

**`guard` -- code-based conditions (for context-based checks):**

| Guard                 | Checks                                            |
| --------------------- | ------------------------------------------------- |
| `isApproved`          | Agent verdict is "approved"                       |
| `isRejected`          | Agent verdict is "rejected"                       |
| `isRoundLimitReached` | Per-state visit count >= maxRounds                |
| `isStalled`           | Agent produced identical output artifacts as previous round |
| `isPassed`            | Deterministic state commands all passed            |

Use `guard` for conditions that depend on workflow context (round limits, stall detection) or for deterministic state transitions (`isPassed`). The simple verdict guards (`isApproved`, `isRejected`) still work but `when` is preferred for new workflows -- `when: { verdict: approved }` is equivalent to `guard: isApproved` and supports custom verdict strings for direct routing.

### Stall detection

The `isStalled` guard compares SHA-256 hashes of a state's output artifact files between consecutive visits. If an agent produces byte-identical output on two consecutive invocations of the same state, the guard returns true — the agent is stuck in a loop producing the same result.

This is useful for coder-critic loops where the coder might repeat the same implementation after being rejected:

```yaml
review:
  type: agent
  description: Reviews code against the spec
  transitions:
    - to: done
      when:
        verdict: approved
    - to: escalate_gate
      guard: isStalled
    - to: implement
      when:
        verdict: rejected
```

The `isStalled` transition should be ordered before the rejection transition so it fires first when the output is identical. This routes to a human gate or alternative state instead of letting the loop continue indefinitely.

## Agent status block

Every agent must end its response with a YAML status block. The orchestrator automatically appends format instructions to the agent's prompt, so you only need to describe what verdicts to use in your prompt template. The minimal required fields are:

```yaml
agent_status:
  verdict: approved
  notes: 'Brief summary of what was done'
```

- **`verdict`** -- Free-form string that drives transition routing. Well-known values are `approved`, `rejected`, `blocked`, and `spec_flaw`, but workflows may define custom verdict strings for direct routing (e.g., `thesis_validate`, `escalate`).
- **`notes`** -- Brief summary passed to the next agent as context.

The following fields are parsed if present but are deprecated and should not be relied upon for routing:

- `completed` -- Defaults to `true`. Use `verdict` instead.
- `confidence` -- Defaults to `"high"`. Validated against `high`/`medium`/`low` but not used for routing.
- `escalation` -- Defaults to `null`. Use `notes` for inter-agent context.
- `test_count` -- Defaults to `null`. No longer consumed by any guard.

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

Custom workflow definitions (`.yaml`, `.yml`, or `.json`) can be placed in `~/.ironcurtain/workflows/`. Files in this directory are discovered by both `ironcurtain workflow list` and the web UI's definition dropdown. User-defined workflows override bundled ones if they share the same name. When both YAML and JSON versions exist with the same name, YAML takes precedence.
