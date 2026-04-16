/**
 * DockerAgentSession -- Session implementation that runs an external
 * agent inside a Docker container.
 *
 * The agent communicates with IronCurtain's MCP proxy server via a
 * Unix domain socket. The proxy enforces the same policy rules as
 * the built-in agent session.
 *
 * Lifecycle:
 * 1. initialize() -- start proxies, generate orientation, create & start container
 * 2. sendMessage() -- docker exec agent command, wait for exit, collect output
 * 3. close() -- stop container, stop proxies, clean up
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { quote } from 'shell-quote';
import type {
  Session,
  SessionId,
  SessionInfo,
  SessionStatus,
  ConversationTurn,
  DiagnosticEvent,
  EscalationRequest,
  BudgetStatus,
} from '../session/types.js';
import type { IronCurtainConfig } from '../config/types.js';
import { CONTAINER_WORKSPACE_DIR, type AgentAdapter, type ConversationStateConfig } from './agent-adapter.js';
import type { DockerManager } from './types.js';
import type { DockerProxy } from './code-mode-proxy.js';
import type { MitmProxy } from './mitm-proxy.js';
import type { CertificateAuthority } from './ca.js';
import { AuditLogTailer } from './audit-log-tailer.js';
import { ensureImage } from './docker-infrastructure.js';
import { prepareSession } from './orientation.js';
import { getInternalNetworkName } from './platform.js';
import { cleanupContainers } from './container-lifecycle.js';
import { SessionNotReadyError, SessionClosedError } from '../session/errors.js';
import { createEscalationWatcher, atomicWriteJsonSync } from '../escalation/escalation-watcher.js';
import type { EscalationWatcher } from '../escalation/escalation-watcher.js';
import * as logger from '../logger.js';
import { DEFAULT_EXEC_TIMEOUT_MS } from './docker-manager.js';

export interface DockerAgentSessionDeps {
  readonly config: IronCurtainConfig;
  readonly sessionId: SessionId;
  readonly adapter: AgentAdapter;
  readonly docker: DockerManager;
  readonly proxy: DockerProxy;
  readonly mitmProxy: MitmProxy;
  readonly ca: CertificateAuthority;
  readonly fakeKeys: ReadonlyMap<string, string>;
  readonly sessionDir: string;
  readonly sandboxDir: string;
  readonly escalationDir: string;
  readonly auditLogPath: string;
  /** Use TCP transport instead of UDS (macOS Docker Desktop). */
  readonly useTcp?: boolean;
  /** Host-side conversation state directory for session resume. */
  readonly conversationStateDir?: string;
  /** Conversation state config from the adapter (mount path, resume flags). */
  readonly conversationStateConfig?: ConversationStateConfig;
  /** Qualified model ID ("provider:model-name") to use for this session's turns, overriding the adapter default. */
  readonly agentModelOverride?: string;
  readonly onEscalation?: (request: EscalationRequest) => void;
  readonly onEscalationExpired?: () => void;
  readonly onEscalationResolved?: (escalationId: string, decision: 'approved' | 'denied') => void;
  readonly onDiagnostic?: (event: DiagnosticEvent) => void;
  /**
   * When set, proxies are already started, orientation is built, and
   * the image name is resolved. initialize() skips those steps and
   * proceeds directly to container creation + watchers.
   */
  readonly preBuiltInfrastructure?: {
    readonly systemPrompt: string;
    readonly image: string;
    readonly mitmAddr: { socketPath?: string; port?: number };
  };
}

export class DockerAgentSession implements Session {
  private readonly sessionId: SessionId;
  private readonly config: IronCurtainConfig;
  private readonly adapter: AgentAdapter;
  private readonly docker: DockerManager;
  private readonly proxy: DockerProxy;
  private readonly mitmProxy: MitmProxy;
  private readonly ca: CertificateAuthority;
  private readonly fakeKeys: ReadonlyMap<string, string>;
  private readonly sessionDir: string;
  private readonly sandboxDir: string;
  private readonly escalationDir: string;
  private readonly auditLogPath: string;
  private readonly useTcp: boolean;
  private readonly conversationStateDir?: string;
  private readonly conversationStateConfig?: ConversationStateConfig;
  private readonly agentModelOverride?: string;

  private status: SessionStatus = 'initializing';
  private readonly createdAt: string;

  private containerId: string | null = null;
  private sidecarContainerId: string | null = null;
  private networkName: string | null = null;
  private systemPrompt = '';

  private turns: ConversationTurn[] = [];
  private diagnosticLog: DiagnosticEvent[] = [];
  private escalationWatcher: EscalationWatcher | null = null;

  private auditTailer: AuditLogTailer | null = null;
  private cumulativeActiveMs = 0;
  private cumulativeCostUsd = 0;

  private readonly onEscalation?: (request: EscalationRequest) => void;
  private readonly onEscalationExpired?: () => void;
  private readonly onEscalationResolved?: (escalationId: string, decision: 'approved' | 'denied') => void;
  private readonly onDiagnostic?: (event: DiagnosticEvent) => void;
  private readonly preBuiltInfrastructure?: DockerAgentSessionDeps['preBuiltInfrastructure'];

  constructor(deps: DockerAgentSessionDeps) {
    this.sessionId = deps.sessionId;
    this.config = deps.config;
    this.adapter = deps.adapter;
    this.docker = deps.docker;
    this.proxy = deps.proxy;
    this.mitmProxy = deps.mitmProxy;
    this.ca = deps.ca;
    this.fakeKeys = deps.fakeKeys;
    this.sessionDir = deps.sessionDir;
    this.sandboxDir = deps.sandboxDir;
    this.escalationDir = deps.escalationDir;
    this.auditLogPath = deps.auditLogPath;
    this.useTcp = deps.useTcp ?? false;
    this.conversationStateDir = deps.conversationStateDir;
    this.conversationStateConfig = deps.conversationStateConfig;
    this.agentModelOverride = deps.agentModelOverride;
    this.onEscalation = deps.onEscalation;
    this.onEscalationExpired = deps.onEscalationExpired;
    this.onEscalationResolved = deps.onEscalationResolved;
    this.onDiagnostic = deps.onDiagnostic;
    this.preBuiltInfrastructure = deps.preBuiltInfrastructure;
    this.createdAt = new Date().toISOString();
  }

  /**
   * Initialize the Docker agent session:
   * 1. Start Code Mode proxy (UDS/TCP)
   * 2. Start MITM proxy (UDS/TCP)
   * 3. Build server listings from sandbox help data
   * 4. Generate orientation files
   * 5. Ensure Docker image exists (with CA cert baked in)
   * 6. Create and start container (--network=none)
   * 7. Start escalation watcher and audit log tailer
   */
  async initialize(): Promise<void> {
    // Ensure directories exist
    mkdirSync(this.sandboxDir, { recursive: true });
    mkdirSync(this.escalationDir, { recursive: true });

    let mitmAddr: { socketPath?: string; port?: number };
    let image: string;

    if (this.preBuiltInfrastructure) {
      // Infrastructure already prepared by prepareDockerInfrastructure() --
      // proxies are started, orientation is built, image name is resolved.
      this.systemPrompt = this.preBuiltInfrastructure.systemPrompt;
      image = this.preBuiltInfrastructure.image;
      mitmAddr = this.preBuiltInfrastructure.mitmAddr;
    } else {
      // Legacy path: start everything from scratch.
      // 1. Start Code Mode proxy
      await this.proxy.start();
      if (this.useTcp && this.proxy.port !== undefined) {
        logger.info(`Code Mode proxy listening on 127.0.0.1:${this.proxy.port}`);
      } else {
        logger.info(`Code Mode proxy listening on ${this.proxy.socketPath}`);
      }

      // 2. Start MITM proxy
      mitmAddr = await this.mitmProxy.start();
      if (mitmAddr.port !== undefined) {
        logger.info(`MITM proxy listening on 127.0.0.1:${mitmAddr.port}`);
      } else {
        logger.info(`MITM proxy listening on ${mitmAddr.socketPath}`);
      }

      // 3. Build server listings from sandbox help data
      const helpData = this.proxy.getHelpData();
      const serverListings = Object.entries(helpData.serverDescriptions).map(([name, description]) => ({
        name,
        description,
      }));
      logger.info(`Available servers: ${serverListings.map((s) => s.name).join(', ')}`);

      // 4. Generate orientation
      // In TCP mode, the container reaches the MCP proxy via host.docker.internal
      const proxyAddress =
        this.useTcp && this.proxy.port !== undefined ? `host.docker.internal:${this.proxy.port}` : undefined;
      const { systemPrompt } = prepareSession(
        this.adapter,
        serverListings,
        this.sessionDir,
        this.config,
        this.sandboxDir,
        proxyAddress,
      );
      this.systemPrompt = systemPrompt;

      // 5. Ensure Docker image exists (build if needed, with CA cert)
      image = await this.adapter.getImage();
      await ensureImage(image, this.docker, this.ca);
    }

    // Write the effective system prompt for debugging
    writeFileSync(resolve(this.sessionDir, 'system-prompt.txt'), this.systemPrompt);

    // 6. Create and start container
    const shortId = this.sessionId.substring(0, 12);
    const orientationDir = resolve(this.sessionDir, 'orientation');

    let env: Record<string, string>;
    let network: string | null;
    let mounts: { source: string; target: string; readonly: boolean }[];

    let extraHosts: string[] | undefined;
    const mainContainerName = `ironcurtain-${shortId}`;

    // Remove stale main container from a crashed previous session (same session
    // ID means same deterministic name, which would conflict on docker create).
    // Done before the TCP/UDS branch since the main container name is
    // deterministic in both modes.
    await this.docker.removeStaleContainer(mainContainerName);

    if (this.useTcp && mitmAddr.port !== undefined && this.proxy.port !== undefined) {
      // macOS TCP mode: internal bridge network blocks egress.
      // A socat sidecar bridges the internal network to the host
      // because Docker Desktop VMs don't forward gateway traffic.
      const mcpPort = this.proxy.port;
      const mitmPort = mitmAddr.port;

      const proxyUrl = `http://host.docker.internal:${mitmPort}`;
      env = {
        ...this.adapter.buildEnv(this.config, this.fakeKeys),
        HTTPS_PROXY: proxyUrl,
        HTTP_PROXY: proxyUrl,
      };

      // Write apt proxy config so sudo apt-get routes through the MITM proxy
      const aptProxyPath = resolve(orientationDir, 'apt-proxy.conf');
      writeFileSync(aptProxyPath, `Acquire::http::Proxy "${proxyUrl}";\nAcquire::https::Proxy "${proxyUrl}";\n`);

      // Create a per-session --internal Docker network that blocks internet egress.
      // Assign to this.networkName immediately so the catch block can clean it up
      // if any subsequent step (sidecar setup, container creation) fails.
      const internalNetworkName = getInternalNetworkName(shortId);
      await this.docker.createNetwork(internalNetworkName, {
        internal: true,
      });
      this.networkName = internalNetworkName;
      network = internalNetworkName;

      // Ensure the socat image is available
      const socatImage = 'alpine/socat';
      if (!(await this.docker.imageExists(socatImage))) {
        logger.info(`Pulling ${socatImage}...`);
        await this.docker.pullImage(socatImage);
      }

      // Create socat sidecar on the default bridge (can reach host.docker.internal)
      const sidecarName = `ironcurtain-sidecar-${shortId}`;

      // Remove stale sidecar from a crashed previous session (TCP mode only).
      await this.docker.removeStaleContainer(sidecarName);

      this.sidecarContainerId = await this.docker.create({
        image: socatImage,
        name: sidecarName,
        network: 'bridge',
        mounts: [],
        env: {},
        entrypoint: '/bin/sh',
        sessionLabel: this.sessionId,
        command: [
          '-c',
          quote(['socat', `TCP-LISTEN:${mcpPort},fork,reuseaddr`, `TCP:host.docker.internal:${mcpPort}`]) +
            ' & ' +
            quote(['socat', `TCP-LISTEN:${mitmPort},fork,reuseaddr`, `TCP:host.docker.internal:${mitmPort}`]) +
            ' & wait',
        ],
      });
      await this.docker.start(this.sidecarContainerId);

      // Connect sidecar to the internal network so the app container can reach it
      await this.docker.connectNetwork(internalNetworkName, this.sidecarContainerId);
      const sidecarIp = await this.docker.getContainerIp(this.sidecarContainerId, internalNetworkName);
      extraHosts = [`host.docker.internal:${sidecarIp}`];
      logger.info(`Sidecar ${sidecarName} bridging ports ${mcpPort},${mitmPort} at ${sidecarIp}`);

      mounts = [
        { source: this.sandboxDir, target: CONTAINER_WORKSPACE_DIR, readonly: false },
        // No session dir mount needed for sockets (TCP mode) -- only orientation subdir is mounted
        { source: orientationDir, target: '/etc/ironcurtain', readonly: true },
        { source: aptProxyPath, target: '/etc/apt/apt.conf.d/90-ironcurtain-proxy', readonly: true },
      ];

      // Mount conversation state directory for session resume (e.g., claude --continue)
      if (this.conversationStateDir && this.conversationStateConfig) {
        mounts.push({
          source: this.conversationStateDir,
          target: this.conversationStateConfig.containerMountPath,
          readonly: false,
        });
      }
    } else {
      // Linux UDS mode: --network=none, session dir with sockets mounted
      const linuxProxyUrl = 'http://127.0.0.1:18080';
      env = {
        ...this.adapter.buildEnv(this.config, this.fakeKeys),
        HTTPS_PROXY: linuxProxyUrl,
        HTTP_PROXY: linuxProxyUrl,
      };
      network = null;

      // Write apt proxy config so sudo apt-get routes through the MITM proxy
      const aptProxyPathLinux = resolve(orientationDir, 'apt-proxy.conf');
      writeFileSync(
        aptProxyPathLinux,
        `Acquire::http::Proxy "${linuxProxyUrl}";\nAcquire::https::Proxy "${linuxProxyUrl}";\n`,
      );

      // Mount only the sockets subdirectory into the container -- not the full
      // session dir. This prevents the container from accessing escalation files,
      // audit logs, or other session data. proxy.sock and mitm-proxy.sock are
      // created in this directory by the host-side proxy setup.
      const socketsDir = resolve(this.sessionDir, 'sockets');
      mkdirSync(socketsDir, { recursive: true });
      mounts = [
        { source: this.sandboxDir, target: CONTAINER_WORKSPACE_DIR, readonly: false },
        { source: socketsDir, target: '/run/ironcurtain', readonly: false },
        { source: orientationDir, target: '/etc/ironcurtain', readonly: true },
        { source: aptProxyPathLinux, target: '/etc/apt/apt.conf.d/90-ironcurtain-proxy', readonly: true },
      ];

      // Mount conversation state directory for session resume (e.g., claude --continue)
      if (this.conversationStateDir && this.conversationStateConfig) {
        mounts.push({
          source: this.conversationStateDir,
          target: this.conversationStateConfig.containerMountPath,
          readonly: false,
        });
      }
    }

    try {
      this.containerId = await this.docker.create({
        image,
        name: mainContainerName,
        network: network ?? 'none',
        mounts,
        env,
        command: ['sleep', 'infinity'],
        sessionLabel: this.sessionId,
        resources: { memoryMb: 8192, cpus: 4 },
        extraHosts,
        capAdd: [
          'SETUID', // sudo setuid
          'SETGID', // sudo setgid
          'CHOWN', // apt-get chown on installed files
          'FOWNER', // apt-get set permissions on files it doesn't own
          'DAC_OVERRIDE', // apt-get read/write files regardless of permissions during install
          'AUDIT_WRITE', // sudo audit logging
        ],
      });

      await this.docker.start(this.containerId);
      logger.info(`Container started: ${this.containerId.substring(0, 12)}`);

      // Connectivity check: verify the container can reach host proxies
      // through the internal network. Abort if unreachable.
      if (this.useTcp && this.networkName !== null && this.proxy.port !== undefined) {
        await this.checkInternalNetworkConnectivity(this.containerId, this.proxy.port);
      }
    } catch (err) {
      // Clean up sidecar and per-session network if setup fails
      if (this.sidecarContainerId) {
        await this.docker.stop(this.sidecarContainerId).catch(() => {});
        await this.docker.remove(this.sidecarContainerId).catch(() => {});
        this.sidecarContainerId = null;
      }
      if (this.networkName !== null) {
        await this.docker.removeNetwork(this.networkName).catch(() => {});
        this.networkName = null;
      }
      throw err;
    }

    // 7. Start watchers
    this.escalationWatcher = createEscalationWatcher(this.escalationDir, {
      onEscalation: (request) => this.onEscalation?.(request),
      onEscalationExpired: () => this.onEscalationExpired?.(),
      onEscalationResolved: (id, decision) => this.onEscalationResolved?.(id, decision),
    });
    this.escalationWatcher.start();

    // Create the audit log file so fs.watch() can attach to it.
    // The proxy process appends entries; we create the empty file upfront.
    if (!existsSync(this.auditLogPath)) {
      writeFileSync(this.auditLogPath, '');
    }
    this.auditTailer = new AuditLogTailer(this.auditLogPath, (event) => this.emitDiagnostic(event));
    this.auditTailer.start();

    this.status = 'ready';
  }

  getInfo(): SessionInfo {
    return {
      id: this.sessionId,
      status: this.status,
      turnCount: this.turns.length,
      createdAt: this.createdAt,
    };
  }

  async sendMessage(userMessage: string): Promise<string> {
    if (this.status === 'closed') throw new SessionClosedError();
    if (this.status !== 'ready') throw new SessionNotReadyError(this.status);
    if (!this.containerId) throw new Error('Container not initialized');

    this.status = 'processing';

    // Per-turn wall-clock timeout (matches builtin session semantics:
    // maxSessionSeconds is a per-turn limit, idle time doesn't count).
    // When not configured, docker.exec applies its own default timeout
    // (currently 10 minutes) to prevent runaway processes.
    const maxSeconds = this.config.userConfig.resourceBudget.maxSessionSeconds;
    const execTimeout = maxSeconds != null ? maxSeconds * 1000 : undefined;

    const turnStartMs = Date.now();
    const turnStart = new Date(turnStartMs).toISOString();

    // Write user context for the auto-approver
    this.writeUserContext(userMessage);

    const command = this.adapter.buildCommand(userMessage, this.systemPrompt, this.agentModelOverride);
    logger.info(`[docker-agent] exec: ${formatCommand(command)}`);

    const execStartMs = Date.now();
    const { exitCode, stdout, stderr } = await this.docker.exec(this.containerId, command, execTimeout);
    const execDurationMs = Date.now() - execStartMs;
    const timeoutLabel = execTimeout != null ? `${execTimeout}ms` : `${DEFAULT_EXEC_TIMEOUT_MS}ms (default)`;
    logger.info(
      `[docker-agent] exit=${exitCode} stdout=${stdout.length}B stderr=${stderr.length}B ` +
        `duration=${execDurationMs}ms timeout=${timeoutLabel}`,
    );
    if (exitCode !== 0) {
      logger.warn(`[docker-agent] non-zero exit code ${exitCode} after ${execDurationMs}ms`);
    }

    if (stderr) {
      logger.info(`[docker-agent] stderr: ${stderr.substring(0, 500)}`);
    }

    this.cumulativeActiveMs += Date.now() - turnStartMs;

    const response = this.adapter.extractResponse(exitCode, stdout);

    if (response.costUsd !== undefined) {
      this.cumulativeCostUsd = response.costUsd;
    }

    const turn: ConversationTurn = {
      turnNumber: this.turns.length + 1,
      userMessage,
      assistantResponse: response.text,
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      timestamp: turnStart,
    };
    this.turns.push(turn);

    this.status = 'ready';
    return response.text;
  }

  getHistory(): readonly ConversationTurn[] {
    return this.turns;
  }

  getDiagnosticLog(): readonly DiagnosticEvent[] {
    return this.diagnosticLog;
  }

  /** Process any new audit log entries immediately (useful for tests). */
  flushAuditLog(): void {
    this.auditTailer?.readNewEntries();
  }

  getPendingEscalation(): EscalationRequest | undefined {
    return this.escalationWatcher?.getPending();
  }

  getBudgetStatus(): BudgetStatus {
    const elapsedSeconds = this.cumulativeActiveMs / 1000;

    return {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      stepCount: this.turns.length,
      elapsedSeconds,
      estimatedCostUsd: this.cumulativeCostUsd,
      limits: this.config.userConfig.resourceBudget,
      cumulative: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
        stepCount: this.turns.length,
        activeSeconds: elapsedSeconds,
        estimatedCostUsd: this.cumulativeCostUsd,
      },
      tokenTrackingAvailable: false,
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- must be async to satisfy Session interface
  async resolveEscalation(
    escalationId: string,
    decision: 'approved' | 'denied',
    options?: { whitelistSelection?: number },
  ): Promise<void> {
    if (!this.escalationWatcher) {
      throw new Error(`No pending escalation with ID: ${escalationId}`);
    }
    this.escalationWatcher.resolve(escalationId, decision, options);
  }

  async close(): Promise<void> {
    if (this.status === 'closed') return;
    this.status = 'closed';

    this.escalationWatcher?.stop();
    this.auditTailer?.stop();

    await cleanupContainers(this.docker, {
      containerId: this.containerId,
      sidecarContainerId: this.sidecarContainerId,
      networkName: this.networkName,
    });

    // Stop proxies
    await this.mitmProxy.stop();
    await this.proxy.stop();
  }

  // --- Private helpers ---

  private emitDiagnostic(event: DiagnosticEvent): void {
    this.diagnosticLog.push(event);
    this.onDiagnostic?.(event);
  }

  /**
   * Checks whether the container can reach host-side proxies via the
   * socat sidecar on the internal Docker network. Throws if connectivity fails.
   */
  private async checkInternalNetworkConnectivity(containerId: string, mcpPort: number): Promise<void> {
    const result = await this.docker.exec(
      containerId,
      ['socat', '-u', '/dev/null', `TCP:host.docker.internal:${mcpPort},connect-timeout=5`],
      // Allow a small buffer above socat's 5s connect-timeout for docker exec/process startup overhead.
      6_000,
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `Internal network connectivity check failed (exit=${result.exitCode}). ` +
          `The container cannot reach host-side proxies via the socat sidecar on the --internal Docker network. ` +
          `Check that the sidecar container is running and connected to the internal network.`,
      );
    }
  }

  private writeUserContext(userMessage: string): void {
    try {
      const contextPath = resolve(this.escalationDir, 'user-context.json');
      atomicWriteJsonSync(contextPath, { userMessage });
    } catch {
      // Ignore write failures
    }
  }
}

/** Formats a command array for logging, truncating long arguments. */
function formatCommand(args: readonly string[]): string {
  const MAX_ARG_LEN = 80;
  return args
    .map((a) => {
      const display = a.length > MAX_ARG_LEN ? `${a.substring(0, MAX_ARG_LEN)}...` : a;
      return a.includes(' ') ? `"${display}"` : display;
    })
    .join(' ');
}
