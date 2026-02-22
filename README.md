# IronCurtain

[![CI](https://github.com/provos/ironcurtain/actions/workflows/ci.yml/badge.svg)](https://github.com/provos/ironcurtain/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@provos/ironcurtain)](https://www.npmjs.com/package/@provos/ironcurtain)
[![License](https://img.shields.io/github/license/provos/ironcurtain)](LICENSE)
[![Website](https://img.shields.io/badge/web-ironcurtain.dev-blue)](https://ironcurtain.dev)

**A secure\* runtime for autonomous AI agents, where security policy is derived from a human-readable constitution.**

_\*When someone writes "secure," you should immediately be skeptical. [What do we mean by secure?](https://ironcurtain.dev)_

> **Research Prototype.** IronCurtain is an early-stage research project exploring how to make AI agents safe enough to be genuinely useful. APIs, configuration formats, and architecture may change. Contributions and feedback are welcome.

## The Problem

Autonomous AI agents can manage files, run git commands, send messages, and interact with APIs on your behalf. But today's agent frameworks give the agent the same privileges as the user such as full access to the filesystem, credentials, and network. Security researchers call this **ambient authority**, and it means a single prompt injection or multi-turn drift can cause an agent to delete files, exfiltrate data, or push malicious code.

The common response is to either restrict agents to a narrow sandbox (limiting their usefulness) or to ask the user to approve every action (limiting their autonomy). Neither is satisfactory.

## The Approach

IronCurtain takes a different path: **express your security intent in plain English, then let the system figure out enforcement.**

You write a **constitution** which is a short document describing what your agent is and isn't allowed to do. IronCurtain compiles this into a deterministic security policy using an LLM pipeline, validates the compiled rules against generated test scenarios, and then enforces the policy at runtime on every tool call. The result is an agent that can work autonomously within boundaries you define in natural language.

The key ideas:

- **The agent is untrusted.** IronCurtain assumes the LLM may be compromised by prompt injection or drift. Security does not depend on the model "being good."
- **English in, enforcement out.** You write intent ("no destructive git operations without approval"); the system compiles it into deterministic rules that are enforced without further LLM involvement at runtime.
- **Semantic interposition.** Instead of giving the agent raw system access, all interactions go through [MCP](https://modelcontextprotocol.io/) servers (filesystem, git, etc.). Every tool call passes through a policy engine that can **allow**, **deny**, or **escalate** to the user for approval.
- **Defense in depth.** Agent code runs in a V8 isolate with no direct access to the host. The only way out is through semantically meaningful MCP tool calls and every one is checked against policy.

## Demo

<p align="center">
  <img src="demo.gif" alt="IronCurtain demo: agent clones a repo, policy escalates git_clone for approval, user approves, then auto-approve handles git push" width="800">
</p>

The agent clones a repository and edits a file. The policy engine escalates `git_clone` for human approval. After the user types `/approve`, the agent completes the task. On the second request ("ok. git push to origin please"), [auto-approve](#auto-approve-escalations) recognizes the explicit intent and approves `git_push` automatically — no interruption needed.

## Architecture

```
┌─────────────────────────────────────────────┐
│              Agent (LLM)                    │
│  Generates TypeScript to accomplish tasks   │
└──────────────────┬──────────────────────────┘
                   │ TypeScript code
                   ▼
┌─────────────────────────────────────────────┐
│         V8 Isolated Sandbox                 │
│  Code executes in isolation.                │
│  Only interface to the world: typed         │
│  function stubs that produce MCP requests.  │
│                                             │
│  filesystem.read_file({path: '...'})        │
│  git.status({repo_path: '...'})             │
└──────────────────┬──────────────────────────┘
                   │ MCP tool-call requests
                   ▼
┌─────────────────────────────────────────────┐
│     Trusted Process (MCP Proxy)             │
│                                             │
│  ┌───────────────────────────────────────┐  │
│  │  Policy Engine                        │  │
│  │  1. Structural invariants (hardcoded) │  │
│  │  2. Compiled constitution rules       │  │
│  │  → allow / deny / escalate            │  │
│  └───────────────────────────────────────┘  │
│  ┌──────────────┐  ┌─────────────────────┐  │
│  │  Audit Log   │  │ Escalation Handler  │  │
│  │  (JSONL)     │  │ (human approval)    │  │
│  └──────────────┘  └─────────────────────┘  │
└──────────────────┬──────────────────────────┘
                   │ approved calls only
                   ▼
┌──────────┐ ┌──────────┐ ┌──────────┐
│Filesystem│ │   Git    │ │  Other   │
│MCP Server│ │MCP Server│ │MCP Server│
└──────────┘ └──────────┘ └──────────┘
```

**Four layers, strict trust boundaries:**

1. **Agent** -- An LLM (Claude, GPT, Gemini) that writes TypeScript to accomplish user tasks. It has no direct access to the system.
2. **Sandbox** -- A V8 isolate ([UTCP Code Mode](https://utcp.dev/)) that executes the agent's TypeScript. The only way to interact with the outside world is through typed function stubs that produce structured MCP requests.
3. **Trusted Process** -- The security kernel. Every MCP request from the sandbox passes through a two-phase policy engine before reaching any real server. Structural checks enforce hardcoded invariants (protected paths, unknown tool denial). Compiled rule evaluation evaluates the compiled constitution rules. Denied calls are blocked; escalated calls are presented to the user for approval.
4. **MCP Servers** -- Standard [Model Context Protocol](https://modelcontextprotocol.io/) servers that provide filesystem access, git operations, and other capabilities. Only approved requests reach them.

## Policy Compilation Pipeline

The constitution is compiled into enforceable policy through a four-stage LLM pipeline:

```
constitution.md → [Annotate] → [Compile] → [Resolve Lists] → [Generate Scenarios] → [Verify & Repair]
                      │              │              │                  │                     │
                      ▼              ▼              ▼                  ▼                     ▼
              tool-annotations  compiled-policy  dynamic-lists   test-scenarios       verified policy
                  .json            .json            .json            .json          (or build failure)
```

1. **Annotate** -- Classify each MCP tool's arguments by role (read-path, write-path, delete-path, none).
2. **Compile** -- Translate the English constitution into deterministic if/then rules. Categorical references ("major news sites", "my contacts") are emitted as `@list-name` symbolic references with list definitions.
3. **Resolve Lists** -- Resolve dynamic list definitions to concrete values via LLM knowledge or MCP tool-use (e.g., querying a contacts database). Resolved values are written to `dynamic-lists.json` and can be user-inspected/edited. Skipped when no lists are present.
4. **Generate Scenarios** -- Create test scenarios from the constitution, combined with mandatory handwritten invariant tests.
5. **Verify & Repair** -- Execute scenarios against the real policy engine. An LLM judge analyzes failures and generates targeted repairs (up to 2 rounds). The build fails if the policy cannot be verified.

All artifacts are content-hash cached -- only changed inputs trigger recompilation.

### What compiled rules look like

A constitution like:

```markdown
- The agent may perform read-only git operations (status, diff, log) within the sandbox without approval.
- The agent must receive human approval before git push, pull, fetch, or any remote-contacting operation.
```

compiles into deterministic JSON rules:

```json
[
  {
    "tool": "git_status",
    "decision": "allow",
    "condition": { "directory": { "within": "$SANDBOX" } }
  },
  {
    "tool": "git_diff",
    "decision": "allow",
    "condition": { "directory": { "within": "$SANDBOX" } }
  },
  {
    "tool": "git_push",
    "decision": "escalate",
    "reason": "Remote-contacting git operations require human approval"
  }
]
```

Any tool call that doesn't match an explicit rule is escalated to a human by default — the system is deny-by-default with human review as the fallback.

## Getting Started

### Prerequisites

- Node.js 18+
- An API key for at least one supported LLM provider (Anthropic, Google, or OpenAI)

### Install

**As a global CLI tool (end users):**

```bash
npm install -g @provos/ironcurtain
```

**From source (development):**

```bash
git clone https://github.com/provos/ironcurtain.git
cd ironcurtain
npm install
```

### 1. Configure your API key

Set your LLM provider API key via environment variable:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Or add it to `~/.ironcurtain/config.json` (auto-created on first run with defaults):

```json
{
  "anthropicApiKey": "sk-ant-..."
}
```

Environment variables take precedence over config file values. Supported providers: `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENAI_API_KEY`.

### 2. Configure settings

```bash
ironcurtain config
```

This opens an interactive editor for `~/.ironcurtain/config.json` where you can configure models, security settings, resource budgets, and auto-compaction. API keys should be set via environment variables.

### 3. Write your constitution

Edit `src/config/constitution.md` to express your security policy in plain English. Here's the included example:

```markdown
# Guiding Principles

1. **Least privilege**: The agent may only access resources explicitly permitted by policy.
2. **No destruction**: Delete operations outside the sandbox are never permitted.
3. **Human oversight**: Operations outside the sandbox require explicit human approval.

# Concrete Guidance

- The agent is allowed to read, write and delete content in the Downloads folder.
- The agent is allowed to read documents in the User's document folder.
- The agent may perform read-only git operations (status, diff, log) within the sandbox without approval.
- The agent may stage files (git add) and commit within the sandbox without approval.
- The agent must receive human approval before git push, pull, fetch, or any remote-contacting operation.
- The agent must receive human approval before git reset, rebase, merge, or any history-rewriting operation.
```

### 4. Annotate tools and compile the policy

```bash
ironcurtain annotate-tools   # classify MCP tool arguments (developer task)
ironcurtain compile-policy   # compile constitution into enforceable rules (user task)
ironcurtain refresh-lists    # re-resolve dynamic lists without full recompilation
```

Or with npm scripts during development: `npm run annotate-tools` / `npm run compile-policy`.

Tool annotation connects to your MCP servers and classifies each tool's arguments via LLM. This only needs re-running when you add or change MCP servers. Policy compilation translates your constitution into deterministic rules, generates test scenarios, and verifies them. The compiled artifacts are written to `~/.ironcurtain/generated/`. Review the generated `compiled-policy.json` -- these are the rules that will be enforced at runtime. (The package ships with pre-compiled defaults so you can run immediately without compiling.)

IronCurtain ships with pre-configured MCP servers for filesystem and git operations. See [Adding MCP Servers](#adding-mcp-servers) for how to extend this.

### 5. Run the agent

**Interactive mode** (multi-turn session with human escalation support):

```bash
ironcurtain start
```

**Single-shot mode** (send one task, get a response):

```bash
ironcurtain start "Summarize the files in the current directory"
```

Or with npm scripts during development: `npm start` / `npm start "task"`.

### Session Commands

During an interactive session:

| Command | Description |
|---------|-------------|
| `/approve` | Approve a pending escalation request |
| `/deny` | Deny a pending escalation request |
| `/budget` | Show resource consumption (tokens, steps, cost) |
| `/logs` | Display diagnostic events |
| `/quit` | End the session |

## Configuration

IronCurtain stores its configuration and session data in `~/.ironcurtain/`:

```
~/.ironcurtain/
├── config.json              # User configuration
├── generated/               # User-compiled policy artifacts (overrides package defaults)
├── sessions/
│   └── {sessionId}/
│       ├── sandbox/         # Per-session filesystem sandbox
│       ├── escalations/     # File-based IPC for human approval
│       ├── audit.jsonl      # Per-session audit log
│       └── session.log      # Diagnostics
```

### Resource Budgets

Sessions enforce configurable limits to prevent runaway agents:

| Limit | Default | Config Key |
|-------|---------|------------|
| Max tokens | 1,000,000 | `resourceBudget.maxTotalTokens` |
| Max steps | 200 | `resourceBudget.maxSteps` |
| Session timeout | 30 minutes | `resourceBudget.maxSessionSeconds` |
| Cost cap | $5.00 | `resourceBudget.maxEstimatedCostUsd` |

Set any limit to `null` in `config.json` to disable it.

### Auto-Approve Escalations

By default, all escalations require manual `/approve` or `/deny`. You can optionally enable an LLM-based auto-approver that checks whether the user's most recent message clearly authorized the escalated action:

```json
{
  "autoApprove": {
    "enabled": true,
    "modelId": "anthropic:claude-haiku-4-5"
  }
}
```

The auto-approver is conservative — it only approves when intent is unambiguous (e.g., "push my changes to origin" clearly authorizes `git_push`). Vague messages like "go ahead" or "fix the tests" always fall through to human approval. It can never deny — only approve or escalate. All auto-approved actions are recorded in the audit log with `autoApproved: true`.

### Multi-Provider Support

IronCurtain supports multiple LLM providers. Use the `provider:model-name` format in config and provide the API key for each provider you use:

```json
{
  "agentModelId": "anthropic:claude-sonnet-4-6",
  "policyModelId": "google:gemini-2.5-flash",
  "googleApiKey": "AIza..."
}
```

Each provider has its own API key field in the config (and corresponding environment variable):

| Provider | Config Key | Environment Variable |
|----------|-----------|---------------------|
| Anthropic | `anthropicApiKey` | `ANTHROPIC_API_KEY` |
| Google | `googleApiKey` | `GOOGLE_GENERATIVE_AI_API_KEY` |
| OpenAI | `openaiApiKey` | `OPENAI_API_KEY` |

Environment variables take precedence over config file values.

### Adding MCP Servers

IronCurtain ships with filesystem and git MCP servers pre-configured. Adding a new server is a developer-level task that may involve changes across several files:

1. **Register the server** in `src/config/mcp-servers.json` with its command, arguments, and optional environment variables or sandbox settings.
2. **Extend the argument role registry** in `src/types/argument-roles.ts` if the new server's tools have argument semantics not covered by existing roles (e.g., `read-path`, `write-path`, `fetch-url`). Each role defines how values are normalized and evaluated by the policy engine.
3. **Update the constitution** in `src/config/constitution.md` to cover the new server's capabilities.
4. **Re-run `ironcurtain annotate-tools`** (or `npm run annotate-tools`) to classify the new server's tool arguments by role.
5. **Re-run `ironcurtain compile-policy`** (or `npm run compile-policy`) to compile policy rules from your constitution. The verification stage will flag gaps.

After compilation, review the updated `tool-annotations.json` and `compiled-policy.json` to verify the new tools are correctly classified and covered by policy.

## Built-in Capabilities

IronCurtain ships with three pre-configured MCP servers. All tool calls are governed by your compiled policy.

**Filesystem** (14 tools) — `read_file`, `read_multiple_files`, `write_file`, `edit_file`, `create_directory`, `list_directory`, `directory_tree`, `move_file`, `search_files`, `get_file_info`, `list_allowed_directories`, `file_exists`, `read_file_lines`, `calculate_diff`.

**Git** (27 tools) — Full git workflow: `git_status`, `git_diff_staged`, `git_diff_unstaged`, `git_diff`, `git_log`, `git_show`, `git_add`, `git_reset`, `git_commit`, `git_checkout`, `git_create_branch`, `git_list_branches`, `git_push`, `git_pull`, `git_fetch`, `git_merge`, `git_rebase`, `git_cherry_pick`, `git_stash`, `git_stash_pop`, `git_stash_list`, `git_tag`, `git_list_tags`, `git_remote`, `git_clone`, `git_init`, `git_blame`.

**Fetch** (1 tool) — `fetch` retrieves content from URLs with automatic HTML-to-markdown conversion.

## Security Model

IronCurtain is designed around a specific threat model: **the LLM goes rogue.** This can happen through prompt injection (a malicious email or web page hijacks the agent) or through multi-turn drift (the agent gradually deviates from the user's intent over a long session).

### What IronCurtain enforces

- **Filesystem containment** -- Path-based policy with symlink-aware resolution prevents path traversal and symlink-escape attacks.
- **Per-tool policy** -- Each MCP tool call is evaluated against compiled rules. The policy engine classifies tool arguments by role (read-path, write-path, delete-path) to make fine-grained decisions.
- **Structural invariants** -- Certain protections are hardcoded and cannot be overridden by the constitution: the agent can never modify its own policy files, audit logs, or configuration.
- **Human escalation** -- When policy says "escalate," the agent pauses and the user must explicitly `/approve` or `/deny` the action. Optionally, an [LLM-based auto-approver](#auto-approve-escalations) can approve actions that clearly match the user's most recent request — it can never deny, only approve or fall through to human review.
- **Audit trail** -- Every tool call and policy decision is logged to an append-only JSONL audit log.
- **Resource limits** -- Token, step, time, and cost budgets prevent runaway sessions.

### Known limitations

This is a research prototype. Known gaps include:

- **Policy compilation fidelity** -- The LLM-based compiler can misinterpret constitution intent. The verification pipeline catches many errors but is not exhaustive. Always review the compiled `compiled-policy.json`.
- **V8 isolate boundaries** -- The sandbox uses V8 isolates, not OS-level virtualization. A V8 zero-day could allow escape (though the agent has no knowledge of how to exploit one).
- **No outbound content inspection** -- An agent allowed to write files could encode sensitive data to bypass content-level controls. Planned: LLM-based intelligibility checks on outbound content.
- **Escalation fatigue** -- Too many false-positive escalations can lead to habitual approval. Tune your constitution to minimize unnecessary prompts.

See [docs/SECURITY_CONCERNS.md](docs/SECURITY_CONCERNS.md) for a detailed threat analysis.

## Troubleshooting

| Issue | Guidance |
|-------|---------|
| **Missing API key** | Set the environment variable (`ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, or `OPENAI_API_KEY`) or add the corresponding key to `~/.ironcurtain/config.json`. |
| **Sandbox unavailable** | OS-level sandboxing requires `bubblewrap` and `socat`. Install both, or set `"sandboxPolicy": "warn"` in your MCP server config for development. |
| **Budget exhausted** | Adjust limits in `~/.ironcurtain/config.json` under `resourceBudget`. Set any individual limit to `null` to disable it. |
| **Node version errors** | Minimum Node.js 18.3.0 required. Node 20+ is recommended. |
| **Policy doesn't match intent** | Review `compiled-policy.json` to see the generated rules. Re-run `ironcurtain compile-policy` after editing your constitution. Check that the wording is specific — vague phrasing leads to vague rules. |
| **Auto-approve not triggering** | The auto-approver only approves when the user's message explicitly authorizes the action (e.g., "push to origin" for `git_push`). Vague messages like "go ahead" always escalate to human review. Verify `autoApprove.enabled` is `true` in `config.json`. |

## Development

```bash
npm test                                    # Run all tests
npx vitest run test/policy-engine.test.ts   # Run a single test file
npx vitest run -t "denies delete_file"      # Run a single test by name
npm run lint                                # Lint
npm run build                               # TypeScript compilation + asset copy
```

### Project Structure

```
src/
├── index.ts                    # Entry point
├── config/                     # Configuration loading, constitution, MCP server definitions
│   ├── constitution.md         # Your security policy in plain English
│   ├── mcp-servers.json        # MCP server definitions
│   └── generated/              # Compiled policy artifacts (do not edit manually)
├── session/                    # Multi-turn session management, budgets, loop detection
├── sandbox/                    # V8 isolated execution environment
├── trusted-process/            # Policy engine, MCP proxy, audit log, escalation
├── pipeline/                   # Constitution → policy compilation pipeline
└── types/                      # Shared type definitions
```

## License

[Apache-2.0](LICENSE)
