import type { IronCurtainConfig } from '../config/types.js';
import type { ToolCallRequest, ToolCallResult } from '../types/mcp.js';
import {
  loadGeneratedPolicy,
  extractServerDomainAllowlists,
  checkConstitutionFreshness,
  checkAnnotationFreshness,
  getPackageGeneratedDir,
} from '../config/index.js';
import { createLanguageModel } from '../config/model-provider.js';
import type { MCPClientManager } from './mcp-client-manager.js';
import { MCPClientManager as McpClientManagerImpl } from './mcp-client-manager.js';
import type { McpRoot } from './mcp-client-manager.js';
import { EscalationHandler } from './escalation.js';
import * as logger from '../logger.js';
import { extractPolicyRoots, toMcpRoots } from './policy-roots.js';
import { buildTrustedServerSet } from '../memory/memory-annotations.js';
import { ToolCallCoordinator, type EscalationPromptFn } from './tool-call-coordinator.js';
import { checkSandboxAvailability, resolveSandboxConfigsForAudit } from './sandbox-integration.js';
import type { ProxiedTool } from './tool-call-pipeline.js';

/** Re-export for backward compatibility with callers that import from here. */
export type { EscalationPromptFn };
export type { EscalationResult } from './tool-call-coordinator.js';

export interface TrustedProcessOptions {
  /**
   * In-process escalation callback used by direct-tool-call code paths
   * (integration tests). When set, the coordinator invokes this
   * instead of consulting the file-IPC escalation directory.
   */
  onEscalation?: EscalationPromptFn;
}

/**
 * In-process trusted process. Wraps `ToolCallCoordinator` for callers
 * (integration tests, fallback direct-tool-call mode) that want a
 * pre-wired object with a single `handleToolCall` entry point.
 *
 * After Step 1, both in-process and Code Mode paths share the same
 * coordinator implementation for policy evaluation and audit logging.
 *
 * Lifecycle: `new TrustedProcess(config)` + `await initialize()`. The
 * coordinator is constructed during `initialize()` (not the constructor)
 * so the auto-approve model can be built first and threaded into
 * construction-time invariants, rather than being attached after the
 * fact.
 */
export class TrustedProcess {
  private coordinator: ToolCallCoordinator | null = null;
  private mcpManager: MCPClientManager;
  private mcpRoots: McpRoot[] = [];
  private escalation: EscalationHandler;
  private readonly options: TrustedProcessOptions;

  constructor(
    private config: IronCurtainConfig,
    options?: TrustedProcessOptions,
  ) {
    this.options = options ?? {};
    // In-process mode uses its own MCPClientManager so each `connect`
    // call spawns a real backend directly (no router subprocess). The
    // coordinator wraps it for the policy gate.
    this.mcpManager = new McpClientManagerImpl();
    this.escalation = new EscalationHandler();
  }

  /** Internal accessor: throws if used before `initialize()`. */
  private requireCoordinator(): ToolCallCoordinator {
    if (!this.coordinator) {
      throw new Error('TrustedProcess used before initialize() -- call initialize() first.');
    }
    return this.coordinator;
  }

  /**
   * Sets the most recent user message for auto-approval context.
   * Called by the session layer before each agent turn.
   */
  setLastUserMessage(message: string): void {
    this.requireCoordinator().setLastUserMessage(message);
  }

  async initialize(): Promise<void> {
    const { compiledPolicy, toolAnnotations, dynamicLists } = loadGeneratedPolicy({
      policyDir: this.config.generatedDir,
      toolAnnotationsDir: this.config.toolAnnotationsDir ?? this.config.generatedDir,
      fallbackDir: getPackageGeneratedDir(),
    });
    checkConstitutionFreshness(compiledPolicy, this.config.constitutionPath);
    checkAnnotationFreshness(toolAnnotations, this.config.mcpServers);

    const serverDomainAllowlists = extractServerDomainAllowlists(this.config.mcpServers);
    const trustedServers = buildTrustedServerSet(this.config.mcpServers);

    // Build the auto-approve model BEFORE constructing the coordinator
    // so it can be passed in as a construction-time invariant.
    const autoApproveModel = await this.buildAutoApproveModel();

    // Compute per-server sandbox disposition for audit annotation.
    const { platformSupported } = checkSandboxAvailability();
    const resolvedSandboxConfigs = resolveSandboxConfigsForAudit(
      this.config.mcpServers,
      this.config.allowedDirectory,
      platformSupported,
      this.config.sandboxPolicy ?? 'warn',
    );

    this.coordinator = new ToolCallCoordinator({
      compiledPolicy,
      toolAnnotations,
      protectedPaths: this.config.protectedPaths,
      allowedDirectory: this.config.allowedDirectory,
      serverDomainAllowlists,
      dynamicLists,
      trustedServers,
      auditLogPath: this.config.auditLogPath,
      auditRedact: this.config.userConfig.auditRedaction.enabled,
      escalationDir: this.config.escalationDir,
      mcpManager: this.mcpManager,
      onEscalation: this.options.onEscalation,
      autoApproveModel,
      resolvedSandboxConfigs,
    });

    const policyRoots = extractPolicyRoots(compiledPolicy, this.config.allowedDirectory);
    this.mcpRoots = toMcpRoots(policyRoots);

    await this.connectMcpServers();
  }

  /**
   * Creates the auto-approve language model when enabled in user config.
   * Returns `null` when auto-approve is disabled or model construction
   * fails (non-fatal: the session continues with manual escalation).
   */
  private async buildAutoApproveModel() {
    const autoApproveConfig = this.config.userConfig.autoApprove;
    if (!autoApproveConfig.enabled) return null;
    try {
      return await createLanguageModel(autoApproveConfig.modelId, this.config.userConfig);
    } catch {
      logger.warn('[auto-approve] Failed to create model; auto-approve disabled');
      return null;
    }
  }

  /**
   * Connects to every configured MCP server and registers its tools
   * with the coordinator. Unavailable servers are logged and skipped.
   */
  private async connectMcpServers(): Promise<void> {
    const coordinator = this.requireCoordinator();
    const failedServers: string[] = [];
    for (const [name, serverConfig] of Object.entries(this.config.mcpServers)) {
      const missingVars = getMissingEnvVars(serverConfig.args);
      if (missingVars.length > 0) {
        logger.warn(`Skipping MCP server '${name}': missing environment variable(s) ${missingVars.join(', ')}`);
        failedServers.push(name);
        continue;
      }
      logger.info(`Connecting to MCP server: ${name}...`);
      try {
        await this.mcpManager.connect(name, serverConfig, this.mcpRoots);
        logger.info(`Connected to MCP server: ${name}`);

        // Publish this server's tools to the coordinator so the policy
        // gate can route calls through it. Share the manager's live
        // `ClientState` so `addRootToClient` mutates the same roots
        // array the manager returns from its `roots/list` handler.
        const tools = await this.mcpManager.listTools(name);
        const clientState = this.mcpManager.getClientState(name);
        if (clientState) {
          const proxiedTools: ProxiedTool[] = tools.map((t) => ({
            serverName: name,
            name: t.name,
            description: t.description,
            inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
          }));
          coordinator.registerTools(name, proxiedTools, clientState);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`Failed to connect to MCP server '${name}': ${msg} — skipping`);
        failedServers.push(name);
      }
    }
    if (failedServers.length > 0) {
      logger.warn(`Unavailable MCP servers: ${failedServers.join(', ')}. Their tools will not be available.`);
    }
  }

  async listTools(serverName: string) {
    return this.mcpManager.listTools(serverName);
  }

  /**
   * Handles a tool call through the coordinator's policy pipeline.
   * Mirrors the legacy TrustedProcess.handleToolCall signature.
   */
  async handleToolCall(request: ToolCallRequest): Promise<ToolCallResult> {
    return this.requireCoordinator().handleStructuredToolCall(request);
  }

  async shutdown(): Promise<void> {
    this.escalation.close();
    // We injected our own MCPClientManager into the coordinator, so
    // the coordinator will NOT close it. Do that here, then close the
    // coordinator (which flushes the audit log).
    await this.mcpManager.closeAll();
    if (this.coordinator) {
      await this.coordinator.close();
    }
  }
}

/**
 * Detects Docker-style `-e VAR_NAME` args (no `=`) where the env var is unset.
 */
function getMissingEnvVars(args: string[]): string[] {
  const missing: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-e' && i + 1 < args.length) {
      const val = args[i + 1];
      if (!val.includes('=') && !process.env[val]) {
        missing.push(val);
      }
      i++;
    }
  }
  return missing;
}
