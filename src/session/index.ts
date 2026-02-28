/**
 * Session module public API.
 *
 * createSession() is the only entry point for session creation.
 * The concrete implementations (AgentSession, DockerAgentSession)
 * are not exported -- callers depend on the Session interface only.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../config/index.js';
import {
  getSessionDir,
  getSessionSandboxDir,
  getSessionEscalationDir,
  getSessionAuditLogPath,
  getSessionLogPath,
  getSessionLlmLogPath,
  getSessionAutoApproveLlmLogPath,
  getSessionSocketsDir,
  getIronCurtainHome,
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

  // Dynamic imports to avoid loading Docker dependencies for built-in sessions
  const { registerBuiltinAdapters, getAgent } = await import('../docker/agent-registry.js');
  const { createCodeModeProxy } = await import('../docker/code-mode-proxy.js');
  const { createMitmProxy } = await import('../docker/mitm-proxy.js');
  const { loadOrCreateCA } = await import('../docker/ca.js');
  const { generateFakeKey } = await import('../docker/fake-keys.js');
  const { createDockerManager } = await import('../docker/docker-manager.js');
  const { DockerAgentSession } = await import('../docker/docker-agent-session.js');
  const { useTcpTransport } = await import('../docker/platform.js');

  await registerBuiltinAdapters();
  const adapter = getAgent(agentId);
  const useTcp = useTcpTransport();

  // Create sockets subdirectory for proxy UDS -- only this dir is mounted into containers
  const socketsDir = getSessionSocketsDir(effectiveSessionId);
  mkdirSync(socketsDir, { recursive: true });

  const socketPath = resolve(socketsDir, 'proxy.sock');

  const proxy = createCodeModeProxy({
    socketPath,
    config: sessionConfig.config,
    listenMode: useTcp ? 'tcp' : 'uds',
  });

  // Load or generate the IronCurtain CA for TLS termination
  const caDir = resolve(getIronCurtainHome(), 'ca');
  const ca = loadOrCreateCA(caDir);

  // Generate fake keys and build provider key mappings
  const providers = adapter.getProviders();
  const fakeKeys = new Map<string, string>();
  const providerMappings: import('../docker/mitm-proxy.js').ProviderKeyMapping[] = [];
  for (const providerConfig of providers) {
    const fakeKey = generateFakeKey(providerConfig.fakeKeyPrefix);
    fakeKeys.set(providerConfig.host, fakeKey);

    // Resolve real API key from config
    const realKey = resolveRealApiKey(providerConfig.host, config);
    providerMappings.push({ config: providerConfig, fakeKey, realKey });
  }

  const mitmProxy = useTcp
    ? createMitmProxy({
        listenPort: 0,
        ca,
        providers: providerMappings,
      })
    : createMitmProxy({
        socketPath: resolve(socketsDir, 'mitm-proxy.sock'),
        ca,
        providers: providerMappings,
      });
  const docker = createDockerManager();

  const session = new DockerAgentSession({
    config: sessionConfig.config,
    sessionId,
    adapter,
    docker,
    proxy,
    mitmProxy,
    ca,
    fakeKeys,
    sessionDir: sessionConfig.sessionDir,
    sandboxDir: sessionConfig.sandboxDir,
    escalationDir: sessionConfig.escalationDir,
    auditLogPath: sessionConfig.auditLogPath,
    useTcp,
    onEscalation: options.onEscalation,
    onEscalationExpired: options.onEscalationExpired,
    onDiagnostic: options.onDiagnostic,
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

/**
 * Resolves the real API key for a provider host from config.
 */
function resolveRealApiKey(host: string, config: IronCurtainConfig): string {
  let key: string;
  switch (host) {
    case 'api.anthropic.com':
      key = config.userConfig.anthropicApiKey;
      break;
    case 'api.openai.com':
      key = config.userConfig.openaiApiKey;
      break;
    case 'generativelanguage.googleapis.com':
      key = config.userConfig.googleApiKey;
      break;
    default:
      logger.warn(`No API key mapping for unknown provider host: ${host}`);
      return '';
  }
  if (!key) {
    logger.warn(`No API key configured for provider host: ${host}`);
  }
  return key;
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
