import type { IronCurtainConfig } from '../config/types.js';
import type { ToolCallRequest, ToolCallResult, PolicyDecision } from '../types/mcp.js';
import type { AuditEntry } from '../types/audit.js';
import { loadGeneratedPolicy } from '../config/index.js';
import { PolicyEngine } from './policy-engine.js';
import { MCPClientManager } from './mcp-client-manager.js';
import { AuditLog } from './audit-log.js';
import { EscalationHandler } from './escalation.js';
import * as logger from '../logger.js';

export type EscalationPromptFn = (request: ToolCallRequest, reason: string) => Promise<'approved' | 'denied'>;

export interface TrustedProcessOptions {
  onEscalation?: EscalationPromptFn;
}

export class TrustedProcess {
  private policyEngine: PolicyEngine;
  private mcpManager: MCPClientManager;
  private auditLog: AuditLog;
  private escalation: EscalationHandler;
  private onEscalation?: EscalationPromptFn;

  constructor(private config: IronCurtainConfig, options?: TrustedProcessOptions) {
    const { compiledPolicy, toolAnnotations } = loadGeneratedPolicy(config.generatedDir);
    this.policyEngine = new PolicyEngine(compiledPolicy, toolAnnotations, config.protectedPaths);
    this.mcpManager = new MCPClientManager();
    this.auditLog = new AuditLog(config.auditLogPath);
    this.escalation = new EscalationHandler();
    this.onEscalation = options?.onEscalation;
  }

  async initialize(): Promise<void> {
    for (const [name, serverConfig] of Object.entries(this.config.mcpServers)) {
      logger.info(`Connecting to MCP server: ${name}...`);
      await this.mcpManager.connect(name, serverConfig);
      logger.info(`Connected to MCP server: ${name}`);
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

    // Step 1: Evaluate request against the policy rule chain
    const evaluation = this.policyEngine.evaluate(request);
    const policyDecision: PolicyDecision = {
      status: evaluation.decision,
      rule: evaluation.rule,
      reason: evaluation.reason,
    };

    let escalationResult: 'approved' | 'denied' | undefined;
    let resultContent: unknown;
    let resultStatus: 'success' | 'denied' | 'error';
    let resultError: string | undefined;

    try {
      // Step 2: Handle escalation via human approval
      if (evaluation.decision === 'escalate') {
        escalationResult = this.onEscalation
          ? await this.onEscalation(request, evaluation.reason)
          : await this.escalation.prompt(request, evaluation.reason);

        if (escalationResult === 'approved') {
          policyDecision.status = 'allow';
          policyDecision.reason = 'Approved by human during escalation';
        } else {
          policyDecision.status = 'deny';
          policyDecision.reason = 'Denied by human during escalation';
        }
      }

      // Step 3: Forward to MCP server or deny
      if (policyDecision.status === 'allow') {
        resultContent = await this.mcpManager.callTool(
          request.serverName,
          request.toolName,
          request.arguments,
        );
        resultStatus = 'success';
      } else {
        resultContent = { denied: true, reason: policyDecision.reason };
        resultStatus = 'denied';
      }
    } catch (err) {
      resultStatus = 'error';
      resultError = err instanceof Error ? err.message : String(err);
      resultContent = { error: resultError };
    }

    const durationMs = Date.now() - startTime;

    // Step 4: Append-only audit log
    const auditEntry: AuditEntry = {
      timestamp: new Date().toISOString(),
      requestId: request.requestId,
      serverName: request.serverName,
      toolName: request.toolName,
      arguments: request.arguments,
      policyDecision,
      escalationResult,
      result: {
        status: resultStatus,
        content: resultStatus === 'success' ? resultContent : undefined,
        error: resultError,
      },
      durationMs,
    };
    this.auditLog.log(auditEntry);

    // Step 5: Return result to caller
    return {
      requestId: request.requestId,
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
