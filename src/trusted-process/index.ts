import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { IronCurtainConfig } from '../config/types.js';
import type { ToolCallRequest, ToolCallResult, PolicyDecision } from '../types/mcp.js';
import type { AuditEntry } from '../types/audit.js';
import {
  loadGeneratedPolicy,
  extractServerDomainAllowlists,
  checkConstitutionFreshness,
  getPackageGeneratedDir,
} from '../config/index.js';
import { createLanguageModel } from '../config/model-provider.js';
import { PolicyEngine, extractAnnotatedPaths } from './policy-engine.js';
import { MCPClientManager, type McpRoot } from './mcp-client-manager.js';
import { getPathRoles } from '../types/argument-roles.js';
import { AuditLog } from './audit-log.js';
import { EscalationHandler } from './escalation.js';
import { autoApprove } from './auto-approver.js';
import { prepareToolArgs } from './path-utils.js';
import { extractPolicyRoots, toMcpRoots, directoryForPath } from './policy-roots.js';
import * as logger from '../logger.js';
import { extractMcpErrorMessage } from './mcp-error-utils.js';
import { type ServerContextMap, updateServerContext, formatServerContext } from './server-context.js';

export type EscalationPromptFn = (request: ToolCallRequest, reason: string) => Promise<'approved' | 'denied'>;

export interface TrustedProcessOptions {
  onEscalation?: EscalationPromptFn;
}

export class TrustedProcess {
  private policyEngine: PolicyEngine;
  private mcpManager: MCPClientManager;
  private mcpRoots: McpRoot[];
  private auditLog: AuditLog;
  private escalation: EscalationHandler;
  private onEscalation?: EscalationPromptFn;
  private autoApproveModel: LanguageModelV3 | null = null;
  private lastUserMessage: string | null = null;
  private serverContextMap: ServerContextMap = new Map();

  constructor(
    private config: IronCurtainConfig,
    options?: TrustedProcessOptions,
  ) {
    const { compiledPolicy, toolAnnotations, dynamicLists } = loadGeneratedPolicy(
      config.generatedDir,
      getPackageGeneratedDir(),
    );
    checkConstitutionFreshness(compiledPolicy, config.constitutionPath);

    const serverDomainAllowlists = extractServerDomainAllowlists(config.mcpServers);
    this.policyEngine = new PolicyEngine(
      compiledPolicy,
      toolAnnotations,
      config.protectedPaths,
      config.allowedDirectory,
      serverDomainAllowlists,
      dynamicLists,
    );

    const policyRoots = extractPolicyRoots(compiledPolicy, config.allowedDirectory);
    this.mcpRoots = toMcpRoots(policyRoots);

    this.mcpManager = new MCPClientManager();
    this.auditLog = new AuditLog(config.auditLogPath, {
      redact: config.userConfig.auditRedaction.enabled,
    });
    this.escalation = new EscalationHandler();
    this.onEscalation = options?.onEscalation;
  }

  /**
   * Sets the most recent user message for auto-approval context.
   * Called by the session layer before each agent turn.
   */
  setLastUserMessage(message: string): void {
    this.lastUserMessage = message;
  }

  async initialize(): Promise<void> {
    const failedServers: string[] = [];
    for (const [name, serverConfig] of Object.entries(this.config.mcpServers)) {
      logger.info(`Connecting to MCP server: ${name}...`);
      try {
        await this.mcpManager.connect(name, serverConfig, this.mcpRoots);
        logger.info(`Connected to MCP server: ${name}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`Failed to connect to MCP server '${name}': ${msg} — skipping`);
        failedServers.push(name);
      }
    }
    if (failedServers.length > 0) {
      logger.warn(`Unavailable MCP servers: ${failedServers.join(', ')}. Their tools will not be available.`);
    }

    // Create auto-approve model if enabled
    const autoApproveConfig = this.config.userConfig.autoApprove;
    if (autoApproveConfig.enabled) {
      try {
        this.autoApproveModel = await createLanguageModel(autoApproveConfig.modelId, this.config.userConfig);
      } catch {
        // Model creation failure should not prevent initialization.
        // Auto-approve simply won't be available.
        logger.warn('[auto-approve] Failed to create model; auto-approve disabled');
      }
    }
  }

  async listTools(serverName: string) {
    return this.mcpManager.listTools(serverName);
  }

  /**
   * Handles a tool call request through the full trusted process lifecycle:
   *   1. Evaluate policy (allow / deny / escalate)
   *   2. If escalated, prompt the human for approval
   *   3. If allowed, forward to the real MCP server
   *   4. Log the complete decision trace to the audit log
   *   5. Return the result to the caller
   */
  async handleToolCall(request: ToolCallRequest): Promise<ToolCallResult> {
    const startTime = Date.now();

    // Annotation-driven normalization: split into transport vs policy args
    const annotation = this.policyEngine.getAnnotation(request.serverName, request.toolName);
    if (!annotation) {
      const reason = `Missing annotation for tool: ${request.serverName}__${request.toolName}. Re-run 'ironcurtain annotate-tools' to update.`;
      return {
        requestId: request.requestId,
        status: 'denied',
        content: { denied: true, reason },
        policyDecision: { status: 'deny', rule: 'missing-annotation', reason },
        durationMs: Date.now() - startTime,
      };
    }
    const { argsForTransport, argsForPolicy } = prepareToolArgs(
      request.arguments,
      annotation,
      this.config.allowedDirectory,
    );
    const policyRequest = { ...request, arguments: argsForPolicy };
    const transportRequest = { ...request, arguments: argsForTransport };

    // Step 1: Evaluate request against the policy rule chain
    const evaluation = this.policyEngine.evaluate(policyRequest);
    const policyDecision: PolicyDecision = {
      status: evaluation.decision,
      rule: evaluation.rule,
      reason: evaluation.reason,
    };

    let escalationResult: 'approved' | 'denied' | undefined;
    let autoApproved = false;
    let resultContent: unknown;
    let resultStatus: 'success' | 'denied' | 'error';
    let resultError: string | undefined;

    try {
      // Step 2: Handle escalation -- try auto-approve first, then human
      if (evaluation.decision === 'escalate') {
        // Try auto-approve before prompting the human
        if (this.autoApproveModel && this.lastUserMessage) {
          const autoResult = await autoApprove(
            {
              userMessage: this.lastUserMessage,
              toolName: `${request.serverName}/${request.toolName}`,
              escalationReason: evaluation.reason,
            },
            this.autoApproveModel,
          );

          if (autoResult.decision === 'approve') {
            autoApproved = true;
            escalationResult = 'approved';
            policyDecision.status = 'allow';
            policyDecision.reason = `Auto-approved: ${autoResult.reasoning}`;
          }
        }

        // Fall through to human escalation if not auto-approved
        if (!autoApproved) {
          const escalationContext = formatServerContext(this.serverContextMap, transportRequest.serverName);
          escalationResult = this.onEscalation
            ? await this.onEscalation(transportRequest, evaluation.reason)
            : await this.escalation.prompt(transportRequest, evaluation.reason, escalationContext);

          if (escalationResult === 'approved') {
            policyDecision.status = 'allow';
            policyDecision.reason = 'Approved by human during escalation';
          } else {
            policyDecision.status = 'deny';
            policyDecision.reason = 'Denied by human during escalation';
          }
        }

        // Expand roots to include target directories so the filesystem
        // server accepts the forwarded call (for both auto and human approval).
        if (escalationResult === 'approved') {
          const pathValues = extractAnnotatedPaths(transportRequest.arguments, annotation, getPathRoles());
          for (const p of pathValues) {
            const dir = directoryForPath(p);
            await this.mcpManager.addRoot(transportRequest.serverName, {
              uri: `file://${dir}`,
              name: 'escalation-approved',
            });
          }
        }
      }

      // Step 3: Forward to MCP server or deny (using transport args)
      if (policyDecision.status === 'allow') {
        const mcpResult = (await this.mcpManager.callTool(
          transportRequest.serverName,
          transportRequest.toolName,
          transportRequest.arguments,
        )) as { content?: unknown; isError?: boolean };
        resultContent = mcpResult;

        if (mcpResult.isError) {
          resultStatus = 'error';
          const content = mcpResult.content;
          if (Array.isArray(content)) {
            resultError = content
              .filter((c: Record<string, unknown>) => c.type === 'text' && typeof c.text === 'string')
              .map((c: Record<string, unknown>) => c.text as string)
              .join('\n');
          }
        } else {
          resultStatus = 'success';
          updateServerContext(
            this.serverContextMap,
            transportRequest.serverName,
            transportRequest.toolName,
            transportRequest.arguments,
          );
        }
      } else {
        resultContent = { denied: true, reason: policyDecision.reason };
        resultStatus = 'denied';
      }
    } catch (err) {
      resultStatus = 'error';
      resultError = extractMcpErrorMessage(err);
      resultContent = { error: resultError };
    }

    const durationMs = Date.now() - startTime;

    // Step 4: Append-only audit log (records argsForTransport -- what was sent to MCP server)
    const auditEntry: AuditEntry = {
      timestamp: new Date().toISOString(),
      requestId: transportRequest.requestId,
      serverName: transportRequest.serverName,
      toolName: transportRequest.toolName,
      arguments: transportRequest.arguments,
      policyDecision,
      escalationResult,
      result: {
        status: resultStatus,
        content: resultStatus === 'success' ? resultContent : undefined,
        error: resultError,
      },
      durationMs,
      autoApproved: autoApproved || undefined,
    };
    this.auditLog.log(auditEntry);

    // Step 5: Return result to caller
    return {
      requestId: transportRequest.requestId,
      status: resultStatus,
      content: resultContent,
      policyDecision,
      durationMs,
    };
  }

  async shutdown(): Promise<void> {
    this.escalation.close();
    await this.mcpManager.closeAll();
    await this.auditLog.close();
  }
}
