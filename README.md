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

IronCurtain supports two session modes with different trust models:

- **Builtin Agent (Code Mode)** — IronCurtain's own LLM agent writes TypeScript snippets that execute in a V8 sandbox. IronCurtain controls the agent, the sandbox, and the policy engine. Every tool call exits the sandbox as a structured MCP request, passes through the policy engine (allow / deny / escalate), and only then reaches the real MCP server.

- **Docker Agent Mode** — An external agent (Claude Code, Goose, etc.) runs inside a Docker container with no network access. IronCurtain mediates the external effects: LLM API calls pass through a TLS-terminating MITM proxy (host allowlist, fake-to-real key swap), and MCP tool calls pass through the same policy engine used by Code Mode.

In both modes, the agent is **untrusted**. Security does not depend on the model following instructions — it is enforced at the boundary.

See [SANDBOXING.md](SANDBOXING.md) for the full architecture with diagrams, layer-by-layer trust analysis, and macOS platform notes.

## Quick Start

### Prerequisites

- Node.js 22+ (required by `isolated-vm`; maximum Node 25)
- Docker (required for Docker Agent Mode and PTY mode)
- An API key for at least one LLM provider (Anthropic, Google, or OpenAI)

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

### One-time setup

**1. Set your API key:**

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Or add it to `~/.ironcurtain/config.json` via `ironcurtain config`. Environment variables take precedence. Supported: `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENAI_API_KEY`.

**2. Run the first-start wizard** (runs automatically on first `ironcurtain start`, or explicitly):

```bash
ironcurtain setup
```

Walks you through GitHub token setup, web search provider, model selection, and other settings. Creates `~/.ironcurtain/config.json` with your choices.

**3. Customize your policy** (optional but recommended):

```bash
ironcurtain customize-policy
```

An LLM-assisted conversation that generates a constitution tailored to your workflow, saved to `~/.ironcurtain/constitution-user.md`. You can also edit this file directly.

**4. Compile the policy:**

```bash
ironcurtain compile-policy
```

Translates your constitution into deterministic rules, generates test scenarios, and verifies them. Compiled artifacts go to `~/.ironcurtain/generated/`. The package ships with pre-compiled defaults — skip this step until you customize.

## Running Modes

### Interactive mode

A multi-turn session where you type tasks and the agent responds:

```bash
ironcurtain start
```

Escalated tool calls pause the agent and prompt you with `/approve` or `/deny`.

### Single-shot mode

Send one task and exit when the agent finishes:

```bash
ironcurtain start "Summarize the files in the current directory"
```

### Session resume

Resume a previous session's conversation history:

```bash
ironcurtain start --resume <session-id>
```

Session IDs are printed on session start and stored under `~/.ironcurtain/sessions/`.

### PTY mode and the escalation listener

PTY mode attaches your terminal directly to Claude Code running inside the Docker container. You get Claude Code's full interactive TUI — spinners, diffs, file previews, slash commands — while IronCurtain still mediates every tool call through its policy engine.

```bash
ironcurtain start --pty
```

**Why a separate escalation listener?** In PTY mode your terminal is fully occupied by Claude Code's raw TTY — there is no channel left to inject escalation prompts inline. Each PTY session registers itself in `~/.ironcurtain/pty-registry/` and a separate companion process handles approvals:

```bash
# Terminal 1 — interactive Claude Code session
ironcurtain start --pty

# Terminal 2 — approve or deny escalations from all active PTY sessions
ironcurtain escalation-listener
```

**How session discovery works:**

1. When `--pty` starts, it writes a registration file to `~/.ironcurtain/pty-registry/session-<id>.json` containing the session ID, escalation directory path, display label, and process PID.
2. The escalation listener polls `pty-registry/` every second. It discovers new sessions, attaches an escalation watcher to each one, and detaches watchers when sessions end. Stale registrations (process PID no longer alive) are removed automatically, so a crashed PTY session doesn't leave phantom entries.

**The escalation flow:**

When a tool call is escalated, the PTY session emits a **BEL character** (`\x07`) — your terminal bell or visual flash signals that attention is needed. Switch to the listener terminal. The listener TUI re-renders in place: active sessions are listed with sequential display numbers, and each pending escalation shows the tool name, arguments, and the policy reason for the escalation.

**Listener commands:**

| Command        | Description                               |
| -------------- | ----------------------------------------- |
| `/approve N`   | Approve escalation #N                     |
| `/deny N`      | Deny escalation #N                        |
| `/approve all` | Approve all pending escalations           |
| `/deny all`    | Deny all pending escalations              |
| `/sessions`    | Show detailed session information         |
| `/quit`        | Exit the listener                         |

Escalation numbers are sequential across all sessions. If you have two active PTY sessions, their escalations share a single numbered list in the dashboard — escalation #3 might be from session [1] and #4 from session [2]. Use the number shown in the dashboard to resolve them.

**Multiple concurrent sessions:** The listener aggregates escalations from all active PTY sessions in one dashboard. Each session is assigned a display number (e.g., `Claude Code [1]`, `Claude Code [2]`) when it first appears.

**Single-instance lock:** Only one escalation listener may run at a time, enforced via a PID-checked lock file at `~/.ironcurtain/escalation-listener.lock`. A stale lock from a crashed process is cleaned up automatically on the next start.

**Emergency exit and terminal recovery:** Press `Ctrl-\` to trigger a graceful shutdown of the PTY session (stops containers, proxies, and performs async cleanup). If the process is killed ungracefully (e.g., `kill -9`), run `reset` in that terminal to restore normal terminal mode.

### Signal messaging transport

Run IronCurtain sessions via Signal messages — send tasks, receive responses, and approve or deny escalations from your phone. All communication is end-to-end encrypted via the Signal protocol.

```bash
ironcurtain setup-signal    # One-time setup wizard
ironcurtain bot             # Start the Signal bot daemon
```

See [TRANSPORT.md](TRANSPORT.md) for setup instructions, architecture details, and why we chose Signal over alternatives like Telegram.

## Session Commands

Commands available during an **interactive** or **single-shot** session:

| Command    | Description                                      |
| ---------- | ------------------------------------------------ |
| `/approve` | Approve the pending escalation                   |
| `/deny`    | Deny the pending escalation                      |
| `/budget`  | Show resource consumption (tokens, steps, cost)  |
| `/logs`    | Display diagnostic events                        |
| `/quit`    | End the session                                  |

In **PTY mode**, use the escalation listener instead (see above) — the PTY terminal is occupied by Claude Code's TUI.

## Policy: Constitution → Enforcement

You write intent in plain English; IronCurtain compiles it into deterministic rules:

```
constitution.md → [Annotate] → [Compile] → [Resolve Lists] → [Generate Scenarios] → [Verify & Repair]
                      │              │              │                  │                     │
                      ▼              ▼              ▼                  ▼                     ▼
              tool-annotations  compiled-policy  dynamic-lists   test-scenarios       verified policy
                  .json            .json            .json            .json          (or build failure)
```

1. **Annotate** — Classify each MCP tool's arguments by role (read-path, write-path, delete-path, none).
2. **Compile** — Translate the English constitution into deterministic if/then rules. Categorical references ("major news sites", "my contacts") are emitted as `@list-name` symbolic references.
3. **Resolve Lists** — Resolve symbolic lists to concrete values via LLM knowledge or MCP tool-use (e.g., querying a contacts database). Written to `dynamic-lists.json`, user-editable. Skipped when no lists are present.
4. **Generate Scenarios** — Create test scenarios from the constitution plus mandatory handwritten invariant tests.
5. **Verify & Repair** — Run scenarios against the real policy engine. An LLM judge analyzes failures and generates targeted repairs (up to 2 rounds). Build fails if the policy cannot be verified.

All artifacts are content-hash cached — only changed inputs trigger recompilation.

### What compiled rules look like

A constitution clause like:

```markdown
- The agent may perform read-only git operations (status, diff, log) within the sandbox without approval.
- The agent must receive human approval before git push, pull, fetch, or any remote-contacting operation.
```

compiles to:

```json
[
  { "tool": "git_status", "decision": "allow",    "condition": { "directory": { "within": "$SANDBOX" } } },
  { "tool": "git_diff",   "decision": "allow",    "condition": { "directory": { "within": "$SANDBOX" } } },
  { "tool": "git_push",   "decision": "escalate", "reason": "Remote-contacting git operations require human approval" }
]
```

Any call that doesn't match an explicit `allow` or `escalate` rule is **denied by default**.

```bash
ironcurtain annotate-tools                      # Classify MCP tool arguments (re-run when servers change)
ironcurtain compile-policy                      # Compile constitution into rules and verify
ironcurtain refresh-lists                       # Re-resolve dynamic lists without full recompilation
ironcurtain refresh-lists --list major-news     # Refresh a single list
```

Review the generated `~/.ironcurtain/generated/compiled-policy.json` — these are the exact rules enforced at runtime.

## Web Search

IronCurtain's fetch server includes a `web_search` tool backed by your choice of provider. Configure via `ironcurtain config` → **Web Search**, or directly in `~/.ironcurtain/config.json`:

```json
{
  "webSearch": {
    "provider": "brave",
    "brave": { "apiKey": "BSA..." }
  }
}
```

| Provider | `provider` value | API key field              | Sign up                       |
| -------- | ---------------- | -------------------------- | ----------------------------- |
| Brave    | `"brave"`        | `webSearch.brave.apiKey`   | https://brave.com/search/api/ |
| Tavily   | `"tavily"`       | `webSearch.tavily.apiKey`  | https://tavily.com/           |
| SerpAPI  | `"serpapi"`      | `webSearch.serpapi.apiKey` | https://serpapi.com/          |

`web_search` is available in both builtin and Docker Agent modes. If no provider is configured, calls to `web_search` return an error explaining how to set one up via `ironcurtain config`.

## Configuration

IronCurtain stores configuration and session data in `~/.ironcurtain/`:

```
~/.ironcurtain/
├── config.json              # User configuration
├── constitution.md          # User-local base constitution (overrides package default)
├── constitution-user.md     # Your policy customizations (generated by customize-policy)
├── generated/               # User-compiled policy artifacts (overrides package defaults)
├── signal-data/             # Signal transport persistent data (registration keys)
├── pty-registry/            # Active PTY session registrations (auto-managed)
├── sessions/
│   └── {sessionId}/
│       ├── sandbox/         # Per-session filesystem sandbox
│       ├── escalations/     # File-based IPC for human approval
│       ├── audit.jsonl      # Per-session audit log
│       └── session.log      # Diagnostics
```

Edit configuration interactively:

```bash
ironcurtain config
```

See [CONFIG.md](CONFIG.md) for the full configuration reference covering all fields, defaults, and environment variable overrides.

### Resource Budgets

Sessions enforce configurable limits to prevent runaway agents:

| Limit           | Default    | Config Key                           |
| --------------- | ---------- | ------------------------------------ |
| Max tokens      | 1,000,000  | `resourceBudget.maxTotalTokens`      |
| Max steps       | 200        | `resourceBudget.maxSteps`            |
| Session timeout | 30 minutes | `resourceBudget.maxSessionSeconds`   |
| Cost cap        | $5.00      | `resourceBudget.maxEstimatedCostUsd` |

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

The auto-approver is conservative — it only approves when intent is unambiguous (e.g., "push my changes to origin" clearly authorizes `git_push`). Vague messages like "go ahead" or "fix the tests" always fall through to human review. It can never deny — only approve or escalate. All auto-approved actions are recorded in the audit log with `autoApproved: true`.

### Audit Redaction

Audit log entries may contain sensitive data passed through tool arguments or results. By default, recognized patterns (credit card numbers, SSNs, API keys) are automatically redacted before entries are written to `audit.jsonl`. Disable with `"auditRedaction": { "enabled": false }` in `config.json` for full forensic logging.

### Multi-Provider Support

IronCurtain supports multiple LLM providers. Use the `provider:model-name` format in config and provide the API key for each provider you use:

```json
{
  "agentModelId": "anthropic:claude-sonnet-4-6",
  "policyModelId": "google:gemini-2.5-flash",
  "googleApiKey": "AIza..."
}
```

| Provider  | Config Key        | Environment Variable           |
| --------- | ----------------- | ------------------------------ |
| Anthropic | `anthropicApiKey` | `ANTHROPIC_API_KEY`            |
| Google    | `googleApiKey`    | `GOOGLE_GENERATIVE_AI_API_KEY` |
| OpenAI    | `openaiApiKey`    | `OPENAI_API_KEY`               |

Environment variables take precedence over config file values.

### Adding MCP Servers

IronCurtain ships with filesystem, git, fetch, and GitHub MCP servers pre-configured. Adding a new server is a developer-level task:

1. **Register the server** in `src/config/mcp-servers.json` with its command, arguments, and optional environment variables or sandbox settings.
2. **Extend the argument role registry** in `src/types/argument-roles.ts` if the new server's tools have argument semantics not covered by existing roles (e.g., `read-path`, `write-path`, `fetch-url`).
3. **Update the constitution** in `src/config/constitution.md` to cover the new server's capabilities.
4. **Re-run `ironcurtain annotate-tools`** to classify the new server's tool arguments by role.
5. **Re-run `ironcurtain compile-policy`** to compile policy rules from your constitution. The verification stage will flag gaps.

After compilation, review the updated `tool-annotations.json` and `compiled-policy.json` to verify the new tools are correctly classified and covered by policy.

## Built-in Capabilities

IronCurtain ships with four pre-configured MCP servers. All tool calls are governed by your compiled policy.

| Server         | Tools | Key capabilities                                                                               |
| -------------- | ----- | ---------------------------------------------------------------------------------------------- |
| **Filesystem** | 14    | Read, write, edit, search files; directory tree; move; diff calculation                        |
| **Git**        | 27    | Full git workflow: status, diff, log, commit, branch, push/pull/fetch, clone, stash, blame     |
| **Fetch**      | 2     | HTTP GET with HTML-to-markdown conversion; `web_search` (see [Web Search](#web-search))        |
| **GitHub**     | 41    | Issues, PRs, code search, reviews via `ghcr.io/github/github-mcp-server`; requires a GitHub personal access token |

Read-only operations are allowed by default policy; mutations (writes, pushes, PR creation) escalate for human approval.

## Security Model

IronCurtain is designed around a specific threat model: **the LLM goes rogue.** This can happen through prompt injection (a malicious email or web page hijacks the agent) or through multi-turn drift (the agent gradually deviates from the user's intent over a long session).

### What IronCurtain enforces

- **Filesystem containment** — Symlink-aware path resolution prevents path traversal and symlink-escape attacks.
- **Per-tool policy** — Each MCP tool call is evaluated against compiled rules. The policy engine classifies tool arguments by role (read-path, write-path, delete-path) to make fine-grained decisions.
- **Structural invariants** — Certain protections are hardcoded and cannot be overridden by the constitution: the agent can never modify its own policy files, audit logs, or configuration.
- **Human escalation** — When policy says "escalate," the agent pauses and the user must explicitly approve or deny. Optionally, an [LLM-based auto-approver](#auto-approve-escalations) handles unambiguous cases.
- **Audit trail** — Every tool call and policy decision is logged to an append-only JSONL audit log.
- **Resource limits** — Token, step, time, and cost budgets prevent runaway sessions.

### Known limitations

This is a research prototype. Known gaps include:

- **Policy compilation fidelity** — The LLM-based compiler can misinterpret constitution intent. The verification pipeline catches many errors but is not exhaustive. Always review the compiled `compiled-policy.json`.
- **V8 isolate boundaries** — Code Mode uses V8 isolates, not OS-level virtualization. A V8 zero-day could allow escape.
- **No outbound content inspection** — An agent allowed to write files could encode sensitive data to bypass content-level controls. Planned: LLM-based intelligibility checks on outbound content.
- **Escalation fatigue** — Too many false-positive escalations can lead to habitual approval. Tune your constitution to minimize unnecessary prompts.

See [docs/SECURITY_CONCERNS.md](docs/SECURITY_CONCERNS.md) for a detailed threat analysis.

## Troubleshooting

| Issue                                       | Guidance                                                                                                                                                                                                                                              |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Missing API key**                         | Set the environment variable (`ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, or `OPENAI_API_KEY`) or add the corresponding key to `~/.ironcurtain/config.json`.                                                                                 |
| **Sandbox unavailable**                     | OS-level sandboxing requires `bubblewrap` and `socat`. Install both, or set `"sandboxPolicy": "warn"` in your MCP server config for development.                                                                                                      |
| **Budget exhausted**                        | Adjust limits in `~/.ironcurtain/config.json` under `resourceBudget`. Set any individual limit to `null` to disable it.                                                                                                                               |
| **Node version errors**                     | Node.js 22+ is required (`isolated-vm` needs `>=22.0.0`). Maximum supported is Node 25 (`<26`).                                                                                                                                                       |
| **Policy doesn't match intent**             | Review `compiled-policy.json` to see the generated rules. Run `ironcurtain customize-policy` to refine your constitution, then `ironcurtain compile-policy` to recompile. Specific wording produces better rules — vague phrasing leads to vague policy. |
| **Auto-approve not triggering**             | The auto-approver only approves when the user's message explicitly authorizes the action (e.g., "push to origin" for `git_push`). Vague messages always escalate to human review. Verify `autoApprove.enabled` is `true` in `config.json`.             |
| **PTY terminal garbled after exit**         | Run `reset` in the PTY terminal to restore normal mode. This is needed when the process is killed ungracefully and raw mode is not restored.                                                                                                           |
| **Escalation listener: "already running"** | Another listener holds the lock at `~/.ironcurtain/escalation-listener.lock`. The lock is auto-cleared if the previous process is dead. If it persists, check the PID in the lock file.                                                               |
| **Signal bot not responding**               | Verify the signal-cli container is running (`docker ps \| grep ironcurtain-signal`). Check that Signal is configured (`ironcurtain setup-signal`). See [TRANSPORT.md](TRANSPORT.md) for detailed troubleshooting.                                     |

## Development

```bash
npm test                                    # Run all tests
npm test -- test/policy-engine.test.ts      # Run a single test file
npm test -- -t "denies delete_file"         # Run a single test by name
npm run lint                                # Lint
npm run build                               # TypeScript compilation + asset copy
```

See [TESTING.md](TESTING.md) for the full testing guide, including integration test flags and conventions.

### Project Structure

```
src/
├── index.ts                    # Entry point
├── cli.ts                      # CLI command dispatcher
├── config/                     # Configuration loading, constitution, MCP server definitions
│   ├── constitution.md         # Base security policy in plain English
│   ├── mcp-servers.json        # MCP server definitions
│   └── generated/              # Compiled policy artifacts (do not edit manually)
├── session/                    # Multi-turn session management, budgets, loop detection
├── sandbox/                    # V8 isolated execution environment
├── trusted-process/            # Policy engine, MCP proxy, audit log, escalation handler
├── pipeline/                   # Constitution → policy compilation pipeline
├── escalation/                 # Escalation listener: session registry, TUI dashboard, state
├── signal/                     # Signal messaging transport (bot daemon, setup, formatting)
├── docker/                     # Docker agent mode, PTY session, MITM proxy, adapters
├── servers/                    # Built-in MCP servers (fetch, web search providers)
└── types/                      # Shared type definitions
```

## License

[Apache-2.0](LICENSE)
