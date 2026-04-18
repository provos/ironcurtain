/**
 * ToolCallCoordinator -- The single host-side owner of the policy gate.
 *
 * Centralizes the full tool-call pipeline (validation, normalization,
 * policy evaluation, escalation, circuit breaking, dispatch, audit) into
 * a single process-local class.
 *
 * The coordinator holds two mutexes:
 *   - tool-call mutex: serializes concurrent `handleToolCall` invocations
 *     so the three in-memory caches (approval whitelist, circuit breaker,
 *     server-context map) cannot race against each other.
 *   - policy mutex: placeholder for policy hot-swap. Not currently wired
 *     into any mutator.
 *
 * Subprocesses spawned by `MCPClientManager` are pure MCP relays that
 * forward calls to the real backend without any policy evaluation.
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
import { loadPersonaPolicyArtifacts } from '../config/index.js';
import { proxyAnnotations, proxyPolicyRules } from '../docker/proxy-tools.js';
import { ControlServer, type ControlServerAddress, type ControlServerListenOptions } from './control-server.js';

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
  /**
   * Optional HTTP control server endpoint. When supplied, `start()`
   * binds a small JSON API that the workflow orchestrator uses to
   * hot-swap policy between state transitions (§4 of the
   * workflow-container-lifecycle design). When omitted, no server is
   * started -- standalone sessions (CLI, daemon, cron) do not use this
   * channel and must not pay for it.
   *
   * Exactly one of `socketPath` / `port` may be set (same contract as
   * `ControlServer.start`).
   */
  readonly controlServerListen?: ControlServerListenOptions;
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
  private auditLog: AuditLog;
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
  // Retained so `loadPolicy` can reconstruct the policy engine with the
  // same per-session invariants (these do not change between personas).
  private readonly protectedPaths: string[];
  private readonly serverDomainAllowlists: ReadonlyMap<string, readonly string[]>;
  private readonly trustedServers: ReadonlySet<string>;
  /**
   * Tool annotations retained for policy hot-swap. Persona policy
   * directories only ship `compiled-policy.json` (+ optional
   * `dynamic-lists.json`); annotations are globally scoped and do not
   * change when the persona swaps. `loadPolicy` reuses this object
   * verbatim when constructing the replacement `PolicyEngine`.
   *
   * This field already has proxy annotations merged in (if the caller
   * did so at construction time); `loadPolicy` therefore does not need
   * to re-merge them.
   */
  private readonly toolAnnotations: StoredToolAnnotationsFile;

  /** Control server (workflow mode only). */
  private readonly controlServer: ControlServer | null;
  private readonly controlServerListen?: ControlServerListenOptions;
  private controlServerAddress: ControlServerAddress | null = null;
  /**
   * Most recent user message. Set by `setLastUserMessage` and threaded
   * into the auto-approver when set. Mutable so callers can update it
   * across turns without reconstructing the coordinator.
   */
  private lastUserMessage: string | null = null;

  /** Tool registry keyed by tool name. */
  private readonly toolMap = new Map<string, CoordinatorTool>();
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

    // Retain per-session invariants so `loadPolicy` can reconstruct the
    // PolicyEngine with the same arguments it was first built with --
    // only the compiled rules / dynamic lists change. Annotations are
    // globally scoped (not shipped in per-persona policy dirs); retain
    // them here so `loadPolicy` does not attempt to re-read them.
    this.protectedPaths = options.protectedPaths;
    this.serverDomainAllowlists = options.serverDomainAllowlists ?? new Map();
    this.trustedServers = options.trustedServers ?? new Set();
    this.toolAnnotations = options.toolAnnotations;

    this.controlServerListen = options.controlServerListen;
    this.controlServer = this.controlServerListen
      ? new ControlServer({
          onLoadPolicy: (req) => this.loadPolicy(req),
        })
      : null;
  }

  getMcpManager(): MCPClientManager {
    return this.mcpManager;
  }

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
    for (const tool of tools) {
      this.toolMap.set(`${serverName}__${tool.name}`, tool);
    }
    if (clientState) {
      this.clientStates.set(serverName, clientState);
    }
  }

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
   * @param serverName - the MCP server that owns the tool
   * @param toolName - the bare tool name (e.g. `read_file`, not `filesystem__read_file`)
   * @param rawArgs - the tool's arguments
   */
  async handleToolCall(
    serverName: string,
    toolName: string,
    rawArgs: Record<string, unknown>,
  ): Promise<ToolCallResponse> {
    const key = `${serverName}__${toolName}`;
    return this.callMutex.withLock(async () => {
      const deps = this.buildCallToolDeps();
      return handleCallTool(key, rawArgs, deps);
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
    const key = `${request.serverName}__${request.toolName}`;
    const synthetic: CoordinatorTool | null = this.toolMap.has(key)
      ? null
      : {
          serverName: request.serverName,
          name: request.toolName,
          inputSchema: {},
        };

    const response = await this.callMutex.withLock(async () => {
      const deps = this.buildCallToolDeps(synthetic);
      // Preserve the caller's requestId/timestamp so audit entries
      // correlate with caller-side tracing. Low-level UTCP callers
      // route through `handleToolCall` below, which omits this.
      return handleCallTool(key, request.arguments, deps, {
        requestId: request.requestId,
        timestamp: request.timestamp,
      });
    });

    const isError = response.isError === true;
    // The pipeline always stamps `_policyDecision` on its responses, so
    // the decision's own `status` field is the authoritative signal for
    // whether a failure was a policy deny vs. a downstream runtime error.
    // Fall back to 'error' only if the decision is missing entirely.
    const status: ToolCallResult['status'] = isError
      ? response._policyDecision?.status === 'deny'
        ? 'denied'
        : 'error'
      : 'success';

    const policyDecision: PolicyDecision = response._policyDecision ?? {
      status: 'allow',
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
    const toolMap = syntheticTool
      ? new Map([...this.toolMap, [`${syntheticTool.serverName}__${syntheticTool.name}`, syntheticTool]])
      : this.toolMap;

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
   * Hot-swap the policy engine and rotate the audit log.
   *
   * Invariants (from §2.1 and §4 "Audit writer concurrency"):
   *
   *   1. Acquire the call mutex first so every in-flight `handleToolCall`
   *      finishes under the old policy before we swap. New callers queue
   *      up on the mutex and start under the new policy.
   *   2. Acquire the policy mutex next to serialize against overlapping
   *      `loadPolicy` calls.
   *   3. Load + construct the new engine BEFORE rotating the audit log.
   *      If the new policy dir is missing or malformed, we abort with the
   *      old engine and old audit stream still fully intact -- callers
   *      can keep running under the previous persona's policy until they
   *      decide to tear down.
   *   4. Only after the new engine is ready do we rotate audit and swap
   *      the engine reference. The order is: rotate audit, then swap
   *      engine. The rotate-first ordering guarantees that the first
   *      log entry written under the new engine lands in the new file.
   *   5. On any failure in steps 3-4, propagate the error without
   *      touching the old engine or old audit stream.
   *
   * Note on the `AuditLogTailer`: session-scoped tailers attached to the
   * previous persona's audit file do not need to be re-pointed here.
   * `DockerAgentSession` creates a fresh tailer per state pointing at
   * whatever audit path was configured for that state, and stops the
   * previous tailer in `close()` before the next state starts. By the
   * time `loadPolicy` runs in a workflow, the old session's tailer is
   * already stopped.
   */
  async loadPolicy(req: { persona: string; version: number; policyDir: string; auditPath: string }): Promise<void> {
    // Wait for any in-flight tool call to drain, then serialize against
    // concurrent loadPolicy. The two mutexes are acquired in this order
    // (call, then policy) everywhere; deadlock is impossible because no
    // other code path acquires them in reverse.
    await this.callMutex.withLock(async () => {
      await this.policyMutex.withLock(async () => {
        // Step 1: load only the per-persona artifacts (compiled policy
        // + optional dynamic lists). Annotations are globally scoped
        // and were retained at construction time -- persona dirs do
        // not ship `tool-annotations.json`. If any required file is
        // missing, the loader throws and we surface that to the caller
        // without touching the live engine.
        const { compiledPolicy, dynamicLists } = loadPersonaPolicyArtifacts(req.policyDir);

        // Step 2: re-merge the virtual proxy tool annotations and
        // rules. The sandbox does this at construction time
        // (src/sandbox/index.ts:581-585); a persona-swapped policy
        // must re-apply the same merge or the new engine will treat
        // `add_proxy_domain` / `remove_proxy_domain` /
        // `list_proxy_domains` as unknown tools.
        //
        // The merge is idempotent: `proxy` is a reserved server name
        // (RESERVED_SERVER_NAMES) so overwriting it on each load is
        // always correct, even if the caller already merged at
        // construction time.
        const mergedAnnotations = mergeProxyAnnotations(this.toolAnnotations);
        compiledPolicy.rules = [...proxyPolicyRules, ...compiledPolicy.rules];

        // Step 3: build the replacement engine using the retained +
        // proxy-merged annotations. A synchronous construction failure
        // (malformed policy) propagates out below without touching
        // `this.policyEngine` or `this.auditLog`.
        const nextEngine = new PolicyEngine(
          compiledPolicy,
          mergedAnnotations,
          this.protectedPaths,
          this.allowedDirectory,
          this.serverDomainAllowlists,
          dynamicLists,
          this.trustedServers,
        );

        // Step 4: rotate audit. `AuditLog.rotate` constructs the new
        // stream FIRST so a synchronous failure here leaves the old
        // stream intact. If rotate throws, the old engine reference is
        // untouched (we have not yet swapped) and the old audit stream
        // is still usable -- callers can keep running under the
        // previous persona's policy. Its contract is that the caller
        // serializes `log/rotate/close`, which we do by holding the
        // policy mutex.
        await this.auditLog.rotate(req.auditPath);

        // Step 5: swap the engine reference. All subsequent calls --
        // queued behind the call mutex, or started after we release --
        // evaluate under the new engine.
        this.policyEngine = nextEngine;
      });
    });
  }

  /**
   * Starts the HTTP control server if one was configured via
   * `controlServerListen`. Safe to call when no server is configured
   * (becomes a no-op). Idempotent: calling twice on a configured
   * coordinator is an error.
   */
  async start(): Promise<ControlServerAddress | null> {
    if (!this.controlServer || !this.controlServerListen) return null;
    if (this.controlServerAddress) {
      throw new Error('ToolCallCoordinator.start() called twice');
    }
    this.controlServerAddress = await this.controlServer.start(this.controlServerListen);
    return this.controlServerAddress;
  }

  /** Returns the bound control server address, or null if not started. */
  getControlServerAddress(): ControlServerAddress | null {
    return this.controlServerAddress;
  }

  /** Releases all held resources (MCP subprocesses, audit stream, control server). */
  async close(): Promise<void> {
    // Stop the control server first so no new loadPolicy requests can
    // arrive while we're tearing down the underlying components.
    if (this.controlServer && this.controlServerAddress) {
      await this.controlServer.stop();
      this.controlServerAddress = null;
    }

    // Drain any in-flight tool call or `loadPolicy` handler before we
    // close the audit log. Stopping the control server above only
    // prevents NEW control requests -- a handler already inside
    // `loadPolicy` (mid-rotate) or a tool call already inside
    // `handleCallTool` (writing to audit) continues to run against the
    // coordinator's state. Acquiring both mutexes in the same order
    // used elsewhere (call, then policy) guarantees those handlers
    // complete before we tear the audit log out from under them; no
    // deadlock risk because no code path takes these in reverse.
    await this.callMutex.withLock(async () => {
      await this.policyMutex.withLock(async () => {
        // Mutexes held — no loadPolicy/handleCallTool can be in flight.
      });
    });

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
 * Returns a shallow-cloned annotations file with the virtual `proxy`
 * server entry overwritten. Mirrors the merge the sandbox performs at
 * construction time so hot-swapped persona policies can evaluate the
 * virtual proxy tools without the caller re-merging.
 *
 * The clone is shallow (copy the `servers` map, keep per-server tool
 * arrays by reference): we only need to replace the `proxy` slot, and
 * the engine does not mutate any other server's tool arrays.
 */
function mergeProxyAnnotations(src: StoredToolAnnotationsFile): StoredToolAnnotationsFile {
  return {
    ...src,
    servers: {
      ...src.servers,
      proxy: {
        inputHash: 'hardcoded',
        tools: proxyAnnotations,
      },
    },
  };
}
