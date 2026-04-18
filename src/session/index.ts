/**
 * Session module public API.
 *
 * createSession() is the only entry point for session creation.
 * The concrete implementations (AgentSession, DockerAgentSession)
 * are not exported -- callers depend on the Session interface only.
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig } from '../config/index.js';
import {
  getIronCurtainHome,
  getPackageConfigDir,
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
import { resolveRealPath } from '../types/argument-roles.js';
import { resolvePersona, applyServerAllowlist } from '../persona/resolve.js';
import { buildPersonaSystemPromptAugmentation } from '../persona/persona-prompt.js';
import { resolveMemoryDbPath } from '../memory/resolve-memory-path.js';
import { buildMemoryServerConfig, MEMORY_SERVER_NAME } from '../memory/memory-annotations.js';
import { buildMemorySystemPrompt, adaptMemoryToolNames } from '../memory/memory-prompt.js';
import { AgentSession } from './agent-session.js';
import { SessionError } from './errors.js';
import { saveSessionMetadata, loadSessionMetadata } from './session-metadata.js';
import { isEqualOrInside } from './workspace-validation.js';
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
  // When resuming, restore persisted session settings (persona, workspace, etc.)
  const effectiveOptions = applyResumeMetadata(options);
  const mode: SessionMode = effectiveOptions.mode ?? { kind: 'builtin' };

  if (mode.kind === 'docker') {
    return createDockerSession(mode.agent, effectiveOptions);
  }

  return createBuiltinSession(effectiveOptions);
}

/**
 * Merges persisted session metadata into options when resuming.
 * Returns options unchanged for new sessions or when no metadata exists
 * (graceful for sessions created before metadata persistence was added).
 */
function applyResumeMetadata(options: SessionOptions): SessionOptions {
  if (!options.resumeSessionId) return options;
  const metadata = loadSessionMetadata(options.resumeSessionId);
  if (!metadata) return options;
  return {
    ...options,
    // Only spread defined metadata fields so undefined doesn't overwrite
    // caller-provided values (important for non-CLI callers like the daemon).
    ...(metadata.persona !== undefined ? { persona: metadata.persona } : {}),
    ...(metadata.workspacePath !== undefined ? { workspacePath: metadata.workspacePath } : {}),
    ...(metadata.policyDir !== undefined ? { policyDir: metadata.policyDir } : {}),
    ...(metadata.disableAutoApprove !== undefined ? { disableAutoApprove: metadata.disableAutoApprove } : {}),
  };
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
  const sessionConfig = buildSessionConfig(config, effectiveSessionId, sessionId, options);

  // Merge resolved systemPromptAugmentation (may include persona augmentation)
  // back into options so AgentSession sees it.
  const effectiveOptions: SessionOptions = sessionConfig.systemPromptAugmentation
    ? { ...options, systemPromptAugmentation: sessionConfig.systemPromptAugmentation }
    : options;

  const session = new AgentSession(
    sessionConfig.config,
    sessionId,
    sessionConfig.escalationDir,
    sessionConfig.sessionDir,
    effectiveOptions,
  );

  try {
    await session.initialize();
  } catch (error) {
    // Clean up on init failure. Teardown logger so error messages from
    // callers (orchestrator, XState) go to the terminal, not the log file.
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
 * Two paths:
 * - Standalone (default): calls `createDockerInfrastructure()` to stand up
 *   the full infrastructure bundle (proxies, orientation, image, running
 *   agent container, sidecar and internal network for TCP mode). The
 *   session is constructed with `ownsInfra=true`, so `close()` tears down
 *   the bundle.
 * - Borrow (`options.workflowInfrastructure` set): uses the caller-supplied
 *   bundle as-is and constructs the session with `ownsInfra=false`. The
 *   caller retains full responsibility for the bundle's lifetime; the
 *   session's `close()` only tears down session-local state.
 *
 * In both paths the session wires up escalation watcher and audit tailer
 * and writes any per-session files (CLAUDE.md, effective system prompt)
 * using fields on the bundle.
 */
async function createDockerSession(
  agentId: import('../docker/agent-adapter.js').AgentId,
  options: SessionOptions,
): Promise<Session> {
  const config = options.config ?? loadConfig();
  const sessionId = createSessionId();
  const effectiveSessionId = options.resumeSessionId ?? sessionId;

  const loggerWasActive = logger.isActive();
  const sessionConfig = buildSessionConfig(config, effectiveSessionId, sessionId, options);

  // Wrap the entire infrastructure + init sequence so that logger.teardown()
  // runs on ANY failure, not just session.initialize() failures.
  // buildSessionConfig() calls logger.setup() which hijacks console globally;
  // if we don't teardown on error, all subsequent console output (including
  // error messages from the orchestrator and XState) silently goes to a log
  // file instead of the terminal.
  let session: InstanceType<typeof import('../docker/docker-agent-session.js').DockerAgentSession> | undefined;
  // Track the infra bundle in outer scope so the catch path can clean
  // up containers/proxies even if failure happens BEFORE the session
  // instance exists (e.g., writeFileSync for CLAUDE.md throws, or the
  // DockerAgentSession constructor throws). Without this, the session
  // is undefined and `session?.close()` is a no-op — the container,
  // sidecar, network, and proxies all leak.
  let infra:
    | Awaited<ReturnType<typeof import('../docker/docker-infrastructure.js').createDockerInfrastructure>>
    | undefined;
  // Tracks whether THIS factory allocated the infra bundle. When true and
  // the session never reaches a constructed state, the catch path tears
  // down the bundle directly. When false (borrow path), the caller owns
  // the bundle and the factory must NEVER destroy it, even on error.
  let builtInfra = false;
  try {
    const { DockerAgentSession } = await import('../docker/docker-agent-session.js');
    const { buildDockerClaudeMd } = await import('../docker/claude-md-seed.js');

    if (options.workflowInfrastructure) {
      // Borrow path: the orchestrator owns the bundle's lifetime. We do
      // not call createDockerInfrastructure(); we do not destroy on close.
      infra = options.workflowInfrastructure;
    } else {
      // Standalone path: factory creates and owns the bundle.
      const { createDockerInfrastructure } = await import('../docker/docker-infrastructure.js');
      infra = await createDockerInfrastructure(
        sessionConfig.config,
        { kind: 'docker', agent: agentId },
        sessionConfig.sessionDir,
        sessionConfig.sandboxDir,
        sessionConfig.escalationDir,
        sessionConfig.auditLogPath,
        sessionId,
        options.tokenStreamBus,
      );
      builtInfra = true;
    }

    const claudeMdContent = buildDockerClaudeMd({
      personaName: options.persona,
      memoryEnabled: config.userConfig.memory.enabled,
    });

    // Write CLAUDE.md into conversation state dir (unconditionally, even on
    // resume, since persona/memory config may change between sessions).
    // Clean up stale CLAUDE.md when memory is disabled to avoid leftover rules.
    if (infra.conversationStateDir) {
      const claudeMdPath = resolve(infra.conversationStateDir, 'CLAUDE.md');
      if (claudeMdContent) {
        writeFileSync(claudeMdPath, claudeMdContent);
      } else {
        try {
          unlinkSync(claudeMdPath);
        } catch {
          /* not present */
        }
      }
    }

    const systemPromptOverride = sessionConfig.systemPromptAugmentation
      ? `${infra.systemPrompt}\n\n${sessionConfig.systemPromptAugmentation}`
      : undefined;

    session = new DockerAgentSession({
      config: sessionConfig.config,
      sessionId,
      infra,
      // Ownership mirrors who allocated the bundle: standalone path owns
      // and tears down on close; borrow path leaves the bundle alive for
      // the external orchestrator.
      ownsInfra: builtInfra,
      agentModelOverride: options.agentModelOverride,
      onEscalation: options.onEscalation,
      onEscalationExpired: options.onEscalationExpired,
      onEscalationResolved: options.onEscalationResolved,
      onDiagnostic: options.onDiagnostic,
      systemPromptOverride,
    });

    await session.initialize();
    return session;
  } catch (error) {
    // If the session was constructed, its close() respects the ownsInfra
    // flag we passed in: standalone sessions (ownsInfra=true) destroy the
    // bundle they own; borrow-mode sessions (ownsInfra=false) leave the
    // caller's bundle intact. We need only invoke close() -- no
    // conditional cleanup here.
    //
    // Otherwise, if we allocated the bundle ourselves but failed before
    // the session was constructed (e.g., the DockerAgentSession
    // constructor threw, or the CLAUDE.md write threw), destroy it
    // directly. NEVER destroy a caller-supplied bundle on this branch --
    // `builtInfra` is false in borrow mode, so the guard below skips it.
    if (session) {
      await session.close().catch(() => {});
    } else if (builtInfra && infra) {
      const { destroyDockerInfrastructure } = await import('../docker/docker-infrastructure.js');
      await destroyDockerInfrastructure(infra).catch(() => {});
    }
    if (!loggerWasActive) logger.teardown();
    throw error instanceof SessionError
      ? error
      : new SessionError(
          `Docker session failed: ${error instanceof Error ? error.message : String(error)}`,
          'SESSION_INIT_FAILED',
        );
  }
}

/** Paths and patched config produced by buildSessionConfig. */
export interface SessionDirConfig {
  config: IronCurtainConfig;
  sessionDir: string;
  sandboxDir: string;
  escalationDir: string;
  auditLogPath: string;
  /** Resolved system prompt augmentation (may include persona augmentation). */
  systemPromptAugmentation?: string;
}

/**
 * Validates that a policyDir path resolves to a location under the
 * IronCurtain home directory or the package config directory. Prevents
 * loading attacker-controlled policy files from arbitrary filesystem locations.
 *
 * The package config directory is allowed so that built-in policy variants
 * (e.g., the read-only policy for constitution generation) can be loaded
 * without copying files into the user home.
 *
 * @throws {SessionError} if the path escapes all trusted directories.
 */
function validatePolicyDir(policyDir: string): void {
  const resolvedPolicy = resolveRealPath(policyDir);
  const trustedDirs = [getIronCurtainHome(), getPackageConfigDir()].map(resolveRealPath);

  if (!trustedDirs.some((dir) => isEqualOrInside(resolvedPolicy, dir))) {
    throw new SessionError(
      `policyDir must be under a trusted directory. ` +
        `Received: ${resolvedPolicy}; ` +
        `trusted: ${trustedDirs.join(', ')}`,
      'SESSION_INIT_FAILED',
    );
  }
}

/**
 * Shared session directory setup and config patching used by both session modes.
 *
 * When workspacePath is provided, it replaces the session sandbox as the
 * agent's working directory. The workspace already exists so we skip
 * creating it, but all other session infrastructure (logs, escalations)
 * still lives under the session directory.
 *
 * When persona is set, resolves the persona to a policyDir, workspace,
 * server allowlist, and system prompt augmentation. Persona takes
 * precedence over explicit policyDir if both are provided.
 */
export function buildSessionConfig(
  config: IronCurtainConfig,
  effectiveSessionId: string,
  sessionId: SessionId,
  opts: Pick<
    SessionOptions,
    | 'resumeSessionId'
    | 'workspacePath'
    | 'policyDir'
    | 'disableAutoApprove'
    | 'persona'
    | 'systemPromptAugmentation'
    | 'jobId'
    | 'resourceBudgetOverrides'
  > = {},
): SessionDirConfig {
  let { workspacePath, policyDir, systemPromptAugmentation } = opts;
  const { resumeSessionId, disableAutoApprove } = opts;
  let serverAllowlist: readonly string[] | undefined;

  // Resolve persona early -- derives policyDir, workspace, server filter,
  // and system prompt augmentation from the persona definition.
  if (opts.persona) {
    const resolved = resolvePersona(opts.persona);
    if (policyDir) {
      logger.warn('Both persona and policyDir specified; using persona.');
    }
    policyDir = resolved.policyDir;
    serverAllowlist = resolved.persona.servers;

    // Use persona workspace unless an explicit workspacePath was provided
    if (!workspacePath) {
      workspacePath = resolved.workspacePath;
    }

    // Build persona system prompt augmentation (includes MCP memory prompt when enabled).
    const memoryEnabled = config.userConfig.memory.enabled;
    const personaAugmentation = buildPersonaSystemPromptAugmentation(resolved.persona, memoryEnabled);
    systemPromptAugmentation = systemPromptAugmentation
      ? `${personaAugmentation}\n\n${systemPromptAugmentation}`
      : personaAugmentation;

    logger.info(`Persona "${opts.persona}" resolved: policyDir=${policyDir}`);
  }

  if (policyDir) {
    validatePolicyDir(policyDir);
  }

  const sessionDir = getSessionDir(effectiveSessionId);
  const sandboxDir = workspacePath ?? getSessionSandboxDir(effectiveSessionId);
  const escalationDir = getSessionEscalationDir(effectiveSessionId);
  const auditLogPath = getSessionAuditLogPath(effectiveSessionId);

  // Create the directory when not using an explicit --workspace flag.
  // When persona is set, `workspacePath` was derived internally (not
  // from the caller), so we still need to ensure it exists.
  // Only skip creation for explicit user-provided workspace paths.
  if (!opts.workspacePath) {
    mkdirSync(sandboxDir, { recursive: true });
  }
  mkdirSync(escalationDir, { recursive: true });

  const sessionLogPath = getSessionLogPath(effectiveSessionId);
  const llmLogPath = getSessionLlmLogPath(effectiveSessionId);
  const autoApproveLlmLogPath = getSessionAutoApproveLlmLogPath(effectiveSessionId);

  // Set up session logging -- captures all console output to file
  logger.setup({ logFilePath: sessionLogPath });
  logger.info(`Session ${sessionId} created`);
  logger.info(`${workspacePath ? 'Workspace' : 'Sandbox'}: ${sandboxDir}`);
  logger.info(`Escalation dir: ${escalationDir}`);
  logger.info(`Audit log: ${auditLogPath}`);
  logger.info(`LLM log: ${llmLogPath}`);
  if (resumeSessionId) {
    logger.info(`Resumed from session: ${resumeSessionId}`);
  }

  // Build userConfig overrides (auto-approver disable, resource budget).
  // Composed incrementally so multiple overrides don't clobber each other.
  let patchedUserConfig = config.userConfig;
  if (disableAutoApprove) {
    patchedUserConfig = { ...patchedUserConfig, autoApprove: { ...patchedUserConfig.autoApprove, enabled: false } };
  }
  if (opts.resourceBudgetOverrides) {
    patchedUserConfig = {
      ...patchedUserConfig,
      resourceBudget: { ...patchedUserConfig.resourceBudget, ...opts.resourceBudgetOverrides },
    };
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
    // When per-job/persona policy is provided, split generated dir:
    // generatedDir -> per-job/persona dir (compiled policy + dynamic lists)
    // toolAnnotationsDir -> global dir (tool annotations)
    ...(policyDir
      ? {
          generatedDir: policyDir,
          toolAnnotationsDir: config.toolAnnotationsDir ?? config.generatedDir,
        }
      : {}),
    mcpServers: JSON.parse(JSON.stringify(config.mcpServers)) as typeof config.mcpServers,
    userConfig: patchedUserConfig,
  };

  // Apply server allowlist if persona specifies one
  if (serverAllowlist) {
    sessionConfig.mcpServers = applyServerAllowlist(sessionConfig.mcpServers, serverAllowlist);
  }

  // Inject the memory MCP server for persona and cron job sessions only.
  // Default (ad-hoc) sessions are stateless and don't benefit from memory.
  const memoryConfig = config.userConfig.memory;
  if (memoryConfig.enabled && (opts.persona || opts.jobId)) {
    const dbPath = resolveMemoryDbPath({
      persona: opts.persona,
      jobId: opts.jobId,
    });
    mkdirSync(dirname(dbPath), { recursive: true });
    sessionConfig.mcpServers[MEMORY_SERVER_NAME] = buildMemoryServerConfig({
      dbPath,
      namespace: (opts.persona ?? opts.jobId) as string,
      llmBaseUrl: memoryConfig.llmBaseUrl,
      llmApiKey: memoryConfig.llmApiKey,
      anthropicApiKey: config.userConfig.anthropicApiKey,
    });

    // For non-persona cron jobs, inject memory usage instructions since
    // persona sessions get this via buildPersonaSystemPromptAugmentation.
    if (!opts.persona) {
      const memoryPrompt = adaptMemoryToolNames(buildMemorySystemPrompt());
      systemPromptAugmentation = systemPromptAugmentation
        ? `${memoryPrompt}\n\n${systemPromptAugmentation}`
        : memoryPrompt;
    }
  }

  // Patch MCP server args to use the session-specific sandbox directory
  patchMcpServerAllowedDirectory(sessionConfig, sandboxDir);

  // Persist session settings so --resume can restore them.
  // Only write on initial creation (not when resuming).
  if (!resumeSessionId) {
    saveSessionMetadata(effectiveSessionId, {
      createdAt: new Date().toISOString(),
      ...(opts.persona ? { persona: opts.persona } : {}),
      ...(opts.workspacePath ? { workspacePath: opts.workspacePath } : {}),
      // Only store policyDir when no persona is set (persona derives its own)
      ...(!opts.persona && policyDir ? { policyDir } : {}),
      ...(opts.disableAutoApprove ? { disableAutoApprove: true } : {}),
    });
  }

  return {
    config: sessionConfig,
    sessionDir,
    sandboxDir,
    escalationDir,
    auditLogPath,
    systemPromptAugmentation,
  };
}

/**
 * Patches the filesystem MCP server's allowed directory argument
 * to use the session-specific sandbox directory, mirroring the
 * logic in loadConfig() that syncs ALLOWED_DIRECTORY.
 */
export function patchMcpServerAllowedDirectory(
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
