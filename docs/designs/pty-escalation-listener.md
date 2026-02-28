# Design: PTY Support and Escalation Listener for Docker Agent Mode

**Status:** Proposed
**Date:** 2026-02-27
**Author:** IronCurtain Engineering

## 1. Overview

Docker Agent Mode currently runs Claude Code inside a Docker container with `--network=none` and mediates all tool calls through IronCurtain's trusted process. However, the user experience is constrained: `sendMessage()` calls `docker exec` with a message, waits for the process to exit, and collects stdout -- there is no interactive terminal. The user cannot watch Claude Code think, cannot type follow-up messages mid-stream, and cannot see Claude Code's native TUI output (spinners, diffs, file previews).

This design adds two features:

1. **`--pty` flag on `ironcurtain start`** -- Attaches the user's terminal directly to Claude Code's PTY inside the Docker container, providing a native interactive experience. Each invocation of `--pty` runs its own independent session.

2. **`ironcurtain escalation-listener`** -- A separate command that runs in another terminal, aggregating escalation notifications from all active PTY sessions. It watches session escalation directories via file-based polling and presents a rich TUI dashboard where the user can approve or deny escalations across multiple concurrent sessions.

Together, these features give the user two terminals: one (or more) running Claude Code interactively via PTY, and one running the escalation listener that handles all policy escalations centrally.

### Why this matters

The current Docker mode is batch-oriented: send a message, wait for a response. Claude Code is designed for interactive use with its own terminal interface. PTY mode bridges this gap, letting the user interact with Claude Code as if it were running locally, while IronCurtain's policy engine still mediates every MCP tool call through the trusted process.

Escalation handling must be separated from the PTY because Claude Code owns the terminal -- there is no way to intercept keystrokes or inject prompts into Claude Code's UI. A dedicated escalation listener in a separate terminal solves this cleanly.

## 2. Architecture

### Component Diagram

```
Terminal 1 (PTY session)              Terminal 2 (PTY session)
+---------------------------+         +---------------------------+
| ironcurtain start --pty   |         | ironcurtain start --pty   |
|   socat (host)            |         |   socat (host)            |
|     |                     |         |     |                     |
|     v                     |         |     v                     |
|   Docker container        |         |   Docker container        |
|   Claude Code (TTY)       |         |   Claude Code (TTY)       |
|     |                     |         |     |                     |
|     v                     |         |     v                     |
|   Code Mode Proxy (MCP)   |         |   Code Mode Proxy (MCP)   |
|     |                     |         |     |                     |
|     v                     |         |     v                     |
|   mcp-proxy-server        |         |   mcp-proxy-server        |
|   (PolicyEngine + Audit)  |         |   (PolicyEngine + Audit)  |
+---------------------------+         +---------------------------+
        |                                     |
        | writes request-{id}.json            | writes request-{id}.json
        v                                     v
  ~/.ironcurtain/sessions/{s1}/esc/     ~/.ironcurtain/sessions/{s2}/esc/
        ^                                     ^
        | polls                               | polls
        |                                     |
+-------+-------------------------------------+-------+
|            Terminal 3 (Escalation Listener)          |
|                                                      |
|  ironcurtain escalation-listener                     |
|  +------------------------------------------------+  |
|  | Session #1 (s1)  [active]   0 pending          |  |
|  | Session #2 (s2)  [active]   1 pending          |  |
|  |                                                |  |
|  | [PENDING] #1: filesystem/write_file            |  |
|  |   Path: /home/user/Documents/report.md         |  |
|  |   Reason: Write outside sandbox                |  |
|  |                                                |  |
|  | > /approve 1  or  /deny 1                      |  |
|  +------------------------------------------------+  |
+------------------------------------------------------+
```

### Data Flow

1. **PTY session startup**: `ironcurtain start --pty "task"` creates a session (Code Mode Proxy + MCP proxy + MITM proxy), starts the Docker container with a PTY-enabled process, and uses `socat` on the host to bridge the user's terminal to the container's PTY via a forwarded port or UDS.

2. **Session registration**: On startup, the PTY session notifies the escalation listener (if running) by writing a registration file to a well-known host-side directory. On shutdown, it writes a deregistration file.

3. **Escalation flow**: When the MCP proxy escalates a tool call, it writes `request-{id}.json` to the session's escalation directory (existing behavior). The escalation listener polls this directory, detects the new file, displays it in the TUI, and waits for the user to approve or deny. The response is written as `response-{id}.json` (existing behavior). The proxy polls for the response and continues.

4. **PTY teardown**: When the user exits Claude Code (Ctrl-D or `/exit`), the container process terminates, socat detects the closed connection and exits, and the session cleanup runs (stop container, stop proxies, write deregistration).

## 3. PTY Mechanism

### How it works

The Docker container currently runs `sleep infinity` as its entrypoint, with agent commands arriving via `docker exec`. For PTY mode, we need a persistent interactive process inside the container that the user's terminal can attach to.

The approach uses `socat` on both the host and container side to bridge a PTY:

1. **Inside the container**: Start Claude Code as an interactive process with a PTY allocated. On Linux, socat listens on a UDS in the bind-mounted sockets directory (e.g., `socat UNIX-LISTEN:/run/ironcurtain/pty.sock,fork EXEC:'claude ...',pty,setsid,ctty`). On macOS, socat listens on a TCP port since VirtioFS does not support UDS.

2. **On the host**: Connect the user's terminal via `socat -,raw,echo=0 UNIX-CONNECT:<session-dir>/pty.sock` (Linux) or `socat -,raw,echo=0 TCP:localhost:<forwarded-port>` (macOS, through the sidecar).

3. **Terminal setup**: Before connecting, the host-side process puts the terminal in raw mode (`stty raw -echo`) and restores it on exit.

### Linux (UDS mode)

On Linux, Docker uses the native filesystem and `--network=none`. Since there is no network stack at all, we use a **single socat** inside the container that listens directly on a Unix domain socket in the bind-mounted sockets directory:

```
Container-side:  socat UNIX-LISTEN:/run/ironcurtain/pty.sock,fork EXEC:'claude ...',pty,setsid,ctty

Host-side:       socat -,raw,echo=0 UNIX-CONNECT:<session-dir>/sockets/pty.sock
```

This is the simplest possible bridge — one socat process, no TCP, no port assignment. The sockets directory (`sessions/{id}/sockets/`) is bind-mounted into the container at `/run/ironcurtain/`, so the UDS is accessible from both sides. The host waits for the socket file to appear (polling with a short timeout) before connecting.

**Mount isolation**: Only the `sockets/` subdirectory is mounted into the container — not the full session directory. This means the container cannot access escalation files, audit logs, or other session data. The existing `proxy.sock` and `mitm-proxy.sock` are created in this directory by the host-side proxies, and `pty.sock` is created by socat inside the container. This is a security improvement over the current implementation which mounts the entire session directory.

### macOS (TCP mode)

On macOS, Docker Desktop uses VirtioFS for bind mounts, which does not support Unix domain sockets. The existing architecture already uses TCP mode with a socat sidecar container that bridges the internal Docker network to the host. We extend this sidecar to also forward the PTY port:

```
Sidecar (existing):
  socat TCP-LISTEN:<mcpPort>,fork,reuseaddr TCP:host.docker.internal:<mcpPort> &
  socat TCP-LISTEN:<mitmPort>,fork,reuseaddr TCP:host.docker.internal:<mitmPort> &
  # NEW: forward PTY port
  socat TCP-LISTEN:<ptyPort>,fork,reuseaddr TCP:host.docker.internal:<ptyPort> &
  wait

Host-side:
  socat -,raw,echo=0 TCP:localhost:<ptyPort>
```

The PTY port is OS-assigned (port 0) and communicated back via the session directory.

### PTY Connection Readiness

The host process needs to know when the container-side socat is ready:

- **Linux**: The host polls for the `pty.sock` UDS file to appear in the session directory. No port assignment needed.
- **macOS**: A dedicated `pty-port.txt` file in the session directory communicates the TCP port number. The container entrypoint starts `socat TCP-LISTEN:0,...` (OS-assigned port) and writes the actual port to this file. The host reads it after container startup.

For robustness, the host process polls with a short timeout (5 seconds) before failing.

### Container Process Lifecycle

The existing entrypoint script is modified to end with `exec "$@"` so it can run the MITM bridge setup and then hand off to whatever CMD is provided:

```bash
#!/bin/bash
# entrypoint-claude-code.sh (updated)

# Start the MITM UDS bridge (existing, Linux only)
MITM_SOCK="/run/ironcurtain/mitm-proxy.sock"  # sockets/ dir mounted at /run/ironcurtain
PROXY_PORT=18080
if [ -S "$MITM_SOCK" ]; then
  socat TCP-LISTEN:$PROXY_PORT,fork,reuseaddr UNIX-CONNECT:$MITM_SOCK &
fi

# Hand off to CMD (sleep infinity for non-PTY, socat PTY command for PTY mode)
exec "$@"
```

- **Non-PTY mode**: CMD is `["sleep", "infinity"]` (unchanged from current behavior)
- **PTY mode**: CMD is the socat command returned by `buildPtyCommand()` — e.g., `["socat", "UNIX-LISTEN:/run/ironcurtain/pty.sock,fork", "EXEC:claude ...,pty,setsid,ctty,stderr"]`

The `exec` ensures the container's PID 1 is the socat/sleep process, so the container exits when it exits.

### AgentAdapter Extension

The `AgentAdapter` interface (`src/docker/agent-adapter.ts`) gains a new optional method:

```typescript
/**
 * Returns the Docker container command for PTY mode.
 * When provided, the container runs this command directly instead of
 * `sleep infinity`, and the host attaches via socat.
 *
 * @param message - the initial task message
 * @param systemPrompt - the orientation prompt
 * @param ptySockPath - the UDS path for the PTY listener (Linux), or undefined for TCP mode (macOS)
 * @param ptyPort - the TCP port for the PTY listener (macOS only)
 */
buildPtyCommand?(
  message: string,
  systemPrompt: string,
  ptyPort: number,
): readonly string[];
```

The Claude Code adapter (`src/docker/adapters/claude-code.ts`) implements this. To avoid shell injection (user-provided `message` and `systemPrompt` must not be embedded in shell strings), these values are written to files in the orientation directory (already bind-mounted read-only at `/etc/ironcurtain/`) and referenced by path:

```typescript
buildPtyCommand(
  message: string,
  systemPrompt: string,
  ptySockPath: string | undefined,
  ptyPort: number | undefined,
): readonly string[] {
  // The socat listener target depends on platform
  const listenArg = ptySockPath
    ? `UNIX-LISTEN:${ptySockPath},fork`       // Linux UDS
    : `TCP-LISTEN:${ptyPort},reuseaddr`;      // macOS TCP

  // message and systemPrompt are written to files in the orientation dir
  // by the PTY session module before container start — not embedded in shell strings
  return [
    'socat', listenArg,
    'EXEC:claude --dangerously-skip-permissions'
      + ' --mcp-config /etc/ironcurtain/claude-mcp-config.json'
      + ' --append-system-prompt-file /etc/ironcurtain/system-prompt.txt'
      + ' -p-file /etc/ironcurtain/initial-message.txt'
      + ',pty,setsid,ctty,stderr',
  ];
}
```

The PTY session module writes `system-prompt.txt` and `initial-message.txt` to the orientation directory before starting the container. This avoids shell metacharacter injection entirely.

### Docker TTY Allocation

The container must be created with TTY allocation for PTY mode. `DockerContainerConfig` gains an optional `tty?: boolean` flag:

```typescript
// In docker-manager.ts buildCreateArgs():
if (config.tty) {
  args.push('-t');
}
```

The PTY session module sets `tty: true` when creating the container. Non-PTY sessions continue to omit it (the existing `sleep infinity` entrypoint does not need a TTY).

Adapters that do not implement `buildPtyCommand` do not support PTY mode -- the `--pty` flag fails with a clear error message.

## 4. Escalation Protocol

The escalation protocol is unchanged from the existing implementation. Both the existing `CliTransport`/`SignalSessionTransport` and the new escalation listener use the same file-based IPC:

### Escalation Directory Structure

```
~/.ironcurtain/sessions/{sessionId}/escalations/
  request-{escalationId}.json      # Written by mcp-proxy-server.ts
  response-{escalationId}.json     # Written by session or escalation-listener
  user-context.json                # Written by session at turn start (for auto-approver)
```

### Request File Format

```typescript
interface EscalationFileRequest {
  escalationId: string;
  serverName: string;
  toolName: string;
  arguments: Record<string, unknown>;
  reason: string;
}
```

### Response File Format

```typescript
interface EscalationFileResponse {
  decision: 'approved' | 'denied';
}
```

### Atomic File Writes

All file writes in the escalation protocol **must** use write-to-temp-then-rename to prevent partial reads:

```typescript
import { writeFileSync, renameSync } from 'node:fs';

function atomicWriteJsonSync(filePath: string, data: unknown): void {
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  renameSync(tmpPath, filePath);  // atomic on same filesystem (POSIX)
}
```

This applies to:
- Proxy writing `request-{id}.json`
- Listener/session writing `response-{id}.json`
- Session registration files in `~/.ironcurtain/pty-registry/`
- `user-context.json`

### Polling Mechanism

The MCP proxy (`mcp-proxy-server.ts`) already polls for the response file at `ESCALATION_POLL_INTERVAL_MS = 500ms` with a configurable timeout (default 300 seconds). The escalation listener polls escalation directories at a similar interval.

### Who Writes the Response

In the current architecture, `DockerAgentSession.resolveEscalation()` writes the response file. In PTY mode, the escalation listener writes the response file directly -- it has write access to the session's escalation directory because it runs on the same host. The `DockerAgentSession` escalation polling loop is not active in PTY mode (the session process exits after attaching the PTY).

### Stale Escalation Detection

A race exists between escalation timeout and user response: the proxy may delete escalation files (timeout cleanup) while the listener is writing a response. To handle this:

1. **Listener side**: After writing `response-{id}.json`, verify the corresponding `request-{id}.json` still exists. If it has been deleted, the escalation expired — display "Escalation #N expired (response was too late)" in the TUI rather than showing a successful approval.
2. **Proxy side**: Before deleting escalation files on timeout, check if a `response-{id}.json` has appeared. If so, read and honor it instead of defaulting to deny. This closes the narrow window where the user responds just before timeout.
3. **Listener `resolve()` method**: `EscalationWatcher.resolve()` should return a status indicating whether the resolution was accepted or the escalation had already expired.

## 5. Session Notification Protocol

PTY sessions must notify the escalation listener about session lifecycle events. This uses a file-based rendezvous in a well-known directory.

### Notification Directory

```
~/.ironcurtain/pty-registry/
  session-{sessionId}.json         # Written on session start, deleted on session end
```

### Session Registration File

```typescript
interface PtySessionRegistration {
  /** Unique session identifier. */
  sessionId: string;
  /** Path to the session's escalation directory. */
  escalationDir: string;
  /** Human-readable label for display (e.g., agent name + task preview). */
  label: string;
  /** ISO 8601 timestamp when the session started. */
  startedAt: string;
  /** PID of the ironcurtain process managing this session. */
  pid: number;
}
```

### Lifecycle

1. **Session start**: The PTY session writes `session-{sessionId}.json` to `~/.ironcurtain/pty-registry/` immediately after the container is running and before attaching the PTY.

2. **Session end**: The PTY session deletes `session-{sessionId}.json` during cleanup (in the `finally` block, alongside container stop and proxy shutdown).

3. **Crash recovery**: If the session process dies without cleanup, the registration file persists. The escalation listener detects stale sessions by checking whether the `pid` is still alive (`process.kill(pid, 0)`) and removes stale registrations.

### Why Not UDS?

A UDS-based notification channel (the escalation listener listens on a UDS, PTY sessions connect and send messages) would be slightly more responsive but adds complexity:

- The listener must be started before PTY sessions (ordering dependency).
- If the listener crashes, PTY sessions lose their notification channel.
- UDS lifecycle management (cleanup on crash, permission management) is nontrivial.

File-based polling is simpler, has no ordering dependency, survives listener restarts, and matches the existing escalation IPC pattern. The cost is up to 300ms latency for session detection, which is acceptable for a session lifecycle event.

## 6. Escalation Module Refactoring

Currently, escalation handling logic is duplicated across three sites:

1. **`DockerAgentSession`** (`src/docker/docker-agent-session.ts`): `pollEscalationDirectory()`, `checkEscalationExpiry()`, `resolveEscalation()`.
2. **`CliTransport`** (`src/session/cli-transport.ts`): `handleEscalationCommand()`, `writeEscalationBanner()`, `createEscalationHandler()`.
3. **`SignalBotDaemon`** (`src/signal/signal-bot-daemon.ts`): `handleEscalationReply()`, `setPendingEscalation()`, `clearPendingEscalation()`.

The escalation listener would be a fourth consumer. To avoid further duplication, we extract a shared module.

### Shared Module: `src/escalation/escalation-watcher.ts`

```typescript
/**
 * Watches an escalation directory for new request files.
 * Pure data -- no I/O presentation. Consumers (CliTransport,
 * SignalBotDaemon, EscalationListener) handle display.
 */

import type { EscalationRequest } from '../session/types.js';

/** Events emitted by the escalation watcher. */
export interface EscalationWatcherEvents {
  /** A new escalation request was detected. */
  onEscalation: (request: EscalationRequest) => void;
  /** A pending escalation expired (proxy timed out and cleaned up files). */
  onEscalationExpired: (escalationId: string) => void;
}

export interface EscalationWatcher {
  /** Start polling the escalation directory. */
  start(): void;
  /** Stop polling. */
  stop(): void;
  /** Returns the currently pending escalation, if any. */
  getPending(): EscalationRequest | undefined;
  /**
   * Resolves a pending escalation by writing the response file.
   * @throws {Error} if no escalation with this ID is pending
   */
  resolve(escalationId: string, decision: 'approved' | 'denied'): void;
}

/**
 * Creates an escalation watcher for a single session's escalation directory.
 */
export function createEscalationWatcher(
  escalationDir: string,
  events: EscalationWatcherEvents,
  options?: {
    /** Poll interval in ms. Default: 300. */
    pollIntervalMs?: number;
  },
): EscalationWatcher;
```

### Migration Path

1. **Extract**: Move the polling, expiry detection, and response-writing logic from `DockerAgentSession` into `createEscalationWatcher()`.

2. **Adapt `DockerAgentSession`**: Replace `startEscalationWatcher()`, `stopEscalationWatcher()`, `pollEscalationDirectory()`, `checkEscalationExpiry()`, and `resolveEscalation()` with a single `EscalationWatcher` instance. The `onEscalation` and `onEscalationExpired` callbacks are forwarded to the watcher's events.

3. **Adapt `CliTransport` and `SignalBotDaemon`**: These do not directly poll -- they receive escalation events via the `onEscalation` callback from `SessionOptions`. No changes needed at this layer; the callback wiring stays the same. The refactoring is internal to `DockerAgentSession`.

4. **Escalation Listener**: Uses `createEscalationWatcher()` once per active session, creating a new watcher when a session registers and stopping it when the session deregisters.

### What the shared module does NOT do

- **Presentation**: The module emits data events. How to display them (CLI banner, TUI dashboard, Signal message) is the consumer's concern.
- **Auto-approval**: The auto-approver runs in the proxy process, before the escalation file is even written. The shared module only handles the human approval path.
- **User context writing**: `user-context.json` is written by the session at turn start, not by the watcher.

## 7. Escalation Listener TUI

### Technology Choice

We use `ink` (React for the terminal) for the TUI. Rationale:

- **Declarative rendering**: The dashboard state (sessions, escalations, history) maps naturally to React components. Imperative terminal libraries like `blessed` require manual redraw management.
- **Ecosystem**: `ink` has input handling (`useInput`), text input (`ink-text-input`), and layout primitives (`Box`, `Text`) out of the box.
- **Testability**: Components are testable with `ink-testing-library` without a real terminal.
- **Consistency**: The project already uses React-like patterns (component composition, state management).

### TUI Layout

```
+------------------------------------------------------------------+
|  IronCurtain Escalation Listener              2 sessions active  |
+------------------------------------------------------------------+
|                                                                  |
|  Active Sessions:                                                |
|  [1] Session a1b2c3d4  claude-code  "Fix the login bug"  2m ago |
|  [2] Session e5f6g7h8  claude-code  "Write unit tests"   5m ago |
|                                                                  |
+------------------------------------------------------------------+
|                                                                  |
|  Pending Escalations:                                            |
|                                                                  |
|  [1] Session #1 (a1b2c3d4)                                      |
|      Tool:    filesystem/write_file                              |
|      Path:    /home/user/Documents/report.md                     |
|      Reason:  Write outside sandbox directory                    |
|                                                                  |
|  [2] Session #2 (e5f6g7h8)                                      |
|      Tool:    github/create_pull_request                         |
|      Repo:    owner/repo                                         |
|      Reason:  GitHub mutation requires approval                  |
|                                                                  |
+------------------------------------------------------------------+
|                                                                  |
|  History (last 10):                                              |
|  [12:34:05] Session #1  filesystem/read_file  APPROVED           |
|  [12:33:42] Session #2  github/list_issues    APPROVED           |
|  [12:33:10] Session #1  filesystem/delete_file DENIED            |
|                                                                  |
+------------------------------------------------------------------+
|  > /approve 1                                                    |
+------------------------------------------------------------------+
```

### State Management

```typescript
interface ListenerState {
  /** Active PTY sessions discovered via the notification directory. */
  sessions: Map<string, {
    registration: PtySessionRegistration;
    watcher: EscalationWatcher;
    /** Sequential display number assigned on discovery. */
    displayNumber: number;
  }>;

  /** Pending escalations across all sessions, keyed by display number. */
  pendingEscalations: Map<number, {
    sessionId: string;
    request: EscalationRequest;
    displayNumber: number;
    receivedAt: Date;
  }>;

  /** Next display number to assign to a new escalation. */
  nextEscalationNumber: number;

  /** Rolling history of resolved escalations. */
  history: Array<{
    sessionId: string;
    toolName: string;
    decision: 'approved' | 'denied';
    resolvedAt: Date;
  }>;
}
```

### Commands

| Command | Description |
|---------|-------------|
| `/approve N` | Approve escalation with display number N |
| `/deny N` | Deny escalation with display number N |
| `/approve all` | Approve all pending escalations |
| `/deny all` | Deny all pending escalations |
| `/sessions` | List active sessions with details |
| `/quit` | Exit the escalation listener |

The display number `N` in `/approve N` and `/deny N` refers to the escalation display number shown in the "Pending Escalations" section, not the session number. This avoids ambiguity when a single session has multiple escalations (rare but possible with concurrent tool calls).

### Escalation Number Assignment

Escalation display numbers are monotonically increasing integers assigned when an escalation is first detected. They are not reused. This prevents confusion if an escalation expires and a new one arrives -- the user never accidentally approves the wrong escalation because the number was recycled.

### Sound/Bell Notification

When a new escalation arrives, the listener writes `\x07` (BEL) to the terminal. This triggers the terminal's bell/notification, alerting the user even if they are focused on the PTY terminal.

## 8. CLI Changes

### New Flag: `--pty`

Added to the `start` subcommand. Only valid when the session mode is Docker.

```
ironcurtain start --pty "Fix the login bug"
ironcurtain start --pty --agent claude-code "Write unit tests"
ironcurtain start --pty                     # Interactive: Claude Code prompts for input
```

**Validation**:
- `--pty` with builtin mode: error with message "PTY mode requires Docker agent mode. Use `--agent claude-code` or ensure Docker is available."
- `--pty` with an adapter that does not implement `buildPtyCommand`: error with message "Agent {agent} does not support PTY mode."

**Behavior**:
- Blocks until the PTY session ends (Claude Code exits or user sends Ctrl-D).
- Does not start the interactive REPL or spinner -- the terminal is fully owned by Claude Code.
- Escalation callbacks are not wired (no `onEscalation`/`onEscalationExpired`) -- the escalation listener handles those.
- Exit code reflects Claude Code's exit code.

### New Command: `escalation-listener`

```
ironcurtain escalation-listener
```

No flags needed. The listener:
1. Creates `~/.ironcurtain/pty-registry/` if it does not exist.
2. Polls the directory for session registration files.
3. For each active session, creates an `EscalationWatcher`.
4. Renders the TUI dashboard.
5. Accepts commands via the input prompt.
6. On `/quit`, stops all watchers and exits.

**Single-instance enforcement**: On startup, the listener attempts to create a lock file at `~/.ironcurtain/escalation-listener.lock` containing its PID. If the file exists and the PID is alive, it prints an error and exits. The lock file is deleted on clean exit and detected as stale on crash (PID check).

### Updated `cli.ts`

```typescript
case 'escalation-listener': {
  const { main } = await import('./escalation/listener-command.js');
  await main();
  break;
}
```

### Updated `index.ts` (start command)

The `parseArgs` options gain a `pty` flag:

```typescript
const { values, positionals } = parseArgs({
  args: args ?? process.argv.slice(2),
  options: {
    resume: { type: 'string', short: 'r' },
    agent: { type: 'string', short: 'a' },
    pty: { type: 'boolean' },
    'list-agents': { type: 'boolean' },
  },
  allowPositionals: true,
  strict: false,
});
```

When `--pty` is set, the flow diverges after session mode resolution:

```typescript
if (values.pty) {
  // Validate: must be Docker mode
  if (mode.kind !== 'docker') {
    process.stderr.write(chalk.red(
      'PTY mode requires Docker agent mode. Use --agent claude-code or ensure Docker is available.\n'
    ));
    process.exit(1);
  }

  const { runPtySession } = await import('./docker/pty-session.js');
  await runPtySession({ config, mode, task });
  return;
}
```

## 9. PTY Session Module

### New File: `src/docker/pty-session.ts`

This module orchestrates the PTY session lifecycle. It reuses the existing infrastructure (Code Mode Proxy, MITM proxy, Docker manager, CA, fake keys) but replaces the `DockerAgentSession` + `CliTransport` stack with a direct PTY attachment.

```typescript
export interface PtySessionOptions {
  config: IronCurtainConfig;
  mode: SessionMode & { kind: 'docker' };
  task: string;
}

/**
 * Runs a PTY session: starts proxies, launches container with
 * PTY-enabled Claude Code, attaches the terminal, and blocks
 * until the session ends.
 */
export async function runPtySession(options: PtySessionOptions): Promise<void>;
```

### Shared Docker Infrastructure

Steps 1–5 below are identical to `createDockerSession()`. To avoid duplication (review issue #15), extract these into a shared helper:

```typescript
// src/docker/docker-infrastructure.ts
export interface DockerInfrastructure {
  sessionId: string;
  sessionDir: string;
  sandboxDir: string;
  escalationDir: string;
  proxy: CodeModeProxy;
  mitmProxy: MitmProxy;
  docker: DockerManager;
  adapter: AgentAdapter;
  fakeKeys: Map<string, string>;
  orientationDir: string;
  systemPrompt: string;
  image: string;
}

export async function prepareDockerInfrastructure(
  config: IronCurtainConfig,
  mode: SessionMode & { kind: 'docker' },
): Promise<DockerInfrastructure>;
```

Both `createDockerSession()` and `runPtySession()` call this helper, then diverge only in how they attach to the container.

### Internal Flow

1. Call `prepareDockerInfrastructure()` (creates session dirs, starts proxies, builds orientation, ensures image).
2. Write `system-prompt.txt` and `initial-message.txt` to the orientation directory (for shell-injection-safe PTY command).
3. Create and start the Docker container with `tty: true` and the PTY command from `buildPtyCommand()` instead of `sleep infinity`.
4. For macOS TCP mode: extend the sidecar to forward the PTY port.
5. Write the session registration file to `~/.ironcurtain/pty-registry/`.
6. Wait for PTY readiness (UDS socket file on Linux, port file on macOS).
7. Start an escalation file watcher on the session's escalation directory — on new request files, emit a BEL character (`\x07`) to the user's terminal to alert them to check the escalation-listener.
8. Connect via the Node.js PTY proxy (see below), entering raw mode.
9. Wait for the connection to close (Claude Code exited or container stopped).
10. Restore terminal mode (guaranteed via try/finally — see Terminal Safety below).
11. Print diagnostic info: check container exit code/status, report OOM or crash.
12. Clean up: delete registration file, stop container, stop sidecar, stop proxies.

### Terminal Safety

Terminal raw mode must be restored on all exit paths — including crashes, SIGTERM, and socat failures. The entire PTY attachment is wrapped in try/finally, with multiple layers of safety:

```typescript
function restoreTerminal(): void {
  try {
    if (process.stdin.isTTY && process.stdin.isRaw) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  } catch { /* best effort */ }
}

// Safety net: restore terminal on any exit
process.on('exit', restoreTerminal);

// SIGTERM is not affected by raw mode (unlike SIGINT which requires Ctrl-C)
process.on('SIGTERM', () => {
  restoreTerminal();
  process.exit(128 + 15);
});
```

If the process is killed with SIGKILL (uncatchable), the terminal will be stuck in raw mode. The user can recover with `reset` or `stty sane`. This limitation should be documented in the `--pty` help text. Ctrl-\ (SIGQUIT) can be used as an emergency exit since it is not intercepted even in raw mode.

### Node.js PTY Proxy (Host Side)

Instead of spawning `socat` on the host (which would require socat as a host dependency), the PTY bridge is implemented directly in Node.js. This also enables **keystroke recording** for the auto-approver (see Section 9.1) and **SIGWINCH forwarding** for terminal resize.

```typescript
import { createConnection, Socket } from 'node:net';
import { execFile } from 'node:child_process';

interface PtyProxyOptions {
  /** UDS path (Linux) or { host, port } (macOS) */
  target: string | { host: string; port: number };
  /** Docker container ID (for SIGWINCH forwarding) */
  containerId: string;
  /** Callback for recording host→container bytes (trusted input) */
  onInput?: (data: Buffer) => void;
}

function attachPty(options: PtyProxyOptions): Promise<number> {
  const conn = typeof options.target === 'string'
    ? createConnection({ path: options.target })
    : createConnection({ host: options.target.host, port: options.target.port });

  const { stdin, stdout } = process;

  // Put terminal in raw mode
  stdin.setRawMode(true);
  stdin.resume();

  // SIGWINCH: forward terminal resize to container PTY
  const onResize = () => {
    const { columns, rows } = stdout;
    if (columns && rows) {
      execFile('docker', [
        'exec', options.containerId,
        'stty', 'cols', String(columns), 'rows', String(rows),
      ], { timeout: 5000 }, () => { /* best effort */ });
    }
  };
  stdout.on('resize', onResize);
  // Send initial size
  onResize();

  // Host → Container (trusted input, tapped for keystroke recording)
  stdin.on('data', (data: Buffer) => {
    conn.write(data);
    options.onInput?.(data);
  });

  // Container → Host (untrusted output, displayed directly)
  conn.pipe(stdout);

  return new Promise((resolve) => {
    const cleanup = () => {
      stdout.removeListener('resize', onResize);
      restoreTerminal();
    };
    conn.on('close', () => { cleanup(); resolve(0); });
    conn.on('error', () => { cleanup(); resolve(1); });
  });
}
```

This eliminates the `socat` host-side dependency entirely while providing keystroke recording and terminal resize forwarding.

### 9.1. Keystroke Recording and Auto-Approver Support

**Problem**: In PTY mode, the user types directly into Claude Code's terminal. The trusted process on the host never sees the conversation, so `user-context.json` (used by the auto-approver to understand user intent) is never written after the initial task message.

**Solution**: The Node.js PTY proxy records the host→container byte stream. This is **trusted data** — it is what the user physically typed on their keyboard, captured before it enters the untrusted container. The raw keystroke buffer is reconstructed into user input on demand using a cheap LLM.

**Design**:

1. **Keystroke buffer**: The `onInput` callback appends raw bytes to a rolling buffer (capped at a reasonable size, e.g. 32KB). The buffer is append-only during normal operation.

2. **On-demand reconstruction**: When the trusted process needs user context for an auto-approval decision (i.e., an escalation is triggered), it sends the raw keystroke buffer to a cheap/fast LLM (e.g., Haiku) with a prompt like:

   > "The following is a raw byte stream of keystrokes typed by a user into a terminal running an AI coding assistant. Reconstruct the user's most recent message/instruction, ignoring control characters, escape sequences, and terminal noise. Return only the reconstructed text."

3. **Write to `user-context.json`**: The reconstructed text is written to the session's `user-context.json` before the auto-approver evaluates the escalation. This integrates with the existing auto-approver pipeline with no changes to the auto-approver itself.

4. **Lazy evaluation**: Reconstruction only happens when there is an escalation that needs auto-approval. Most tool calls are allowed by policy and never trigger this path. This keeps costs minimal.

**Why this works**:
- The input stream is trusted (captured on the host before entering the container)
- Claude Code uses simple prompt-based input (type message, press Enter) — no complex vim-style editing
- The `/approve` and `/deny` commands happen in the escalation-listener terminal, not the PTY, so they never appear in the keystroke stream
- A cheap LLM handles the messy parts (backspace sequences, escape codes, terminal control chars) more robustly than hand-written parsing
- The user would notice if the untrusted container were manipulating the terminal in adversarial ways (e.g., injecting fake prompts), and can interrupt the session

**Security note**: The container can send escape sequences that manipulate terminal display (cursor repositioning, clearing lines, etc.), which could theoretically trick the user into typing something unintended. However, this requires active adversarial behavior that would be visually obvious to the user, who can always Ctrl+C the session. This is an acceptable risk for the auto-approver use case.

## 10. Security Considerations

### UDS Permissions

The session escalation directory (`~/.ironcurtain/sessions/{id}/escalations/`) is created with default permissions (umask-dependent, typically `0755`). Since escalation files contain tool call arguments that may include file paths or URLs:

- **Recommendation**: Create the escalation directory with `0700` permissions. This is already the case for the session directory parent, but we should be explicit.
- The PTY sessions notification directory (`~/.ironcurtain/pty-registry/`) should also be `0700`.

### File Permissions for Registration and Escalation Files

- Registration files: `0600` (only the owner can read/write).
- Escalation request/response files: `0600` (inherits from escalation directory).

### Race Conditions

**Escalation race**: If the user runs `/approve 1` in the escalation listener at the same moment the proxy's escalation timeout fires, both sides might try to write the response file. The proxy's `waitForEscalationDecision()` uses a final-check-after-deadline pattern, which handles this correctly: if the response file appears between the last poll and the deadline, it is read. If both the listener and the proxy write, the response file contains a valid decision either way (both would be `'denied'` from timeout or the user's explicit decision).

**Stale registration**: If a PTY session crashes without cleanup, the registration file persists. The escalation listener detects this via PID liveness checking and removes stale registrations. The check runs on each poll cycle.

**Concurrent response writes**: Two escalation listeners cannot run simultaneously (single-instance lock). The PTY session itself does not write escalation responses (it has no escalation handler wired). So only one process ever writes response files for a given session.

### PTY Security

The PTY connection is between the Node.js PTY proxy on the host and socat inside the Docker container. On Linux, this goes through a UDS in the bind-mounted sockets directory (`sessions/{id}/sockets/`) -- only accessible to the host user. The container only has access to this sockets directory, not the full session directory (escalation files, audit logs, etc. are inaccessible). On macOS, it goes through a TCP port, but the sidecar container bridges only the internal Docker network to the host -- the port is not exposed to the public network.

The PTY does not bypass the policy engine. Claude Code inside the container still communicates with the Code Mode Proxy via the MCP socket. Every tool call still passes through the policy engine. The PTY only carries Claude Code's terminal I/O (text, ANSI escape codes, user keystrokes) -- it does not carry MCP protocol messages.

### Lock File Security

The escalation listener lock file (`~/.ironcurtain/escalation-listener.lock`) should be created with `0600` permissions. The PID inside is validated with `process.kill(pid, 0)` which only succeeds if the calling process has permission to signal the target (same user), preventing PID-spoofing attacks from other users on a shared system.

## 11. New Type Definitions

### `src/docker/pty-types.ts`

```typescript
/**
 * Types for PTY session management and the escalation listener.
 */

/** Registration file written by PTY sessions for the escalation listener. */
export interface PtySessionRegistration {
  /** Unique session identifier (SessionId). */
  readonly sessionId: string;
  /** Absolute path to the session's escalation directory. */
  readonly escalationDir: string;
  /** Human-readable label for TUI display. */
  readonly label: string;
  /** ISO 8601 timestamp when the session started. */
  readonly startedAt: string;
  /** PID of the ironcurtain process managing this session. */
  readonly pid: number;
}

/** Well-known directory for PTY session registration files. */
export const PTY_REGISTRY_DIR_NAME = 'pty-registry';

/** Lock file name for single-instance enforcement. */
export const LISTENER_LOCK_FILE = 'escalation-listener.lock';

/** PTY socket filename (Linux UDS mode). */
export const PTY_SOCK_NAME = 'pty.sock';

/** Default PTY port inside the container (macOS TCP mode only). */
export const DEFAULT_PTY_PORT = 19000;
```

### `src/escalation/escalation-watcher.ts`

(See Section 6 for the full interface definition.)

### `src/escalation/listener-state.ts`

```typescript
/**
 * State management for the escalation listener TUI.
 */

export interface ActiveSession {
  readonly registration: PtySessionRegistration;
  readonly watcher: EscalationWatcher;
  /** Sequential display number assigned when the session was first detected. */
  readonly displayNumber: number;
}

export interface PendingEscalation {
  readonly sessionId: string;
  readonly sessionDisplayNumber: number;
  readonly request: EscalationRequest;
  /** Monotonically increasing display number for the /approve and /deny commands. */
  readonly displayNumber: number;
  readonly receivedAt: Date;
}

export interface ResolvedEscalation {
  readonly sessionId: string;
  readonly toolName: string;
  readonly serverName: string;
  readonly decision: 'approved' | 'denied';
  readonly resolvedAt: Date;
}

export interface ListenerState {
  readonly sessions: ReadonlyMap<string, ActiveSession>;
  readonly pendingEscalations: ReadonlyMap<number, PendingEscalation>;
  readonly history: readonly ResolvedEscalation[];
  readonly nextEscalationNumber: number;
  readonly nextSessionNumber: number;
}
```

## 12. Implementation Plan

### Phase 1: Escalation Watcher Module (no new features, pure refactoring)

**Goal**: Extract the shared escalation watcher from `DockerAgentSession`.

**Files changed**:
- **New**: `src/escalation/escalation-watcher.ts` -- shared polling + response-writing logic
- **Modified**: `src/docker/docker-agent-session.ts` -- replace inline escalation polling with `EscalationWatcher` instance
- **New**: `test/escalation-watcher.test.ts` -- unit tests for the extracted module

**Verification**: All existing tests pass. `DockerAgentSession` behavior is unchanged.

### Phase 2: PTY Session Infrastructure

**Goal**: Add PTY container startup, host-side Node.js PTY proxy with SIGWINCH forwarding, terminal safety, and keystroke recording. Extract shared Docker infrastructure. Improve mount security.

**Files changed**:
- **New**: `src/docker/pty-types.ts` -- type definitions
- **New**: `src/docker/pty-session.ts` -- PTY session orchestration (Node.js PTY proxy, terminal safety, BEL on escalation)
- **New**: `src/docker/docker-infrastructure.ts` -- shared `prepareDockerInfrastructure()` helper
- **Modified**: `src/session/index.ts` -- refactor `createDockerSession()` to use `prepareDockerInfrastructure()`
- **Modified**: `src/docker/docker-agent-session.ts` -- mount `sockets/` subdir instead of full session dir; create proxy/MITM sockets in `sockets/`
- **Modified**: `src/config/paths.ts` -- add `getSessionSocketsDir()`
- **Modified**: `src/docker/agent-adapter.ts` -- add optional `buildPtyCommand` method
- **Modified**: `src/docker/adapters/claude-code.ts` -- implement `buildPtyCommand` (file-based prompt, no shell injection)
- **Modified**: `src/docker/docker-manager.ts` -- add `tty?: boolean` to `DockerContainerConfig`
- **Modified**: `docker/entrypoint-claude-code.sh` -- change to `exec "$@"` pattern
- **New**: `test/pty-session.test.ts` -- unit tests with mocked Docker manager

**Verification**: Manual test on Linux: `ironcurtain start --pty "hello"` attaches to Claude Code's terminal with working resize.

### Phase 3: CLI Integration for `--pty`

**Goal**: Wire the `--pty` flag into the CLI entry point.

**Files changed**:
- **Modified**: `src/index.ts` -- add `--pty` flag parsing and validation
- **Modified**: `src/cli.ts` -- update help text

**Verification**: `ironcurtain start --pty "task"` works end-to-end. `--pty` without Docker mode shows clear error.

### Phase 4: Session Notification Protocol

**Goal**: PTY sessions register/deregister in the well-known directory.

**Files changed**:
- **Modified**: `src/docker/pty-session.ts` -- write/delete registration files
- **Modified**: `src/config/paths.ts` -- add `getSessionSocketsDir()`, `getPtyRegistryDir()`, and `getListenerLockPath()`
- **New**: `src/escalation/session-registry.ts` -- read/validate registration files, stale PID detection

**Verification**: Registration files appear in `~/.ironcurtain/pty-registry/` during PTY sessions and are cleaned up on exit.

### Phase 5: Escalation Listener Command

**Goal**: Implement the `escalation-listener` command with TUI.

**Files changed**:
- **New**: `src/escalation/listener-command.ts` -- CLI entry point
- **New**: `src/escalation/listener-state.ts` -- state management
- **New**: `src/escalation/components/` -- ink React components (Dashboard, SessionList, EscalationList, HistoryList, CommandInput)
- **Modified**: `src/cli.ts` -- add `escalation-listener` case

**Dependencies**: `ink`, `ink-text-input`, `react` (peer dependency of ink)

**Verification**: Manual test: start a PTY session in one terminal, run `escalation-listener` in another, trigger an escalation, approve it via the listener.

### Phase 6: macOS TCP Mode Support

**Goal**: Extend the sidecar container to forward the PTY port on macOS.

**Files changed**:
- **Modified**: `src/docker/pty-session.ts` -- add sidecar PTY port forwarding logic
- **Modified**: `src/docker/docker-agent-session.ts` -- share sidecar creation logic (or extract to a helper)

**Verification**: Manual test on macOS: PTY session works through the sidecar.

### Phase 7: Polish and Documentation

**Goal**: Error handling, edge cases, documentation.

**Work items**:
- Add `--pty` to the help text and README (including SIGKILL/raw-mode recovery note, Ctrl-\ emergency exit)
- Add integration tests for the escalation listener
- Implement atomic file writes (`atomicWriteJsonSync`) in existing escalation code (`mcp-proxy-server.ts`, `docker-agent-session.ts`)
- Add container exit diagnostics (OOM detection, non-zero exit code reporting)

### Dependency Graph

```
Phase 1 (Escalation Watcher) ─────────────────────┐
                                                    │
Phase 2 (PTY Infrastructure) ──── Phase 3 (CLI) ──┼── Phase 6 (macOS)
                                        │          │
Phase 4 (Session Notifications) ────────┤          │
                                        │          │
                                        └── Phase 5 (Listener TUI) ── Phase 7 (Polish)
```

Phase 1 is independent and can start immediately. Phases 2-4 can proceed in parallel after Phase 1 (Phase 4 depends on Phase 2's types but not its implementation). Phase 5 depends on Phases 1 and 4. Phase 6 depends on Phase 2. Phase 7 depends on everything.

---

## Design Review

### 1. ~~Non-Atomic File Writes Create Race Conditions for Partial Reads~~ **ADDRESSED in Section 4**

- **Severity**: ~~High~~ Resolved
- **Description**: All file writes in the escalation protocol now use write-to-temp-then-rename (`atomicWriteJsonSync`). See Section 4, "Atomic File Writes".

### 2. ~~Escalation Response File Race Between Listener and Proxy Timeout~~ **ADDRESSED in Section 4**

- **Severity**: ~~High~~ Resolved
- **Description**: Section 4 now specifies stale escalation detection: the listener verifies request files still exist after writing responses, the proxy checks for last-second responses before defaulting to deny, and `EscalationWatcher.resolve()` returns acceptance status.

### 3. ~~DockerManager Lacks TTY/Interactive Container Support~~ **ADDRESSED in Section 3 & 9**

- **Severity**: ~~High~~ Resolved
- **Description**: The design now specifies a `tty?: boolean` flag on `DockerContainerConfig` (Section 3, "Docker TTY Allocation") and the PTY session sets `tty: true` when creating the container (Section 9, step 3).

### 4. ~~Linux UDS PTY Bridge Has Incorrect Architecture~~ **ADDRESSED in Section 3**

- **Severity**: ~~High~~ Resolved
- **Description**: Section 3 now specifies a single socat with `UNIX-LISTEN` directly on the UDS — no TCP, no port assignment on Linux.

### 5. ~~No User Context (user-context.json) Written in PTY Mode Breaks Auto-Approver~~ **ADDRESSED in Section 9.1**

- **Severity**: ~~High~~ Resolved
- **Description**: The Node.js PTY proxy now records the host→container keystroke stream (trusted data). On escalation, the raw buffer is sent to a cheap LLM for reconstruction, and the result is written to `user-context.json` for the auto-approver. See Section 9.1 for the full design. This also eliminates the socat host dependency (issue #6).

### 6. ~~socat as Host-Side Dependency Not Validated~~ **ADDRESSED in Section 9**

- **Severity**: ~~Medium~~ Resolved
- **Description**: The Node.js PTY proxy replaces host-side socat entirely. The host uses `net.createConnection()` for UDS (Linux) or TCP (macOS). socat is only needed inside the container (where it's already installed in the image).

### 7. ~~Container Entrypoint Script Divergence and Duplication~~ **ADDRESSED in Section 3**

- **Severity**: ~~Medium~~ Resolved
- **Description**: The entrypoint script now ends with `exec "$@"`, passing through to whatever CMD is provided. Non-PTY mode passes `sleep infinity` as CMD; PTY mode passes the socat command from `buildPtyCommand()`. See Section 3, "Container Process Lifecycle".

### 8. ~~SIGWINCH (Terminal Resize) Not Forwarded~~ **ADDRESSED in Section 9**

- **Severity**: ~~Medium~~ Resolved
- **Description**: The Node.js PTY proxy now includes SIGWINCH forwarding: `stdout.on('resize', ...)` triggers `docker exec stty cols C rows R`. Initial size is sent on connect. See Section 9, "Node.js PTY Proxy".

### 9. ~~Ctrl-C Handling Ambiguity in PTY Mode~~ **ADDRESSED in Section 9**

- **Severity**: ~~Medium~~ Resolved
- **Description**: Section 9 now includes "Terminal Safety": `process.on('exit', restoreTerminal)` as a safety net, a SIGTERM handler for external kills, and documentation that Ctrl-\ (SIGQUIT) is the emergency exit. SIGKILL limitation is documented in help text.

### 10. EscalationWatcher Interface Assumes Single Pending Escalation

- **Severity**: Medium
- **Description**: The `EscalationWatcher` interface in Section 6 has `getPending(): EscalationRequest | undefined` (singular). However, looking at the proxy code (`mcp-proxy-server.ts`), the `CallTool` handler is invoked per tool call, and if Claude Code fires multiple tool calls in rapid succession (possible with parallel tool use), multiple `request-{id}.json` files could appear simultaneously in the escalation directory. The existing `DockerAgentSession.pollEscalationDirectory()` (line 499) also has this assumption -- it returns early if `pendingEscalation` is already set and only picks up one request at a time. While the proxy serializes tool calls via the MCP protocol (one at a time per connection), Code Mode proxy does not -- multiple sandbox executions could each trigger independent proxy processes that write escalation files concurrently.
- **Recommendation**: Clarify whether the system guarantees at-most-one escalation per session at a time (it appears to, since each proxy connection processes one tool call at a time and blocks during escalation). If so, document this invariant explicitly. If not (e.g., future multi-connection support), `EscalationWatcher` should support multiple pending escalations and `getPending()` should return an array.

### 11. PID-Based Crash Detection Has Known Limitations

- **Severity**: Medium
- **Description**: The design proposes detecting stale session registrations by checking `process.kill(pid, 0)`. This has two issues: (a) PID recycling -- on a busy system, a new process may reuse the same PID, causing the listener to believe the dead session is still alive. The window for this is typically small but nonzero. (b) On Linux, `process.kill(pid, 0)` only works for processes owned by the same user, which is the expected case but is not validated. The design correctly notes the same-user constraint in Section 10 but frames it as a security feature rather than a limitation.
- **Recommendation**: Add a secondary check: verify the process at the PID is actually an `ironcurtain` process (e.g., read `/proc/{pid}/cmdline` on Linux and check for `ironcurtain` or `node`). Alternatively, use a heartbeat mechanism: PTY sessions periodically update a `lastSeen` timestamp in their registration file, and the listener considers sessions stale if `lastSeen` is more than N seconds old. This is more robust than PID checks.

### 12. Escalation Listener Lock File Race Condition

- **Severity**: Medium
- **Description**: Section 8 describes single-instance enforcement via a lock file containing the PID. The check "if file exists and PID is alive, error and exit" has a TOCTOU race: two listener processes starting simultaneously could both check, find no lock, and both proceed to create the lock. Standard PID-file locking is vulnerable to this.
- **Recommendation**: Use `fs.openSync()` with `O_EXCL | O_CREAT` flags for atomic creation, or use advisory file locking (`flock` via an npm package). The `O_EXCL` approach is simpler and sufficient: `fs.writeFileSync(lockPath, String(pid), { flag: 'wx' })` throws `EEXIST` if the file already exists.

### 13. ~~Session Directory Mount Permissions for Escalation Listener~~ **ADDRESSED in Section 3**

- **Severity**: ~~Medium~~ Resolved
- **Description**: The design now mounts only `sessions/{id}/sockets/` (not the full session directory) into the container at `/run/ironcurtain`. This directory contains only UDS files (`proxy.sock`, `mitm-proxy.sock`, `pty.sock`) and is safe to mount read-write. Escalation files, audit logs, and other session data are inaccessible to the container. This is a security improvement over the current implementation. The existing `docker-agent-session.ts` should also be updated to use the `sockets/` subdirectory.

### 14. Missing Cleanup of Orphaned PTY Sockets and Registration Files

- **Severity**: Medium
- **Description**: If the host process (running `ironcurtain start --pty`) is killed with SIGKILL (which cannot be caught), the terminal is left in raw mode, the Docker container continues running, the registration file persists, and the UDS socket file remains. The escalation listener handles the registration file (PID check), but there is no mechanism to clean up the running container or restore the terminal.
- **Recommendation**: Add a startup sweep to `runPtySession()` that checks for containers with the `ironcurtain.session` label whose managing PID is dead, and cleans them up. Also consider writing a `cleanup-sessions` subcommand for manual recovery. For terminal restoration, consider registering a handler with `process.on('exit')` which fires even on SIGKILL... actually it does not fire on SIGKILL. Document this limitation and suggest `reset` as a terminal recovery command.

### 15. ~~The Design Duplicates Docker Infrastructure Setup~~ **ADDRESSED in Section 9**

- **Severity**: ~~Medium~~ Resolved
- **Description**: Section 9 now specifies a shared `prepareDockerInfrastructure()` helper in `src/docker/docker-infrastructure.ts`. Both `createDockerSession()` and `runPtySession()` call this helper.

### 16. ~~No Feedback When Escalation Listener Is Not Running~~ **ADDRESSED in Section 9**

- **Severity**: ~~Medium~~ Resolved
- **Description**: Section 9, step 7 specifies that the PTY session watches the escalation directory and emits a BEL character (`\x07`) to the user's terminal when a new escalation request appears, alerting them to check the escalation-listener terminal.

### 17. ~~`buildPtyCommand` Shell Quoting Vulnerability~~ **ADDRESSED in Section 3**

- **Severity**: ~~Medium~~ Resolved
- **Description**: `buildPtyCommand()` now references files in the orientation directory (`system-prompt.txt`, `initial-message.txt`) instead of embedding user input in shell strings. See Section 3, "AgentAdapter Extension".

### 18. `ink` Dependency Adds React to the Dependency Tree

- **Severity**: Low
- **Description**: Section 7 proposes `ink` (React for the terminal) for the TUI. This adds `react`, `react-dom` (or its terminal equivalent), and `ink` to the project's dependency tree. The project currently has zero React dependencies. Adding React (~300KB minified) for a single TUI screen is heavyweight. The rationale mentions "the project already uses React-like patterns" but this is about code patterns, not actual React usage.
- **Recommendation**: Consider lighter alternatives: `@clack/prompts` (already a project dependency, used by `config-command.ts`), `blessed` or `blessed-contrib`, or a simple hand-rolled approach using ANSI escape codes and readline (the TUI is essentially a scrolling list with a command prompt). If `ink` is chosen, ensure it is a production dependency, not dev-only, since `escalation-listener` ships as a user-facing command.

### 19. EscalationWatcher Migration May Break DockerAgentSession Single-Escalation Semantics

- **Severity**: Low
- **Description**: The current `DockerAgentSession.pollEscalationDirectory()` skips polling when `this.pendingEscalation` is set (line 499), ensuring at most one escalation is surfaced to the UI at a time. The proposed `EscalationWatcher` interface does not specify this behavior -- it has `getPending()` (singular) but no documented contract about whether it buffers additional requests. If the watcher emits `onEscalation` for every new request file it finds, and the `DockerAgentSession` consumer does not suppress duplicates, the `onEscalation` callback could fire while a previous escalation is still pending.
- **Recommendation**: Document the at-most-one-pending invariant in the `EscalationWatcher` interface. The watcher should buffer additional requests internally and emit `onEscalation` for the next one only after the current one is resolved or expired.

### 20. Hardcoded Port 19000 May Conflict with Multiple Container Sessions

- **Severity**: Low
- **Description**: `DEFAULT_PTY_PORT = 19000` is used inside the container. Since each PTY session runs in its own container with `--network=none`, there is no port conflict between sessions. However, the design mentions "Port 0 = OS-assigned" in one place (Section 3, PTY Port Assignment) but uses hardcoded `19000` in the `buildPtyCommand` example and `DEFAULT_PTY_PORT`. This inconsistency could cause confusion during implementation.
- **Recommendation**: Choose one approach and be consistent. Since each container has its own network namespace (even `--network=none` gives a private loopback), port 19000 is fine and simpler than OS-assigned. Remove the "Port 0" references, or switch entirely to OS-assigned ports if there is a reason to.

### 21. No Mechanism for Escalation Listener to Discover Session Task Description

- **Severity**: Low
- **Description**: The `PtySessionRegistration` includes a `label` field described as "Human-readable label for display (e.g., agent name + task preview)." However, in PTY mode there is no `sendMessage()` call with the task text available at the time the registration file is written. The initial message is passed directly to Claude Code via the socat command. The label would need to be synthesized from the CLI arguments.
- **Recommendation**: Have `runPtySession()` construct the label from the agent name and a truncated version of the task string (e.g., `"claude-code: Fix the login bug"`). If no task is provided (interactive PTY mode), use `"claude-code: interactive"`.

### 22. Missing Graceful Degradation When Docker Container Exits Unexpectedly

- **Severity**: Low
- **Description**: Section 9 step 12 says "Wait for socat to exit (meaning Claude Code exited or the connection dropped)." If the Docker container crashes (OOM kill, Docker daemon restart, etc.), socat on the host side sees a closed connection and exits. The cleanup code runs. However, there is no diagnostic output to the user explaining *why* the session ended. The terminal is in raw mode, so the user sees nothing -- the terminal just returns to the shell prompt (after raw mode restoration).
- **Recommendation**: After socat exits and the terminal is restored, check the container's exit code and status (`docker inspect -f '{{.State.ExitCode}}' <id>`). If it is non-zero or if the state is `OOMKilled`, print a diagnostic message to stderr explaining what happened.

### 23. Design Does Not Address `process.exit(0)` in `src/index.ts`

- **Severity**: Low
- **Description**: The current `src/index.ts` ends with `process.exit(0)` in the finally block (line 128). The design proposes adding a `--pty` branch that calls `runPtySession()` and returns (Section 8, line "await runPtySession({...}); return;"). However, the `process.exit(0)` at the end of `main()` will fire on the normal path, and the signal handler also calls `process.exit()`. The PTY session needs its own signal handling (SIGTERM for cleanup) and its own exit path that restores the terminal before exiting. If the existing `handleSignal()` fires during PTY mode, it calls `transport.close()` on a `CliTransport` that was never started, which is benign but indicates the signal handling was not designed for the PTY path.
- **Recommendation**: The `--pty` branch should install its own signal handlers and manage its own process lifecycle, independent of the existing `main()` flow. The early `return` after `runPtySession()` in the design is correct, but ensure signal handlers from the non-PTY path are not registered when `--pty` is active.
