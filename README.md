# IronCurtain

[![CI](https://github.com/provos/ironcurtain/actions/workflows/ci.yml/badge.svg)](https://github.com/provos/ironcurtain/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@provos/ironcurtain)](https://www.npmjs.com/package/@provos/ironcurtain)
[![License](https://img.shields.io/github/license/provos/ironcurtain)](LICENSE)
[![Website](https://img.shields.io/badge/web-ironcurtain.dev-blue)](https://ironcurtain.dev)

**A secure\* runtime for autonomous AI agents, where security policy is derived from a human-readable constitution.**

_\*When someone writes "secure," you should immediately be skeptical. [What do we mean by secure?](https://ironcurtain.dev)_

> [!WARNING]
> **Research Prototype.** IronCurtain is an early-stage research project exploring how to make AI agents safe enough to be genuinely useful. APIs, configuration formats, and architecture may change. Contributions and feedback are welcome.

## Demo

<p align="center">
  <img src="demo.gif" alt="IronCurtain mux demo: trusted input from command mode enables auto-approval of git clone and git push" width="800">
</p>

The agent is asked to clone a repository and push changes. Both `git_clone` and `git_push` are escalated by the policy engine, but the auto-approver approves them automatically — the user's trusted input from command mode (Ctrl-A) provided clear intent, so no manual `/approve` was needed.

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

## Architecture

IronCurtain supports two session modes with different trust models:

- **Builtin Agent (Code Mode)** — IronCurtain's own LLM agent writes TypeScript snippets that execute in a V8 sandbox. IronCurtain controls the agent, the sandbox, and the policy engine. Every tool call exits the sandbox as a structured MCP request, passes through the policy engine (allow / deny / escalate), and only then reaches the real MCP server.

- **Docker Agent Mode** — An external agent (Claude Code, Goose, etc.) runs inside a Docker container with no network access. IronCurtain mediates the external effects: LLM API calls pass through a TLS-terminating MITM proxy (host allowlist, fake-to-real key swap), MCP tool calls pass through the same policy engine, and package installations (npm/PyPI) go through a validating registry proxy.

In both modes, the agent is **untrusted**. Security does not depend on the model following instructions — it is enforced at the boundary.

See [SANDBOXING.md](SANDBOXING.md) for the full architecture with diagrams, layer-by-layer trust analysis, and macOS platform notes.

## Quick Start

### Prerequisites

- Node.js 22+ (required by `isolated-vm`; maximum Node 25)
- Docker — not required but **strongly recommended** for Docker Agent Mode, which provides the strongest isolation
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

You can also place keys in a `.env` file in the project root (loaded automatically via `dotenv`), or add them to `~/.ironcurtain/config.json` via `ironcurtain config`. Environment variables take precedence over config file values. Supported: `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENAI_API_KEY`.

**2. Run the first-start wizard** (runs automatically on first `ironcurtain start`, or explicitly):

```bash
ironcurtain setup
```

Walks you through GitHub token setup, web search provider, model selection, and other settings. Creates `~/.ironcurtain/config.json` with your choices.

## Running IronCurtain

IronCurtain ships with a default policy geared towards the developer experience — read-only operations are allowed, mutations (writes, pushes, PR creation) escalate for human approval. You can start using it immediately after setup.

### Terminal multiplexer (recommended)

The recommended way to use IronCurtain. It gives you the full power of your agent's interactive TUI (Claude Code or Goose) while IronCurtain mediates every tool call through its policy engine — all in a single terminal.

```bash
ironcurtain mux
```

**Key capabilities:**

- **Full agent TUI** — The agent runs in a PTY inside a Docker container with no network access. You interact with it exactly as if it were running locally.
- **Inline escalation handling** — When a tool call needs approval, an escalation picker overlays the viewport with single-key actions (a/d/w for approve/deny/whitelist). Use `/approve+ N` to whitelist a domain or path for the rest of the session.
- **Trusted user input** — Text typed in command mode (Ctrl-A) is captured on the host side before entering the container. This creates a verified intent signal that the auto-approver can use — e.g., typing "push my changes to origin" will auto-approve a subsequent `git_push` escalation.
- **Tab management** — Spawn multiple concurrent sessions (`/new`), switch between them (`/tab N`, Alt-1..9), close them (`/close`). Multiple mux instances can run in parallel.

See [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) for the full walkthrough: input modes, trusted input security model, escalation workflow, and keyboard reference.

### Builtin agent (no Docker required)

For quick tasks or environments without Docker, IronCurtain's builtin agent runs entirely locally in a V8 sandbox:

```bash
ironcurtain start                                    # Interactive multi-turn session
ironcurtain start "Summarize the files in ./src"     # Single-shot mode
ironcurtain start -w ./my-project "Fix the tests"    # Workspace mode
ironcurtain start --persona my-assistant "Check my email"  # Use a persona
```

### Other running modes

IronCurtain also supports PTY mode, session resume (`--resume <session-id>`), a Signal messaging transport for mobile approval, and a daemon mode for scheduled cron jobs. See [RUNNING_MODES.md](RUNNING_MODES.md) for details.

## Customizing Your Policy

The default policy works well for general development, but you can tailor it to your workflow:

**1. Customize your constitution** (optional but recommended):

```bash
ironcurtain customize-policy
```

An LLM-assisted conversation that generates a constitution tailored to your workflow, saved to `~/.ironcurtain/constitution-user.md`. You can also edit this file directly.

**2. Compile the policy:**

```bash
ironcurtain compile-policy
```

Translates your constitution into deterministic rules, generates test scenarios, and verifies them. Compiled artifacts go to `~/.ironcurtain/generated/`.

### Personas

Personas are named policy profiles — each bundles a constitution, compiled policy, persistent workspace, and semantic memory. Use them to run agents with different roles or access levels.

```bash
ironcurtain persona create my-assistant    # Create a persona
ironcurtain persona compile my-assistant   # Compile its policy
ironcurtain start --persona my-assistant "Check my calendar"
```

In mux mode, `/new my-assistant` spawns a tab using that persona. Personas can also be assigned to cron jobs. See [DAEMON.md](DAEMON.md) for scheduled job configuration.

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
  { "tool": "git_status", "decision": "allow", "condition": { "directory": { "within": "$SANDBOX" } } },
  { "tool": "git_diff", "decision": "allow", "condition": { "directory": { "within": "$SANDBOX" } } },
  { "tool": "git_push", "decision": "escalate", "reason": "Remote-contacting git operations require human approval" }
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

## Configuration

IronCurtain stores configuration and session data in `~/.ironcurtain/`:

```
~/.ironcurtain/
├── config.json              # User configuration
├── constitution.md          # User-local base constitution (overrides package default)
├── constitution-user.md     # Your policy customizations (generated by customize-policy)
├── generated/               # User-compiled policy artifacts (overrides package defaults)
├── personas/                # Persona directories (constitution, policy, workspace, memory)
├── jobs/                    # Cron job definitions, workspaces, and run records
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

Key configuration areas: models and API keys, resource budgets (token/step/time/cost limits), auto-approve escalations, web search provider, audit redaction, and memory server LLM settings. See [CONFIG.md](CONFIG.md) for the full reference.

## Built-in Capabilities

IronCurtain ships with six pre-configured MCP servers. All tool calls (except memory) are governed by your compiled policy.

| Server               | Tools | Key capabilities                                                                                                  |
| -------------------- | ----- | ----------------------------------------------------------------------------------------------------------------- |
| **Filesystem**       | 14    | Read, write, edit, search files; directory tree; move; diff calculation                                           |
| **Git**              | 28    | Full git workflow: status, diff, log, commit, branch, push/pull/fetch, clone, stash, blame                        |
| **Fetch**            | 2     | HTTP GET with HTML-to-markdown conversion; web search (Brave, Tavily, SerpAPI)                                    |
| **GitHub**           | 41    | Issues, PRs, code search, reviews via `ghcr.io/github/github-mcp-server`; requires a GitHub personal access token |
| **Google Workspace** | 128   | Gmail, Calendar, Drive, Docs, Sheets — requires OAuth setup via `ironcurtain auth`                                |
| **Memory**           | 5     | Persistent semantic memory with hybrid vector+keyword search, LLM summarization, and automatic compaction. Enabled for persona and cron sessions. |

Read-only operations are allowed by default policy; mutations (writes, pushes, PR creation) escalate for human approval. Tools use `server.tool` naming (e.g., `filesystem.read_file`, `memory.recall`).

### Network Passthrough (Docker Agent Mode)

In Docker Agent Mode, the container has no network access — all traffic goes through IronCurtain's MITM proxy. By default, only LLM provider domains are reachable. The agent can request access to additional domains at runtime via the `proxy` virtual MCP server (`add_proxy_domain`). Each request requires human approval via the escalation flow.

Approved domains get a **raw passthrough tunnel** — HTTP, HTTPS, and WebSocket connections are forwarded without content inspection or credential injection. This gives the agent greater utility (calling third-party APIs, streaming data from external services) but means traffic to those domains is **unmediated**. See [SECURITY_CONCERNS.md](docs/SECURITY_CONCERNS.md) Section 2b-i for the threat model and [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) for usage details.

## Security Model

IronCurtain is designed around a specific threat model: **the LLM goes rogue.** This can happen through prompt injection (a malicious email or web page hijacks the agent) or through multi-turn drift (the agent gradually deviates from the user's intent over a long session).

### What IronCurtain enforces

- **Filesystem containment** — Symlink-aware path resolution prevents path traversal and symlink-escape attacks.
- **Per-tool policy** — Each MCP tool call is evaluated against compiled rules. The policy engine classifies tool arguments by role (read-path, write-path, delete-path) to make fine-grained decisions.
- **Structural invariants** — Certain protections are hardcoded and cannot be overridden by the constitution: the agent can never modify its own policy files, audit logs, or configuration.
- **Human escalation** — When policy says "escalate," the agent pauses and the user must explicitly approve or deny. Optionally, an LLM-based auto-approver handles unambiguous cases (see [CONFIG.md](CONFIG.md)).
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

| Issue                                   | Guidance                                                                                                                                                                                                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Missing API key**                     | Set the environment variable (`ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, or `OPENAI_API_KEY`) or add the corresponding key to `~/.ironcurtain/config.json`.                                                                                    |
| **Sandbox unavailable**                 | OS-level sandboxing requires `bubblewrap` and `socat`. Install both, or set `"sandboxPolicy": "warn"` in your MCP server config for development.                                                                                                         |
| **Budget exhausted**                    | Adjust limits in `~/.ironcurtain/config.json` under `resourceBudget`. Set any individual limit to `null` to disable it.                                                                                                                                  |
| **Node version errors**                 | Node.js 22+ is required (`isolated-vm` needs `>=22.0.0`). Maximum supported is Node 25 (`<26`).                                                                                                                                                          |
| **Policy doesn't match intent**         | Review `compiled-policy.json` to see the generated rules. Run `ironcurtain customize-policy` to refine your constitution, then `ironcurtain compile-policy` to recompile. Specific wording produces better rules — vague phrasing leads to vague policy. |
| **Auto-approve not triggering**         | The auto-approver only approves when the user's message explicitly authorizes the action (e.g., "push to origin" for `git_push`). Vague messages always escalate to human review. Verify `autoApprove.enabled` is `true` in `config.json`.               |
| **PTY/mux terminal garbled after exit** | Run `reset` in that terminal to restore normal mode. This is needed when the process is killed ungracefully and raw mode is not restored.                                                                                                                |
| **Mux/listener: "already running"**     | Only one mux or escalation-listener can run at a time. The lock at `~/.ironcurtain/escalation-listener.lock` is auto-cleared if the previous process is dead. If it persists, check the PID in the lock file.                                            |
| **Signal bot not responding**           | Verify the signal-cli container is running (`docker ps \| grep ironcurtain-signal`). Check that Signal is configured (`ironcurtain setup-signal`). See [TRANSPORT.md](TRANSPORT.md) for detailed troubleshooting.                                        |

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
├── session/                    # Multi-turn session management, budgets, loop detection
├── sandbox/                    # V8 isolated execution environment
├── trusted-process/            # Policy engine, MCP proxy, audit log, escalation handler
├── pipeline/                   # Constitution → policy compilation pipeline
├── escalation/                 # Escalation listener: session registry, TUI dashboard, state
├── mux/                        # Terminal multiplexer: PTY bridge, renderer, trusted input
├── persona/                    # Persona management (create, compile, resolve)
├── memory/                     # Memory server integration (config, annotations, path resolution)
├── signal/                     # Signal messaging transport (bot daemon, setup, formatting)
├── daemon/                     # Unified daemon (Signal + cron scheduler, control socket)
├── cron/                       # Cron job management (scheduler, job store, git sync, policy)
├── docker/                     # Docker agent mode, PTY session, MITM proxy, registry proxy
├── servers/                    # Built-in MCP servers (fetch, web search providers)
└── types/                      # Shared type definitions
packages/
└── memory-mcp-server/          # Standalone memory MCP server (publishable npm package)
```

## License

[Apache-2.0](LICENSE)
