# Docker Agent Broker Design Specification

## 1. Overview

IronCurtain currently runs a built-in agent loop (Vercel AI SDK + UTCP Code Mode) that generates tool calls mediated by the MCP proxy's policy engine. This design extends IronCurtain to act as a **broker for external coding agents** -- Claude Code, Goose, OpenCode, Codex, and others -- running inside heavily restricted Docker containers.

The core insight is that IronCurtain's value is not the agent loop itself but the **policy-mediated MCP proxy** sitting between the agent and the outside world. By decoupling the agent from the policy enforcement layer, we can run any MCP-native agent inside a sandboxed Docker container where:

- The agent has **free reign within its per-session sandbox directory** (volume-mounted)
- The agent has **no network access** (`--network=none`) — only LLM API calls are allowed, via a TLS-terminating MITM proxy on a Unix domain socket
- All other external operations (filesystem outside sandbox, git, network fetch, etc.) are mediated through **MCP tools exposed via IronCurtain's policy engine**
- Per-agent **orientation files** teach the agent about the MCP-mediated environment

This architecture creates a two-layer defense:
1. **Docker + MITM proxy** sandboxes the entire agent process (no network access, LLM API calls filtered and key-swapped by TLS-terminating proxy, filesystem isolation, process isolation)
2. **IronCurtain's policy engine** mediates every external operation at the MCP protocol level

The built-in agent loop remains as a first-class option. The Docker broker is an alternative session type that implements the same `Session` interface.

**Transport transparency** is a core design principle. The existing transport layer (e.g., `CliTransport`) must work identically regardless of which session type it is driving. The transport calls `session.sendMessage()`, receives diagnostic events via callbacks, handles escalations via the same slash commands — and never knows whether the session is running a built-in agent loop or a Docker container. The Docker container is an implementation detail hidden behind the `Session` interface.

## 2. Architecture

### High-Level Component Diagram

```
                          IronCurtain Broker (Host Process)
                         +--------------------------------------+
                         |                                      |
                         |  Session Manager                     |
                         |    |                                 |
                         |    +-- AgentSession (built-in)       |
                         |    |     Uses UTCP Code Mode         |
                         |    |     + MCP Proxy via stdio       |
                         |    |                                 |
                         |    +-- DockerAgentSession             |
                         |          |                           |
                         |          +-- Docker Container        |
                         |          |     Lifecycle Manager     |
                         |          |                           |
                         |          +-- MCP Proxy Server        |
                         |          |     (per-session, UDS)    |
                         |          |                           |
                         |          +-- MITM Proxy              |
                         |          |     (per-session, UDS)    |
                         |          |     TLS-terminating,      |
                         |          |     endpoint filtering,   |
                         |          |     API key swap          |
                         |          |                           |
                         |          +-- Escalation Watcher      |
                         |          +-- Result Collector        |
                         |                                      |
                         +--------------------------------------+
                              |                          |
               Unix Domain Socket              Unix Domain Socket
               (MCP tool calls)                (MITM proxy)
                              |                          |
                         +--------------------------------------+
                         |  Docker Container (per-session)      |
                         |  --network=none                      |
                         |  (no external network access)        |
                         |                                      |
                         |  /workspace/  (volume: sandbox dir)  |
                         |  /etc/ironcurtain/  (orientation)    |
                         |  /run/ironcurtain/proxy.sock  (UDS)  |
                         |  /run/ironcurtain/mitm-proxy.sock    |
                         |                                      |
                         |  HTTPS_PROXY=http://127.0.0.1:18080  |
                         |  (socat bridges TCP→UDS internally)  |
                         |                                      |
                         |  Agent Process                       |
                         |    (Claude Code / Goose / etc.)      |
                         |    MCP tools via UDS proxy           |
                         |    LLM API via MITM proxy            |
                         |    (fake sentinel API key, never     |
                         |     sees real credentials)           |
                         +--------------------------------------+
```

### Data Flow for a Tool Call

```
1. Agent (in container) wants to read /home/user/Documents/report.pdf
2. Agent calls MCP tool: filesystem.read_file({ path: "/home/user/Documents/report.pdf" })
3. MCP client in container connects to /run/ironcurtain/proxy.sock
4. Request travels over UDS to host-side MCP Proxy Server
5. PolicyEngine evaluates: read outside sandbox -> escalate
6. Escalation IPC -> user approves via CLI
7. Proxy forwards to real filesystem MCP server on host
8. Result returns over UDS to agent in container
9. Agent processes the file content
```

### Transport Transparency

```
Transport (e.g., CliTransport)
  |
  +-- session.sendMessage(userMessage) --> response string
  +-- onDiagnostic callback            <-- tool_call, agent_text, budget_warning, ...
  +-- onEscalation callback            <-- escalation request
  +-- session.resolveEscalation()      --> approve/deny
  +-- session.getBudgetStatus()        --> budget snapshot
  +-- session.close()                  --> cleanup
```

The transport sees the **same `Session` interface** regardless of whether `sendMessage()` is fulfilled by the built-in agent loop (AI SDK + UTCP Code Mode) or by a Docker container running Claude Code. All session state — turns, diagnostics, escalations, budget — flows through the same callbacks and methods. No transport code changes are needed.

### Comparison: Built-in vs Docker Agent Sessions

```
Built-in AgentSession:
  AI SDK -> execute_code -> UTCP Code Mode -> MCP Proxy (stdio) -> MCP Servers

DockerAgentSession:
  Docker Container -> Agent -> MCP Client -> MCP Proxy (UDS) -> MCP Servers
```

The right half of the pipeline (MCP Proxy -> MCP Servers) is identical. The left half changes from "AI SDK + V8 sandbox" to "Docker container + external agent." The policy engine, compiled rules, audit log, escalation handling, and MCP server management are all reused without modification. Critically, the **transport layer is completely unaffected** — `CliTransport.run(session)` works identically for both session types.

## 3. Session Abstraction

### Unified Session Interface

Both session types implement the existing `Session` interface from `src/session/types.ts`. The critical observation is that the `Session` interface is already abstract enough -- it models a conversation, not an agent implementation.

```typescript
// src/session/types.ts -- EXISTING, unchanged
export interface Session {
  getInfo(): SessionInfo;
  sendMessage(userMessage: string): Promise<string>;
  getHistory(): readonly ConversationTurn[];
  getDiagnosticLog(): readonly DiagnosticEvent[];
  resolveEscalation(escalationId: string, decision: 'approved' | 'denied'): Promise<void>;
  getPendingEscalation(): EscalationRequest | undefined;
  getBudgetStatus(): BudgetStatus;
  close(): Promise<void>;
}
```

For Docker agent sessions, `sendMessage()` has different semantics internally:

- The **first call** starts the agent container with the user's message as the initial task
- **Subsequent calls** deliver follow-up messages to the running agent (via a message file or stdin pipe)
- The response is the agent's output collected from its stdout/result file

This maps cleanly to the existing interface: `sendMessage()` is still "send input, get output." The implementation details differ, but the contract is identical. **The transport never needs to distinguish between session types** — it calls `sendMessage()`, receives callbacks, and that's it.

Escalation requests flow through the same `onEscalation` callback — the `DockerAgentSession` polls the escalation directory using the same pattern as `AgentSession` (extracted into shared code).

Diagnostic events are partially synthesized from the audit log (see Section 11a for details). The `DockerAgentSession` tails the audit log to emit `tool_call` diagnostics. However, `agent_text` and `step_finish` events cannot be synthesized — the agent's text generation is opaque to IronCurtain. The transport's spinner will show tool call activity but not text generation progress. This is an accepted limitation of the Docker session type.

### Session Factory Extension

```typescript
// src/session/index.ts -- extended

/**
 * Discriminated union for session creation options.
 *
 * 'builtin' creates the existing AgentSession (UTCP Code Mode + AI SDK).
 * 'docker' creates a DockerAgentSession that spawns an external agent
 * inside a Docker container with MCP proxy mediation.
 */
export type SessionMode =
  | { readonly kind: 'builtin' }
  | { readonly kind: 'docker'; readonly agent: AgentId };

/**
 * Identifier for a registered agent adapter.
 * Branded to prevent mixing with other string identifiers.
 */
export type AgentId = string & { readonly __brand: 'AgentId' };

export interface SessionOptions {
  // ... existing fields ...

  /**
   * Session mode selection. Defaults to 'builtin' for backward compatibility.
   * When 'docker', the agent field specifies which external agent to run.
   */
  mode?: SessionMode;
}

export async function createSession(options: SessionOptions = {}): Promise<Session> {
  const mode = options.mode ?? { kind: 'builtin' };

  if (mode.kind === 'docker') {
    return createDockerAgentSession(mode.agent, options);
  }

  return createBuiltinSession(options);  // existing logic, renamed
}
```

## 4. Docker Container Design

### Docker Image Strategy: Hybrid (Pre-baked + Runtime Config)

Agent installation is a **build-time** concern — pre-baked into per-agent Docker images. Agent configuration is a **runtime** concern — injected via environment variables and mounted volumes at container creation time.

This separation means:
- No network needed at container startup for installation
- First-run interactive prompts are suppressed during image build
- Per-session config (MCP settings, orientation) is injected dynamically
- **Real API keys never enter the container** — the agent receives a fake sentinel key; the MITM proxy swaps it for the real key on the host side

### Base Image

Per-agent images extend Microsoft's Dev Containers `universal` image, which provides
a comprehensive development environment used by GitHub Codespaces:

- **Languages**: Node.js, Python, Java, Go, Ruby, PHP, .NET, Rust, C++
- **Tools**: git, curl, wget, socat, build-essential, docker CLI, kubectl, terraform
- **Non-root user**: `codespace` (pre-configured with sudo access)
- **Size**: ~6-8GB (one-time download, cached by Docker)

This avoids "missing tool X" surprises — the agent has access to the same development
environment a human developer would expect in a Codespaces workspace.

```dockerfile
# docker/Dockerfile.base
FROM mcr.microsoft.com/devcontainers/universal:latest

# Standard IronCurtain directory structure
USER root
RUN mkdir -p /workspace /etc/ironcurtain /run/ironcurtain && \
    chown codespace:codespace /workspace /etc/ironcurtain /run/ironcurtain

WORKDIR /workspace
USER codespace
```

Note: The `universal` image uses `codespace` as the non-root user (uid 1000).
All per-agent images inherit this user.

### Claude Code Image (Reference)

```dockerfile
# docker/Dockerfile.claude-code
FROM ironcurtain-base:latest

# Install Claude Code CLI (Node.js is already in the base image)
USER root
RUN npm install -g @anthropic-ai/claude-code
USER codespace

# Create the config directory — settings.json is generated entirely
# by IronCurtain at runtime and copied in by the entrypoint script.
RUN mkdir -p /home/codespace/.claude

# The entrypoint script copies runtime-generated config into the right
# location before the agent is invoked via docker exec.
COPY docker/entrypoint-claude-code.sh /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

```bash
#!/bin/bash
# docker/entrypoint-claude-code.sh
#
# Copies runtime-injected MCP config from the orientation mount
# into Claude Code's expected config location, then idles.
# Agent commands are executed via `docker exec`.

# Merge runtime MCP config into settings.json if provided
if [ -f /etc/ironcurtain/claude-settings.json ]; then
  cp /etc/ironcurtain/claude-settings.json /home/codespace/.claude/settings.json
fi

# Idle — agent commands arrive via docker exec
exec sleep infinity
```

### Codex Image (Example)

```dockerfile
# docker/Dockerfile.codex
FROM ironcurtain-base:latest

USER root
RUN npm install -g @openai/codex
USER codespace

RUN mkdir -p /home/codespace/.config/codex
```

### Image Build and Caching

Images are built on first use and cached locally:

```bash
# Built automatically by DockerAgentSession if not present
docker build -t ironcurtain-claude-code:latest -f docker/Dockerfile.claude-code .
```

The `AgentAdapter.getImage()` method checks if the image exists (`docker image inspect`) and triggers a build if needed. Subsequent sessions reuse the cached image.

### Container Configuration

Each session container is created with:

```typescript
interface DockerContainerConfig {
  /** Base image name (e.g., "ironcurtain-agent:latest") */
  readonly image: string;

  /** Volume mounts */
  readonly mounts: readonly DockerMount[];

  /** Docker network name for the container */
  readonly network: string;

  /** Environment variables passed to the container */
  readonly env: Readonly<Record<string, string>>;

  /** Command to execute inside the container */
  readonly command: readonly string[];

  /** Optional resource limits */
  readonly resources?: {
    readonly memoryMb?: number;
    readonly cpus?: number;
  };
}

interface DockerMount {
  /** Host path */
  readonly source: string;
  /** Container path */
  readonly target: string;
  /** Mount as read-only */
  readonly readonly: boolean;
}
```

### Standard Mounts

Every agent container gets three mounts:

| Host Path | Container Path | Mode | Purpose |
|-----------|---------------|------|---------|
| `~/.ironcurtain/sessions/{id}/sandbox/` | `/workspace` | read-write | Agent's working directory |
| `~/.ironcurtain/sessions/{id}/` | `/run/ironcurtain/` | read-write | Session dir (contains `proxy.sock` created by MCP proxy) |
| `~/.ironcurtain/sessions/{id}/orientation/` | `/etc/ironcurtain/` | read-only | Orientation files + MCP config |

Note: The session directory is mounted (not the socket file directly) because Docker bind-mounts are set up at `docker create` time. If we mounted `proxy.sock` directly and it didn't exist yet, Docker would create a directory at that path, breaking the socket. By mounting the parent directory, the socket file appears naturally when the MCP proxy starts listening.

### Network Isolation via TLS-Terminating MITM Proxy

Agents need HTTPS access to their LLM provider's API (e.g., `api.anthropic.com`). These are not MCP tool calls — they are the agent's own inference requests. The container runs with `--network=none` (zero network access) and all HTTPS traffic is routed through a **TLS-terminating MITM proxy** on a Unix domain socket.

This design achieves two critical properties that a simple CONNECT tunnel cannot:
1. **Real API keys never enter the container.** The agent receives a fake sentinel key; the proxy swaps it for the real key before forwarding upstream.
2. **Endpoint-level filtering.** The proxy inspects decrypted HTTP requests and blocks any endpoint not on the allowlist (e.g., only `POST /v1/messages` for Anthropic).

```
Docker Container (--network=none)         Host Process
+------------------------------------+    +--------------------------------+
| Agent process                      |    |                                |
|   HTTPS_PROXY=http://127.0.0.1:   |    |  IronCurtain MITM Proxy (UDS) |
|     18080                          |    |                                |
|   ANTHROPIC_API_KEY=sk-ant-api03-  |    |  1. CONNECT host check         |
|     ironcurtain-<fake>             |    |     ✓ allowlisted provider     |
|                                    |    |     ✗ 403 Forbidden            |
|   socat bridges TCP:18080 → UDS ---|----→  2. TLS termination            |
|                                    |    |     (per-host cert from CA)    |
|   NODE_EXTRA_CA_CERTS=             |    |  3. Endpoint filter            |
|     ironcurtain-ca.crt             |    |     ✓ POST /v1/messages        |
+------------------------------------+    |     ✗ 403 Blocked              |
                                          |  4. Fake key → real key swap   |
                                          |  5. Forward to upstream API    |
                                          +--------------------------------+
                                                        |
                                                  (real HTTPS)
                                                        ↓
                                               api.anthropic.com:443
```

**How it works:**

1. IronCurtain generates a self-signed CA (`~/.ironcurtain/ca/`) on first run. The CA certificate (not the key) is baked into the Docker base image via `update-ca-certificates`.
2. For each provider, IronCurtain generates a random fake sentinel API key (192 bits of entropy) and passes it to the container as an environment variable.
3. The MITM proxy listens on a Unix domain socket, bind-mounted into the container. Inside the container, `socat` bridges `TCP:127.0.0.1:18080` to the UDS so that `HTTPS_PROXY` works.
4. When the agent makes an HTTPS request, the proxy handles the `CONNECT` and checks the target hostname against the provider allowlist. Denied hosts get `403`.
5. For allowed hosts, the proxy terminates TLS using a dynamically generated leaf certificate signed by the IronCurtain CA (cached per hostname).
6. The proxy inspects the decrypted HTTP request: checks the method+path against the provider's endpoint allowlist, validates the fake sentinel key, swaps it for the real key, and forwards to the upstream API.
7. Responses are streamed back (SSE passthrough with `flushHeaders()` + `setNoDelay(true)`).

**What this achieves:**

- **API keys are protected.** The real key exists only in the host process memory. The container never sees it. Even if the agent is compromised, it can only exfiltrate the fake sentinel key, which is useless outside the MITM proxy.
- **Endpoint-level filtering.** Unlike a passthrough CONNECT proxy, the MITM proxy sees decrypted traffic and can enforce per-endpoint allowlists (e.g., block telemetry or admin endpoints).
- **Zero network attack surface.** The container has `--network=none` — no IP connectivity at all. The only communication channel is the UDS.
- MCP tool calls for general network access (fetch, git, etc.) still go through the MCP proxy and policy engine as before.

**Agent Adapter Integration:**

Each agent adapter declares its required LLM API providers:

```typescript
export interface AgentAdapter {
  // ... existing methods ...

  /** Returns provider configs for LLM APIs this agent needs. */
  getProviders(): readonly ProviderConfig[];

  /** Build environment variables. Receives fake keys keyed by provider host. */
  buildEnv(config: IronCurtainConfig, fakeKeys: ReadonlyMap<string, string>): Record<string, string>;
}
```

The `DockerAgentSession` lifecycle becomes:

```
1. Load/create CA certificate
2. Generate fake sentinel keys for each provider
3. Start MCP proxy server (UDS) — for tool calls
4. Start MITM proxy (UDS) — for LLM API calls
5. Start container (--network=none) with:
   - Fake API key in env (e.g., ANTHROPIC_API_KEY=sk-ant-api03-ironcurtain-<random>)
   - HTTPS_PROXY=http://127.0.0.1:18080
   - NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/ironcurtain-ca.crt
   - MITM proxy UDS bind-mounted
6. ... agent runs ...
7. Stop container
8. Stop MITM proxy
9. Stop MCP proxy server
```

**Docker Network Setup:**

Each session gets its own isolated Docker bridge network. This prevents inter-container communication between concurrent sessions — a compromised container in one session cannot reach containers or proxies belonging to other sessions.

```bash
# Created during session initialization
docker create --network=none ...

# Removed during session cleanup
docker rm -f ironcurtain-{sessionId-short}
```

The container runs with `--network=none` — no IP connectivity. All communication with the host happens via bind-mounted Unix domain sockets (MCP proxy and MITM proxy).

## 5. MCP Proxy Transport

### Current Transport: stdio

The existing MCP proxy server (`mcp-proxy-server.ts`) uses `StdioServerTransport`. It reads JSON-RPC from stdin and writes responses to stdout. This works because UTCP Code Mode spawns the proxy as a child process with stdio pipes.

### New Transport: Unix Domain Socket

For Docker agent sessions, the proxy needs to listen on a Unix domain socket that is bind-mounted into the container. Unix domain sockets work on both Docker for Linux and Docker for Mac, making them the natural choice. No TCP fallback is provided — UDS is the only supported transport for Docker sessions.

The MCP SDK does not ship a UDS transport — only `StdioServerTransport`, `SSEServerTransport`, and `StreamableHTTPServerTransport`. We need to implement a custom `UdsServerTransport` that wraps a `net.Server` listening on a Unix socket and bridges each connection to the MCP SDK's `Transport` interface (JSON-RPC over a bidirectional stream). This is straightforward — the SDK's `Transport` interface is small (a readable/writable pair with `start()`, `send()`, `close()`).

```typescript
// src/trusted-process/uds-proxy-transport.ts

import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { createServer, type Socket } from 'node:net';

/**
 * Creates a Unix domain socket transport for the MCP proxy server.
 *
 * Listens on the given socket path. When a client connects, it creates
 * an MCP server session for that connection. Only one concurrent client
 * connection is expected (the agent in the container).
 *
 * The socket file is created on listen() and removed on close().
 */
export interface UdsProxyTransportOptions {
  /** Absolute path to the Unix domain socket file. */
  readonly socketPath: string;

  /**
   * Factory that creates and configures the MCP server for each connection.
   * Called once per client connection. The returned server handles the
   * full MCP lifecycle (tools/list, tools/call, etc.).
   */
  readonly createServer: () => McpServer;
}
```

### Per-Session Socket Isolation

Each session gets its own socket file:

```
~/.ironcurtain/sessions/{sessionId}/proxy.sock
```

This provides natural isolation between concurrent sessions. Each socket has its own MCP proxy server instance with its own PolicyEngine, AuditLog, and MCP client connections. There is no shared state between sessions.

### Socket File Lifecycle

```
1. createDockerAgentSession() creates session directory
2. MCP proxy server starts listening on proxy.sock
3. Docker container starts with proxy.sock bind-mounted
4. Agent connects to /run/ironcurtain/proxy.sock
5. MCP traffic flows over UDS
6. On session close:
   a. Docker container is stopped and removed
   b. MCP proxy server closes the socket
   c. Socket file is unlinked
```

### MCP Proxy Server Mode Selection

The proxy server gains a transport mode selection:

```typescript
// src/trusted-process/mcp-proxy-server.ts -- extended startup

async function main(): Promise<void> {
  // ... existing config parsing ...

  const socketPath = process.env.PROXY_SOCKET_PATH;

  let transport: Transport;
  if (socketPath) {
    // Docker agent sessions: listen on Unix domain socket
    transport = new UdsServerTransport(socketPath);
  } else {
    // Built-in agent sessions: stdio (unchanged)
    transport = new StdioServerTransport();
  }

  await server.connect(transport);
  // ... rest unchanged ...
}
```

This keeps the proxy server as a single codebase supporting both transports. The transport selection is driven by the presence of `PROXY_SOCKET_PATH` — no separate mode flag needed. Unix domain sockets are the only non-stdio transport; TCP is explicitly not supported.


## 6. Agent Configuration

### Agent Adapter Interface

Each supported agent has an adapter that handles its specific configuration needs.

```typescript
// src/docker/agent-adapter.ts

/**
 * An agent adapter encapsulates the differences between external agents.
 *
 * Each adapter knows:
 * - What Docker image to use (or how to build one)
 * - How to configure MCP server discovery for the agent
 * - What orientation files to inject
 * - How to construct the container's entrypoint command
 * - How to collect the agent's response
 */
export interface AgentAdapter {
  /** Unique identifier for this agent type. */
  readonly id: AgentId;

  /** Human-readable name for display. */
  readonly displayName: string;

  /**
   * Returns the Docker image to use for this agent.
   * May trigger a build if the image doesn't exist yet.
   */
  getImage(): Promise<string>;

  /**
   * Generates the MCP client configuration file that tells
   * the agent how to connect to IronCurtain's proxy.
   *
   * The format varies per agent:
   * - Claude Code: ~/.claude/settings.json
   * - Goose: ~/.config/goose/config.yaml
   *
   * @param socketPath - container-side UDS path (e.g., /run/ironcurtain/proxy.sock)
   * @param tools - list of available MCP tools for documentation
   */
  generateMcpConfig(socketPath: string, tools: ToolInfo[]): AgentConfigFile[];

  /**
   * Generates orientation documents that teach the agent about
   * the MCP-mediated environment.
   *
   * Returns files to write into the orientation directory.
   */
  generateOrientationFiles(context: OrientationContext): AgentConfigFile[];

  /**
   * Constructs the docker exec command for a turn.
   * Called for every turn — the agent's native session resume mechanism
   * handles conversation continuity automatically.
   *
   * @param message - the user's message for this turn
   * @param systemPrompt - the orientation prompt (from buildSystemPrompt())
   */
  buildCommand(message: string, systemPrompt: string): readonly string[];

  /**
   * Returns the system prompt to append to the agent's default system prompt.
   * This teaches the agent about the MCP-mediated environment, sandbox
   * boundaries, and available tools. Injected via the agent's native
   * mechanism (e.g., Claude Code's --append-system-prompt).
   */
  buildSystemPrompt(context: OrientationContext): string;

  /**
   * Constructs environment variables for the container.
   * Includes API keys and agent-specific configuration.
   */
  buildEnv(config: IronCurtainConfig): Readonly<Record<string, string>>;

  /**
   * Parses the agent's output to extract the final response text.
   * Different agents produce output in different formats.
   *
   * @param exitCode - the container's exit code
   * @param stdout - captured stdout from the container
   * @param resultFile - optional path to a result file in the sandbox
   */
  extractResponse(exitCode: number, stdout: string, resultFile?: string): string;
}

interface AgentConfigFile {
  /** Path inside the container (relative to orientation root or absolute). */
  readonly path: string;
  /** File content. */
  readonly content: string;
}

interface ToolInfo {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

interface OrientationContext {
  /** The sandbox directory path inside the container. */
  readonly workspaceDir: string;
  /** List of available MCP tools with descriptions. */
  readonly tools: ToolInfo[];
  /** Domains the agent may access via fetch MCP tool. */
  readonly allowedDomains: string[];
}
```

### Agent Adapter Registry

```typescript
// src/docker/agent-registry.ts

/**
 * Registry of known agent adapters.
 *
 * New agents are added by implementing AgentAdapter and registering here.
 * The registry is a simple Map -- no dynamic loading or plugin system.
 * This is a PoC; a plugin architecture can be added later if needed.
 */
const registry = new Map<AgentId, AgentAdapter>();

export function registerAgent(adapter: AgentAdapter): void {
  if (registry.has(adapter.id)) {
    throw new Error(`Agent adapter already registered: ${adapter.id}`);
  }
  registry.set(adapter.id, adapter);
}

export function getAgent(id: AgentId): AgentAdapter {
  const adapter = registry.get(id);
  if (!adapter) {
    const available = [...registry.keys()].join(', ');
    throw new Error(`Unknown agent: ${id}. Available: ${available}`);
  }
  return adapter;
}

export function listAgents(): readonly AgentAdapter[] {
  return [...registry.values()];
}
```

### Claude Code Adapter (Reference Implementation)

```typescript
// src/docker/adapters/claude-code.ts

import type { AgentAdapter, AgentConfigFile, OrientationContext, ToolInfo } from '../agent-adapter.js';

export const claudeCodeAdapter: AgentAdapter = {
  id: 'claude-code' as AgentId,
  displayName: 'Claude Code',

  async getImage() {
    return 'ironcurtain-claude-code:latest';
  },

  generateMcpConfig(socketPath: string, tools: ToolInfo[]): AgentConfigFile[] {
    // Claude Code uses a settings.json that configures MCP servers.
    // The proxy appears as a single MCP server using UDS transport.
    // Single source of truth for all Claude Code settings.
    // Generated entirely by IronCurtain — nothing pre-baked in the Docker image.
    const settings = {
      mcpServers: {
        ironcurtain: {
          // Claude Code supports UDS transport via command that
          // bridges stdio to a Unix socket
          command: 'socat',
          args: ['STDIO', `UNIX-CONNECT:${socketPath}`],
        },
      },
      // Suppress all interactive prompts and permission checks —
      // IronCurtain's policy engine handles security.
      dangerouslySkipPermissions: true,
      permissions: {
        allow: ['*'],
      },
    };

    // Path is relative to the orientation directory (/etc/ironcurtain/).
    // The entrypoint script copies this to ~/.claude/settings.json.
    return [
      {
        path: 'claude-settings.json',
        content: JSON.stringify(settings, null, 2),
      },
    ];
  },

  buildCommand(message: string, systemPrompt: string): readonly string[] {
    return [
      'claude',
      '--continue',
      '--dangerously-skip-permissions',
      '--output-format', 'text',
      '--append-system-prompt', systemPrompt,
      '-p', message,
    ];
  },

  buildSystemPrompt(context: OrientationContext): string {
    return buildClaudeCodeOrientation(context);
  },

  getAllowedApiHosts(): readonly string[] {
    return ['api.anthropic.com'];
  },

  buildEnv(config: IronCurtainConfig): Record<string, string> {
    return {
      ANTHROPIC_API_KEY: fakeKeys.get('api.anthropic.com') ?? '',
      NODE_EXTRA_CA_CERTS: '/usr/local/share/ca-certificates/ironcurtain-ca.crt',
      // Disable Claude Code's update checks
      CLAUDE_CODE_DISABLE_UPDATE_CHECK: '1',
    };
  },

  extractResponse(exitCode: number, stdout: string): string {
    if (exitCode !== 0) {
      return `Agent exited with code ${exitCode}.\n\nOutput:\n${stdout}`;
    }
    return stdout.trim();
  },
};

function buildClaudeCodeOrientation(context: OrientationContext): string {
  const toolList = context.tools
    .map((t) => `- \`${t.name}\` -- ${t.description ?? 'no description'}`)
    .join('\n');

  return `You are running inside a sandboxed environment managed by IronCurtain.

## Environment Constraints

### Network
You have NO general network access. All network operations must go through
MCP tools provided by IronCurtain:
- Use the \`fetch\` MCP tool to make HTTP requests
- Use the \`git\` MCP tools for git operations (clone, push, pull)
Do NOT attempt direct network requests — they will fail.

### Filesystem
- **Free access**: \`${context.workspaceDir}\` — read, write, create, delete freely.
- **Mediated access**: Everything outside this directory goes through the
  IronCurtain policy engine and may require human approval.

### Available MCP Tools
${toolList}

### Policy Enforcement
Every MCP tool call is evaluated against security policy rules:
- **Allowed**: proceeds automatically
- **Denied**: blocked — do NOT retry denied operations
- **Escalated**: requires human approval — you will receive the result once approved

### Best Practices
1. Work within ${context.workspaceDir} as much as possible
2. Batch external operations to minimize escalation prompts
3. If an operation is denied, explain the denial and suggest alternatives
4. Do not attempt to bypass the sandbox
`;
}
```

## 7. Orientation / Injection

### What Gets Injected

Each agent container receives three categories of injected content:

**1. MCP Client Configuration** -- tells the agent where to find MCP tools.

The format is agent-specific. For Claude Code, this is `~/.claude/settings.json` pointing to the UDS socket via a `socat` bridge. For Goose, it would be a YAML config. The `AgentAdapter.generateMcpConfig()` method handles the translation. This is written to the orientation directory and copied into the correct location by the container's entrypoint script.

**2. System Prompt** -- teaches the agent about its environment.

Injected via the agent's native mechanism on every turn:
- Claude Code: `--append-system-prompt "..."`
- Other agents: equivalent flags or config options

This avoids writing orientation files to the workspace (which could overwrite project files like `CLAUDE.md`). The system prompt explains:
- No direct network access -- use MCP tools for git, fetch, etc.
- Sandbox boundary -- free reign inside `/workspace`, mediated outside
- Available MCP tools and their purpose
- Policy enforcement behavior (allow/deny/escalate)

The `AgentAdapter.buildSystemPrompt()` method generates this content from an `OrientationContext`.

**3. Project Files** -- the actual work the agent needs to do.

These are the files in the sandbox directory, volume-mounted from the host. The user (or IronCurtain's session setup) populates this directory before starting the container. For a coding task on an existing repo, this would be a git clone or copy of the repository.

### Session Setup

```typescript
// src/docker/orientation.ts

/**
 * Prepares the session's orientation directory and builds the system prompt.
 *
 * 1. Queries the MCP proxy for available tools
 * 2. Generates MCP client config via adapter (written to orientation dir)
 * 3. Builds the system prompt via adapter (passed to buildCommand on each turn)
 */
export async function prepareSession(
  adapter: AgentAdapter,
  proxyTools: ToolInfo[],
  sessionDir: string,
  config: IronCurtainConfig,
): Promise<{ systemPrompt: string }> {
  const orientationDir = resolve(sessionDir, 'orientation');
  mkdirSync(orientationDir, { recursive: true });

  const context: OrientationContext = {
    workspaceDir: '/workspace',
    tools: proxyTools,
    allowedDomains: extractAllowedDomains(config),
  };

  // MCP client configuration (agent-specific format).
  // Paths are relative to the orientation directory.
  // The container's entrypoint copies them to the agent's expected locations.
  const mcpConfigFiles = adapter.generateMcpConfig(
    '/run/ironcurtain/proxy.sock',
    proxyTools,
  );
  for (const file of mcpConfigFiles) {
    const targetPath = resolve(orientationDir, file.path);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, file.content);
  }

  // System prompt (injected per-turn via --append-system-prompt or equivalent)
  const systemPrompt = adapter.buildSystemPrompt(context);

  return { systemPrompt };
}
```

### How Agents Discover MCP Tools

The specific mechanism depends on the agent:

| Agent | MCP Discovery Mechanism | Config File |
|-------|------------------------|-------------|
| Claude Code | `settings.json` with `mcpServers` | `~/.claude/settings.json` |
| Goose | Config YAML with MCP server list | `~/.config/goose/config.yaml` |
| OpenCode | Environment variable or config | Agent-specific |

All agents connect to the same UDS endpoint (`/run/ironcurtain/proxy.sock`) but through agent-specific configuration formats. The `socat STDIO UNIX-CONNECT:/run/ironcurtain/proxy.sock` bridge pattern works for any agent that expects an MCP server via stdio.

## 8. Lifecycle

### Session Creation

```
createSession({ mode: { kind: 'docker', agent: 'claude-code' } })
  |
  1. Generate session ID
  2. Create session directory tree:
     ~/.ironcurtain/sessions/{id}/
       sandbox/           (volume mount target)
       orientation/       (injected config files)
       escalations/       (escalation IPC directory)
       audit.jsonl        (audit log)
       session.log        (session log)
       proxy.sock         (UDS, created by proxy)
  |
  3. Resolve agent adapter from registry
  |
  4. Start MCP Proxy Server (host process)
     - Mode: UDS (PROXY_SOCKET_PATH set)
     - Listens on: proxy.sock
     - Connects to real MCP servers (filesystem, git, fetch, etc.)
     - PolicyEngine loaded with compiled rules
  |
  5. Start MITM Proxy (host process, UDS)
     - Providers from adapter.getProviders()
     - Fake sentinel keys generated per provider
     - TLS-terminating with endpoint filtering and key swap
  |
  6. Query MCP proxy for available tools (tools/list)
  |
  7. Generate orientation files via agent adapter
     - Write CLAUDE.md (or equivalent) to sandbox/
     - Write MCP client config to orientation/
  |
  8. Ensure Docker image exists (build with CA cert if needed)
  |
  9. Start Docker container with idle entrypoint:
     docker create \
       --name ironcurtain-{sessionId-short} \
       --network none \
       \
       --cap-drop=ALL \
       --label ironcurtain.session={sessionId} \
       --memory 4g \
       --cpus 2 \
       -v {sessionDir}:/run/ironcurtain \
       -v {sandboxDir}:/workspace \
       -v {orientationDir}:/etc/ironcurtain:ro \
       -e ANTHROPIC_API_KEY=sk-ant-api03-ironcurtain-<fake> \
       -e ANTHROPIC_API_KEY=sk-ant-api03-ironcurtain-<fake> \
       -e HTTPS_PROXY=http://127.0.0.1:18080 \
       -e HTTP_PROXY=http://127.0.0.1:18080 \
       -e NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/ironcurtain-ca.crt \
       {agent-image} \
       sleep infinity
     docker start {containerId}
  |
  Note: The container stays alive for the entire session. Agent commands
  are executed via `docker exec` per turn (see Message Processing below).
  API keys are injected via `-e` at create time — never written to the
  image or to disk inside the container.
  |
  10. Session status -> 'ready'
  |
  return Session
```

### Message Processing (sendMessage)

The container stays alive for the entire session. Each `sendMessage()` call executes
the agent via `docker exec` inside the running container. The agent's native session
resume mechanism maintains conversation continuity between turns.

```
sendMessage("Fix the bug in auth.ts")   // Any turn (including first)
  |
  1. Build command via adapter.buildCommand(message, systemPrompt):
     ['claude', '--continue', '--dangerously-skip-permissions',
      '--output-format', 'text',
      '--append-system-prompt', '<orientation>',
      '-p', 'Fix the bug in auth.ts']
  |
  2. Execute inside container:
     docker exec {containerId} claude --continue \
       --dangerously-skip-permissions --output-format text \
       --append-system-prompt "..." -p "Fix the bug in auth.ts"
  |
  3. Wait for docker exec to exit (async — event loop continues)
     - Escalation watcher polls escalation directory on setInterval
     - Diagnostics emitted from audit log watcher
  |
  4. Collect stdout from docker exec
  |
  5. Parse response via adapter.extractResponse(exitCode, stdout)
  |
  6. Record ConversationTurn, return response text
```

**Key design points:**

- The container is long-lived (`sleep infinity` entrypoint). `docker exec` runs
  commands inside it without restarting.
- Every turn uses `adapter.buildCommand()` with `--continue`. Claude Code's
  `--continue` works on the first turn too (starts a new session if none exists),
  so no special-casing is needed.
- The agent's session state is stored on disk inside the container (e.g.,
  `~/.claude/projects/` for Claude Code). Since the container is persistent,
  state survives between `docker exec` invocations.
- The orientation/system prompt is injected via `--append-system-prompt` on every
  turn, not via a CLAUDE.md file. This avoids overwriting any project CLAUDE.md
  and ensures the agent always has the orientation context.
- `docker exec` is async (Node.js `child_process.exec`). The `await` yields to
  the event loop, so `setInterval` callbacks (escalation watcher, audit log
  tailer) continue to fire during execution.

**Concurrency guard:** `sendMessage()` transitions status to `'processing'` and
rejects concurrent calls, same as the built-in session. Only one `docker exec`
runs at a time per session.

### Container Termination and Cleanup

```
session.close()
  |
  1. Stop Docker container (docker stop, graceful SIGTERM then SIGKILL)
  2. Remove Docker container (docker rm)
  3. Remove per-session Docker network (docker network rm)
  4. Stop MITM proxy (close UDS listener, tear down active connections)
  5. Stop MCP proxy server (close UDS listener)
  6. Close MCP client connections to backend servers
  7. Close audit log
  8. Unlink proxy.sock
  9. Session status -> 'closed'
  |
  Note: sandbox directory is NOT deleted -- it contains the agent's work product.
  The user can inspect results in ~/.ironcurtain/sessions/{id}/sandbox/
```

### Crash Recovery

If the host process crashes:

- Docker containers continue running (they are independent processes)
- On next startup, stale containers can be detected by label and cleaned up
- Socket files in session directories are stale -- safe to unlink and recreate
- Audit logs are append-only JSONL -- no corruption risk from mid-write crashes

## 9. Concurrent Sessions

### Isolation Guarantees

Each session is fully isolated:

| Resource | Isolation Mechanism |
|----------|-------------------|
| Sandbox directory | Per-session path: `sessions/{id}/sandbox/` |
| UDS socket | Per-session path: `sessions/{id}/proxy.sock` |
| MCP proxy server | Separate OS process per session |
| Docker network | Per-session bridge: `ironcurtain-{id-short}` |
| Docker container | Separate container per session |
| MITM proxy | Per-session UDS on host |
| Audit log | Per-session file: `sessions/{id}/audit.jsonl` |
| Escalation IPC | Per-session directory: `sessions/{id}/escalations/` |
| Policy engine | Separate instance per proxy (loaded from same compiled artifacts) |

There is no shared mutable state between sessions. The compiled policy artifacts (`compiled-policy.json`, `tool-annotations.json`) are read-only and loaded independently by each proxy instance.

### Resource Management

Concurrent sessions consume:

| Component | Per-Session Cost |
|-----------|-----------------|
| MCP proxy server | ~50-100 MB (Node.js process) |
| MITM proxy | Negligible (runs in IronCurtain process) |
| Docker container | ~200-500 MB (depends on agent) |
| MCP server connections | ~30-50 MB per server (shared across proxy) |
| UDS socket | Negligible |
| Disk (sandbox) | Depends on task |

For a typical setup with 2-3 concurrent sessions, expect ~1-2 GB total memory.

### Session Limits

The broker can enforce a maximum concurrent session count:

```typescript
interface BrokerConfig {
  /** Maximum number of concurrent Docker agent sessions. Default: 5. */
  readonly maxConcurrentSessions: number;
}
```

This is enforced in `createDockerAgentSession()` before allocating resources.

## 10. Security Model

### Threat Model

**Trusted components:**
- IronCurtain host process (session manager, MCP proxy, policy engine)
- Compiled policy artifacts (produced by offline pipeline with human review)
- Docker daemon (assumed correctly configured)

**Untrusted components:**
- The agent inside the container (may be compromised, jailbroken, or buggy)
- Agent-generated code and file modifications within the sandbox
- MCP tool call arguments (inspected by policy engine)

**What the agent CAN do (by design):**
- Read, write, create, delete any file within the sandbox directory
- Call MCP tools -- subject to policy engine evaluation
- Produce arbitrary stdout/stderr output
- Use CPU and memory within container resource limits

**What the agent CANNOT do:**
- Access arbitrary network destinations (container has `--network=none`; only allowlisted LLM API endpoints via MITM proxy)
- Access the host filesystem outside the sandbox (Docker volume isolation)
- Modify IronCurtain's policy, config, or audit logs (not mounted)
- Bypass policy evaluation for MCP tool calls (all calls go through proxy)
- Access other sessions' sandboxes or sockets (container isolation)
- Access API keys of other providers (only the needed key is passed in)

### Attack Vectors and Mitigations

**1. Agent tries to escape Docker container**
- Mitigation: Standard Docker containment (namespaces, cgroups, seccomp)
- The container runs as non-root (`codespace` user from devcontainers base image)
- No capabilities granted (`--cap-drop=ALL`)
- No privileged mode

**2. Agent tries to access arbitrary network destinations**
- Mitigation: Container runs with `--network=none` — zero IP connectivity
- The only communication channels are bind-mounted Unix domain sockets (MCP proxy and MITM proxy)
- The MITM proxy rejects CONNECT requests to any hostname not in the provider allowlist
- Endpoint-level filtering blocks requests to non-allowlisted API paths even on allowed hosts
- The agent cannot make direct TCP connections to any host — there is no network interface

**3. Agent tries to exploit the MCP proxy via malformed requests**
- Mitigation: The MCP SDK handles JSON-RPC parsing and schema validation
- The policy engine validates arguments before forwarding
- Path traversal is blocked by `resolveRealPath()` normalization

**4. Agent floods the proxy with requests**
- Mitigation: The `CallCircuitBreaker` limits repeated identical calls
- Resource budget tracker limits total tokens/cost
- Docker memory and CPU limits prevent resource exhaustion

**5. Agent writes malicious files to the sandbox**
- Mitigation: This is expected behavior -- the sandbox is the agent's workspace
- The user reviews results before using them
- Files in the sandbox cannot affect the host system outside the mount

**6. Agent tries to communicate with other containers**
- Mitigation: Each session has its own isolated Docker bridge network — containers from different sessions cannot see each other
- Each container has its own UDS sockets and MITM proxy (not shared)
- Docker's default seccomp profile prevents most IPC mechanisms

### Defense in Depth

```
Layer 1: Docker Container + MITM Proxy
  - No network access (--network=none); LLM API calls via TLS-terminating MITM proxy
  - Real API keys never enter the container (fake key swap)
  - Filesystem limited to mounts
  - Non-root, no capabilities
  - Resource limits (memory, CPU)

Layer 2: IronCurtain Policy Engine (MCP Proxy)
  - Structural invariants (protected paths, unknown tools)
  - Compiled declarative rules (per-role evaluation)
  - Domain allowlists for URL-category tools
  - Escalation for operations outside sandbox

Layer 3: bubblewrap/srt (MCP Server Sandbox)
  - Per-server filesystem restrictions
  - Per-server network isolation
  - Process isolation within the host

Layer 4: Human Oversight
  - Escalation prompts for sensitive operations
  - Audit log for forensic review
  - Auto-approve with conservative matching (optional)
```

## 11. Docker Agent Session Implementation

### Core Class

```typescript
// src/docker/docker-agent-session.ts

import type { Session, SessionId, SessionInfo, SessionStatus,
  ConversationTurn, DiagnosticEvent, EscalationRequest, BudgetStatus,
  SessionOptions } from '../session/types.js';
import type { AgentAdapter } from './agent-adapter.js';
import type { IronCurtainConfig } from '../config/types.js';
import type { DockerManager } from './docker-manager.js';
import type { ManagedProxy } from './managed-proxy.js';

/**
 * Session implementation that runs an external agent inside a Docker container.
 *
 * The agent communicates with IronCurtain's MCP proxy server via a Unix domain
 * socket. The proxy enforces the same policy rules as the built-in agent session.
 *
 * Lifecycle:
 * 1. initialize() -- start proxies, generate orientation, create & start container
 * 2. sendMessage() -- docker exec agent command, wait for exit, collect output
 * 3. close() -- stop container, stop proxies, clean up
 */
export class DockerAgentSession implements Session {
  private readonly sessionId: SessionId;
  private readonly config: IronCurtainConfig;
  private readonly adapter: AgentAdapter;
  private status: SessionStatus = 'initializing';
  private readonly createdAt: string;

  private readonly sandboxDir: string;
  private readonly orientationDir: string;
  private readonly escalationDir: string;
  private readonly socketPath: string;

  private proxy: ManagedProxy | null = null;
  private mitmProxy: MitmProxy | null = null;
  private docker: DockerManager | null = null;
  private containerId: string | null = null;
  private turnCount = 0;  // tracks first turn vs continuation

  private turns: ConversationTurn[] = [];
  private diagnosticLog: DiagnosticEvent[] = [];
  private pendingEscalation: EscalationRequest | undefined;

  private readonly onEscalation?: (request: EscalationRequest) => void;
  private readonly onEscalationExpired?: () => void;
  private readonly onDiagnostic?: (event: DiagnosticEvent) => void;

  async sendMessage(userMessage: string): Promise<string> {
    this.status = 'processing';

    // Same command for every turn — --continue handles both
    // first turn (creates session) and subsequent turns (resumes)
    const command = this.adapter.buildCommand(userMessage, this.systemPrompt);

    // Execute inside the running container
    const { exitCode, stdout, stderr } = await this.docker!.exec(
      this.containerId!, command,
    );

    // Log stderr for diagnostics (not returned to user)
    if (stderr) this.appendToSessionLog(stderr);

    const response = this.adapter.extractResponse(exitCode, stdout);
    this.turnCount++;
    this.status = 'ready';
    return response;
  }

  // ... constructor, initialize(), close(), etc. ...
  // Implements the same Session interface as AgentSession
}
```

### Diagnostic Event Synthesis (11a)

The built-in `AgentSession` emits diagnostic events directly from the AI SDK's `onStepFinish` callback. `DockerAgentSession` cannot do this — the agent runs in a separate container. Instead, it synthesizes a subset of diagnostics by tailing the audit log.

**Audit Log Tailer:**

```typescript
// src/docker/audit-log-tailer.ts

/**
 * Tails a JSONL audit log file and emits DiagnosticEvent callbacks
 * for each new entry. Uses fs.watch() for change notification and
 * tracks the file read offset to parse only new lines.
 */
export class AuditLogTailer {
  private offset = 0;
  private watcher: FSWatcher | null = null;

  constructor(
    private readonly auditLogPath: string,
    private readonly onDiagnostic: (event: DiagnosticEvent) => void,
  ) {}

  start(): void {
    // Watch for file changes (inotify on Linux, kqueue on macOS)
    this.watcher = watch(this.auditLogPath, () => this.readNewEntries());
  }

  private readNewEntries(): void {
    // Read from current offset to EOF
    const fd = openSync(this.auditLogPath, 'r');
    const stat = fstatSync(fd);
    if (stat.size <= this.offset) { closeSync(fd); return; }

    const buf = Buffer.alloc(stat.size - this.offset);
    readSync(fd, buf, 0, buf.length, this.offset);
    closeSync(fd);
    this.offset = stat.size;

    // Parse complete lines as JSONL
    const lines = buf.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      const entry = JSON.parse(line) as AuditEntry;
      this.onDiagnostic({
        kind: 'tool_call',
        toolName: `${entry.serverName}.${entry.toolName}`,
        preview: this.buildPreview(entry),
      });
    }
  }

  stop(): void {
    this.watcher?.close();
  }
}
```

**What can and cannot be synthesized:**

| DiagnosticEvent kind | Available? | Source |
|---------------------|-----------|--------|
| `tool_call` | Yes | Audit log entries |
| `budget_warning` | Yes | DockerAgentSession's own wall-clock/step tracking |
| `budget_exhausted` | Yes | DockerAgentSession's own tracking |
| `agent_text` | **No** | Agent's text generation is opaque |
| `step_finish` | **No** | Agent's step lifecycle is opaque |
| `loop_detection` | **No** | Built-in session's internal detection |
| `result_truncation` | **No** | Built-in session's internal behavior |
| `message_compaction` | **No** | Built-in session's internal behavior |

The transport's spinner behavior will differ between session types: Docker sessions show tool call activity (e.g., "Calling filesystem.read_file...") but not text generation progress. This is an accepted limitation — the transport can check `SessionInfo` to determine the session type and adjust its display accordingly if needed.

### Budget Tracking for Docker Sessions (11b)

The built-in session tracks tokens and cost via the AI SDK. Docker sessions cannot observe token usage — the agent's LLM calls happen inside the container. The `DockerAgentSession` tracks what it can observe:

| Metric | Source | Accuracy |
|--------|--------|----------|
| `stepCount` | Increment per `docker exec` turn | Exact |
| `elapsedSeconds` | Wall-clock timer started at first `sendMessage()` | Exact |
| `totalTokens` / `totalInputTokens` / `totalOutputTokens` | **0** | Unavailable |
| `estimatedCostUsd` | **0** | Unavailable |

**Interface change:** Add a `tokenTrackingAvailable` flag to `BudgetStatus`:

```typescript
export interface BudgetStatus {
  // ... existing fields ...

  /** False for Docker sessions where token usage is not observable. */
  readonly tokenTrackingAvailable: boolean;
}
```

The transport can use this flag to display "N/A" for token and cost fields in the `/budget` command. `ConversationTurn.usage` fields return 0 for Docker sessions.

The `ResourceBudgetTracker`'s step-count and wall-clock enforcement still works for Docker sessions. Token-based limits (maxTokens, maxCost) are effectively disabled — users should rely on their API key's spending limits instead.

### MCP Proxy Manager

```typescript
// src/docker/managed-proxy.ts

/**
 * Manages the lifecycle of an MCP proxy server process for a Docker session.
 *
 * Spawns the proxy as a child process with PROXY_SOCKET_PATH set and
 * manages its lifecycle. The proxy process is the same mcp-proxy-server.ts
 * used by the built-in session, just with a different transport.
 */
export interface ManagedProxy {
  /** Start the proxy process. Resolves when the UDS is ready for connections. */
  start(): Promise<void>;

  /** Query available tools from the running proxy. */
  listTools(): Promise<ToolInfo[]>;

  /** Stop the proxy process and clean up the socket. */
  stop(): Promise<void>;

  /** The socket path the proxy is listening on. */
  readonly socketPath: string;
}

/**
 * Readiness detection: start() polls for the socket file to appear on disk
 * (the proxy creates it when net.Server.listen() completes). This is simpler
 * and more reliable than a stdout-based readiness protocol:
 *
 *   const start = Date.now();
 *   while (!existsSync(this.socketPath)) {
 *     if (Date.now() - start > 10_000) throw new Error('Proxy startup timeout');
 *     await setTimeout(50);
 *   }
 *
 * The socket file's existence guarantees the proxy is listening and ready to
 * accept connections. Since the proxy is started before the Docker container,
 * there is no race condition — by the time the agent invokes socat, the
 * socket is already live.
 */
```

### Docker Manager

```typescript
// src/docker/docker-manager.ts

/**
 * Manages Docker container lifecycle for agent sessions.
 *
 * Uses the Docker CLI (not the Docker API) for simplicity.
 * The Docker socket is only accessed from the host process,
 * never from inside agent containers.
 */
export interface DockerManager {
  /** Check that Docker is available and the base image exists. */
  preflight(image: string): Promise<void>;

  /** Create a container with the given configuration. Returns container ID. */
  create(config: DockerContainerConfig): Promise<string>;

  /** Start a created container. */
  start(containerId: string): Promise<void>;

  /**
   * Execute a command inside a running container via `docker exec`.
   * Returns when the command exits. Both stdout and stderr are captured.
   * This is the primary mechanism for running agent commands per turn.
   *
   * Stderr is captured for error diagnosis and session logging but is
   * not returned to the user via sendMessage(). The adapter's
   * extractResponse() receives only stdout.
   *
   * @param timeoutMs - kill the exec process after this many ms.
   *   Enforces the session's wall-clock budget. Uses AbortController
   *   on the spawned child process.
   */
  exec(containerId: string, command: readonly string[], timeoutMs?: number): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;

  /** Stop a running container (SIGTERM, then SIGKILL after grace period). */
  stop(containerId: string): Promise<void>;

  /** Remove a container (must be stopped). */
  remove(containerId: string): Promise<void>;

  /** Check if a container is running. */
  isRunning(containerId: string): Promise<boolean>;
}
```

## 12. Configuration

### User Config Extension

```typescript
// Addition to UserConfig schema in src/config/user-config.ts

const dockerAgentSchema = z.object({
  /** Default agent to use for Docker sessions. */
  defaultAgent: z.string().optional(),

  /** Per-agent API key overrides (agent may need its own key). */
  agentApiKeys: z.record(z.string(), z.string().min(1)).optional(),

  /** Docker resource limits. */
  resources: z.object({
    memoryMb: z.number().int().positive().optional(),
    cpus: z.number().positive().optional(),
  }).optional(),

  /** Maximum concurrent Docker agent sessions. */
  maxConcurrentSessions: z.number().int().positive().optional(),
}).optional();
```

### MCP Server Config for Docker Sessions

Docker agent sessions use the same `mcp-servers.json` as the built-in agent. The proxy connects to the same backend MCP servers. No changes needed.

### CLI Extension

```
ironcurtain start "your task"                    # built-in agent (default)
ironcurtain start --agent claude-code "your task" # Docker: Claude Code
ironcurtain start --agent goose "your task"       # Docker: Goose
ironcurtain start --list-agents                   # List available agents
```

## 13. Implementation Plan

### Phase 1: UDS Transport and CONNECT Proxy

**Goal:** The existing MCP proxy server can listen on a Unix domain socket instead of stdio. A TLS-terminating MITM proxy handles LLM API calls with endpoint filtering and key swap.

**Changes:**
1. Create `src/trusted-process/uds-server-transport.ts` -- MCP SDK server transport over UDS
2. Add `PROXY_SOCKET_PATH` env var handling to `mcp-proxy-server.ts`
3. Create `src/docker/mitm-proxy.ts` -- TLS-terminating MITM proxy with endpoint filtering and key swap
4. Unit tests: UDS transport connects, handles JSON-RPC messages, cleans up socket on close
5. Unit tests: MITM proxy allows/rejects hosts, filters endpoints, swaps keys correctly
6. Integration test: start proxy on UDS, connect MCP client, call tools/list

**No behavioral change** to existing stdio-based sessions.

**Files:**
- New: `src/trusted-process/uds-server-transport.ts`
- New: `src/docker/mitm-proxy.ts`, `src/docker/ca.ts`, `src/docker/provider-config.ts`, `src/docker/fake-keys.ts`
- Modified: `src/trusted-process/mcp-proxy-server.ts` (transport selection)

### Phase 2: Docker Manager and Container Lifecycle

**Goal:** Start and stop Docker containers programmatically from Node.js.

**Changes:**
1. Create `src/docker/docker-manager.ts` -- Docker CLI wrapper
2. Create `src/docker/types.ts` -- container config, mount, and result types
3. Preflight check: Docker daemon available, base image exists
4. Unit tests: mock exec, verify correct Docker CLI commands
5. Integration test (requires Docker): create, start, wait, stop, remove a minimal container

**No agent logic yet** -- just container lifecycle management.

**Files:**
- New: `src/docker/docker-manager.ts`
- New: `src/docker/types.ts`

### Phase 3: Agent Adapter Framework and Claude Code Adapter

**Goal:** Define the agent adapter interface and implement the first adapter.

**Changes:**
1. Create `src/docker/agent-adapter.ts` -- AgentAdapter interface and types
2. Create `src/docker/agent-registry.ts` -- adapter registry
3. Create `src/docker/adapters/claude-code.ts` -- Claude Code adapter
4. Create `src/docker/orientation.ts` -- orientation file generation
5. Create `Dockerfile.ironcurtain-agent` -- base Docker image
6. Build scripts for the Docker image

**Files:**
- New: `src/docker/agent-adapter.ts`
- New: `src/docker/agent-registry.ts`
- New: `src/docker/adapters/claude-code.ts`
- New: `src/docker/orientation.ts`
- New: `Dockerfile.ironcurtain-agent`

### Phase 4: Docker Agent Session

**Goal:** The `DockerAgentSession` class implementing the `Session` interface.

**Changes:**
1. Create `src/docker/docker-agent-session.ts` -- core session class
2. Create `src/docker/managed-proxy.ts` -- proxy lifecycle manager
3. Create `src/docker/audit-log-tailer.ts` -- audit log → DiagnosticEvent synthesis
4. Extract escalation polling from `AgentSession` into shared utility
5. Extend `createSession()` in `src/session/index.ts` to support `mode: { kind: 'docker', agent }`
6. Add `SessionMode` type and `tokenTrackingAvailable` to `src/session/types.ts`
7. Wire escalation IPC (same file-based rendezvous as built-in sessions)
8. Extend CLI to accept `--agent` flag

**Files:**
- New: `src/docker/docker-agent-session.ts`
- New: `src/docker/managed-proxy.ts`
- New: `src/docker/audit-log-tailer.ts`
- Modified: `src/session/index.ts` (factory extension)
- Modified: `src/session/types.ts` (SessionMode type, BudgetStatus.tokenTrackingAvailable)
- Modified: `src/index.ts` or `src/cli.ts` (CLI flag)

### Phase 5: End-to-End Testing and Hardening

**Goal:** Verify the full flow works with a real Claude Code agent.

**Changes:**
1. End-to-end test: create Docker session, run simple task, verify result
2. Concurrent session test: two Docker sessions running simultaneously
3. Escalation flow test: agent triggers escalation, user approves via CLI
4. Error handling: container crash, proxy crash, Docker unavailable
5. Cleanup hardening: stale container detection, socket file cleanup

### Phase 6: Additional Agent Adapters

**Goal:** Support additional agents beyond Claude Code.

**Changes:**
1. Goose adapter (`src/docker/adapters/goose.ts`)
2. OpenCode adapter (`src/docker/adapters/opencode.ts`)
3. Agent-specific Docker images or image layers

Each adapter is independent and can be added without modifying existing code (the adapter interface is the extension point).

## 14. Accepted Security Trade-offs

### API Key Protection via MITM Proxy

**Real API keys never enter the container.** The agent receives a randomly generated fake sentinel key (192 bits of entropy). The TLS-terminating MITM proxy on the host validates the fake key and swaps it for the real key before forwarding to the upstream API. This eliminates the key exfiltration trade-off from the original CONNECT proxy design.

**Residual risk:** A compromised agent could make excessive LLM API calls (running up costs) using the fake key via the MITM proxy. This is mitigated by:
- Per-session resource budgets (wall-clock timeout, step limits)
- Endpoint-level filtering (only completion endpoints, not admin APIs)
- Users should still configure spending limits on their API keys as defense-in-depth

## 15. Open Questions

1. **Agent output collection.** Different agents produce output differently. Claude Code with `--output-format text` writes to stdout. Other agents may write to files. The `extractResponse()` method on the adapter handles this, but we may need a more structured result format (e.g., a JSON file with response text, modified files list, and status).

2. **API key routing.** Claude Code needs `ANTHROPIC_API_KEY`. Codex needs `OPENAI_API_KEY`. Goose might use either. The adapter's `getProviders()` and `buildEnv()` methods handle this. Each provider gets its own fake sentinel key; the MITM proxy maps each fake key to the corresponding real key. Only the providers declared by the adapter are configured.

3. **Docker image management.** The hybrid approach uses pre-baked per-agent images with the agent CLI pre-installed and first-run setup completed. Who builds these images? Options: (a) user runs `ironcurtain build-images` manually, (b) `createSession()` builds on first use with caching, (c) pre-built images on a registry. For the PoC, option (b) with caching is simplest. The Dockerfile per agent lives in `docker/` in the IronCurtain repo.

4. **Project file injection.** Before the agent starts, the sandbox directory needs to contain the project files. For a "fix this repo" task, the user needs to clone or copy the repo into the sandbox. This could be automated: `ironcurtain start --agent claude-code --repo https://github.com/user/repo "Fix the bug"` would clone the repo into the sandbox before starting the container. This is a convenience feature for Phase 5+.

5. **`--append-system-prompt` persistence across turns.** The system prompt is passed via `--append-system-prompt` on every `docker exec` invocation. Verify that this flag works correctly with `--continue` (the appended prompt should apply to the resumed session, not create conflicts with the previous turn's system prompt).
