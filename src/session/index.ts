/**
 * Session module public API.
 *
 * createSession() is the only entry point for session creation.
 * The concrete AgentSession class is not exported -- callers
 * depend on the Session interface only.
 */

import { mkdirSync } from 'node:fs';
import { loadConfig } from '../config/index.js';
import {
  getSessionSandboxDir,
  getSessionEscalationDir,
  getSessionAuditLogPath,
} from '../config/paths.js';
import { AgentSession } from './agent-session.js';
import { SessionError } from './errors.js';
import { createSessionId } from './types.js';
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
 * 3. Creates the session directory tree
 * 4. Overrides the config's allowedDirectory and auditLogPath
 * 5. Creates the AgentSession, calls initialize(), returns Session
 *
 * @throws {SessionError} with code SESSION_INIT_FAILED if
 *   sandbox or MCP connection setup fails.
 */
export async function createSession(options: SessionOptions = {}): Promise<Session> {
  const config = options.config ?? loadConfig();
  const sessionId = createSessionId();

  const sandboxDir = getSessionSandboxDir(sessionId);
  const escalationDir = getSessionEscalationDir(sessionId);
  const auditLogPath = getSessionAuditLogPath(sessionId);

  mkdirSync(sandboxDir, { recursive: true });
  mkdirSync(escalationDir, { recursive: true });

  // Override config paths for this session's isolated directories.
  // Deep-clone mcpServers so patching doesn't mutate the caller's config.
  const sessionConfig = {
    ...config,
    allowedDirectory: sandboxDir,
    auditLogPath,
    escalationDir,
    mcpServers: JSON.parse(JSON.stringify(config.mcpServers)),
  };

  // Patch MCP server args to use the session-specific sandbox directory
  patchMcpServerAllowedDirectory(sessionConfig, sandboxDir);

  const session = new AgentSession(sessionConfig, sessionId, escalationDir, options);

  try {
    await session.initialize();
  } catch (error) {
    // Clean up on init failure
    await session.close().catch(() => {});
    throw new SessionError(
      `Session initialization failed: ${error instanceof Error ? error.message : String(error)}`,
      'SESSION_INIT_FAILED',
    );
  }

  return session;
}

/**
 * Patches the filesystem MCP server's allowed directory argument
 * to use the session-specific sandbox directory, mirroring the
 * logic in loadConfig() that syncs ALLOWED_DIRECTORY.
 */
function patchMcpServerAllowedDirectory(
  config: { mcpServers: Record<string, { args: string[] }> },
  sandboxDir: string,
): void {
  const fsServer = config.mcpServers['filesystem'];
  if (!fsServer) return;

  // Replace any existing allowed directory path in args.
  // The config may have the original default or a previously patched value.
  const lastArgIndex = fsServer.args.length - 1;
  if (lastArgIndex >= 0) {
    fsServer.args[lastArgIndex] = sandboxDir;
  }
}

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
