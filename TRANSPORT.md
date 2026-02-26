# Signal Messaging Transport

IronCurtain includes a Signal messaging transport that lets you interact with agent sessions from any device running the Signal app. Send tasks, receive responses, and approve escalations — all through end-to-end encrypted messages.

## Why Signal?

IronCurtain is a security-first runtime. The messaging transport should reflect that posture. We evaluated several options:

| Platform | E2E Encryption | Open Protocol | Metadata Collection | Bot API |
|----------|---------------|---------------|--------------------|---------|
| **Signal** | Always on, all messages | Yes (open-source) | Minimal (sealed sender) | No official API (we use signal-cli) |
| Telegram | Opt-in (Secret Chats only) | No | Extensive | Yes (full-featured) |
| Discord | No | No | Extensive | Yes (full-featured) |
| Slack | No (enterprise key management) | No | Extensive | Yes (full-featured) |
| Matrix | Optional (varies by client) | Yes (federated) | Depends on homeserver | Yes |

Telegram, Discord, and Slack would have been easier to integrate — they all have official bot APIs with inline buttons, rich formatting, and webhooks. But they also collect metadata, lack default E2E encryption, and run on closed protocols. Using one of these as the primary transport for a security-focused agent runtime would undermine the project's credibility.

Signal's tradeoffs are the right ones for IronCurtain:

- **Full E2E encryption by default** — every message between you and the bot is encrypted. Signal cannot read them. Your ISP cannot read them. A compromised server cannot read them.
- **Minimal metadata** — Signal's sealed sender protocol means even Signal's servers don't know who sent a message to whom.
- **Open-source protocol** — the Signal Protocol is published, audited, and used as the basis for encryption in WhatsApp, Google Messages, and others.
- **No bot API is actually a feature** — there is no cloud-hosted bot infrastructure that could be compromised. The signal-cli process runs on *your* machine, in a Docker container you control. Your messages never pass through a third-party bot platform.

The downside is engineering effort. Signal has no bot SDK, no webhooks, no inline buttons. We bridge the gap with [signal-cli](https://github.com/AsamK/signal-cli) running in the community-maintained [signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api) Docker container. Escalation approvals use text replies ("approve"/"deny") instead of buttons. Code formatting is limited to Signal's inline markup. These are acceptable tradeoffs for a tool whose users care about security.

## Prerequisites

- Docker running on the host machine
- A phone number for the bot (a dedicated number, or your existing Signal account via device linking)
- Your own Signal phone number (to receive messages)

## Setup

### 1. Run the setup wizard

```bash
ironcurtain setup-signal
```

The wizard walks you through:

1. **Docker validation** — confirms Docker is available
2. **Container setup** — pulls and starts the signal-cli-rest-api Docker image
3. **Signal registration** — either register a new phone number (requires captcha + SMS verification) or link as a secondary device on your existing Signal account
4. **Identity verification** — a challenge-response exchange proves you control the recipient phone number and captures your Signal identity key fingerprint

All configuration is saved to `~/.ironcurtain/config.json` under the `signal` key.

### 2. Start the bot

```bash
ironcurtain bot
```

The bot starts a long-running daemon that:
- Connects to signal-cli via WebSocket for real-time message delivery
- Creates agent sessions on demand when you send a message
- Handles graceful shutdown on Ctrl+C / SIGTERM

You can specify which agent to use:

```bash
ironcurtain bot --agent claude-code    # Docker agent mode
ironcurtain bot --agent builtin        # Built-in Code Mode agent
```

Without `--agent`, the bot uses the same auto-detection logic as `ironcurtain start`.

### 3. Send a message

Open Signal on your phone or desktop and send a message to the bot's number. The bot creates a new session and responds with the agent's output.

## Bot Commands

Send these as Signal messages to control the bot:

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/quit` or `/new` | End the current session (bot stays online) |
| `/budget` | Show resource consumption (tokens, steps, cost) |
| `approve` or `/approve` | Approve a pending escalation |
| `deny` or `/deny` | Deny a pending escalation |

Any other message is routed to the active session as a user message. If no session exists, one is created automatically.

## Escalation Handling

When the policy engine escalates a tool call, the bot sends a formatted banner:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ESCALATION: Human approval required
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Tool: filesystem/write_file
Arguments: {"path": "/etc/hosts"}
Reason: Write outside sandbox
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Reply "approve" or "deny"
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Reply with `approve` or `deny` (case-insensitive, with or without `/` prefix).

## Identity Verification

During setup, the bot sends a 6-digit challenge code to your Signal number and asks you to type it back in the terminal. This proves you control both the terminal and the Signal account. The bot also captures your Signal identity key fingerprint and stores it in the config.

At runtime, the bot continuously verifies your identity key:
- **Real-time detection** — signal-cli flags incoming messages when the sender's identity key has changed
- **Periodic verification** — the bot proactively checks the identity key via the signal-cli API every 5 minutes

If a key change is detected, the bot **locks the transport** — all messages are silently rejected. This protects against SIM-swap attacks, number reassignment, or device compromises.

To unlock after a legitimate key change (new phone, Signal reinstall):

```bash
ironcurtain setup-signal --re-trust
```

This runs a new challenge-response exchange, captures the new identity key, and updates the config. The running bot detects the config change and automatically resumes accepting messages.

## Architecture

```
Signal App (phone/desktop)
        |
  Signal Servers (E2E encrypted)
        |
┌────────────────────────────────────────┐
│  Host Machine                          │
│                                        │
│  ironcurtain bot    signal-cli-rest-api│
│  ┌───────────────┐  ┌────────────────┐ │
│  │SignalBotDaemon│  │ Docker         │ │
│  │  WebSocket ◄──┼──┤ container      │ │
│  │  HTTP POST  ──┼─►│ REST API :8080 │ │
│  └──────┬────────┘  └────────────────┘ │
│         │                              │
│  ┌──────▼───────┐                      │
│  │   Session    │                      │
│  │ Policy Engine│                      │
│  │  MCP Servers │                      │
│  └──────────────┘                      │
└────────────────────────────────────────┘
```

The transport is split into two components:

- **SignalBotDaemon** — long-lived process that owns the WebSocket connection, manages identity verification, and routes messages to sessions. Survives session boundaries.
- **SignalSessionTransport** — lightweight `Transport` adapter, one per session. Created when a new session starts, destroyed when it ends.

## Docker Container

The signal-cli container runs as a persistent background service:

| Property | Value |
|----------|-------|
| Image | `bbernhard/signal-cli-rest-api:latest` |
| Network | `bridge` (needs internet for Signal servers) |
| Port | `127.0.0.1:18080:8080` (localhost only) |
| Capabilities | `--cap-drop=ALL` (same as agent containers) |
| Restart policy | `unless-stopped` (survives reboots) |
| Data volume | `~/.ironcurtain/signal-data/` → `/home/.local/share/signal-cli` |
| Memory | ~200-400MB (JVM-based) |

The container is automatically managed — `ironcurtain bot` ensures it's running before connecting. Registration data and cryptographic keys persist in the host-mounted volume.

## Configuration

Signal config lives in `~/.ironcurtain/config.json`:

```json
{
  "signal": {
    "botNumber": "+15551234567",
    "recipientNumber": "+15559876543",
    "recipientIdentityKey": "05a1b2c3d4e5f6...",
    "container": {
      "image": "bbernhard/signal-cli-rest-api:latest",
      "port": 18080
    }
  }
}
```

| Field | Description | Default |
|-------|-------------|---------|
| `botNumber` | The bot's registered Signal phone number | *(set during setup)* |
| `recipientNumber` | Your Signal phone number | *(set during setup)* |
| `recipientIdentityKey` | Your Signal identity key fingerprint | *(captured during setup)* |
| `container.image` | Docker image for signal-cli | `bbernhard/signal-cli-rest-api:latest` |
| `container.port` | Host port for the REST API | `18080` |

## Text Formatting

Agent responses are converted from Markdown to Signal's styled text markup before sending. Signal supports a subset of Markdown:

| Markdown | Signal rendering |
|----------|-----------------|
| `**bold**` | **Bold** |
| `*italic*` | *Italic* |
| `` `code` `` | `Monospace` |
| `~~strike~~` | ~~Strikethrough~~ |
| `# Heading` | **Bold text** (no size distinction) |
| Code blocks | Backtick-wrapped (no syntax highlighting) |
| `> quote` | `| quoted text` |
| Lists | Preserved as-is |
| `[text](url)` | `text (url)` |
| Tables | Monospace approximation |

Long messages are automatically split at paragraph boundaries to stay within Signal's ~2000 character limit.

## Troubleshooting

| Issue | Resolution |
|-------|-----------|
| `Signal is not configured` | Run `ironcurtain setup-signal` first |
| Container port conflict | Change `container.port` in config or stop the conflicting service |
| Registration blocked by Signal | Wait and retry, try a different IP, or use device linking instead |
| Bot not responding | Check that the signal-cli container is running: `docker ps \| grep ironcurtain-signal` |
| Identity key mismatch | Run `ironcurtain setup-signal --re-trust` to re-verify |
| signal-cli protocol errors | Update the Docker image: change `container.image` to a newer tag and restart |
| High memory usage | The signal-cli JVM uses 200-400MB. This is normal and required while the bot is running |

## Known Limitations

- **No inline buttons** — Signal has no bot API. Escalation approvals use text replies.
- **Limited formatting** — No syntax highlighting, no tables, no header sizing. Code-heavy output looks degraded compared to terminal rendering.
- **Single user** — The bot accepts messages from one phone number only. Group chat and multi-user support are not implemented.
- **JVM memory** — The signal-cli container uses 200-400MB of RAM as a permanent background cost.
- **Registration fragility** — Signal's anti-fraud measures may block registration from certain IPs or virtual numbers.
- **Protocol updates** — Signal periodically changes its server protocol, which can break old signal-cli versions. Update the Docker image when this happens.
