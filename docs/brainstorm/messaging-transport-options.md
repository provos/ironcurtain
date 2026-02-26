# Messaging Transport Options for IronCurtain

**Date:** 2026-02-24
**Status:** Research / Brainstorm
**Purpose:** Evaluate messaging platforms as remote transports for IronCurtain sessions

## Context

IronCurtain has a pluggable `Transport` interface (`src/session/transport.ts`) that decouples I/O from session logic. The existing `CliTransport` uses stdin/stdout. A messaging transport would enable:

1. **Remote interaction** - control IronCurtain sessions from a phone or any device
2. **Markdown-formatted responses** - render agent output with formatting
3. **Escalation UI** - approve/deny security escalations via buttons or reactions
4. **Asynchronous monitoring** - see what the agent is doing without being at the terminal

The Transport contract is minimal:

```typescript
interface Transport {
  run(session: Session): Promise<void>;
  close(): void;
}
```

Escalation handling uses callbacks (`onEscalation`, `onEscalationExpired`) that a messaging transport would wire to platform-specific interactive elements (buttons, reactions, etc.).

---

## Quick Comparison

| Platform | Official Bot API | Node/TS SDK | Markdown | Interactive Buttons | No Public Server | Self-Hostable | E2EE | Free | Setup Complexity |
|----------|-----------------|-------------|----------|-------------------|-----------------|---------------|------|------|-----------------|
| **Telegram** | Yes (excellent) | Yes (grammY, Telegraf) | MarkdownV2 | Inline keyboards | Yes (long polling) | No | No (cloud chats) | Yes | Very Low |
| **Signal** | No (unofficial) | Fragile wrappers | Text styles only | No | Yes | Yes (signal-cli) | Yes | Yes | High |
| **Discord** | Yes (excellent) | Yes (discord.js) | Yes (subset) | Buttons, Components V2 | Yes (gateway WS) | No | No | Yes | Low |
| **Slack** | Yes (excellent) | Yes (Bolt) | mrkdwn (non-standard) | Block Kit buttons | Yes (Socket Mode) | No | No | Free tier limited | Medium |
| **Matrix** | Yes (open spec) | Yes (matrix-bot-sdk) | HTML/limited md | Reactions only (no buttons) | N/A (self-hosted) | Yes | Optional (Megolm) | Yes (OSS) | High |
| **WhatsApp** | Yes (Cloud API) | Yes (official) | No | Limited buttons | No (webhook required) | No | Yes (by default) | Partly free | Very High |
| **Mattermost** | Yes | Yes (@rocket.chat/sdk-style) | Markdown | Interactive buttons | N/A (self-hosted) | Yes | No (built-in) | Yes (OSS) | Medium-High |
| **Rocket.Chat** | Yes | Yes (@rocket.chat/sdk) | Markdown | Interactive buttons | N/A (self-hosted) | Yes | Optional | Yes (OSS) | Medium-High |

---

## Detailed Platform Analysis

### 1. Telegram

**Verdict: Best overall option for implementation simplicity and feature completeness.**

#### API/SDK Availability

Telegram has an excellent, well-documented [Bot API](https://core.telegram.org/bots/api) that is the gold standard for messaging bot platforms. Multiple mature TypeScript SDKs exist:

- **[grammY](https://grammy.dev/)** - Modern, TypeScript-first framework. Excellent type safety, plugin ecosystem, built-in keyboard helpers. This is the recommended choice.
- **[Telegraf](https://github.com/telegraf/telegraf)** - Mature, widely used, ships TypeScript declarations.
- **[node-telegram-bot-api](https://www.npmjs.com/package/node-telegram-bot-api)** - Lower-level wrapper.
- **[GramIO](https://gramio.dev/)** - Newer framework, works on Node.js, Bun, and Deno.

#### Bot/Automation Support

Creating a Telegram bot is trivially easy:
1. Message @BotFather on Telegram
2. Run `/newbot`, choose a name
3. Receive an API token
4. Start coding - no OAuth flow, no app review, no server infrastructure

#### Rich Messaging

- **MarkdownV2 parse mode**: bold, italic, underline, strikethrough, spoiler, inline code, code blocks with language-specific syntax highlighting, links, blockquotes
- **Inline keyboards**: buttons attached to messages with callback data (up to 64 bytes per button, up to 200 buttons per message)
- **Button styling**: custom emoji icons and color variants (added in recent API updates)
- **Callback queries**: when a user clicks a button, the bot receives a callback with the button's data
- No message length limit that would matter for agent responses (4096 chars for text messages, but messages can be split)

This makes Telegram ideal for escalation UI: send a message with two inline buttons ("Approve" / "Deny"), receive the callback when the user taps one.

#### Authentication/Setup Complexity

**Minimal.** Bot token is a single string. No OAuth, no webhook certificates needed with long polling. grammY's `bot.start()` handles everything.

#### Self-Hosting Requirements

Telegram itself cannot be self-hosted - it is a cloud service. The bot connects outbound to Telegram's servers. Two modes:

- **Long polling** (recommended for IronCurtain): bot pulls updates from Telegram. No public URL needed, no firewall rules, works behind NAT. Slightly higher latency (~1-2s) but perfectly acceptable.
- **Webhooks**: Telegram pushes updates to your URL. Requires public HTTPS endpoint. More efficient at scale but unnecessary for a single-user agent interaction.

#### Rate Limits

- 30 messages/second globally (more than sufficient for single-user agent interaction)
- 1 message/second per individual chat (ample for agent responses)
- 20 messages/minute per group
- Free, no paid tier needed

#### Security/Privacy

- **No E2EE for bot conversations** - Telegram's "Secret Chats" (E2EE) are not available for bots
- Messages are stored on Telegram's cloud servers
- Telegram has been criticized for its custom MTProto protocol rather than using Signal Protocol
- **However**: for an agent control channel, the threat model is different from personal messaging. The messages are tool call metadata and agent responses, not personal communications.

#### Licensing and Cost

Completely free. No usage fees, no premium tiers needed for bot functionality.

#### Implementation Sketch

```typescript
import { Bot, InlineKeyboard } from 'grammy';

class TelegramTransport implements Transport {
  private bot: Bot;
  private chatId: number; // authorized user's chat ID

  async run(session: Session): Promise<void> {
    this.bot.on('message:text', async (ctx) => {
      if (ctx.chat.id !== this.chatId) return; // single-user auth
      const response = await session.sendMessage(ctx.message.text);
      await ctx.reply(response, { parse_mode: 'MarkdownV2' });
    });

    // Escalation buttons
    this.bot.callbackQuery('approve', async (ctx) => {
      const pending = session.getPendingEscalation();
      if (pending) await session.resolveEscalation(pending.escalationId, 'approved');
    });

    await this.bot.start();
  }
}
```

#### Escalation UX

```
========================================
  ESCALATION: Human approval required
========================================
  Tool:      filesystem/write_file
  Arguments: {"path": "/etc/hosts"}
  Reason:    Write outside sandbox
========================================
  [Approve]   [Deny]
```

The inline keyboard buttons are rendered natively by Telegram clients on all platforms (iOS, Android, Desktop, Web).

---

### 2. Signal

**Verdict: Technically possible but significantly harder than alternatives. The lack of an official bot API is a fundamental obstacle. Worth pursuing only if Signal's privacy properties are a hard requirement.**

#### The Core Problem

Signal has **no official bot API** and has shown no public plans to create one. Signal's philosophy prioritizes end-user privacy, and a bot API would introduce server-side message processing that conflicts with their E2EE-everywhere stance. Every approach to building a Signal bot involves unofficial, potentially fragile workarounds.

#### Approach A: signal-cli + REST API (Most Viable)

[signal-cli](https://github.com/AsamK/signal-cli) (4.2k GitHub stars, actively maintained, latest release v0.13.24 on Feb 5, 2026) is the de facto standard for programmatic Signal access. [bbernhard/signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api) wraps it in a Docker container with a REST API.

**Setup steps:**
1. Run the Docker container: `docker run -p 8080:8080 bbernhard/signal-cli-rest-api`
2. Register a phone number (requires captcha + SMS/call verification):
   - `POST /v1/register/+1234567890`
   - Complete captcha at `https://signalcaptchas.org/registration/generate.html`
   - Verify with SMS code: `POST /v1/register/+1234567890/verify/123456`
3. OR link as secondary device (scan QR code from Signal mobile app)

**Receiving messages:**
- In `json-rpc` mode: WebSocket connection for real-time message delivery
- Webhook callback via `RECEIVE_WEBHOOK_URL` config
- SSE (Server-Sent Events) endpoint
- Polling the `/v1/receive` endpoint (least desirable)

**Sending messages:**
```
POST /v2/send
{
  "message": "Agent response here",
  "number": "+1234567890",
  "recipients": ["+0987654321"]
}
```

**Text formatting:**
Signal supports styled text (bold, italic, monospace, strikethrough, spoiler) but NOT Markdown syntax. signal-cli exposes this via:
- `--text-style` CLI flag: `"0:5:BOLD"` (start:length:style)
- JSON-RPC: `textStyles` array in request body
- REST API: `text_mode: "styled"` with `**bold**`, `*italic*`, `` `monospace` ``

This means IronCurtain would need a Markdown-to-Signal-styles converter, which is non-trivial for complex formatting. Code blocks with syntax highlighting are not supported - only monospace spans.

#### Approach B: signal-cli as Linked Device

Instead of registering a new number, signal-cli can link to an existing Signal account as a secondary device. This avoids needing a dedicated phone number but means:
- The primary device (your phone) must remain active
- The bot shares your identity - messages from the bot appear to come from you
- Not suitable for a dedicated bot identity

#### Approach C: Direct Node.js Libraries

Several Node.js libraries exist but all are thin wrappers around signal-cli:
- [signal-bot-node](https://github.com/Bentipa/signal-bot-node) - requires signal-cli daemon, "not ready for production"
- [signal-bot-nodejs](https://github.com/saveriocastellano/signal-bot-nodejs) - experimental, uses signal-cli HTTP daemon
- [signal-bot (npm)](https://www.npmjs.com/package/signal-bot) - requires signal-cli daemon mode

None of these are mature enough for production use.

#### Approach D: Chrome DevTools Automation

[mandatoryprogrammer/signal-bot](https://github.com/mandatoryprogrammer/signal-bot) hooks into Signal Desktop via Chrome DevTools protocol. This is creative but extremely fragile - it breaks with every Signal Desktop update and requires running a full Electron app.

#### Phone Number Requirement

**You cannot use Signal without a phone number.** Options:
- Dedicated SIM card (most reliable)
- Google Voice number (free, US-only, may be flagged by Signal's anti-fraud)
- Virtual number services (Freezvon, TextNow, etc.) - quality varies, some get blocked
- Landline number (Signal will call instead of SMS for verification)

The number must be able to receive SMS or calls for initial registration and periodic re-verification.

#### Interactive Elements (Escalation UI)

**Signal has no inline buttons, reactions-as-actions, or any interactive UI elements for bots.** The only option for escalation would be:
- Text-based commands: user replies with "approve" or "deny"
- Emoji reactions (Signal supports reactions, and signal-cli can send them, but parsing reaction responses is fragile)

This is a significant UX downgrade compared to Telegram's inline keyboards.

#### Security/Privacy Advantages

- Full E2EE (Signal Protocol, Megolm) - even signal-cli respects this
- Messages are not stored on any server after delivery
- Open source protocol and clients
- No metadata collection by Signal Foundation
- The strongest privacy properties of any option on this list

#### Challenges Summary

| Challenge | Severity | Mitigation |
|-----------|----------|------------|
| No official bot API | High | Use signal-cli REST API (community-maintained) |
| Phone number required | Medium | Dedicated SIM or virtual number |
| No inline buttons | High | Text-based escalation commands |
| No Markdown support | Medium | Convert to Signal text styles (limited) |
| signal-cli is Java-based | Low | Docker container abstracts this |
| Registration fragility | Medium | Captcha + rate limiting can block registration |
| signal-cli breaking changes | Medium | Pin Docker image versions |
| No code block formatting | High | Agent output will look degraded |

#### Architecture for Signal Transport

```
IronCurtain Process
  |
  +--> SignalTransport
         |
         +--> HTTP client --> signal-cli-rest-api (Docker)
                                |
                                +--> signal-cli (Java)
                                       |
                                       +--> Signal servers
```

The IronCurtain process would communicate with the signal-cli REST API over HTTP/WebSocket, adding a network hop and an external dependency (the Docker container) compared to Telegram's direct SDK integration.

---

### 3. Discord

**Verdict: Strong option with excellent developer experience. Good for users who already use Discord. Interactive components are first-class.**

#### API/SDK Availability

- [discord.js](https://discord.js.org/) - The dominant Node.js library (175k+ GitHub stars). Mature, excellent TypeScript support, covers the full API surface.
- [discordx](https://www.npmjs.com/package/discordx) - TypeScript decorator-based framework on top of discord.js.
- Official [Discord API documentation](https://discord.com/developers/docs) is thorough.

#### Bot/Automation Support

1. Create an application at [discord.com/developers](https://discord.com/developers/applications)
2. Add a bot user, copy the token
3. Generate an OAuth2 invite URL with appropriate permissions
4. Invite the bot to a server (guild)
5. Connect via gateway WebSocket - no public URL needed

#### Rich Messaging

- **Markdown**: Discord supports a subset of Markdown including bold, italic, strikethrough, inline code, code blocks with syntax highlighting, headers, lists, blockquotes, spoiler tags, and links
- **Embeds**: structured rich content with titles, descriptions, fields, colors, images, footers - up to 6,000 characters per embed
- **Components V2** (released March 2025): mixing text, media, and interactive components in a single message. Limit of 40 components per message.
- **Message length**: 2,000 characters (4,000 with Nitro). Agent responses would need chunking or embeds.

The 2,000-character message limit is a real constraint for agent output. Workarounds:
- Split long responses across multiple messages
- Use embeds (4,096 char description + fields)
- Send as file attachments for very long output

#### Interactive Elements (Escalation UI)

Discord's button support is excellent:
- Buttons come in 4 color styles (Primary/blue, Secondary/gray, Success/green, Danger/red)
- Up to 5 buttons per action row, 5 rows per message
- Callback with custom_id when clicked
- Ephemeral responses (only visible to the clicking user)

Perfect for escalation: green "Approve" button + red "Deny" button.

#### Authentication/Setup

- Bot token (single string)
- Must create a Discord server or have admin access to an existing one
- OAuth2 for inviting the bot to servers
- No public URL needed (gateway WebSocket connects outbound)

#### Rate Limits

- 50 requests/second to the API globally
- 120 gateway events per 60 seconds
- 1,000 IDENTIFY calls per 24 hours (connection establishment)
- Interaction responses do not count toward rate limits

More than sufficient for single-user agent interaction.

#### Security/Privacy

- No E2EE
- Messages stored on Discord's servers
- Discord is a US company subject to US law
- Bot must be in a Discord server - consider using a private server with only the bot and the user

#### Cost

Free. No paid tier needed for bot functionality.

#### Key Concern

Discord requires creating/joining a Discord server. For a security-focused tool, having agent output flowing through Discord's cloud servers is a privacy consideration, even in a private server.

---

### 4. Slack

**Verdict: Good option for teams already using Slack. Socket Mode eliminates the public server requirement. But the free tier is limited and the platform is workplace-oriented.**

#### API/SDK Availability

- [Bolt for JavaScript](https://github.com/slackapi/bolt-js) (@slack/bolt) - Official Slack framework. Well-maintained, TypeScript support, handles OAuth, events, and interactive components.
- Socket Mode eliminates the need for a public URL.

#### Rich Messaging

- **mrkdwn** (not standard Markdown): bold, italic, strikethrough, inline code, code blocks, links, lists, blockquotes. Notably missing: headers, nested formatting.
- **Block Kit**: Slack's structured message format with sections, dividers, images, actions, and input blocks. Very powerful for building interactive UIs.
- **Block Kit Builder**: visual tool for designing message layouts.

#### Interactive Elements

Block Kit provides:
- Buttons (primary, danger, default styles)
- Select menus, multi-selects
- Date pickers, time pickers
- Radio buttons, checkboxes
- Modals (dialog windows)
- Overflow menus

Excellent for escalation UI - even better than Telegram in terms of flexibility.

#### Socket Mode (No Public Server)

Socket Mode uses a WebSocket connection from the bot to Slack's servers. No public URL, no webhook endpoint, no SSL certificate. Perfect for running behind NAT/firewall.

Setup requires:
- App-Level Token (xapp-) for the socket connection
- Bot Token (xoxb-) for API calls
- Enable Socket Mode in app settings

#### Rate Limits

- Tier 1: 1 request/minute
- Tier 2: 20 requests/minute
- Tier 3: 50 requests/minute
- Tier 4: 100+ requests/minute
- Web API methods have individual tier assignments

For single-user interaction, these limits are fine.

#### Free Tier Limitations

- 90-day message history (older messages become inaccessible)
- 10 app/integration limit per workspace
- 5GB total file storage
- Data older than 1 year is deleted

For a dedicated IronCurtain workspace, the free tier should be adequate.

#### Cost (Paid)

- Pro: $7.25/user/month (minimum 3 users = $21.75/month even for 1-2 users)
- Business+: $12.50/user/month

#### Security/Privacy

- No E2EE
- Slack is a cloud service (Salesforce-owned)
- Enterprise Grid offers data residency options
- SOC 2, ISO 27001 certified

---

### 5. WhatsApp

**Verdict: Not recommended. The setup complexity, business verification requirements, webhook dependency, and limited interactive elements make it a poor fit.**

#### API/SDK Availability

- [Official WhatsApp Cloud API Node.js SDK](https://github.com/WhatsApp/WhatsApp-Nodejs-SDK) by Meta
- REST API (Graph API) at `graph.facebook.com`

#### Setup Complexity - Very High

1. Create a Meta Business Portfolio
2. Create a Meta App in the App Dashboard
3. Add WhatsApp product to the app
4. Complete business verification (requires legal entity documentation)
5. Get display name approved
6. Create a System User and generate a permanent access token
7. Set up a public HTTPS webhook endpoint for receiving messages
8. Configure webhook verification (hub.challenge handshake)

This is enterprise-grade onboarding for what should be a personal tool.

#### Rich Messaging

- **No Markdown support** - WhatsApp supports bold (`*text*`), italic (`_text_`), strikethrough (`~text~`), and monospace (`` ```text``` ``) in user messages, but the Business API's template/text messages have even more limited formatting.
- No code blocks with syntax highlighting.

#### Interactive Elements

- Quick Reply buttons (up to 3 buttons)
- Call-to-Action buttons (up to 2)
- List messages (up to 10 items in sections)

Limited compared to Telegram or Discord.

#### Webhook Requirement

WhatsApp Cloud API requires a publicly accessible HTTPS endpoint to receive messages. No long polling, no WebSocket, no Socket Mode equivalent. This means:
- You need a public server or tunnel (ngrok, Cloudflare Tunnel)
- SSL certificate required
- Must respond to Meta's webhook verification

#### Rate Limits and Pricing

- Free: service (customer-initiated) conversations within 24-hour window
- Marketing messages: ~$0.025/conversation
- Messaging tiers: starts at 1,000 users/day, scales with quality score
- Requires business verification to move beyond test mode

#### Why Not WhatsApp

- Requires a real business entity for verification
- Webhook requirement adds infrastructure complexity
- Limited formatting destroys agent output readability
- Only 3 quick reply buttons (fine for approve/deny, but no room for future expansion)
- Per-message pricing for bot-initiated conversations
- Phone number required (tied to WhatsApp Business account)

---

### 6. Matrix

**Verdict: Strong alignment with IronCurtain's security ethos. Self-hostable with optional E2EE. But lacks native interactive buttons, and the developer experience is rougher than commercial platforms.**

#### API/SDK Availability

- [matrix-bot-sdk](https://github.com/turt2live/matrix-bot-sdk) - TypeScript/JavaScript SDK specifically for bots. Actively maintained.
- [matrix-js-sdk](https://github.com/matrix-org/matrix-js-sdk) - Full client SDK (more complex, designed for Element-like clients).
- Matrix is an open standard with a [formal specification](https://spec.matrix.org/).

#### Self-Hosting

Matrix is designed for federation and self-hosting:
- **Synapse** (Python) - reference homeserver, most mature
- **Dendrite** (Go) - lighter alternative
- **Conduit** (Rust) - lightweight, single-binary

A minimal self-hosted setup (Synapse + PostgreSQL) can run on a small VPS or even a Raspberry Pi.

#### Rich Messaging

- Messages support HTML formatting (sent as `m.text` with `format: "org.matrix.custom.html"`)
- Clients render HTML, so you get: bold, italic, code, code blocks, headers, links, lists, tables
- No standardized Markdown parsing on the server side - you send HTML
- Element (the main client) renders this well, but other clients vary

#### Interactive Elements

**This is Matrix's biggest weakness for our use case.**

- **No native inline buttons in messages.** The Matrix spec does not have an equivalent to Telegram inline keyboards or Discord buttons.
- **Reactions**: users can react with arbitrary emoji. A bot could watch for thumbs-up/thumbs-down reactions, but this is clunky.
- **Polls (MSC3381)**: supported in Element, but polls are for multiple-choice questions, not approve/deny actions.
- **Widgets**: interactive HTML apps embedded in rooms. Powerful but heavyweight - requires serving a web app. Overkill for an approve/deny button.

For escalation, the practical options are:
1. Text commands ("reply with `approve` or `deny`")
2. Emoji reactions (watch for specific reactions)
3. Custom widget (significant implementation effort)

#### E2EE Support

- Matrix supports E2EE via Olm/Megolm protocols
- For bots, encryption adds complexity:
  - **matrix-bot-sdk** has built-in crypto support (must be enabled explicitly with an `ICryptoStorageProvider`)
  - **Pantalaimon** - E2EE-aware proxy daemon that handles encryption transparently for clients that don't support it
  - matrix-bot-sdk has a `PantalaimonClient` class for integration
- In E2EE rooms, the bot must participate in key exchange, manage device keys, handle key verification

#### Bot Setup

1. Create an account on your homeserver (or a public one like matrix.org)
2. Obtain an access token
3. Start the bot with matrix-bot-sdk
4. Bot auto-joins rooms when invited (via `AutojoinRoomsMixin`)

No app registration, no business verification, no phone number.

#### Security/Privacy

- Full E2EE when configured (strongest when self-hosted + E2EE)
- Self-hosted: you control all data
- Federated: can communicate with other Matrix servers
- Open source protocol, open source servers, open source clients
- **Best privacy story of all options** (when self-hosted with E2EE)

#### Cost

All server software is free and open source. Only cost is infrastructure for self-hosting.

#### Architecture

```
IronCurtain Process
  |
  +--> MatrixTransport (matrix-bot-sdk)
         |
         +--> Matrix homeserver (self-hosted Synapse/Dendrite)
                |
                +--> Matrix clients (Element on phone/desktop/web)
```

---

### 7. Mattermost

**Verdict: Viable self-hosted option with proper interactive message support. Good if the user already runs Mattermost. Not worth setting up from scratch just for IronCurtain.**

#### Overview

Mattermost is an open-source Slack alternative designed for self-hosting.

- **SDK**: [@rocket.chat/sdk-style npm packages](https://www.npmjs.com/package/mattermost-client-node), REST API, incoming/outgoing webhooks
- **Interactive messages**: buttons, menus, dialogs backed by HTTP POST callbacks
- **Markdown**: full Markdown support in messages
- **Self-hosted**: yes, that's the whole point
- **Free tier**: Community Edition is free and open source (MIT license)
- **Requires**: running a Mattermost server instance

Interactive messages in Mattermost work via HTTP POST callbacks to a URL you specify. This means your IronCurtain process needs to expose an HTTP endpoint for button click callbacks, or you need to set up a webhook relay.

---

### 8. Rocket.Chat

**Verdict: Similar to Mattermost. Self-hostable, open source, interactive messages. Same trade-off - not worth deploying just for IronCurtain.**

- **SDK**: [@rocket.chat/sdk](https://www.npmjs.com/package/@rocket.chat/sdk) - TypeScript interfaces, DDP and REST API support
- **Interactive messages**: buttons and actions
- **Markdown**: full Markdown support
- **Self-hosted**: yes, Docker or manual installation
- **Free tier**: Community Edition (MIT license)

---

### 9. XMPP/Jabber

**Verdict: Not recommended. Outdated ecosystem, no interactive elements, fragmented client support.**

- **SDK**: [xmpp.js](https://github.com/xmppjs/xmpp.js) - modern, handles reconnection, browser + Node.js
- **Interactive elements**: XMPP has no standard for inline buttons. Some extensions (XEP-0004 Data Forms) exist but client support is inconsistent.
- **Markdown**: no standard Markdown rendering across clients
- **Self-hosted**: yes (ejabberd, Prosody)
- **E2EE**: OMEMO protocol (Signal Protocol derivative)
- **Reality**: the XMPP ecosystem has shrunk significantly. Client quality varies wildly. Not a practical choice for 2026.

---

### 10. Zulip

**Verdict: Interesting for teams, but Python-centric bot framework and limited interactive widgets make it suboptimal.**

- **Bot API**: first-class, with interactive bot framework
- **Problem**: the bot framework is Python-only. No official Node.js/TypeScript SDK for interactive bots.
- **Interactive widgets**: "zforms" with buttons, but implemented server-side (no plugin model for custom widgets without forking)
- **Self-hosted**: yes, open source
- **Markdown**: excellent Markdown support with LaTeX, code blocks, syntax highlighting

The Python-only interactive bot framework is a dealbreaker for a TypeScript project.

---

## Signal Deep Dive: Making It Work

Since Signal is the preferred option, here is a more detailed engineering analysis of what a Signal transport would look like.

### Architecture

The most reliable approach uses signal-cli-rest-api in `json-rpc` Docker mode:

```
┌─────────────────────────────────────────────────┐
│ IronCurtain Host                                │
│                                                  │
│  ┌──────────────────┐  ┌──────────────────────┐ │
│  │ IronCurtain      │  │ signal-cli-rest-api   │ │
│  │ Process           │  │ (Docker container)    │ │
│  │                   │  │                       │ │
│  │ SignalTransport ──┼──┤ REST API (:8080)      │ │
│  │   (HTTP + WS)     │  │ WebSocket (messages)  │ │
│  │                   │  │                       │ │
│  └──────────────────┘  │ signal-cli (Java)     │ │
│                         │ JVM (~200-400MB RAM)  │ │
│                         └──────────┬───────────┘ │
│                                    │             │
└────────────────────────────────────┼─────────────┘
                                     │
                              Signal servers
                              (signal.org)
```

### Registration Flow

```
1. User runs: ironcurtain setup-signal
2. System starts signal-cli-rest-api container
3. Two options presented:
   a) Register new number:
      - User provides phone number
      - System opens captcha URL in browser
      - User completes captcha, pastes token
      - System calls POST /v1/register/{number} with captcha
      - User receives SMS, enters verification code
      - System calls POST /v1/register/{number}/verify/{code}
   b) Link to existing Signal account:
      - System opens QR code URL in browser
      - User scans QR code from Signal mobile app
      - Device is linked
4. Phone number stored in config
```

### Message Handling

```typescript
class SignalTransport implements Transport {
  private restApiUrl: string; // http://localhost:8080
  private senderNumber: string; // +1234567890
  private recipientNumber: string; // user's number

  async run(session: Session): Promise<void> {
    // Connect WebSocket for incoming messages
    const ws = new WebSocket(`ws://${this.restApiUrl}/v1/receive/${this.senderNumber}`);

    ws.on('message', async (data) => {
      const envelope = JSON.parse(data.toString());
      if (envelope.dataMessage?.message) {
        const userText = envelope.dataMessage.message;

        // Check for escalation commands
        if (this.handleEscalationReply(userText, session)) return;

        // Send to session
        const response = await session.sendMessage(userText);

        // Convert markdown to Signal styled text
        const { text, textStyles } = markdownToSignalStyles(response);

        // Send response
        await this.sendMessage(text, textStyles);
      }
    });
  }

  private async sendMessage(text: string, textStyles?: string[]): Promise<void> {
    await fetch(`${this.restApiUrl}/v2/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        number: this.senderNumber,
        recipients: [this.recipientNumber],
        text_mode: 'styled',
        // textStyles for JSON-RPC mode
      }),
    });
  }
}
```

### Formatting Conversion Challenge

Signal's text formatting is positional (`start:length:STYLE`), not markup-based. Converting Markdown to Signal styles requires:

1. Parse Markdown AST (using `marked` or `remark`)
2. Render to plain text while tracking character positions
3. Generate `textStyles` array with position-based style annotations
4. Handle nested styles (bold + italic = two overlapping style ranges)

Code blocks would be rendered as MONOSPACE spans. No syntax highlighting. No headings (would need to fake with BOLD). No tables. No images.

**Example conversion:**

```markdown
## Tool Result

The file `config.json` was **successfully** written.

```json
{"key": "value"}
```
```

Becomes:
```
Tool Result

The file config.json was successfully written.

{"key": "value"}
```
With textStyles: `["0:11:BOLD", "16:11:MONOSPACE", "32:12:BOLD", "56:18:MONOSPACE"]`

This is a significant quality degradation for agent output.

### Escalation Without Buttons

```
========================================
ESCALATION: Human approval required
========================================
Tool:      filesystem/write_file
Arguments: {"path": "/etc/hosts"}
Reason:    Write outside sandbox
========================================
Reply "approve" or "deny"
========================================
```

The transport watches for text replies matching "approve" or "deny" (case-insensitive). This works but is less discoverable and more error-prone than tapping a button.

### Operational Concerns

1. **signal-cli JVM memory**: 200-400MB for the Java process. This is a heavy dependency.
2. **Registration can break**: Signal's anti-fraud measures may block registration attempts, especially from VPS IP ranges or virtual numbers.
3. **signal-cli updates**: Signal changes its server protocol periodically. When they do, old signal-cli versions stop working. The error is often "signal-cli version is too old for the Signal-Server." This requires updating the Docker image.
4. **Account linking instability**: Signal periodically requires re-linking or re-verification of secondary devices.
5. **Single device constraint**: signal-cli registered as a primary device will de-register your phone app. As a linked device, it depends on the primary device being active.

---

## Security Analysis: Telegram

A deeper investigation into Telegram's security raised concerns relevant to a security-first project:

- **No E2EE for bot conversations.** Regular chats use server-side encryption only - Telegram holds the keys. Secret Chats offer E2EE but are unavailable for bots.
- **Custom cryptography (MTProto).** A 2022 formal verification found MTProto 2.0 logically sound, but it hasn't undergone the independent scrutiny of Signal Protocol. No published third-party security audits.
- **Closed-source servers.** Client code is open source, but server code is not.
- **Russian infrastructure ties.** A 2025 investigation found key parts of Telegram's network operated by companies with ties to Russian state institutions including the FSB.
- **Metadata exposure.** MTProto includes an unencrypted `auth_key_id` that identifies a specific device. Telegram may share IP addresses and phone numbers upon court order.

For IronCurtain, the messages flowing through a transport include task instructions, agent output, codebase paths, and escalation details. Recommending Telegram as the primary transport would undermine a security-first project's credibility.

## Matrix: Practical Considerations

Matrix is architecturally aligned with IronCurtain's security values (self-hostable, optional E2EE, open protocol) but has practical hurdles:

- **Client app:** Element (iOS, Android, desktop, web) is the primary client. FluffyChat and SchildiChat are alternatives.
- **Reachability:** Your phone must reach the homeserver. Options: VPS ($5/month), Tailscale mesh (free), or Cloudflare Tunnel (free).
- **Lightweight servers:** Conduit (Rust, single binary, ~10MB RAM) makes self-hosting practical on minimal hardware.
- **No inline buttons:** Escalation UX relies on text commands or emoji reactions - workable but less polished.

---

## Decision: Signal as Primary Transport

After evaluating all options, **Signal is the chosen primary transport for IronCurtain.**

### Rationale

Every other agent framework will reach for Telegram or Slack because they're easy. Choosing Signal makes a statement: IronCurtain takes security seriously enough to do the hard thing. This aligns with the project's core identity as a security-first agent runtime.

- **Strongest privacy properties** of any messaging platform - full E2EE, no metadata collection, open source protocol
- **Differentiated feature** - no competing agent framework offers Signal as a transport
- **User trust** - security-conscious users (IronCurtain's target audience) already use Signal
- **Operational overhead is manageable** with good engineering: Docker container for signal-cli with host-mounted volumes for persistence, automated image rebuilds, and a smooth interactive onboarding experience

The UX trade-offs (no inline buttons, limited formatting) are real but acceptable. Text-based escalation commands work. Monospace formatting covers essential code output needs.

### Mitigations for Known Challenges

| Challenge | Mitigation |
|-----------|------------|
| signal-cli updates when Signal changes protocol | Regular Docker image rebuilds; pin + test before upgrading |
| Registration data lost on container rebuild | Host-mounted volume for signal-cli data directory |
| Phone number + captcha registration | Smooth interactive terminal onboarding (`ironcurtain setup-signal`) |
| No inline buttons for escalation | Text-based "approve"/"deny" replies; clear formatting |
| Limited text formatting | Markdown-to-Signal-styles converter; monospace for code |
| JVM memory overhead (200-400MB) | Acceptable for a background service; document requirements |

### Future Transports

Signal is the primary transport. Additional transports may follow based on demand:

1. **Matrix** - for users who want self-hosted infrastructure and button-capable clients
2. **Telegram** - for users who prefer convenience over privacy
3. **Discord** - for developer communities

### Shared Abstraction Layer

All messaging transports share common needs:

```typescript
interface MessagingCapabilities {
  markdown: boolean;        // can render Markdown natively
  inlineButtons: boolean;   // can attach buttons to messages
  codeBlocks: boolean;      // can render code with syntax highlighting
  maxMessageLength: number; // chars before message must be split
  reactions: boolean;       // can monitor emoji reactions
}

// Shared utilities
function splitMessage(text: string, maxLength: number): string[];
function formatEscalationText(request: EscalationRequest): string;
function markdownToSignalStyles(markdown: string): { text: string; styles: string[] };
```

---

## Sources

### Signal
- [AsamK/signal-cli (GitHub)](https://github.com/AsamK/signal-cli)
- [bbernhard/signal-cli-rest-api (GitHub)](https://github.com/bbernhard/signal-cli-rest-api)
- [signal-cli-rest-api API docs](https://bbernhard.github.io/signal-cli-rest-api/)
- [signal-cli Registration with captcha](https://github.com/AsamK/signal-cli/wiki/Registration-with-captcha)
- [signal-cli Linking other devices](https://github.com/AsamK/signal-cli/wiki/Linking-other-devices-(Provisioning))
- [signal-cli text formatting discussion](https://github.com/AsamK/signal-cli/discussions/878)
- [Signal Text Formatting support page](https://support.signal.org/hc/en-us/articles/6325622209178-Text-Formatting)

### Telegram
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [grammY framework](https://grammy.dev/)
- [Telegraf (GitHub)](https://github.com/telegraf/telegraf)
- [grammY Long Polling vs Webhooks](https://grammy.dev/guide/deployment-types)
- [grammY Inline Keyboard plugin](https://grammy.dev/plugins/keyboard)
- [Telegram Bot API rate limits FAQ](https://core.telegram.org/bots/faq)

### Discord
- [discord.js](https://discord.js.org/)
- [Discord Gateway docs](https://docs.discord.com/developers/events/gateway)
- [Discord Components V2](https://cybrancee.com/blog/the-future-of-discord-components-v2/)
- [Discord rate limits](https://discord.com/developers/docs/topics/rate-limits)

### Slack
- [Slack Bolt for JavaScript](https://github.com/slackapi/bolt-js)
- [Slack Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)
- [Slack Block Kit](https://docs.slack.dev/block-kit/)
- [Slack free tier limitations](https://slack.com/help/articles/27204752526611-Feature-limitations-on-the-free-version-of-Slack)

### WhatsApp
- [WhatsApp Cloud API Node.js SDK (GitHub)](https://github.com/WhatsApp/WhatsApp-Nodejs-SDK)
- [WhatsApp Business Platform pricing](https://business.whatsapp.com/products/platform-pricing)

### Matrix
- [matrix-bot-sdk (GitHub)](https://github.com/turt2live/matrix-bot-sdk)
- [matrix-js-sdk (GitHub)](https://github.com/matrix-org/matrix-js-sdk)
- [Matrix SDKs page](https://matrix.org/ecosystem/sdks/)
- [matrix-bot-sdk encryption tutorial](https://turt2live.github.io/matrix-bot-sdk/tutorial-encryption.html)
- [Pantalaimon (GitHub)](https://github.com/matrix-org/pantalaimon)

### Mattermost
- [Mattermost interactive messages](https://developers.mattermost.com/integrate/plugins/interactive-messages/)
- [Mattermost API docs](https://api.mattermost.com/)

### Rocket.Chat
- [Rocket.Chat.js.SDK (GitHub)](https://github.com/RocketChat/Rocket.Chat.js.SDK)
