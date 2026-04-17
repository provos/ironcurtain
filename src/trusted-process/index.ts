import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { IronCurtainConfig } from '../config/types.js';
import type { ToolCallRequest, ToolCallResult } from '../types/mcp.js';
import {
  loadGeneratedPolicy,
  extractServerDomainAllowlists,
  checkConstitutionFreshness,
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
import type { ProxiedTool, ClientState } from './tool-call-pipeline.js';

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
 */
export class TrustedProcess {
  private coordinator: ToolCallCoordinator;
  private mcpManager: MCPClientManager;
  private mcpRoots: McpRoot[];
  private escalation: EscalationHandler;
  private autoApproveModel: LanguageModelV3 | null = null;
  private lastUserMessage: string | null = null;

  constructor(
    private config: IronCurtainConfig,
    options?: TrustedProcessOptions,
  ) {
    const { compiledPolicy, toolAnnotations, dynamicLists } = loadGeneratedPolicy({
      policyDir: config.generatedDir,
      toolAnnotationsDir: config.toolAnnotationsDir ?? config.generatedDir,
      fallbackDir: getPackageGeneratedDir(),
    });
    checkConstitutionFreshness(compiledPolicy, config.constitutionPath);

    const serverDomainAllowlists = extractServerDomainAllowlists(config.mcpServers);
    const trustedServers = buildTrustedServerSet(config.mcpServers);

    // In-process mode uses its own MCPClientManager so each `connect`
    // call spawns a real backend directly (no router subprocess). The
    // coordinator wraps it for the policy gate.
    this.mcpManager = new McpClientManagerImpl();
    this.coordinator = new ToolCallCoordinator({
      compiledPolicy,
      toolAnnotations,
      protectedPaths: config.protectedPaths,
      allowedDirectory: config.allowedDirectory,
      serverDomainAllowlists,
      dynamicLists,
      trustedServers,
      auditLogPath: config.auditLogPath,
      auditRedact: config.userConfig.auditRedaction.enabled,
      escalationDir: config.escalationDir,
      mcpManager: this.mcpManager,
      onEscalation: options?.onEscalation,
    });

    const policyRoots = extractPolicyRoots(compiledPolicy, config.allowedDirectory);
    this.mcpRoots = toMcpRoots(policyRoots);

    this.escalation = new EscalationHandler();
  }

  /**
   * Sets the most recent user message for auto-approval context.
   * Called by the session layer before each agent turn.
   */
  setLastUserMessage(message: string): void {
    this.lastUserMessage = message;
    this.coordinator.setLastUserMessage(message);
  }

  async initialize(): Promise<void> {
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
        // gate can route calls through it. Use the live MCP client as
        // the `ClientState` so `handleCallTool`'s escalation/roots
        // expansion path remains functional.
        const tools = await this.mcpManager.listTools(name);
        const client = this.mcpManager.getClient(name);
        const roots = this.mcpManager.getRoots(name);
        if (client) {
          const proxiedTools: ProxiedTool[] = tools.map((t) => ({
            serverName: name,
            name: t.name,
            description: t.description,
            inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
          }));
          const clientState: ClientState = { client, roots: roots ?? [] };
          this.coordinator.registerTools(name, proxiedTools, clientState);
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

    // Create auto-approve model if enabled.
    // NOTE: auto-approve model creation after coordinator construction
    // is a known limitation -- the coordinator's `handleCallTool` only
    // reads the model passed at construction time. For in-process tests
    // with auto-approve enabled, wire the model into
    // `ToolCallCoordinatorOptions.autoApproveModel` directly and skip
    // this branch. Kept here for parity with the legacy API until the
    // session layer is updated to build the model before constructing
    // the coordinator.
    const autoApproveConfig = this.config.userConfig.autoApprove;
    if (autoApproveConfig.enabled) {
      try {
        this.autoApproveModel = await createLanguageModel(autoApproveConfig.modelId, this.config.userConfig);
      } catch {
        logger.warn('[auto-approve] Failed to create model; auto-approve disabled');
      }
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
    // Temporarily unused; retained for future integration with the
    // coordinator's auto-approver context (the coordinator currently
    // reads user context from the escalation directory, not here).
    void this.autoApproveModel;
    void this.lastUserMessage;
    void this.escalation;
    return this.coordinator.handleStructuredToolCall(request);
  }

  async shutdown(): Promise<void> {
    this.escalation.close();
    // We injected our own MCPClientManager into the coordinator, so
    // the coordinator will NOT close it. Do that here, then close the
    // coordinator (which flushes the audit log).
    await this.mcpManager.closeAll();
    await this.coordinator.close();
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
