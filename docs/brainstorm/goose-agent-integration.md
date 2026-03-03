# Goose Agent Integration — Research

**Date:** 2026-03-03
**Status:** Research
**Purpose:** Evaluate Goose (by Block) as a second agent for IronCurtain's Docker Agent Mode

## Context

IronCurtain currently supports Claude Code as its only Docker Agent Mode agent. Adding Goose would validate the "agent-framework agnostic" claim and expand IronCurtain's audience to the Goose community. The `AgentAdapter` interface was designed for this extensibility — the interface comment already says "Claude Code, Goose, etc."

---

## What is Goose?

**Goose** (codename goose) is an open-source, extensible AI agent built by Block (Square, Cash App, Afterpay, TIDAL).

- **GitHub**: [github.com/block/goose](https://github.com/block/goose) — 32,284 stars
- **Latest release**: v1.26.1 (2026-02-27)
- **Language**: Rust (backend/CLI) + TypeScript/React (desktop)
- **License**: Apache 2.0
- **Foundation**: Donated to the Linux Foundation's [Agentic AI Foundation (AAIF)](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation) alongside Anthropic's MCP and OpenAI's AGENTS.md
- **Scope**: Goes beyond code suggestions — builds projects, writes/executes/edits code, debugs, orchestrates workflows, interacts with external APIs

Comparable to Claude Code or Cursor Agent but provider-agnostic and fully open source.

---

## Architecture

Three components:
1. **Interface**: CLI (`goose`) or Electron Desktop app
2. **Agent**: Core Rust agent loop managing LLM interaction
3. **Extensions**: MCP servers providing tools/capabilities

Agent loop: user request → LLM with tool list → tool calls via MCP → results back to LLM → repeat until done.

---

## MCP Integration

**Goose is a native MCP client.** Its entire extension system is built on MCP.

**Supported transports**: stdio, Streamable HTTP, SSE, Docker containers, builtin (compiled into `goose-mcp` Rust crate)

**Tool discovery**: Automatic via `tools/list` when an extension is enabled.

**Extension configuration** in `~/.config/goose/config.yaml`:
```yaml
extensions:
  my-server:
    name: My MCP Server
    cmd: some-command
    args: ["arg1", "arg2"]
    enabled: true
    type: stdio
    timeout: 300
```

---

## LLM Provider Support

25+ providers including:
- Anthropic (Claude), OpenAI, Google Gemini, Groq, xAI
- AWS Bedrock, Azure OpenAI, GCP Vertex AI, Databricks, Snowflake
- Ollama, Docker Model Runner, Ramalama (fully local/free)
- OpenRouter, LiteLLM (gateway/proxy services)

**Custom endpoints**: `OPENAI_HOST`/`OPENAI_BASE_PATH` and `ANTHROPIC_HOST` for routing to any compatible API, including MITM proxies.

**Key storage**: OS keychain via `keyring` Rust crate. Environment variables take priority over keychain (important for Docker).

---

## Execution Modes

- **Interactive**: `goose session` — conversational terminal UI
- **Headless**: `goose run -t "task"` — non-interactive, one-shot execution
- **Headless (no state)**: `goose run --no-session -t "task"`
- **Docker**: `docker run ghcr.io/block/goose:v1.26.1 run -t "task"`

Key environment variables for headless:
- `GOOSE_MODE=auto` — no permission prompts
- `GOOSE_MAX_TURNS=50` — prevents runaway execution
- `GOOSE_CONTEXT_STRATEGY=summarize` — manages token limits

---

## Permission Model

Four modes:

| Mode | Behavior |
|------|----------|
| Autonomous (default) | Full access, no approval needed |
| Smart Approval | Risk-based — auto-approves reads, flags writes |
| Manual Approval | Requires confirmation for all tool usage |
| Chat Only | No file modifications or tool execution |

Per-tool permissions: Always Allow, Ask Before, Never Allow.

**Headless limitation**: Cannot prompt for permission in headless mode. `GOOSE_MODE=auto` is required for containerized usage.

---

## Docker Agent Mode Compatibility

### How It Would Work

The same architecture as Claude Code:

1. Container runs with `--network=none`
2. MITM proxy on host intercepts LLM API calls via UDS
3. Goose inside container uses fake API key; MITM proxy swaps for real one
4. MCP proxy on host mediates tool calls via UDS + socat bridge

### LLM API Routing

Goose supports custom API hosts:
- `ANTHROPIC_HOST=http://localhost:PORT` → socat bridge to MITM proxy UDS
- `OPENAI_HOST=http://localhost:PORT` → same pattern
- Uses native cert store (since PR #1923) → custom CA certs for MITM work

### MCP Proxy Connection

```yaml
# ~/.config/goose/config.yaml inside container
extensions:
  ironcurtain:
    name: IronCurtain
    cmd: socat
    args: ["STDIO", "UNIX-CONNECT:/run/ironcurtain/proxy.sock"]
    enabled: true
    type: stdio
    timeout: 300
```

Structurally identical to how Claude Code connects — socat bridges stdio to the UDS, MCP proxy sees a normal client.

### Fake Key Swap

Environment variables take priority over keychain. Setting `ANTHROPIC_API_KEY=<fake>` or `OPENAI_API_KEY=<fake>` as container env vars works. The MITM proxy swaps fake for real.

---

## GooseAgentAdapter Implementation

Would implement the `AgentAdapter` interface (`src/docker/agent-adapter.ts`):

| Method | Goose Implementation |
|--------|---------------------|
| `getImage()` | `ghcr.io/block/goose:v1.26.1` or custom image with CA cert + socat |
| `generateMcpConfig()` | Write `~/.config/goose/config.yaml` with socat stdio extension |
| `generateOrientationFiles()` | Config yaml, CA cert install script |
| `buildCommand()` | `goose run --no-session -t "message"` |
| `buildSystemPrompt()` | Via `--with-instructions` or recipe files |
| `getProviders()` | Return Anthropic/OpenAI/Google depending on configured provider |
| `buildEnv()` | `GOOSE_PROVIDER`, `GOOSE_MODEL`, fake API key, `GOOSE_MODE=auto` |
| `extractResponse()` | Parse Goose's text output (no JSON output mode) |
| `buildPtyCommand()` | socat bridge + `goose session` for interactive mode |

### Engineering Challenges

1. **Response parsing** — Goose has no `--output-format json`. Need to parse text stdout. This is the biggest gap.
2. **Multi-provider MITM** — Need MITM proxy configs for whichever LLM provider Goose uses (Anthropic, OpenAI, Google, etc.). IronCurtain's `ProviderConfig` system already defines these.
3. **Custom Docker image** — Official image needs socat and IronCurtain CA cert added.
4. **System prompt injection** — Goose supports `--with-instructions` flag or recipe files for system prompts.
5. **TLS certificates** — Goose uses native cert store. Install CA cert in `/usr/local/share/ca-certificates/` + `update-ca-certificates`.

### What Makes It Easier

- Native MCP client — no adaptation layer needed for tool calls
- Headless mode with `GOOSE_MODE=auto` — fits IronCurtain's turn-based model
- Official Docker image — `ghcr.io/block/goose` (~340MB, Debian slim, non-root UID 1000)
- Custom API endpoints — `OPENAI_HOST`/`ANTHROPIC_HOST` env vars
- `AgentAdapter` interface was designed for this

---

## Compatibility Summary

| Criterion | Rating | Notes |
|-----------|--------|-------|
| MCP support | Excellent | Native MCP client, stdio transport works directly |
| `--network=none` | Feasible | Needs MITM proxy for LLM API + custom CA cert |
| Headless mode | Good | `goose run -t` with `GOOSE_MODE=auto` |
| Fake key swap | Good | Env vars override keyring |
| Custom LLM endpoint | Good | `OPENAI_HOST`, `ANTHROPIC_HOST` supported |
| Docker image | Available | Official `ghcr.io/block/goose` |
| TLS/CA certs | Good | Uses native cert store |
| PTY mode | Feasible | `goose session` for interactive use |
| Response parsing | Needs work | No JSON output mode; text parsing required |
| Multi-provider | Excellent | 25+ providers |

---

## Strategic Value

- **Validates "agent-agnostic"** — proves IronCurtain works with any MCP-speaking agent, not just Claude Code
- **Expands audience** — 32k GitHub stars community, different from Claude Code users
- **Open source alignment** — Apache 2.0 + Linux Foundation backing
- **Multi-provider** — users can bring their own LLM (Ollama for local, OpenAI, etc.)
- **Moderate effort** — adapter interface was designed for this; MCP proxy and MITM infrastructure already exist

---

## Sources

- [block/goose on GitHub](https://github.com/block/goose)
- [Goose Architecture](https://block.github.io/goose/docs/goose-architecture/)
- [Goose LLM Providers](https://block.github.io/goose/docs/getting-started/providers/)
- [Goose Extensions](https://block.github.io/goose/docs/getting-started/using-extensions/)
- [Goose Headless Mode](https://block.github.io/goose/docs/tutorials/headless-goose/)
- [Goose Permission Modes](https://block.github.io/goose/docs/guides/goose-permissions/)
- [Goose v1.25.0 Sandboxing](https://block.github.io/goose/blog/2026/02/23/goose-v1-25-0/)
- [Running Goose in Containers](https://dev.to/agasta/running-goose-in-containers-without-losing-your-mind-3m8)
- [Building AI Agents with Goose and Docker](https://www.docker.com/blog/building-ai-agents-with-goose-and-docker/)
- [Linux Foundation AAIF Announcement](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation)
