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
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createLlmLoggingMiddleware } from '../pipeline/llm-logger.js';
import type { LlmLogContext } from '../pipeline/llm-logger.js';
import { resolve } from 'node:path';
import type { IronCurtainConfig } from '../config/types.js';
import type { Sandbox } from '../sandbox/index.js';
import { buildSystemPrompt } from '../agent/prompts.js';
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
import { SessionNotReadyError, SessionClosedError } from './errors.js';

const MAX_AGENT_STEPS = 10;
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
    this.model = this.buildModel();
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

    this.status = 'processing';
    const turnStart = new Date().toISOString();
    const messageCountBefore = this.messages.length;

    try {
      this.messages.push({ role: 'user', content: userMessage });

      const result = await generateText({
        model: this.model!,
        system: this.systemPrompt,
        messages: this.messages,
        tools: this.tools,
        stopWhen: stepCountIs(MAX_AGENT_STEPS),
        onStepFinish: (stepResult) => {
          this.emitToolCallDiagnostics(stepResult.toolCalls);
          this.emitTextDiagnostic(stepResult.text);
        },
      });

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
      throw error;
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
          try {
            const { result, logs } = await this.sandbox.executeCode(code);
            const output: Record<string, unknown> = {};
            if (logs.length > 0) output.console = logs;
            output.result = result;
            return output;
          } catch (err) {
            return {
              error: err instanceof Error ? err.message : String(err),
            };
          }
        },
      }),
    };
  }

  private buildModel(): LanguageModel {
    const baseModel = anthropic('claude-sonnet-4-6');
    if (!this.config.llmLogPath) return baseModel;

    const logContext: LlmLogContext = { stepName: 'agent' };
    return wrapLanguageModel({
      model: baseModel,
      middleware: createLlmLoggingMiddleware(this.config.llmLogPath, logContext),
    });
  }

  private emitToolCallDiagnostics(toolCalls: readonly { toolName: string; input?: unknown }[]): void {
    for (const tc of toolCalls) {
      if (tc.toolName === 'execute_code' && tc.input != null) {
        const input = tc.input as { code: string };
        const preview = input.code.substring(0, 120).replace(/\n/g, '\\n');
        const event: DiagnosticEvent = {
          kind: 'tool_call',
          toolName: tc.toolName,
          preview: `${preview}${input.code.length > 120 ? '...' : ''}`,
        };
        this.diagnosticLog.push(event);
        this.onDiagnostic?.(event);
      }
    }
  }

  private emitTextDiagnostic(text: string): void {
    if (!text) return;
    const event: DiagnosticEvent = {
      kind: 'agent_text',
      preview: `${text.substring(0, 200)}${text.length > 200 ? '...' : ''}`,
    };
    this.diagnosticLog.push(event);
    this.onDiagnostic?.(event);
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
