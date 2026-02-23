# Docker Agent Broker Design (designed 2026-02-23)

## Full Spec
- `docs/design/docker-agent-broker.md`

## Key Architecture
- IronCurtain becomes broker for external agents (Claude Code, Goose, etc.) in Docker containers
- Two-layer defense: Docker (agent-level) + bubblewrap/srt (MCP server-level) -- orthogonal
- Same `Session` interface for both built-in and Docker sessions
- `SessionMode = { kind: 'builtin' } | { kind: 'docker', agent: AgentId }`

## MCP Proxy Transport
- Existing stdio transport for built-in sessions (unchanged)
- New UDS transport for Docker sessions: `~/.ironcurtain/sessions/{id}/proxy.sock`
- Env var selection: `PROXY_TRANSPORT=uds` + `PROXY_SOCKET_PATH`
- Fallback: TCP (for Docker Desktop on Windows)

## Docker Container Design
- `--network=none` -- no network access
- Volume mounts: sandbox dir -> /workspace, UDS -> /run/ironcurtain/proxy.sock, orientation -> /etc/ironcurtain
- Non-root user, `--cap-drop=ALL`
- socat bridge for agents expecting stdio MCP: `socat STDIO UNIX-CONNECT:/run/ironcurtain/proxy.sock`

## Agent Adapter Pattern
- `AgentAdapter` interface: getImage(), generateMcpConfig(), generateOrientationFiles(), buildCommand(), buildEnv(), extractResponse()
- Registry: Map<AgentId, AgentAdapter>, registerAgent()/getAgent()
- Claude Code adapter: `--dangerously-skip-all-permissions`, settings.json with mcpServers pointing to socat->UDS
- Per-agent orientation files (CLAUDE.md for Claude Code)

## New Files (planned)
- `src/docker/docker-agent-session.ts` -- DockerAgentSession implements Session
- `src/docker/managed-proxy.ts` -- spawns proxy in UDS mode
- `src/docker/docker-manager.ts` -- Docker CLI wrapper
- `src/docker/agent-adapter.ts` -- AgentAdapter interface
- `src/docker/agent-registry.ts` -- adapter registry
- `src/docker/adapters/claude-code.ts` -- first adapter
- `src/docker/orientation.ts` -- orientation file generation
- `src/trusted-process/uds-server-transport.ts` -- MCP SDK UDS transport
- `Dockerfile.ironcurtain-agent` -- base image

## 6-Phase Implementation
1. UDS transport for MCP proxy
2. Docker manager + container lifecycle
3. Agent adapter framework + Claude Code adapter
4. DockerAgentSession class
5. End-to-end testing + hardening
6. Additional agent adapters (Goose, OpenCode)
