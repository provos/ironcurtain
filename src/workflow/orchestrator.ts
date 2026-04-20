import {
  readFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { MessageLog } from './message-log.js';
import { createHash, type Hash } from 'node:crypto';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import * as http from 'node:http';
import { createActor, fromPromise, type AnyActorRef, type Snapshot } from 'xstate';
import type {
  WorkflowId,
  WorkflowDefinition,
  WorkflowContext,
  WorkflowStatus,
  WorkflowResult,
  WorkflowCheckpoint,
  WorkflowEvent,
  TransitionRecord,
  HumanGateRequest,
  HumanGateEvent,
  HumanGateStateDefinition,
  AgentStateDefinition,
  DeterministicStateDefinition,
  AgentOutput,
} from './types.js';
import { createWorkflowId, WORKFLOW_ARTIFACT_DIR, GLOBAL_PERSONA } from './types.js';
import {
  getWorkflowAuditLogPath,
  getWorkflowProxyControlSocketPath,
  getWorkflowBundleDir,
  getWorkflowStateDir,
} from '../config/paths.js';
import { POLICY_LOAD_PATH } from '../trusted-process/control-server.js';
import { loadConfig } from '../config/index.js';
import { getPersonaDefinitionPath, resolvePersona } from '../persona/resolve.js';
import { createPersonaName } from '../persona/types.js';
import type { Session, SessionId, SessionOptions, SessionMode } from '../session/types.js';
import type { AgentId } from '../docker/agent-adapter.js';
import type { DockerInfrastructure } from '../docker/docker-infrastructure.js';
import {
  buildWorkflowMachine,
  type AgentInvokeInput,
  type AgentInvokeResult,
  type DeterministicInvokeInput,
  type DeterministicInvokeResult,
} from './machine-builder.js';
import type { CheckpointStore } from './checkpoint.js';
import {
  parseAgentStatus,
  AgentStatusParseError,
  buildStatusBlockReprompt,
  getValidVerdicts,
  buildInvalidVerdictReprompt,
} from './status-parser.js';
import { buildAgentCommand, buildArtifactReprompt, buildStatusInstructions } from './prompt-builder.js';
import { collectFilesRecursive, hasAnyFiles, snapshotArtifacts } from './artifacts.js';
import { validateDefinition } from './validate.js';
import { parseDefinitionFile } from './discovery.js';

const execFileAsync = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Transition message truncation
// ---------------------------------------------------------------------------

const MAX_TRANSITION_MESSAGE_BYTES = 4096;
const TRANSITION_TRUNCATION_NOTICE = '\n\n[... truncated]';

/**
 * Default timeout for a `loadPolicy` RPC to the workflow coordinator.
 * Generous because the coordinator's mutex may be held briefly by an
 * in-flight tool call; tight because "control socket unreachable" must
 * surface fast rather than wedge the workflow.
 */
const LOAD_POLICY_RPC_TIMEOUT_MS = 10_000;

function truncateForTransition(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  if (Buffer.byteLength(text, 'utf-8') <= MAX_TRANSITION_MESSAGE_BYTES) {
    return text;
  }
  const noticeBudget = MAX_TRANSITION_MESSAGE_BYTES - Buffer.byteLength(TRANSITION_TRUNCATION_NOTICE, 'utf-8');
  let truncated = text;
  while (Buffer.byteLength(truncated, 'utf-8') > noticeBudget) {
    truncated = truncated.slice(0, Math.floor(truncated.length * 0.9));
  }
  return truncated + TRANSITION_TRUNCATION_NOTICE;
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parses an agent_status block into one of three explicit states: `ok` with the
 * parsed output, `missing` when no block was present, or `malformed` when a
 * block was present but failed YAML or schema validation. Callers branch on the
 * `kind` discriminator to decide whether to retry, abort, or proceed.
 */
type ParseResult =
  | { kind: 'ok'; output: AgentOutput }
  | { kind: 'missing' }
  | { kind: 'malformed'; error: AgentStatusParseError };

function tryParseAgentStatus(responseText: string): ParseResult {
  try {
    const output = parseAgentStatus(responseText);
    return output ? { kind: 'ok', output } : { kind: 'missing' };
  } catch (err) {
    if (err instanceof AgentStatusParseError) {
      return { kind: 'malformed', error: err };
    }
    throw err;
  }
}

/**
 * Writes directly to process.stderr, bypassing any console hijacking
 * (e.g., logger.setup() redirecting console.error to a file).
 * Used for critical error messages that MUST reach the terminal.
 */
function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Handle for writing to a workflow tab in the mux. */
export interface WorkflowTabHandle {
  write(text: string): void;
  setLabel(label: string): void;
  close(): void;
}

/**
 * Inputs for creating a workflow-scoped Docker infrastructure bundle.
 * Supplied by the orchestrator when `settings.sharedContainer === true`
 * and the workflow uses a Docker agent.
 */
export interface CreateWorkflowInfrastructureInput {
  readonly workflowId: WorkflowId;
  readonly agentId: AgentId;
  /**
   * Path to the workflow's coordinator control socket. The orchestrator
   * starts the coordinator's HTTP control server at this path after the
   * bundle is created (see `startWorkflowControlServer` dep). The path
   * is included here so the factory may optionally pre-create the
   * containing directory or use it for labelling.
   */
  readonly controlSocketPath: string;
  /**
   * Workspace directory for this workflow run. Used as the allowed
   * directory for the filesystem MCP server and all sessions that run
   * in the shared container. Either a user-supplied `--workspace <path>`
   * or the default `<baseDir>/<workflowId>/workspace/`.
   *
   * All sessions in a workflow mount the workflow's workspace directory;
   * no session-scoped sandbox is ever used under shared-container mode.
   */
  readonly workspacePath: string;
}

/** Inputs for starting the coordinator's HTTP control server on a workflow bundle. */
export interface StartWorkflowControlServerInput {
  readonly infra: DockerInfrastructure;
  readonly socketPath: string;
}

/** Inputs for the `loadPolicy` RPC dispatched at each agent state entry. */
export interface LoadPolicyRpcInput {
  readonly socketPath: string;
  readonly persona: string;
  readonly policyDir: string;
  /** Hard timeout in milliseconds; the call aborts if the coordinator does not ack in time. */
  readonly timeoutMs?: number;
}

/** Dependencies injected into the orchestrator. */
export interface WorkflowOrchestratorDeps {
  /** Factory for creating agent sessions. */
  readonly createSession: (options: SessionOptions) => Promise<Session>;

  /** Factory for creating read-only workflow tabs in the mux. */
  readonly createWorkflowTab: (label: string, workflowId: WorkflowId) => WorkflowTabHandle;

  /** Callback to raise a human gate in the mux UI. */
  readonly raiseGate: (gate: HumanGateRequest) => void;

  /** Callback to dismiss a human gate from the mux UI. */
  readonly dismissGate: (workflowId: WorkflowId, gateId: string) => void;

  /** Base directory for workflow artifacts and checkpoints. */
  readonly baseDir: string;

  /** Persistent checkpoint store for workflow resume. */
  readonly checkpointStore: CheckpointStore;

  /**
   * Factory for creating a workflow-scoped Docker infrastructure bundle.
   * Called at workflow start when `settings.sharedContainer === true`
   * and the workflow uses a Docker agent. When omitted, the orchestrator
   * loads the default implementation lazily from `src/docker/docker-infrastructure.ts`.
   * Tests override this to avoid spinning up real Docker resources.
   */
  readonly createWorkflowInfrastructure?: (input: CreateWorkflowInfrastructureInput) => Promise<DockerInfrastructure>;

  /**
   * Teardown counterpart for `createWorkflowInfrastructure`. Called on
   * workflow terminal states, abort, and shutdownAll. When omitted, the
   * orchestrator loads the default implementation lazily from
   * `src/docker/docker-infrastructure.ts`. Tests override this to avoid
   * touching real Docker resources.
   */
  readonly destroyWorkflowInfrastructure?: (infra: DockerInfrastructure) => Promise<void>;

  /**
   * Attaches the coordinator's HTTP control server to the workflow
   * bundle. Called once at workflow start (after the bundle is created)
   * whenever `settings.sharedContainer === true`. The default
   * implementation reaches through `infra.proxy.getPolicySwapTarget()` and
   * calls `startControlServer({ socketPath })`. Tests override this to
   * intercept the control-server wiring entirely.
   */
  readonly startWorkflowControlServer?: (input: StartWorkflowControlServerInput) => Promise<void>;

  /**
   * Dispatches a `POST /__ironcurtain/policy/load` request to the
   * workflow's coordinator control socket. Called before each agent
   * state invocation to rotate the audit stream and swap the active
   * policy. The default implementation speaks HTTP/1.1 over a Unix
   * domain socket (no extra dependency). Tests inject a fake handler
   * to assert on the RPC shape without standing up a real socket.
   */
  readonly loadPolicyRpc?: (input: LoadPolicyRpcInput) => Promise<void>;
}

/** Lifecycle events emitted by the orchestrator. */
export type WorkflowLifecycleEvent =
  | {
      readonly kind: 'started';
      readonly workflowId: WorkflowId;
      readonly name: string;
      readonly taskDescription: string;
    }
  | { readonly kind: 'state_entered'; readonly workflowId: WorkflowId; readonly state: string }
  | { readonly kind: 'completed'; readonly workflowId: WorkflowId }
  | { readonly kind: 'failed'; readonly workflowId: WorkflowId; readonly error: string }
  | { readonly kind: 'gate_raised'; readonly workflowId: WorkflowId; readonly gate: HumanGateRequest }
  | { readonly kind: 'gate_dismissed'; readonly workflowId: WorkflowId; readonly gateId: string }
  | {
      readonly kind: 'agent_started';
      readonly workflowId: WorkflowId;
      readonly state: string;
      readonly persona: string;
      /**
       * Session ID of the agent session. Consumers (e.g. the daemon's
       * token-stream bridge wiring) use this to register the session
       * so token events produced by this agent are routable to
       * `observe --all` subscribers.
       */
      readonly sessionId: SessionId;
    }
  | {
      readonly kind: 'agent_completed';
      readonly workflowId: WorkflowId;
      readonly state: string;
      readonly persona: string;
      readonly verdict: string;
      readonly notes: string;
    }
  /**
   * Emitted unconditionally in the `executeAgentState` finally block --
   * both on success (after `agent_completed`) and on failure (when the
   * agent state threw or the verdict retry failed). Pairs 1:1 with
   * `agent_started` and signals that the session has been closed.
   *
   * Consumers that registered per-agent resources (e.g. token-stream
   * bridge entries) must clean up in response to this event so no
   * state leaks across rapid state transitions.
   */
  | {
      readonly kind: 'agent_session_ended';
      readonly workflowId: WorkflowId;
      readonly state: string;
      readonly persona: string;
      readonly sessionId: SessionId;
    };

/** Extended workflow detail for the web UI. */
export interface WorkflowDetail {
  readonly definition: WorkflowDefinition;
  readonly transitionHistory: readonly TransitionRecord[];
  readonly workspacePath: string;
  readonly context: {
    readonly taskDescription: string;
    readonly round: number;
    readonly maxRounds: number;
    readonly totalTokens: number;
    readonly visitCounts: Record<string, number>;
  };
}

/** The narrow controller interface exposed to the mux. */
export interface WorkflowController {
  start(definitionPath: string, taskDescription: string, workspacePath?: string): Promise<WorkflowId>;
  resume(workflowId: WorkflowId): Promise<void>;
  listResumable(): WorkflowId[];
  getStatus(id: WorkflowId): WorkflowStatus | undefined;
  getDetail(id: WorkflowId): WorkflowDetail | undefined;
  listActive(): readonly WorkflowId[];
  resolveGate(id: WorkflowId, event: HumanGateEvent): void;
  abort(id: WorkflowId): Promise<void>;
  onEvent(callback: (event: WorkflowLifecycleEvent) => void): void;
  shutdownAll(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface WorkflowInstance {
  readonly id: WorkflowId;
  readonly definition: WorkflowDefinition;
  readonly definitionPath: string;
  readonly actor: AnyActorRef;
  readonly gateStateNames: ReadonlySet<string>;
  readonly terminalStateNames: ReadonlySet<string>;
  readonly activeSessions: Set<Session>;
  readonly artifactDir: string;
  /**
   * Root directory where the agent session operates.
   * Either a fresh directory created by the orchestrator
   * or a user-provided path via --workspace.
   */
  readonly workspacePath: string;
  readonly tab: WorkflowTabHandle;
  /** Accumulated transition records for checkpointing. */
  readonly transitionHistory: TransitionRecord[];
  /** Tracks the most recently detected state for status queries. */
  currentState: string;
  /** Set when the workflow reaches a terminal state. */
  finalStatus?: WorkflowStatus;
  /** Active gate ID, if the machine is waiting at a human gate. */
  activeGateId?: string;
  /** Tracks the last error surfaced to avoid emitting duplicate lifecycle events. */
  lastSurfacedError?: string;
  /** Timestamp when the current state was entered, for transition duration tracking. */
  stateEnteredAt?: number;
  /** Append-only JSONL message log for debugging. */
  readonly messageLog: MessageLog;
  /**
   * Docker infrastructure shared across workflow states. Set by
   * createWorkflowInfrastructure at workflow start; destroyed at
   * workflow terminal. Undefined for builtin workflows or when
   * settings.sharedContainer is false.
   */
  infra?: DockerInfrastructure;
  /**
   * Memoized compiled-policy directory per persona. Populated on first
   * use by `cyclePolicy` to avoid re-reading `persona.json` / running
   * `loadConfig()` on every state transition.
   */
  readonly policyDirByPersona: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class WorkflowOrchestrator implements WorkflowController {
  private readonly workflows = new Map<WorkflowId, WorkflowInstance>();
  private readonly lifecycleCallbacks: Array<(e: WorkflowLifecycleEvent) => void> = [];

  constructor(private readonly deps: WorkflowOrchestratorDeps) {}

  /** Build a partial log entry with shared fields for the given workflow instance. */
  private logBase(instance: WorkflowInstance): { ts: string; workflowId: string; state: string } {
    return {
      ts: new Date().toISOString(),
      workflowId: instance.id,
      state: instance.currentState,
    };
  }

  // -----------------------------------------------------------------------
  // Pre-flight validation
  // -----------------------------------------------------------------------

  /**
   * Validates that all non-"global" personas referenced in the workflow
   * definition actually exist on disk. Fails fast with a clear error
   * listing all missing personas.
   *
   * Only checks for persona.json existence -- does NOT verify compiled
   * policy (that happens at session creation time via resolvePersona).
   */
  private validatePersonas(definition: WorkflowDefinition): void {
    const missing: string[] = [];
    for (const [stateId, state] of Object.entries(definition.states)) {
      if (state.type !== 'agent') continue;
      const persona = state.persona;
      if (persona === GLOBAL_PERSONA) continue;

      const defPath = getPersonaDefinitionPath(createPersonaName(persona));
      if (!existsSync(defPath)) {
        missing.push(`"${persona}" (used by state "${stateId}")`);
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `Workflow references personas that do not exist:\n` +
          `  ${missing.join('\n  ')}\n` +
          `Create them with: ironcurtain persona create <name>`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Workflow-scoped Docker infrastructure lifecycle
  // -----------------------------------------------------------------------

  /**
   * Determines whether a workflow should run in shared-container mode.
   * Requires both an explicit opt-in via `settings.sharedContainer` and
   * a Docker-backed agent. Builtin workflows ignore the flag entirely.
   */
  private shouldUseSharedContainer(definition: WorkflowDefinition): boolean {
    const settings = definition.settings ?? {};
    if (settings.sharedContainer !== true) return false;
    if (settings.mode === 'builtin') return false;
    return true;
  }

  /**
   * Creates the workflow-scoped Docker infrastructure bundle and stashes
   * it on `instance.infra`. Called once at workflow start and on resume
   * when shared-container mode is enabled.
   *
   * Only invoked when `shouldUseSharedContainer(definition)` returns true;
   * callers must gate on that check.
   *
   * After the bundle is created, attaches the coordinator's HTTP control
   * server at the workflow-scoped UDS path. If the control-server attach
   * fails, the bundle is torn down before the error propagates so we do
   * not leak Docker resources on partial initialization.
   */
  private async createWorkflowInfrastructure(instance: WorkflowInstance): Promise<void> {
    const settings = instance.definition.settings ?? {};
    const agentId = (settings.dockerAgent ?? 'claude-code') as AgentId;
    const controlSocketPath = getWorkflowProxyControlSocketPath(instance.id);
    // Ensure the workflow run dir exists BEFORE the coordinator tries to
    // bind its UDS there. `getWorkflowRunDir` is lazily materialized; if
    // the first thing the orchestrator does is ask the coordinator to
    // listen on a path whose parent directory is missing, bind fails.
    const runDir = dirname(controlSocketPath);
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    // `mkdirSync`'s `mode` only applies on creation; if the run dir
    // pre-exists (stale from a prior run or manually created) the mode
    // is a no-op. The coordinator's control socket relies on 0o700 to
    // gate access — enforce permissions unconditionally.
    chmodSync(runDir, 0o700);

    const factory = this.deps.createWorkflowInfrastructure ?? (await this.loadDefaultInfrastructureFactory());
    const infra = await factory({
      workflowId: instance.id,
      agentId,
      controlSocketPath,
      workspacePath: instance.workspacePath,
    });

    // Attach the control server. On failure, tear down the bundle so
    // we don't leak containers/proxies; the error propagates to the
    // caller so `start()` can reject.
    try {
      const startServer = this.deps.startWorkflowControlServer ?? defaultStartWorkflowControlServer;
      await startServer({ infra, socketPath: controlSocketPath });
    } catch (err) {
      const destroy = this.deps.destroyWorkflowInfrastructure ?? (await this.loadDefaultInfrastructureTeardown());
      await destroy(infra).catch((teardownErr: unknown) => {
        writeStderr(
          `[workflow] destroyDockerInfrastructure during control-server recovery for ${instance.id}: ${toErrorMessage(teardownErr)}`,
        );
      });
      throw err;
    }

    instance.infra = infra;
  }

  /**
   * Reloads the coordinator's policy for the given persona. Called once
   * per agent state invocation (including re-entries) when
   * `instance.infra` is set. The coordinator stamps `persona` onto every
   * subsequent audit entry, so consumers can reconstruct per-persona /
   * per-re-entry slices from the single `audit.jsonl` file.
   *
   * On failure (control socket unreachable, coordinator reports a load
   * error) this throws — the workflow must not proceed under the
   * previous persona's policy.
   */
  private async cyclePolicy(instance: WorkflowInstance, persona: string): Promise<void> {
    let policyDir = instance.policyDirByPersona.get(persona);
    if (policyDir === undefined) {
      policyDir = resolvePersonaPolicyDir(persona);
      instance.policyDirByPersona.set(persona, policyDir);
    }
    const socketPath = getWorkflowProxyControlSocketPath(instance.id);

    const loadPolicy = this.deps.loadPolicyRpc ?? defaultLoadPolicyRpc;
    await loadPolicy({
      socketPath,
      persona,
      policyDir,
      timeoutMs: LOAD_POLICY_RPC_TIMEOUT_MS,
    });
  }

  /**
   * Tears down the workflow-scoped Docker infrastructure bundle, if any.
   *
   * Callers in recovery paths depend on this function never throwing:
   *   - Failures in `destroy(infra)` are logged to stderr and swallowed;
   *     the socket-unlink step still runs.
   *   - Failures in the socket unlink are logged and swallowed.
   *
   * **Not a retry point.** `instance.infra` is cleared synchronously
   * before the async `destroy(infra)` so a second concurrent call (e.g.
   * `shutdownAll` racing the fire-and-forget destroy in
   * `handleWorkflowComplete`) sees `infra === undefined` and returns
   * without re-entering `destroy`. This prevents double-destroy against
   * the same Docker resources at the cost of giving up on in-process
   * retry if the first destroy threw — recovery from a persistent
   * destroy failure is the operator's responsibility (`docker ps -a`).
   */
  private async destroyWorkflowInfrastructure(instance: WorkflowInstance): Promise<void> {
    const infra = instance.infra;
    if (!infra) return;
    // Clear BEFORE the await so a concurrent caller sees undefined and
    // bails out. See JSDoc for the rationale.
    instance.infra = undefined;

    const destroy = this.deps.destroyWorkflowInfrastructure ?? (await this.loadDefaultInfrastructureTeardown());
    try {
      await destroy(infra);
    } catch (err) {
      writeStderr(`[workflow] destroyDockerInfrastructure failed for ${instance.id}: ${toErrorMessage(err)}`);
    }

    // Best-effort: unlink the coordinator control socket. Swallow
    // ENOENT because the socket may never have been bound (e.g., when
    // destroy runs after a failure before control-server attach).
    try {
      unlinkSync(getWorkflowProxyControlSocketPath(instance.id));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        writeStderr(`[workflow] Failed to unlink control socket for ${instance.id}: ${toErrorMessage(err)}`);
      }
    }
  }

  /**
   * Lazy-loads the default `createDockerInfrastructure` wrapper. The real
   * helper requires Docker dependencies and the session config, so we
   * construct them here rather than eagerly at orchestrator construction
   * time (which would pay the import cost for every workflow run,
   * including builtin ones that don't need Docker).
   */
  private async loadDefaultInfrastructureFactory(): Promise<
    (input: CreateWorkflowInfrastructureInput) => Promise<DockerInfrastructure>
  > {
    const { createDockerInfrastructure } = await import('../docker/docker-infrastructure.js');
    const { loadConfig, applyAllowedDirectoryToMcpArgs } = await import('../config/index.js');

    return async (input) => {
      const config = loadConfig();
      // Bundle dir holds the workflow's shared Docker artifacts
      // (orientation, sockets, claude-state, escalations, system
      // prompt). It's colocated under the workflow run directory so
      // every workflow-scoped file lives under a single tree.
      // Audit entries go to the workflow-scoped file (one file per
      // workflow run, with per-entry persona tagging) instead of the
      // per-session audit file.
      const bundleDir = getWorkflowBundleDir(input.workflowId);
      const bundleEscalationDir = resolve(bundleDir, 'escalations');
      // All sessions in a workflow share the workflow's workspace dir
      // as their allowed directory. Do NOT use a session-scoped sandbox
      // here: the orchestrator's artifact checks look inside the
      // workspace, so artifacts the agent writes must land in the same
      // tree.
      mkdirSync(bundleDir, { recursive: true });
      mkdirSync(bundleEscalationDir, { recursive: true });
      mkdirSync(input.workspacePath, { recursive: true });
      // Rewrite the allowed directory and audit path onto the loaded
      // config. `config.allowedDirectory` drives the filesystem MCP
      // server's --allowed-directory; `config.auditLogPath` is what the
      // ToolCallCoordinator (via Sandbox) reads when creating the
      // AuditLog. Without the audit rewrite, audit entries fall through
      // to the default `./audit.jsonl` against process.cwd().
      config.allowedDirectory = input.workspacePath;
      config.auditLogPath = getWorkflowAuditLogPath(input.workflowId);
      applyAllowedDirectoryToMcpArgs(config.mcpServers, input.workspacePath);
      return createDockerInfrastructure(
        config,
        { kind: 'docker', agent: input.agentId },
        bundleDir,
        input.workspacePath,
        bundleEscalationDir,
        input.workflowId,
      );
    };
  }

  /** Lazy-loads the default `destroyDockerInfrastructure` helper. */
  private async loadDefaultInfrastructureTeardown(): Promise<(infra: DockerInfrastructure) => Promise<void>> {
    const { destroyDockerInfrastructure } = await import('../docker/docker-infrastructure.js');
    return destroyDockerInfrastructure;
  }

  // -----------------------------------------------------------------------
  // WorkflowController implementation
  // -----------------------------------------------------------------------

  async start(definitionPath: string, taskDescription: string, workspacePath?: string): Promise<WorkflowId> {
    const raw = parseDefinitionFile(definitionPath);
    const definition = validateDefinition(raw);
    this.validatePersonas(definition);
    const workflowId = createWorkflowId();

    const resolvedWorkspace = workspacePath ?? resolve(this.deps.baseDir, workflowId, 'workspace');

    // Reject if any active workflow already uses this workspace path
    for (const instance of this.workflows.values()) {
      if (instance.workspacePath === resolvedWorkspace && !instance.finalStatus) {
        throw new Error(`Workspace ${resolvedWorkspace} is already in use by workflow ${instance.id}`);
      }
    }

    mkdirSync(resolvedWorkspace, { recursive: true });

    const artifactDir = resolve(resolvedWorkspace, WORKFLOW_ARTIFACT_DIR);
    mkdirSync(artifactDir, { recursive: true });
    const taskDir = resolve(artifactDir, 'task');
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(resolve(taskDir, 'description.md'), taskDescription);

    ensureWorkflowGitignored(resolvedWorkspace);

    // Copy definition to baseDir for resume portability
    const metaDir = resolve(this.deps.baseDir, workflowId);
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(resolve(metaDir, 'definition.json'), JSON.stringify(definition, null, 2));

    const { machine, gateStateNames, terminalStateNames } = buildWorkflowMachine(definition, taskDescription);

    const providedMachine = this.provideActors(machine, workflowId, definition);
    const actor = createActor(providedMachine);
    const tab = this.deps.createWorkflowTab(definition.name, workflowId);
    const messageLog = new MessageLog(resolve(this.deps.baseDir, workflowId, 'messages.jsonl'));

    const instance: WorkflowInstance = {
      id: workflowId,
      definition,
      definitionPath,
      actor,
      gateStateNames,
      terminalStateNames,
      activeSessions: new Set(),
      artifactDir,
      workspacePath: resolvedWorkspace,
      tab,
      transitionHistory: [],
      currentState: definition.initial,
      stateEnteredAt: Date.now(),
      messageLog,
      policyDirByPersona: new Map(),
    };

    // Create workflow-scoped Docker infrastructure BEFORE starting the actor
    // so the first state's session invocation can borrow it. If infra creation
    // fails, fail fast without registering the workflow or starting the actor.
    if (this.shouldUseSharedContainer(definition)) {
      try {
        await this.createWorkflowInfrastructure(instance);
      } catch (err) {
        tab.write(`[error] Failed to create workflow infrastructure: ${toErrorMessage(err)}`);
        tab.close();
        throw err;
      }
    }

    this.workflows.set(workflowId, instance);
    this.emitLifecycleEvent({ kind: 'started', workflowId, name: definition.name, taskDescription });
    this.subscribeToActor(instance);
    actor.start();
    return workflowId;
  }

  async resume(workflowId: WorkflowId): Promise<void> {
    const checkpoint = await Promise.resolve(this.deps.checkpointStore.load(workflowId));
    if (!checkpoint) {
      throw new Error(`No checkpoint found for workflow ${workflowId}`);
    }

    const definitionCopyPath = resolve(this.deps.baseDir, workflowId, 'definition.json');
    const definitionPath = existsSync(definitionCopyPath) ? definitionCopyPath : checkpoint.definitionPath;
    // Runtime copies are always JSON; original user files may be YAML
    const raw = parseDefinitionFile(definitionPath);
    const definition = validateDefinition(raw);

    const { machine, gateStateNames, terminalStateNames } = buildWorkflowMachine(
      definition,
      checkpoint.context.taskDescription,
    );

    const providedMachine = this.provideActors(machine, workflowId, definition);

    const restoredSnapshot = providedMachine.resolveState({
      value: checkpoint.machineState as string,
      context: checkpoint.context,
    });
    const actor = createActor(providedMachine, { snapshot: restoredSnapshot as Snapshot<unknown> });

    const workspacePath = checkpoint.workspacePath ?? resolve(this.deps.baseDir, workflowId, 'workspace');
    const artifactDir = resolve(workspacePath, WORKFLOW_ARTIFACT_DIR);
    // Ensure artifact dir exists (backward compat with pre-workspace checkpoints)
    mkdirSync(artifactDir, { recursive: true });

    const tab = this.deps.createWorkflowTab(definition.name, workflowId);
    // Append to existing log file (resume must not overwrite)
    const messageLog = new MessageLog(resolve(this.deps.baseDir, workflowId, 'messages.jsonl'));

    const instance: WorkflowInstance = {
      id: workflowId,
      definition,
      definitionPath: checkpoint.definitionPath,
      actor,
      gateStateNames,
      terminalStateNames,
      activeSessions: new Set(),
      artifactDir,
      workspacePath,
      tab,
      transitionHistory: [...checkpoint.transitionHistory],
      currentState: String(checkpoint.machineState),
      stateEnteredAt: Date.now(),
      messageLog,
      policyDirByPersona: new Map(),
    };

    // Create workflow-scoped Docker infrastructure before starting the
    // actor. Resume does NOT reclaim the original container — any
    // dependencies installed in the previous run are lost. Reclamation
    // is tracked as a follow-up in the workflow container lifecycle
    // design (§6).
    if (this.shouldUseSharedContainer(definition)) {
      writeStderr(
        `[workflow] Resuming ${workflowId} in shared-container mode: creating a fresh Docker infrastructure bundle. ` +
          `Any dependencies installed in the pre-resume container are lost.`,
      );
      try {
        await this.createWorkflowInfrastructure(instance);
      } catch (err) {
        tab.write(`[error] Failed to create workflow infrastructure on resume: ${toErrorMessage(err)}`);
        tab.close();
        throw err;
      }
    }

    this.workflows.set(workflowId, instance);
    this.emitLifecycleEvent({
      kind: 'started',
      workflowId,
      name: definition.name,
      taskDescription: checkpoint.context.taskDescription,
    });
    this.subscribeToActor(instance);
    actor.start();

    // XState v5's resolveState() restores *to* a state but does not *enter* it.
    // Invoke services (agent/deterministic) only start on state entry via transition.
    // For invoke states, we must manually execute the service and feed the result
    // back to the actor as an xstate.done.actor / xstate.error.actor event.
    const restoredState = String(checkpoint.machineState);
    const stateDef = definition.states[restoredState];
    if (stateDef.type === 'agent' || stateDef.type === 'deterministic') {
      this.replayInvokeForRestoredState(workflowId, restoredState, stateDef, definition);
    }
  }

  /**
   * Manually executes the invoke service for a state that was restored from
   * a checkpoint. XState does not re-trigger invocations when an actor is
   * started from a persisted snapshot, so we run the service ourselves and
   * send the result event to the actor.
   */
  private replayInvokeForRestoredState(
    workflowId: WorkflowId,
    stateId: string,
    stateDef: AgentStateDefinition | DeterministicStateDefinition,
    definition: WorkflowDefinition,
  ): void {
    const instance = this.workflows.get(workflowId);
    if (!instance) return;

    const snapshot = instance.actor.getSnapshot() as { context: WorkflowContext };
    const context = snapshot.context;

    // Build the service promise based on state type
    const servicePromise: Promise<unknown> =
      stateDef.type === 'agent'
        ? this.executeAgentState(workflowId, { stateId, stateConfig: stateDef, context }, definition)
        : this.executeDeterministicState({ stateId, commands: stateDef.run, context });

    // Feed the result back to the actor as an XState internal invoke event.
    // These event types don't exist in our WorkflowEvent union, so we cast
    // through unknown to satisfy TypeScript while matching XState's internal
    // event format that onDone/onError handlers expect.
    servicePromise
      .then((output) => {
        instance.actor.send({ type: `xstate.done.actor.${stateId}`, output } as unknown as WorkflowEvent);
      })
      .catch((err: unknown) => {
        instance.actor.send({ type: `xstate.error.actor.${stateId}`, error: err } as unknown as WorkflowEvent);
      });
  }

  listResumable(): WorkflowId[] {
    const allCheckpointed = this.deps.checkpointStore.listAll();
    const activeIds = new Set(this.listActive());
    return allCheckpointed.filter((id) => !activeIds.has(id));
  }

  getStatus(id: WorkflowId): WorkflowStatus | undefined {
    const instance = this.workflows.get(id);
    if (!instance) return undefined;

    if (instance.finalStatus) return instance.finalStatus;

    if (instance.activeGateId) {
      const gateName = instance.currentState;
      const stateDef = instance.definition.states[gateName];
      if (stateDef.type === 'human_gate') {
        return {
          phase: 'waiting_human',
          gate: this.buildGateRequest(id, gateName, stateDef),
        };
      }
    }

    return {
      phase: 'running',
      currentState: instance.currentState,
      activeAgents: [],
    };
  }

  getDetail(id: WorkflowId): WorkflowDetail | undefined {
    const instance = this.workflows.get(id);
    if (!instance) return undefined;

    const snapshot = instance.actor.getSnapshot() as { context: WorkflowContext };
    const ctx = snapshot.context;

    return {
      definition: instance.definition,
      transitionHistory: [...instance.transitionHistory],
      workspacePath: instance.workspacePath,
      context: {
        taskDescription: ctx.taskDescription,
        round: ctx.round,
        maxRounds: ctx.maxRounds,
        totalTokens: ctx.totalTokens,
        visitCounts: { ...ctx.visitCounts },
      },
    };
  }

  listActive(): readonly WorkflowId[] {
    return [...this.workflows.keys()].filter((id) => {
      const instance = this.workflows.get(id);
      return instance && !instance.finalStatus;
    });
  }

  resolveGate(id: WorkflowId, event: HumanGateEvent): void {
    // FORCE_REVISION and REPLAN loop back to an earlier state with the
    // feedback injected into the next agent's prompt (via context.humanPrompt).
    // Without feedback the agent has no signal for what to change and the
    // re-entry prompt ("Revise it to address the human feedback above")
    // references content that does not exist. Require non-empty feedback at
    // the source so every entry point (CLI, web UI, programmatic) fails fast.
    if (event.type === 'FORCE_REVISION' || event.type === 'REPLAN') {
      if (!event.prompt || event.prompt.trim().length === 0) {
        throw new Error(`Feedback is required for ${event.type} events`);
      }
    }

    const instance = this.workflows.get(id);
    if (!instance) return;

    const gateId = instance.activeGateId;
    if (!gateId) {
      // No active gate -- prevent double-resolution
      return;
    }

    // Clear before sending to prevent concurrent double-resolution
    instance.activeGateId = undefined;
    this.deps.dismissGate(instance.id, gateId);

    instance.messageLog.append({
      ...this.logBase(instance),
      type: 'gate_resolved',
      event: event.type,
      prompt: event.prompt ?? null,
    });

    const xstateEventName = `HUMAN_${event.type}` as const;
    instance.actor.send({
      type: xstateEventName,
      prompt: event.prompt,
    });
  }

  async abort(id: WorkflowId): Promise<void> {
    const instance = this.workflows.get(id);
    if (!instance) return;

    if (
      instance.finalStatus?.phase === 'completed' ||
      instance.finalStatus?.phase === 'aborted' ||
      instance.finalStatus?.phase === 'failed'
    ) {
      return;
    }

    const closePromises: Promise<void>[] = [];
    for (const session of instance.activeSessions) {
      closePromises.push(session.close().catch(() => {}));
    }
    await Promise.allSettled(closePromises);
    instance.activeSessions.clear();

    instance.actor.stop();
    instance.finalStatus = {
      phase: 'aborted',
      reason: 'Workflow aborted by user',
    };

    // Tear down workflow-scoped Docker infrastructure after all sessions
    // are closed. Error-tolerant (see destroyWorkflowInfrastructure).
    await this.destroyWorkflowInfrastructure(instance);

    try {
      this.deps.checkpointStore.remove(id);
    } catch (err) {
      writeStderr(`[workflow] Failed to remove checkpoint on abort for ${id}: ${toErrorMessage(err)}`);
    }

    instance.tab.write('[aborted]');
    instance.tab.close();

    this.emitLifecycleEvent({
      kind: 'failed',
      workflowId: id,
      error: 'Workflow aborted by user',
    });
  }

  onEvent(callback: (event: WorkflowLifecycleEvent) => void): void {
    this.lifecycleCallbacks.push(callback);
  }

  async shutdownAll(): Promise<void> {
    const ids = [...this.workflows.keys()];
    // Abort runs full teardown (including destroyWorkflowInfrastructure) for
    // workflows not yet in a terminal state. For already-terminal workflows,
    // abort() early-returns — so we follow up with an explicit destroy pass
    // to defend against any case where a terminal transition skipped infra
    // teardown (e.g., tests forcing finalStatus directly). The destroy call
    // is idempotent when instance.infra is undefined.
    await Promise.allSettled(ids.map((id) => this.abort(id)));
    await Promise.allSettled(
      ids.map((id) => {
        const instance = this.workflows.get(id);
        return instance ? this.destroyWorkflowInfrastructure(instance) : Promise.resolve();
      }),
    );
  }

  // -----------------------------------------------------------------------
  // Actor setup helpers
  // -----------------------------------------------------------------------

  /** Injects concrete agent/deterministic service implementations into the machine. */
  private provideActors(
    machine: ReturnType<typeof buildWorkflowMachine>['machine'],
    workflowId: WorkflowId,
    definition: WorkflowDefinition,
  ): ReturnType<typeof buildWorkflowMachine>['machine'] {
    return machine.provide({
      actors: {
        agentService: fromPromise<AgentInvokeResult, AgentInvokeInput>(async ({ input }) => {
          try {
            return await this.executeAgentState(workflowId, input, definition);
          } catch (err) {
            writeStderr(`[workflow] agentService invoke rejected for "${input.stateId}": ${toErrorMessage(err)}`);
            throw err;
          }
        }),
        deterministicService: fromPromise<DeterministicInvokeResult, DeterministicInvokeInput>(async ({ input }) => {
          try {
            return await this.executeDeterministicState(input);
          } catch (err) {
            writeStderr(
              `[workflow] deterministicService invoke rejected for "${input.stateId}": ${toErrorMessage(err)}`,
            );
            throw err;
          }
        }),
      },
    }) as ReturnType<typeof buildWorkflowMachine>['machine'];
  }

  /** Subscribes to actor snapshot changes for lifecycle events, gates, and checkpointing. */
  private subscribeToActor(instance: WorkflowInstance): void {
    const { actor, gateStateNames, definition, id: workflowId } = instance;

    actor.subscribe((rawSnapshot: unknown) => {
      const snapshot = rawSnapshot as {
        value: unknown;
        context: WorkflowContext;
        status: string;
        matches: (state: string) => boolean;
      };
      const stateValue = String(snapshot.value);
      const previousState = instance.currentState;
      const now = Date.now();

      // Record transition and checkpoint only on actual state changes
      if (stateValue !== previousState) {
        const duration = instance.stateEnteredAt ? now - instance.stateEnteredAt : 0;

        const stateType = definition.states[previousState].type;
        let agentMessage: string | undefined;
        if (stateType === 'human_gate') {
          agentMessage = truncateForTransition(snapshot.context.humanPrompt ?? snapshot.context.previousAgentOutput);
        } else if (stateType === 'agent') {
          agentMessage = truncateForTransition(snapshot.context.previousAgentOutput);
        }
        // deterministic and terminal: no agentMessage (leave undefined)

        instance.transitionHistory.push({
          from: previousState,
          to: stateValue,
          event: 'transition',
          timestamp: new Date(now).toISOString(),
          duration_ms: duration,
          agentMessage,
        });
        instance.stateEnteredAt = now;
        this.saveCheckpoint(instance, snapshot);

        instance.messageLog.append({
          ...this.logBase(instance),
          type: 'state_transition',
          from: previousState,
          event: stateValue,
        });
      }

      instance.currentState = stateValue;
      instance.tab.write(`[state] ${stateValue}`);

      // Surface errors from invoke failures (storeError action sets lastError)
      const ctx = snapshot.context;
      if (ctx.lastError && ctx.lastError !== instance.lastSurfacedError) {
        instance.lastSurfacedError = ctx.lastError;
        writeStderr(`[workflow] Error in context after state "${stateValue}": ${ctx.lastError}`);
        instance.tab.write(`[error] Agent invoke failed: ${ctx.lastError}`);
        this.emitLifecycleEvent({
          kind: 'failed',
          workflowId,
          error: `Agent "${previousState}" failed: ${ctx.lastError}`,
        });
      } else if (!ctx.lastError && instance.lastSurfacedError) {
        instance.lastSurfacedError = undefined;
      }

      for (const gateName of gateStateNames) {
        if (snapshot.matches(gateName)) {
          const stateDef = definition.states[gateName];
          if (stateDef.type === 'human_gate') {
            this.handleGateEntry(workflowId, gateName, stateDef);
          }
          break;
        }
      }

      this.emitLifecycleEvent({
        kind: 'state_entered',
        workflowId,
        state: stateValue,
      });

      // Check for terminal states
      if (snapshot.status === 'done') {
        this.handleWorkflowComplete(workflowId, snapshot.context);
      }
    });
  }

  // -----------------------------------------------------------------------
  // Checkpointing
  // -----------------------------------------------------------------------

  private saveCheckpoint(instance: WorkflowInstance, snapshot: { value: unknown; context: unknown }): void {
    const checkpoint: WorkflowCheckpoint = {
      machineState: snapshot.value,
      context: snapshot.context as WorkflowContext,
      timestamp: new Date().toISOString(),
      transitionHistory: [...instance.transitionHistory],
      definitionPath: instance.definitionPath,
      workspacePath: instance.workspacePath,
    };
    try {
      this.deps.checkpointStore.save(instance.id, checkpoint);
    } catch (err) {
      writeStderr(`[workflow] Failed to save checkpoint for ${instance.id}: ${toErrorMessage(err)}`);
    }
  }

  // -----------------------------------------------------------------------
  // Agent state execution
  // -----------------------------------------------------------------------

  private async executeAgentState(
    workflowId: WorkflowId,
    input: AgentInvokeInput,
    definition: WorkflowDefinition,
  ): Promise<AgentInvokeResult> {
    const { stateId, stateConfig, context } = input;
    const instance = this.workflows.get(workflowId);
    if (!instance) throw new Error(`Workflow ${workflowId} not found`);

    const settings = definition.settings ?? {};

    // Version artifact directories before re-entering a state
    const visitCount = context.visitCounts[stateId] ?? 0;
    if (visitCount > 1) {
      const unversioned = new Set(settings.unversionedArtifacts ?? []);
      snapshotArtifacts(instance.artifactDir, stateConfig.outputs, visitCount, unversioned);
    }

    instance.tab.write(`[agent] Starting "${stateId}" (persona: ${stateConfig.persona})`);

    const command = buildAgentCommand(stateId, stateConfig, context, definition);

    const mode: SessionMode =
      settings.mode === 'builtin'
        ? { kind: 'builtin' }
        : { kind: 'docker', agent: (settings.dockerAgent ?? 'claude-code') as AgentId };

    const effectiveModel = stateConfig.model ?? settings.model;

    // Shared-container mode only: rotate the coordinator's audit stream
    // and swap policy before constructing the borrowing session. In
    // per-state-container mode the new session builds its own
    // coordinator, so there is nothing to cycle.
    if (instance.infra) {
      try {
        await this.cyclePolicy(instance, stateConfig.persona);
      } catch (err) {
        const errMsg = toErrorMessage(err);
        writeStderr(`[workflow] cyclePolicy failed for "${stateId}": ${errMsg}`);
        instance.tab.write(`[error] Policy cycle failed for "${stateId}": ${errMsg}`);
        instance.messageLog.append({
          ...this.logBase(instance),
          type: 'error',
          error: errMsg,
          context: `cyclePolicy for "${stateId}" (persona: ${stateConfig.persona})`,
        });
        throw err;
      }
    }

    // Create session with resumeSessionId for same-role continuity.
    // sessionsByState is keyed by stateId (set by updateContextFromAgentResult).
    // workspacePath ensures the agent writes to the artifact directory,
    // so files created by the agent are visible to the orchestrator.
    const previousSessionId = stateConfig.freshSession === false ? context.sessionsByState[stateId] : undefined;

    // In borrow mode, route this invocation's per-state artifacts
    // (session.log, session-metadata.json) under a slug-keyed directory
    // inside the workflow run. The XState machine's `incrementVisitCount`
    // entry action runs before `invoke`, so `context.visitCounts[stateId]`
    // is already incremented by the time this factory runs (1 on first
    // entry, 2 on re-entry, etc.).
    const visitCountForSlug = context.visitCounts[stateId];
    const stateSlug = `${stateId}.${visitCountForSlug}`;
    const workflowStateDir = instance.infra ? getWorkflowStateDir(instance.id, stateSlug) : undefined;
    if (workflowStateDir) {
      mkdirSync(workflowStateDir, { recursive: true });
    }

    let session: Session;
    try {
      session = await this.deps.createSession({
        persona: stateConfig.persona,
        mode,
        resumeSessionId: previousSessionId,
        workspacePath: instance.workspacePath,
        systemPromptAugmentation: definition.settings?.systemPrompt,
        ...(effectiveModel != null ? { agentModelOverride: effectiveModel } : {}),
        ...(settings.maxSessionSeconds != null
          ? { resourceBudgetOverrides: { maxSessionSeconds: settings.maxSessionSeconds } }
          : {}),
        // Borrow the workflow-scoped Docker bundle so the session does
        // not rebuild proxies / containers per state. Unset for builtin
        // or opt-out workflows.
        ...(instance.infra ? { workflowInfrastructure: instance.infra } : {}),
        // Per-state artifact dir is only meaningful in borrow mode —
        // `buildSessionConfig` throws if `workflowStateDir` is supplied
        // without a bundle.
        ...(workflowStateDir ? { workflowStateDir, stateSlug } : {}),
      });
    } catch (err) {
      const errMsg = toErrorMessage(err);
      writeStderr(`[workflow] Session creation failed for "${stateId}": ${errMsg}`);
      instance.tab.write(`[error] Session creation failed for "${stateId}": ${errMsg}`);
      instance.messageLog.append({
        ...this.logBase(instance),
        type: 'error',
        error: errMsg,
        context: `session creation for "${stateId}"`,
      });
      throw err;
    }

    instance.activeSessions.add(session);

    try {
      instance.tab.write(`[agent] Sending command to "${stateId}"...`);

      const { messageLog } = instance;
      const statusInstructions = buildStatusInstructions(stateConfig.transitions);

      const logReceived = (text: string, output: AgentOutput | undefined) => {
        messageLog.append({
          ...this.logBase(instance),
          type: 'agent_received',
          role: stateConfig.persona,
          message: text,
          verdict: output?.verdict ?? null,
          // eslint-disable-next-line @typescript-eslint/no-deprecated -- logged for diagnostics
          confidence: output?.confidence ?? null,
          notes: output?.notes ?? null,
        });
      };

      messageLog.append({
        ...this.logBase(instance),
        type: 'agent_sent',
        role: stateConfig.persona,
        message: command,
      });

      this.emitLifecycleEvent({
        kind: 'agent_started',
        workflowId,
        state: stateId,
        persona: stateConfig.persona,
        sessionId: session.getInfo().id,
      });

      let responseText = await session.sendMessage(command);
      let parseResult = tryParseAgentStatus(responseText);
      logReceived(responseText, parseResult.kind === 'ok' ? parseResult.output : undefined);

      let agentOutput: AgentOutput;
      if (parseResult.kind === 'ok') {
        agentOutput = parseResult.output;
      } else {
        const malformed = parseResult.kind === 'malformed' ? parseResult.error : undefined;
        const retryMsg = buildStatusBlockReprompt(statusInstructions, malformed);
        messageLog.append({
          ...this.logBase(instance),
          type: 'agent_retry',
          role: stateConfig.persona,
          reason: malformed ? 'malformed_status_block' : 'missing_status_block',
          details: malformed
            ? `Malformed agent_status block: ${malformed.message}`
            : 'Response did not contain an agent_status block',
          retryMessage: retryMsg,
        });

        responseText = await session.sendMessage(retryMsg);
        parseResult = tryParseAgentStatus(responseText);
        logReceived(responseText, parseResult.kind === 'ok' ? parseResult.output : undefined);

        if (parseResult.kind !== 'ok') {
          throw new Error(
            parseResult.kind === 'malformed'
              ? `Agent produced a malformed agent_status block after retry: ${parseResult.error.message}`
              : 'Agent failed to provide agent_status block after retry',
          );
        }
        agentOutput = parseResult.output;
      }

      // Validate verdict against valid transitions before the result reaches XState.
      // This prevents silent deadlocks when the agent returns a verdict that no
      // transition's `when` clause matches.
      const validVerdicts = getValidVerdicts(stateConfig.transitions);
      if (validVerdicts && !validVerdicts.has(agentOutput.verdict)) {
        const retryMsg = buildInvalidVerdictReprompt(agentOutput.verdict, stateConfig.transitions);
        messageLog.append({
          ...this.logBase(instance),
          type: 'agent_retry',
          role: stateConfig.persona,
          reason: 'invalid_verdict',
          details: `Verdict "${agentOutput.verdict}" not in valid set: ${[...validVerdicts].join(', ')}`,
          retryMessage: retryMsg,
        });

        responseText = await session.sendMessage(retryMsg);
        const retryParse = tryParseAgentStatus(responseText);
        logReceived(responseText, retryParse.kind === 'ok' ? retryParse.output : undefined);

        if (retryParse.kind !== 'ok') {
          const suffix =
            retryParse.kind === 'malformed'
              ? `retry produced a malformed status block: ${retryParse.error.message}`
              : 'retry did not include a status block';
          throw new Error(
            `Agent verdict "${agentOutput.verdict}" is not valid for this state ` +
              `(expected one of: ${[...validVerdicts].join(', ')}), and ${suffix}`,
          );
        }

        if (!validVerdicts.has(retryParse.output.verdict)) {
          throw new Error(
            `Agent returned invalid verdict "${retryParse.output.verdict}" after retry ` +
              `(expected one of: ${[...validVerdicts].join(', ')})`,
          );
        }

        agentOutput = retryParse.output;
      }

      const missingArtifacts = this.findMissingArtifacts(stateConfig, instance.artifactDir);
      if (missingArtifacts.length > 0) {
        const artifactRetryMsg = buildArtifactReprompt(missingArtifacts, stateConfig.transitions);
        messageLog.append({
          ...this.logBase(instance),
          type: 'agent_retry',
          role: stateConfig.persona,
          reason: 'missing_artifacts',
          details: `Missing: ${missingArtifacts.join(', ')}`,
          retryMessage: artifactRetryMsg,
        });

        const retryResponse = await session.sendMessage(artifactRetryMsg);
        const retryParse = tryParseAgentStatus(retryResponse);
        if (retryParse.kind === 'ok') {
          logReceived(retryResponse, retryParse.output);
          agentOutput = retryParse.output;
        } else {
          logReceived(retryResponse, undefined);
        }
        const stillMissing = this.findMissingArtifacts(stateConfig, instance.artifactDir);
        if (stillMissing.length > 0) {
          throw new Error(`Missing artifacts after retry: ${stillMissing.join(', ')}`);
        }
      }

      const outputHash = computeOutputHash(stateConfig.outputs, instance.artifactDir, instance.workspacePath);
      const artifacts = collectArtifactPaths(stateConfig.outputs, instance.artifactDir);

      instance.tab.write(
        `[agent] "${stateId}" completed: verdict=${agentOutput.verdict}, artifacts=${Object.keys(artifacts).join(',') || 'none'}`,
      );

      this.emitLifecycleEvent({
        kind: 'agent_completed',
        workflowId,
        state: stateId,
        persona: stateConfig.persona,
        verdict: agentOutput.verdict,
        // YAML parser returns null when the agent omits notes; default to empty
        // string at the source so downstream consumers can trust the field is
        // always present (per web-ui visualization design §F.2).
        notes: agentOutput.notes ?? '',
      });

      return {
        output: agentOutput,
        sessionId: previousSessionId || session.getInfo().id,
        artifacts,
        outputHash,
        responseText,
      };
    } catch (err) {
      instance.messageLog.append({
        ...this.logBase(instance),
        type: 'error',
        error: toErrorMessage(err),
        context: `agent "${stateId}" (persona: ${stateConfig.persona})`,
      });
      throw err;
    } finally {
      instance.activeSessions.delete(session);
      const endedSessionId = session.getInfo().id;
      await session.close().catch((closeErr: unknown) => {
        console.error(`[workflow] session.close() failed for "${stateId}": ${toErrorMessage(closeErr)}`);
      });
      // Emit regardless of success / failure so consumers (e.g. the
      // daemon's bridge wiring) can release per-agent resources. Pairs
      // 1:1 with `agent_started`.
      this.emitLifecycleEvent({
        kind: 'agent_session_ended',
        workflowId,
        state: stateId,
        persona: stateConfig.persona,
        sessionId: endedSessionId,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Deterministic state execution
  // -----------------------------------------------------------------------

  private async executeDeterministicState(input: DeterministicInvokeInput): Promise<DeterministicInvokeResult> {
    const { commands } = input;
    let totalTestCount = 0;
    const allErrors: string[] = [];

    for (const cmdArray of commands) {
      if (cmdArray.length === 0) continue;
      const [binary, ...args] = cmdArray;
      try {
        const { stdout } = await execFileAsync(binary, args);
        // Try to extract test count from stdout (simple heuristic)
        const testMatch = /(\d+)\s+(?:tests?|specs?)\s+pass/i.exec(stdout);
        if (testMatch) {
          totalTestCount += parseInt(testMatch[1], 10);
        }
      } catch (err) {
        const execErr = err as { code?: number; stderr?: string; stdout?: string };
        allErrors.push(execErr.stderr ?? execErr.stdout ?? String(err));
      }
    }

    return {
      passed: allErrors.length === 0,
      testCount: totalTestCount > 0 ? totalTestCount : undefined,
      errors: allErrors.length > 0 ? allErrors.join('\n') : undefined,
    };
  }

  // -----------------------------------------------------------------------
  // Gate handling
  // -----------------------------------------------------------------------

  private handleGateEntry(workflowId: WorkflowId, gateName: string, stateDef: HumanGateStateDefinition): void {
    const instance = this.workflows.get(workflowId);
    if (!instance) return;

    const gateRequest = this.buildGateRequest(workflowId, gateName, stateDef);
    instance.activeGateId = gateRequest.gateId;

    instance.messageLog.append({
      ...this.logBase(instance),
      type: 'gate_raised',
      acceptedEvents: stateDef.acceptedEvents,
    });

    this.deps.raiseGate(gateRequest);
    this.emitLifecycleEvent({
      kind: 'gate_raised',
      workflowId,
      gate: gateRequest,
    });
  }

  private buildGateRequest(
    workflowId: WorkflowId,
    gateName: string,
    stateDef: HumanGateStateDefinition,
  ): HumanGateRequest {
    const instance = this.workflows.get(workflowId);
    const presentedArtifacts = new Map<string, string>();
    for (const artifactName of stateDef.present ?? []) {
      if (instance) {
        const dir = resolve(instance.artifactDir, artifactName);
        if (existsSync(dir)) {
          presentedArtifacts.set(artifactName, dir);
        }
      }
    }

    // Surface context.lastError in the gate summary so callers know
    // whether this gate was reached normally or via an invoke error.
    const snapshot = instance?.actor.getSnapshot() as { context?: WorkflowContext } | undefined;
    const errorContext = snapshot?.context?.lastError ? ` (error: ${snapshot.context.lastError})` : '';

    return {
      gateId: `${workflowId}-${gateName}`,
      workflowId,
      stateName: gateName,
      acceptedEvents: stateDef.acceptedEvents,
      presentedArtifacts,
      summary: `Waiting for human review at ${gateName}${errorContext}`,
    };
  }

  // -----------------------------------------------------------------------
  // Completion handling
  // -----------------------------------------------------------------------

  private handleWorkflowComplete(workflowId: WorkflowId, context: WorkflowContext): void {
    const instance = this.workflows.get(workflowId);
    if (!instance) return;

    // Guard against XState emitting a terminal transition multiple times.
    // `finalStatus` being set is the canonical "already completed" signal;
    // if it's set, skip re-entering terminal handling so we don't call
    // destroyWorkflowInfrastructure twice (the teardown itself is idempotent,
    // but duplicate tab.close() / checkpoint.remove() / lifecycle events
    // are noisy).
    if (instance.finalStatus) return;

    // Check if this is a normal completion or an aborted terminal
    const stateValue = instance.currentState;
    if (stateValue === 'aborted' || stateValue.includes('abort')) {
      instance.finalStatus = {
        phase: 'aborted',
        reason: 'Workflow reached aborted state',
      };
    } else {
      const result: WorkflowResult = { finalArtifacts: { ...context.artifacts } };
      instance.finalStatus = {
        phase: 'completed',
        result,
      };
    }

    try {
      this.deps.checkpointStore.remove(workflowId);
    } catch (err) {
      writeStderr(`[workflow] Failed to remove checkpoint for ${workflowId}: ${toErrorMessage(err)}`);
    }

    instance.tab.write(`[done] ${instance.finalStatus.phase}`);
    instance.tab.close();

    // Tear down workflow-scoped Docker infrastructure. Runs asynchronously
    // because the actor subscription is sync; destroyWorkflowInfrastructure
    // is error-tolerant so unhandled rejections should not occur, but we
    // still catch defensively for a belt-and-suspenders guarantee.
    void this.destroyWorkflowInfrastructure(instance).catch((err: unknown) => {
      writeStderr(
        `[workflow] destroyWorkflowInfrastructure unexpectedly threw for ${workflowId}: ${toErrorMessage(err)}`,
      );
    });

    this.emitLifecycleEvent({
      kind: 'completed',
      workflowId,
    });
  }

  // -----------------------------------------------------------------------
  // Artifact helpers
  // -----------------------------------------------------------------------

  private findMissingArtifacts(stateConfig: AgentStateDefinition, artifactDir: string): string[] {
    const missing: string[] = [];
    for (const output of stateConfig.outputs) {
      const dir = resolve(artifactDir, output);
      if (!hasAnyFiles(dir)) {
        missing.push(output);
      }
    }
    return missing;
  }

  // -----------------------------------------------------------------------
  // Lifecycle event emission
  // -----------------------------------------------------------------------

  private emitLifecycleEvent(event: WorkflowLifecycleEvent): void {
    for (const cb of this.lifecycleCallbacks) {
      try {
        cb(event);
      } catch (cbErr) {
        // Lifecycle callbacks should not crash the orchestrator, but log the failure
        console.error(`[workflow] Lifecycle callback threw for "${event.kind}":`, cbErr);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Standalone helpers (exported for testing)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Policy cycling helpers (workflow shared-container mode)
// ---------------------------------------------------------------------------

/**
 * Resolves the compiled-policy directory for the given persona name.
 *
 * The reserved sentinel `GLOBAL_PERSONA` maps to the package-bundled
 * generated dir (same one `loadConfig().generatedDir` resolves to for
 * CLI runs). All other values go through `resolvePersona()`, which
 * validates the persona exists and has a compiled policy.
 */
function resolvePersonaPolicyDir(persona: string): string {
  if (persona === GLOBAL_PERSONA) {
    return loadConfig().generatedDir;
  }
  return resolvePersona(persona).policyDir;
}

/**
 * Default `startWorkflowControlServer`: reaches through the infra
 * bundle's proxy for its policy-swap target and binds a control server
 * at the workflow-scoped UDS path.
 */
async function defaultStartWorkflowControlServer(input: StartWorkflowControlServerInput): Promise<void> {
  const target = input.infra.proxy.getPolicySwapTarget();
  if (!target) {
    throw new Error(
      'Cannot attach workflow control server: the proxy is not yet started. ' +
        'Call proxy.start() before attaching a control server.',
    );
  }
  await target.startControlServer({ socketPath: input.socketPath });
}

/**
 * Default `loadPolicyRpc`: speaks HTTP/1.1 over the supplied UDS using
 * Node's built-in client. Resolves on a 2xx response; rejects on any
 * non-2xx status, request timeout, or socket error. The coordinator's
 * reply body is read only on the error path (to surface the error
 * text) — 2xx bodies are discarded with `res.resume()`.
 *
 * Exported so integration tests can drive the wire format without
 * standing up a full `WorkflowOrchestrator`. Keeping the HTTP request
 * construction in one place guarantees tests exercise the same bytes
 * production emits.
 */
export async function defaultLoadPolicyRpc(input: LoadPolicyRpcInput): Promise<void> {
  const body = JSON.stringify({
    persona: input.persona,
    policyDir: input.policyDir,
  });
  const timeoutMs = input.timeoutMs ?? LOAD_POLICY_RPC_TIMEOUT_MS;

  return new Promise((resolveFn, rejectFn) => {
    let settled = false;
    const settle = (err?: Error): void => {
      if (settled) return;
      settled = true;
      if (err) rejectFn(err);
      else resolveFn();
    };

    const req = http.request(
      {
        socketPath: input.socketPath,
        method: 'POST',
        path: POLICY_LOAD_PATH,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body, 'utf-8'),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) {
          res.resume();
          res.on('end', () => settle());
          res.on('error', settle);
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          settle(new Error(`loadPolicy RPC failed (status ${status}): ${text.slice(0, 200)}`));
        });
        res.on('error', settle);
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`loadPolicy RPC timed out after ${timeoutMs}ms`));
    });
    req.on('error', settle);
    req.end(body);
  });
}

// ---------------------------------------------------------------------------
// Workspace root hashing (file listing + mtime, no content reads)
// ---------------------------------------------------------------------------

const WORKSPACE_HASH_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  '.git',
  WORKFLOW_ARTIFACT_DIR,
  'node_modules',
  '__pycache__',
  '.next',
  'dist',
  'build',
  '.cache',
  '.venv',
  'venv',
]);

/**
 * Recursively collects `relativePath:mtime` entries for all files
 * under `basePath`, excluding directories in WORKSPACE_HASH_EXCLUDED_DIRS.
 */
function collectFileEntries(basePath: string, relativeTo: string, out: string[]): void {
  const dirents = readdirSync(resolve(basePath, relativeTo), { withFileTypes: true });
  for (const dirent of dirents) {
    const relPath = relativeTo ? `${relativeTo}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) {
      if (WORKSPACE_HASH_EXCLUDED_DIRS.has(dirent.name)) continue;
      collectFileEntries(basePath, relPath, out);
    } else if (dirent.isFile()) {
      const fullPath = resolve(basePath, relPath);
      const mtime = statSync(fullPath).mtimeMs;
      out.push(`${relPath}:${mtime}`);
    }
  }
}

/** Hashes the workspace root file listing (paths + mtimes) into the given hash. */
function hashWorkspaceRoot(hash: Hash, workspacePath: string): void {
  const entries: string[] = [];
  collectFileEntries(workspacePath, '', entries);
  entries.sort();
  for (const entry of entries) {
    hash.update(entry);
  }
}

/**
 * Computes a SHA-256 hash of output artifacts or workspace root file metadata.
 *
 * When `outputNames` is non-empty, hashes declared artifact file contents.
 * When `outputNames` is empty, hashes workspace root file listing (paths + mtimes)
 * to detect code-only changes without reading file contents.
 */
export function computeOutputHash(outputNames: readonly string[], artifactDir: string, workspacePath: string): string {
  const hash = createHash('sha256');

  if (outputNames.length > 0) {
    for (const output of outputNames) {
      const dir = resolve(artifactDir, output);
      const files = collectFilesRecursive(dir);
      for (const file of files) {
        hash.update(file.relativePath);
        hash.update(readFileSync(file.fullPath));
      }
    }
  } else {
    hashWorkspaceRoot(hash, workspacePath);
  }

  return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// .gitignore management
// ---------------------------------------------------------------------------

/** Ensures the workflow artifact directory is listed in the workspace root's .gitignore. */
function ensureWorkflowGitignored(workspacePath: string): void {
  const gitignorePath = resolve(workspacePath, '.gitignore');
  const dirEntry = `${WORKFLOW_ARTIFACT_DIR}/`;

  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf-8');
    const lines = content.split('\n');
    const alreadyListed = lines.some((line) => line.trim() === dirEntry || line.trim() === WORKFLOW_ARTIFACT_DIR);
    if (!alreadyListed) {
      const suffix = content.endsWith('\n') ? '' : '\n';
      appendFileSync(gitignorePath, `${suffix}${dirEntry}\n`);
    }
  } else {
    writeFileSync(gitignorePath, `${dirEntry}\n`);
  }
}

/**
 * Collects artifact paths: maps output name -> directory path.
 */
export function collectArtifactPaths(outputNames: readonly string[], artifactDir: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const output of outputNames) {
    const dir = resolve(artifactDir, output);
    if (existsSync(dir)) {
      result[output] = dir;
    }
  }
  return result;
}
