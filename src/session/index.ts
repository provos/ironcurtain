/**
 * Session module public API.
 *
 * createSession() is the only entry point for session creation.
 * The concrete implementations (AgentSession, DockerAgentSession)
 * are not exported -- callers depend on the Session interface only.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { loadConfig } from '../config/index.js';
import {
  getSessionDir,
  getSessionSandboxDir,
  getSessionEscalationDir,
  getSessionAuditLogPath,
  getSessionLogPath,
  getSessionLlmLogPath,
  getSessionAutoApproveLlmLogPath,
} from '../config/paths.js';
import type { IronCurtainConfig } from '../config/types.js';
import * as logger from '../logger.js';
import { AgentSession } from './agent-session.js';
import { SessionError } from './errors.js';
import { createSessionId } from './types.js';
import type { Session, SessionId, SessionOptions, SessionMode } from './types.js';

/**
 * Creates and initializes a new session.
 *
 * This is the only public entry point for session creation.
 * The concrete implementations are not exported -- callers
 * depend on the Session interface only.
 *
 * When mode is 'docker', spawns an external agent in a Docker
 * container with MCP proxy mediation. Otherwise (default), creates
 * the built-in AgentSession using UTCP Code Mode + AI SDK.
 *
 * @throws {SessionError} with code SESSION_INIT_FAILED if
 *   sandbox or MCP connection setup fails.
 */
export async function createSession(options: SessionOptions = {}): Promise<Session> {
  const mode: SessionMode = options.mode ?? { kind: 'builtin' };

  if (mode.kind === 'docker') {
    return createDockerSession(mode.agent, options);
  }

  return createBuiltinSession(options);
}

/**
 * Creates the built-in AgentSession (existing behavior).
 */
async function createBuiltinSession(options: SessionOptions): Promise<Session> {
  const config = options.config ?? loadConfig();
  const sessionId = createSessionId();

  // When resuming, reuse the previous session's directory tree entirely.
  // Logs are append-only so they simply extend.
  const effectiveSessionId = options.resumeSessionId ?? sessionId;

  if (options.resumeSessionId) {
    const sessionDir = getSessionDir(options.resumeSessionId);
    if (!existsSync(sessionDir)) {
      throw new SessionError(
        `Cannot resume session "${options.resumeSessionId}": ` + `session directory not found at ${sessionDir}`,
        'SESSION_INIT_FAILED',
      );
    }
  }

  const loggerWasActive = logger.isActive();
  const sessionConfig = buildSessionConfig(config, effectiveSessionId, sessionId, options.resumeSessionId);

  const session = new AgentSession(sessionConfig.config, sessionId, sessionConfig.escalationDir, options);

  try {
    await session.initialize();
  } catch (error) {
    // Clean up on init failure
    await session.close().catch(() => {});
    if (!loggerWasActive) logger.teardown();
    throw new SessionError(
      `Session initialization failed: ${error instanceof Error ? error.message : String(error)}`,
      'SESSION_INIT_FAILED',
    );
  }

  return session;
}

/**
 * Creates a DockerAgentSession that runs an external agent in a container.
 *
 * Uses prepareDockerInfrastructure() for shared Docker setup (proxies,
 * orientation, image resolution), then creates the session with pre-built
 * infrastructure so initialize() only does container creation + watchers.
 */
async function createDockerSession(
  agentId: import('../docker/agent-adapter.js').AgentId,
  options: SessionOptions,
): Promise<Session> {
  const config = options.config ?? loadConfig();
  const sessionId = createSessionId();
  const effectiveSessionId = options.resumeSessionId ?? sessionId;

  const loggerWasActive = logger.isActive();
  const sessionConfig = buildSessionConfig(config, effectiveSessionId, sessionId, options.resumeSessionId);

  const { prepareDockerInfrastructure } = await import('../docker/docker-infrastructure.js');
  const { DockerAgentSession } = await import('../docker/docker-agent-session.js');

  const infra = await prepareDockerInfrastructure(
    sessionConfig.config,
    { kind: 'docker', agent: agentId },
    sessionConfig.sessionDir,
    sessionConfig.sandboxDir,
    sessionConfig.escalationDir,
    sessionConfig.auditLogPath,
    sessionId,
  );

  const session = new DockerAgentSession({
    config: sessionConfig.config,
    sessionId,
    adapter: infra.adapter,
    docker: infra.docker,
    proxy: infra.proxy,
    mitmProxy: infra.mitmProxy,
    ca: infra.ca,
    fakeKeys: infra.fakeKeys,
    sessionDir: sessionConfig.sessionDir,
    sandboxDir: sessionConfig.sandboxDir,
    escalationDir: sessionConfig.escalationDir,
    auditLogPath: sessionConfig.auditLogPath,
    useTcp: infra.useTcp,
    onEscalation: options.onEscalation,
    onEscalationExpired: options.onEscalationExpired,
    onDiagnostic: options.onDiagnostic,
    preBuiltInfrastructure: {
      systemPrompt: infra.systemPrompt,
      image: infra.image,
      mitmAddr: infra.mitmAddr,
    },
  });

  try {
    await session.initialize();
  } catch (error) {
    await session.close().catch(() => {});
    if (!loggerWasActive) logger.teardown();
    throw new SessionError(
      `Docker session initialization failed: ${error instanceof Error ? error.message : String(error)}`,
      'SESSION_INIT_FAILED',
    );
  }

  return session;
}

/** Paths and patched config produced by buildSessionConfig. */
interface SessionDirConfig {
  config: IronCurtainConfig;
  sessionDir: string;
  sandboxDir: string;
  escalationDir: string;
  auditLogPath: string;
  autoApproveLlmLogPath: string;
}

/**
 * Shared session directory setup and config patching used by both session modes.
 */
function buildSessionConfig(
  config: IronCurtainConfig,
  effectiveSessionId: string,
  sessionId: SessionId,
  resumeSessionId?: string,
): SessionDirConfig {
  const sessionDir = getSessionDir(effectiveSessionId);
  const sandboxDir = getSessionSandboxDir(effectiveSessionId);
  const escalationDir = getSessionEscalationDir(effectiveSessionId);
  const auditLogPath = getSessionAuditLogPath(effectiveSessionId);

  mkdirSync(sandboxDir, { recursive: true });
  mkdirSync(escalationDir, { recursive: true });

  const sessionLogPath = getSessionLogPath(effectiveSessionId);
  const llmLogPath = getSessionLlmLogPath(effectiveSessionId);
  const autoApproveLlmLogPath = getSessionAutoApproveLlmLogPath(effectiveSessionId);

  // Set up session logging -- captures all console output to file
  logger.setup({ logFilePath: sessionLogPath });
  logger.info(`Session ${sessionId} created`);
  logger.info(`Sandbox: ${sandboxDir}`);
  logger.info(`Escalation dir: ${escalationDir}`);
  logger.info(`Audit log: ${auditLogPath}`);
  logger.info(`LLM log: ${llmLogPath}`);
  if (resumeSessionId) {
    logger.info(`Resumed from session: ${resumeSessionId}`);
  }

  // Override config paths for this session's isolated directories.
  // Deep-clone mcpServers so patching doesn't mutate the caller's config.
  const sessionConfig = {
    ...config,
    allowedDirectory: sandboxDir,
    auditLogPath,
    escalationDir,
    sessionLogPath,
    llmLogPath,
    autoApproveLlmLogPath,
    mcpServers: JSON.parse(JSON.stringify(config.mcpServers)) as typeof config.mcpServers,
  };

  // Patch MCP server args to use the session-specific sandbox directory
  patchMcpServerAllowedDirectory(sessionConfig, sandboxDir);

  return {
    config: sessionConfig,
    sessionDir,
    sandboxDir,
    escalationDir,
    auditLogPath,
    autoApproveLlmLogPath,
  };
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
  const fsServer = config.mcpServers['filesystem'] as { args: string[] } | undefined;
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
  SessionMode,
  SessionOptions,
  SessionInfo,
  SessionId,
  ConversationTurn,
  DiagnosticEvent,
  EscalationRequest,
  SandboxFactory,
  BudgetStatus,
} from './types.js';
export type { Transport } from './transport.js';
export { SessionError, SessionNotReadyError, SessionClosedError, BudgetExhaustedError } from './errors.js';
export { resolveSessionMode, PreflightError } from './preflight.js';
export type { PreflightResult, PreflightOptions } from './preflight.js';
