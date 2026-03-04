# Developer Guide: Using IronCurtain with Docker Agent Mode

This guide covers the recommended way to use IronCurtain as a security layer for AI coding agents (Claude Code, Goose, etc.). The **terminal multiplexer** (`ironcurtain mux`) gives you the full power of your agent's interactive TUI while IronCurtain enforces security policy on every tool call.

## Why the Terminal Multiplexer?

IronCurtain's Docker Agent Mode runs an external agent (Claude Code, Goose, etc.) inside a network-isolated Docker container. All external effects — LLM API calls, filesystem mutations, git operations — pass through IronCurtain's policy engine. The terminal multiplexer is the interface that ties this together into a seamless developer workflow.

**Without the mux**, PTY mode requires two terminals: one for the agent session and a separate escalation listener. The user has no way to provide trusted input — keystrokes typed into the PTY flow through the Docker container and cannot be distinguished from sandbox-injected text. This means the auto-approver is effectively disabled.

**With the mux**, everything lives in a single terminal:

- **Full agent TUI** — You see your agent's interactive interface exactly as if you ran it locally.
- **Inline escalation handling** — When a tool call needs approval, the escalation panel appears as an overlay. No terminal switching, no context loss.
- **Trusted input line** — Text you type in command mode is captured on the host side, _before_ it enters the container. This creates a verified channel of user intent that the auto-approver can use to make approval decisions.
- **Tab management** — Run multiple agent sessions side by side and switch between them instantly.

## Getting Started

### Prerequisites

- Node.js 22+ and Docker (same as Docker Agent Mode)
- `node-pty` (installed automatically as an optional dependency)
- An API key for your LLM provider

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
- **Handle escalations** — `/approve N`, `/deny N`, `/approve all`, `/deny all`.
- **Manage tabs** — `/new` (spawn session), `/tab N` (switch), `/close` (terminate).
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

## Inline Escalation Handling

When a tool call triggers a policy escalation:

1. The PTY session emits a **BEL character** (your terminal bell or visual flash).
2. An **escalation badge** appears in the tab bar showing the count of pending escalations.
3. The **footer guidance** updates to show the pending count and hint at Ctrl-A.

Press **Ctrl-A** to enter command mode. The **escalation panel** overlays the bottom of the viewport, showing each pending escalation with:

- Sequential number (for `/approve N` or `/deny N`)
- Tool name and server
- Key arguments (packed `key: value` format)
- Policy reason for the escalation

Resolve escalations with:

| Command          | Description                         |
| ---------------- | ----------------------------------- |
| `/approve N`     | Approve escalation #N               |
| `/deny N`        | Deny escalation #N                  |
| `/approve all`   | Approve all pending escalations     |
| `/deny all`      | Deny all pending escalations        |

After resolving, press **Ctrl-A** or **Escape** to return to PTY mode. The agent continues automatically.

## Tab Management

The mux supports multiple concurrent agent sessions:

| Command    | Description                              |
| ---------- | ---------------------------------------- |
| `/new`     | Spawn a new session tab                  |
| `/tab N`   | Switch to tab N                          |
| `/close`   | Close the current tab                    |
| `/close N` | Close tab N                              |
| Alt-1..9   | Quick-switch to tab 1-9 (any mode)       |

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

# Press Ctrl-A to enter command mode.
# The escalation panel shows:
#   [1] git__git_push  remote: origin, branch: main
#       "Remote git operations require human approval"

# Option A: Manual approval
/approve 1

# Option B: Trusted input (also tells the auto-approver)
# Type: push my changes to origin
# This writes trusted context AND forwards to Claude Code.
# The auto-approver sees the trusted intent and approves automatically.

# Press Ctrl-A to return to PTY mode.
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
