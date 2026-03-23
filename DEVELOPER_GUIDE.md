# Developer Guide: Using IronCurtain with Docker Agent Mode

This guide covers the recommended way to use IronCurtain as a security layer for AI coding agents (Claude Code, Goose, etc.). The **terminal multiplexer** (`ironcurtain mux`) gives you the full power of your agent's interactive TUI while IronCurtain enforces security policy on every tool call.

## Why the Terminal Multiplexer?

IronCurtain's Docker Agent Mode runs an external agent (Claude Code, Goose, etc.) inside a network-isolated Docker container. All external effects — LLM API calls, filesystem mutations, git operations — pass through IronCurtain's policy engine. The terminal multiplexer is the interface that ties this together into a seamless developer workflow.

**Without the mux**, PTY mode requires two terminals: one for the agent session and a separate escalation listener. The user has no way to provide trusted input — keystrokes typed into the PTY flow through the Docker container and cannot be distinguished from sandbox-injected text. This means the auto-approver is effectively disabled.

**With the mux**, everything lives in a single terminal:

- **Full agent TUI** — You see your agent's interactive interface exactly as if you ran it locally.
- **Inline escalation handling** — When a tool call needs approval, the escalation picker appears as a floating overlay. No terminal switching, no context loss.
- **Trusted input line** — Text you type in command mode is captured on the host side, _before_ it enters the container. This creates a verified channel of user intent that the auto-approver can use to make approval decisions.
- **Tab management** — Run multiple agent sessions side by side and switch between them instantly.

## Getting Started

### Prerequisites

- Node.js 22+ and Docker (same as Docker Agent Mode)
- `node-pty` (installed automatically as an optional dependency)
- An API key for your LLM provider (or OAuth — see [OAuth Authentication](#oauth-authentication))

### Launch

```bash
ironcurtain mux
```

This spawns a new tab running `ironcurtain start --pty --agent claude-code` inside a Docker container, enters full-screen mode, and you're immediately in the agent's TUI.

## The Two Input Modes

The mux has two input modes, toggled with **Ctrl-A**:

### PTY Mode (default)

All keystrokes flow directly to the agent inside the container. This is the normal interactive experience — you're typing into Claude Code's prompt, navigating its UI, using its slash commands. The footer shows a hint: `^A command mode`.

### Command Mode

Press **Ctrl-A** to switch to command mode. A command input line appears at the bottom of the screen. Here you can:

- **Type trusted input** — Any text that isn't a slash command is sent as trusted user input (see below).
- **Handle escalations** — `/approve N`, `/deny N`, `/approve all`, `/deny all`, `/approve+ N` (approve and whitelist).
- **Manage tabs** — `/new` (spawn session), `/new <persona>` (spawn with persona), `/tab N` (switch), `/close` (terminate).
- **Resume sessions** — `/resume` (open picker), `/resume <id>` (resume by session ID prefix).
- **View sessions** — `/sessions` shows all active sessions.
- **Exit** — `/quit` or `Ctrl-A` / `Escape` to return to PTY mode.

Press **Ctrl-A** again or **Escape** to return to PTY mode. Quick tab switching is available with **Alt-1** through **Alt-9** from either mode.

## Trusted Input and Auto-Approval

This is the key capability that makes the mux more than a convenience — it's a security feature.

### The Problem

In PTY mode, the agent runs inside a Docker container. When you type into the PTY, your keystrokes enter the container through a socat bridge. From IronCurtain's perspective, this input is indistinguishable from text the sandbox itself might generate. If a prompt injection caused the agent to echo "push my changes to origin" into its own input, a naive auto-approver would treat that as user authorization.

### The Solution: Host-Side Trusted Input

When you type text in **command mode** (after pressing Ctrl-A), the mux captures it on the host side — before it ever touches the container:

1. Your text is written to `user-context.json` in the session's escalation directory (which is never bind-mounted into the container).
2. The text is then forwarded to the agent's PTY as keystrokes.
3. When a tool call triggers an escalation, the auto-approver reads `user-context.json` and checks whether the trusted text clearly authorizes the action.

```
You type: "push my changes to origin"

  Host side (trusted):
    → user-context.json written with source: "mux-trusted-input"
    → Text forwarded to PTY

  Container side:
    → Claude Code receives text, decides to call git_push
    → git_push escalated by policy engine

  Auto-approver:
    → Reads user-context.json
    → Verifies source = "mux-trusted-input" (host-originated)
    → Verifies timestamp is within 120 seconds (not stale)
    → LLM confirms "push my changes to origin" authorizes git_push
    → Auto-approved ✓
```

### Security Guarantees

The trust model rests on Docker container isolation:

- The escalation directory is **never bind-mounted** into the container — only the host-side mux can write `user-context.json`.
- A `source` field (`"mux-trusted-input"`) is required for PTY sessions — the auto-approver rejects context without this marker.
- A **120-second staleness window** bounds the time-of-check/time-of-use (TOCTOU) gap between typing trusted input and the agent acting on it.
- The auto-approver remains **conservative** — it only approves when intent is unambiguous. Vague messages ("go ahead", "fix it") always fall through to manual review.
- The auto-approver can **never deny** — only approve or escalate. A false negative means human review, not a blocked operation.

### Enabling Auto-Approval

Auto-approval is configured in `~/.ironcurtain/config.json`:

```json
{
  "autoApprove": {
    "enabled": true,
    "modelId": "anthropic:claude-haiku-4-5"
  }
}
```

The mux shows a pre-flight warning if auto-approve is enabled but the required API key is missing.

## Escalation Handling

When a tool call triggers a policy escalation:

1. The PTY session emits a **BEL character** (your terminal bell or visual flash).
2. An **escalation badge** appears in the tab bar showing the count of pending escalations.
3. The **footer guidance** updates to show the pending count and hint at Ctrl-A.

### Escalation Picker

Press **Ctrl-E** (from PTY mode) or **Ctrl-A** then view escalations in command mode. The **escalation picker** is a floating overlay that shows each pending escalation with its tool name, server, key arguments, and policy reason. When multiple escalations are pending, use arrow keys to navigate between them.

The picker supports single-key actions for fast resolution:

| Key   | Action                                      |
| ----- | ------------------------------------------- |
| `a`   | Approve the focused escalation              |
| `d`   | Deny the focused escalation                 |
| `w`   | Approve and whitelist (same as `/approve+`) |
| `A`   | Approve all pending escalations             |
| `D`   | Deny all pending escalations                |
| `Esc` | Dismiss the picker                          |

You can also resolve escalations via slash commands in command mode:

| Command          | Description                                            |
| ---------------- | ------------------------------------------------------ |
| `/approve N`     | Approve escalation #N                                  |
| `/deny N`        | Deny escalation #N                                     |
| `/approve+ N`    | Approve #N and whitelist similar future calls           |
| `/approve all`   | Approve all pending escalations                        |
| `/deny all`      | Deny all pending escalations                           |

After resolving, press **Ctrl-A** or **Escape** to return to PTY mode. The agent continues automatically.

### Approval Whitelisting

When you use `/approve+ N` or press `w` in the escalation picker, IronCurtain extracts a pattern from the approved call (tool name, server, and argument constraints like directory paths or domains) and remembers it for the rest of the session. Future calls matching that pattern are auto-approved without another escalation. Whitelist entries are session-scoped and never persisted to disk. The escalation panel shows a preview of what each `/approve+` would whitelist, so you can see the scope of the pattern before committing.

## Personas

Personas are named policy profiles that let you run the agent under different security configurations. Each persona bundles its own constitution (security rules), compiled policy, and persistent memory database under `~/.ironcurtain/personas/<name>/`.

### Creating and Managing Personas

```bash
# Create a new persona interactively
ironcurtain persona create exec-assistant

# List all personas
ironcurtain persona list

# Compile a persona's constitution into policy rules
ironcurtain persona compile exec-assistant

# Edit a persona's constitution
ironcurtain persona edit exec-assistant

# Show persona details
ironcurtain persona show exec-assistant
```

A persona must be compiled before it can be used in a session. Personas can optionally restrict which MCP servers are available (the `filesystem` server is always included).

### Using Personas in the Mux

In command mode, `/new` without arguments opens a **persona picker** that lists all available personas with their compilation status. You can also specify a persona directly:

```
/new exec-assistant
```

Sessions launched with a persona use that persona's compiled policy and get their own isolated memory database.

## Session Resume

The mux can resume previous Docker agent sessions that are still running. Use `/resume` in command mode to open a **resume picker** showing all resumable sessions, or provide a session ID prefix directly:

```
/resume a3f2
```

This attaches to the existing container and reconnects the PTY, escalation handling, and audit logging.

## Memory

When a persona (or cron job) session has memory enabled, IronCurtain injects a memory MCP server into the session. The memory server provides tools for the agent to store and recall information across sessions, backed by a per-persona SQLite database at `~/.ironcurtain/personas/<name>/memory.db`.

Memory is configured in `~/.ironcurtain/config.json`:

```json
{
  "memory": {
    "enabled": true,
    "autoSave": true
  }
}
```

When `autoSave` is enabled, the agent automatically stores a condensed session summary at session close. Memory is only available for persona and cron job sessions, not ad-hoc default sessions.

## OAuth Authentication

IronCurtain supports OAuth for both LLM provider authentication and third-party MCP server credentials.

### LLM Provider OAuth

OAuth tokens for Claude Code are auto-detected from `~/.claude/.credentials.json` and preferred over API keys. The MITM proxy swaps the fake sentinel key for the real OAuth token on the host side — the real credential never enters the container. Override with `IRONCURTAIN_DOCKER_AUTH=apikey` to force API key mode.

### Third-Party OAuth (MCP Servers)

For MCP servers that require OAuth (e.g., Google Workspace), use `ironcurtain auth`:

```bash
# Import OAuth client credentials from your provider
ironcurtain auth import google ~/Downloads/credentials.json

# Authorize (opens browser for OAuth flow)
ironcurtain auth google

# Check authorization status for all providers
ironcurtain auth status

# Revoke a stored token
ironcurtain auth revoke google
```

Tokens are stored locally and refreshed automatically. You can request additional scopes with `--scopes`:

```bash
ironcurtain auth google --scopes gmail.send,calendar.events
```

## Proxy MCP Server

Inside Docker Agent Mode, the agent has access to a virtual `proxy` MCP server that lets it manage network access at runtime. Since the container runs with no network egress, all internet traffic goes through IronCurtain's MITM proxy which maintains a domain allowlist.

The proxy server exposes three tools:

- **`add_proxy_domain`** — Request access to an additional domain (e.g., `api.example.com`). The agent must provide a justification, and the request is escalated for human approval before the domain is added.
- **`remove_proxy_domain`** — Remove a previously approved dynamic domain from the allowlist.
- **`list_proxy_domains`** — List all currently accessible domains (both built-in provider domains and dynamically added ones).

These tools go through normal policy evaluation and audit logging. Adding a domain always requires human approval via the escalation flow.

## Package Installation Proxy

When enabled, IronCurtain mediates package installations (npm, PyPI, Debian APT) inside the Docker container through a registry proxy. This provides supply-chain security by validating packages before allowing downloads:

- **Denylist** — Blocked packages are always rejected.
- **Allowlist** — Explicitly allowed packages bypass the age gate.
- **Age gate** — New package versions must age for a configurable quarantine period (default: 14 days) before they are auto-allowed. This protects against supply-chain attacks that publish malicious versions.

Configure in `~/.ironcurtain/config.json`:

```json
{
  "packageInstallation": {
    "enabled": true,
    "quarantineDays": 14,
    "allowedPackages": ["lodash", "express"],
    "deniedPackages": ["malicious-pkg"]
  }
}
```

## Tab Management

The mux supports multiple concurrent agent sessions:

| Command              | Description                              |
| -------------------- | ---------------------------------------- |
| `/new`               | Open persona picker / spawn session      |
| `/new <persona>`     | Spawn session with a specific persona    |
| `/resume`            | Open resume picker for past sessions     |
| `/resume <id>`       | Resume a session by ID prefix            |
| `/tab N`             | Switch to tab N                          |
| `/close`             | Close the current tab                    |
| `/close N`           | Close tab N                              |
| Alt-1..9             | Quick-switch to tab 1-9 (any mode)       |

The tab bar at the top shows all sessions. The active tab is highlighted. Tabs with pending escalations show an `[!]` badge.

## Workflow Example

A typical development session:

```bash
# Start the mux
ironcurtain mux

# You're now in Claude Code's TUI (PTY mode).
# Type your task directly — Claude Code processes it normally.

# Claude Code tries to git push → policy escalates.
# You hear a bell, see the badge in the tab bar.

# Option A: Press Ctrl-E to open the escalation picker.
# Navigate with arrow keys, press 'a' to approve or 'w' to approve+whitelist.

# Option B: Press Ctrl-A to enter command mode.
/approve 1

# Option C: Trusted input (also tells the auto-approver)
# In command mode, type: push my changes to origin
# This writes trusted context AND forwards to Claude Code.
# The auto-approver sees the trusted intent and approves automatically.

# Press Ctrl-A or Escape to return to PTY mode.
```

## PTY Mode Without the Mux

You can still use PTY mode with a separate escalation listener (the original two-terminal workflow):

```bash
# Terminal 1 — agent session
ironcurtain start --pty

# Terminal 2 — escalation handling
ironcurtain escalation-listener
```

This workflow does not support trusted input or auto-approval for PTY sessions. The mux is the recommended approach.

## Keyboard Reference

| Key             | PTY Mode                              | Command Mode                           |
| --------------- | ------------------------------------- | -------------------------------------- |
| Ctrl-A          | Enter command mode                    | Return to PTY mode                     |
| Ctrl-E          | Open escalation picker                | —                                      |
| Escape          | —                                     | Discard input, return to PTY mode      |
| Enter           | (forwarded to PTY)                    | Execute command or send trusted input  |
| Ctrl-C          | (forwarded to PTY)                    | Clear input buffer                     |
| Alt-1..9        | Switch to tab 1-9                     | Switch to tab 1-9                      |
| Ctrl-\          | Graceful shutdown                     | Graceful shutdown                      |

## Troubleshooting

| Issue | Guidance |
| ----- | -------- |
| **"node-pty not available"** | Install with `npm install node-pty`. It's an optional dependency that requires a C++ toolchain. |
| **"Listener already running"** | Only one mux or escalation-listener can run at a time. Check for existing processes or stale lock at `~/.ironcurtain/escalation-listener.lock`. |
| **Auto-approve not working** | Ensure `autoApprove.enabled` is `true` in config. Use command mode (Ctrl-A) to type input — PTY-mode keystrokes are untrusted. Check that the API key for the auto-approve model is set. |
| **Terminal garbled after exit** | Run `reset` to restore normal terminal mode. |
| **Session discovery timeout** | Docker startup can take 10+ seconds. The mux retries discovery via registry polling. If sessions don't appear, check `docker ps` and the PTY registry at `~/.ironcurtain/pty-registry/`. |
| **Persona not compiled** | Run `ironcurtain persona compile <name>` before launching a session with that persona. The mux warns if a selected persona has no compiled policy. |
| **Memory not saving** | Memory requires a persona or cron job session context. Ad-hoc sessions (no persona) do not get a memory server. Check that `memory.enabled` is `true` in config. |
