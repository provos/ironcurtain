import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { resolve } from 'node:path';
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
import { createWorkflowId, WORKFLOW_ARTIFACT_DIR, GLOBAL_PERSONA, DEFAULT_CONTAINER_SCOPE } from './types.js';
import {
  getBundleAuditLogPath,
  getBundleBundleDir,
  getBundleControlSocketPath,
  getBundleRuntimeRoot,
  getInvocationDir,
} from '../config/paths.js';
import { POLICY_LOAD_PATH } from '../trusted-process/control-server.js';
import { loadConfig } from '../config/index.js';
import { getTokenStreamBus } from '../docker/token-stream-bus.js';
import { getPersonaDefinitionPath, resolvePersona } from '../persona/resolve.js';
import { createPersonaName } from '../persona/types.js';
import type {
  AgentConversationId,
  BundleId,
  Session,
  SessionId,
  SessionOptions,
  SessionMode,
} from '../session/types.js';
import { createAgentConversationId, createBundleId } from '../session/types.js';
import type { AgentId } from '../docker/agent-adapter.js';
import { ensureSecureBundleDir, type DockerInfrastructure } from '../docker/docker-infrastructure.js';
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
 * and the workflow uses a Docker agent. One input produces one bundle;
 * bifurcated workflows invoke the factory once per distinct
 * `containerScope` their agent states declare.
 */
export interface CreateWorkflowInfrastructureInput {
  readonly workflowId: WorkflowId;
  /**
   * Stable key for this bundle. Minted by the orchestrator via
   * `createBundleId()` before the factory is invoked so both the
   * coordinator's control-socket path and the bundle's on-disk
   * directory share the same identifier. Each unique `scope` under a
   * workflow gets its own fresh `BundleId`.
   */
  readonly bundleId: BundleId;
  readonly agentId: AgentId;
  /**
   * Path to the bundle's coordinator control socket. The orchestrator
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
   * Scoped bundles share this workspace — isolation happens at the
   * coordinator/policy level, not the filesystem.
   */
  readonly workspacePath: string;
  /**
   * Scope label this bundle was minted for. Emitted directly as the
   * `ironcurtain.scope=<scope>` Docker label on the container and its
   * sidecar. The orchestrator resolves
   * `stateConfig.containerScope ?? DEFAULT_CONTAINER_SCOPE` before calling
   * the factory, so this is always a concrete string.
   *
   * See `docs/designs/workflow-session-identity.md` §2.5.
   */
  readonly scope: string;
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
   * Docker infrastructure bundles, keyed on the `containerScope` string
   * that minted them. Populated lazily: on the first `executeAgentState`
   * for a scope not yet present, the orchestrator mints a fresh
   * `BundleId`, builds the `DockerInfrastructure`, and inserts the
   * result under the scope key. Subsequent states with the same scope
   * borrow the existing entry.
   *
   * Empty for builtin workflows and for Docker workflows running
   * without `sharedContainer: true` (each state owns its own bundle in
   * that mode). Under `sharedContainer: true`, the default-scope entry
   * (`DEFAULT_CONTAINER_SCOPE` / `"primary"`) is what older code called
   * "the primary bundle" — now it is simply one entry among the rest.
   *
   * Lifecycle: entries are created on first use, destroyed only at
   * workflow terminal via `destroyWorkflowInfrastructure`.
   *
   * See `docs/designs/workflow-session-identity.md` §2.4.
   */
  readonly bundlesByScope: Map<string, DockerInfrastructure>;
  /**
   * Memoized compiled-policy directory per persona. Populated on first
   * use by `cyclePolicy` to avoid re-reading `persona.json` / running
   * `loadConfig()` on every state transition.
   */
  readonly policyDirByPersona: Map<string, string>;
  /**
   * Three coordinated pieces of token-stream accounting state, grouped
   * so lifecycle (setup/teardown) operates on one value. `outputTokens`
   * accumulates `message_end.outputTokens` for any event whose session
   * id is in `sessionIds`. `unsubscribe` is set at `setupTokenSubscription`
   * and cleared on teardown; presence indicates "subscribed."
   */
  tokens: {
    outputTokens: number;
    readonly sessionIds: Set<SessionId>;
    unsubscribe?: () => void;
  };
  /**
   * Last persona loaded into each bundle's coordinator, keyed by
   * `BundleId`. `cyclePolicy` consults this and skips the `loadPolicy`
   * RPC when a re-entry would install the same persona that is already
   * active — the coordinator's audit stream is already tagged with the
   * right persona and the policy engine is already correct.
   */
  readonly currentPersonaByBundle: Map<string, string>;
  /**
   * Set once `destroyWorkflowInfrastructure` begins teardown. An
   * `ensureBundleForScope` call that suspended at `await factory(...)`
   * must observe this flag before publishing into `bundlesByScope` —
   * otherwise a container minted mid-abort would leak past the
   * post-teardown leak assertion.
   */
  aborted: boolean;
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
   * Returns the bundle for `scope`, minting a new one on first use.
   *
   * Each unique `containerScope` used across the workflow's states gets
   * exactly one bundle: the first `executeAgentState` call under a given
   * scope creates the bundle, attaches its coordinator control server,
   * and inserts the result into `instance.bundlesByScope`. Later states
   * with the same scope borrow the existing entry (no factory call).
   *
   * Replaces the pre-Step-6 eager workflow-start mint. Only invoked when
   * `shouldUseSharedContainer(definition)` returns true; callers must
   * gate on that check.
   *
   * On control-server attach failure, the just-created bundle is torn
   * down before the error propagates so we do not leak Docker resources
   * on partial initialization. The map is **not** populated in that case
   * — the scope entry remains absent so a later state can retry.
   *
   * Concurrency: relies on serial XState invocations — there is no
   * parallel agent-state fan-out today. If that ever lands, add an
   * in-flight-promise guard to prevent concurrent lazy-mint races for
   * the same scope.
   *
   * Abort race: if `destroyWorkflowInfrastructure` begins while a mint
   * is suspended at either `await factory(...)` or `await startServer(...)`,
   * the mint completes but must not publish into `bundlesByScope` —
   * destroy already snapshot-cleared the map and would miss the late
   * insertion. `instance.aborted` is the barrier, consulted at both
   * `await` points; on observed abort we tear down the just-built
   * bundle and throw without updating the map.
   */
  private async ensureBundleForScope(instance: WorkflowInstance, scope: string): Promise<DockerInfrastructure> {
    if (instance.aborted) {
      throw new Error(`Workflow ${instance.id} is aborting; cannot mint bundle for scope "${scope}"`);
    }
    const existing = instance.bundlesByScope.get(scope);
    if (existing) return existing;

    const settings = instance.definition.settings ?? {};
    const agentId = (settings.dockerAgent ?? 'claude-code') as AgentId;
    // Mint a fresh UUID per scope: each bundle needs its own on-disk
    // directory tree, coordinator control socket, and Docker container
    // name. Unlike single-session CLI (`bundleId === sessionId`),
    // workflow scopes produce genuine standalone `BundleId`s.
    const bundleId = createBundleId();
    const controlSocketPath = getBundleControlSocketPath(bundleId);
    // Ensure the per-bundle runtime root exists BEFORE the coordinator
    // tries to bind its UDS there. Routes through `ensureSecureBundleDir`
    // so the same symlink-rejection + 0o700-enforcement hardening that
    // guards `sockets/` and `host/` (in `prepareDockerInfrastructure`)
    // also guards the root the coordinator's `ctrl.sock` binds into.
    ensureSecureBundleDir(getBundleRuntimeRoot(bundleId));

    const factory = this.deps.createWorkflowInfrastructure ?? (await this.loadDefaultInfrastructureFactory());
    const infra = await factory({
      workflowId: instance.id,
      bundleId,
      agentId,
      controlSocketPath,
      workspacePath: instance.workspacePath,
      scope,
    });

    // Abort may have landed while `factory()` was suspended. Publishing
    // into `bundlesByScope` now would leak past the destroy's leak
    // assertion; destroy the orphan inline and throw. ESLint cannot see
    // that `instance.aborted` is mutated by the concurrent
    // `destroyWorkflowInfrastructure` call between the two reads.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (instance.aborted) {
      const destroy = this.deps.destroyWorkflowInfrastructure ?? (await this.loadDefaultInfrastructureTeardown());
      await destroy(infra).catch((teardownErr: unknown) => {
        writeStderr(
          `[workflow] destroyDockerInfrastructure during abort recovery for ${instance.id} (bundle ${bundleId}): ${toErrorMessage(teardownErr)}`,
        );
      });
      throw new Error(`Workflow ${instance.id} was aborted during bundle mint for scope "${scope}"`);
    }

    // Attach the control server. On failure, tear down the bundle so
    // we don't leak containers/proxies; the error propagates so the
    // caller (executeAgentState) can fail the state invoke.
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

    // Abort check #2: abort may have landed while `startServer()` was
    // suspended. Publishing into `bundlesByScope` now would leak past
    // the destroy's leak assertion; tear down the just-built bundle
    // and throw. ESLint cannot see that `instance.aborted` is mutated
    // by the concurrent `destroyWorkflowInfrastructure` call between
    // the two reads.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (instance.aborted) {
      const destroy = this.deps.destroyWorkflowInfrastructure ?? (await this.loadDefaultInfrastructureTeardown());
      await destroy(infra).catch((teardownErr: unknown) => {
        writeStderr(
          `[workflow] destroyDockerInfrastructure during abort recovery (post-startServer) for ${instance.id} (bundle ${bundleId}): ${toErrorMessage(teardownErr)}`,
        );
      });
      throw new Error(`Workflow ${instance.id} was aborted during control-server attach for scope "${scope}"`);
    }

    instance.bundlesByScope.set(scope, infra);
    return infra;
  }

  /**
   * Reloads the coordinator's policy for the given persona on the given
   * bundle. Called once per agent state invocation (including re-entries)
   * in shared-container mode. The coordinator stamps `persona` onto every
   * subsequent audit entry, so consumers can reconstruct per-persona /
   * per-re-entry slices from the bundle's `audit.jsonl` file.
   *
   * Each scope owns its own bundle, coordinator, and control socket, so
   * the bundle is passed explicitly — cycle the scope the state is
   * about to enter, not some other scope's bundle.
   *
   * On failure (control socket unreachable, coordinator reports a load
   * error) this throws — the workflow must not proceed under the
   * previous persona's policy.
   */
  private async cyclePolicy(instance: WorkflowInstance, persona: string, bundle: DockerInfrastructure): Promise<void> {
    // Skip the RPC when the bundle's coordinator already has this
    // persona loaded. Consecutive states on the same scope+persona
    // would otherwise re-send an identical `loadPolicy` — a no-op on
    // the coordinator that still costs a UDS round-trip and a policy
    // engine rebuild.
    if (instance.currentPersonaByBundle.get(bundle.bundleId) === persona) return;

    let policyDir = instance.policyDirByPersona.get(persona);
    if (policyDir === undefined) {
      policyDir = resolvePersonaPolicyDir(persona);
      instance.policyDirByPersona.set(persona, policyDir);
    }
    // Target this bundle's coordinator. Under bifurcated workflows every
    // bundle has its own socket, so the bundle argument fully determines
    // the route.
    const socketPath = getBundleControlSocketPath(bundle.bundleId);

    // Invalidate the cache entry BEFORE the RPC. If `loadPolicy` fails
    // after the coordinator already applied the new policy (e.g., the
    // RPC times out during the response), leaving the cache pointed at
    // the previous persona would silently skip the next cycle and run
    // a subsequent state under the wrong policy. Clear-then-rewrite
    // ensures the cache is never stale relative to the coordinator's
    // actual state — at worst we re-send an identical `loadPolicy`.
    instance.currentPersonaByBundle.delete(bundle.bundleId);

    const loadPolicy = this.deps.loadPolicyRpc ?? defaultLoadPolicyRpc;
    await loadPolicy({
      socketPath,
      persona,
      policyDir,
      timeoutMs: LOAD_POLICY_RPC_TIMEOUT_MS,
    });
    instance.currentPersonaByBundle.set(bundle.bundleId, persona);
  }

  /**
   * Tears down every bundle this workflow owns. Walks
   * `instance.bundlesByScope.values()` in parallel via `Promise.allSettled`
   * so failures in one bundle's teardown do not block the others. The
   * map is drained before the awaits so a second concurrent caller (e.g.
   * `shutdownAll` racing the fire-and-forget destroy in
   * `handleWorkflowComplete`) sees an empty map and returns without
   * re-entering `destroy`.
   *
   * Callers in recovery paths rely on **expected** failure modes being
   * swallowed so abort/shutdown flows can complete:
   *   - Failures in `destroy(infra)` are logged to stderr and swallowed.
   *   - Failures in socket unlinks are logged and swallowed.
   *
   * **One exception — intentional throw on internal invariant violation.**
   * After teardown the helper asserts `bundlesByScope.size === 0`. A
   * non-empty map at that point is a bug: something added an entry back
   * while teardown was in flight. The invariant is enforced by the
   * abort-guard in `ensureBundleForScope` (post-`factory` flag check);
   * reaching this throw means the guard has a hole and we want it to
   * surface loudly rather than silently strand a bundle. Callers are
   * `abort()`, `shutdownAll()`, and the fire-and-forget `.catch()` in
   * `handleWorkflowComplete` — in the expected invariant-holds case
   * none of them see an exception. A thrown leak assertion in
   * `abort()` / `shutdownAll()` will propagate to their own caller (the
   * test or CLI layer), which is the intended signal.
   */
  private async destroyWorkflowInfrastructure(instance: WorkflowInstance): Promise<void> {
    // Set BEFORE any short-circuit: an in-flight `ensureBundleForScope`
    // that resumes from its `await factory(...)` must observe this flag
    // and tear down its own orphan rather than publishing into the map.
    instance.aborted = true;
    if (instance.bundlesByScope.size === 0) return;

    // Snapshot and clear BEFORE the awaits so a concurrent caller sees
    // an empty map and bails out. See JSDoc for the rationale.
    const bundles = [...instance.bundlesByScope.values()];
    instance.bundlesByScope.clear();

    const destroy = this.deps.destroyWorkflowInfrastructure ?? (await this.loadDefaultInfrastructureTeardown());

    await Promise.allSettled(
      bundles.map(async (infra) => {
        try {
          await destroy(infra);
        } catch (err) {
          writeStderr(
            `[workflow] destroyDockerInfrastructure failed for ${instance.id} (bundle ${infra.bundleId}): ${toErrorMessage(err)}`,
          );
        }

        // Best-effort: unlink the coordinator control socket. Swallow
        // ENOENT because the socket may never have been bound (e.g.,
        // when destroy runs after a failure before control-server attach).
        try {
          unlinkSync(getBundleControlSocketPath(infra.bundleId));
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT') {
            writeStderr(
              `[workflow] Failed to unlink control socket for ${instance.id} (bundle ${infra.bundleId}): ${toErrorMessage(err)}`,
            );
          }
        }
      }),
    );

    // Leak assertion: after snapshot-and-clear + parallel destroy, the
    // map MUST be empty. A non-empty map means a destroy path silently
    // added an entry back after teardown began — a real bug we surface
    // as a synchronous error so it cannot be swallowed.
    if (instance.bundlesByScope.size !== 0) {
      const leaked = [...instance.bundlesByScope.keys()];
      throw new Error(`Leaked workflow bundle scopes after teardown: ${JSON.stringify(leaked)}`);
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
      // Bundle dir holds the bundle's shared Docker artifacts
      // (orientation, sockets, claude-state, escalations, system
      // prompt). It lives under the bundle's per-bundleId subtree so
      // bifurcated workflows can host multiple bundles side by side
      // without key collisions.
      // Audit entries go to the per-bundle audit file (one file per
      // bundle, with per-entry persona tagging).
      const bundleDir = getBundleBundleDir(input.workflowId, input.bundleId);
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
      config.auditLogPath = getBundleAuditLogPath(input.workflowId, input.bundleId);
      applyAllowedDirectoryToMcpArgs(config.mcpServers, input.workspacePath);
      return createDockerInfrastructure(
        config,
        { kind: 'docker', agent: input.agentId },
        bundleDir,
        input.workspacePath,
        bundleEscalationDir,
        input.bundleId,
        // Threading the workflowId + scope here drives the
        // `ironcurtain.workflow` and `ironcurtain.scope` Docker labels
        // emitted by `createSessionContainers()` via `buildBundleLabels`.
        input.workflowId,
        input.scope,
      );
    };
  }

  /** Lazy-loads the default `destroyDockerInfrastructure` helper. */
  private async loadDefaultInfrastructureTeardown(): Promise<(infra: DockerInfrastructure) => Promise<void>> {
    const { destroyDockerInfrastructure } = await import('../docker/docker-infrastructure.js');
    return destroyDockerInfrastructure;
  }

  // -----------------------------------------------------------------------
  // Token-stream accumulation (workflow-scoped totalTokens counter)
  // -----------------------------------------------------------------------
  //
  // The token-stream bus is global (see `getTokenStreamBus()` in
  // `src/docker/token-stream-bus.ts`), so the orchestrator subscribes with
  // `subscribeAll()` and filters inside the listener by the workflow's own
  // session-ID set. Per-workflow rather than per-agent: `ctx.totalTokens`
  // is a workflow-level cumulative sum, so one long-lived subscription is
  // cheaper (one bus listener, one unsubscribe on completion) than
  // subscribing and unsubscribing on every `agent_started` /
  // `agent_session_ended` pair.

  /**
   * Subscribes the workflow to the global token-stream bus. Accumulates
   * `message_end.outputTokens` into `instance.tokens.outputTokens` for any
   * event whose session ID is in `instance.tokens.sessionIds`. The set is managed
   * by `executeAgentState` (added before `agent_started`, removed in the
   * `finally` block after `agent_session_ended`).
   *
   * Installed synchronously so the subscription is live before any agent
   * state runs — no window where bus events go unobserved.
   */
  private setupTokenSubscription(instance: WorkflowInstance): void {
    // Defensive: re-entry by resume-after-crash should not double-subscribe.
    if (instance.tokens.unsubscribe) return;
    instance.tokens.unsubscribe = getTokenStreamBus().subscribeAll((sessionId, event) => {
      if (event.kind !== 'message_end') return;
      if (!instance.tokens.sessionIds.has(sessionId)) return;
      instance.tokens.outputTokens += event.outputTokens;
    });
  }

  /**
   * Tears down the token-stream bus subscription. Idempotent: safe to
   * call from both normal completion and abort paths.
   */
  private teardownTokenSubscription(instance: WorkflowInstance): void {
    if (instance.tokens.unsubscribe) {
      try {
        instance.tokens.unsubscribe();
      } catch {
        // Unsubscribe is best-effort; errors here should never prevent
        // workflow teardown from completing.
      }
      instance.tokens.unsubscribe = undefined;
    }
    instance.tokens.sessionIds.clear();
  }

  // -----------------------------------------------------------------------
  // WorkflowController implementation
  // -----------------------------------------------------------------------

  // Keeps the `async` signature even though the body no longer awaits:
  // (a) preserves the `WorkflowController.start()` contract (Promise<WorkflowId>),
  // (b) leaves a hook for future async bootstrap work without another
  // interface change.
  // eslint-disable-next-line @typescript-eslint/require-await
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
      bundlesByScope: new Map(),
      policyDirByPersona: new Map(),
      tokens: {
        outputTokens: 0,
        sessionIds: new Set(),
      },
      currentPersonaByBundle: new Map(),
      aborted: false,
    };

    // Under `sharedContainer: true`, bundles are minted lazily by
    // `ensureBundleForScope` on the first `executeAgentState` call for
    // each scope. There is no eager workflow-start mint — the first
    // state pays the cost of spinning up the bundle it needs. This also
    // removes a latent "Docker not available" failure mode at workflow
    // registration time: the workflow enters the actor's first state
    // before any Docker resource is touched.

    this.workflows.set(workflowId, instance);
    this.setupTokenSubscription(instance);
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
      bundlesByScope: new Map(),
      policyDirByPersona: new Map(),
      tokens: {
        // Resume picks up the checkpointed totalTokens as the accumulator's
        // starting point so post-resume message_end events keep adding to
        // the running total instead of resetting it.
        outputTokens: checkpoint.context.totalTokens,
        sessionIds: new Set(),
      },
      currentPersonaByBundle: new Map(),
      aborted: false,
    };

    // Resume does NOT reclaim the original containers — any
    // dependencies installed in the previous run are lost. Under the
    // lazy-mint model there is nothing to do at resume time:
    // `bundlesByScope` starts empty and the first state to execute
    // mints its bundle afresh. Container reclamation across resume is
    // tracked as a follow-up.
    if (this.shouldUseSharedContainer(definition)) {
      writeStderr(
        `[workflow] Resuming ${workflowId} in shared-container mode: bundles will be re-created lazily per scope. ` +
          `Any dependencies installed in pre-resume containers are lost.`,
      );
    }

    this.workflows.set(workflowId, instance);
    this.setupTokenSubscription(instance);
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

    // Release the token-stream bus subscription before the async infra
    // teardown so no late events land against a finalized workflow.
    this.teardownTokenSubscription(instance);

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
    // is idempotent when instance.bundlesByScope is empty.
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

    // Shared-container mode only: resolve (or lazily mint) the bundle
    // for this state's scope, rotate the coordinator's audit stream, and
    // swap policy before constructing the borrowing session. In
    // per-state-container mode the new session builds its own
    // coordinator, so there is nothing to cycle.
    //
    // Scope lookup algorithm (docs/designs/workflow-session-identity.md §3):
    //   1. scope := stateConfig.containerScope ?? "primary"
    //   2. bundle := instance.bundlesByScope.get(scope)
    //   3. if absent: lazy-mint via ensureBundleForScope(instance, scope)
    //   4. borrow bundle via SessionOptions.workflowInfrastructure
    let bundle: DockerInfrastructure | undefined;
    if (this.shouldUseSharedContainer(definition)) {
      const scope = stateConfig.containerScope ?? DEFAULT_CONTAINER_SCOPE;
      try {
        bundle = await this.ensureBundleForScope(instance, scope);
      } catch (err) {
        const errMsg = toErrorMessage(err);
        writeStderr(`[workflow] ensureBundleForScope failed for "${stateId}" (scope=${scope}): ${errMsg}`);
        instance.tab.write(`[error] Infrastructure setup failed for "${stateId}": ${errMsg}`);
        instance.messageLog.append({
          ...this.logBase(instance),
          type: 'error',
          error: errMsg,
          context: `ensureBundleForScope "${stateId}" (scope: ${scope})`,
        });
        throw err;
      }

      try {
        await this.cyclePolicy(instance, stateConfig.persona, bundle);
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

    // Agent-CLI conversation identity for this invocation. Decision table
    // (docs/designs/workflow-session-identity.md §3):
    //   - freshSession:false AND prior entry in agentConversationsByState -> reuse
    //   - otherwise -> mint fresh via createAgentConversationId()
    // The Docker adapter decides --session-id vs --resume by probing
    // conversationStateDir for `<agentConversationId>.jsonl`; a minted-fresh
    // id has no prior file, a reused one does.
    const priorConversationId =
      stateConfig.freshSession === false ? context.agentConversationsByState[stateId] : undefined;
    const agentConversationId: AgentConversationId = priorConversationId ?? createAgentConversationId();

    // In borrow mode, route this invocation's per-state artifacts
    // (session.log, session-metadata.json) under a slug-keyed directory
    // inside the workflow run. The XState machine's `incrementVisitCount`
    // entry action runs before `invoke`, so `context.visitCounts[stateId]`
    // is already incremented by the time this factory runs (1 on first
    // entry, 2 on re-entry, etc.).
    const visitCountForSlug = context.visitCounts[stateId];
    const stateSlug = `${stateId}.${visitCountForSlug}`;
    const workflowStateDir = bundle ? getInvocationDir(instance.id, bundle.bundleId, stateSlug) : undefined;
    if (workflowStateDir) {
      mkdirSync(workflowStateDir, { recursive: true });
    }

    let session: Session;
    try {
      session = await this.deps.createSession({
        persona: stateConfig.persona,
        mode,
        agentConversationId,
        workspacePath: instance.workspacePath,
        systemPromptAugmentation: definition.settings?.systemPrompt,
        ...(effectiveModel != null ? { agentModelOverride: effectiveModel } : {}),
        ...(settings.maxSessionSeconds != null
          ? { resourceBudgetOverrides: { maxSessionSeconds: settings.maxSessionSeconds } }
          : {}),
        // Borrow the workflow-scoped Docker bundle so the session does
        // not rebuild proxies / containers per state. Unset for builtin
        // or opt-out workflows.
        ...(bundle ? { workflowInfrastructure: bundle } : {}),
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

      // Shared-container mode: the MITM is long-lived across agents. Flip
      // its routing id so this agent's events land under its own session id
      // (matching what the bridge registers below). Optional-chain because
      // builtin/per-state-container workflows have no shared bundle.
      const agentSessionId = session.getInfo().id;
      bundle?.setTokenSessionId(agentSessionId);
      instance.tokens.sessionIds.add(agentSessionId);

      this.emitLifecycleEvent({
        kind: 'agent_started',
        workflowId,
        state: stateId,
        persona: stateConfig.persona,
        sessionId: agentSessionId,
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
        agentConversationId,
        artifacts,
        outputHash,
        responseText,
        // Snapshot the workflow's cumulative output-token count AT THE
        // END of this agent's turn. The XState assign action uses this
        // value to update ctx.totalTokens; it reflects every `message_end`
        // the bus subscriber has seen so far, including all earlier
        // agents in the workflow.
        totalTokens: instance.tokens.outputTokens,
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
        writeStderr(`[workflow] session.close() failed for "${stateId}": ${toErrorMessage(closeErr)}`);
      });
      // Order: close session (drains in-flight LLM stream) → clear MITM
      // routing → drop from accumulator filter → emit agent_session_ended.
      // Clearing the MITM id before the bridge teardown means any stray
      // late event cannot push under an about-to-be-unregistered label.
      bundle?.setTokenSessionId(undefined);
      instance.tokens.sessionIds.delete(endedSessionId);
      // Pairs 1:1 with agent_started; emitted unconditionally in finally
      // so success, failure, and abort paths all clean up the bridge.
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

    // Release the token-stream bus subscription. Done eagerly (before the
    // async destroyWorkflowInfrastructure) because it's a synchronous
    // callback — idempotent if already cleared by abort().
    this.teardownTokenSubscription(instance);

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
