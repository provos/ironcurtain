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

import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir, arch } from 'node:os';
import { quote } from 'shell-quote';
import { createHash } from 'node:crypto';
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
import type { MitmProxy } from './mitm-proxy.js';
import type { CertificateAuthority } from './ca.js';
import { AuditLogTailer } from './audit-log-tailer.js';
import { prepareSession } from './orientation.js';
import { INTERNAL_NETWORK_NAME, INTERNAL_NETWORK_SUBNET, INTERNAL_NETWORK_GATEWAY } from './platform.js';
import { SessionNotReadyError, SessionClosedError } from '../session/errors.js';
import * as logger from '../logger.js';

const ESCALATION_POLL_INTERVAL_MS = 300;

export interface DockerAgentSessionDeps {
  readonly config: IronCurtainConfig;
  readonly sessionId: SessionId;
  readonly adapter: AgentAdapter;
  readonly docker: DockerManager;
  readonly proxy: ManagedProxy;
  readonly mitmProxy: MitmProxy;
  readonly ca: CertificateAuthority;
  readonly fakeKeys: ReadonlyMap<string, string>;
  readonly sessionDir: string;
  readonly sandboxDir: string;
  readonly escalationDir: string;
  readonly auditLogPath: string;
  /** Use TCP transport instead of UDS (macOS Docker Desktop). */
  readonly useTcp?: boolean;
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
  private readonly mitmProxy: MitmProxy;
  private readonly ca: CertificateAuthority;
  private readonly fakeKeys: ReadonlyMap<string, string>;
  private readonly sessionDir: string;
  private readonly sandboxDir: string;
  private readonly escalationDir: string;
  private readonly auditLogPath: string;
  private readonly useTcp: boolean;

  private status: SessionStatus = 'initializing';
  private readonly createdAt: string;

  private containerId: string | null = null;
  private sidecarContainerId: string | null = null;
  private networkName: string | null = null;
  private systemPrompt = '';

  private turns: ConversationTurn[] = [];
  private diagnosticLog: DiagnosticEvent[] = [];
  private pendingEscalation: EscalationRequest | undefined;
  private seenEscalationIds = new Set<string>();
  private escalationPollInterval: ReturnType<typeof setInterval> | null = null;

  private auditTailer: AuditLogTailer | null = null;
  private cumulativeActiveMs = 0;
  private cumulativeCostUsd = 0;

  private readonly onEscalation?: (request: EscalationRequest) => void;
  private readonly onEscalationExpired?: () => void;
  private readonly onDiagnostic?: (event: DiagnosticEvent) => void;

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
    this.onEscalation = deps.onEscalation;
    this.onEscalationExpired = deps.onEscalationExpired;
    this.onDiagnostic = deps.onDiagnostic;
    this.createdAt = new Date().toISOString();
  }

  /**
   * Initialize the Docker agent session:
   * 1. Start MCP proxy (UDS)
   * 2. Start MITM proxy (UDS)
   * 3. Query proxy for available tools
   * 4. Generate orientation files
   * 5. Ensure Docker image exists (with CA cert baked in)
   * 6. Create and start container (--network=none)
   * 7. Start escalation watcher and audit log tailer
   */
  async initialize(): Promise<void> {
    // Ensure directories exist
    mkdirSync(this.sandboxDir, { recursive: true });
    mkdirSync(this.escalationDir, { recursive: true });

    // 1. Start MCP proxy
    await this.proxy.start();
    if (this.useTcp && this.proxy.port !== undefined) {
      logger.info(`MCP proxy listening on 127.0.0.1:${this.proxy.port}`);
    } else {
      logger.info(`MCP proxy listening on ${this.proxy.socketPath}`);
    }

    // 2. Start MITM proxy
    const mitmAddr = await this.mitmProxy.start();
    if (mitmAddr.port !== undefined) {
      logger.info(`MITM proxy listening on 127.0.0.1:${mitmAddr.port}`);
    } else {
      logger.info(`MITM proxy listening on ${mitmAddr.socketPath}`);
    }

    // 3. Query proxy for available tools
    const tools = await this.proxy.listTools();
    logger.info(`Available tools: ${tools.map((t) => t.name).join(', ')}`);

    // 4. Generate orientation
    // In TCP mode, the container reaches the MCP proxy via host.docker.internal
    const proxyAddress =
      this.useTcp && this.proxy.port !== undefined ? `host.docker.internal:${this.proxy.port}` : undefined;
    const { systemPrompt } = prepareSession(
      this.adapter,
      tools,
      this.sessionDir,
      this.config,
      this.sandboxDir,
      proxyAddress,
    );
    this.systemPrompt = systemPrompt;

    // 5. Ensure Docker image exists (build if needed, with CA cert)
    const image = await this.adapter.getImage();
    await this.ensureImage(image);

    // 6. Create and start container
    const shortId = this.sessionId.substring(0, 12);
    const orientationDir = resolve(this.sessionDir, 'orientation');

    let env: Record<string, string>;
    let network: string;
    let mounts: { source: string; target: string; readonly: boolean }[];

    let extraHosts: string[] | undefined;

    if (this.useTcp && mitmAddr.port !== undefined && this.proxy.port !== undefined) {
      // macOS TCP mode: internal bridge network blocks egress.
      // A socat sidecar bridges the internal network to the host
      // because Docker Desktop VMs don't forward gateway traffic.
      const mcpPort = this.proxy.port;
      const mitmPort = mitmAddr.port;

      env = {
        ...this.adapter.buildEnv(this.config, this.fakeKeys),
        HTTPS_PROXY: `http://host.docker.internal:${mitmPort}`,
        HTTP_PROXY: `http://host.docker.internal:${mitmPort}`,
      };

      // Create an --internal Docker network that blocks internet egress
      await this.docker.createNetwork(INTERNAL_NETWORK_NAME, {
        internal: true,
        subnet: INTERNAL_NETWORK_SUBNET,
        gateway: INTERNAL_NETWORK_GATEWAY,
      });
      network = INTERNAL_NETWORK_NAME;

      // Create socat sidecar on the default bridge (can reach host.docker.internal)
      const sidecarName = `ironcurtain-sidecar-${shortId}`;
      this.sidecarContainerId = await this.docker.create({
        image: 'alpine/socat',
        name: sidecarName,
        network: 'bridge',
        mounts: [],
        env: {},
        entrypoint: '/bin/sh',
        command: [
          '-c',
          quote(['socat', `TCP-LISTEN:${mcpPort},fork,reuseaddr`, `TCP:host.docker.internal:${mcpPort}`]) +
            ' & ' +
            quote(['socat', `TCP-LISTEN:${mitmPort},fork,reuseaddr`, `TCP:host.docker.internal:${mitmPort}`]),
        ],
      });
      await this.docker.start(this.sidecarContainerId);

      // Connect sidecar to the internal network so the app container can reach it
      await this.docker.connectNetwork(INTERNAL_NETWORK_NAME, this.sidecarContainerId);
      const sidecarIp = await this.docker.getContainerIp(this.sidecarContainerId, INTERNAL_NETWORK_NAME);
      extraHosts = [`host.docker.internal:${sidecarIp}`];
      logger.info(`Sidecar ${sidecarName} bridging ports ${mcpPort},${mitmPort} at ${sidecarIp}`);

      mounts = [
        { source: this.sandboxDir, target: '/workspace', readonly: false },
        // No session dir mount needed for sockets (TCP mode) -- only orientation subdir is mounted
        { source: orientationDir, target: '/etc/ironcurtain', readonly: true },
      ];
    } else {
      // Linux UDS mode: --network=none, session dir with sockets mounted
      env = {
        ...this.adapter.buildEnv(this.config, this.fakeKeys),
        HTTPS_PROXY: 'http://127.0.0.1:18080',
        HTTP_PROXY: 'http://127.0.0.1:18080',
      };
      network = 'none';
      mounts = [
        { source: this.sandboxDir, target: '/workspace', readonly: false },
        // Session dir contains proxy.sock and mitm-proxy.sock -- directory mount
        // exposes both to the container (file mounts for UDS don't work on macOS Docker Desktop).
        { source: this.sessionDir, target: '/run/ironcurtain', readonly: false },
        { source: orientationDir, target: '/etc/ironcurtain', readonly: true },
      ];
    }

    this.containerId = await this.docker.create({
      image,
      name: `ironcurtain-${shortId}`,
      network,
      mounts,
      env,
      command: ['sleep', 'infinity'],
      sessionLabel: this.sessionId,
      resources: { memoryMb: 4096, cpus: 2 },
      extraHosts,
    });

    await this.docker.start(this.containerId);
    this.networkName = network;
    logger.info(`Container started: ${this.containerId.substring(0, 12)}`);

    // Connectivity check: verify the container can reach host proxies
    // through the internal network. Abort if unreachable.
    if (this.useTcp && network === INTERNAL_NETWORK_NAME && this.proxy.port !== undefined) {
      await this.checkInternalNetworkConnectivity(this.containerId, this.proxy.port);
    }

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

    const command = this.adapter.buildCommand(userMessage, this.systemPrompt);
    logger.info(`[docker-agent] exec: ${formatCommand(command)}`);

    const { exitCode, stdout, stderr } = await this.docker.exec(this.containerId, command, execTimeout);
    logger.info(`[docker-agent] exit=${exitCode} stdout=${stdout.length}B stderr=${stderr.length}B`);

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
    return this.pendingEscalation;
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

    // Stop and remove sidecar container
    if (this.sidecarContainerId) {
      await this.docker.stop(this.sidecarContainerId);
      await this.docker.remove(this.sidecarContainerId);
    }

    // Remove internal network (ignore errors -- other sessions may use it)
    if (this.networkName === INTERNAL_NETWORK_NAME) {
      await this.docker.removeNetwork(INTERNAL_NETWORK_NAME);
    }

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
   * Ensures the Docker image exists and is up-to-date, building it
   * (and the base image) if needed.
   *
   * Staleness detection uses a content hash of all build inputs
   * (Dockerfiles, entrypoint scripts, CA certificate) stored as
   * Docker image labels.
   */
  private async ensureImage(image: string): Promise<void> {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const dockerDir = resolve(packageRoot, 'docker');

    // On arm64 hosts (Apple Silicon), use the lightweight arm64-native Dockerfile
    // instead of the amd64-only devcontainers/universal image.
    const baseDockerfile =
      arch() === 'arm64' && existsSync(resolve(dockerDir, 'Dockerfile.base.arm64'))
        ? 'Dockerfile.base.arm64'
        : 'Dockerfile.base';

    // Build base image with CA cert baked in (if stale or missing)
    const baseImage = 'ironcurtain-base:latest';
    const baseBuildHash = this.computeBuildHash(dockerDir, [baseDockerfile]);
    const baseRebuilt = await this.ensureBaseImage(baseImage, dockerDir, baseDockerfile, baseBuildHash);

    // Build the agent-specific image (if stale, missing, or base was rebuilt)
    const agentName = image.replace('ironcurtain-', '').replace(':latest', '');
    const dockerfile = `Dockerfile.${agentName}`;
    const agentDockerfilePath = resolve(dockerDir, dockerfile);
    if (!existsSync(agentDockerfilePath)) {
      throw new Error(`Dockerfile not found for agent "${agentName}": ${agentDockerfilePath}`);
    }

    const agentBuildHash = this.computeBuildHash(dockerDir, [dockerfile], baseBuildHash);
    const needsAgentBuild = baseRebuilt || (await this.isImageStale(image, agentBuildHash));

    if (needsAgentBuild) {
      logger.info(`Building Docker image ${image}...`);
      await this.docker.buildImage(image, agentDockerfilePath, dockerDir, {
        'ironcurtain.build-hash': agentBuildHash,
      });
      logger.info(`Docker image ${image} built successfully`);
    }
  }

  /**
   * Ensures the base image exists and is up-to-date.
   * Returns true if the base image was (re)built.
   */
  private async ensureBaseImage(
    baseImage: string,
    dockerDir: string,
    dockerfile: string,
    buildHash: string,
  ): Promise<boolean> {
    if (!(await this.isImageStale(baseImage, buildHash))) return false;

    logger.info('Building base Docker image (this may take a while on first run)...');

    // Create temporary build context with CA cert
    const tmpContext = mkdtempSync(resolve(tmpdir(), 'ironcurtain-build-'));
    try {
      // Copy Dockerfile and entrypoint scripts
      for (const file of readdirSync(dockerDir)) {
        copyFileSync(resolve(dockerDir, file), resolve(tmpContext, file));
      }
      // Copy CA cert into build context
      copyFileSync(this.ca.certPath, resolve(tmpContext, 'ironcurtain-ca-cert.pem'));

      await this.docker.buildImage(baseImage, resolve(tmpContext, dockerfile), tmpContext, {
        'ironcurtain.build-hash': buildHash,
      });
    } finally {
      rmSync(tmpContext, { recursive: true, force: true });
    }
    logger.info('Base Docker image built successfully');
    return true;
  }

  /**
   * Checks if an image needs (re)building by comparing the stored
   * build hash label against the expected hash.
   */
  private async isImageStale(image: string, expectedHash: string): Promise<boolean> {
    if (!(await this.docker.imageExists(image))) return true;
    const storedHash = await this.docker.getImageLabel(image, 'ironcurtain.build-hash');
    return storedHash !== expectedHash;
  }

  /**
   * Computes a SHA-256 content hash of all files in the docker directory
   * plus the CA certificate. This captures changes to Dockerfiles,
   * entrypoint scripts, and the CA cert.
   */
  private computeBuildHash(dockerDir: string, dockerfiles: string[], parentHash?: string): string {
    const hash = createHash('sha256');

    // Hash specified Dockerfiles and all entrypoint scripts
    const files = readdirSync(dockerDir).sort();
    for (const file of files) {
      // Include requested Dockerfiles and all entrypoint/script files
      if (dockerfiles.includes(file) || file.endsWith('.sh')) {
        hash.update(`file:${file}\n`);
        hash.update(readFileSync(resolve(dockerDir, file)));
      }
    }

    // Hash CA certificate content
    hash.update('ca-cert\n');
    hash.update(this.ca.certPem);

    // Chain parent hash for agent images (so base rebuild triggers agent rebuild)
    if (parentHash) {
      hash.update(`parent:${parentHash}\n`);
    }

    return hash.digest('hex');
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
