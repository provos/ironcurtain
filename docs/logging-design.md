# Design: Session Logging System

**Status:** Proposed
**Date:** 2026-02-18

## Problem

When running IronCurtain interactively (`npm start`), the terminal is cluttered with log messages from two sources:

1. **IronCurtain's own diagnostics** -- callbacks wired in `src/index.ts` write to `console.error` (e.g., `[sandbox] execute_code: ...`, `[agent] ...`). The `TrustedProcess` class in `src/trusted-process/index.ts` logs MCP server connection progress to `console.error`. The `MCPClientManager` logs errors to `console.error` during shutdown.

2. **Third-party libraries** -- UTCP Code Mode and the MCP SDK write directly to `console.log` and `console.error` (e.g., `[McpCommunicationProtocol] Calling tool...`, `Calling tool 'filesystem...' via protocol 'mcp'.`). IronCurtain has no control over these call sites.

The result is a noisy terminal where the user's actual conversation with the agent is buried in diagnostic output. Meanwhile, when something goes wrong, there is no persistent log file to inspect after the fact -- everything scrolled past in the terminal is gone.

### Current console usage by category

**Diagnostic output (should go to log file, not terminal):**

| File | Call | Purpose |
|------|------|---------|
| `src/index.ts:10` | `console.error('Initializing session...')` | Startup progress |
| `src/index.ts:27-30` | `console.error('[sandbox]...')` / `console.error('[agent]...')` | `onDiagnostic` callback |
| `src/index.ts:35` | `console.error('Session ready.\n')` | Startup complete |
| `src/trusted-process/index.ts:34,36` | `console.error('Connecting to MCP server...')` | MCP connection progress |
| `src/trusted-process/mcp-client-manager.ts:56` | `console.error('Error closing MCP server...')` | Shutdown error |
| `src/agent/index.ts:35,53-54,68,73` | `console.error(...)` | Legacy agent diagnostics |

**User-facing output (must remain visible in the terminal):**

| File | Call | Purpose |
|------|------|---------|
| `src/index.ts:14-22` | `console.error('ESCALATION...')` | Escalation banner -- user must see this |
| `src/index.ts:50` | `console.error('Fatal error:', err)` | Fatal crash -- user must see this |
| `src/session/cli-transport.ts:31-32` | `console.log(response)` | Agent response to stdout |
| `src/session/cli-transport.ts:41-42` | `console.error('IronCurtain interactive...')` | REPL welcome message |
| `src/session/cli-transport.ts:60` | `console.error('still processing...')` | User feedback |
| `src/session/cli-transport.ts:67-68` | `console.log(response)` | Agent response to stdout |
| `src/session/cli-transport.ts:70-71` | `console.error('Error: ...')` | Error feedback |
| `src/session/cli-transport.ts:122-154` | Various `console.error(...)` | `/logs` display, escalation commands |
| `src/trusted-process/escalation.ts:20-32` | `console.error(...)` | In-process escalation prompts |

**Third-party noise (captured by console interception):**

| Source | Method | Examples |
|--------|--------|----------|
| UTCP Code Mode | `console.log` | `[McpCommunicationProtocol] Calling tool...` |
| MCP SDK | `console.log` / `console.error` | `Calling tool 'filesystem...' via protocol 'mcp'.` |

**Excluded from this design (standalone CLI tools with their own terminal output):**

| File | Reason |
|------|--------|
| `src/pipeline/compile.ts` | Standalone CLI (`npm run compile-policy`), not part of agent sessions |
| `src/trusted-process/mcp-proxy-server.ts` | Separate child process; already uses `process.stderr.write()` |

## Design

A thin, file-based logging module at `src/logger.ts` that captures all log output into a per-session log file at `~/.ironcurtain/sessions/{id}/session.log`. The terminal stays clean: only the agent's actual responses go to stdout, only escalation prompts and fatal errors go to stderr. Everything else is silently written to the log file for post-hoc debugging.

The logger has two independent capabilities:

1. **Structured logging API** -- `logger.info()`, `logger.warn()`, `logger.error()`, `logger.debug()` for IronCurtain's own code.
2. **Console interception** -- redirects `console.log`, `console.error`, `console.warn`, `console.debug` to the same log file, capturing third-party library output.

### Directory layout change

The session directory gains one new file:

```
~/.ironcurtain/sessions/{sessionId}/
  ├── sandbox/
  ├── escalations/
  ├── audit.jsonl
  └── session.log          <-- NEW
```

## Key Design Decisions

**1. Module-level singleton, not a class instance passed around.** Console interception is inherently global -- there is only one `console` object per process. A `setup()` / `teardown()` lifecycle at the module level is simpler and more honest than pretending this could be dependency-injected. The session factory calls `setup()` during init and `teardown()` during close.

**2. Synchronous `fs.appendFileSync` writes, not a write stream.** This is a tracer bullet. `appendFileSync` is simple, always flushes, and preserves data even if the process crashes. The `AuditLog` class uses a `WriteStream` because it handles high-throughput structured data; this logger handles human-readable debug lines at low volume. If performance becomes a concern later, switching to a buffered write stream is a localized change.

**3. Console interception saves and restores the originals.** We monkey-patch `console.log`, `console.error`, `console.warn`, and `console.debug` to redirect to the log file. The original methods are saved in module state so `teardown()` can restore them cleanly. Intercepted output is prefixed with `[console.{method}]` so log readers can distinguish third-party noise from IronCurtain's own logger calls.

**4. User-facing output bypasses the interception via `process.stdout.write()` / `process.stderr.write()`.** Any code that intends to talk to the user -- agent responses, escalation banners, REPL prompts, fatal error messages -- must call `process.stdout.write()` or `process.stderr.write()` directly instead of using `console.log` / `console.error`. These low-level write calls are not intercepted. This is the fundamental two-stream separation: `console.*` goes to the log file, `process.stdout/stderr.write()` goes to the terminal.

**5. The proxy process (`mcp-proxy-server.ts`) does NOT import the logger.** The proxy runs as a separate child process spawned by Code Mode. It already uses `process.stderr.write()` for its fatal error messages. Its stdio is owned by the MCP JSON-RPC protocol. The proxy is excluded from this design.

**6. The pipeline CLI (`src/pipeline/compile.ts`) does NOT import the logger.** The pipeline is a standalone CLI tool (`npm run compile-policy`) with its own terminal output. It does not run during agent sessions. No change needed.

**7. The `DiagnosticEvent` system stays as-is.** The `DiagnosticEvent` type and the `onDiagnostic` callback pattern in `AgentSession` are architecturally sound -- they decouple the session from I/O. The only change is that the callback in `src/index.ts` now calls `logger.info()` instead of `console.error()`. The `/logs` slash command continues to read from the in-memory `getDiagnosticLog()` array.

**8. Log level filtering is deferred.** For the tracer bullet, all levels are always written. A `LOG_LEVEL` environment variable can be added later without changing any call sites.

**9. No third-party logging libraries.** This is intentionally minimal. The module is ~80 lines of code with zero dependencies.

## Logger API

### Types and functions (`src/logger.ts`)

```typescript
/**
 * Log levels ordered by severity. All levels are always written
 * in the initial implementation; level filtering is deferred.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Configuration for logger setup. Provided once per session.
 */
export interface LoggerOptions {
  /** Absolute path to the log file. Parent directory must exist. */
  readonly logFilePath: string;
}

/**
 * Sets up file-based logging and console interception.
 *
 * After this call:
 * - logger.info/warn/error/debug() write to the log file
 * - console.log/error/warn/debug are intercepted and redirected
 *   to the log file
 * - Original console methods are saved for restoration
 *
 * Must be called exactly once per session. Calling setup() twice
 * without an intervening teardown() throws an error to prevent
 * leaked interceptions.
 *
 * @throws {Error} if logger is already set up
 */
export function setup(options: LoggerOptions): void;

/**
 * Restores original console methods and stops logging.
 * Idempotent -- safe to call multiple times or when the logger
 * was never set up.
 *
 * After this call, logger.info() etc. become no-ops and
 * console.* methods work normally again.
 */
export function teardown(): void;

/**
 * Returns true if the logger is currently set up (between a
 * setup() and teardown() call).
 */
export function isActive(): boolean;

/**
 * Log a message at the specified level. If the logger is not
 * set up, the call is a silent no-op. This makes it safe to
 * call from code that runs both inside and outside sessions
 * (e.g., MCPClientManager, the legacy runAgent()).
 *
 * Log line format:
 *   2026-02-18T14:30:00.123Z INFO  Session initialized
 *   2026-02-18T14:30:00.456Z ERROR Connection failed: timeout
 */
export function debug(message: string): void;
export function info(message: string): void;
export function warn(message: string): void;
export function error(message: string): void;
```

### Implementation

```typescript
// src/logger.ts

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerOptions {
  readonly logFilePath: string;
}

// --- Module state ---

let logFilePath: string | null = null;

/** Saved originals for restoration on teardown. */
let originalConsole: {
  log: typeof console.log;
  error: typeof console.error;
  warn: typeof console.warn;
  debug: typeof console.debug;
} | null = null;

// --- Lifecycle ---

export function setup(options: LoggerOptions): void {
  if (logFilePath !== null) {
    throw new Error('Logger already set up. Call teardown() first.');
  }

  logFilePath = options.logFilePath;

  // Ensure parent directory exists
  mkdirSync(dirname(logFilePath), { recursive: true });

  // Save originals before patching
  originalConsole = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    debug: console.debug,
  };

  // Intercept console methods -- redirect to log file
  console.log = (...args: unknown[]) => {
    writeEntry('info', `[console.log] ${formatArgs(args)}`);
  };
  console.error = (...args: unknown[]) => {
    writeEntry('error', `[console.error] ${formatArgs(args)}`);
  };
  console.warn = (...args: unknown[]) => {
    writeEntry('warn', `[console.warn] ${formatArgs(args)}`);
  };
  console.debug = (...args: unknown[]) => {
    writeEntry('debug', `[console.debug] ${formatArgs(args)}`);
  };

  writeEntry('info', 'Logger initialized');
}

export function teardown(): void {
  if (originalConsole) {
    console.log = originalConsole.log;
    console.error = originalConsole.error;
    console.warn = originalConsole.warn;
    console.debug = originalConsole.debug;
    originalConsole = null;
  }
  logFilePath = null;
}

export function isActive(): boolean {
  return logFilePath !== null;
}

// --- Logging functions ---

export function debug(message: string): void {
  writeEntry('debug', message);
}

export function info(message: string): void {
  writeEntry('info', message);
}

export function warn(message: string): void {
  writeEntry('warn', message);
}

export function error(message: string): void {
  writeEntry('error', message);
}

// --- Internal helpers ---

const LEVEL_PAD: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info:  'INFO ',
  warn:  'WARN ',
  error: 'ERROR',
};

function writeEntry(level: LogLevel, message: string): void {
  if (!logFilePath) return; // no-op when not set up
  const timestamp = new Date().toISOString();
  const line = `${timestamp} ${LEVEL_PAD[level]} ${message}\n`;
  try {
    appendFileSync(logFilePath, line);
  } catch {
    // Cannot log if the file is gone or disk is full.
    // Swallow to avoid crashing the agent over a logging failure.
  }
}

/**
 * Formats console.* arguments into a single string, mimicking
 * Node's util.format behavior for the common cases.
 */
function formatArgs(args: unknown[]): string {
  return args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
}
```

### Log file format

Plain text, one line per entry. Human-readable, `grep`-able:

```
2026-02-18T14:30:00.100Z INFO  Logger initialized
2026-02-18T14:30:00.101Z INFO  Session abc-123 created
2026-02-18T14:30:00.102Z INFO  Sandbox: /home/user/.ironcurtain/sessions/abc-123/sandbox
2026-02-18T14:30:01.500Z INFO  Connecting to MCP server: filesystem...
2026-02-18T14:30:02.300Z INFO  Connected to MCP server: filesystem
2026-02-18T14:30:02.301Z INFO  [console.log] [McpCommunicationProtocol] Calling tool filesystem.read_file
2026-02-18T14:30:02.302Z INFO  [sandbox] execute_code: const result = filesystem.read_file({path: '/tmp/test.txt'})
2026-02-18T14:30:02.400Z INFO  [console.log] Calling tool 'filesystem.read_file' via protocol 'mcp'.
2026-02-18T14:30:03.100Z INFO  [agent] Here are the contents of the file...
2026-02-18T14:30:10.000Z ERROR [console.error] Error closing MCP server "filesystem": connection reset
```

Lines prefixed with `[console.*]` are intercepted third-party output. Lines without that prefix are from IronCurtain's own `logger.*()` calls.

## Console Interception

### How it works

When `setup()` is called:

1. The original `console.log`, `console.error`, `console.warn`, and `console.debug` functions are saved to module-level variables.
2. Each is replaced with a function that formats its arguments and writes them to the log file via `writeEntry()`.
3. All subsequent `console.*` calls -- including those from UTCP Code Mode and the MCP SDK -- go to the log file instead of the terminal.

When `teardown()` is called:

1. The saved originals are restored to `console.log`, etc.
2. `console.*` calls work normally again.

### What is NOT intercepted

- **`process.stdout.write()`** -- used by the CLI transport for agent responses
- **`process.stderr.write()`** -- used for escalation banners, REPL prompts, fatal errors
- **`readline` prompts** -- the CLI transport passes `process.stderr` as the `output` for `createInterface()`, which calls `process.stderr.write()` internally

This is the key design insight: `console.log()` internally calls `process.stdout.write()`, so our interception replaces the outer function but not the inner primitive. Code that calls `process.stdout.write()` or `process.stderr.write()` directly always reaches the terminal.

### Edge case: setup() called twice

Calling `setup()` when the logger is already active throws an `Error`. This prevents a subtle bug where the saved "originals" would actually be the already-patched functions, making `teardown()` unable to restore the real originals.

### Edge case: logger not set up

All four logging functions (`debug`, `info`, `warn`, `error`) are silent no-ops when the logger has not been set up. This makes them safe to call from modules that run both inside and outside sessions. For example, `MCPClientManager.closeAll()` calls `logger.error()` -- if the code is invoked from an integration test without a session, the call does nothing.

## Path Helper Addition

Add to `src/config/paths.ts`:

```typescript
/**
 * Returns the session log path for a given session:
 *   {home}/sessions/{sessionId}/session.log
 */
export function getSessionLogPath(sessionId: string): string {
  return resolve(getSessionDir(sessionId), 'session.log');
}
```

## Component Diagram

```
                    src/index.ts (entry point)
                         |
                         | calls createSession()
                         v
                  src/session/index.ts
                         |
                    creates session dirs
                    calls logger.setup({ logFilePath })
                         |
                         v
                  src/session/agent-session.ts
                    |           |
                    |           | emits DiagnosticEvents
                    |           | via onDiagnostic callback
                    |           v
                    |     src/index.ts callback
                    |       calls logger.info(...)
                    |
                    v
              src/logger.ts  <--  module singleton
               /        \
              /          \
   logger.info()     console.log() interception
   logger.error()    console.error() interception
   logger.warn()     console.warn() interception
   logger.debug()    console.debug() interception
              \          /
               \        /
                v      v
    ~/.ironcurtain/sessions/{id}/session.log


  SEPARATE PROCESSES (do NOT import logger):

  src/trusted-process/mcp-proxy-server.ts
    -- uses process.stderr.write() directly
    -- its stderr captured by Code Mode sandbox

  src/pipeline/compile.ts
    -- standalone CLI tool
    -- uses console.error() for its own terminal output
```

### Data flow for different output types

```
IronCurtain diagnostic    -->  logger.info()           -->  session.log
Third-party library noise -->  console.log() [patched] -->  session.log
Agent response to user    -->  process.stdout.write()  -->  terminal (stdout)
Escalation banner         -->  process.stderr.write()  -->  terminal (stderr)
Fatal error               -->  process.stderr.write()  -->  terminal (stderr)
REPL prompts/feedback     -->  process.stderr.write()  -->  terminal (stderr)
```

## Integration Points

### Session factory (`src/session/index.ts`)

The factory sets up the logger after creating session directories but before initializing the sandbox. This ensures that sandbox init (which spawns child processes and triggers third-party console output) is captured.

```typescript
import * as logger from '../logger.js';
import { getSessionLogPath } from '../config/paths.js';

// Inside createSession(), after mkdirSync calls:
const sessionLogPath = getSessionLogPath(sessionId);
logger.setup({ logFilePath: sessionLogPath });
logger.info(`Session ${sessionId} created`);
logger.info(`Sandbox: ${sandboxDir}`);
logger.info(`Escalation dir: ${escalationDir}`);
logger.info(`Audit log: ${auditLogPath}`);
```

The error path must also call `teardown()` to restore console if session creation fails:

```typescript
try {
  await session.initialize();
} catch (error) {
  await session.close().catch(() => {});
  logger.teardown();  // <-- restore console before throwing
  throw new SessionError(...);
}
```

### Session close (`src/session/agent-session.ts`)

`logger.teardown()` is called at the end of `close()`, after all other cleanup. This ensures that sandbox shutdown output is still captured.

```typescript
async close(): Promise<void> {
  if (this.status === 'closed') return;
  this.status = 'closed';
  this.stopEscalationWatcher();
  if (this.sandbox) {
    await this.sandbox.shutdown();
    this.sandbox = null;
  }
  logger.teardown();  // <-- restore console after all cleanup
}
```

### Entry point (`src/index.ts`)

Three categories of changes:

**Diagnostic callback switches to logger:**

```typescript
onDiagnostic: (event) => {
  switch (event.kind) {
    case 'tool_call':
      logger.info(`[sandbox] ${event.toolName}: ${event.preview}`);
      break;
    case 'agent_text':
      logger.info(`[agent] ${event.preview}`);
      break;
  }
},
```

**Escalation callback switches to `process.stderr.write()` (user-facing):**

```typescript
onEscalation: (req) => {
  process.stderr.write('\n========================================\n');
  process.stderr.write('  ESCALATION: Human approval required\n');
  process.stderr.write('========================================\n');
  process.stderr.write(`  Tool:      ${req.serverName}/${req.toolName}\n`);
  process.stderr.write(`  Arguments: ${JSON.stringify(req.arguments, null, 2)}\n`);
  process.stderr.write(`  Reason:    ${req.reason}\n`);
  process.stderr.write('========================================\n');
  process.stderr.write('  Type /approve or /deny\n');
  process.stderr.write('========================================\n\n');
},
```

**Pre-session and fatal messages switch to `process.stderr.write()`:**

```typescript
process.stderr.write('Initializing session...\n');
// ... createSession() ...
process.stderr.write('Session ready.\n\n');

// ...

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
});
```

Note: the "Initializing session..." and "Fatal error:" messages fire before `logger.setup()` or after `logger.teardown()`, so they must use `process.stderr.write()` regardless.

### CLI transport (`src/session/cli-transport.ts`)

All `console.log()` and `console.error()` calls become `process.stdout.write()` and `process.stderr.write()` respectively, because every call in this file is user-facing output:

```typescript
// Single-shot mode -- agent response to stdout:
process.stdout.write('\n=== Agent Response ===\n');
process.stdout.write(response + '\n');

// Interactive mode -- agent response to stdout:
process.stdout.write(response + '\n\n');

// Interactive mode -- UI messages to stderr:
process.stderr.write('IronCurtain interactive mode. Type /quit to exit.\n\n');
process.stderr.write('Commands: /quit /logs /approve /deny\n\n');
process.stderr.write('  (still processing previous message, please wait)\n');

// /logs display to stderr:
process.stderr.write('  (no diagnostic events yet)\n');
process.stderr.write(`  [tool] ${event.toolName}: ${event.preview}\n`);

// Escalation commands to stderr:
process.stderr.write('  No escalation pending.\n');
process.stderr.write(`  Escalation ${decision}.\n`);

// Errors to stderr:
process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
process.stderr.write(`Unexpected error: ${err}\n`);
```

### TrustedProcess in-process mode (`src/trusted-process/index.ts`)

```typescript
import * as logger from '../logger.js';

async initialize(): Promise<void> {
  for (const [name, serverConfig] of Object.entries(this.config.mcpServers)) {
    logger.info(`Connecting to MCP server: ${name}...`);
    await this.mcpManager.connect(name, serverConfig);
    logger.info(`Connected to MCP server: ${name}`);
  }
}
```

### MCPClientManager (`src/trusted-process/mcp-client-manager.ts`)

```typescript
import * as logger from '../logger.js';

async closeAll(): Promise<void> {
  for (const [name, server] of this.servers) {
    try {
      await server.client.close();
    } catch (err) {
      logger.error(`Error closing MCP server "${name}": ${err}`);
    }
  }
  this.servers.clear();
}
```

### EscalationHandler (`src/trusted-process/escalation.ts`)

This is the in-process escalation handler used by `TrustedProcess` in direct-tool-call mode (not by sessions). Its output is user-facing (prompting for approval via readline), so it switches to `process.stderr.write()`:

```typescript
async prompt(request: ToolCallRequest, reason: string): Promise<'approved' | 'denied'> {
  const rl = this.getReadline();

  process.stderr.write('\n========================================\n');
  process.stderr.write('  ESCALATION: Human approval required\n');
  process.stderr.write('========================================\n');
  process.stderr.write(`  Tool:      ${request.serverName}/${request.toolName}\n`);
  process.stderr.write(`  Arguments: ${JSON.stringify(request.arguments, null, 2)}\n`);
  process.stderr.write(`  Reason:    ${reason}\n`);
  process.stderr.write('========================================\n');

  return new Promise((resolve) => {
    rl.question('  Approve? (y/N): ', (answer) => {
      const approved = answer.trim().toLowerCase() === 'y';
      process.stderr.write(approved ? '  -> APPROVED\n' : '  -> DENIED\n');
      process.stderr.write('========================================\n\n');
      resolve(approved ? 'approved' : 'denied');
    });
  });
}
```

### Legacy agent (`src/agent/index.ts`)

```typescript
import * as logger from '../logger.js';

// Replace all console.error calls:
logger.info(`[sandbox] Executing code (${code.length} chars)`);
logger.info(`Agent starting with Code Mode sandbox`);
logger.info(`Task: ${task}`);
logger.info(`Tool: execute_code("${preview}${input.code.length > 120 ? '...' : ''}")`);
logger.info(`Agent: ${text.substring(0, 200)}${text.length > 200 ? '...' : ''}`);
```

Since the legacy agent can run outside a session context (e.g., integration tests that call `runAgent()` directly), the logger will not be set up, and these become silent no-ops. That is the correct behavior -- no log file means no log output.

## Unchanged Files

| File | Reason |
|------|--------|
| `src/trusted-process/mcp-proxy-server.ts` | Separate child process. Already uses `process.stderr.write()` for fatal errors. Does not import the logger. |
| `src/pipeline/compile.ts` | Standalone CLI tool. Uses `console.error()` for its own terminal output. Not part of agent sessions. |
| `src/session/types.ts` | `DiagnosticEvent` and `SessionOptions.onDiagnostic` are unchanged. |
| `src/session/agent-session.ts` | `emitToolCallDiagnostics()` and `emitTextDiagnostic()` are unchanged (they fire the callback; the callback is what changes). One line added to `close()`. |
| `src/trusted-process/policy-engine.ts` | No console calls. |
| `src/trusted-process/audit-log.ts` | No console calls. |

## Complete File Change Summary

| File | Change | Type |
|------|--------|------|
| `src/logger.ts` | Logger module with setup/teardown lifecycle, structured logging API, console interception | **NEW** |
| `src/config/paths.ts` | Add `getSessionLogPath()` | Modified |
| `src/session/index.ts` | Call `logger.setup()` after creating dirs, `logger.teardown()` in error path | Modified |
| `src/session/agent-session.ts` | Call `logger.teardown()` at end of `close()` | Modified |
| `src/index.ts` | `onDiagnostic` uses `logger.info()`, escalation/startup/fatal use `process.stderr.write()` | Modified |
| `src/session/cli-transport.ts` | Replace all `console.log` with `process.stdout.write()`, all `console.error` with `process.stderr.write()` | Modified |
| `src/trusted-process/index.ts` | Replace `console.error` with `logger.info()` | Modified |
| `src/trusted-process/mcp-client-manager.ts` | Replace `console.error` with `logger.error()` | Modified |
| `src/trusted-process/escalation.ts` | Replace `console.error` with `process.stderr.write()` | Modified |
| `src/agent/index.ts` | Replace `console.error` with `logger.info()` | Modified |
| `test/logger.test.ts` | Unit tests for the logger module | **NEW** |

## `/logs` Slash Command

The `/logs` slash command in `cli-transport.ts` continues to read from the in-memory `getDiagnosticLog()` array. It shows the structured diagnostic events (tool calls, agent text) that the session accumulated during message processing.

The session log file captures a superset of this information (including third-party library noise and timestamps), but `getDiagnosticLog()` provides a cleaner, structured view for interactive use. A future enhancement could add a `/logs --full` variant that tails the session log file directly, but this is deferred.

## Testing Strategy

The logger's `setup()` / `teardown()` lifecycle makes unit testing straightforward. Tests create a temporary directory, set up the logger pointing at it, exercise the API, read the log file, and call `teardown()` in `afterEach` to ensure console is always restored.

```typescript
// test/logger.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as logger from '../src/logger.js';

describe('Logger', () => {
  let logDir: string;
  let logFile: string;

  beforeEach(() => {
    logDir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-logger-'));
    logFile = resolve(logDir, 'test.log');
  });

  afterEach(() => {
    logger.teardown(); // Always restore console, even if a test fails
  });

  it('writes entries with timestamp and level', () => {
    logger.setup({ logFilePath: logFile });
    logger.info('hello world');
    logger.teardown();

    const content = readFileSync(logFile, 'utf-8');
    expect(content).toContain('INFO ');
    expect(content).toContain('hello world');
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO timestamp
  });

  it('intercepts console.log and redirects to file', () => {
    logger.setup({ logFilePath: logFile });
    console.log('third-party noise');
    logger.teardown();

    const content = readFileSync(logFile, 'utf-8');
    expect(content).toContain('[console.log] third-party noise');
  });

  it('intercepts console.error and redirects to file', () => {
    logger.setup({ logFilePath: logFile });
    console.error('some error');
    logger.teardown();

    const content = readFileSync(logFile, 'utf-8');
    expect(content).toContain('[console.error] some error');
  });

  it('restores console methods on teardown', () => {
    const originalLog = console.log;
    logger.setup({ logFilePath: logFile });
    expect(console.log).not.toBe(originalLog);
    logger.teardown();
    expect(console.log).toBe(originalLog);
  });

  it('is a no-op when not set up', () => {
    // Should not throw, should not write anywhere
    logger.info('this goes nowhere');
    logger.error('neither does this');
  });

  it('throws if setup() called twice without teardown()', () => {
    logger.setup({ logFilePath: logFile });
    expect(() => logger.setup({ logFilePath: logFile })).toThrow(
      'Logger already set up',
    );
  });

  it('teardown() is idempotent', () => {
    logger.setup({ logFilePath: logFile });
    logger.teardown();
    logger.teardown(); // Should not throw
  });

  it('teardown() is safe when never set up', () => {
    logger.teardown(); // Should not throw
  });

  it('formats non-string console arguments as JSON', () => {
    logger.setup({ logFilePath: logFile });
    console.log('count:', 42, { key: 'value' });
    logger.teardown();

    const content = readFileSync(logFile, 'utf-8');
    expect(content).toContain('[console.log] count: 42 {"key":"value"}');
  });

  it('writes all four log levels', () => {
    logger.setup({ logFilePath: logFile });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    logger.teardown();

    const content = readFileSync(logFile, 'utf-8');
    expect(content).toContain('DEBUG d');
    expect(content).toContain('INFO  i');
    expect(content).toContain('WARN  w');
    expect(content).toContain('ERROR e');
  });

  it('isActive() reflects lifecycle state', () => {
    expect(logger.isActive()).toBe(false);
    logger.setup({ logFilePath: logFile });
    expect(logger.isActive()).toBe(true);
    logger.teardown();
    expect(logger.isActive()).toBe(false);
  });
});
```

## Open Questions

### Q1: Should there be a `logger.toUser()` convenience method?

Code that writes to the user's terminal must use `process.stderr.write()` or `process.stdout.write()` directly. This is explicit and correct, but verbose for multi-line output like escalation banners. A convenience method like `logger.toStderr(message)` could simplify these call sites.

**Recommendation**: Defer. The explicit `process.stderr.write()` calls make the intent unmistakable. Adding a wrapper is syntactic sugar that obscures the two-stream separation. If the pattern proves too verbose in practice, we can add it later.

### Q2: Should the proxy's stderr be routed to the session log?

The MCP proxy process (`mcp-proxy-server.ts`) writes to `process.stderr`, which Code Mode may propagate through some callback or pipe. If Code Mode surfaces proxy stderr as sandbox logs, we could route it to the logger. But this depends on UTCP's internal behavior and is outside our control.

**Recommendation**: Defer. Investigate Code Mode's stderr handling as a follow-up. For the tracer bullet, proxy stderr goes wherever Code Mode sends it (likely the parent process's stderr, which after console interception would end up in the log file anyway via the intercepted `console.error`).

### Q3: Should the `onDiagnostic` callback be removed from `SessionOptions`?

Now that `AgentSession` can call `logger.info()` directly, the `onDiagnostic` callback is arguably redundant for the CLI case. However, the callback serves a valid purpose: it lets transports decide how to present diagnostics (e.g., a web UI might show a progress spinner, Slack might post a thread update). The callback is about real-time UI feedback; the logger is about persistent debug output. They serve different needs.

**Recommendation**: Keep both. The `onDiagnostic` callback is the right abstraction for transport-specific UI. The logger is the right mechanism for persistent debug output. They coexist naturally: `AgentSession` emits events through the callback, and the callback handler (in `src/index.ts`) writes to the logger.
