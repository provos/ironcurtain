/**
 * AgentSession -- concrete Session implementation.
 *
 * Not exported from the public API. Callers use the Session interface
 * via createSession() in index.ts.
 */

import {
  generateText,
  stepCountIs,
  tool,
  wrapLanguageModel,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import { createLanguageModel } from '../config/model-provider.js';
import { z } from 'zod';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createLlmLoggingMiddleware } from '../pipeline/llm-logger.js';
import type { LlmLogContext } from '../pipeline/llm-logger.js';
import { resolve } from 'node:path';
import type { IronCurtainConfig } from '../config/types.js';
import type { Sandbox } from '../sandbox/index.js';
import { buildSystemPrompt } from './prompts.js';
import type {
  Session,
  SessionId,
  SessionStatus,
  SessionInfo,
  SessionOptions,
  ConversationTurn,
  DiagnosticEvent,
  EscalationRequest,
  SandboxFactory,
} from './types.js';
import { SessionNotReadyError, SessionClosedError, BudgetExhaustedError } from './errors.js';
import { StepLoopDetector } from './step-loop-detector.js';
import { ResourceBudgetTracker } from './resource-budget-tracker.js';
import { truncateResult, getResultSizeLimit, formatKB } from './truncate-result.js';
import * as logger from '../logger.js';

const MAX_AGENT_STEPS = 100;
const ESCALATION_POLL_INTERVAL_MS = 300;

/** Default sandbox factory: creates a real UTCP Code Mode sandbox. */
async function defaultSandboxFactory(config: IronCurtainConfig): Promise<Sandbox> {
  const { Sandbox: SandboxClass } = await import('../sandbox/index.js');
  const instance = new SandboxClass();
  await instance.initialize(config);
  return instance;
}

export class AgentSession implements Session {
  private readonly sessionId: SessionId;
  private status: SessionStatus = 'initializing';
  private readonly config: IronCurtainConfig;
  private sandbox: Sandbox | null = null;
  private readonly createdAt: string;
  private readonly sandboxFactory: SandboxFactory;
  private readonly escalationDir: string;

  /** Raw AI SDK message history. */
  private messages: ModelMessage[] = [];

  /** Structured turn log exposed through getHistory(). */
  private turns: ConversationTurn[] = [];

  /** Accumulated diagnostic events exposed through getDiagnosticLog(). */
  private diagnosticLog: DiagnosticEvent[] = [];

  /** System prompt, built once after sandbox initialization. */
  private systemPrompt = '';

  /** The tool set, built once after sandbox initialization. */
  private tools: ToolSet = {};

  /** Language model, optionally wrapped with logging middleware. */
  private model: LanguageModel | null = null;

  /** Currently pending escalation, if any. */
  private pendingEscalation: EscalationRequest | undefined;

  /** Interval handle for polling the escalation directory. */
  private escalationPollInterval: ReturnType<typeof setInterval> | null = null;

  /** Escalation IDs already detected, to prevent re-detection after resolution. */
  private seenEscalationIds = new Set<string>();

  /** Step-level loop detector for the agent. */
  private loopDetector = new StepLoopDetector();

  /** Resource budget tracker for token, step, time, and cost limits. */
  private readonly budgetTracker: ResourceBudgetTracker;

  /** Callbacks from SessionOptions. */
  private readonly onEscalation?: (request: EscalationRequest) => void;
  private readonly onDiagnostic?: (event: DiagnosticEvent) => void;

  constructor(
    config: IronCurtainConfig,
    sessionId: SessionId,
    escalationDir: string,
    options: SessionOptions = {},
  ) {
    this.sessionId = sessionId;
    this.config = config;
    this.escalationDir = escalationDir;
    this.sandboxFactory = options.sandboxFactory ?? defaultSandboxFactory;
    this.onEscalation = options.onEscalation;
    this.onDiagnostic = options.onDiagnostic;
    this.createdAt = new Date().toISOString();
    this.budgetTracker = new ResourceBudgetTracker(
      config.userConfig.resourceBudget,
      config.agentModelId,
    );
  }

  /**
   * Initialize the session's sandbox and build the tool set.
   * Called by the factory function, not by external callers.
   */
  async initialize(): Promise<void> {
    this.sandbox = await this.sandboxFactory(this.config);
    this.systemPrompt = buildSystemPrompt(
      this.sandbox.getToolInterfaces(),
      this.config.allowedDirectory,
    );
    this.tools = this.buildTools();
    this.model = await this.buildModel();
    this.startEscalationWatcher();
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

    // Pre-check: budget may already be exhausted from a previous turn
    const budgetCheck = this.budgetTracker.isExhausted();
    if (budgetCheck) {
      this.emitBudgetExhaustedDiagnostic(budgetCheck.dimension, budgetCheck.message);
      throw new BudgetExhaustedError(budgetCheck.dimension, budgetCheck.message);
    }

    this.status = 'processing';
    const turnStart = new Date().toISOString();
    const messageCountBefore = this.messages.length;

    // Wall-clock abort signal (null when wall-clock budget is disabled)
    const remainingMs = this.budgetTracker.getRemainingWallClockMs();
    const abortController = remainingMs !== null ? new AbortController() : null;
    const abortTimeout = abortController
      ? setTimeout(() => abortController.abort(), remainingMs!)
      : null;

    try {
      this.messages.push({ role: 'user', content: userMessage });

      const result = await generateText({
        model: this.model!,
        system: this.systemPrompt,
        messages: this.messages,
        tools: this.tools,
        stopWhen: [
          stepCountIs(MAX_AGENT_STEPS),
          this.budgetTracker.createStopCondition(),
        ],
        ...(abortController ? { abortSignal: abortController.signal } : {}),
        onStepFinish: (stepResult) => {
          this.emitToolCallDiagnostics(stepResult.toolCalls);
          this.emitTextDiagnostic(stepResult.text);
          this.emitBudgetWarnings();
        },
      });

      // Check if budget triggered the stop
      const postCheck = this.budgetTracker.isExhausted();
      if (postCheck) {
        this.emitBudgetExhaustedDiagnostic(postCheck.dimension, postCheck.message);
      }

      this.messages.push(...result.response.messages);

      const turn = this.recordTurn(userMessage, result.text, result.totalUsage, turnStart);
      this.turns.push(turn);

      this.status = 'ready';
      return result.text;
    } catch (error) {
      // Truncate back to the state before this turn, removing the user
      // message and any partial response messages that may have been pushed.
      this.messages.length = messageCountBefore;
      this.status = 'ready';

      // Detect AbortError from wall-clock timeout
      if (error instanceof Error && error.name === 'AbortError') {
        const exhausted = this.budgetTracker.isExhausted();
        const dimension = exhausted?.dimension ?? 'wall_clock';
        const message = exhausted?.message ?? 'Session aborted: wall-clock time budget exceeded';
        this.emitBudgetExhaustedDiagnostic(dimension, message);
        throw new BudgetExhaustedError(dimension, message);
      }

      throw error;
    } finally {
      if (abortTimeout !== null) clearTimeout(abortTimeout);
    }
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

  async resolveEscalation(
    escalationId: string,
    decision: 'approved' | 'denied',
  ): Promise<void> {
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
    if (this.sandbox) {
      await this.sandbox.shutdown();
      this.sandbox = null;
    }
  }

  // --- Private helpers ---

  private buildTools(): ToolSet {
    return {
      execute_code: tool({
        description:
          'Execute TypeScript code in a secure sandbox with access to filesystem tools. ' +
          'Write code that calls tool functions like filesystem.filesystem_read_file({ path }), ' +
          'filesystem.filesystem_list_directory({ path }), etc. ' +
          'Tools are synchronous — no await needed. Use return to provide results. ' +
          'Call __getToolInterface(\'tool.name\') to discover the full type signature of any tool.',
        inputSchema: z.object({
          code: z
            .string()
            .describe('TypeScript code to execute in the sandbox'),
        }),
        execute: async ({ code }) => {
          if (!this.sandbox) throw new Error('Sandbox not initialized');

          const budgetBlock = this.budgetTracker.isExhausted();
          if (budgetBlock) {
            return { error: budgetBlock.message };
          }

          const blockCheck = this.loopDetector.isBlocked();
          if (blockCheck) {
            return { error: blockCheck.message };
          }

          try {
            const { result, logs } = await this.sandbox.executeCode(code);
            const output: Record<string, unknown> = {};
            if (logs.length > 0) output.console = logs;

            const truncation = truncateResult(result, getResultSizeLimit());
            output.result = truncation.value;
            if (truncation.truncated) {
              output.warning = `Tool result truncated from ${formatKB(truncation.originalSize)} to ${formatKB(truncation.finalSize)}. Use targeted reads (head/tail parameters) for specific portions.`;
              logger.warn(`[truncation] Result truncated: ${formatKB(truncation.originalSize)} -> ${formatKB(truncation.finalSize)}`);
              this.emitTruncationDiagnostic(truncation.originalSize, truncation.finalSize);
            }

            return this.applyLoopVerdict(code, output);
          } catch (err) {
            const output: Record<string, unknown> = {
              error: err instanceof Error ? err.message : String(err),
            };
            return this.applyLoopVerdict(code, output);
          }
        },
      }),
    };
  }

  private async buildModel(): Promise<LanguageModel> {
    const baseModel = await createLanguageModel(
      this.config.agentModelId,
      this.config.userConfig,
    );
    if (!this.config.llmLogPath) return baseModel;

    const logContext: LlmLogContext = { stepName: 'agent' };
    return wrapLanguageModel({
      model: baseModel,
      middleware: createLlmLoggingMiddleware(this.config.llmLogPath, logContext),
    });
  }

  /** Logs a diagnostic event and forwards it to the transport callback. */
  private emitDiagnostic(event: DiagnosticEvent): void {
    this.diagnosticLog.push(event);
    this.onDiagnostic?.(event);
  }

  private emitToolCallDiagnostics(toolCalls: readonly { toolName: string; input?: unknown }[]): void {
    for (const tc of toolCalls) {
      if (tc.toolName === 'execute_code' && tc.input != null) {
        const input = tc.input as { code: string };
        const preview = input.code.substring(0, 120).replace(/\n/g, '\\n');
        this.emitDiagnostic({
          kind: 'tool_call',
          toolName: tc.toolName,
          preview: `${preview}${input.code.length > 120 ? '...' : ''}`,
        });
      }
    }
  }

  /** Analyze a step for loop detection and attach a warning if needed. */
  private applyLoopVerdict(code: string, output: Record<string, unknown>): Record<string, unknown> {
    const verdict = this.loopDetector.analyzeStep(code, output);
    if (verdict.action === 'warn' || verdict.action === 'block') {
      output.warning = output.warning
        ? `${output.warning} | ${verdict.message}`
        : verdict.message;
      this.emitLoopDetectionDiagnostic(verdict.action, verdict.category, verdict.message);
    }
    return output;
  }

  private emitTruncationDiagnostic(originalSize: number, finalSize: number): void {
    this.emitDiagnostic({
      kind: 'result_truncation',
      originalKB: +(originalSize / 1024).toFixed(1),
      finalKB: +(finalSize / 1024).toFixed(1),
    });
  }

  private emitLoopDetectionDiagnostic(action: 'warn' | 'block', category: string, message: string): void {
    this.emitDiagnostic({ kind: 'loop_detection', action, category, message });
  }

  private emitBudgetWarnings(): void {
    for (const warning of this.budgetTracker.getActiveWarnings()) {
      this.emitDiagnostic({
        kind: 'budget_warning',
        dimension: warning.dimension,
        percentUsed: warning.percentUsed,
        message: warning.message,
      });
    }
  }

  private emitBudgetExhaustedDiagnostic(dimension: string, message: string): void {
    this.emitDiagnostic({ kind: 'budget_exhausted', dimension, message });
  }

  private emitTextDiagnostic(text: string): void {
    if (!text) return;
    this.emitDiagnostic({
      kind: 'agent_text',
      preview: `${text.substring(0, 200)}${text.length > 200 ? '...' : ''}`,
    });
  }

  private recordTurn(
    userMessage: string,
    assistantResponse: string,
    usage: { inputTokens: number | undefined; outputTokens: number | undefined; totalTokens: number | undefined },
    timestamp: string,
  ): ConversationTurn {
    return {
      turnNumber: this.turns.length + 1,
      userMessage,
      assistantResponse,
      usage: {
        promptTokens: usage.inputTokens ?? 0,
        completionTokens: usage.outputTokens ?? 0,
        totalTokens: usage.totalTokens ?? 0,
      },
      timestamp,
    };
  }

  /**
   * Starts polling the escalation directory for new request files.
   * When a request is detected, sets pendingEscalation and fires
   * the onEscalation callback.
   */
  private startEscalationWatcher(): void {
    this.escalationPollInterval = setInterval(() => {
      this.pollEscalationDirectory();
    }, ESCALATION_POLL_INTERVAL_MS);
  }

  private pollEscalationDirectory(): void {
    if (this.pendingEscalation) return;

    try {
      const files = readdirSync(this.escalationDir);
      const requestFile = files.find(f =>
        f.startsWith('request-') && f.endsWith('.json') &&
        !this.seenEscalationIds.has(this.extractEscalationId(f)),
      );
      if (!requestFile) return;

      const requestPath = resolve(this.escalationDir, requestFile);
      const request: EscalationRequest = JSON.parse(readFileSync(requestPath, 'utf-8'));
      this.seenEscalationIds.add(request.escalationId);
      this.pendingEscalation = request;
      this.onEscalation?.(request);
    } catch {
      // Directory may not exist yet or be empty -- ignore
    }
  }

  /** Extracts the escalation ID from a request filename like "request-abc123.json". */
  private extractEscalationId(filename: string): string {
    return filename.replace(/^request-/, '').replace(/\.json$/, '');
  }

  private stopEscalationWatcher(): void {
    if (this.escalationPollInterval) {
      clearInterval(this.escalationPollInterval);
      this.escalationPollInterval = null;
    }
  }
}
