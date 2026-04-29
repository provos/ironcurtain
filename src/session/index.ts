/**
 * Session module public API.
 *
 * createSession() is the only entry point for session creation.
 * The concrete implementations (AgentSession, DockerAgentSession)
 * are not exported -- callers depend on the Session interface only.
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  loadConfig,
  applyAllowedDirectoryToMcpArgs,
  loadGeneratedPolicy,
  getPackageGeneratedDir,
} from '../config/index.js';
import { extractRequiredServers } from '../trusted-process/policy-roots.js';
import {
  getSessionDir,
  getSessionSandboxDir,
  getSessionEscalationDir,
  getSessionAuditLogPath,
  getSessionLogPath,
  getSessionLlmLogPath,
  getSessionAutoApproveLlmLogPath,
  SESSION_LOG_FILENAME,
  SESSION_METADATA_FILENAME,
} from '../config/paths.js';
import { validatePolicyDir as sharedValidatePolicyDir } from '../config/validate-policy-dir.js';
import type { IronCurtainConfig } from '../config/types.js';
import * as logger from '../logger.js';
import { resolvePersona, applyServerAllowlist, filterMcpServersByPolicy } from '../persona/resolve.js';
import { resolveSkillsForSession } from '../skills/discovery.js';
import type { ResolvedSkill } from '../skills/types.js';
import { buildPersonaSystemPromptAugmentation } from '../persona/persona-prompt.js';
import { resolveMemoryDbPath } from '../memory/resolve-memory-path.js';
import { buildMemoryServerConfig, MEMORY_SERVER_NAME } from '../memory/memory-annotations.js';
import { buildMemorySystemPrompt, adaptMemoryToolNames } from '../memory/memory-prompt.js';
import { isMemoryEnabledFor } from '../memory/memory-policy.js';
import type { PersonaDefinition } from '../persona/types.js';
import { createJobId } from '../cron/types.js';
import { loadJob } from '../cron/job-store.js';
import { AgentSession } from './agent-session.js';
import { SessionError } from '../types/errors.js';
import { saveSessionMetadata, saveSessionMetadataTo, loadSessionMetadata } from './session-metadata.js';
import { createAgentConversationId, createSessionId } from './types.js';
import type {
  AgentConversationId,
  BuiltinSessionOptions,
  BundleId,
  DockerSessionOptions,
  Session,
  SessionId,
  SessionOptions,
  SessionMode,
} from './types.js';

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
export async function createSession(options: DockerSessionOptions): Promise<Session>;
export async function createSession(options?: BuiltinSessionOptions): Promise<Session>;
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
 * Entry point for callers outside the workflow orchestrator — CLI,
 * daemon, signal bot, web UI. For Docker mode: resumes the persisted
 * `AgentConversationId` when `resumeSessionId` is set (so
 * `ironcurtain --resume <id>` continues the prior Claude conversation
 * via `--resume <conv-id>` on the adapter), otherwise mints fresh.
 * Builtin mode ignores the field.
 *
 * Legacy-session fallback: sessions created before
 * `agentConversationId` was persisted in metadata will have no stored
 * id. Those resumes mint fresh, and the agent CLI starts a new
 * conversation — the prior transcript is unreachable but nothing is
 * corrupted. New sessions created post-refactor always persist the id,
 * so subsequent resumes recover the conversation.
 *
 * Workflow callers must not use this: they must thread
 * `agentConversationId` from `context.agentConversationsByState` via
 * `createSession()` directly so `freshSession: false` states resume
 * the prior conversation.
 */
export async function createStandaloneSession(options: Omit<SessionOptions, 'agentConversationId'>): Promise<Session> {
  if (options.mode?.kind === 'docker') {
    const persistedId = options.resumeSessionId
      ? loadSessionMetadata(options.resumeSessionId)?.agentConversationId
      : undefined;
    return createSession({
      ...options,
      mode: options.mode,
      agentConversationId: persistedId ?? createAgentConversationId(),
    });
  }
  return createSession({ ...options, mode: options.mode });
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
    // Caller-supplied `agentConversationId` wins over the persisted
    // one (workflow orchestrator always passes its own explicitly).
    // Only the CLI / daemon `createStandaloneSession` path leaves the
    // field unset, and that's exactly the path we want to restore from
    // metadata so `--resume` continues the prior Claude conversation.
    ...(options.agentConversationId === undefined && metadata.agentConversationId !== undefined
      ? { agentConversationId: metadata.agentConversationId }
      : {}),
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

  // Agent-CLI conversation id must be minted by the caller. Docker-mode
  // callers pass `DockerSessionOptions`, which makes this field required
  // at the type level. The runtime guard catches callers that widen to
  // the base `SessionOptions` type and forget to supply it — the factory
  // will not mint on their behalf because the single-conversation model
  // makes the minting site load-bearing (workflow orchestrator reuses
  // per state; each CLI run mints fresh). See §11 step 4 and §3
  // "Identity flow" in docs/designs/workflow-session-identity.md.
  if (!options.agentConversationId) {
    throw new SessionError(
      'agentConversationId is required for Docker sessions: mint via createAgentConversationId() at the call site',
      'SESSION_INIT_FAILED',
    );
  }
  const agentConversationId: AgentConversationId = options.agentConversationId;

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
      // The orchestrator is also responsible for `setTokenSessionId`: it
      // flips the MITM proxy's routing target to the active agent's session
      // ID before each run and clears it on session end.
      infra = options.workflowInfrastructure;
    } else {
      // Standalone path: factory creates and owns the bundle.
      // Single-session invariant (§2.1 of workflow-session-identity): the
      // SessionId value doubles as the BundleId. Casting at this boundary
      // preserves the deterministic `ironcurtain-<sessionId[0:12]>`
      // container name for prior-crash recovery.
      const bundleId = sessionId as unknown as BundleId;
      const { createDockerInfrastructure } = await import('../docker/docker-infrastructure.js');
      infra = await createDockerInfrastructure(
        sessionConfig.config,
        { kind: 'docker', agent: agentId },
        sessionConfig.sessionDir,
        sessionConfig.sandboxDir,
        sessionConfig.escalationDir,
        bundleId,
        undefined,
        undefined,
        sessionConfig.resolvedSkills,
      );
      // Standalone sessions use their bundle for the session's entire
      // lifetime; pin the token-stream routing ID to this session's ID.
      // Clearing on close is unnecessary because the bundle itself is
      // destroyed by `session.close()` (ownsInfra=true).
      infra.setTokenSessionId(sessionId);
      builtInfra = true;
    }

    const claudeMdContent = buildDockerClaudeMd({
      personaName: options.persona,
      memoryEnabled: sessionConfig.memoryEnabled,
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
      agentConversationId,
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
  /** Memory MCP gate decision derived from persona/job/userConfig. */
  memoryEnabled: boolean;
  /**
   * Skills resolved via user → persona → workflow last-wins. Always
   * `[]` in borrow mode — staging happened in-place via
   * `borrowInfra.restageSkills`, so callers shouldn't re-stage.
   */
  resolvedSkills?: readonly ResolvedSkill[];
}

/**
 * Validates that a policyDir path resolves to a location under the
 * IronCurtain home directory or the package config directory. Prevents
 * loading attacker-controlled policy files from arbitrary filesystem locations.
 *
 * Thin wrapper around the shared validator in `config/validate-policy-dir.ts`
 * so failures surface as `SessionError` with our standard code — the
 * shared helper throws `PolicyDirValidationError`, which other callers
 * (e.g., the coordinator's `loadPolicy` RPC) surface in their own way.
 *
 * Returns the realpath-canonicalized path. Callers must use the return
 * value for all subsequent reads: feeding the original (possibly-symlinked)
 * path to downstream artifact loaders would reopen the symlink-swap TOCTOU
 * window the validator was introduced to close.
 *
 * @throws {SessionError} if the path escapes all trusted directories.
 */
function validatePolicyDir(policyDir: string): string {
  try {
    return sharedValidatePolicyDir(policyDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SessionError(message, 'SESSION_INIT_FAILED');
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
    | 'workflowInfrastructure'
    | 'workflowStateDir'
    | 'stateSlug'
    | 'agentConversationId'
    | 'workflowSkillsDir'
  > = {},
): SessionDirConfig {
  let { workspacePath, policyDir, systemPromptAugmentation } = opts;
  const { resumeSessionId, disableAutoApprove } = opts;
  let serverAllowlist: readonly string[] | undefined;
  let personaDef: PersonaDefinition | undefined = undefined;

  // Borrow mode is gated on `workflowInfrastructure`. The per-state dir
  // is only meaningful alongside the bundle; passing it alone is a bug.
  if (opts.workflowStateDir && !opts.workflowInfrastructure) {
    throw new SessionError(
      'workflowStateDir requires workflowInfrastructure; borrow-mode artifacts have no owner without a bundle',
      'SESSION_INIT_FAILED',
    );
  }

  // Resolve persona early -- derives policyDir, workspace, and server
  // filter from the persona definition. The persona system prompt
  // augmentation is deferred until after the memory gate is computed
  // with the full (persona + job) scope, so the augmentation and the
  // server bolt-on cannot disagree when both opts.persona and opts.jobId
  // are set.
  if (opts.persona) {
    const resolved = resolvePersona(opts.persona);
    personaDef = resolved.persona;
    if (policyDir) {
      logger.warn('Both persona and policyDir specified; using persona.');
    }
    policyDir = resolved.policyDir;
    serverAllowlist = resolved.persona.servers;

    // Use persona workspace unless an explicit workspacePath was provided
    if (!workspacePath) {
      workspacePath = resolved.workspacePath;
    }

    logger.info(`Persona "${opts.persona}" resolved: policyDir=${policyDir}`);
  }

  // Single gate computation with the full scope. Reused for the persona
  // augmentation, the cron-job memory prompt, and the server bolt-on so
  // the prompt cannot mention memory while the relay is gated off (or
  // vice versa). Skip the loadJob disk read when the global kill switch
  // would short-circuit anyway.
  const memoryConfig = config.userConfig.memory;
  const jobDef = memoryConfig.enabled && opts.jobId ? loadJob(createJobId(opts.jobId)) : undefined;
  const memoryEnabled = isMemoryEnabledFor({
    persona: personaDef,
    job: jobDef,
    userConfig: config.userConfig,
  });

  if (personaDef) {
    const personaAugmentation = buildPersonaSystemPromptAugmentation(personaDef, memoryEnabled);
    systemPromptAugmentation = systemPromptAugmentation
      ? `${personaAugmentation}\n\n${systemPromptAugmentation}`
      : personaAugmentation;
  }

  if (policyDir) {
    // Use the validator's realpath-canonicalized return value. Passing
    // the original (possibly-symlinked) path through to `generatedDir`
    // would reopen the symlink-swap TOCTOU window the validator was
    // introduced to close: downstream artifact reads (compiled policy,
    // dynamic lists) must happen against the same canonical path the
    // containment check approved.
    policyDir = validatePolicyDir(policyDir);
  }

  // Paths differ by mode:
  // - Borrow mode: per-state artifacts go under `workflowStateDir` when
  //   the orchestrator supplied one; otherwise fall back to the bundle's
  //   bundleDir (legacy path, still used by factory-level tests). The
  //   bundle owns workspace/escalation/audit on `workflowInfrastructure`.
  // - Standalone/CLI: everything lives under `{home}/sessions/{id}/`.
  const borrowInfra = opts.workflowInfrastructure;
  const artifactDir = borrowInfra ? (opts.workflowStateDir ?? borrowInfra.bundleDir) : undefined;
  const sessionDir = artifactDir ?? getSessionDir(effectiveSessionId);
  const sandboxDir = workspacePath ?? getSessionSandboxDir(effectiveSessionId);
  const escalationDir = borrowInfra ? borrowInfra.escalationDir : getSessionEscalationDir(effectiveSessionId);
  const auditLogPath = borrowInfra ? borrowInfra.auditLogPath : getSessionAuditLogPath(effectiveSessionId);

  // Standalone mode creates its own session tree. Borrow mode relies on
  // directories the orchestrator and bundle already own.
  if (!borrowInfra) {
    if (!opts.workspacePath) {
      mkdirSync(sandboxDir, { recursive: true });
    }
    mkdirSync(escalationDir, { recursive: true });
  }

  const sessionLogPath = artifactDir
    ? resolve(artifactDir, SESSION_LOG_FILENAME)
    : getSessionLogPath(effectiveSessionId);
  // llm-interactions / auto-approve-llm still live under the standalone
  // session dir even in borrow mode (per-turn LLM logs are not scoped to
  // the workflow state artifact dir; config.llmLogPath is only read when
  // the builtin agent is active, and borrow-mode sessions are Docker).
  const llmLogPath = getSessionLlmLogPath(effectiveSessionId);
  const autoApproveLlmLogPath = getSessionAutoApproveLlmLogPath(effectiveSessionId);

  // Set up session logging -- captures all console output to file.
  // In borrow mode, setup() retargets the singleton to the new state's
  // log file; a prior state's teardown in session.close() releases the
  // console hijack first.
  logger.setup({ logFilePath: sessionLogPath });
  logger.info(`Session ${sessionId} created${opts.stateSlug ? ` (state=${opts.stateSlug})` : ''}`);
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

  const { compiledPolicy: policyForFilter } = loadGeneratedPolicy({
    policyDir: sessionConfig.generatedDir,
    toolAnnotationsDir: sessionConfig.toolAnnotationsDir ?? sessionConfig.generatedDir,
    fallbackDir: getPackageGeneratedDir(),
  });
  sessionConfig.mcpServers = filterMcpServersByPolicy(
    sessionConfig.mcpServers,
    extractRequiredServers(policyForFilter),
  );

  // Inject the memory MCP server for persona and cron job sessions only.
  // Default (ad-hoc) sessions are stateless and don't benefit from memory.
  // The gate decision was made once above; reuse it here so the prompt
  // and the relay cannot diverge.
  if (memoryEnabled) {
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
  applyAllowedDirectoryToMcpArgs(sessionConfig.mcpServers, sandboxDir);

  // Persist session settings so --resume can restore them.
  // Only write on initial creation (not when resuming).
  if (!resumeSessionId) {
    const metadata = {
      createdAt: new Date().toISOString(),
      ...(opts.persona ? { persona: opts.persona } : {}),
      ...(opts.workspacePath ? { workspacePath: opts.workspacePath } : {}),
      // Only store policyDir when no persona is set (persona derives its own)
      ...(!opts.persona && policyDir ? { policyDir } : {}),
      ...(opts.disableAutoApprove ? { disableAutoApprove: true } : {}),
      // Persist the agent-CLI conversation id so `ironcurtain --resume`
      // can continue the same Claude conversation rather than starting
      // fresh. Docker-mode sessions only; builtin has no agent CLI.
      ...(opts.agentConversationId ? { agentConversationId: opts.agentConversationId } : {}),
    };
    if (artifactDir) {
      saveSessionMetadataTo(resolve(artifactDir, SESSION_METADATA_FILENAME), metadata);
    } else {
      saveSessionMetadata(effectiveSessionId, metadata);
    }
  }

  // Borrow-mode: re-stage the bundle in-place so per-state persona skills
  // become visible without remounting. Standalone mode returns the set
  // through SessionDirConfig for the docker factory to stage at bundle
  // creation.
  const resolvedSkills = resolveSkillsForSession({
    ...(opts.persona ? { personaName: opts.persona } : {}),
    ...(opts.workflowSkillsDir ? { workflowSkillsDir: opts.workflowSkillsDir } : {}),
  });
  if (borrowInfra) {
    borrowInfra.restageSkills(resolvedSkills);
  }

  return {
    config: sessionConfig,
    sessionDir,
    sandboxDir,
    escalationDir,
    auditLogPath,
    systemPromptAugmentation,
    memoryEnabled,
    resolvedSkills: borrowInfra ? [] : resolvedSkills,
  };
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
export { SessionError, SessionNotReadyError, SessionClosedError, BudgetExhaustedError } from '../types/errors.js';
export { resolveSessionMode, PreflightError } from './preflight.js';
export type { PreflightResult, PreflightOptions } from './preflight.js';
