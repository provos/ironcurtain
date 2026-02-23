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

import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import type { AgentAdapter } from './agent-adapter.js';
import type { DockerManager } from './types.js';
import type { ManagedProxy } from './managed-proxy.js';
import type { ConnectProxy } from './connect-proxy.js';
import { AuditLogTailer } from './audit-log-tailer.js';
import { prepareSession } from './orientation.js';
import { SessionNotReadyError, SessionClosedError } from '../session/errors.js';
import * as logger from '../logger.js';

const ESCALATION_POLL_INTERVAL_MS = 300;

export interface DockerAgentSessionDeps {
  readonly config: IronCurtainConfig;
  readonly sessionId: SessionId;
  readonly adapter: AgentAdapter;
  readonly docker: DockerManager;
  readonly proxy: ManagedProxy;
  readonly connectProxy: ConnectProxy;
  readonly sessionDir: string;
  readonly sandboxDir: string;
  readonly escalationDir: string;
  readonly auditLogPath: string;
  readonly onEscalation?: (request: EscalationRequest) => void;
  readonly onEscalationExpired?: () => void;
  readonly onDiagnostic?: (event: DiagnosticEvent) => void;
}

export class DockerAgentSession implements Session {
  private readonly sessionId: SessionId;
  private readonly config: IronCurtainConfig;
  private readonly adapter: AgentAdapter;
  private readonly docker: DockerManager;
  private readonly proxy: ManagedProxy;
  private readonly connectProxy: ConnectProxy;
  private readonly sessionDir: string;
  private readonly sandboxDir: string;
  private readonly escalationDir: string;
  private readonly auditLogPath: string;

  private status: SessionStatus = 'initializing';
  private readonly createdAt: string;

  private containerId: string | null = null;
  private systemPrompt = '';

  private turns: ConversationTurn[] = [];
  private diagnosticLog: DiagnosticEvent[] = [];
  private pendingEscalation: EscalationRequest | undefined;
  private seenEscalationIds = new Set<string>();
  private escalationPollInterval: ReturnType<typeof setInterval> | null = null;

  private auditTailer: AuditLogTailer | null = null;
  private sessionStartMs: number | null = null;

  private readonly onEscalation?: (request: EscalationRequest) => void;
  private readonly onEscalationExpired?: () => void;
  private readonly onDiagnostic?: (event: DiagnosticEvent) => void;

  constructor(deps: DockerAgentSessionDeps) {
    this.sessionId = deps.sessionId;
    this.config = deps.config;
    this.adapter = deps.adapter;
    this.docker = deps.docker;
    this.proxy = deps.proxy;
    this.connectProxy = deps.connectProxy;
    this.sessionDir = deps.sessionDir;
    this.sandboxDir = deps.sandboxDir;
    this.escalationDir = deps.escalationDir;
    this.auditLogPath = deps.auditLogPath;
    this.onEscalation = deps.onEscalation;
    this.onEscalationExpired = deps.onEscalationExpired;
    this.onDiagnostic = deps.onDiagnostic;
    this.createdAt = new Date().toISOString();
  }

  /**
   * Initialize the Docker agent session:
   * 1. Start MCP proxy (UDS)
   * 2. Start CONNECT proxy (UDS)
   * 3. Query proxy for available tools
   * 4. Generate orientation files
   * 5. Ensure Docker image exists
   * 6. Create and start container (--network=none)
   * 7. Start escalation watcher and audit log tailer
   */
  async initialize(): Promise<void> {
    // Ensure directories exist
    mkdirSync(this.sandboxDir, { recursive: true });
    mkdirSync(this.escalationDir, { recursive: true });

    // 1. Start MCP proxy
    await this.proxy.start();
    logger.info(`MCP proxy listening on ${this.proxy.socketPath}`);

    // 2. Start CONNECT proxy (UDS)
    const connectAddr = await this.connectProxy.start();
    logger.info(`CONNECT proxy listening on ${connectAddr.socketPath}`);

    // 3. Query proxy for available tools
    const tools = await this.proxy.listTools();
    logger.info(`Available tools: ${tools.map((t) => t.name).join(', ')}`);

    // 4. Generate orientation
    const { systemPrompt } = prepareSession(this.adapter, tools, this.sessionDir, this.config, this.sandboxDir);
    this.systemPrompt = systemPrompt;

    // 5. Ensure Docker image exists (build if needed)
    const image = await this.adapter.getImage();
    await this.ensureImage(image);

    // 6. Create and start container (--network=none + UDS for CONNECT proxy)
    const shortId = this.sessionId.substring(0, 12);

    const env = {
      ...this.adapter.buildEnv(this.config),
      HTTPS_PROXY: 'http://127.0.0.1:18080',
      HTTP_PROXY: 'http://127.0.0.1:18080',
    };

    const orientationDir = resolve(this.sessionDir, 'orientation');
    this.containerId = await this.docker.create({
      image,
      name: `ironcurtain-${shortId}`,
      network: 'none',
      mounts: [
        { source: this.sandboxDir, target: '/workspace', readonly: false },
        { source: this.sessionDir, target: '/run/ironcurtain', readonly: false },
        { source: orientationDir, target: '/etc/ironcurtain', readonly: true },
        { source: connectAddr.socketPath, target: '/run/ironcurtain/connect-proxy.sock', readonly: true },
      ],
      env,
      command: ['sleep', 'infinity'],
      sessionLabel: this.sessionId,
      resources: { memoryMb: 4096, cpus: 2 },
    });

    await this.docker.start(this.containerId);
    logger.info(`Container started: ${this.containerId.substring(0, 12)}`);

    // 7. Start watchers
    this.startEscalationWatcher();

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
    if (!this.sessionStartMs) this.sessionStartMs = Date.now();

    const turnStart = new Date().toISOString();

    // Write user context for the auto-approver
    this.writeUserContext(userMessage);

    const command = this.adapter.buildCommand(userMessage, this.systemPrompt);
    logger.info(`[docker-agent] exec: ${formatCommand(command)}`);

    const { exitCode, stdout, stderr } = await this.docker.exec(this.containerId, command);
    logger.info(`[docker-agent] exit=${exitCode} stdout=${stdout.length}B stderr=${stderr.length}B`);

    if (stderr) {
      logger.info(`[docker-agent] stderr: ${stderr.substring(0, 500)}`);
    }

    const response = this.adapter.extractResponse(exitCode, stdout);

    const turn: ConversationTurn = {
      turnNumber: this.turns.length + 1,
      userMessage,
      assistantResponse: response,
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
    return response;
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

  getBudgetStatus(): BudgetStatus {
    const elapsedSeconds = this.sessionStartMs ? (Date.now() - this.sessionStartMs) / 1000 : 0;

    return {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      stepCount: this.turns.length,
      elapsedSeconds,
      estimatedCostUsd: 0,
      limits: this.config.userConfig.resourceBudget,
      cumulative: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
        stepCount: this.turns.length,
        activeSeconds: elapsedSeconds,
        estimatedCostUsd: 0,
      },
      tokenTrackingAvailable: false,
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- must be async to satisfy Session interface
  async resolveEscalation(escalationId: string, decision: 'approved' | 'denied'): Promise<void> {
    if (!this.pendingEscalation || this.pendingEscalation.escalationId !== escalationId) {
      throw new Error(`No pending escalation with ID: ${escalationId}`);
    }

    const responsePath = resolve(this.escalationDir, `response-${escalationId}.json`);
    writeFileSync(responsePath, JSON.stringify({ decision }));
    this.pendingEscalation = undefined;
  }

  async close(): Promise<void> {
    if (this.status === 'closed') return;
    this.status = 'closed';

    this.stopEscalationWatcher();
    this.auditTailer?.stop();

    // Stop and remove container
    if (this.containerId) {
      await this.docker.stop(this.containerId);
      await this.docker.remove(this.containerId);
    }

    // Stop proxies
    await this.connectProxy.stop();
    await this.proxy.stop();
  }

  // --- Private helpers ---

  private emitDiagnostic(event: DiagnosticEvent): void {
    this.diagnosticLog.push(event);
    this.onDiagnostic?.(event);
  }

  private startEscalationWatcher(): void {
    this.escalationPollInterval = setInterval(() => {
      this.pollEscalationDirectory();
    }, ESCALATION_POLL_INTERVAL_MS);
  }

  private stopEscalationWatcher(): void {
    if (this.escalationPollInterval) {
      clearInterval(this.escalationPollInterval);
      this.escalationPollInterval = null;
    }
  }

  private pollEscalationDirectory(): void {
    if (this.pendingEscalation) {
      this.checkEscalationExpiry();
      return;
    }

    try {
      const files = readdirSync(this.escalationDir);
      const requestFile = files.find(
        (f) =>
          f.startsWith('request-') && f.endsWith('.json') && !this.seenEscalationIds.has(this.extractEscalationId(f)),
      );
      if (!requestFile) return;

      const requestPath = resolve(this.escalationDir, requestFile);
      const request = JSON.parse(readFileSync(requestPath, 'utf-8')) as EscalationRequest;
      this.seenEscalationIds.add(request.escalationId);
      this.pendingEscalation = request;
      this.onEscalation?.(request);
    } catch {
      // Directory may not exist yet or be empty
    }
  }

  private checkEscalationExpiry(): void {
    if (!this.pendingEscalation) return;
    const escalationId = this.pendingEscalation.escalationId;
    const requestExists = existsSync(resolve(this.escalationDir, `request-${escalationId}.json`));
    const responseExists = existsSync(resolve(this.escalationDir, `response-${escalationId}.json`));
    if (!requestExists && !responseExists) {
      this.pendingEscalation = undefined;
      this.onEscalationExpired?.();
    }
  }

  private writeUserContext(userMessage: string): void {
    try {
      const contextPath = resolve(this.escalationDir, 'user-context.json');
      writeFileSync(contextPath, JSON.stringify({ userMessage }));
    } catch {
      // Ignore write failures
    }
  }

  private extractEscalationId(filename: string): string {
    return filename.replace(/^request-/, '').replace(/\.json$/, '');
  }

  /**
   * Ensures the Docker image exists, building it (and the base image) if needed.
   * Dockerfiles live in the `docker/` directory relative to the package root.
   */
  private async ensureImage(image: string): Promise<void> {
    if (await this.docker.imageExists(image)) return;

    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const dockerDir = resolve(packageRoot, 'docker');

    // Build base image first if it doesn't exist
    const baseImage = 'ironcurtain-base:latest';
    if (!(await this.docker.imageExists(baseImage))) {
      logger.info('Building base Docker image (this may take a while on first run)...');
      await this.docker.buildImage(baseImage, resolve(dockerDir, 'Dockerfile.base'), dockerDir);
      logger.info('Base Docker image built successfully');
    }

    // Build the agent-specific image
    // Image name format: ironcurtain-{agent}:latest -> Dockerfile.{agent}
    const agentName = image.replace('ironcurtain-', '').replace(':latest', '');
    const dockerfile = resolve(dockerDir, `Dockerfile.${agentName}`);
    if (!existsSync(dockerfile)) {
      throw new Error(`Dockerfile not found for agent "${agentName}": ${dockerfile}`);
    }

    logger.info(`Building Docker image ${image}...`);
    await this.docker.buildImage(image, dockerfile, dockerDir);
    logger.info(`Docker image ${image} built successfully`);
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
