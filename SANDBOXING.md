# Sandboxing Architecture

IronCurtain uses defense-in-depth to contain untrusted AI agents. No single layer is assumed to be sufficient -- each layer catches what the others miss. This document describes how the layers work together.

## Two Session Modes

IronCurtain supports two session modes that share the same policy engine but differ in how the agent runs:

- **Builtin Agent (Code Mode)** - IronCurtain's own LLM agent writes TypeScript snippets that execute in a V8 sandbox. The agent has no direct system access; every interaction goes through MCP tool calls that are policy-checked. IronCurtain controls the agent, the sandbox, and the policy engine.

- **Docker Agent Mode** - An external agent (Claude Code, Goose, etc.) runs inside a Docker container with `--network=none`. The agent has its own LLM loop and tool-calling mechanism - IronCurtain doesn't control the agent's execution. Instead, IronCurtain mediates the agent's external access: LLM API calls go through a TLS-terminating MITM proxy, and MCP tool calls go through the same policy engine used by Code Mode.

The layers below apply differently depending on the session mode. Layers 1 and 2 are Docker Agent Mode only. Layer 3 applies to both modes. Layer 4 applies to MCP servers in both modes.

## The Threat Model

The AI agent is **untrusted**. It may be compromised via prompt injection, multi-turn drift, or adversarial inputs from external sources (emails, web pages, code). IronCurtain assumes the worst and enforces security boundaries that the agent cannot bypass regardless of its intent.

## Four Layers of Defense

```
┌──────────────────────────────────────────────────────────┐
│  Layer 1: Docker Container (--network=none)              │
│  Process isolation, filesystem isolation, no network     │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Layer 2: TLS-Terminating MITM Proxy               │  │
│  │  Credential protection, endpoint filtering         │  │
│  │  Real credentials never enter the container        │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Layer 3: MCP Policy Engine                        │  │
│  │  Per-tool-call allow/deny/escalate decisions       │  │
│  │  Compiled from human-readable constitution         │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Layer 4: OS-Level Sandbox (bubblewrap/srt)        │  │
│  │  Per-MCP-server filesystem and network isolation   │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### Layer 1: Docker Container _(Docker Agent Mode only)_

The agent process runs inside a Docker container with strong isolation:

- **`--network=none`** -- The container has no network interface. No IP connectivity at all. The agent cannot make outbound connections, scan the network, or reach any service.
- **`--cap-drop=ALL`** -- All Linux capabilities are dropped. No privilege escalation.
- **Non-root user** -- The container runs as the `codespace` user (uid 1000), not root.
- **Volume mounts** -- Only the session sandbox directory is writable. Orientation files and proxy sockets are read-only.

The only way the agent can communicate with the outside world is through two bind-mounted Unix domain sockets: the MCP proxy (for tool calls) and the MITM proxy (for LLM API calls).

#### macOS: Sidecar-Based Network Isolation

On macOS, Docker Desktop's VirtioFS does not support Unix domain sockets in bind mounts. IronCurtain falls back to TCP transport: the MCP and MITM proxies listen on TCP ports on the host.

To maintain network isolation equivalent to Linux's `--network=none`, IronCurtain uses a socat sidecar container:

1. The agent container runs on a Docker `--internal` bridge network with no default route and iptables DROP rules — no internet egress is possible.
2. A lightweight socat sidecar connects to both the default `bridge` network (host-reachable) and the `--internal` network (app-facing). It forwards only the two required proxy ports (MCP and MITM).
3. The agent container resolves `host.docker.internal` to the sidecar's IP on the internal network, so proxy traffic routes through the sidecar while all other connectivity is blocked.

The agent cannot reach the host gateway or any host service directly — it can only reach the two proxy ports forwarded by the sidecar. This provides the same security guarantee as Linux's `--network=none`: the only way out is through IronCurtain's proxies.

If the connectivity check fails at startup, IronCurtain aborts session initialization rather than falling back to a less secure network configuration.

### Layer 2: TLS-Terminating MITM Proxy _(Docker Agent Mode only)_

The agent needs to call its LLM provider's API (e.g., Anthropic's `/v1/messages`). Since the container has no network, these requests go through a MITM proxy running on the host.

**Credential protection:** Real credentials (API keys or OAuth tokens) never enter the container. The agent receives a randomly generated fake sentinel key. The MITM proxy validates the fake key and swaps it for the real credential before forwarding upstream. Even if the agent is fully compromised, it cannot exfiltrate the real credentials because it never has access to them.

**How it works:**

1. On first run, IronCurtain generates a self-signed CA certificate. The certificate (not the private key) is baked into the Docker image via `update-ca-certificates`.
2. The proxy listens on a Unix domain socket, bind-mounted into the container. Inside the container, `socat` bridges a local TCP port to the UDS so that standard `HTTPS_PROXY` environment variables work.
3. When the agent makes an HTTPS request, the proxy:
   - Checks the target hostname against the provider allowlist (e.g., only `api.anthropic.com`)
   - Terminates TLS using a dynamically generated certificate signed by the IronCurtain CA
   - Validates the HTTP method and path against the endpoint allowlist (e.g., only `POST /v1/messages`)
   - Validates the fake sentinel key and swaps it for the real API key
   - Forwards the request to the upstream API and streams the response back

**What this blocks:**

- Requests to non-allowlisted hosts (403 at CONNECT)
- Requests to non-allowlisted endpoints on allowed hosts (403 at HTTP layer)
- Requests with wrong or missing fake keys (403)
- Any attempt to extract the real API key (it exists only in host process memory)

### Layer 3: MCP Policy Engine _(both modes)_

All external operations beyond LLM API calls -- filesystem access, git operations, network fetch, etc. -- go through MCP (Model Context Protocol) tool calls. Every tool call passes through a policy engine before reaching the real MCP server.

The policy is compiled from a human-readable **constitution** -- a short document describing what the agent is and isn't allowed to do. The compilation pipeline translates English intent into deterministic JSON rules that are enforced without further LLM involvement at runtime.

Policy decisions are:

- **Allow** -- The tool call proceeds.
- **Deny** -- The tool call is blocked (default when no rule matches).
- **Escalate** -- The user is prompted for approval before proceeding.

Structural invariants are enforced regardless of compiled rules: protected system paths are always denied, unknown tools are always denied, and path traversal/symlink escape attempts are neutralized by resolving to canonical real paths before comparison.

See the [README](README.md) for details on the policy compilation pipeline.

### Layer 4: OS-Level Sandbox (bubblewrap/srt) _(both modes)_

MCP server processes themselves can be sandboxed using `@anthropic-ai/sandbox-runtime` (`srt`). Each sandboxed MCP server runs in its own `srt` process with independent:

- **Filesystem restrictions** -- Write access limited to the session sandbox directory.
- **Network isolation** -- Per-server network proxy infrastructure. Servers that don't need network access get none.
- **Process isolation** -- Linux namespaces via bubblewrap.

This layer catches threats that the policy engine cannot see: compromised MCP servers, indirect code execution through tool calls, and side-channel attacks from within server processes.

See [docs/designs/execution-containment.md](docs/designs/execution-containment.md) for the full design specification.

## How the Layers Interact

Each layer addresses a different class of threat:

| Threat                            | Layer 1 (Docker) | Layer 2 (MITM)  | Layer 3 (Policy)  | Layer 4 (srt) |
| --------------------------------- | :--------------: | :-------------: | :---------------: | :-----------: |
| Network exfiltration              |     Blocked      |    Filtered     |        N/A        |    Blocked    |
| Credential theft                  |       N/A        |    Prevented    |        N/A        |      N/A      |
| Unauthorized file access          |    Contained     |       N/A       |      Blocked      |   Contained   |
| Unauthorized git operations       |       N/A        |       N/A       | Blocked/Escalated |      N/A      |
| Compromised MCP server            |       N/A        |       N/A       |        N/A        |   Contained   |
| Prompt injection → bad tool calls |       N/A        |       N/A       | Blocked/Escalated |      N/A      |
| Excessive API spending            |       N/A        | Endpoint filter |   Budget limits   |      N/A      |

No single layer handles everything. A prompt-injected agent might try to exfiltrate data via an API call, but Layer 2 blocks non-allowlisted endpoints. It might try to read sensitive files, but Layer 3 enforces the policy. It might try to exploit an MCP server, but Layer 4 contains the blast radius.

## Design Documents

- [Docker Agent Broker](docs/design/docker-agent-broker.md) -- Full design for the Docker container + MITM proxy architecture
- [TLS-Terminating API Proxy](docs/design/tls-terminating-api-proxy.md) -- Detailed MITM proxy design
- [Execution Containment](docs/designs/execution-containment.md) -- OS-level sandboxing via bubblewrap/srt
- [Security Concerns](docs/SECURITY_CONCERNS.md) -- Known threats, attack vectors, and residual risks
