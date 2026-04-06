# Running Modes

IronCurtain supports several running modes beyond the recommended `ironcurtain mux`. This document covers all available modes and when to use them.

## Terminal Multiplexer (recommended)

The default and recommended way to use IronCurtain. See the main [README](README.md) for quick start.

```bash
ironcurtain mux
ironcurtain mux --agent claude-code   # Specify agent (default: claude-code)
```

The mux supports session resume and persona selection through an interactive picker when spawning new tabs.

See [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) for the full walkthrough: input modes, trusted input security model, escalation workflow, and keyboard reference.

## Builtin Agent (Code Mode)

IronCurtain's own LLM agent writes TypeScript that executes in a V8 sandbox. IronCurtain controls the agent, the sandbox, and the policy engine. Docker is not required.

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

### Workspace mode

Point the agent at an existing directory instead of a fresh sandbox:

```bash
ironcurtain start -w ./my-project "Fix the failing tests"
ironcurtain start --workspace /home/user/repos/my-app
```

The workspace replaces the session sandbox as the agent's working area. All session infrastructure (logs, escalations, audit) still lives under `~/.ironcurtain/sessions/`. The path is validated to prevent use of sensitive directories.

### Personas

Use a named persona profile with its own constitution, compiled policy, and persistent workspace:

```bash
ironcurtain start -p exec-assistant "Check my email"
ironcurtain start --persona coder "Refactor the auth module"
```

Manage personas with the `ironcurtain persona` subcommand (`create`, `list`, `compile`, `edit`, `show`, `delete`). See `ironcurtain persona --help` for details.

### Session resume

Resume a previous session's conversation history:

```bash
ironcurtain start --resume <session-id>
```

Session IDs are printed on session start and stored under `~/.ironcurtain/sessions/`.

### Session commands

Commands available during an interactive or single-shot session:

| Command    | Description                                     |
| ---------- | ----------------------------------------------- |
| `/approve` | Approve the pending escalation                  |
| `/deny`    | Deny the pending escalation                     |
| `/budget`  | Show resource consumption (tokens, steps, cost) |
| `/logs`    | Display diagnostic events                       |
| `/quit`    | End the session                                 |

## PTY Mode (Docker Agent, separate escalation listener)

An alternative to the mux — run a raw PTY session in one terminal and handle escalations in another:

```bash
# Terminal 1 — interactive agent session (e.g., Claude Code in Docker)
ironcurtain start --pty

# Terminal 2 — approve or deny escalations from all active PTY sessions
ironcurtain escalation-listener
```

This workflow does not support trusted input or auto-approval for PTY sessions. The mux is recommended instead.

**Emergency exit and terminal recovery:** Press `Ctrl-\` to trigger a graceful shutdown of the PTY session. If the process is killed ungracefully, run `reset` in that terminal to restore normal terminal mode.

## Signal Messaging Transport

Run IronCurtain sessions via Signal messages — send tasks, receive responses, and approve or deny escalations from your phone. All communication is end-to-end encrypted via the Signal protocol.

```bash
ironcurtain setup-signal    # One-time setup wizard
ironcurtain bot             # Start the Signal bot daemon
```

See [TRANSPORT.md](TRANSPORT.md) for setup instructions, architecture details, and why we chose Signal over alternatives like Telegram.

## Daemon Mode

A unified long-running daemon that combines Signal messaging with scheduled cron jobs. Define recurring tasks with per-job security policies, and IronCurtain runs them headlessly on a cron schedule.

```bash
ironcurtain daemon add-job        # Interactive wizard to define a scheduled job
ironcurtain daemon                # Start the daemon (Signal + cron)
ironcurtain daemon --no-signal    # Cron-only mode (no Signal transport)
ironcurtain daemon --web-ui       # Start with browser-based dashboard
ironcurtain daemon list-jobs      # List jobs with schedule and status
ironcurtain daemon logs <id>      # Show recent run summaries
```

The `--web-ui` flag enables a browser-based dashboard for monitoring sessions, handling escalations, and managing jobs. See the [Web UI section in DAEMON.md](DAEMON.md#web-ui) for details.

Each job has its own task description, security constitution (compiled into per-job policy rules), persistent workspace, optional git repo sync, and configurable resource budgets. Escalations are auto-denied in headless mode unless Signal is configured for approval routing.

See [DAEMON.md](DAEMON.md) for the full setup guide, job definition reference, and troubleshooting.

## OAuth Authentication

IronCurtain supports third-party OAuth providers for MCP servers that require authenticated access (e.g., Google Workspace). Manage OAuth credentials with the `auth` subcommand:

```bash
ironcurtain auth                           # Show status of all providers
ironcurtain auth import <provider> <file>  # Import OAuth client credentials
ironcurtain auth <provider>                # Authorize a provider (opens browser)
ironcurtain auth revoke <provider>         # Revoke and delete stored token
```

## Agent Selection

Both `start` and `mux` accept `--agent` to choose which agent adapter to use. List registered agents with:

```bash
ironcurtain start --list-agents
```
