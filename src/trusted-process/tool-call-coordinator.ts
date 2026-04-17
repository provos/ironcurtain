/**
 * ToolCallCoordinator -- The single host-side owner of the policy gate.
 *
 * Centralizes the full tool-call pipeline (validation, normalization,
 * policy evaluation, escalation, circuit breaking, dispatch, audit) into
 * a single process-local class. Replaces the per-subprocess copies of
 * PolicyEngine, AuditLog, CallCircuitBreaker, ApprovalWhitelist, and
 * ServerContextMap that used to live in each mcp-proxy-server.ts
 * subprocess.
 *
 * The coordinator holds two mutexes:
 *   - tool-call mutex: serializes concurrent `handleToolCall` invocations
 *     so the three in-memory caches (approval whitelist, circuit breaker,
 *     server-context map) cannot race against each other.
 *   - policy mutex: reserved for future `loadPolicy` swaps (§2.2). Not
 *     currently wired into any mutator; present so upstream code can rely
 *     on its existence for Step 2.
 *
 * Subprocesses spawned by `MCPClientManager` are pure MCP relays that
 * forward calls to the real backend without any policy evaluation.
 *
 * See `docs/designs/workflow-container-lifecycle.md` §2.1 for the full
 * design.
 */

import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { CompiledPolicyFile, DynamicListsFile, StoredToolAnnotationsFile } from '../pipeline/types.js';
import type { ToolCallRequest, ToolCallResult, PolicyDecision } from '../types/mcp.js';
import { AuditLog } from './audit-log.js';
import { PolicyEngine } from './policy-engine.js';
import { MCPClientManager } from './mcp-client-manager.js';
import { CallCircuitBreaker } from './call-circuit-breaker.js';
import { createApprovalWhitelist, type ApprovalWhitelist, type WhitelistCandidateIpc } from './approval-whitelist.js';
import { type ServerContextMap } from './server-context.js';
import { AsyncMutex } from './async-mutex.js';
import type { ControlApiClient } from '../docker/proxy-tools.js';
import {
  handleCallTool,
  extractTextFromContent,
  type CallToolDeps,
  type ClientState,
  type InProcessEscalationFn,
  type ProxiedTool,
  type ToolCallResponse,
} from './tool-call-pipeline.js';
import type { ResolvedSandboxConfig } from './sandbox-integration.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result from an escalation callback, optionally including whitelist selection.
 * Mirrors the `EscalationResult` shape used by `TrustedProcess`.
 */
export interface EscalationResult {
  readonly decision: 'approved' | 'denied';
  /** Index into whitelistCandidates to whitelist. Absent = no whitelisting. */
  readonly whitelistSelection?: number;
}

/**
 * Callback invoked by the coordinator when policy decides to escalate and
 * neither the whitelist nor the auto-approver resolved the request.
 *
 * Not used directly by `handleCallTool` in Step 1 (that path consumes the
 * file-IPC directory). Kept for parity with `TrustedProcess` and for
 * future wiring into in-process escalation hooks.
 */
export type EscalationPromptFn = (
  request: ToolCallRequest,
  reason: string,
  context?: Readonly<Record<string, string>>,
  whitelistCandidates?: readonly WhitelistCandidateIpc[],
) => Promise<EscalationResult>;

/**
 * Configuration for the coordinator. All fields are read-only after
 * construction.
 */
export interface ToolCallCoordinatorOptions {
  readonly compiledPolicy: CompiledPolicyFile;
  readonly toolAnnotations: StoredToolAnnotationsFile;
  readonly protectedPaths: string[];
  readonly allowedDirectory?: string;
  readonly serverDomainAllowlists?: ReadonlyMap<string, readonly string[]>;
  readonly dynamicLists?: DynamicListsFile;
  readonly trustedServers?: ReadonlySet<string>;
  /** Path where audit entries are appended. */
  readonly auditLogPath: string;
  /** Whether to redact PII/credentials before writing. */
  readonly auditRedact?: boolean;
  /** Auto-approval model (null = disabled). */
  readonly autoApproveModel?: LanguageModelV3 | null;
  /** Directory for file-based escalation IPC (used by file-IPC callers). */
  readonly escalationDir?: string;
  /**
   * In-process escalation callback. When set, supersedes the
   * file-IPC escalation path. The callback receives the synthesized
   * `ToolCallRequest`, the reason, server context, and any whitelist
   * candidates the coordinator extracted.
   */
  readonly onEscalation?: EscalationPromptFn;
  /** Control API client for virtual proxy tools (Docker Agent Mode only). */
  readonly controlApiClient?: ControlApiClient | null;
  /**
   * Pre-existing `MCPClientManager` to use for dispatch. When omitted a new
   * one is constructed internally. Tests inject a mock here.
   */
  readonly mcpManager?: MCPClientManager;
  /**
   * Resolved sandbox configs per server. Used by `handleCallTool` to
   * annotate audit entries with `sandboxed=true` when applicable.
   * Optional; coordinator supplies an empty map when absent.
   */
  readonly resolvedSandboxConfigs?: Map<string, ResolvedSandboxConfig>;
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

/** Shape of a tool registered with the coordinator. */
export type CoordinatorTool = ProxiedTool;

export class ToolCallCoordinator {
  private readonly policyMutex = new AsyncMutex();
  private readonly callMutex = new AsyncMutex();

  private policyEngine: PolicyEngine;
  private readonly auditLog: AuditLog;
  private readonly circuitBreaker: CallCircuitBreaker;
  private readonly whitelist: ApprovalWhitelist;
  private readonly serverContextMap: ServerContextMap = new Map();
  private readonly mcpManager: MCPClientManager;
  private readonly ownedMcpManager: boolean;
  private readonly resolvedSandboxConfigs: Map<string, ResolvedSandboxConfig>;
  private readonly autoApproveModel: LanguageModelV3 | null;
  private readonly escalationDir?: string;
  private readonly onEscalation?: EscalationPromptFn;
  private readonly controlApiClient: ControlApiClient | null;
  private readonly allowedDirectory?: string;
  /**
   * Most recent user message. Set by `setLastUserMessage` and threaded
   * into the auto-approver when set. Mutable so callers can update it
   * across turns without reconstructing the coordinator.
   */
  private lastUserMessage: string | null = null;

  /** Tool registry keyed by tool name. */
  private readonly toolMap = new Map<string, CoordinatorTool>();
  /** Tracks tools per backend server. */
  private readonly toolsByServer = new Map<string, CoordinatorTool[]>();
  /** Client states used for roots expansion on escalation. */
  private readonly clientStates = new Map<string, ClientState>();

  constructor(options: ToolCallCoordinatorOptions) {
    this.policyEngine = new PolicyEngine(
      options.compiledPolicy,
      options.toolAnnotations,
      options.protectedPaths,
      options.allowedDirectory,
      options.serverDomainAllowlists,
      options.dynamicLists,
      options.trustedServers,
    );
    this.auditLog = new AuditLog(options.auditLogPath, {
      redact: options.auditRedact === true,
    });
    this.circuitBreaker = new CallCircuitBreaker();
    this.whitelist = createApprovalWhitelist();
    this.autoApproveModel = options.autoApproveModel ?? null;
    this.escalationDir = options.escalationDir;
    this.onEscalation = options.onEscalation;
    this.controlApiClient = options.controlApiClient ?? null;
    this.allowedDirectory = options.allowedDirectory;
    this.resolvedSandboxConfigs = options.resolvedSandboxConfigs ?? new Map<string, ResolvedSandboxConfig>();

    if (options.mcpManager) {
      this.mcpManager = options.mcpManager;
      this.ownedMcpManager = false;
    } else {
      this.mcpManager = new MCPClientManager();
      this.ownedMcpManager = true;
    }
  }

  /** Exposes the internal `MCPClientManager` for wiring (subprocess setup). */
  getMcpManager(): MCPClientManager {
    return this.mcpManager;
  }

  /** Exposes the internal `PolicyEngine` for read-only callers. */
  getPolicyEngine(): PolicyEngine {
    return this.policyEngine;
  }

  /**
   * Registers the tools a backend server exposes. Called after the
   * subprocess has connected and listed tools.
   *
   * Optionally associates a `ClientState` with the server so escalation
   * root expansion can reach the MCP client (used by the Sandbox wiring
   * for real subprocess clients).
   */
  registerTools(serverName: string, tools: CoordinatorTool[], clientState?: ClientState): void {
    const list: CoordinatorTool[] = [];
    for (const tool of tools) {
      this.toolMap.set(tool.name, tool);
      list.push(tool);
    }
    this.toolsByServer.set(serverName, list);
    if (clientState) {
      this.clientStates.set(serverName, clientState);
    }
  }

  /** Returns all registered tools (for catalog/help construction). */
  getRegisteredTools(): CoordinatorTool[] {
    return [...this.toolMap.values()];
  }

  /** Associates a `ClientState` with a server (roots-expansion path). */
  setClientState(serverName: string, state: ClientState): void {
    this.clientStates.set(serverName, state);
  }

  /** Associates a resolved sandbox config with a server (audit `sandboxed` flag). */
  setResolvedSandboxConfig(serverName: string, config: ResolvedSandboxConfig): void {
    this.resolvedSandboxConfigs.set(serverName, config);
  }

  // ---------------------------------------------------------------------
  // Tool-call pipeline
  // ---------------------------------------------------------------------

  /**
   * Handles a single tool call end-to-end. Serialized by the tool-call
   * mutex so the coordinator-owned caches remain consistent under
   * concurrent callers.
   *
   * Accepts the low-level `(toolName, rawArgs)` pair. Returns the MCP
   * response shape (`content`, `isError`). For the structured
   * `ToolCallResult` form, use `handleStructuredToolCall`.
   */
  async handleToolCall(toolName: string, rawArgs: Record<string, unknown>): Promise<ToolCallResponse> {
    return this.callMutex.withLock(async () => {
      const deps = this.buildCallToolDeps();
      return handleCallTool(toolName, rawArgs, deps);
    });
  }

  /**
   * Structured entry point matching the shape used by in-process
   * `TrustedProcess` callers (returns `ToolCallResult`).
   *
   * The `policyDecision` on the returned result is sourced from the
   * coordinator-internal `_policyDecision` field on the response when
   * present (always, in practice -- `handleCallTool` stamps it). Falls
   * back to a synthesized value if the field is missing.
   */
  async handleStructuredToolCall(request: ToolCallRequest): Promise<ToolCallResult> {
    const startTime = Date.now();

    // Structured callers supply (serverName, toolName). If the tool
    // isn't registered, pass a per-call augmented lookup so
    // `handleCallTool` can route through the policy engine (which
    // will report `missing-annotation` via the normal path). Without
    // this, the coordinator would short-circuit with `unknown-tool`,
    // losing the existing semantics that in-process callers rely on.
    //
    // The synthetic entry is scoped to this invocation only -- it is
    // never persisted in `this.toolMap`, which would cause unbounded
    // growth and cross-server collisions when two servers expose the
    // same tool name.
    const synthetic: CoordinatorTool | null = this.toolMap.has(request.toolName)
      ? null
      : {
          serverName: request.serverName,
          name: request.toolName,
          inputSchema: {},
        };

    const response = await this.callMutex.withLock(async () => {
      const deps = this.buildCallToolDeps(synthetic);
      return handleCallTool(request.toolName, request.arguments, deps);
    });

    const isError = response.isError === true;
    const status: ToolCallResult['status'] = isError ? extractStatusFromErrorContent(response.content) : 'success';

    const policyDecision: PolicyDecision = response._policyDecision ?? {
      status: isError ? (status === 'denied' ? 'deny' : 'allow') : 'allow',
      rule: 'synthesized',
      reason: extractTextFromContent(response.content) ?? (isError ? 'error' : 'ok'),
    };

    return {
      requestId: request.requestId,
      status,
      content: response.content,
      policyDecision,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Builds the `CallToolDeps` snapshot consumed by `handleCallTool`.
   *
   * When `syntheticTool` is provided, it is overlaid on the real
   * toolMap for this single call only. Callers that need to route a
   * structured request for an unregistered tool through the policy
   * engine use this to avoid mutating the coordinator's long-lived
   * tool registry.
   */
  private buildCallToolDeps(syntheticTool: CoordinatorTool | null = null): CallToolDeps {
    // Capture the callback reference once to narrow the type, then
    // adapt it to the shape handleCallTool expects.
    const escalationFn = this.onEscalation;
    const onEscalation: InProcessEscalationFn | undefined = escalationFn
      ? async (req, reason, ctx, candidates) => escalationFn(req, reason, ctx, candidates)
      : undefined;

    // When a synthetic entry is provided, construct a fresh map that
    // overlays it on the real registry. The overlay is local to this
    // call; it never mutates `this.toolMap`. Without a synthetic
    // entry, reuse the real map directly to avoid per-call copies.
    const toolMap = syntheticTool ? new Map([...this.toolMap, [syntheticTool.name, syntheticTool]]) : this.toolMap;

    return {
      toolMap,
      policyEngine: this.policyEngine,
      auditLog: this.auditLog,
      circuitBreaker: this.circuitBreaker,
      clientStates: this.clientStates,
      resolvedSandboxConfigs: this.resolvedSandboxConfigs,
      allowedDirectory: this.allowedDirectory,
      escalationDir: this.escalationDir,
      autoApproveModel: this.autoApproveModel,
      serverContextMap: this.serverContextMap,
      whitelist: this.whitelist,
      controlApiClient: this.controlApiClient,
      onEscalation,
      autoApproveUserMessage: this.lastUserMessage ?? undefined,
    };
  }

  /**
   * Sets the most recent user message used by the auto-approver. Called
   * by session layers before each agent turn so auto-approval sees the
   * current prompt context. Setting `null` clears the value.
   */
  setLastUserMessage(message: string | null): void {
    this.lastUserMessage = message;
  }

  /**
   * Swap the policy engine and rotate the audit log. Reserved for
   * Step 2; currently a stub so upstream control-socket wiring can
   * compile. The policy mutex is not acquired here because there is
   * nothing to protect yet -- Step 2 will introduce the guarded swap.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- Step 2 impl will be async; stub throws synchronously
  async loadPolicy(req: { persona: string; version: number; policyDir: string; auditPath: string }): Promise<void> {
    // Reference the arg so lint doesn't flag it; Step 2 will use it.
    void req;
    throw new Error('ToolCallCoordinator.loadPolicy is not implemented in Step 1.');
  }

  /** Releases all held resources (MCP subprocesses, audit stream). */
  async close(): Promise<void> {
    if (this.ownedMcpManager) {
      await this.mcpManager.closeAll();
    }
    await this.auditLog.close();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Infers a `ToolCallResult.status` from an error response's text.
 * Used by `handleStructuredToolCall` to distinguish `denied` from `error`.
 */
function extractStatusFromErrorContent(content: unknown): 'denied' | 'error' {
  const text = extractTextFromContent(content) ?? '';
  if (
    text.startsWith('DENIED:') ||
    text.startsWith('ESCALATION REQUIRED:') ||
    text.startsWith('ESCALATION DENIED:') ||
    text.startsWith('CIRCUIT BREAKER:')
  ) {
    return 'denied';
  }
  if (text.startsWith('Unknown argument(s):') || text.startsWith('Missing annotation for tool:')) {
    return 'denied';
  }
  return 'error';
}
