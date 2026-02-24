import { randomUUID } from 'node:crypto';
import type { IronCurtainConfig } from '../config/types.js';
import type { Sandbox } from '../sandbox/index.js';
import type { ResolvedResourceBudgetConfig } from '../config/user-config.js';
import type { CumulativeBudgetSnapshot } from './resource-budget-tracker.js';
import type { AgentId } from '../docker/agent-adapter.js';

/**
 * Unique identifier for a session. Branded to prevent accidental
 * mixing with other string identifiers.
 */
export type SessionId = string & { readonly __brand: 'SessionId' };

/** Creates a new unique SessionId. */
export function createSessionId(): SessionId {
  return randomUUID() as SessionId;
}

/**
 * The possible states a session can be in. Linear progression:
 * initializing -> ready -> (processing <-> ready) -> closed.
 *
 * - initializing: sandbox and resources being set up
 * - ready: accepting messages
 * - processing: a message is being processed (generateText in flight)
 * - closed: resources released, no more messages accepted
 */
export type SessionStatus = 'initializing' | 'ready' | 'processing' | 'closed';

/**
 * Selects the session implementation.
 *
 * 'builtin' creates the existing AgentSession (UTCP Code Mode + AI SDK).
 * 'docker' creates a DockerAgentSession that spawns an external agent
 * inside a Docker container with MCP proxy mediation.
 */
export type SessionMode = { readonly kind: 'builtin' } | { readonly kind: 'docker'; readonly agent: AgentId };

/**
 * A single turn in the conversation. Captures what the user said,
 * what the agent responded, and metadata about the turn.
 */
export interface ConversationTurn {
  /** 1-based turn number within this session. */
  readonly turnNumber: number;

  /** The user's input for this turn. */
  readonly userMessage: string;

  /** The agent's final text response for this turn. */
  readonly assistantResponse: string;

  /** Token usage for this turn (prompt + completion). */
  readonly usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };

  /** ISO 8601 timestamp when this turn started. */
  readonly timestamp: string;
}

/**
 * A diagnostic event emitted during message processing.
 * Transports decide how (or whether) to display these.
 */
export type DiagnosticEvent =
  | { readonly kind: 'tool_call'; readonly toolName: string; readonly preview: string }
  | { readonly kind: 'agent_text'; readonly preview: string }
  | { readonly kind: 'step_finish'; readonly stepIndex: number }
  | {
      readonly kind: 'loop_detection';
      readonly action: 'warn' | 'block';
      readonly category: string;
      readonly message: string;
    }
  | { readonly kind: 'result_truncation'; readonly originalKB: number; readonly finalKB: number }
  | {
      readonly kind: 'budget_warning';
      readonly dimension: string;
      readonly percentUsed: number;
      readonly message: string;
    }
  | { readonly kind: 'budget_exhausted'; readonly dimension: string; readonly message: string }
  | {
      readonly kind: 'message_compaction';
      readonly originalMessageCount: number;
      readonly newMessageCount: number;
      readonly summaryPreview: string;
    };

/**
 * Budget status: current consumption snapshot plus configured limits.
 * Exposed to transports for the /budget command and end-of-session summary.
 */
export interface BudgetStatus {
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalTokens: number;
  readonly stepCount: number;
  readonly elapsedSeconds: number;
  readonly estimatedCostUsd: number;
  readonly limits: ResolvedResourceBudgetConfig;
  readonly cumulative: CumulativeBudgetSnapshot;

  /** False for Docker sessions where token usage is not observable. */
  readonly tokenTrackingAvailable: boolean;
}

/**
 * Read-only snapshot of session state. Exposed to transports
 * and external observers without giving them mutation access.
 */
export interface SessionInfo {
  readonly id: SessionId;
  readonly status: SessionStatus;
  readonly turnCount: number;
  readonly createdAt: string;
}

/**
 * Factory function for creating sandbox instances.
 * The default creates a real Sandbox wrapping UTCP Code Mode's V8 isolate.
 * Tests provide a factory returning a mock.
 */
export type SandboxFactory = (config: IronCurtainConfig) => Promise<Sandbox>;

/**
 * Escalation request data surfaced to the transport.
 * Decoupled from ToolCallRequest to avoid leaking internal types
 * to transport implementations.
 */
export interface EscalationRequest {
  /** Unique ID for this escalation, used to match approve/deny responses. */
  readonly escalationId: string;
  readonly toolName: string;
  readonly serverName: string;
  readonly arguments: Record<string, unknown>;
  readonly reason: string;
}

/**
 * Options for creating a session. Extends the base config with
 * session-specific overrides.
 */
export interface SessionOptions {
  /** Base configuration. If omitted, loaded from environment. */
  config?: IronCurtainConfig;

  /**
   * Session mode selection. Defaults to 'builtin' for backward compatibility.
   * When 'docker', the agent field specifies which external agent to run.
   */
  mode?: SessionMode;

  /** If provided, reuses the sandbox from this previous session via symlink. */
  resumeSessionId?: string;

  /**
   * Maximum number of messages to retain in history before pruning.
   * Defined as an extension point but not enforced in the initial
   * implementation. When the context window is exceeded,
   * generateText() throws and the error propagates to the transport.
   */
  maxHistoryMessages?: number;

  /**
   * Factory for creating sandbox instances.
   * Default: creates a real Sandbox (UTCP Code Mode V8 isolate).
   * Tests provide a factory returning a mock.
   */
  sandboxFactory?: SandboxFactory;

  /**
   * Callback invoked when the proxy surfaces an escalation.
   * The transport uses this to notify the user and collect approval.
   * If not provided, escalations are auto-denied.
   */
  onEscalation?: (request: EscalationRequest) => void;

  /**
   * Callback invoked when a pending escalation expires (proxy timed out).
   * The transport uses this to clear the escalation banner and notify the user.
   */
  onEscalationExpired?: () => void;

  /**
   * Callback invoked during message processing with diagnostic events.
   * Transports use this to display progress (e.g., tool call previews).
   * If not provided, diagnostics are silently dropped.
   */
  onDiagnostic?: (event: DiagnosticEvent) => void;
}

/**
 * The core session contract. A session is a stateful conversation
 * that owns its sandbox, policy engine, and message history.
 *
 * Invariants:
 * - sendMessage() can only be called when status is 'ready'
 * - sendMessage() is not reentrant (status transitions to 'processing')
 * - After close(), no methods except getInfo() are valid
 * - The session ID is unique and immutable for the session's lifetime
 */
export interface Session {
  /** Returns a read-only snapshot of session state. */
  getInfo(): SessionInfo;

  /**
   * Sends a user message and returns the agent's response.
   *
   * Appends the user message to conversation history, calls the LLM
   * with the full history, appends the response messages, and returns
   * the agent's text.
   *
   * @throws {SessionNotReadyError} if status is not 'ready'
   * @throws {SessionClosedError} if session has been closed
   */
  sendMessage(userMessage: string): Promise<string>;

  /**
   * Returns the conversation history as turn summaries.
   * Does not expose raw ModelMessage[] to avoid coupling
   * callers to the AI SDK's internal message format.
   */
  getHistory(): readonly ConversationTurn[];

  /**
   * Returns accumulated diagnostic events from all turns.
   * Transports can use this for a /logs command or similar.
   */
  getDiagnosticLog(): readonly DiagnosticEvent[];

  /**
   * Resolves a pending escalation. Called by the transport
   * when the user approves or denies via a slash command.
   *
   * Writes the response to the escalation directory so the
   * proxy process can pick it up and continue.
   *
   * @throws {Error} if no escalation with this ID is pending
   */
  resolveEscalation(escalationId: string, decision: 'approved' | 'denied'): Promise<void>;

  /**
   * Returns any currently pending escalation, or undefined.
   */
  getPendingEscalation(): EscalationRequest | undefined;

  /**
   * Returns current resource budget consumption and configured limits.
   * Used by transports for /budget display and end-of-session summary.
   */
  getBudgetStatus(): BudgetStatus;

  /**
   * Releases all session resources: sandbox, MCP connections,
   * audit log, escalation directory. Idempotent -- safe to call
   * multiple times. After close(), status becomes 'closed'.
   */
  close(): Promise<void>;
}
