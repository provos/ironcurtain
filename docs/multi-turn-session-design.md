# Design: Multi-Turn Session Architecture

**Status:** Proposed (decisions finalized)
**Date:** 2026-02-17

## Problem

IronCurtain is currently single-shot: `src/index.ts` bootstraps one config, one sandbox, runs one `runAgent()` call with `generateText()`, and exits. There is no concept of a "session." The agent has no conversation history management. Every invocation pays the full startup cost (sandbox creation, MCP proxy process spawn, tool discovery) for a single exchange.

This design introduces a **Session** abstraction that transforms IronCurtain from a one-shot task runner into an interactive assistant. A user can send multiple messages to the same agent session, the agent retains conversation context across messages, and all resources (sandbox, policy engine, audit log) persist for the session's lifetime.

This is the first step in a three-part progression:
1. **Multi-turn sessions** (this design) -- defines the session abstraction
2. **Messaging/UI integration** -- new transports for web, Slack, etc.
3. **Concurrent agents** -- multiple sessions running in parallel

The session abstraction is the prerequisite for both later phases. We must be intentional about session boundaries: the session owns its resources rather than relying on global state, so concurrent agents becomes straightforward later.

## Directory Layout

All IronCurtain runtime data lives under a single home directory, defaulting to `~/.ironcurtain/`. This is overridable via the `IRONCURTAIN_HOME` environment variable.

```
~/.ironcurtain/                          # IRONCURTAIN_HOME
├── config/                              # future: user config, constitution overrides
├── sessions/
│   └── {sessionId}/
│       ├── sandbox/                     # ALLOWED_DIRECTORY for this session
│       ├── escalations/                 # IPC files for escalation routing
│       └── audit.jsonl                  # per-session audit log
└── logs/                                # pipeline logs, llm-interactions, etc.
```

Each session gets its own isolated subdirectory under `sessions/`. This provides:

- **Per-session isolation**: sandbox files, escalation IPC, and audit logs are scoped to the session that created them. Concurrent sessions never interfere with each other.
- **Persistence across reboots**: audit logs and session artifacts survive system restarts (unlike `/tmp/` which is often cleared on reboot).
- **Single location**: all runtime data is findable in one place, simplifying debugging, backup, and cleanup.
- **Config migration path**: the `config/` directory provides a natural home for future user-level configuration (constitution overrides, model preferences, etc.) without polluting the project source tree.

The home directory is resolved at startup via a utility function:

```typescript
// src/config/paths.ts

import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Returns the IronCurtain home directory.
 * Defaults to ~/.ironcurtain, overridable via IRONCURTAIN_HOME env var.
 */
export function getIronCurtainHome(): string {
  return process.env.IRONCURTAIN_HOME ?? resolve(homedir(), '.ironcurtain');
}

/**
 * Returns the session directory for a given session ID.
 * Creates the directory tree structure if it does not exist.
 */
export function getSessionDir(sessionId: string): string {
  return resolve(getIronCurtainHome(), 'sessions', sessionId);
}
```

**Cleanup of old sessions**: Session directories accumulate over time. The `createSession` factory does not perform cleanup of stale sessions -- this is a separate concern. A future `ironcurtain cleanup` CLI command can scan `~/.ironcurtain/sessions/`, identify sessions older than a threshold, and remove them. For the tracer bullet, manual cleanup via `rm -rf ~/.ironcurtain/sessions/*` is sufficient.

## Design Overview

```
                          +-----------------+
                          |   Entry Point   |
                          |  src/index.ts   |
                          +--------+--------+
                                   |
                        creates session + transport
                                   |
                    +--------------+--------------+
                    |                             |
           +-------v-------+           +---------v---------+
           |   Transport    |           |     Session       |
           |  (interface)   |           |   (interface)     |
           +-------+-------+           +---------+---------+
                   |                              |
           +-------v-------+           +---------v---------+
           |  CliTransport  |  calls    |   AgentSession    |
           | (stdin/stdout) +---------->|  (implementation) |
           +-------+-------+ sendMsg   +---------+---------+
                   |                              | owns
                   | reads/writes                 |
                   | escalation                   |
                   | response files  +------------+------------+----------+
                   |                 |            |            |          |
                   |       +---------v---+ +------v------+ +--v-------+ +v-----------+
                   |       |   Sandbox   | |Conversation | | Config   | | Escalation |
                   |       |             | |  History    | |          | |   Dir      |
                   |       +------+------+ |ModelMessage | +----------+ +--+---------+
                   |              |        |  array      |                 |
                   |              |        +-------------+                 |
                   |       +------v------+                                 |
                   |       |  MCP Proxy  +---------------------------------+
                   |       |             |  writes escalation request files
                   |       +------+------+  polls for response files
                   |              |
                   |       +------v------+
                   |       | PolicyEngine|
                   |       |  AuditLog   |
                   |       +-------------+
                   |
                   +--> /approve, /deny slash commands write response files
```

**Dependency direction**: Transport depends on Session (interface). Session owns Sandbox, Config, and the escalation directory. The proxy process communicates escalation state through the filesystem (the escalation directory). Nothing in the proxy depends on session types -- the coupling is purely through file conventions.

## Key Design Decisions

**1. Session owns all resources; nothing is global.** Today, `src/index.ts` creates a `Sandbox` in module scope and `runAgent()` constructs tools and calls `generateText()` as a standalone function. The session must own the sandbox, config, conversation history, and a per-session audit log as instance state. This is the prerequisite for concurrent agents later -- two sessions must not share mutable state.

**2. The agent becomes stateful, the session is its container.** Currently `runAgent()` is a pure function: task in, text out. Multi-turn requires accumulating `ModelMessage[]` across calls. Rather than making `runAgent()` accept and return message arrays (which pushes state management onto the caller), the session owns the history and the agent operates on it.

**3. Transport is an interface with escalation support.** The session accepts messages via `sendMessage()` and surfaces escalations via an `onEscalation` callback. A transport reads from some external source (stdin, HTTP, WebSocket), calls `sendMessage()`, and handles escalation notifications. The session never imports readline or HTTP -- that is the transport's job. Diagnostic logging (tool call previews, agent text) is also delegated to the transport via an `onDiagnostic` callback, rather than hardcoded stderr writes.

**4. The AI SDK's `messages` array is the natural history format.** `generateText()` accepts `messages: Array<ModelMessage>` and returns `response.messages: Array<ResponseMessage>`. Multi-turn is: append a `UserModelMessage` for the new input, call `generateText()` with the full history, then append the `ResponseMessage[]` to the history.

**5. `generateText()` per turn, not `streamText()` (for now).** Streaming is a UI concern and belongs in the transport layer. The session produces complete responses. A future streaming design can be layered on without changing the session interface.

**6. Context window exhaustion fails clearly.** No automatic pruning or summarization. If the message history exceeds the model's context window, `generateText()` throws an error, which propagates to the transport for display. The `SessionOptions.maxHistoryMessages` field is defined as an extension point but not enforced.

**7. Backward compatibility via a thin wrapper.** The existing `npm start "task"` invocation creates a session, sends one message, prints the result, and exits. No behavioral change.

**8. Sandbox injection via factory pattern.** `SessionOptions` includes a `sandboxFactory` field that takes `(config: IronCurtainConfig) => Promise<Sandbox>`. The default factory creates a real `Sandbox` (wrapping UTCP Code Mode's V8 isolate). Tests provide a factory returning a mock. This is cleaner than an `@internal` constructor parameter and enables future sandbox implementations (e.g., remote sandboxes).

**9. Per-session audit log files.** Each session generates its own audit log at `~/.ironcurtain/sessions/{sessionId}/audit.jsonl`. This avoids interleaved writes from concurrent sessions and simplifies per-session auditing.

**10. Escalation routing via file-based IPC.** The proxy process cannot use stdin (occupied by MCP JSON-RPC) or direct IPC (spawned by Code Mode, not by IronCurtain). Instead, escalations are communicated through a per-session escalation directory (`~/.ironcurtain/sessions/{sessionId}/escalations/`): the proxy writes a request file, polls for a response file, and the transport (via the session) writes the response. See the Escalation Architecture section for details.

**11. Shared system prompt utility.** `buildSystemPrompt()` is extracted from `src/agent/index.ts` into `src/agent/prompts.ts` as a shared utility, imported by both the (deprecated) `runAgent()` and the new `AgentSession`.

**12. Structured home directory.** All runtime data lives under `~/.ironcurtain/` (overridable via `IRONCURTAIN_HOME`). Each session gets an isolated subdirectory for its sandbox, escalation IPC, and audit log. This replaces the previous scattered `/tmp/ironcurtain-*` paths with a single, organized location that survives reboots and supports concurrent sessions naturally.

## Interface Definitions

### Session Types (`src/session/types.ts`)

```typescript
import type { IronCurtainConfig } from '../config/types.js';
import type { Sandbox } from '../sandbox/index.js';

/**
 * Unique identifier for a session. Branded to prevent accidental
 * mixing with other string identifiers.
 */
export type SessionId = string & { readonly __brand: 'SessionId' };

/** Creates a new unique SessionId. */
export function createSessionId(): SessionId;

/**
 * The possible states a session can be in. Linear progression:
 * initializing -> ready -> (processing <-> ready) -> closed.
 *
 * - initializing: sandbox and resources being set up
 * - ready: accepting messages
 * - processing: a message is being processed (generateText in flight)
 * - closed: resources released, no more messages accepted
 */
export type SessionStatus = 'initializing' | 'ready' | 'processing' | 'closed';

/**
 * A single turn in the conversation. Captures what the user said,
 * what the agent responded, and metadata about the turn.
 */
export interface ConversationTurn {
  /** 1-based turn number within this session. */
  readonly turnNumber: number;

  /** The user's input for this turn. */
  readonly userMessage: string;

  /** The agent's final text response for this turn. */
  readonly assistantResponse: string;

  /** Token usage for this turn (prompt + completion). */
  readonly usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };

  /** ISO 8601 timestamp when this turn started. */
  readonly timestamp: string;
}

/**
 * A diagnostic event emitted during message processing.
 * Transports decide how (or whether) to display these.
 */
export type DiagnosticEvent =
  | { readonly kind: 'tool_call'; readonly toolName: string; readonly preview: string }
  | { readonly kind: 'agent_text'; readonly preview: string }
  | { readonly kind: 'step_finish'; readonly stepIndex: number };

/**
 * Read-only snapshot of session state. Exposed to transports
 * and external observers without giving them mutation access.
 */
export interface SessionInfo {
  readonly id: SessionId;
  readonly status: SessionStatus;
  readonly turnCount: number;
  readonly createdAt: string;
}

/**
 * Factory function for creating sandbox instances.
 * The default creates a real Sandbox wrapping UTCP Code Mode's V8 isolate.
 * Tests provide a factory returning a mock.
 */
export type SandboxFactory = (config: IronCurtainConfig) => Promise<Sandbox>;

/**
 * Escalation request data surfaced to the transport.
 * Decoupled from ToolCallRequest to avoid leaking internal types
 * to transport implementations.
 */
export interface EscalationRequest {
  /** Unique ID for this escalation, used to match approve/deny responses. */
  readonly escalationId: string;
  readonly toolName: string;
  readonly serverName: string;
  readonly arguments: Record<string, unknown>;
  readonly reason: string;
}

/**
 * Options for creating a session. Extends the base config with
 * session-specific overrides.
 */
export interface SessionOptions {
  /** Base configuration. If omitted, loaded from environment. */
  config?: IronCurtainConfig;

  /**
   * Maximum number of messages to retain in history before pruning.
   * Defined as an extension point but not enforced in the initial
   * implementation. When the context window is exceeded,
   * generateText() throws and the error propagates to the transport.
   */
  maxHistoryMessages?: number;

  /**
   * Factory for creating sandbox instances.
   * Default: creates a real Sandbox (UTCP Code Mode V8 isolate).
   * Tests provide a factory returning a mock.
   */
  sandboxFactory?: SandboxFactory;

  /**
   * Callback invoked when the proxy surfaces an escalation.
   * The transport uses this to notify the user and collect approval.
   * If not provided, escalations are auto-denied.
   */
  onEscalation?: (request: EscalationRequest) => void;

  /**
   * Callback invoked during message processing with diagnostic events.
   * Transports use this to display progress (e.g., tool call previews).
   * If not provided, diagnostics are silently dropped.
   */
  onDiagnostic?: (event: DiagnosticEvent) => void;
}
```

### Session Interface (`src/session/types.ts` continued)

```typescript
/**
 * The core session contract. A session is a stateful conversation
 * that owns its sandbox, policy engine, and message history.
 *
 * Invariants:
 * - sendMessage() can only be called when status is 'ready'
 * - sendMessage() is not reentrant (status transitions to 'processing')
 * - After close(), no methods except getInfo() are valid
 * - The session ID is unique and immutable for the session's lifetime
 */
export interface Session {
  /** Returns a read-only snapshot of session state. */
  getInfo(): SessionInfo;

  /**
   * Sends a user message and returns the agent's response.
   *
   * Appends the user message to conversation history, calls the LLM
   * with the full history, appends the response messages, and returns
   * the agent's text.
   *
   * @throws {SessionNotReadyError} if status is not 'ready'
   * @throws {SessionClosedError} if session has been closed
   */
  sendMessage(userMessage: string): Promise<string>;

  /**
   * Returns the conversation history as turn summaries.
   * Does not expose raw ModelMessage[] to avoid coupling
   * callers to the AI SDK's internal message format.
   */
  getHistory(): readonly ConversationTurn[];

  /**
   * Returns accumulated diagnostic events from all turns.
   * Transports can use this for a /logs command or similar.
   */
  getDiagnosticLog(): readonly DiagnosticEvent[];

  /**
   * Resolves a pending escalation. Called by the transport
   * when the user approves or denies via a slash command.
   *
   * Writes the response to the escalation directory so the
   * proxy process can pick it up and continue.
   *
   * @throws {Error} if no escalation with this ID is pending
   */
  resolveEscalation(escalationId: string, decision: 'approved' | 'denied'): Promise<void>;

  /**
   * Returns any currently pending escalation, or undefined.
   */
  getPendingEscalation(): EscalationRequest | undefined;

  /**
   * Releases all session resources: sandbox, MCP connections,
   * audit log, escalation directory. Idempotent -- safe to call
   * multiple times. After close(), status becomes 'closed'.
   */
  close(): Promise<void>;
}
```

### Transport Interface (`src/session/transport.ts`)

```typescript
import type { Session } from './types.js';

/**
 * A transport delivers messages between an external source and a session.
 * It is responsible for:
 * - Reading input from its source (stdin, HTTP, WebSocket, etc.)
 * - Calling session.sendMessage() with each input
 * - Delivering the response back to the source
 * - Handling slash commands (including escalation approval)
 * - Signaling when the conversation should end
 *
 * The transport does NOT own the session -- the caller creates the session
 * and passes it to the transport. This allows the same session to be
 * used with different transports (e.g., migrate from CLI to web mid-session).
 */
export interface Transport {
  /**
   * Starts the transport's message loop. Returns when the transport
   * is done (user typed /quit, connection closed, etc.).
   *
   * The transport must handle errors from session.sendMessage()
   * gracefully (display to user, continue accepting input).
   */
  run(session: Session): Promise<void>;
}
```

### Session Errors (`src/session/errors.ts`)

```typescript
/**
 * Base class for session-related errors. Uses a discriminant
 * `code` field for programmatic handling without instanceof checks.
 */
export class SessionError extends Error {
  constructor(
    message: string,
    public readonly code: SessionErrorCode,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

export type SessionErrorCode =
  | 'SESSION_NOT_READY'
  | 'SESSION_CLOSED'
  | 'SESSION_INIT_FAILED'
  | 'MESSAGE_FAILED';

export class SessionNotReadyError extends SessionError {
  constructor(currentStatus: string) {
    super(
      `Session is not ready to accept messages (current status: ${currentStatus})`,
      'SESSION_NOT_READY',
    );
    this.name = 'SessionNotReadyError';
  }
}

export class SessionClosedError extends SessionError {
  constructor() {
    super('Session has been closed', 'SESSION_CLOSED');
    this.name = 'SessionClosedError';
  }
}
```

### Session Factory (`src/session/index.ts`)

```typescript
import type { Session, SessionOptions } from './types.js';

/**
 * Creates and initializes a new session.
 *
 * This is the only public entry point for session creation.
 * The concrete implementation (AgentSession) is not exported --
 * callers depend on the Session interface only.
 *
 * The factory:
 * 1. Resolves config (from options or loadConfig())
 * 2. Generates a SessionId
 * 3. Creates the session directory tree:
 *      ~/.ironcurtain/sessions/{sessionId}/
 *      ~/.ironcurtain/sessions/{sessionId}/sandbox/
 *      ~/.ironcurtain/sessions/{sessionId}/escalations/
 * 4. Overrides the config's allowedDirectory and auditLogPath
 *    to point to the session-specific paths
 * 5. Creates the sandbox via sandboxFactory (or the default factory)
 * 6. Initializes the session and returns it in 'ready' state
 *
 * @throws {SessionError} with code SESSION_INIT_FAILED if
 *   sandbox or MCP connection setup fails.
 */
export async function createSession(options?: SessionOptions): Promise<Session>;

// Re-export types needed by callers
export type {
  Session,
  SessionOptions,
  SessionInfo,
  SessionId,
  ConversationTurn,
  DiagnosticEvent,
  EscalationRequest,
  SandboxFactory,
} from './types.js';
export type { Transport } from './transport.js';
export { SessionError, SessionNotReadyError, SessionClosedError } from './errors.js';
```

### Path Utilities (`src/config/paths.ts`)

```typescript
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Returns the IronCurtain home directory.
 * Defaults to ~/.ironcurtain, overridable via IRONCURTAIN_HOME env var.
 */
export function getIronCurtainHome(): string {
  return process.env.IRONCURTAIN_HOME ?? resolve(homedir(), '.ironcurtain');
}

/**
 * Returns the sessions base directory: {home}/sessions/
 */
export function getSessionsDir(): string {
  return resolve(getIronCurtainHome(), 'sessions');
}

/**
 * Returns the session directory for a given session ID:
 *   {home}/sessions/{sessionId}/
 */
export function getSessionDir(sessionId: string): string {
  return resolve(getSessionsDir(), sessionId);
}

/**
 * Returns the sandbox directory for a given session:
 *   {home}/sessions/{sessionId}/sandbox/
 */
export function getSessionSandboxDir(sessionId: string): string {
  return resolve(getSessionDir(sessionId), 'sandbox');
}

/**
 * Returns the escalation IPC directory for a given session:
 *   {home}/sessions/{sessionId}/escalations/
 */
export function getSessionEscalationDir(sessionId: string): string {
  return resolve(getSessionDir(sessionId), 'escalations');
}

/**
 * Returns the audit log path for a given session:
 *   {home}/sessions/{sessionId}/audit.jsonl
 */
export function getSessionAuditLogPath(sessionId: string): string {
  return resolve(getSessionDir(sessionId), 'audit.jsonl');
}

/**
 * Returns the logs directory: {home}/logs/
 */
export function getLogsDir(): string {
  return resolve(getIronCurtainHome(), 'logs');
}
```

### System Prompt Utility (`src/agent/prompts.ts`)

```typescript
/**
 * Builds the system prompt for the agent. Shared between
 * the legacy runAgent() function and the new AgentSession.
 */
export function buildSystemPrompt(
  codeModePrompt: string,
  toolInterfaces: string,
): string {
  return `You are a helpful assistant. You complete tasks by writing TypeScript code that executes in a secure sandbox.

Every tool call in your code goes through a security policy engine. Calls may be ALLOWED, DENIED, or require ESCALATION (human approval). If a call is denied, do NOT retry it -- explain the denial to the user.

${codeModePrompt}

## Currently available tool interfaces

${toolInterfaces}
`;
}
```

## Escalation Architecture

### The Problem

The MCP proxy server runs as a child process spawned by UTCP Code Mode. IronCurtain does not have a direct process handle to it. The proxy's stdin/stdout are occupied by the MCP JSON-RPC protocol, and its stderr is inherited (unstructured, shared with the parent). There is no built-in IPC channel between the proxy and the session.

When the proxy's policy engine evaluates a tool call as `escalate`, it needs to:
1. Notify the session that human approval is needed
2. Block the tool call until the human responds
3. Either forward the call (approved) or return a denial (denied)

Currently, the proxy auto-denies all escalations because it has no way to prompt the user. In interactive mode, we can do better.

### Design: File-Based Escalation Rendezvous

The session creates a per-session escalation directory at `~/.ironcurtain/sessions/{sessionId}/escalations/`. The directory path is passed to the proxy via environment variable. The proxy and session communicate through files in this directory.

#### Protocol

```
1. Proxy evaluates tool call -> decision is 'escalate'
2. Proxy writes: {escalationDir}/request-{uuid}.json
   Contains: { escalationId, serverName, toolName, arguments, reason }
3. Proxy polls: {escalationDir}/response-{uuid}.json
   Polls every 500ms with a configurable timeout (default 5 minutes)
4. Meanwhile, session detects new request file (via fs.watch or polling)
5. Session calls onEscalation callback -> transport notifies the user
6. User types /approve or /deny
7. Transport calls session.resolveEscalation(id, decision)
8. Session writes: {escalationDir}/response-{uuid}.json
   Contains: { decision: 'approved' | 'denied' }
9. Proxy reads the response file, acts accordingly
10. Both files are cleaned up after the proxy reads the response
```

#### Sequence Diagram

```
  User          CliTransport       Session          Escalation Dir        MCP Proxy
   |                |                 |                   |                  |
   |  "read /etc/x" |                 |                   |                  |
   |--------------->|                 |                   |                  |
   |                | sendMessage()   |                   |                  |
   |                |---------------->|                   |                  |
   |                |                 | generateText()    |                  |
   |                |                 |---.               |                  |
   |                |                 |   | execute_code  |                  |
   |                |                 |   | (sandbox)     |                  |
   |                |                 |   |               |  tools/call      |
   |                |                 |   |               |<----- ... -------|
   |                |                 |   |               |                  |
   |                |                 |   |               |  policy: escalate|
   |                |                 |   |               |                  |
   |                |                 |   |               | write request    |
   |                |                 |   |               |<-----------------|
   |                |                 |   |               |                  |
   |                |                 | detect request    |  poll response   |
   |                |                 |<------------------|  (blocking)      |
   |                |                 |                   |<- - - - - - - - -|
   |                | onEscalation()  |                   |                  |
   |                |<----------------|                   |                  |
   | [ESCALATION]   |                 |                   |                  |
   |<---------------|                 |                   |                  |
   |                |                 |                   |                  |
   | /approve       |                 |                   |                  |
   |--------------->|                 |                   |                  |
   |                | resolveEscalation()                 |                  |
   |                |---------------->|                   |                  |
   |                |                 | write response    |                  |
   |                |                 |------------------>|                  |
   |                |                 |                   |  read response   |
   |                |                 |                   |----------------->|
   |                |                 |                   |                  |
   |                |                 |                   |  forward call    |
   |                |                 |                   |  return result   |
   |                |                 |   |               |<-----------------|
   |                |                 |<--'               |                  |
   |                | response text   |                   |                  |
   |                |<----------------|                   |                  |
   | "Here are ..." |                 |                   |                  |
   |<---------------|                 |                   |                  |
```

#### Timing Considerations

The escalation blocks the proxy's `CallToolRequestSchema` handler, which blocks the sandbox's `callToolChain()`, which blocks the agent's `execute_code` tool, which blocks `generateText()`, which blocks `sendMessage()`. This means the transport's REPL loop is also blocked -- the user cannot type regular messages while an escalation is pending.

However, the transport can detect this: when `onEscalation` fires, the transport knows a slash command (`/approve` or `/deny`) is expected. The CLI transport can handle this by:
1. Printing the escalation details to stderr
2. Entering an escalation-specific prompt loop that only accepts `/approve` or `/deny`
3. Resuming normal REPL operation after the escalation is resolved

But there is a subtlety: `sendMessage()` is blocking. The `onEscalation` callback fires during `sendMessage()`, so the transport cannot call `resolveEscalation()` from within the callback (it would need to do so from a different execution context).

The solution is to **not block on escalation within `sendMessage()`**. Instead:
1. The session detects an escalation request file (via polling from a background interval)
2. The `onEscalation` callback fires asynchronously
3. The escalation is resolved through `resolveEscalation()`, which writes the response file
4. The proxy picks up the response and continues
5. The sandbox tool call completes
6. `generateText()` eventually finishes
7. `sendMessage()` returns

Since the proxy is the one polling and blocking, and the session's escalation detection runs on a background interval, this flow works without blocking the Node.js event loop. The transport can accept `/approve` or `/deny` commands even while `sendMessage()` is awaiting completion, because `sendMessage()` is `await`-ed (it yields to the event loop during `generateText()`), and the CLI transport can read stdin during that time if it structures its loop correctly.

**Revised transport approach**: The CLI transport does not use a simple `for await...of readline` loop. Instead, it uses an event-driven approach where readline events are processed regardless of whether a `sendMessage()` call is in flight. When an escalation is pending, slash commands are handled immediately; regular messages are queued until `sendMessage()` completes.

#### Environment Variable

The proxy receives the escalation directory path via a new environment variable:

```
ESCALATION_DIR=~/.ironcurtain/sessions/{sessionId}/escalations
```

(Resolved to an absolute path at runtime, e.g., `/home/user/.ironcurtain/sessions/abc123/escalations`)

This is set alongside the existing `AUDIT_LOG_PATH`, `MCP_SERVERS_CONFIG`, `GENERATED_DIR`, and `PROTECTED_PATHS` in the sandbox's `registerManual()` call.

#### Proxy Changes

The proxy's escalation handling changes from auto-deny to file-based rendezvous:

```typescript
// In mcp-proxy-server.ts, when evaluation.decision === 'escalate':

if (evaluation.decision === 'escalate') {
  const escalationDir = process.env.ESCALATION_DIR;
  if (!escalationDir) {
    // No escalation directory configured -- auto-deny (backward compatible)
    logAudit({ status: 'denied', error: evaluation.reason }, 0, 'denied');
    return {
      content: [{ type: 'text', text: `ESCALATION REQUIRED: ${evaluation.reason}. Action denied (no escalation handler).` }],
      isError: true,
    };
  }

  const escalationId = uuidv4();
  const requestPath = resolve(escalationDir, `request-${escalationId}.json`);
  const responsePath = resolve(escalationDir, `response-${escalationId}.json`);

  // Write escalation request
  writeFileSync(requestPath, JSON.stringify({
    escalationId,
    serverName: request.serverName,
    toolName: request.toolName,
    arguments: request.arguments,
    reason: evaluation.reason,
  }));

  // Poll for response (blocking this tool call)
  const timeoutMs = 5 * 60 * 1000; // 5 minutes
  const pollIntervalMs = 500;
  const deadline = Date.now() + timeoutMs;
  let decision: 'approved' | 'denied' = 'denied';

  while (Date.now() < deadline) {
    if (existsSync(responsePath)) {
      const response = JSON.parse(readFileSync(responsePath, 'utf-8'));
      decision = response.decision;
      // Clean up files
      try { unlinkSync(requestPath); } catch { /* ignore */ }
      try { unlinkSync(responsePath); } catch { /* ignore */ }
      break;
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  if (decision === 'approved') {
    policyDecision.status = 'allow';
    policyDecision.reason = 'Approved by human during escalation';
    // Fall through to forward the call
  } else {
    logAudit({ status: 'denied', error: evaluation.reason }, 0, 'denied');
    return {
      content: [{ type: 'text', text: `ESCALATION DENIED: ${evaluation.reason}` }],
      isError: true,
    };
  }
}
```

#### Fallback Behavior

When `ESCALATION_DIR` is not set (e.g., in single-shot mode or when the transport does not support escalations), the proxy falls back to auto-deny. This preserves backward compatibility.

#### File Format

Request file (`request-{escalationId}.json`):
```json
{
  "escalationId": "uuid",
  "serverName": "filesystem",
  "toolName": "read_file",
  "arguments": { "path": "/etc/hostname" },
  "reason": "Read access outside sandbox requires human approval"
}
```

Response file (`response-{escalationId}.json`):
```json
{
  "decision": "approved"
}
```

#### Cleanup

The session's `close()` method does not remove the session directory (audit logs should persist). It only stops the escalation watcher and shuts down the sandbox. Stale escalation request/response files within the escalations subdirectory are harmless -- they are small JSON files that can be cleaned up by a future `ironcurtain cleanup` command along with the rest of the session directory.

## Session Lifecycle

### State Machine

```
                 createSession()
                      |
                      v
              +---------------+
              | initializing  |  session dir creation, sandbox.initialize(),
              +-------+-------+  tool discovery
                      |
                      v
              +-------+-------+
     +------->|    ready      |<------+
     |        +-------+-------+       |
     |                |               |
     |         sendMessage()          |
     |                |               |
     |                v               |
     |        +-------+-------+       |
     |        |  processing   |-------+
     |        +-------+-------+  generateText() completes
     |                |
     |                | (error: reset to ready)
     |                |
     +----------------+
              |
        close()
              |
              v
      +-------+-------+
      |    closed      |  sandbox.shutdown(), watcher stopped
      +---------------+
```

### Initialization Sequence

1. `createSession(options)` is called
2. Factory resolves config (from options or `loadConfig()`)
3. Factory generates a `SessionId`
4. Factory creates the session directory tree:
   - `~/.ironcurtain/sessions/{sessionId}/` (session root)
   - `~/.ironcurtain/sessions/{sessionId}/sandbox/` (ALLOWED_DIRECTORY)
   - `~/.ironcurtain/sessions/{sessionId}/escalations/` (escalation IPC)
5. Factory overrides config paths for this session:
   - `config.allowedDirectory` = `~/.ironcurtain/sessions/{sessionId}/sandbox/`
   - `config.auditLogPath` = `~/.ironcurtain/sessions/{sessionId}/audit.jsonl`
   - `config.escalationDir` = `~/.ironcurtain/sessions/{sessionId}/escalations/`
6. Factory creates `AgentSession` instance (status: `initializing`)
7. Factory calls `agentSession.initialize()`:
   a. Creates `Sandbox` via `sandboxFactory(config)` (default: `new Sandbox()`)
   b. Calls `sandbox.initialize(config)` -- spawns MCP proxy process with `ESCALATION_DIR` env var, discovers tools
   c. Builds system prompt via `buildSystemPrompt()` from `src/agent/prompts.ts`
   d. Builds tool set (the `execute_code` tool wired to the sandbox)
   e. Starts background escalation directory watcher (polling interval)
   f. Sets status to `ready`
8. Factory returns the session (as the `Session` interface)

### Message Processing Sequence

1. Caller (transport) calls `session.sendMessage(userMessage)`
2. Session asserts status is `ready`, transitions to `processing`
3. Session appends `{ role: 'user', content: userMessage }` to `this.messages`
4. Session calls `generateText()` with:
   - `model`: `anthropic('claude-sonnet-4-6')`
   - `system`: the pre-built system prompt
   - `messages`: the full `this.messages` array
   - `tools`: the pre-built tool set
   - `stopWhen`: `stepCountIs(MAX_AGENT_STEPS)`
   - `onStepFinish`: emits `DiagnosticEvent` via `options.onDiagnostic` callback
5. `generateText()` executes (potentially multiple steps with tool calls)
   - If a tool call triggers an escalation, the proxy blocks (polling for response)
   - The session's background watcher detects the request file, fires `onEscalation`
   - The transport shows the escalation to the user, who types `/approve` or `/deny`
   - The transport calls `session.resolveEscalation()`, which writes the response file
   - The proxy reads the response and continues
6. Session appends `result.response.messages` (the `ResponseMessage[]`) to `this.messages`
7. Session records a `ConversationTurn` with the user input, agent text, and usage
8. Session transitions back to `ready`
9. Session returns `result.text`

If an error occurs during step 5, the session transitions back to `ready` (not `closed`) so the conversation can continue. The error propagates to the caller.

### Shutdown Sequence

1. Caller calls `session.close()`
2. If already `closed`, return immediately (idempotent)
3. Set status to `closed`
4. Stop the escalation directory watcher
5. Call `sandbox.shutdown()` -- closes Code Mode client, terminates proxy process
6. Null out the sandbox reference

Note: the session directory (`~/.ironcurtain/sessions/{sessionId}/`) is **not** removed on close. The audit log and sandbox artifacts persist for post-session inspection. Cleanup is handled by a separate mechanism (future `ironcurtain cleanup` command or manual deletion).

## Conversation History Management

### Internal Representation

The session maintains two parallel data structures:

1. **`messages: ModelMessage[]`** -- the raw AI SDK message array, used as input to `generateText()`. This is the source of truth for the LLM's conversation context. It contains `UserModelMessage`, `AssistantModelMessage`, and `ToolModelMessage` entries.

2. **`turns: ConversationTurn[]`** -- a structured summary of each user/assistant exchange, exposed through `getHistory()`. This is a read-friendly view for transports, debugging, and future persistence.

3. **`diagnosticLog: DiagnosticEvent[]`** -- accumulated diagnostic events from all turns, exposed through `getDiagnosticLog()`. The CLI transport's `/logs` command displays these.

The `messages` array grows monotonically within a session. Each call to `sendMessage()` appends one `UserModelMessage` and then the `ResponseMessage[]` from `generateText()`. The `ResponseMessage[]` typically contains one `AssistantModelMessage` (the text response) and possibly `ToolModelMessage` entries (tool call results from intermediate steps).

### AI SDK Message Flow

```
Turn 1:
  messages = [
    { role: 'user', content: 'List files in the sandbox' }
  ]
  -> generateText(messages) ->
  response.messages = [
    { role: 'assistant', content: [...tool calls...] },
    { role: 'tool', content: [...tool results...] },
    { role: 'assistant', content: [{ type: 'text', text: 'Here are the files...' }] },
  ]
  messages = [
    { role: 'user', content: 'List files in the sandbox' },
    { role: 'assistant', content: [...] },
    { role: 'tool', content: [...] },
    { role: 'assistant', content: [...] },
  ]

Turn 2:
  messages = [
    ...previous messages...,
    { role: 'user', content: 'Now read the first file' }
  ]
  -> generateText(messages) ->
  ...response.messages appended...
```

### Context Window Strategy

No pruning is performed. The full message history is passed to `generateText()` on every turn. If the history exceeds the model's context window, `generateText()` will throw an error, which propagates to the transport for display. The transport should display a clear message like "Context window exceeded. Please start a new session."

The `SessionOptions.maxHistoryMessages` field is defined in the interface as an extension point for future strategies:
- **Simple truncation**: Use the AI SDK's `pruneMessages()` to drop old tool call/result pairs
- **Summarization**: After N turns, summarize old turns into a single system message
- **Sliding window**: Keep only the last K turns, with a summary preamble

These are future enhancements that do not change the `Session` interface.

## Implementation Details

### AgentSession (`src/session/agent-session.ts`)

The concrete class that implements `Session`. Not exported from the public API -- callers use the `Session` interface via `createSession()`.

```typescript
// src/session/agent-session.ts (internal, not re-exported)

import { generateText, stepCountIs, tool } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { CodeModeUtcpClient } from '@utcp/code-mode';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ModelMessage } from '@ai-sdk/provider-utils';
import type { IronCurtainConfig } from '../config/types.js';
import { Sandbox } from '../sandbox/index.js';
import { buildSystemPrompt } from '../agent/prompts.js';
import type {
  Session,
  SessionId,
  SessionStatus,
  SessionInfo,
  SessionOptions,
  ConversationTurn,
  DiagnosticEvent,
  EscalationRequest,
  SandboxFactory,
} from './types.js';
import { createSessionId } from './types.js';
import { SessionNotReadyError, SessionClosedError } from './errors.js';

const MAX_AGENT_STEPS = 10;

/** Default sandbox factory: creates a real UTCP Code Mode sandbox. */
const defaultSandboxFactory: SandboxFactory = async (config) => {
  const sandbox = new Sandbox();
  await sandbox.initialize(config);
  return sandbox;
};

export class AgentSession implements Session {
  private readonly id: SessionId;
  private status: SessionStatus = 'initializing';
  private config: IronCurtainConfig;
  private sandbox: Sandbox | null = null;
  private readonly createdAt: string;
  private readonly sandboxFactory: SandboxFactory;
  private readonly escalationDir: string;

  /** Raw AI SDK message history. */
  private messages: ModelMessage[] = [];

  /** Structured turn log exposed through getHistory(). */
  private turns: ConversationTurn[] = [];

  /** Accumulated diagnostic events exposed through getDiagnosticLog(). */
  private diagnosticLog: DiagnosticEvent[] = [];

  /** System prompt, built once after sandbox initialization. */
  private systemPrompt: string = '';

  /** The tool set, built once after sandbox initialization. */
  private tools: Record<string, ReturnType<typeof tool>> = {};

  /** Currently pending escalation, if any. */
  private pendingEscalation: EscalationRequest | undefined;

  /** Interval handle for polling the escalation directory. */
  private escalationPollInterval: ReturnType<typeof setInterval> | null = null;

  /** Callbacks from SessionOptions. */
  private readonly onEscalation?: (request: EscalationRequest) => void;
  private readonly onDiagnostic?: (event: DiagnosticEvent) => void;

  constructor(
    config: IronCurtainConfig,
    sessionId: SessionId,
    escalationDir: string,
    options: SessionOptions = {},
  ) {
    this.id = sessionId;
    this.config = config;
    this.escalationDir = escalationDir;
    this.sandboxFactory = options.sandboxFactory ?? defaultSandboxFactory;
    this.onEscalation = options.onEscalation;
    this.onDiagnostic = options.onDiagnostic;
    this.createdAt = new Date().toISOString();
  }

  /**
   * Initialize the session's sandbox and build the tool set.
   * Called by the factory function, not by external callers.
   */
  async initialize(): Promise<void> {
    // Inject the escalation directory into the config so the proxy receives it
    const configWithEscalation = {
      ...this.config,
      escalationDir: this.escalationDir,
    };

    this.sandbox = await this.sandboxFactory(configWithEscalation);
    this.systemPrompt = buildSystemPrompt(
      CodeModeUtcpClient.AGENT_PROMPT_TEMPLATE,
      this.sandbox.getToolInterfaces(),
    );
    this.tools = this.buildTools();
    this.startEscalationWatcher();
    this.status = 'ready';
  }

  getInfo(): SessionInfo {
    return {
      id: this.id,
      status: this.status,
      turnCount: this.turns.length,
      createdAt: this.createdAt,
    };
  }

  async sendMessage(userMessage: string): Promise<string> {
    if (this.status === 'closed') throw new SessionClosedError();
    if (this.status !== 'ready') throw new SessionNotReadyError(this.status);

    this.status = 'processing';
    const turnStart = new Date().toISOString();

    try {
      // Append user message to history
      this.messages.push({ role: 'user', content: userMessage });

      const result = await generateText({
        model: anthropic('claude-sonnet-4-6'),
        system: this.systemPrompt,
        messages: this.messages,
        tools: this.tools,
        stopWhen: stepCountIs(MAX_AGENT_STEPS),
        onStepFinish: ({ text, toolCalls }, stepIndex) => {
          if (toolCalls && toolCalls.length > 0) {
            for (const tc of toolCalls) {
              if (tc.toolName === 'execute_code' && 'input' in tc) {
                const input = tc.input as { code: string };
                const preview = input.code.substring(0, 120).replace(/\n/g, '\\n');
                const event: DiagnosticEvent = {
                  kind: 'tool_call',
                  toolName: tc.toolName,
                  preview: `${preview}${input.code.length > 120 ? '...' : ''}`,
                };
                this.diagnosticLog.push(event);
                this.onDiagnostic?.(event);
              }
            }
          }
          if (text) {
            const event: DiagnosticEvent = {
              kind: 'agent_text',
              preview: `${text.substring(0, 200)}${text.length > 200 ? '...' : ''}`,
            };
            this.diagnosticLog.push(event);
            this.onDiagnostic?.(event);
          }
        },
      });

      // Append response messages to history for next turn
      this.messages.push(...result.response.messages);

      const turn: ConversationTurn = {
        turnNumber: this.turns.length + 1,
        userMessage,
        assistantResponse: result.text,
        usage: {
          promptTokens: result.totalUsage.promptTokens,
          completionTokens: result.totalUsage.completionTokens,
          totalTokens:
            result.totalUsage.promptTokens + result.totalUsage.completionTokens,
        },
        timestamp: turnStart,
      };
      this.turns.push(turn);

      this.status = 'ready';
      return result.text;
    } catch (error) {
      this.status = 'ready'; // Reset to ready so the session can recover
      throw error;
    }
  }

  getHistory(): readonly ConversationTurn[] {
    return this.turns;
  }

  getDiagnosticLog(): readonly DiagnosticEvent[] {
    return this.diagnosticLog;
  }

  getPendingEscalation(): EscalationRequest | undefined {
    return this.pendingEscalation;
  }

  async resolveEscalation(
    escalationId: string,
    decision: 'approved' | 'denied',
  ): Promise<void> {
    if (!this.pendingEscalation || this.pendingEscalation.escalationId !== escalationId) {
      throw new Error(`No pending escalation with ID: ${escalationId}`);
    }

    const responsePath = resolve(this.escalationDir, `response-${escalationId}.json`);
    writeFileSync(responsePath, JSON.stringify({ decision }));
    this.pendingEscalation = undefined;
  }

  async close(): Promise<void> {
    if (this.status === 'closed') return; // Idempotent
    this.status = 'closed';
    this.stopEscalationWatcher();
    if (this.sandbox) {
      await this.sandbox.shutdown();
      this.sandbox = null;
    }
    // Session directory is NOT removed -- audit logs persist.
    // Cleanup is handled by a separate mechanism.
  }

  private buildTools(): Record<string, ReturnType<typeof tool>> {
    return {
      execute_code: tool({
        description:
          'Execute TypeScript code in a secure sandbox with access to filesystem tools. ' +
          'Write code that calls tool functions like filesystem.read_file(), ' +
          'filesystem.list_directory(), etc. ' +
          'Tools are synchronous -- no await needed. Use return to provide results.',
        inputSchema: z.object({
          code: z
            .string()
            .describe('TypeScript code to execute in the sandbox'),
        }),
        execute: async ({ code }) => {
          if (!this.sandbox) throw new Error('Sandbox not initialized');
          try {
            const { result, logs } = await this.sandbox.executeCode(code);
            const output: Record<string, unknown> = {};
            if (logs.length > 0) output.console = logs;
            output.result = result;
            return output;
          } catch (err) {
            return {
              error: err instanceof Error ? err.message : String(err),
            };
          }
        },
      }),
    };
  }

  /**
   * Starts polling the escalation directory for new request files.
   * When a request is detected, sets pendingEscalation and fires
   * the onEscalation callback.
   */
  private startEscalationWatcher(): void {
    this.escalationPollInterval = setInterval(() => {
      if (this.pendingEscalation) return; // Already handling one

      try {
        const files = readdirSync(this.escalationDir);
        const requestFile = files.find(f => f.startsWith('request-') && f.endsWith('.json'));
        if (requestFile) {
          const requestPath = resolve(this.escalationDir, requestFile);
          const request: EscalationRequest = JSON.parse(readFileSync(requestPath, 'utf-8'));
          this.pendingEscalation = request;
          this.onEscalation?.(request);
        }
      } catch { /* directory may not exist yet or be empty */ }
    }, 300);
  }

  private stopEscalationWatcher(): void {
    if (this.escalationPollInterval) {
      clearInterval(this.escalationPollInterval);
      this.escalationPollInterval = null;
    }
  }
}
```

### CLI Transport (`src/session/cli-transport.ts`)

```typescript
import { createInterface, type Interface } from 'node:readline';
import type { Transport } from './transport.js';
import type { Session, DiagnosticEvent, EscalationRequest } from './types.js';

/**
 * CLI transport that reads from stdin and writes to stdout/stderr.
 *
 * Supports two modes:
 * - Single-shot: if initialMessage is provided, sends it and returns
 * - Interactive: REPL loop with slash commands
 *
 * Slash commands:
 * - /quit, /exit -- end the session
 * - /logs -- display accumulated diagnostic events
 * - /approve -- approve a pending escalation
 * - /deny -- deny a pending escalation
 */
export class CliTransport implements Transport {
  constructor(private readonly initialMessage?: string) {}

  async run(session: Session): Promise<void> {
    if (this.initialMessage) {
      // Single-shot mode: send one message, print response, done
      const response = await session.sendMessage(this.initialMessage);
      console.log('\n=== Agent Response ===');
      console.log(response);
      return;
    }

    // Interactive mode
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr, // Prompts to stderr, responses to stdout
    });

    console.error('IronCurtain interactive mode. Type /quit to exit.\n');
    console.error('Commands: /quit /logs /approve /deny\n');

    // Event-driven approach: readline events are processed regardless
    // of whether a sendMessage() call is in flight.
    let running = true;
    let messageInFlight = false;

    const processLine = async (input: string): Promise<void> => {
      input = input.trim();
      if (!input) return;

      // --- Slash commands ---

      if (input === '/quit' || input === '/exit') {
        running = false;
        rl.close();
        return;
      }

      if (input === '/logs') {
        const logs = session.getDiagnosticLog();
        if (logs.length === 0) {
          console.error('  (no diagnostic events yet)');
        } else {
          for (const event of logs) {
            switch (event.kind) {
              case 'tool_call':
                console.error(`  [tool] ${event.toolName}: ${event.preview}`);
                break;
              case 'agent_text':
                console.error(`  [agent] ${event.preview}`);
                break;
              case 'step_finish':
                console.error(`  [step] ${event.stepIndex} completed`);
                break;
            }
          }
        }
        return;
      }

      if (input === '/approve' || input === '/deny') {
        const pending = session.getPendingEscalation();
        if (!pending) {
          console.error('  No escalation pending.');
          return;
        }
        const decision = input === '/approve' ? 'approved' : 'denied';
        try {
          await session.resolveEscalation(pending.escalationId, decision);
          console.error(`  Escalation ${decision}.`);
        } catch (err) {
          console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }

      // --- Regular message ---

      if (messageInFlight) {
        console.error('  (still processing previous message, please wait)');
        return;
      }

      messageInFlight = true;
      try {
        const response = await session.sendMessage(input);
        console.log(response);
        console.log(); // Blank line between responses
      } catch (error) {
        console.error(
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        messageInFlight = false;
      }
    };

    // Process lines as they arrive
    rl.on('line', (line) => {
      if (running) {
        processLine(line).catch((err) => {
          console.error(`Unexpected error: ${err}`);
        });
      }
    });

    // Wait until the REPL is done
    await new Promise<void>((resolve) => {
      rl.on('close', resolve);
    });
  }
}
```

### Refactored Entry Point (`src/index.ts`)

```typescript
import 'dotenv/config';
import { loadConfig } from './config/index.js';
import { createSession } from './session/index.js';
import { CliTransport } from './session/cli-transport.js';

async function main() {
  const task = process.argv.slice(2).join(' ');
  const config = loadConfig();

  // Note: the session's ALLOWED_DIRECTORY is now per-session
  // (~/.ironcurtain/sessions/{id}/sandbox/), created by the factory.
  // The config's allowedDirectory is used as a fallback/default
  // and is overridden by the factory for each session.

  console.error('Initializing session...');
  const session = await createSession({
    config,
    // In interactive mode, surface escalations to stderr
    onEscalation: (req) => {
      console.error('\n========================================');
      console.error('  ESCALATION: Human approval required');
      console.error('========================================');
      console.error(`  Tool:      ${req.serverName}/${req.toolName}`);
      console.error(`  Arguments: ${JSON.stringify(req.arguments, null, 2)}`);
      console.error(`  Reason:    ${req.reason}`);
      console.error('========================================');
      console.error('  Type /approve or /deny');
      console.error('========================================\n');
    },
    // In interactive mode, show diagnostic events on stderr
    onDiagnostic: (event) => {
      switch (event.kind) {
        case 'tool_call':
          console.error(`  [sandbox] ${event.toolName}: ${event.preview}`);
          break;
        case 'agent_text':
          console.error(`  [agent] ${event.preview}`);
          break;
      }
    },
  });
  console.error('Session ready.\n');

  // If a task was provided on the command line, run single-shot.
  // Otherwise, enter interactive mode.
  const transport = new CliTransport(task || undefined);

  try {
    await transport.run(session);
  } finally {
    await session.close();
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
```

This preserves full backward compatibility:
- `npm start "your task"` -- single-shot mode, same behavior as before
- `npm start` (no args) -- enters interactive REPL mode (new behavior)

## What Changes, What Doesn't

### Unchanged

| File | Why |
|------|-----|
| `src/trusted-process/policy-engine.ts` | Policy evaluation is unchanged |
| `src/trusted-process/audit-log.ts` | Audit log class is unchanged (per-session path is a factory concern) |
| `src/trusted-process/index.ts` | TrustedProcess (in-process mode) is unchanged |
| `src/trusted-process/escalation.ts` | EscalationHandler is unchanged (used by in-process mode only) |
| `src/config/types.ts` | Config types unchanged (escalationDir passed via separate mechanism) |
| `src/types/` | All shared types are unchanged |
| `src/pipeline/` | Compilation pipeline is unchanged |
| All existing tests | Continue to work without modification |

### New Files

| File | Purpose |
|------|---------|
| `src/config/paths.ts` | `getIronCurtainHome()`, `getSessionDir()`, `getSessionSandboxDir()`, `getSessionEscalationDir()`, `getSessionAuditLogPath()`, `getLogsDir()` |
| `src/session/types.ts` | `SessionId`, `SessionStatus`, `Session`, `SessionOptions`, `ConversationTurn`, `SessionInfo`, `EscalationRequest`, `DiagnosticEvent`, `SandboxFactory` |
| `src/session/errors.ts` | `SessionError`, `SessionNotReadyError`, `SessionClosedError` |
| `src/session/agent-session.ts` | `AgentSession` class (concrete `Session` implementation) |
| `src/session/transport.ts` | `Transport` interface |
| `src/session/cli-transport.ts` | `CliTransport` class (stdin/stdout REPL + single-shot + slash commands) |
| `src/session/index.ts` | `createSession()` factory + public re-exports |
| `src/agent/prompts.ts` | `buildSystemPrompt()` shared utility |
| `test/session.test.ts` | Unit tests for session lifecycle and multi-turn history |

### Modified Files

| File | Change |
|------|--------|
| `src/index.ts` | Rewritten to use `createSession()` + `CliTransport` (backward compatible) |
| `src/agent/index.ts` | Import `buildSystemPrompt` from `./prompts.js`; `runAgent()` gets deprecation comment |
| `src/config/index.ts` | Default `ALLOWED_DIRECTORY` changes from `/tmp/ironcurtain-sandbox` to `~/.ironcurtain/sessions/default/sandbox/` (but per-session override means this default is rarely used) |
| `src/sandbox/index.ts` | Pass `ESCALATION_DIR` env var to proxy in `registerManual()` call |
| `src/trusted-process/mcp-proxy-server.ts` | Escalation handling: file-based rendezvous instead of auto-deny |

## Extension Points

### Future Transports (Phase 2)

Adding a messaging platform transport (e.g., Slack, Discord, web UI) means:

1. Implement the `Transport` interface
2. Wire up the message source to `session.sendMessage()`
3. Handle `onEscalation` callback to show approval UI in the platform
4. Handle `onDiagnostic` callback to show progress in the platform
5. Deliver the response back through the platform's API

The session does not change. The transport handles authentication, message formatting, threading, and delivery.

### Concurrent Agents (Phase 3)

Because each `Session` owns its resources (sandbox directory, message history, audit log file, escalation directory), running multiple sessions concurrently is:

1. Call `createSession()` N times -- each gets a unique session ID
2. Each session gets its own directory under `~/.ironcurtain/sessions/`
3. Each session gets its own sandbox process, proxy, policy engine, audit log file, and escalation directory
4. No shared mutable state between sessions

The per-session directory structure makes this natural -- concurrent sessions are just sibling directories under `~/.ironcurtain/sessions/`.

### Context Window Management

The `SessionOptions.maxHistoryMessages` hook is the extension point. Future strategies:

- **Simple truncation**: Use the AI SDK's `pruneMessages()` to drop old tool call/result pairs
- **Summarization**: After N turns, summarize old turns into a single system message
- **Sliding window**: Keep only the last K turns, with a summary preamble

These are implementation details inside `AgentSession.sendMessage()` and do not change the `Session` interface.

### Session Persistence

The `ConversationTurn[]` provides enough information to display history. If we need to persist and resume sessions across process restarts, we would:

1. Serialize `this.messages` (the raw `ModelMessage[]`) to the session directory
2. On resume, deserialize and restore the array
3. The session ID enables lookup under `~/.ironcurtain/sessions/{sessionId}/`

The session directory already persists after `close()`, so this is a natural extension. The only addition is a `messages.json` file alongside `audit.jsonl`.

### Session Cleanup

Session directories accumulate under `~/.ironcurtain/sessions/`. Future cleanup options:

- **CLI command**: `ironcurtain cleanup --older-than 7d` removes session directories older than a threshold
- **Startup pruning**: `createSession()` could optionally prune old sessions on startup (opt-in via config)
- **Manual**: `rm -rf ~/.ironcurtain/sessions/*`

For the tracer bullet, manual cleanup is sufficient.

## Testing Strategy

### Session Unit Tests (no LLM calls)

The `SandboxFactory` on `SessionOptions` enables clean testing without real sandbox processes. Tests provide a factory that returns a mock sandbox:

```typescript
const mockSandbox = {
  getToolInterfaces: () => 'mock interfaces',
  executeCode: async (code: string) => ({ result: 'mock result', logs: [] }),
  shutdown: async () => {},
  initialize: async () => {},
} as unknown as Sandbox;

const session = await createSession({
  config: testConfig,
  sandboxFactory: async () => mockSandbox,
});
```

Tests should set `IRONCURTAIN_HOME` to a temporary directory to avoid polluting the user's real `~/.ironcurtain/`:

```typescript
process.env.IRONCURTAIN_HOME = `/tmp/ironcurtain-test-${process.pid}`;
```

**What to test:**

- Session lifecycle: `initializing` -> `ready` -> `processing` -> `ready` -> `closed`
- `sendMessage()` throws `SessionNotReadyError` when status is `processing`
- `sendMessage()` throws `SessionClosedError` after `close()`
- `close()` is idempotent (calling twice does not throw)
- `getHistory()` returns turns in order with correct turn numbers
- Error during `generateText()` resets status to `ready` (session recovers)
- Per-session audit log file is created at `~/.ironcurtain/sessions/{id}/audit.jsonl`
- Session directory tree is created with sandbox/, escalations/ subdirectories
- Escalation directory is created during initialization
- `resolveEscalation()` writes response file to escalation directory
- `resolveEscalation()` throws if no matching escalation is pending
- `getDiagnosticLog()` accumulates events across turns

### Transport Tests

`CliTransport` can be tested by creating a mock `Session` object that implements the interface with stub responses:

- Single-shot mode sends one message and returns
- Interactive mode processes multiple messages
- `/quit` and `/exit` exit the loop
- `/logs` displays diagnostic events
- `/approve` and `/deny` resolve pending escalations
- `/approve` with no pending escalation shows an error
- Errors from `sendMessage()` are caught and displayed, not fatal
- Regular messages are rejected while another is in flight

### Escalation Integration Tests

Test the file-based rendezvous protocol:

1. Create a temporary session directory with escalations/ subdirectory
2. Write a request file simulating the proxy
3. Verify the session detects it and fires `onEscalation`
4. Call `resolveEscalation()` and verify the response file is written
5. Verify the file format matches what the proxy expects

### Full Integration Tests

The existing `test/integration.test.ts` tests the `TrustedProcess` directly and is unaffected. A new `test/session-integration.test.ts` can test the full session lifecycle with a real sandbox, including escalation routing (real MCP server, session directory under a temp `IRONCURTAIN_HOME`, 30s timeout).

## Migration Notes

### Incremental Migration Path

1. **Step 1**: Create `src/config/paths.ts` with `getIronCurtainHome()` and related path utilities
2. **Step 2**: Create `src/agent/prompts.ts` with `buildSystemPrompt()`; update `src/agent/index.ts` to import from it
3. **Step 3**: Create `src/session/` directory with `types.ts`, `errors.ts`, `transport.ts`
4. **Step 4**: Create `src/session/agent-session.ts` and `src/session/index.ts`
5. **Step 5**: Create `src/session/cli-transport.ts`
6. **Step 6**: Update `src/sandbox/index.ts` to pass `ESCALATION_DIR` to proxy
7. **Step 7**: Update `src/trusted-process/mcp-proxy-server.ts` with file-based escalation handling
8. **Step 8**: Refactor `src/index.ts` to use `createSession()` + `CliTransport`
9. **Step 9**: Update `src/config/index.ts` default `ALLOWED_DIRECTORY` to use `getIronCurtainHome()`
10. **Step 10**: Verify `npm start "task"` still works (single-shot backward compatibility)
11. **Step 11**: Verify `npm start` (no args) enters interactive mode
12. **Step 12**: Add `test/session.test.ts`
13. **Step 13**: Mark `runAgent()` as deprecated (not removed)

### Sandbox Changes

The `Sandbox.initialize()` method needs to pass the escalation directory to the proxy. The `createSession` factory overrides the config's `allowedDirectory` to point to the per-session sandbox directory (`~/.ironcurtain/sessions/{sessionId}/sandbox/`) and adds the `escalationDir` field. The sandbox then includes both in the proxy's environment variables.

The `Sandbox` class gains awareness of one new env var (`ESCALATION_DIR`) in its `registerManual()` call. This is a minimal change that does not affect the Sandbox's public API.

### Config Migration

The `loadConfig()` function in `src/config/index.ts` changes its default `ALLOWED_DIRECTORY` from `/tmp/ironcurtain-sandbox` to a path under `~/.ironcurtain/`. However, in practice, the `createSession` factory overrides this per-session, so the default is only used when `loadConfig()` is called outside a session context (e.g., in the pipeline or in legacy code paths).

The `mcp-servers.json` file still ships with a default path that `loadConfig()` patches at runtime. This mechanism continues to work -- the patched value is now the session-specific sandbox directory.

Existing `.env` files that set `ALLOWED_DIRECTORY=/tmp/ironcurtain-sandbox` continue to work. The session factory overrides this per-session regardless of what the config says. The environment variable remains as a fallback for non-session usage.

### Existing Test Compatibility

Existing tests (e.g., `test/integration.test.ts`) create their own sandbox directories under `/tmp/` and configure `IronCurtainConfig` directly. These tests do not go through `createSession()` and are unaffected by the `~/.ironcurtain/` change. The home directory structure is purely a session-level concern.

New session tests should set `IRONCURTAIN_HOME` to a temporary directory to avoid side effects.

## Decisions

These decisions were finalized from the original open questions during design review.

### D1: Slash Command System

**Decision**: The CLI transport supports `/quit`, `/logs`, `/approve`, and `/deny`.

- `/quit` (and `/exit`) ends the session
- `/logs` displays accumulated diagnostic events (tool call previews, agent text excerpts) from all turns in the session
- `/approve` approves a pending escalation
- `/deny` denies a pending escalation

**Rationale**: `/logs` replaces the hardcoded stderr diagnostic output from the original `runAgent()`, giving the user on-demand access without cluttering the REPL. The escalation commands are required by the escalation routing design (D3). Additional commands like `/history`, `/clear`, or `/status` can be added later without interface changes.

### D2: Context Window Exhaustion

**Decision**: Fail with a clear error. No automatic pruning or summarization.

When the message history exceeds the model's context window, `generateText()` throws an error. The error propagates to the transport, which should display a message like "Context window exceeded. Please start a new session."

**Rationale**: Automatic pruning risks silently dropping context that the user expects the agent to remember. Explicit failure is debuggable and sets clear expectations. Proper context management (pruning, summarization) is a future enhancement with its own design considerations.

### D3: Escalation Routing in Interactive Mode

**Decision**: File-based IPC between the proxy process and the session. The proxy writes a request file to a per-session escalation directory (`~/.ironcurtain/sessions/{sessionId}/escalations/`), then polls for a response file. The session detects the request via a background polling interval and fires the `onEscalation` callback. The transport surfaces the escalation to the user, who approves or denies via `/approve` or `/deny`. The session writes the response file.

When `ESCALATION_DIR` is not set (single-shot mode, or transports that do not support escalations), the proxy falls back to auto-deny, preserving backward compatibility.

**Rationale**: The proxy's stdin/stdout are occupied by MCP JSON-RPC, and Code Mode spawns the proxy (IronCurtain does not have a direct process handle). File-based rendezvous is the only IPC mechanism that works across this process boundary without modifying Code Mode or the MCP SDK. The polling approach is simple, debuggable (you can inspect the files), and works on all platforms. The 500ms poll interval adds minimal latency to a human-in-the-loop operation.

**Trade-offs**: File-based IPC is slower than pipes or shared memory, but escalations are rare (most tool calls are allowed or denied by policy) and require human response times (seconds to minutes), so the overhead is negligible. The polling approach is less elegant than `fs.watch`, but `fs.watch` has platform-specific reliability issues; polling at 300ms in the session and 500ms in the proxy is robust.

See the Escalation Architecture section above for the full protocol, sequence diagram, and implementation details.

### D4: Diagnostic Logging

**Decision**: Delegate to the transport via callbacks. The `SessionOptions.onDiagnostic` callback receives `DiagnosticEvent` values during message processing. The session also accumulates all events in an internal log exposed via `getDiagnosticLog()`. The CLI transport's `/logs` command displays this accumulated log.

**Rationale**: Diagnostic output is transport-specific. stderr makes sense for CLI but not for a web UI or Slack bot. By making diagnostics callback-driven, each transport can decide independently how to present them. The `/logs` command provides on-demand access without cluttering the interactive session.

The `onDiagnostic` callback fires during `sendMessage()` (from within `generateText()`'s `onStepFinish`), so the transport receives real-time diagnostic events even before the response is complete. The CLI transport can choose to display them immediately to stderr, buffer them for `/logs`, or both. In the initial implementation, the entry point (`src/index.ts`) wires `onDiagnostic` to stderr for real-time output, and `/logs` provides the full accumulated history.

### D5: Sandbox Injection for Testing

**Decision**: Factory pattern via `SessionOptions.sandboxFactory`. The field accepts a function `(config: IronCurtainConfig) => Promise<Sandbox>`. The default factory creates a real `Sandbox` wrapping UTCP Code Mode's V8 isolate. Tests provide a factory returning a mock.

**Rationale**: The factory pattern is cleaner than an `@internal` constructor parameter and follows the dependency inversion principle. It also enables future sandbox implementations (e.g., remote sandboxes, sandboxes with different isolation levels) without changing the session interface. The factory receives the full config, including the session-specific paths (sandbox directory, escalation directory, audit log path), so it can configure the sandbox appropriately.

### D6: Per-Session Audit Log

**Decision**: Each session gets its own audit log file at `~/.ironcurtain/sessions/{sessionId}/audit.jsonl`.

**Rationale**: Per-session files avoid interleaved writes from concurrent sessions, simplify per-session auditing, and make cleanup straightforward (delete the session directory when the data is no longer needed). Colocating the audit log with the session's sandbox and escalation directory makes the session directory self-contained.

The `createSession` factory overrides the config's `auditLogPath` to point to the session-specific path. The `AuditLog` class is unchanged -- it receives a path and writes to it.

### D7: System Prompt Extraction

**Decision**: Extract `buildSystemPrompt()` into `src/agent/prompts.ts` as a shared utility.

The function is imported by both the (deprecated) `runAgent()` in `src/agent/index.ts` and the new `AgentSession` in `src/session/agent-session.ts`.

**Rationale**: This avoids code duplication while keeping a clean module boundary. The `src/agent/` directory is the natural home for prompt-related utilities. The function is small (10 lines) but will likely grow as the prompt is refined, so having a single source of truth matters. Unlike Option C (copy into agent-session.ts), this approach prevents drift between the two copies.

### D8: Structured Home Directory

**Decision**: All runtime data lives under `~/.ironcurtain/` (overridable via `IRONCURTAIN_HOME` environment variable). Each session gets an isolated subdirectory:

```
~/.ironcurtain/
├── config/                              # future: user config overrides
├── sessions/
│   └── {sessionId}/
│       ├── sandbox/                     # ALLOWED_DIRECTORY for this session
│       ├── escalations/                 # IPC files for escalation routing
│       └── audit.jsonl                  # per-session audit log
└── logs/                                # pipeline logs, llm-interactions, etc.
```

This replaces the previous scattered paths:
- `/tmp/ironcurtain-sandbox` -> `~/.ironcurtain/sessions/{sessionId}/sandbox/`
- `/tmp/ironcurtain-escalation-{sessionId}/` -> `~/.ironcurtain/sessions/{sessionId}/escalations/`
- `./audit.jsonl` (or `AUDIT_LOG_PATH`) -> `~/.ironcurtain/sessions/{sessionId}/audit.jsonl`

**Rationale**:

1. **Persistence**: `/tmp/` is often cleared on reboot. Audit logs, sandbox artifacts, and session state survive system restarts when stored under `~/`.

2. **Discoverability**: a single `~/.ironcurtain/` directory is easy to find, inspect, and back up. Scattered `/tmp/ironcurtain-*` directories are hard to locate and manage.

3. **Per-session isolation**: each session gets its own sandbox directory (`ALLOWED_DIRECTORY`), so concurrent sessions have fully isolated filesystems. Previously, all sessions shared `/tmp/ironcurtain-sandbox`, which would cause file conflicts.

4. **Config migration path**: the `config/` subdirectory provides a natural home for future user-level settings (constitution overrides, model preferences, default policies) without polluting the project source tree.

5. **Clean concurrent agents**: the directory structure makes Phase 3 (concurrent agents) trivial -- each session is a sibling directory under `sessions/`, with no shared mutable state.

6. **Overridable**: `IRONCURTAIN_HOME` allows CI environments, containers, and tests to redirect all state to a custom location (e.g., `IRONCURTAIN_HOME=/tmp/ironcurtain-test-$$`).

The path utilities in `src/config/paths.ts` centralize all path derivation logic, so no other module needs to know the directory structure. Changes to the layout only require updating `paths.ts`.
