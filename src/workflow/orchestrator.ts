import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  cpSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { isWithinDirectory } from '../types/argument-roles.js';
import { errorMessage } from '../utils/error-message.js';
import { MessageLog, type AgentRetryReason } from './message-log.js';
import { createHash, type Hash } from 'node:crypto';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import * as http from 'node:http';
import { createActor, fromPromise, type AnyActorRef, type AnyStateMachine, type Snapshot } from 'xstate';
import type {
  WorkflowId,
  WorkflowDefinition,
  WorkflowContext,
  WorkflowStatus,
  WorkflowResult,
  WorkflowCheckpoint,
  ContainerSnapshotRef,
  TransitionRecord,
  HumanGateRequest,
  HumanGateEvent,
  HumanGateStateDefinition,
  AgentStateDefinition,
  DeterministicStateDefinition,
  AgentOutput,
} from './types.js';
import {
  createWorkflowId,
  WORKFLOW_ARTIFACT_DIR,
  GLOBAL_PERSONA,
  DEFAULT_CONTAINER_SCOPE,
  DETERMINISTIC_RESULT_ERROR_VERDICT,
  resolveWorkflowSkillsOptions,
} from './types.js';
import {
  getBundleAuditLogPath,
  getBundleBundleDir,
  getBundleControlSocketPath,
  getBundleRuntimeRoot,
  getBundleStatesDir,
  getInvocationDir,
  nextStateSlug,
} from '../config/paths.js';
import { POLICY_LOAD_PATH } from '../trusted-process/control-server.js';
import { loadConfig, loadPersonaPolicyArtifacts } from '../config/index.js';
import { getBundleCapturesDir } from '../config/paths.js';
import { validatePolicyDir } from '../config/validate-policy-dir.js';
import type { ResolvedUserConfig } from '../config/user-config.js';
import { getTokenStreamBus } from '../docker/token-stream-bus.js';
import { getPersonaDefinitionPath, resolvePersona } from '../persona/resolve.js';
import { isMemoryEnabledForPersonaName } from '../persona/memory-gate.js';
import { extractRequiredServers } from '../trusted-process/policy-roots.js';
import { createPersonaName } from '../persona/types.js';
import { MEMORY_SERVER_NAME } from '../memory/memory-annotations.js';
import type {
  AgentConversationId,
  AgentTurnResult,
  BundleId,
  Session,
  SessionId,
  SessionOptions,
  SessionMode,
} from '../session/types.js';
import { createAgentConversationId, createBundleId } from '../session/types.js';
import {
  CONTAINER_WORKSPACE_DIR,
  describeTransientFailureKind,
  type AgentId,
  type TransientFailureKind,
} from '../docker/agent-adapter.js';
import {
  buildWorkflowExecCommand,
  ensureSecureBundleDir,
  type DockerInfrastructure,
} from '../docker/docker-infrastructure.js';
import type { ContainerRuntime } from '../docker/types.js';
import {
  buildWorkflowMachine,
  type AgentInvokeInput,
  type AgentInvokeResult,
  type DeterministicInvokeInput,
  type DeterministicInvokeResult,
  type FanOutInvokeInput,
  type FanOutInvokeResult,
  type RoundChildOutcome,
  type RoundChildStatus,
  type RoundChildSummary,
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
import {
  DEFAULT_EVOLVE_LANE_DIR,
  DEFAULT_EVOLVE_LANE_RELATIVE_DIR,
  evolveResultScriptIndex,
  evolveStepName,
  resolveFanOutWorkers,
} from './lane-template.js';
import { collectFilesRecursive, hasAnyFiles, snapshotArtifacts } from './artifacts.js';
import {
  isSafeWorkspaceRelativePath,
  parseArtifactRef,
  validateDefinition,
  validateWorkflowSkillReferences,
} from './validate.js';
import { parseDefinitionFile, getWorkflowPackageDir } from './discovery.js';
import { resolveSkillsForSession } from '../skills/discovery.js';
import type { ResolvedSkill } from '../skills/types.js';
import { discoverWorkflowRuns } from './workflow-discovery.js';
import { isCheckpointResumable } from './checkpoint.js';
import {
  AgentInvocationError,
  WorkflowQuotaExhaustedError,
  WorkflowTransientFailureError,
  isWorkflowQuotaExhaustedError,
  isWorkflowTransientFailureError,
} from './errors.js';
import { commitContainerSnapshot, removeContainerSnapshotImages } from './container-snapshots.js';

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
 * Narrows a finished child round actor's `snapshot.value` to the closed
 * {@link RoundChildStatus} union. The child machine always terminates in one
 * of its three synthetic terminals (`recorded`/`blocked`/`errored`), so this
 * normally just confirms the name. An unrecognized terminal — which should be
 * unreachable in a validated definition — is treated as `errored`, the
 * conservative fail verdict, rather than silently passing as `recorded`.
 */
function toRoundChildStatus(value: unknown, index: number): RoundChildStatus {
  if (value === 'recorded' || value === 'blocked' || value === 'errored') {
    return value;
  }
  writeStderr(`[workflow] fan-out child ${index} ended in unexpected terminal "${String(value)}"; treating as errored`);
  return 'errored';
}

/**
 * The settled outcome of the first lane to reach `blocked`/`errored`, passed to
 * every un-settled peer so they can be drained (stopped) on its behalf. Carries
 * the trigger's `index`/`status`/`context` plus the `reason` computed ONCE at
 * the trigger source ({@link roundChildReason}) and threaded through, so neither
 * the drain log nor each drained peer's `drainedBy` recomputes it.
 */
type RoundChildDrainTrigger = Pick<RoundChildOutcome, 'index' | 'status' | 'context'> & {
  readonly status: 'blocked' | 'errored';
  readonly reason: string;
};

/**
 * The two-phase join handle for one lane. `promise` resolves either by the
 * child's own snapshot reaching a terminal (natural settle) or by an external
 * {@link drain} call (a peer blocked/errored). `isSettled` is the first-wins
 * guard the drain loop checks so a lane that already settled is never drained;
 * `drain` is the external resolver that natural-settle alone cannot express
 * (see {@link waitForRoundChild} for why `xstate.waitFor` does not fit).
 */
interface RoundChildWaiter {
  readonly index: number;
  readonly actor: AnyActorRef;
  readonly promise: Promise<RoundChildOutcome>;
  readonly isSettled: () => boolean;
  readonly drain: (trigger: RoundChildDrainTrigger) => void;
}

/**
 * One blocked/errored lane as it appears in the aggregated gate's `issues`
 * payload — the wire shape the human reviewer sees per offending lane. The
 * `reason` is the lane's surfaced cause (see {@link roundChildReason}).
 */
interface FanOutIssue {
  readonly index: number;
  readonly status: 'blocked' | 'errored';
  readonly reason: string;
}

interface EvolveRecordedLane {
  readonly index: number;
  readonly batchIndex: number;
  readonly stepName: string;
  readonly nodeId?: number;
  readonly parent?: readonly number[];
  readonly stepDir?: string;
}

interface FanOutDbReconstruction {
  readonly batchIndex: number;
  readonly recordedByLane: ReadonlyMap<number, EvolveRecordedLane>;
  readonly missingLanes: readonly number[];
  readonly runDir: string;
}

type FanOutDbReconstructionResult =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'ready'; readonly reconstruction: FanOutDbReconstruction }
  | { readonly kind: 'error'; readonly error: string };

/**
 * Crash-resume overrides threaded into the barrier `sample_batch`: `batchIndex`
 * pins the in-flight `step_<batch>_lane_<k>` number (so re-run lanes reuse their
 * pre-crash step names) and `lanes` restricts the draw to the lanes that did not
 * record before the crash. Both default to "fresh batch" when omitted (bridge
 * derives the index, draws all `workers` lanes). See {@link reconstructFanOutBatchFromDb}.
 */
interface FanOutBatchOptions {
  readonly batchIndex?: number;
  readonly lanes?: readonly number[];
}

// Parses the fan-out step name `step_<batch>(_lane_<k>)?`: group 1 = batch index,
// group 2 = lane id (undefined for legacy non-lane `step_<batch>` nodes). The
// TS twin of Python STEP_NAME_RE in scripts/evolve_result.py; the writer is
// {@link evolveStepName} in lane-template.ts. All three move together.
const EVOLVE_LANE_STEP_RE = /^step_(\d+)(?:_lane_(\d+))?$/;

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

/** Per-run subdirectory name for the staged copy of the workflow's bundled `skills/` tree. */
const STAGED_WORKFLOW_SKILLS_SUBDIR = 'workflow-skills';
/** Per-run subdirectory name for the staged copy of workflow helper scripts. */
const STAGED_WORKFLOW_SCRIPTS_SUBDIR = 'workflow-scripts';

/**
 * Workspace-relative segments of the evolve engine's per-step code directory:
 * `<workspace>/.evolve_runs/main/steps/<step_name>/code`.
 *
 * This layout is OWNED by the Python bridge (`evolve_result.py` — the engine
 * writes each candidate's source under `steps/<step_name>/code`, and
 * `evolve-eval` reads it from there). The TS side only READS it host-side to
 * content-hash fan-out candidates ({@link computeFanOutCandidateDuplicateStats}),
 * so this const duplicates a path the Python defines. Keep the two in sync: if
 * the engine's on-disk step layout changes, update both here and in the bridge.
 */
const EVOLVE_STEP_CODE_PATH_SEGMENTS = ['.evolve_runs', 'main', 'steps'] as const;
const EVOLVE_STEP_CODE_FILENAME = 'code';

/**
 * Stages the workflow package's `skills/` tree into the run directory
 * so the workflow becomes self-contained at start time. After this call
 * the per-run path (`<runMetaDir>/workflow-skills/`) is the canonical
 * source of workflow-bundled skills for both initial-set staging and
 * per-state restage; the original package path under
 * `getWorkflowPackageDir(definitionPath)` is no longer consulted at
 * runtime.
 *
 * Returns the absolute path to the staged copy when source `skills/`
 * exists and was copied, `undefined` when the source has no `skills/`
 * directory (the workflow simply ships none — not an error). Throws
 * only on copy I/O failure, since a half-copied tree would be worse
 * than a missing one.
 *
 * Why copy at start (not symlink): the package directory may be
 * deleted, moved, or rebuilt between start and resume — symlink chases
 * lead to "skills silently empty on resume" without diagnostic. A
 * shallow-recursive copy decouples the run from its source-of-record
 * location.
 */
export function stageWorkflowSkillsAtStart(packageDir: string, runMetaDir: string): string | undefined {
  return stageWorkflowSubdir(packageDir, runMetaDir, 'skills', STAGED_WORKFLOW_SKILLS_SUBDIR);
}

export function stageWorkflowScriptsAtStart(packageDir: string, runMetaDir: string): string | undefined {
  return stageWorkflowSubdir(packageDir, runMetaDir, 'scripts', STAGED_WORKFLOW_SCRIPTS_SUBDIR);
}

/**
 * Shallow-recursive copy of a workflow package subdir (`skills` / `scripts`) into
 * the run dir. Returns the staged path, or `undefined` when the source subdir is
 * absent (the workflow ships none — not an error). Throws only on copy I/O
 * failure (a half-copied tree is worse than a missing one). See
 * `stageWorkflowSkillsAtStart` above for why we copy rather than symlink.
 */
function stageWorkflowSubdir(
  packageDir: string,
  runMetaDir: string,
  sourceSubdir: string,
  stagedSubdir: string,
): string | undefined {
  const source = resolve(packageDir, sourceSubdir);
  if (!existsSync(source)) return undefined;

  const stagedDir = resolve(runMetaDir, stagedSubdir);
  cpSync(source, stagedDir, { recursive: true });
  return stagedDir;
}

/**
 * Resolves the workflow-skills directory to use for a resumed workflow.
 *
 * Priority order, from most-trusted to most-degraded:
 *   1. The checkpointed staged path, if it still exists. The orchestrator
 *      writes this at start under the run dir; we own the lifecycle so
 *      it should normally still be there.
 *   2. A fresh stage from the original package dir, when the staged
 *      copy is gone but the source is reachable. Recovers from manual
 *      pruning of the run dir without losing skills on resume.
 *   3. `undefined`, with a stderr warning. Both the staged copy and
 *      the source are gone; degrade gracefully but make the loss
 *      visible (the original bug — silent empty discovery — is what
 *      this whole resolver exists to prevent).
 *
 * Pre-feature checkpoints have no `workflowSkillsDir` field; they
 * trigger the case-(2) fresh stage transparently.
 */
function resolveWorkflowSkillsDirOnResume(opts: {
  workflowId: WorkflowId;
  checkpointedStagedDir: string | undefined;
  packageDir: string;
  runMetaDir: string;
}): string | undefined {
  const { workflowId, checkpointedStagedDir, packageDir, runMetaDir } = opts;

  if (checkpointedStagedDir !== undefined && existsSync(checkpointedStagedDir)) {
    return checkpointedStagedDir;
  }

  try {
    const restaged = stageWorkflowSkillsAtStart(packageDir, runMetaDir);
    if (restaged !== undefined) {
      writeStderr(
        `[workflow] Resume ${workflowId}: workflow-skills staged copy missing, re-staged from ${packageDir}.`,
      );
      return restaged;
    }
  } catch (err) {
    writeStderr(
      `[workflow] Resume ${workflowId}: failed to re-stage workflow skills from ${packageDir}: ${toErrorMessage(err)}`,
    );
    return undefined;
  }

  // Both paths gone. Without this warning the resumed run silently
  // loses every workflow-bundled skill — the exact failure mode this
  // function was added to prevent.
  writeStderr(
    `[workflow] Resume ${workflowId}: no workflow-skills available (staged copy and ${packageDir}/skills both missing). Workflow-bundled skills will not be available in this run.`,
  );
  return undefined;
}

function resolveWorkflowScriptsDirOnResume(opts: {
  workflowId: WorkflowId;
  checkpointedStagedDir: string | undefined;
  packageDir: string;
  runMetaDir: string;
}): string | undefined {
  const { workflowId, checkpointedStagedDir, packageDir, runMetaDir } = opts;

  if (checkpointedStagedDir !== undefined && existsSync(checkpointedStagedDir)) {
    return checkpointedStagedDir;
  }

  try {
    const restaged = stageWorkflowScriptsAtStart(packageDir, runMetaDir);
    if (restaged !== undefined) {
      writeStderr(
        `[workflow] Resume ${workflowId}: workflow-scripts staged copy missing, re-staged from ${packageDir}.`,
      );
      return restaged;
    }
  } catch (err) {
    writeStderr(
      `[workflow] Resume ${workflowId}: failed to re-stage workflow scripts from ${packageDir}: ${toErrorMessage(err)}`,
    );
    return undefined;
  }

  // Both paths gone. Only warn if scripts were previously staged
  // (`checkpointedStagedDir` set): a workflow that never shipped scripts must not
  // warn about "missing" scripts on every resume. `stageWorkflowScriptsAtStart`
  // already proved `scripts/` is absent here, so no source re-stat is needed.
  if (checkpointedStagedDir === undefined) {
    return undefined;
  }

  writeStderr(
    `[workflow] Resume ${workflowId}: no workflow-scripts available (staged copy and ${packageDir}/scripts both missing). Container deterministic helpers will not be available in this run.`,
  );
  return undefined;
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
  /** Union of MCP server names required across every agent state in this scope. */
  readonly requiredServers: ReadonlySet<string>;
  /**
   * Initial skills staged at bundle creation (user + workflow only).
   * Persona skills are layered in per-state via `bundle.restageSkills`.
   */
  readonly resolvedSkills?: readonly ResolvedSkill[];
  /** Per-run staged workflow scripts directory to mount read-only in the bundle. */
  readonly workflowScriptsDir?: string;
  /** Optional immutable snapshot image digest to use for the main container. */
  readonly baseImageOverride?: string;
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
   * Resolved user config. Consulted by `getRequiredServersForScope` to
   * decide whether to mint the memory relay for a shared-container
   * bundle (memory is opt-in per persona; see
   * docs/designs/per-persona-memory-optin.md).
   */
  readonly userConfig: ResolvedUserConfig;

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

  /**
   * Raw trajectory-capture override for this workflow run (CLI
   * `--capture-traces` flag). Passed UNRESOLVED to the infrastructure
   * factory, which is the single place that resolves it against
   * `userConfig.capture?.enabled`. When resolution yields true, the
   * factory constructs a writer for each bundle and `executeAgentState`
   * brackets each agent's session with `bundle.beginCaptureSession` /
   * `bundle.endCaptureSession`. Undefined falls through to config.
   * See docs/designs/mitm-token-trajectory-capture.md §10.
   */
  readonly captureTracesOverride?: boolean;
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
  /**
   * Per-run staged copy of the workflow package's `skills/` tree. Set
   * by `start()` (when the package ships skills) and by `resume()`
   * (which trusts the checkpointed path or re-stages on miss). All
   * runtime call sites that previously recomputed
   * `getWorkflowPackageDir(definitionPath) + '/skills'` read this
   * cached path instead — guarantees a stable directory across the
   * lifetime of the run even if the original package moves.
   *
   * `undefined` means the workflow has no bundled skills (either the
   * package shipped none, or both the staged copy and the source were
   * lost on resume — see `resolveWorkflowSkillsDirOnResume`).
   */
  readonly workflowSkillsDir: string | undefined;
  readonly workflowScriptsDir: string | undefined;
  readonly containerSnapshots: Readonly<Record<string, ContainerSnapshotRef>> | undefined;
  readonly actor: AnyActorRef;
  readonly roundMachinesByState: ReadonlyMap<string, AnyStateMachine>;
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
   * Last persona loaded into each bundle's coordinator, keyed by
   * `BundleId`. `cyclePolicy` consults this and skips the `loadPolicy`
   * RPC when a re-entry would install the same persona that is already
   * active — the coordinator's audit stream is already tagged with the
   * right persona and the policy engine is already correct.
   */
  readonly currentPersonaByBundle: Map<string, string>;
  /**
   * Required-server snapshot taken at bundle mint, keyed by `BundleId`.
   * `cyclePolicy` checks each newly loaded persona's required servers
   * against this set so a mid-workflow persona recompile that adds a
   * server fails fast with a clear error instead of producing cryptic
   * "tool unavailable" runtime failures (no relay was spawned for the
   * new server).
   */
  readonly mintedServersByBundle: Map<string, ReadonlySet<string>>;
  /**
   * Set once `destroyWorkflowInfrastructure` begins teardown. An
   * `ensureBundleForScope` call that suspended at `await factory(...)`
   * must observe this flag before publishing into `bundlesByScope` —
   * otherwise a container minted mid-abort would leak past the
   * post-teardown leak assertion.
   */
  aborted: boolean;
  /**
   * Tracks the fire-and-forget Docker teardown started by
   * `handleWorkflowComplete` on a normal terminal. The terminal handler runs
   * inside the synchronous actor subscription and so cannot await teardown;
   * it stores the promise here instead. `shutdownAll` drains it so the CLI's
   * `process.exit()` does not race the in-flight teardown and orphan the
   * per-run `--internal` Docker network. Note that `destroyWorkflowInfrastructure`
   * snapshot-and-clears `bundlesByScope` synchronously, so a redundant destroy
   * pass no-ops while the real work stays captured in this promise — awaiting
   * it is the only way to observe teardown completion. The apple-container
   * backend loses this race every time (its VM shutdown is slow), so draining
   * the promise matters there in particular.
   */
  teardownPromise?: Promise<void>;
  /**
   * Stamped by `throwIfQuotaExhausted` when an agent turn reports
   * upstream quota exhaustion. `handleWorkflowComplete` consults this
   * to force an abort-like terminal phase and preserve the checkpoint,
   * regardless of which state the error target resolved to — so resume
   * still works for workflow definitions whose error target happens to
   * be a normal terminal (e.g. `done`) rather than `aborted`/`failed`.
   * Survives only in-process; the checkpoint itself does not record it.
   */
  quotaExhausted?: { readonly resetAt?: Date; readonly rawMessage: string };
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
   * Sibling of `quotaExhausted`: drives the same checkpoint-preserving
   * abort path. Survives only in-process; the checkpoint does not
   * record it.
   *
   * Initial-state caveat: the orchestrator only checkpoints on actual
   * state transitions, so a transient failure on the `initial:` state
   * has no prior checkpoint to preserve and resume will re-enter the
   * terminal rather than the failing state. Applies to `quotaExhausted`
   * too; closing requires a checkpoint-on-start change.
   */
  transientFailure?: { readonly kind: TransientFailureKind; readonly rawMessage: string };
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

    const requiredServers = this.getRequiredServersForScope(instance, scope);
    // Persona-less initial set; per-state restaging fills in persona skills later.
    // Reads the cached per-run staged path (set at start / resume) so
    // the bundle never depends on the original package directory still
    // being on disk.
    const resolvedSkills = resolveSkillsForSession({ workflowSkillsDir: instance.workflowSkillsDir });
    const factory = this.deps.createWorkflowInfrastructure ?? (await this.loadDefaultInfrastructureFactory());
    const baseImageOverride = instance.containerSnapshots?.[scope]?.image;
    const infra = await factory({
      workflowId: instance.id,
      bundleId,
      agentId,
      controlSocketPath,
      workspacePath: instance.workspacePath,
      scope,
      requiredServers,
      resolvedSkills,
      workflowScriptsDir: instance.workflowScriptsDir,
      baseImageOverride,
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
    instance.mintedServersByBundle.set(bundleId, requiredServers);
    return infra;
  }

  /**
   * Returns the cached policyDir for `persona`, canonicalizing on first
   * lookup so required-server derivation and the coordinator's
   * `loadPolicy` RPC operate on the same realpath-resolved file (any
   * symlink under the persona dir is collapsed once, here, instead of
   * re-resolved by every reader).
   */
  private getPolicyDir(instance: WorkflowInstance, persona: string): string {
    const cached = instance.policyDirByPersona.get(persona);
    if (cached !== undefined) return cached;
    const dir = validatePolicyDir(resolvePersonaPolicyDir(persona));
    instance.policyDirByPersona.set(persona, dir);
    return dir;
  }

  /**
   * Computes the union of MCP server names required by every agent state
   * sharing `scope`. Threaded into the workflow infrastructure factory so
   * the bundle only spawns proxies the policies actually reference.
   */
  private getRequiredServersForScope(instance: WorkflowInstance, scope: string): ReadonlySet<string> {
    const union = new Set<string>();
    const seenPersonas = new Set<string>();
    for (const stateConfig of Object.values(instance.definition.states)) {
      if (stateConfig.type !== 'agent') continue;
      const stateScope = stateConfig.containerScope ?? DEFAULT_CONTAINER_SCOPE;
      if (stateScope !== scope) continue;
      if (seenPersonas.has(stateConfig.persona)) continue;
      seenPersonas.add(stateConfig.persona);
      const { compiledPolicy } = loadPersonaPolicyArtifacts(this.getPolicyDir(instance, stateConfig.persona));
      for (const server of extractRequiredServers(compiledPolicy)) {
        union.add(server);
      }
      // Memory is bolt-on (not in compiled policy). `Set.add` is
      // idempotent, so adding here per-persona preserves any-wants-it.
      if (isMemoryEnabledForPersonaName(stateConfig.persona, this.deps.userConfig)) {
        union.add(MEMORY_SERVER_NAME);
      }
    }
    return union;
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

    const policyDir = this.getPolicyDir(instance, persona);

    // Guard against mid-workflow recompiles that add a server: the bundle
    // was minted with a fixed required-server set, so a new policy that
    // expands the set would have the coordinator allow tools no relay was
    // spawned for. Fail fast with a clear error instead.
    const minted = instance.mintedServersByBundle.get(bundle.bundleId);
    if (minted) {
      const { compiledPolicy } = loadPersonaPolicyArtifacts(policyDir);
      const newServers = extractRequiredServers(compiledPolicy);
      const added: string[] = [];
      for (const s of newServers) if (!minted.has(s)) added.push(s);
      if (added.length > 0) {
        throw new Error(
          `Persona "${persona}" requires server(s) [${added.join(', ')}] that were not spawned for this scope ` +
            `(bundle minted with [${[...minted].sort().join(', ')}]). ` +
            `A persona recompile that expands the server set requires restarting the workflow.`,
        );
      }
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
  private destroyWorkflowInfrastructure(instance: WorkflowInstance): Promise<void> {
    // Set BEFORE any short-circuit: an in-flight `ensureBundleForScope`
    // that resumes from its `await factory(...)` must observe this flag
    // and tear down its own orphan rather than publishing into the map.
    instance.aborted = true;

    // Join semantics: the first caller starts the teardown; concurrent
    // and later callers await the SAME promise. This is what lets the
    // CLI's shutdownAll() block until the fire-and-forget destroy from
    // handleWorkflowComplete has actually finished, instead of bailing
    // on the already-cleared map and letting process.exit() kill the
    // teardown mid-flight (leaking the container, its network, and the
    // MCP relay subprocesses).
    instance.teardownPromise ??= this.runBundleTeardown(instance);
    return instance.teardownPromise;
  }

  /** Body of the bundle teardown; only ever started once per instance. */
  private async runBundleTeardown(instance: WorkflowInstance): Promise<void> {
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

  private shouldSnapshotOnStop(instance: WorkflowInstance): boolean {
    if (!this.shouldUseSharedContainer(instance.definition)) return false;
    if (instance.definition.settings?.snapshotOnStop !== true) return false;
    return this.deps.userConfig.snapshot.enabled;
  }

  private async snapshotResumableScopes(
    instance: WorkflowInstance,
  ): Promise<Readonly<Record<string, ContainerSnapshotRef>> | undefined> {
    if (!this.shouldSnapshotOnStop(instance)) return undefined;
    const entries = [...instance.bundlesByScope.entries()];
    if (entries.length === 0) return undefined;

    const snapshots: Record<string, ContainerSnapshotRef> = {};
    for (const [scope, infra] of entries) {
      // Container snapshots require Docker's commit/image APIs, which the Apple
      // `container` runtime does not provide. Skip cleanly (the workflow stops
      // without a resumable container snapshot) rather than attempting a commit
      // that the runtime would reject.
      if (infra.runtimeKind !== 'docker') {
        writeStderr(
          `[workflow] Container snapshots are not supported on the "${infra.runtimeKind}" runtime; ` +
            `stopping ${instance.id} scope "${scope}" without a snapshot.`,
        );
        continue;
      }
      try {
        snapshots[scope] = await commitContainerSnapshot({
          docker: infra.docker,
          workflowId: instance.id,
          scope,
          containerId: infra.containerId,
        });
      } catch (err) {
        writeStderr(
          `[workflow] Failed to snapshot container for ${instance.id} scope "${scope}": ${toErrorMessage(err)}`,
        );
      }
    }
    return Object.keys(snapshots).length > 0 ? snapshots : undefined;
  }

  private async dockerForSnapshotCleanup(instance: WorkflowInstance): Promise<ContainerRuntime> {
    if (instance.bundlesByScope.size > 0) {
      return [...instance.bundlesByScope.values()][0].docker;
    }
    const { createDockerManager } = await import('../docker/docker-manager.js');
    return createDockerManager();
  }

  private async removeSnapshotImagesAfterTeardown(
    docker: ContainerRuntime,
    snapshots: Readonly<Record<string, ContainerSnapshotRef>> | undefined,
  ): Promise<void> {
    if (!snapshots || Object.keys(snapshots).length === 0) return;
    await removeContainerSnapshotImages(docker, snapshots).catch((err: unknown) => {
      writeStderr(`[workflow] Failed to remove container snapshot image(s): ${toErrorMessage(err)}`);
    });
  }

  /**
   * Builds and persists the terminal checkpoint, preserving the prior on-disk
   * machineState/context (which point at the last non-terminal save point) so
   * resume re-enters that state instead of the terminal snapshot. Shared by the
   * abort() and handleWorkflowComplete() stop paths.
   */
  private saveTerminalCheckpoint(
    instance: WorkflowInstance,
    finalStatus: WorkflowStatus,
    containerSnapshots: Readonly<Record<string, ContainerSnapshotRef>> | undefined,
    existing: WorkflowCheckpoint | undefined,
  ): void {
    try {
      const terminalCheckpoint = this.buildCheckpoint(
        instance,
        instance.actor.getSnapshot() as { value: unknown; context: unknown },
        finalStatus,
        containerSnapshots,
      );
      const checkpoint = existing
        ? { ...terminalCheckpoint, machineState: existing.machineState, context: existing.context }
        : terminalCheckpoint;
      this.deps.checkpointStore.save(instance.id, checkpoint);
    } catch (err) {
      writeStderr(`[workflow] Failed to save terminal checkpoint for ${instance.id}: ${toErrorMessage(err)}`);
    }
  }

  private snapshotsSupersededBy(
    previous: Readonly<Record<string, ContainerSnapshotRef>> | undefined,
    next: Readonly<Record<string, ContainerSnapshotRef>> | undefined,
  ): Readonly<Record<string, ContainerSnapshotRef>> | undefined {
    if (!previous) return undefined;
    const nextImages = new Set(Object.values(next ?? {}).map((snapshot) => snapshot.image));
    const superseded: Record<string, ContainerSnapshotRef> = {};
    for (const [scope, snapshot] of Object.entries(previous)) {
      if (!nextImages.has(snapshot.image)) {
        superseded[scope] = snapshot;
      }
    }
    return Object.keys(superseded).length > 0 ? superseded : undefined;
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
    const { filterMcpServersByPolicy } = await import('../persona/resolve.js');

    // The raw `--capture-traces` override is threaded through unresolved;
    // the infrastructure factory is the single place that resolves it
    // against `userConfig.capture?.enabled`. The same raw override is
    // applied to every scope's bundle.
    const captureTracesOverride = this.deps.captureTracesOverride;

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
      config.mcpServers = filterMcpServersByPolicy(config.mcpServers, input.requiredServers);
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
        input.resolvedSkills,
        {
          override: captureTracesOverride,
          capturesDir: getBundleCapturesDir(input.workflowId, input.bundleId),
          recordedAgentName: input.agentId,
          workflowRunId: input.workflowId,
        },
        input.workflowScriptsDir,
        input.baseImageOverride ? { baseImageOverride: input.baseImageOverride } : undefined,
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
    validateWorkflowSkillReferences(definition, getWorkflowPackageDir(definitionPath));
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

    // Stage the workflow package's `skills/` tree into the run dir so
    // resume is independent of whether the original package path still
    // exists. Cached on the instance and persisted in every checkpoint
    // so all subsequent reads point at this stable per-run copy.
    const workflowSkillsDir = stageWorkflowSkillsAtStart(getWorkflowPackageDir(definitionPath), metaDir);
    const workflowScriptsDir = stageWorkflowScriptsAtStart(getWorkflowPackageDir(definitionPath), metaDir);

    const { machine, roundMachinesByState, gateStateNames, terminalStateNames } = buildWorkflowMachine(
      definition,
      taskDescription,
    );

    const providedMachine = this.provideActors(machine, workflowId, definition, roundMachinesByState);
    const actor = createActor(providedMachine);
    const tab = this.deps.createWorkflowTab(definition.name, workflowId);
    const messageLog = new MessageLog(resolve(this.deps.baseDir, workflowId, 'messages.jsonl'));

    const instance: WorkflowInstance = {
      id: workflowId,
      definition,
      definitionPath,
      workflowSkillsDir,
      workflowScriptsDir,
      containerSnapshots: undefined,
      actor,
      roundMachinesByState,
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
      currentPersonaByBundle: new Map(),
      mintedServersByBundle: new Map(),
      aborted: false,
      tokens: {
        outputTokens: 0,
        sessionIds: new Set(),
      },
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

    const { machine, roundMachinesByState, gateStateNames, terminalStateNames } = buildWorkflowMachine(
      definition,
      checkpoint.context.taskDescription,
    );

    const providedMachine = this.provideActors(machine, workflowId, definition, roundMachinesByState);

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

    // Resolve workflow-skills with the run-dir staged copy as primary,
    // a fresh re-stage from the original package dir as recovery, and
    // a logged `undefined` as the last-resort degradation. See
    // `resolveWorkflowSkillsDirOnResume` for the full priority order.
    //
    // Recovery uses `checkpoint.definitionPath` (the user's original
    // package), not `definitionPath` — the latter resolves to the
    // run-dir copy of `definition.json` whose `getWorkflowPackageDir`
    // is the run dir itself, which never contains a sibling `skills/`.
    const runMetaDir = resolve(this.deps.baseDir, workflowId);
    const workflowSkillsDir = resolveWorkflowSkillsDirOnResume({
      workflowId,
      checkpointedStagedDir: checkpoint.workflowSkillsDir,
      packageDir: getWorkflowPackageDir(checkpoint.definitionPath),
      runMetaDir,
    });
    const workflowScriptsDir = resolveWorkflowScriptsDirOnResume({
      workflowId,
      checkpointedStagedDir: checkpoint.workflowScriptsDir,
      packageDir: getWorkflowPackageDir(checkpoint.definitionPath),
      runMetaDir,
    });

    const instance: WorkflowInstance = {
      id: workflowId,
      definition,
      definitionPath: checkpoint.definitionPath,
      workflowSkillsDir,
      workflowScriptsDir,
      containerSnapshots: checkpoint.containerSnapshots,
      actor,
      roundMachinesByState,
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
      currentPersonaByBundle: new Map(),
      mintedServersByBundle: new Map(),
      aborted: false,
      tokens: {
        // Resume picks up the checkpointed totalTokens as the accumulator's
        // starting point so post-resume message_end events keep adding to
        // the running total instead of resetting it.
        outputTokens: checkpoint.context.totalTokens,
        sessionIds: new Set(),
      },
    };

    // Under the lazy-mint model there is nothing to create at resume
    // time: `bundlesByScope` starts empty and the first state to execute
    // mints its bundle. When the checkpoint carries snapshot digests,
    // the per-scope mint path uses them as immutable image overrides
    // after an imageExists guard; missing images degrade to fresh.
    if (this.shouldUseSharedContainer(definition)) {
      const restoredScopes = Object.keys(checkpoint.containerSnapshots ?? {});
      const snapshotNote =
        restoredScopes.length > 0
          ? ` Snapshot restore available for scope(s): ${restoredScopes.join(', ')}.`
          : ' No container snapshots recorded; scopes will start fresh.';
      writeStderr(
        `[workflow] Resuming ${workflowId} in shared-container mode: bundles will be re-created lazily per scope.${snapshotNote}`,
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
    let servicePromise: Promise<unknown>;
    if (stateDef.type === 'agent') {
      servicePromise =
        stateDef.fanOut !== undefined
          ? this.runFanOutSegment(
              workflowId,
              { stateId, stateConfig: stateDef, context },
              definition,
              instance.roundMachinesByState,
            )
          : this.executeAgentState(workflowId, { stateId, stateConfig: stateDef, context }, definition);
    } else if (stateDef.fanOut !== undefined) {
      servicePromise = this.runFanOutSegment(
        workflowId,
        { stateId, stateConfig: stateDef, context },
        definition,
        instance.roundMachinesByState,
      );
    } else {
      servicePromise = this.executeDeterministicState(workflowId, {
        stateId,
        commands: stateDef.run,
        context,
        container: stateDef.container ?? false,
        containerScope: stateDef.containerScope,
        timeoutMs: stateDef.timeoutMs,
        resultFile: stateDef.resultFile,
      });
    }

    // Feed the result back to the actor as an XState internal invoke event.
    // These event types don't exist in our WorkflowEvent union, so we cast
    // through unknown to satisfy TypeScript while matching XState's internal
    // event format that onDone/onError handlers expect.
    servicePromise
      .then((output) => {
        instance.actor.send({ type: `xstate.done.actor.${stateId}`, output });
      })
      .catch((err: unknown) => {
        instance.actor.send({ type: `xstate.error.actor.${stateId}`, error: err });
      });
  }

  listResumable(): WorkflowId[] {
    const runs = discoverWorkflowRuns(this.deps.baseDir);
    const activeIds = new Set(this.listActive());
    const resumable: WorkflowId[] = [];
    for (const run of runs) {
      if (!run.hasCheckpoint || activeIds.has(run.workflowId)) continue;
      // FileCheckpointStore.load() re-throws on JSON.parse failure (it only
      // swallows ENOENT). A single corrupt checkpoint.json would otherwise
      // poison the whole list and break `workflow inspect` discovery + the
      // web UI past-runs panel. Skip and log instead.
      let cp;
      try {
        cp = this.deps.checkpointStore.load(run.workflowId);
      } catch (err) {
        writeStderr(
          `[workflow] Failed to load checkpoint for ${run.workflowId}: ${toErrorMessage(err)}; skipping in resumable list`,
        );
        continue;
      }
      if (cp !== undefined && isCheckpointResumable(cp)) {
        resumable.push(run.workflowId);
      }
    }
    return resumable;
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
      // A terminal transition is already in flight (e.g. a natural completion
      // racing this abort). Wait for its teardown instead of starting a second
      // one. `teardownPromise` is only set by the fire-and-forget completion
      // path; awaiting `undefined` is a no-op on the abort-vs-abort race.
      await instance.teardownPromise;
      return;
    }

    // Claim the terminal synchronously, BEFORE the first await below, so a
    // natural completion firing during session close sees `finalStatus` set
    // and bails at its own guard. This is the single-flight gate that
    // guarantees exactly-once snapshot + teardown across abort/complete.
    instance.finalStatus = {
      phase: 'aborted',
      reason: 'Workflow aborted by user',
    };

    const closePromises: Promise<void>[] = [];
    for (const session of instance.activeSessions) {
      closePromises.push(session.close().catch(() => {}));
    }
    await Promise.allSettled(closePromises);
    instance.activeSessions.clear();

    instance.actor.stop();

    let previousCheckpoint: WorkflowCheckpoint | undefined;
    try {
      previousCheckpoint = this.deps.checkpointStore.load(id);
    } catch (err) {
      writeStderr(`[workflow] Failed to load existing checkpoint during abort for ${id}: ${toErrorMessage(err)}`);
    }
    const containerSnapshots = await this.snapshotResumableScopes(instance);
    this.saveTerminalCheckpoint(instance, instance.finalStatus, containerSnapshots, previousCheckpoint);

    // Release the token-stream bus subscription before the async infra
    // teardown so no late events land against a finalized workflow.
    this.teardownTokenSubscription(instance);

    // Tear down workflow-scoped Docker infrastructure after all sessions
    // are closed. Error-tolerant (see destroyWorkflowInfrastructure).
    const snapshotsToRemove = this.snapshotsSupersededBy(previousCheckpoint?.containerSnapshots, containerSnapshots);
    const cleanupDocker = snapshotsToRemove ? await this.dockerForSnapshotCleanup(instance) : undefined;
    await this.destroyWorkflowInfrastructure(instance);
    if (cleanupDocker) {
      await this.removeSnapshotImagesAfterTeardown(cleanupDocker, snapshotsToRemove);
    }

    // Intentionally leave the checkpoint in place: a user-triggered abort
    // should remain resumable via `workflow resume`. The checkpoint is only
    // removed on successful completion (see handleWorkflowComplete).

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
    // Drain any fire-and-forget teardown started by `handleWorkflowComplete`
    // on a normal terminal. Because `destroyWorkflowInfrastructure`
    // snapshot-and-clears `bundlesByScope` up front, the explicit pass above
    // no-ops for an already-completed workflow whose teardown is still in
    // flight — so we must await the stored promise to guarantee the Docker
    // network/container removal has actually finished before the caller (the
    // CLI) calls process.exit().
    await Promise.allSettled(ids.map((id) => this.workflows.get(id)?.teardownPromise ?? Promise.resolve()));
  }

  // -----------------------------------------------------------------------
  // Actor setup helpers
  // -----------------------------------------------------------------------

  /**
   * Injects concrete service implementations into the machine: `agentService`
   * and `deterministicService` for executable states, plus `fanOutService` —
   * the invoke body of a `workers` fan-out state, which runs
   * {@link runFanOutSegment} and is re-provided onto each child round machine
   * (the children reuse the same agent/deterministic actors, lane-scoped via
   * input).
   */
  private provideActors(
    machine: AnyStateMachine,
    workflowId: WorkflowId,
    definition: WorkflowDefinition,
    roundMachinesByState: ReadonlyMap<string, AnyStateMachine>,
  ): AnyStateMachine {
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
            return await this.executeDeterministicState(workflowId, input);
          } catch (err) {
            writeStderr(
              `[workflow] deterministicService invoke rejected for "${input.stateId}": ${toErrorMessage(err)}`,
            );
            throw err;
          }
        }),
        fanOutService: fromPromise<FanOutInvokeResult, FanOutInvokeInput>(async ({ input }) => {
          try {
            return await this.runFanOutSegment(workflowId, input, definition, roundMachinesByState);
          } catch (err) {
            writeStderr(`[workflow] fanOutService invoke rejected for "${input.stateId}": ${toErrorMessage(err)}`);
            throw err;
          }
        }),
      },
    }) as AnyStateMachine;
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

        // Skip checkpointing transitions into terminal states. On successful
        // completion `handleWorkflowComplete` removes the checkpoint anyway;
        // on abort we want the surviving checkpoint to point at the last
        // non-terminal state so `resume()` can restart the run meaningfully.
        if (!this.isTerminalStateValue(definition, stateValue)) {
          this.saveCheckpoint(instance, snapshot);
        }

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
        this.handleWorkflowComplete(workflowId, snapshot.context).catch((err: unknown) => {
          writeStderr(`[workflow] terminal handling failed for ${workflowId}: ${toErrorMessage(err)}`);
        });
      }
    });
  }

  // -----------------------------------------------------------------------
  // Checkpointing
  // -----------------------------------------------------------------------

  /**
   * Returns true if `stateValue` names a terminal state in the workflow
   * definition. Used to skip checkpointing on the final transition so the
   * last on-disk checkpoint points at the last non-terminal state (important
   * for resume-after-abort, which would otherwise reload an `aborted`
   * snapshot and immediately re-terminate).
   */
  private isTerminalStateValue(definition: WorkflowDefinition, stateValue: string): boolean {
    return definition.states[stateValue].type === 'terminal';
  }

  // `waiting_human` would smuggle a ReadonlyMap (gate.presentedArtifacts) into
  // JSON.stringify, which silently emits `{}`. handleWorkflowComplete only
  // assigns `completed` or `aborted`, so the cycle is safe today.
  private buildCheckpoint(
    instance: WorkflowInstance,
    snapshot: { value: unknown; context: unknown },
    finalStatus?: WorkflowStatus,
    containerSnapshots?: Readonly<Record<string, ContainerSnapshotRef>>,
  ): WorkflowCheckpoint {
    return {
      machineState: snapshot.value,
      context: snapshot.context as WorkflowContext,
      timestamp: new Date().toISOString(),
      transitionHistory: [...instance.transitionHistory],
      definitionPath: instance.definitionPath,
      workspacePath: instance.workspacePath,
      // Persisted so resume can read the run-dir staged copy directly
      // instead of recomputing from the (possibly moved/deleted)
      // package path. Skipped when the workflow shipped no skills, to
      // keep the checkpoint shape tight for the common case.
      ...(instance.workflowSkillsDir !== undefined ? { workflowSkillsDir: instance.workflowSkillsDir } : {}),
      ...(instance.workflowScriptsDir !== undefined ? { workflowScriptsDir: instance.workflowScriptsDir } : {}),
      ...(containerSnapshots !== undefined && Object.keys(containerSnapshots).length > 0 ? { containerSnapshots } : {}),
      ...(finalStatus !== undefined ? { finalStatus } : {}),
    };
  }

  private saveCheckpoint(instance: WorkflowInstance, snapshot: { value: unknown; context: unknown }): void {
    const checkpoint = this.buildCheckpoint(instance, snapshot);
    try {
      this.deps.checkpointStore.save(instance.id, checkpoint);
    } catch (err) {
      writeStderr(`[workflow] Failed to save checkpoint for ${instance.id}: ${toErrorMessage(err)}`);
    }
  }

  // -----------------------------------------------------------------------
  // Agent state execution
  // -----------------------------------------------------------------------

  // TODO(refactor): this method is ~230 lines and carries three
  // invocation-scoped closures (`logReceived`, `logAgentRetry`,
  // `sendAgentTurn`) that all capture the same bundle of state —
  // `session`, `instance`, `stateConfig`, `stateId`, `messageLog`, and
  // `this`. The closure pattern is idiomatic here only because every
  // alternative (methods, helpers) would propagate that bundle through
  // 5–6 parameters per site.
  //
  // The right fix is to extract the whole turn-handling pipeline
  // (send/parse/retry/reprompt + the three log helpers) into a
  // dedicated class — e.g. `AgentTurnRunner` — constructed once per
  // invocation with the shared state injected. That shrinks this
  // method from ~230 lines to ~80, and makes turn handling
  // unit-testable in isolation (today it is reachable only through
  // end-to-end workflow tests). Pair the extraction with a review of
  // `AgentInvocationError` wrapping so the conversation-id recovery
  // semantics survive the move. Worth doing as its own PR; do NOT
  // fold it into a feature change.
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
    //   4. borrow bundle via SessionOptions.workflow.infrastructure
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
    // Mutable tracker updated by the hard-failure retry loop when the
    // session rotates its conversation id. The final value is what lands
    // in the invocation result / error and hence in the checkpoint's
    // `agentConversationsByState`, so a later `freshSession: false` visit
    // resumes the id whose transcript actually exists on disk.
    let currentConversationId: AgentConversationId = agentConversationId;

    // In borrow mode, route this invocation's per-state artifacts
    // (session.log, session-metadata.json) under a slug-keyed directory
    // inside the workflow run. The slug is the next available `.N` in
    // the bundle's states dir, so true logical re-visits AND resume legs
    // both get their own dir — never appending into a prior leg's logs.
    let stateSlug: string | undefined;
    let workflowStateDir: string | undefined;
    if (bundle) {
      // Thread lane.id into the slug so N same-state fan-out lanes each get a
      // distinct `{stateId}_lane_{id}.{N}` diagnostics dir. nextStateSlug is
      // check-then-act, so N concurrent lanes sharing one `stateId` would
      // otherwise compute the same slug and clobber each other's session.log /
      // session-metadata.json (§5.4 — the one diagnostics-dir collision).
      stateSlug = nextStateSlug(getBundleStatesDir(instance.id, bundle.bundleId), stateId, context.lane?.id);
      workflowStateDir = getInvocationDir(instance.id, bundle.bundleId, stateSlug);
      mkdirSync(workflowStateDir, { recursive: true });
    }

    // Read the cached per-run staged path; never recompute from
    // `instance.definitionPath` here. Computing it per-state would
    // re-introduce the resume-fragility bug fixed by staging at start.
    const workflowSkillsDir = instance.workflowSkillsDir;

    // Workflow context for the session. Always emitted for workflow
    // runs (so the orchestrator's identity isn't ambiguous), even when
    // there's no bundle to borrow — `infrastructure` / `stateDir` /
    // `stateSlug` opt in only when shared-container mode applies.
    const workflowOptions = {
      ...(bundle ? { infrastructure: bundle } : {}),
      ...(workflowStateDir ? { stateDir: workflowStateDir, stateSlug } : {}),
      ...resolveWorkflowSkillsOptions(stateConfig.skills, workflowSkillsDir),
    };

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
        // The nested record colocates the borrowed bundle, per-state
        // artifact dir, and workflow-bundled skills. `buildSessionConfig`
        // enforces the borrow-mode invariant (stateDir requires
        // infrastructure) at runtime.
        ...(Object.keys(workflowOptions).length > 0 ? { workflow: workflowOptions } : {}),
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
      throw new AgentInvocationError({ stateId, agentConversationId: currentConversationId, cause: err });
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
        });
      };

      const logAgentRetry = (reason: AgentRetryReason, details: string, retryMessage: string) => {
        messageLog.append({
          ...this.logBase(instance),
          type: 'agent_retry',
          role: stateConfig.persona,
          reason,
          details,
          retryMessage,
        });
      };

      // Uniform agent-turn entrypoint: every prompt and reprompt must flow
      // through here so the quota-exhaustion / transient-failure
      // short-circuits apply to ALL of them. Retrying or reprompting a turn
      // whose adapter reported either signal would only burn more of the
      // already-exhausted budget (quota) or hammer a stalled upstream
      // (transient) — instead we log the structured event once and throw
      // a dedicated error so higher layers can distinguish "paused by
      // provider" / "stalled upstream" from "aborted by bug" (today all
      // three abort; M4 turns these into a `paused` terminal phase without
      // touching here).
      //
      // Sessions without `sendMessageDetailed` (e.g., built-in in-process
      // sessions) degrade cleanly to `sendMessage`, which cannot produce
      // either signal — the short-circuits simply never fire for them.
      const sendAgentTurn = async (msg: string): Promise<AgentTurnResult> => {
        const result = session.sendMessageDetailed
          ? await session.sendMessageDetailed(msg)
          : { text: await session.sendMessage(msg), hardFailure: false };
        if (result.quotaExhausted) {
          const { resetAt, rawMessage } = result.quotaExhausted;
          logReceived(result.text, undefined);
          messageLog.append({
            ...this.logBase(instance),
            type: 'quota_exhausted',
            role: stateConfig.persona,
            resetAt: resetAt?.toISOString(),
            rawMessage,
          });
          // Stamp the instance before throwing so `handleWorkflowComplete`
          // can force an abort-preserving terminal regardless of which
          // state the onError target resolves to — protects checkpoint
          // retention for workflow definitions whose error target happens
          // to be a normal terminal (e.g. `done`).
          instance.quotaExhausted = { resetAt, rawMessage };
          throw new WorkflowQuotaExhaustedError({ stateId, resetAt, rawMessage });
        }
        if (result.transientFailure) {
          const { kind, rawMessage } = result.transientFailure;
          // Same shape as the quota branch — append a structured log
          // entry, stamp the instance, throw a dedicated error — but
          // deliberately skip `logReceived`. Quota envelopes carry the
          // provider's actual rate-limit message in `result.text`, which
          // is worth recording as the agent's turn. Transient envelopes
          // carry only the agent's preamble with no real assistant
          // content, so logging it as `agent_received` would falsely
          // imply the agent produced a turn.
          messageLog.append({
            ...this.logBase(instance),
            type: 'transient_failure',
            role: stateConfig.persona,
            kind,
            rawMessage,
          });
          instance.transientFailure = { kind, rawMessage };
          throw new WorkflowTransientFailureError({ stateId, kind, rawMessage });
        }
        return result;
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
      // builtin/per-state-container workflows have no shared `infra`.
      const agentSessionId = session.getInfo().id;
      // Per-lane token ATTRIBUTION is best-effort under fan-out: N lanes share one
      // long-lived MITM, so setTokenSessionId is racy across concurrent lanes and a
      // given event may be attributed to whichever lane's session id is currently
      // flipped. The AGGREGATE — instance.tokens.outputTokens, summed over every
      // registered sessionId below — is authoritative for budget and the
      // fan-out merge (mergeRecordedFanOutContext); the per-lane split is not.
      bundle?.setTokenSessionId(agentSessionId);
      // Trajectory-capture lifecycle: brackets the agent's run with a
      // begin/end pair on the bundle. The matching `endCaptureSession`
      // is in the finally block, awaited BEFORE session.close() per §11
      // so the manifest entry is durable even if close() throws.
      // `bundle` is genuinely optional (builtin / per-state-container
      // workflows have no shared bundle); the method is always present.
      if (bundle) {
        bundle.beginCaptureSession({
          sessionId: agentSessionId,
          persona: stateConfig.persona,
          fsmState: stateId,
        });
      }
      instance.tokens.sessionIds.add(agentSessionId);

      this.emitLifecycleEvent({
        kind: 'agent_started',
        workflowId,
        state: stateId,
        persona: stateConfig.persona,
        sessionId: agentSessionId,
      });

      // Two-phase retry: (1) hard-failure retries re-send the ORIGINAL
      // command with a rotated conversation id, (2) soft-failure reprompt
      // asks the agent to fix a missing/malformed agent_status block.
      //
      // Hard failures (exitCode != 0 with empty output, e.g., upstream
      // provider stall that kills the CLI mid-stream) leave the agent's
      // session id consumed but no resumable transcript on disk — a retry
      // with the same id is rejected by the CLI. Rotating and resending the
      // original prompt is the correct recovery path; a missing-status-block
      // reprompt into a dead session cannot possibly succeed.
      const MAX_HARD_RETRIES = 2;
      let responseText = '';
      for (let attempt = 0; attempt <= MAX_HARD_RETRIES; attempt++) {
        const result = await sendAgentTurn(command);
        responseText = result.text;
        if (!result.hardFailure) break;

        logReceived(responseText, undefined);
        logAgentRetry(
          'upstream_stall',
          `Agent exited without producing output (attempt ${attempt + 1}/${MAX_HARD_RETRIES + 1})`,
          command,
        );

        if (attempt === MAX_HARD_RETRIES) {
          throw new Error(`Agent failed to produce output after ${MAX_HARD_RETRIES + 1} attempts (upstream stall)`);
        }
        const rotated = session.rotateAgentConversationId?.();
        if (rotated) currentConversationId = rotated;
      }

      let parseResult = tryParseAgentStatus(responseText);
      logReceived(responseText, parseResult.kind === 'ok' ? parseResult.output : undefined);

      let agentOutput: AgentOutput;
      if (parseResult.kind === 'ok') {
        agentOutput = parseResult.output;
      } else {
        const malformed = parseResult.kind === 'malformed' ? parseResult.error : undefined;
        const retryMsg = buildStatusBlockReprompt(statusInstructions, malformed);
        logAgentRetry(
          malformed ? 'malformed_status_block' : 'missing_status_block',
          malformed
            ? `Malformed agent_status block: ${malformed.message}`
            : 'Response did not contain an agent_status block',
          retryMsg,
        );

        responseText = (await sendAgentTurn(retryMsg)).text;
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
        logAgentRetry(
          'invalid_verdict',
          `Verdict "${agentOutput.verdict}" not in valid set: ${[...validVerdicts].join(', ')}`,
          retryMsg,
        );

        responseText = (await sendAgentTurn(retryMsg)).text;
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
        logAgentRetry('missing_artifacts', `Missing: ${missingArtifacts.join(', ')}`, artifactRetryMsg);

        const retryResponse = (await sendAgentTurn(artifactRetryMsg)).text;
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
      });

      return {
        output: agentOutput,
        agentConversationId: currentConversationId,
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
      // Quota exhaustion / transient upstream failure already produced
      // their own structured log entries inside `sendAgentTurn`;
      // appending a generic `error` entry here would double-log the same
      // event and make `workflow inspect` surface a duplicate red error
      // line alongside the structured signal. Suppress the generic entry
      // when the cause is a `WorkflowQuotaExhaustedError` or
      // `WorkflowTransientFailureError`.
      if (!isWorkflowQuotaExhaustedError(err) && !isWorkflowTransientFailureError(err)) {
        instance.messageLog.append({
          ...this.logBase(instance),
          type: 'error',
          error: toErrorMessage(err),
          context: `agent "${stateId}" (persona: ${stateConfig.persona})`,
        });
      }
      throw new AgentInvocationError({ stateId, agentConversationId: currentConversationId, cause: err });
    } finally {
      instance.activeSessions.delete(session);
      const endedSessionId = session.getInfo().id;
      // Trajectory-capture lifecycle: end the capture session FIRST so
      // the `session-end` manifest entry is durable even if
      // session.close() throws. The two-phase drain inside
      // endCaptureSession waits for in-flight reassembly to settle
      // before enqueuing the manifest end-marker (§9 / §11).
      // `bundle` is genuinely optional (builtin / per-state-container
      // workflows); the method is always present when the bundle is.
      if (bundle) {
        await bundle.endCaptureSession(endedSessionId).catch((err: unknown) => {
          writeStderr(`[workflow] endCaptureSession failed for "${stateId}": ${toErrorMessage(err)}`);
        });
      }
      await session.close().catch((closeErr: unknown) => {
        writeStderr(`[workflow] session.close() failed for "${stateId}": ${toErrorMessage(closeErr)}`);
      });
      // session.close() drains in-flight streams that captured the
      // agent's session id at attach time; they keep posting under it
      // until they finish, regardless of setTokenSessionId(undefined).
      // The clear here only governs future attachments.
      bundle?.setTokenSessionId(undefined);
      instance.tokens.sessionIds.delete(endedSessionId);
      // Pairs 1:1 with agent_started; emitted unconditionally in finally
      // so success, failure, and abort paths all clean up the bridge.
      this.emitLifecycleEvent({
        kind: 'agent_session_ended',
        workflowId,
        state: stateId,
        sessionId: endedSessionId,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Fan-out state execution
  // -----------------------------------------------------------------------

  /**
   * Runs one fan-out batch: the invoke body of the real `workers` state,
   * registered as the `fanOutService` actor (see {@link provideActors}). For
   * each worker it creates a free-standing child round actor, starts it, and
   * barrier-joins on every child reaching a `final` state, then folds the lane
   * verdicts into a single parent-edge result (§6.2).
   *
   * WHY free-standing `createActor` + `.start()` and NOT in-context `spawn`:
   * this is a `fromPromise` invoke body (plain async TS), not an XState entry
   * action — `spawn` is only callable from inside an action. A free-standing
   * actor is its OWN root, so the parent's `snapshot.value` stays the string
   * `"workers"` (single-active-state spine preserved, §6.4); the children's
   * snapshots are their own, read here via {@link waitForRoundChild}. A
   * `type:'parallel'` region would instead fold into the parent's `value` and
   * make it an object — fatal to checkpoint/terminal/gate serialization (§6.4).
   *
   * WHY mint the scope bundle BEFORE fan-out: {@link preMintFanOutScopeBundle}
   * runs `ensureBundleForScope` serially up front so the single shared
   * container exists before any child's first `container:true` step. N children
   * racing their first container step would each see an empty `bundlesByScope`
   * and mint a SEPARATE container, defeating `sharedContainer` (§6.2 / §8.1;
   * cross-ref the `ensureBundleForScope` check-then-act race comment).
   *
   * Never throws: every failure path — workflow gone, misconfigured segment,
   * unsupported worker count, missing child machine — funnels through
   * {@link fanOutErrorResult}, which yields a `result_file_error` verdict that
   * the parent `workers` state routes to its `failed` edge. (The `fanOutService`
   * wrapper in {@link provideActors} would also catch a thrown error, but the
   * uniform result keeps the parent transition table verdict-driven.)
   */
  private async runFanOutSegment(
    workflowId: WorkflowId,
    input: FanOutInvokeInput,
    definition: WorkflowDefinition,
    roundMachinesByState: ReadonlyMap<string, AnyStateMachine>,
  ): Promise<FanOutInvokeResult> {
    const instance = this.workflows.get(workflowId);
    if (!instance) {
      return this.fanOutErrorResult(input, `workflow ${workflowId} not found`);
    }

    const fanOut = input.stateConfig.fanOut;
    const segment = input.stateConfig.segment ?? [];
    if (fanOut === undefined || segment.length === 0) {
      return this.fanOutErrorResult(input, `State "${input.stateId}" is not a configured fan-out segment.`);
    }

    const workers = resolveFanOutWorkers(fanOut, definition.settings);
    if (!Number.isInteger(workers) || workers < 1) {
      return this.fanOutErrorResult(input, `State "${input.stateId}" resolved to invalid worker count ${workers}.`);
    }

    const roundMachine = roundMachinesByState.get(input.stateId);
    if (!roundMachine) {
      return this.fanOutErrorResult(
        input,
        `No child round machine is registered for fan-out state "${input.stateId}".`,
      );
    }

    // PRECONDITION: mint the shared-container bundle once, before any child.
    await this.preMintFanOutScopeBundle(instance, input.stateId, segment);

    const reconstruction = this.reconstructFanOutBatchFromDb(instance, definition, segment, workers);
    if (reconstruction.kind === 'error') {
      return this.fanOutErrorResult(input, reconstruction.error);
    }
    const missingLanes =
      reconstruction.kind === 'ready'
        ? reconstruction.reconstruction.missingLanes
        : Array.from({ length: workers }, (_, index) => index);

    const preparedLaneResults = await this.prepareFanOutLaneResults(workflowId, input, definition, segment, workers, {
      batchIndex:
        reconstruction.kind === 'ready' && reconstruction.reconstruction.recordedByLane.size > 0
          ? reconstruction.reconstruction.batchIndex
          : undefined,
      lanes: missingLanes,
    });
    if (preparedLaneResults.error !== undefined) {
      return this.fanOutErrorResult(input, preparedLaneResults.error);
    }

    instance.tab.write(`[fanout] Starting "${input.stateId}" with ${workers} worker${workers === 1 ? '' : 's'}`);
    const providedRoundMachine = this.provideActors(roundMachine, workflowId, definition, roundMachinesByState);
    let drainTrigger: RoundChildDrainTrigger | undefined;
    const childActors: RoundChildWaiter[] = [];
    const lanePromises: Array<Promise<RoundChildOutcome>> = [];
    // Drain-on-escalation trigger. WHAT: the FIRST lane to reach `blocked`/
    // `errored` latches `drainTrigger`; the `!== undefined` guard makes this
    // fire-once, so a later co-blocker never re-triggers. Every un-settled peer
    // is then drained (stopped) on the trigger's behalf.
    //
    // WHY drain-first / discard healthy peers: a batch escalation re-decides the
    // WHOLE round (the parent routes the whole batch to one human gate), so an
    // in-flight peer's eventual `recorded` would be thrown away anyway — draining
    // stops that wasted LLM spend instead of letting peers run to completion.
    //
    // WHY stop-at-boundary, NOT AbortSignal: there is no AbortSignal threaded
    // into the executor layer (FSM-M3), so a lane can only be stopped at a state
    // boundary via `actor.stop()`; an already-dispatched external service call
    // may still finish out-of-band, which is why {@link waitForRoundChild}'s
    // drain resolves the lane's outcome the moment it stops rather than awaiting
    // the in-flight call.
    //
    // Skip edges: the trigger lane itself is skipped (it already settled with its
    // own blocked/errored outcome), and any `isSettled()` peer is skipped — a peer
    // that RECORDED before the drain reached it keeps its real outcome (it is not
    // rewritten to `drained`). The SINGLE aggregated gate over all
    // blocked/errored lanes is produced later, at {@link joinFanOutBatch}.
    const requestDrain = (trigger: RoundChildDrainTrigger): void => {
      if (drainTrigger !== undefined) return;
      drainTrigger = trigger;
      instance.tab.write(
        `[fanout] "${input.stateId}" draining peers after lane ${trigger.index} ${trigger.status}: ${trigger.reason}`,
      );
      for (const child of childActors) {
        if (child.index === trigger.index || child.isSettled()) continue;
        child.drain(trigger);
      }
    };

    // Two loops on purpose: construct ALL waiters before starting ANY actor, so
    // an early-settling child's drain reaches peers that already have waiters
    // (a child started in loop 1 could settle synchronously and call
    // `requestDrain` before loop 2's later peers existed).
    for (let index = 0; index < workers; index += 1) {
      // Synthesize-vs-respawn fork. A lane whose node already recorded before the
      // crash is DB-authoritative: synthesize its outcome from the durable node
      // (no re-run, no fresh budget). A missing lane is RE-SPAWNED — and a
      // re-spawned lane restarts with a fresh visit/token budget (its per-lane
      // `maxVisits` resets, §6.1 / FSM-M1) and may drift to a different verdict
      // than its pre-crash run would have produced (§11.2). Synthesized lanes are
      // intentionally NOT pushed to `childActors`: they have no actor to drain, so
      // the drain-on-escalation loop must never touch them.
      const recordedLane =
        reconstruction.kind === 'ready' ? reconstruction.reconstruction.recordedByLane.get(index) : undefined;
      if (recordedLane !== undefined) {
        lanePromises[index] = Promise.resolve(
          this.synthesizeRecordedFanOutOutcome(input, segment, workers, recordedLane),
        );
        continue;
      }
      const childContext = this.buildFanOutLaneContext(
        input.context,
        index,
        workers,
        preparedLaneResults.byLane[index],
      );
      const child = createActor(providedRoundMachine, { input: { context: childContext } });
      const waiter = this.waitForRoundChild(child, index, requestDrain);
      childActors.push(waiter);
      lanePromises[index] = waiter.promise;
    }

    for (const child of childActors) {
      child.actor.start();
    }

    const settled = await Promise.allSettled(lanePromises);
    let result = this.joinFanOutBatch(instance, input, settled);
    if (workers > 1 && result.verdict === 'recorded') {
      const promotion = await this.promoteBarrierCognition(workflowId, definition, segment, result.context, settled);
      if (promotion.error !== undefined) {
        return this.fanOutErrorResult(input, promotion.error);
      }
      if (promotion.result?.payload !== undefined) {
        result = {
          ...result,
          payload: {
            ...(result.payload ?? {}),
            cognition_promotion: promotion.result.payload,
          },
        };
      }
      // Barrier-owned canonical stop_signals: with N lanes, each lane wrote only
      // its lane-scoped stop_signals copy, so the single file the orchestrator
      // routes on is computed ONCE here, post-barrier, over the N-grown nodes.json
      // (SHOULD-FIX-1). At workers:1 the lone lane's attach_analysis already wrote
      // the canonical bare file inline (byte-identical backward compat), so we skip.
      const stopSignalsError = await this.computeBarrierStopSignals(workflowId, definition, segment, input.context);
      if (stopSignalsError !== undefined) {
        return this.fanOutErrorResult(input, stopSignalsError);
      }
    }
    this.logFanOutJoin(instance, input.stateId, workers, result, settled);
    instance.tab.write(`[fanout] "${input.stateId}" joined: verdict=${result.verdict ?? 'none'}`);
    return result;
  }

  /**
   * Promotes recorded lane lessons once, serially, at the fan-out barrier. This
   * is the workers>1 cognition single-writer point (§9): lane `attach_analysis`
   * calls only record durable nodes; the parent invokes `promote_cognition`
   * after every child has recorded and before re-entering `orchestrator`.
   *
   * Only `recorded` lanes are promoted — blocked/errored children are filtered
   * out because they contributed no durable node to seed a lesson from.
   *
   * Returns one of three shapes:
   * - `{ error }` — the promotion ran but did not pass (the bridge returned a
   *   non-`cognition_promoted` verdict / `needs_repair`), OR — a hard error —
   *   `lanes.length === 0` for a workers>1 recorded batch (every recorded child
   *   should carry a lane id, so an empty set means the join is inconsistent).
   * - `{ result }` — the promotion passed; the caller folds the payload into the
   *   batch result under `cognition_promotion`.
   * - `{}` — a no-op, when {@link buildEvolvePromoteCognitionInput} returns
   *   undefined (non-evolve segment, or a segment with nothing to promote).
   *
   * Mixed-verdict deferral (within §9, intended): this only runs when the batch
   * verdict is `recorded`. When a batch instead escalates/fails, recorded lanes'
   * lessons are NOT promoted that turn — on APPROVE→resume the recorded lanes
   * idempotent-skip then barrier-promote (the ledger dedups), but an
   * ABORT/FORCE_REVISION never promotes them, by design: an aborted batch must
   * not seed cognition.
   */
  private async promoteBarrierCognition(
    workflowId: WorkflowId,
    definition: WorkflowDefinition,
    segment: readonly string[],
    context: WorkflowContext,
    settled: readonly PromiseSettledResult<RoundChildOutcome>[],
  ): Promise<{ result?: DeterministicInvokeResult; error?: string }> {
    const lanes = settled
      .filter((entry): entry is PromiseFulfilledResult<RoundChildOutcome> => entry.status === 'fulfilled')
      .map((entry) => entry.value)
      .filter((child) => child.status === 'recorded')
      .map((child) => child.context.lane?.id)
      .filter((lane): lane is number => typeof lane === 'number' && Number.isInteger(lane) && lane >= 0)
      .sort((a, b) => a - b);

    if (lanes.length === 0) {
      return { error: 'fan-out cognition promotion had no recorded lanes to promote' };
    }

    const attach = this.findEvolveAttachAnalysisState(definition, segment);
    if (!attach) return {};

    const input = this.buildEvolvePromoteCognitionInput(attach.stateId, attach.state, attach.command, context, lanes);
    if (!input) return {};

    const result = await this.executeDeterministicState(workflowId, input);
    if (!result.passed || result.verdict !== 'cognition_promoted') {
      return {
        error: result.errors ?? `barrier cognition promotion failed with verdict ${result.verdict ?? 'unknown'}`,
      };
    }
    return { result };
  }

  /**
   * Locates the segment's `attach_analysis` deterministic state and its evolve
   * command (the segment member that carries the `evolve_result.py` path and
   * `--run-dir`). Returns `undefined` when the segment has no such state — a
   * non-evolve fan-out has no cognition to promote.
   */
  private findEvolveAttachAnalysisState(
    definition: WorkflowDefinition,
    segment: readonly string[],
  ): { stateId: string; state: DeterministicStateDefinition; command: readonly string[] } | undefined {
    for (const stateId of segment) {
      const state = definition.states[stateId];
      if (state.type !== 'deterministic') continue;
      const command = state.run.find((entry) => this.isEvolveAttachAnalysisCommand(entry));
      if (command) return { stateId, state, command };
    }
    return undefined;
  }

  /**
   * Derives the `promote_cognition` invoke input from the segment's already-
   * resolved `attach_analysis` command: reuses the bridge path, `--run-dir`,
   * container scope, and timeout; rewrites the subcommand; passes the recorded
   * lane ids; and writes one barrier-owned result at
   * `current/cognition_promotion.json`. Returns `undefined` when the command
   * lacks the bridge path, a `--run-dir`, or a resolvable workspace-relative
   * result path (the caller then treats promotion as a no-op).
   */
  private buildEvolvePromoteCognitionInput(
    stateId: string,
    state: DeterministicStateDefinition,
    attachCommand: readonly string[],
    context: WorkflowContext,
    lanes: readonly number[],
  ): DeterministicInvokeInput | undefined {
    return this.buildEvolveBarrierInput(stateId, state, attachCommand, context, {
      stateIdSuffix: '_promote_cognition',
      subcommand: 'promote_cognition',
      resultBasename: 'cognition_promotion.json',
      extraArgs: lanes.flatMap((lane) => ['--lane', String(lane)]),
    });
  }

  /**
   * Computes the single canonical `current/stop_signals.json` ONCE at the
   * barrier join by running the bridge's `compute_stop_signals` subcommand over
   * the batch-grown `nodes.json`. The bridge writes the bare canonical file
   * atomically (temp+rename); per-lane `attach_analysis` only ever wrote
   * lane-scoped copies, so this is the sole writer of the routing input the
   * orchestrator reads each batch (SHOULD-FIX-1).
   *
   * Derived from the segment head's declared `sample` command (the only segment
   * member guaranteed to carry the `evolve_result.py` path and `--run-dir`), so
   * it inherits the same container scope / timeout. Returns an error string on
   * failure (the caller folds it into a `result_file_error`), or `undefined` on
   * success — including the benign case where the segment has no recognizable
   * evolve sample command (a non-evolve fan-out has no stop signals to compute).
   */
  private async computeBarrierStopSignals(
    workflowId: WorkflowId,
    definition: WorkflowDefinition,
    segment: readonly string[],
    context: WorkflowContext,
  ): Promise<string | undefined> {
    const sampleStateId = segment[0];
    const sampleState = definition.states[sampleStateId];
    if (sampleState.type !== 'deterministic') return undefined;

    const input = this.buildEvolveStopSignalsInput(sampleStateId, sampleState, context);
    if (!input) return undefined;

    const result = await this.executeDeterministicState(workflowId, input);
    if (!result.passed || result.verdict !== 'stop_signals_computed') {
      return result.errors ?? `barrier stop_signals computation failed with verdict ${result.verdict ?? 'unknown'}`;
    }
    return undefined;
  }

  /**
   * Derives the `compute_stop_signals` invoke input from the segment head's
   * `sample` command: reuses its `evolve_result.py` path and `--run-dir`,
   * rewrites the subcommand to `compute_stop_signals`, and points
   * `--result-file` at the shared `current/stop_signals_compute.json` barrier
   * artifact. Returns `undefined` when the command lacks the bridge path, a
   * `--run-dir`, or a resolvable workspace-relative result path.
   */
  private buildEvolveStopSignalsInput(
    stateId: string,
    state: DeterministicStateDefinition,
    context: WorkflowContext,
  ): DeterministicInvokeInput | undefined {
    const sampleCommand = state.run.find((command) => this.isEvolveSampleCommand(command));
    if (!sampleCommand) return undefined;
    return this.buildEvolveBarrierInput(stateId, state, sampleCommand, context, {
      stateIdSuffix: '_stop_signals',
      subcommand: 'compute_stop_signals',
      resultBasename: 'stop_signals_compute.json',
    });
  }

  /**
   * Mints the fan-out segment's shared-container bundle ONCE, before any child
   * actor starts (the load-bearing precondition of {@link runFanOutSegment}).
   *
   * The mint precondition: only when the workflow actually uses a shared
   * container (`shouldUseSharedContainer`) AND at least one segment member runs
   * in-container. A segment with no container members needs no bundle and
   * returns early.
   *
   * `ensureBundleForScope` is an unguarded check-then-act across awaits (its own
   * doc flags the lazy-mint race): N children each hitting their first
   * `container:true` step would each see `bundlesByScope.get(scope)` undefined
   * and mint a SEPARATE container. Calling it once here, serially, closes that
   * window — every child then borrows the already-minted bundle. Cross-ref the
   * race comment on `ensureBundleForScope`.
   *
   * The multi-scope throw is a guardrail, not a supported path: this slice
   * keeps the whole segment under one `containerScope` (single-policy
   * homogeneity, §8.2). A segment spanning >1 scope is out of slice scope and
   * fails fast rather than minting the wrong bundle.
   */
  private async preMintFanOutScopeBundle(
    instance: WorkflowInstance,
    fanOutStateId: string,
    segment: readonly string[],
  ): Promise<void> {
    if (!this.shouldUseSharedContainer(instance.definition)) return;

    const scopes = new Set<string>();
    for (const memberId of segment) {
      const member = instance.definition.states[memberId];
      if (member.type === 'agent') {
        scopes.add(member.containerScope ?? DEFAULT_CONTAINER_SCOPE);
      } else if (member.type === 'deterministic' && member.container === true) {
        scopes.add(member.containerScope ?? DEFAULT_CONTAINER_SCOPE);
      }
    }

    if (scopes.size === 0) return;
    if (scopes.size > 1) {
      throw new Error(
        `fan-out state "${fanOutStateId}" spans multiple container scopes (${[...scopes].join(', ')}); ` +
          'multi-scope fan-out is out of scope for this implementation slice.',
      );
    }

    // size is exactly 1 here (the 0 and >1 cases returned/threw above), so the
    // single-element destructure yields the one scope.
    const [scope] = [...scopes];
    await this.ensureBundleForScope(instance, scope);
  }

  private buildFanOutLaneContext(
    context: WorkflowContext,
    index: number,
    workers: number,
    preparedResults: Readonly<Record<string, DeterministicInvokeResult>> | undefined,
  ): WorkflowContext {
    if (workers === 1) return context;
    return {
      ...context,
      lane: {
        id: index,
        dir: `${DEFAULT_EVOLVE_LANE_DIR}/lane_${index}`,
        relativeDir: `${DEFAULT_EVOLVE_LANE_RELATIVE_DIR}/lane_${index}`,
        ...(preparedResults !== undefined ? { preparedResults } : {}),
      },
    };
  }

  /**
   * Reconstructs an in-flight evolve fan-out batch from the durable engine DB.
   *
   * This intentionally does NOT use XState child persistence. The checkpoint
   * stores `{ machineState, context }` and `resolveState()` re-enters `workers`
   * without live child ActorRefs; free-standing child actors created in the old
   * process are gone. First-cut crash-resume therefore treats `nodes.json` as the
   * source of truth: a recorded `step_<batch>_lane_<k>` means lane k is already
   * done and must be synthesized, while every missing lane is re-spawned fresh
   * from `sample`. That fresh re-run can produce a different verdict (§11.2
   * verdict drift), which is acceptable for node-integrity but not a promise of
   * batch-outcome reproducibility.
   *
   * Cross-language seam (deliberate, NOT accidental duplication). The batch-index
   * reuse rule below re-implements Python `_next_batch_index(run_dir, workers)`.
   * We re-derive it here rather than consume the bridge's `sample_batch_prepared`
   * echo because the index is needed BEFORE `sample_batch` runs: TS must know it
   * to decide synthesize-vs-respawn per lane AND to pin `--batch-index` into the
   * very `sample_batch` call whose output would otherwise echo it. Having the
   * bridge be authoritative would invert that ordering. So the two derivations
   * MUST move together — TS pins `--batch-index` whenever any lane is recorded (so
   * the bridge cannot diverge), and recomputes the identical number when none is.
   * Both sides cite the shared `step_<batch>_lane_<k>` format (`evolveStepName` /
   * the Python f-string) as the contract.
   */
  private reconstructFanOutBatchFromDb(
    instance: WorkflowInstance,
    definition: WorkflowDefinition,
    segment: readonly string[],
    workers: number,
  ): FanOutDbReconstructionResult {
    if (workers === 1) return { kind: 'unavailable' };

    const runDir = this.evolveRunDirForFanOutSegment(definition, segment);
    if (!runDir) return { kind: 'unavailable' };

    const runDirRelative = this.containerPathToWorkspaceRelative(runDir);
    if (!runDirRelative) return { kind: 'unavailable' };

    const nodesPath = resolve(instance.workspacePath, runDirRelative, 'database_data', 'nodes.json');
    const nodes = this.readEvolveNodes(nodesPath);
    if (nodes.error !== undefined) return { kind: 'error', error: nodes.error };

    const expectedLanes = Array.from({ length: workers }, (_, index) => index);
    const lanesByBatch = new Map<number, Set<number>>();
    const recordedByStep = new Map<string, EvolveRecordedLane>();
    let highestBatch = 0;

    for (const [nodeKey, rawNode] of nodes.entries) {
      const node = this.asRecord(rawNode);
      if (!node) continue;
      const meta = this.asRecord(node.meta_info);
      const stepName = typeof meta?.step_name === 'string' ? meta.step_name : undefined;
      if (!stepName) continue;
      const match = EVOLVE_LANE_STEP_RE.exec(stepName);
      if (!match) continue;

      const batchIndex = Number.parseInt(match[1], 10);
      highestBatch = Math.max(highestBatch, batchIndex);
      // Group 2 (the lane id) is undefined for a legacy non-lane `step_<batch>`
      // node; only lane-tagged nodes participate in fan-out reconstruction.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- an unmatched optional regex group is `undefined` at runtime, but the type is `string`
      if (match[2] === undefined) continue;

      const lane = Number.parseInt(match[2], 10);
      lanesByBatch.set(batchIndex, (lanesByBatch.get(batchIndex) ?? new Set<number>()).add(lane));
      recordedByStep.set(stepName, {
        index: lane,
        batchIndex,
        stepName,
        nodeId: this.nodeIdFromRecord(node, nodeKey),
        parent: this.nodeParentFromRecord(node),
        stepDir: `${runDir}/steps/${stepName}`,
      });
    }

    // Reuse-vs-advance heuristic — the crux of crash-resume, and the TS twin of
    // Python `_next_batch_index(run_dir, workers)` (scripts/evolve_result.py).
    // The highest lane-tagged batch whose CURRENT-worker lanes are only
    // PARTIALLY present (some expected lane is missing) is the batch that was
    // in flight when we crashed → REUSE its index, so the re-run lanes write the
    // SAME `step_<batch>_lane_<k>` names and stay idempotent against the records
    // that already landed. A fully-recorded highest batch (every expected lane
    // present) or a fully-drained one (no lane-tagged nodes, so highestLanes is
    // empty) is finished → advance to `highestBatch + 1`. This must match the
    // Python reuse rule exactly: when recordedByLane is non-empty we PIN
    // `--batch-index` to this value (so the bridge cannot diverge); when it is
    // empty we pass no `--batch-index` and the bridge recomputes the same number.
    // The shared `step_<batch>_lane_<k>` format (evolveStepName / the Python
    // f-string) is the contract both sides cite; keep this block and
    // `_next_batch_index` in lockstep — same seam as STEP_NAME_RE ↔ EVOLVE_LANE_STEP_RE.
    const highestLanes = lanesByBatch.get(highestBatch) ?? new Set<number>();
    const batchIndex =
      highestBatch > 0 && highestLanes.size > 0 && expectedLanes.some((lane) => !highestLanes.has(lane))
        ? highestBatch
        : highestBatch + 1;
    const recordedByLane = new Map<number, EvolveRecordedLane>();
    for (const lane of expectedLanes) {
      const recorded = recordedByStep.get(evolveStepName(batchIndex, lane));
      if (recorded !== undefined) recordedByLane.set(lane, recorded);
    }
    const missingLanes = expectedLanes.filter((lane) => !recordedByLane.has(lane));

    if (recordedByLane.size > 0) {
      instance.tab.write(
        `[fanout] Reconstructed "${segment[0]}" batch ${batchIndex}: ` +
          `${recordedByLane.size} recorded, ${missingLanes.length} to re-run`,
      );
    }

    return {
      kind: 'ready',
      reconstruction: {
        batchIndex,
        recordedByLane,
        missingLanes,
        runDir,
      },
    };
  }

  /**
   * The evolve `--run-dir` for this fan-out segment's `sample` head, or
   * `undefined` when the segment head is not a deterministic evolve sample
   * command. `undefined` makes {@link reconstructFanOutBatchFromDb} return
   * `unavailable`, so resume falls back to re-spawning all lanes fresh.
   */
  private evolveRunDirForFanOutSegment(definition: WorkflowDefinition, segment: readonly string[]): string | undefined {
    const sampleStateId = segment[0];
    const sampleState = definition.states[sampleStateId];
    if (sampleState.type !== 'deterministic') return undefined;
    const sampleCommand = sampleState.run.find((command) => this.isEvolveSampleCommand(command));
    return sampleCommand ? this.commandFlagValue(sampleCommand, '--run-dir') : undefined;
  }

  /**
   * Reads the engine `nodes.json` node map. Missing file ⇒ `{ entries: [] }`
   * with NO error — a fresh batch (or a run that has not recorded any node yet)
   * is a normal pre-crash state and must reconstruct as "nothing recorded". A
   * read or JSON-parse failure ⇒ an `error`, which aborts the fan-out: a corrupt
   * DB is NOT safe to treat as empty (we would re-run lanes that may already be
   * recorded), so the missing-vs-corrupt distinction is load-bearing.
   */
  private readEvolveNodes(nodesPath: string): { entries: ReadonlyArray<readonly [string, unknown]>; error?: string } {
    if (!existsSync(nodesPath)) return { entries: [] };
    let raw: string;
    try {
      raw = readFileSync(nodesPath, 'utf-8');
    } catch (err) {
      return { entries: [], error: `could not read evolve nodes DB ${nodesPath}: ${errorMessage(err)}` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { entries: [], error: `could not parse evolve nodes DB ${nodesPath}: ${errorMessage(err)}` };
    }

    const root = this.asRecord(parsed);
    const nodes = this.asRecord(root?.nodes);
    return { entries: nodes ? Object.entries(nodes) : [] };
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private nodeIdFromRecord(node: Record<string, unknown>, fallback: string): number | undefined {
    const raw = node.id;
    if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
    const parsed = Number.parseInt(fallback, 10);
    return Number.isInteger(parsed) ? parsed : undefined;
  }

  /**
   * The node's parent lineage as a tri-state: `undefined` when the record has no
   * `parent` array at all (omit the field from the synthesized payload — lineage
   * unknown), `[]` for a root node (an explicit empty array — root, not omitted),
   * and `[...ids]` for a child's parent ids. The empty-vs-undefined distinction
   * is preserved deliberately so {@link synthesizeRecordedFanOutOutcome} can omit
   * an unknown parent while still echoing an explicit root.
   */
  private nodeParentFromRecord(node: Record<string, unknown>): readonly number[] | undefined {
    if (!Array.isArray(node.parent)) return undefined;
    const parent = node.parent.filter((item): item is number => typeof item === 'number' && Number.isInteger(item));
    return parent.length > 0 ? parent : [];
  }

  /**
   * Builds the barrier outcome for a lane that already recorded before a crash.
   * The durable node proves the lane advanced; the volatile child actor context
   * (visit counts, token spend, in-flight state) is not recoverable without the
   * deferred `getPersistedSnapshot()` + in-context spawn migration, so this is a
   * minimal recorded context sufficient for join, promotion, and duplicate stats.
   *
   * Edge cases (the contract callers rely on):
   * - Called ONLY for a lane the engine DB already recorded — i.e. the
   *   just-before-crash case where the node landed but the process died before
   *   the join. Every NOT-recorded lane is re-spawned instead (see the fork in
   *   {@link runFanOutSegment}).
   * - Does NOT rebuild on-disk artifacts. The lane's `analysis.md` /
   *   `analysis_record.json` may be absent post-crash, but the durable node is
   *   authoritative, so a fabricated `lastDeterministicResult` with
   *   `{ verdict: 'recorded', idempotent_skip: true }` is sufficient — nothing
   *   downstream re-reads those files for a recorded lane.
   * - `idempotent_skip: true` is the marker that this outcome was synthesized
   *   (vs produced by a live re-run); the returned `recorded` outcome is
   *   otherwise indistinguishable to {@link joinFanOutBatch} from a live-recorded
   *   lane, so the join, promotion, and duplicate-rate paths need no special case.
   */
  private synthesizeRecordedFanOutOutcome(
    input: FanOutInvokeInput,
    segment: readonly string[],
    workers: number,
    recorded: EvolveRecordedLane,
  ): RoundChildOutcome {
    const base = this.buildFanOutLaneContext(input.context, recorded.index, workers, undefined);
    const payload: Record<string, unknown> = {
      step_name: recorded.stepName,
      idempotent_skip: true,
      ...(recorded.nodeId !== undefined ? { node_id: recorded.nodeId } : {}),
      ...(recorded.parent !== undefined ? { parent: [...recorded.parent] } : {}),
      ...(recorded.stepDir !== undefined ? { step_dir: recorded.stepDir } : {}),
    };
    return {
      index: recorded.index,
      status: 'recorded',
      context: {
        ...base,
        round: base.round + 1,
        previousStateName: segment[segment.length - 1] ?? input.stateId,
        lastDeterministicResult: {
          verdict: 'recorded',
          payload,
        },
      },
    };
  }

  /**
   * Runs the ONE barrier-side `sample_batch(n=workers)` before fan-out and
   * partitions its result into per-lane pre-computed `sample` results (keyed by
   * lane id) that {@link executeDeterministicState} replays as each child's
   * `sample` step.
   *
   * WHY one barrier-side `sample_batch(n=N)` and NOT N independent `sample()`
   * calls: the divergence between lanes is INJECTED at sampling (§7.4). N
   * independent `sample()` calls each reload the same `nodes.json` and, with a
   * diversity-maintaining sampler, could draw the SAME parent into multiple
   * lanes — collapsing the N-wide frontier into "N samples of one distribution"
   * and producing near-duplicate candidates. A single `sample_batch` over the
   * whole DB partitions N DISTINCT parents (one per lane) in one serialized,
   * read-only DB touch, guaranteeing disjoint parent sets up front. The bridge
   * uses a per-lane seed offset (`base_seed + laneId`) to decorrelate the lanes
   * while keeping the partition reproducible, with a deterministic hash tiebreak
   * so the assignment is stable across resume (§7.4).
   *
   * `workers === 1` short-circuits: the single lane uses the legacy inline
   * `sample` step (byte-identical backward compat, gate item 1), so there is no
   * batch to prepare. A non-deterministic or unrecognized sample state likewise
   * returns an empty map (the child runs its own `sample`).
   */
  private async prepareFanOutLaneResults(
    workflowId: WorkflowId,
    input: FanOutInvokeInput,
    definition: WorkflowDefinition,
    segment: readonly string[],
    workers: number,
    options: FanOutBatchOptions = {},
  ): Promise<{ byLane: Record<number, Readonly<Record<string, DeterministicInvokeResult>>>; error?: string }> {
    if (workers === 1) return { byLane: {} };
    const expectedLanes = options.lanes ?? Array.from({ length: workers }, (_, index) => index);
    if (expectedLanes.length === 0) return { byLane: {} };

    const sampleStateId = segment[0];
    const sampleState = definition.states[sampleStateId];
    if (sampleState.type !== 'deterministic') return { byLane: {} };

    const batchInput = this.buildEvolveSampleBatchInput(sampleStateId, sampleState, input.context, workers, options);
    if (!batchInput) return { byLane: {} };

    const result = await this.executeDeterministicState(workflowId, batchInput);
    if (!result.passed || result.verdict !== 'sample_batch_prepared') {
      return {
        byLane: {},
        error: result.errors ?? `fan-out sample batch failed with verdict ${result.verdict ?? 'unknown'}`,
      };
    }

    const lanes = Array.isArray(result.payload?.lanes) ? result.payload.lanes : undefined;
    if (!lanes) {
      return { byLane: {}, error: 'fan-out sample batch did not return a lanes array' };
    }

    const byLane: Record<number, Readonly<Record<string, DeterministicInvokeResult>>> = {};
    for (const lanePayload of lanes) {
      if (!lanePayload || typeof lanePayload !== 'object' || Array.isArray(lanePayload)) continue;
      const laneId = (lanePayload as { lane?: unknown }).lane;
      if (typeof laneId !== 'number' || !Number.isInteger(laneId) || laneId < 0 || laneId >= workers) continue;
      if (!expectedLanes.includes(laneId)) continue;
      byLane[laneId] = {
        [sampleStateId]: {
          passed: true,
          verdict: 'sampled',
          payload: lanePayload as Record<string, unknown>,
        },
      };
    }

    const missing = expectedLanes.filter((index) => !(index in byLane));
    if (missing.length > 0) {
      return { byLane: {}, error: `fan-out sample batch omitted lane(s): ${missing.join(', ')}` };
    }

    return { byLane };
  }

  /**
   * Derives the deterministic invoke input for the barrier-side `sample_batch`
   * from the segment head's declared `sample` command: rewrites the `sample`
   * subcommand to `sample_batch`, adds `--workers <N>`, carries over the
   * query/top-k flags, and points `--result-file` at the shared
   * `current/sample_batch.json` (the batch artifact is barrier-owned, not
   * lane-scoped). Returns `undefined` (the caller then lets each child sample on
   * its own) when the segment head is not a recognizable evolve `sample`
   * command, has no `evolve_result.py` entry, or lacks a `--run-dir` / resolvable
   * workspace-relative result path.
   */
  private buildEvolveSampleBatchInput(
    stateId: string,
    state: DeterministicStateDefinition,
    context: WorkflowContext,
    workers: number,
    options: FanOutBatchOptions = {},
  ): DeterministicInvokeInput | undefined {
    const sampleCommand = state.run.find((command) => this.isEvolveSampleCommand(command));
    if (!sampleCommand) return undefined;
    return this.buildEvolveBarrierInput(stateId, state, sampleCommand, context, {
      stateIdSuffix: '_batch',
      subcommand: 'sample_batch',
      resultBasename: 'sample_batch.json',
      extraArgs: [
        '--workers',
        String(workers),
        ...(options.lanes !== undefined ? options.lanes.flatMap((lane) => ['--lane', String(lane)]) : []),
        ...(options.batchIndex !== undefined ? ['--batch-index', String(options.batchIndex)] : []),
        ...this.sampleQueryArgs(sampleCommand),
        ...this.sampleTopKArgs(sampleCommand),
      ],
    });
  }

  /**
   * Shared skeleton for the three barrier-side `evolve_result.py` invocations
   * (`sample_batch`, `promote_cognition`, `compute_stop_signals`). Given an
   * already-resolved `sourceCommand` (the caller does the `state.run.find`), it
   * locates the bridge path, carries over `--run-dir`, rewrites the subcommand,
   * splices in the per-caller `extraArgs`, and points `--result-file` at the
   * shared barrier artifact `current/<resultBasename>`. Returns `undefined` when
   * the source command lacks the bridge path, a `--run-dir`, or a resolvable
   * workspace-relative result path — the caller's documented no-op signal.
   */
  private buildEvolveBarrierInput(
    stateId: string,
    state: DeterministicStateDefinition,
    sourceCommand: readonly string[],
    context: WorkflowContext,
    options: { stateIdSuffix: string; subcommand: string; resultBasename: string; extraArgs?: readonly string[] },
  ): DeterministicInvokeInput | undefined {
    const scriptIndex = evolveResultScriptIndex(sourceCommand);
    if (scriptIndex < 0) return undefined;
    const runDir = this.commandFlagValue(sourceCommand, '--run-dir');
    if (!runDir) return undefined;

    const resultFile = `${runDir}/current/${options.resultBasename}`;
    const workspaceRelativeResultFile = this.containerPathToWorkspaceRelative(resultFile);
    if (!workspaceRelativeResultFile) return undefined;

    const command = [
      ...sourceCommand.slice(0, scriptIndex + 1),
      options.subcommand,
      '--run-dir',
      runDir,
      ...(options.extraArgs ?? []),
      '--result-file',
      resultFile,
    ];

    return {
      stateId: `${stateId}${options.stateIdSuffix}`,
      commands: [command],
      context,
      container: state.container ?? false,
      containerScope: state.containerScope,
      timeoutMs: state.timeoutMs,
      resultFile: workspaceRelativeResultFile,
    };
  }

  private isEvolveSampleCommand(command: readonly string[]): boolean {
    const scriptIndex = evolveResultScriptIndex(command);
    return scriptIndex >= 0 && command[scriptIndex + 1] === 'sample';
  }

  private isEvolveAttachAnalysisCommand(command: readonly string[]): boolean {
    const scriptIndex = evolveResultScriptIndex(command);
    return scriptIndex >= 0 && command[scriptIndex + 1] === 'attach_analysis';
  }

  private commandFlagValue(command: readonly string[], flag: string): string | undefined {
    const index = command.indexOf(flag);
    if (index < 0) return undefined;
    return command[index + 1];
  }

  private sampleQueryArgs(command: readonly string[]): string[] {
    if (command.includes('--query-from-spec')) return ['--query-from-spec'];
    const query = this.commandFlagValue(command, '--query');
    return query !== undefined ? ['--query', query] : [];
  }

  private sampleTopKArgs(command: readonly string[]): string[] {
    const topK = this.commandFlagValue(command, '--top-k');
    return topK !== undefined ? ['--top-k', topK] : [];
  }

  private containerPathToWorkspaceRelative(path: string): string | undefined {
    const prefix = `${CONTAINER_WORKSPACE_DIR}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
  }

  /**
   * Barrier primitive for one lane. Returns a {@link RoundChildWaiter} (NOT a
   * bare Promise): a two-phase handle whose `promise` resolves by EITHER of two
   * routes, and whose `drain`/`isSettled` members let the fan-out pump stop and
   * inspect the lane externally.
   *
   * The two resolution routes and the discriminator {@link joinFanOutBatch} reads:
   * - NATURAL SETTLE — the child's own snapshot reaches a `final` state
   *   (`status === 'done'`), resolving with `recorded`/`blocked`/`errored` and
   *   `drainedBy: undefined`. A free-standing child fires no parent-visible
   *   `onDone`, so the parent watches the child's OWN snapshot (§6.2) via
   *   subscribe-until-done rather than an `xstate.done.actor` event.
   * - DRAIN — an external `drain(trigger)` call (a peer blocked/errored) stops
   *   the actor and resolves with status `drained` and a populated `drainedBy`.
   *   `drainedBy` being set vs `undefined` is exactly how the join distinguishes
   *   a drained peer from a naturally-settled lane.
   *
   * `isSettled` is first-wins: whichever route fires first latches `settled`, so
   * a lane that RECORDED before the drain reached it keeps its real `recorded`
   * outcome (the drain is a no-op on an already-settled lane).
   *
   * After the child `onError` -> `errored` fix, a segment-member service
   * rejection becomes a normal `errored` TERMINAL (status `done`, value
   * `errored`) and resolves here; the `status === 'error'` branch is the
   * residual safety net for an actor-level throw the `errored` terminal did not
   * catch (e.g. an entry-action throw), which resolves as an `errored` lane so
   * drain-on-escalation can still stop peers and the join can report the full
   * batch.
   *
   * WHY a hand-rolled subscribe loop and NOT `xstate`'s `waitFor`: `waitFor`
   * resolves only when the actor's OWN snapshot stream matches a predicate. The
   * drain route resolves the SAME promise from OUTSIDE that stream (the pump
   * synthesizes a `drained` outcome the instant it stops the actor, without
   * waiting for any in-flight external service call to settle, FSM-M3). `waitFor`
   * cannot express that external resolver, so the two-phase waiter is kept.
   *
   * The trailing `observe(actor.getSnapshot())` after `subscribe` guards the
   * synchronous-settle-before-subscribe race: a child whose first state
   * settles synchronously (e.g. a sync entry-action throw) can already be
   * `done`/`error` by the time `.subscribe` returns, so the subscription would
   * never deliver that final snapshot. Observing the current snapshot once,
   * immediately, closes the lane in that case.
   */
  private waitForRoundChild(
    actor: AnyActorRef,
    index: number,
    onDrainTrigger: (trigger: RoundChildDrainTrigger) => void,
  ): RoundChildWaiter {
    let settled = false;
    let subscription: { unsubscribe: () => void } | undefined;
    let finishOutcome: (outcome: RoundChildOutcome) => void = () => {};

    const promise = new Promise<RoundChildOutcome>((resolvePromise) => {
      const finish = (outcome: RoundChildOutcome): void => {
        if (settled) return;
        settled = true;
        subscription?.unsubscribe();
        resolvePromise(outcome);
        if (outcome.status === 'blocked' || outcome.status === 'errored') {
          // Compute the surfaced reason ONCE here, at the trigger source, and
          // thread it on the trigger so the drain log and every drained peer's
          // `drainedBy` reuse it rather than re-deriving (§ dedup).
          onDrainTrigger({
            index: outcome.index,
            status: outcome.status,
            context: outcome.context,
            reason: this.roundChildReason(outcome),
          });
        }
      };
      finishOutcome = finish;

      const observe = (snapshot: unknown): void => {
        const snap = snapshot as {
          readonly status?: string;
          readonly value?: unknown;
          readonly context?: WorkflowContext;
          readonly error?: unknown;
        };
        if (snap.status === 'done') {
          finish({
            index,
            status: toRoundChildStatus(snap.value, index),
            context: snap.context as WorkflowContext,
          });
        } else if (snap.status === 'error') {
          const reason = snap.error ?? `fan-out child ${index} errored`;
          finish({
            index,
            status: 'errored',
            context: snap.context as WorkflowContext,
            drainedBy: undefined,
          });
          writeStderr(`[workflow] fan-out child ${index} actor error: ${toErrorMessage(reason)}`);
        }
      };
      subscription = actor.subscribe(observe);
      observe(actor.getSnapshot());
    });

    return {
      index,
      actor,
      promise,
      isSettled: () => settled,
      drain: (trigger) => {
        if (settled) return;
        const snapshot = actor.getSnapshot() as { context?: WorkflowContext };
        const context = snapshot.context ?? trigger.context;
        actor.stop();
        // Resolve directly after stop(): the stopped actor will not enter its
        // next state, while any already-started external promise may still finish
        // out-of-band (there is no AbortSignal in the executor layer, FSM-M3).
        finishOutcome({
          index,
          status: 'drained',
          context,
          drainedBy: { index: trigger.index, status: trigger.status, reason: trigger.reason },
        });
      },
    };
  }

  /**
   * Folds the settled lane outcomes into a single parent-edge result, applying
   * a fixed verdict precedence (worst lane wins):
   *   1. any rejected settle -> `result_file_error` (a residual actor-level
   *      throw that did not resolve as an `errored` lane);
   *   2. else any `blocked` lane -> `escalate` (route once to human review,
   *      with every blocked/errored lane reason aggregated);
   *   3. else any `errored` lane -> `result_file_error` (explicit fail mapping);
   *   4. else any `drained` lane without an issue trigger -> `result_file_error`;
   *   5. else all `recorded` -> `recorded` (the batch advanced).
   *
   * WHY `Promise.allSettled` (not `Promise.all`) upstream: one lane's rejection
   * must not abandon its N-1 in-flight peers (FSM-S5). `all` would reject on the
   * first throw and lose the other lanes' outcomes; `allSettled` lets the join
   * see the full batch, including parent-synthesized `drained` peer outcomes.
   *
   * For `workers: 1`, the recorded path still promotes the single child context
   * exactly. For N>1, the recorded path folds lane contexts into a parent batch
   * context: child artifacts/conversations merge, parent visit counts remain
   * authoritative for the single-active-state spine, and total tokens fan in
   * from the orchestrator's workflow-level token accumulator.
   */
  private joinFanOutBatch(
    instance: WorkflowInstance,
    input: FanOutInvokeInput,
    settled: readonly PromiseSettledResult<RoundChildOutcome>[],
  ): FanOutInvokeResult {
    const rejected = settled.find((result) => result.status === 'rejected');
    if (rejected?.status === 'rejected') {
      return this.fanOutErrorResult(input, toErrorMessage(rejected.reason));
    }

    const children = settled.map((result) => {
      if (result.status !== 'fulfilled') {
        throw new Error('unreachable rejected fan-out result after rejection check');
      }
      return result.value;
    });
    const first = children[0];
    const childSummaries: RoundChildSummary[] = children.map((child) => ({
      index: child.index,
      status: child.status,
      // Carry `drainedBy` through to the join log so observability records which
      // lane's escalation stopped each drained peer (the bare `drained` status
      // alone does not say). NOTE (drain-first, § consider): `issues` below is the
      // blocked/errored-AT-DRAIN set only — a peer that WOULD have blocked but was
      // drained first is reported here as `drained`, NOT as an issue in the gate.
      ...(child.drainedBy !== undefined ? { drainedBy: child.drainedBy } : {}),
    }));
    const issues = this.fanOutIssues(children);

    if (issues.some((issue) => issue.status === 'blocked')) {
      const source = children.find((child) => child.status === 'blocked') ?? first;
      const summary = this.formatFanOutIssues('Fan-out batch escalated after blocked lane(s):', issues);
      return {
        passed: false,
        verdict: 'escalate',
        errors: summary,
        payload: { issues },
        context: this.promoteFanOutIssueContext(instance, input.context, input.stateId, source, 'escalate', issues),
        children: childSummaries,
      };
    }

    if (issues.some((issue) => issue.status === 'errored')) {
      const source = children.find((child) => child.status === 'errored') ?? first;
      const summary = this.formatFanOutIssues('Fan-out batch failed after errored lane(s):', issues);
      return {
        passed: false,
        verdict: DETERMINISTIC_RESULT_ERROR_VERDICT,
        errors: summary,
        payload: { issues },
        context: this.promoteFanOutIssueContext(
          instance,
          input.context,
          input.stateId,
          source,
          DETERMINISTIC_RESULT_ERROR_VERDICT,
          issues,
        ),
        children: childSummaries,
      };
    }

    const drained = children.find((child) => child.status === 'drained');
    if (drained) {
      return {
        passed: false,
        verdict: DETERMINISTIC_RESULT_ERROR_VERDICT,
        errors: `fan-out child ${drained.index} was drained without a blocked or errored trigger`,
        context: this.promoteFanOutContext(instance, input.context, drained.context),
        children: childSummaries,
      };
    }

    return {
      passed: true,
      verdict: 'recorded',
      context:
        children.length === 1 ? first.context : this.mergeRecordedFanOutContext(instance, input.context, children),
      children: childSummaries,
    };
  }

  /**
   * Projects the blocked/errored lanes (the offenders) into the {@link FanOutIssue}
   * payload that lands in the aggregated gate. Drained peers are intentionally
   * excluded — they are the drain-first collateral, not independent issues (§ the
   * reason list is the blocked-at-drain set, not all-would-have-blocked).
   */
  private fanOutIssues(children: readonly RoundChildOutcome[]): FanOutIssue[] {
    return children
      .filter((child) => child.status === 'blocked' || child.status === 'errored')
      .map((child) => ({
        index: child.index,
        status: child.status as 'blocked' | 'errored',
        reason: this.roundChildReason(child),
      }));
  }

  /**
   * Surfaces a one-line human-readable cause for a blocked/errored lane, with an
   * ASYMMETRIC fallback order per status — THE footgun this method guards:
   *
   * - `errored` prefers `lastError` then `previousAgentOutput`: an errored lane
   *   DID trip `storeError`, so `lastError` is the populated, authoritative cause.
   * - `blocked` prefers `previousAgentOutput` then `lastError`: a blocked lane
   *   (evaluator_blocked) never trips `storeError`, so its `lastError` is null and
   *   the real reason lives on `previousAgentOutput` (the evaluator's message).
   *
   * Do NOT collapse the two branches into one fallback chain: a unified order
   * would surface a stale/null field for one of the two statuses. This rationale
   * was deleted from the old call sites and is re-homed here on purpose.
   */
  private roundChildReason(child: Pick<RoundChildOutcome, 'index' | 'status' | 'context'>): string {
    if (child.status === 'errored') {
      return (
        child.context.lastError ??
        child.context.previousAgentOutput ??
        `fan-out child ${child.index} ended in "${child.status}"`
      );
    }
    return (
      child.context.previousAgentOutput ??
      child.context.lastError ??
      `fan-out child ${child.index} ended in "${child.status}"`
    );
  }

  /** Renders an issue list as a header line plus one `- lane <i> <status>: <reason>` bullet per offending lane. */
  private formatFanOutIssues(header: string, issues: readonly FanOutIssue[]): string {
    if (issues.length === 0) return header;
    return [header, ...issues.map((issue) => `- lane ${issue.index} ${issue.status}: ${issue.reason}`)].join('\n');
  }

  /**
   * Builds the parent-spine context for a blocked/errored BATCH (the escalate and
   * errored-only join branches). WHAT it folds:
   * - the worst lane's context (`source`) promoted back onto the spine via
   *   {@link promoteFanOutContext} (lane marker stripped, parent visit counts
   *   restored, tokens from the accumulator);
   * - an AGGREGATED multi-lane summary of every blocked/errored lane written to
   *   `previousAgentOutput` (this is what the orchestrator reads on APPROVE→resume
   *   and the human reads in the gate banner);
   * - the same lanes as the structured `issues` payload on
   *   `lastDeterministicResult` for the gate.
   *
   * WHY ONE gate, not one per offending lane: all blocked/errored reasons fold
   * into a single payload so the human reviews the batch ONCE. The two verdict
   * shapes differ only in `lastError`: `escalate` leaves `lastError` null (a
   * blocked lane is recoverable, not an error), while the errored-only verdict
   * mirrors the summary into `lastError` (the batch failed).
   *
   * SCRATCH-SHAPE TAG (workers:1 vs workers>1 disambiguator): the orchestrator's
   * recovery prompt has two mutually-exclusive recoveries — legacy `evaluate`-
   * resume of the one written-but-unscored candidate (bare `current/`) vs discard
   * the lane scratch and start a fresh `design` batch (lane-scoped
   * `current/lane_<k>/`). At `workers:1` the lane carries NO `lane` marker and the
   * scratch is the BARE `current/`, so the legacy resume is the correct recovery;
   * at `workers>1` the lane scratch is under `current/lane_<k>/` and must be
   * discarded. The summary message alone ("Fan-out batch escalated…") would push
   * the LLM toward discard in BOTH cases, so we append an explicit scratch-shape
   * sentence derived from `source.context.lane` to steer the prompt's branch.
   */
  private promoteFanOutIssueContext(
    instance: WorkflowInstance,
    parentContext: WorkflowContext,
    fanOutStateId: string,
    source: RoundChildOutcome,
    verdict: string,
    issues: readonly FanOutIssue[],
  ): WorkflowContext {
    const summary = this.formatFanOutIssues(
      verdict === DETERMINISTIC_RESULT_ERROR_VERDICT
        ? 'Fan-out batch failed after errored lane(s):'
        : 'Fan-out batch escalated after blocked lane(s):',
      issues,
    );
    const scratchNote =
      source.context.lane === undefined
        ? '\nScratch is the bare current/ (a single candidate is written; result.json may be absent) — ' +
          'resume the round in place; do NOT discard and start a fresh batch.'
        : '\nScratch is lane-scoped under current/lane_<k>/ — discard the lane scratch and re-decide normally.';
    return {
      ...this.promoteFanOutContext(instance, parentContext, source.context),
      previousAgentOutput: `${summary}${scratchNote}`,
      previousAgentNotes: null,
      previousStateName: fanOutStateId,
      lastDeterministicResult: {
        verdict,
        payload: { issues: issues.map((issue) => ({ ...issue })) },
      },
      ...(verdict === DETERMINISTIC_RESULT_ERROR_VERDICT ? { lastError: summary } : { lastError: null }),
    };
  }

  /**
   * Promotes a SINGLE lane's context back onto the parent spine (the
   * blocked/errored drain paths, and the `workers: 1` recorded path where there
   * is exactly one lane). Strips the per-lane `lane` marker so the parent never
   * carries a lane identity, restores the parent's authoritative `visitCounts`
   * (the single-active-state spine owns visit accounting; a lane's own counts
   * are a within-batch detail, §7.5), and reads `totalTokens` from the
   * instance-level token accumulator (the aggregate over all lanes' registered
   * sessionIds, which is the budget-authoritative figure, NOT the lane's local
   * sum). The `lane === undefined` branch is the no-fan-out / `workers: 1` case:
   * there is no lane marker to strip, so only the token figure is refreshed.
   */
  private promoteFanOutContext(
    instance: WorkflowInstance,
    parentContext: WorkflowContext,
    laneContext: WorkflowContext,
  ): WorkflowContext {
    if (laneContext.lane === undefined) {
      return {
        ...laneContext,
        totalTokens: instance.tokens.outputTokens,
      };
    }
    const withoutLane = this.withoutLaneContext(laneContext);
    return {
      ...withoutLane,
      visitCounts: parentContext.visitCounts,
      totalTokens: instance.tokens.outputTokens,
    };
  }

  /**
   * Folds the N recorded lane contexts back into ONE parent-spine context at the
   * barrier join (the recorded happy path for `workers > 1`). This is the
   * highest-stakes merge in the fan-out: the parent FSM is single-active-state,
   * so after the batch it must hold a single coherent context even though N
   * child actors each evolved their own copy in parallel. Each field is merged
   * by a rule chosen for WHY it is correct on the spine, NOT by a uniform
   * strategy:
   *
   * - `visitCounts`: the PARENT's counts are authoritative and copied verbatim.
   *   The spine has a single active state (`workers`), entered once per batch;
   *   the children's per-lane visit counts are a within-batch bookkeeping detail
   *   (§7.5) that must not leak onto the parent, or the global round-limit
   *   backstop would see N× inflated counts.
   * - `round`: SUM of each lane's POSITIVE delta over the parent baseline
   *   (`max(0, child.round - parent.round)`). A batch advanced the search by as
   *   many rounds as lanes that progressed; summing positive deltas counts each
   *   advancing lane once and ignores any lane that did not move forward.
   * - `reviewHistory`: SUFFIX-append only — each lane's entries BEYOND the shared
   *   parent baseline are appended. Lanes start from the same parent
   *   reviewHistory, so a naive concat would replay the baseline N times; taking
   *   only the suffix past `parentContext.reviewHistory.length` avoids that N×
   *   duplication while still capturing every lane's new review notes.
   * - `humanPrompt`: NULLED. A human prompt is a single-turn directive consumed
   *   by one state entry; it has no meaning fanned across N lanes and must not
   *   survive the batch (a stale prompt would mis-route the next orchestrator
   *   turn).
   * - `totalTokens`: read from the instance-level accumulator (the aggregate over
   *   all lanes' registered MITM sessionIds), NOT summed from the children here —
   *   the accumulator is the budget-authoritative figure and already includes
   *   every lane's spend.
   * - `artifacts` / `previousOutputHashes` / `agentConversationsByState`: shallow
   *   last-writer-wins merge over the parent baseline (lanes write disjoint,
   *   lane-scoped keys, so collisions are not expected; the parent baseline is
   *   the floor). The remaining scalar fields come from `last` (the
   *   highest-index lane), an arbitrary-but-deterministic representative.
   */
  private mergeRecordedFanOutContext(
    instance: WorkflowInstance,
    parentContext: WorkflowContext,
    children: readonly RoundChildOutcome[],
  ): WorkflowContext {
    const ordered = [...children].sort((a, b) => a.index - b.index);
    const last = ordered[ordered.length - 1]?.context ?? parentContext;
    const lastWithoutLane = this.withoutLaneContext(last);

    const artifacts = ordered.reduce<Record<string, string>>((acc, child) => ({ ...acc, ...child.context.artifacts }), {
      ...parentContext.artifacts,
    });
    const previousOutputHashes = ordered.reduce<Record<string, string>>(
      (acc, child) => ({ ...acc, ...child.context.previousOutputHashes }),
      { ...parentContext.previousOutputHashes },
    );
    const agentConversationsByState = ordered.reduce<Record<string, AgentConversationId>>(
      (acc, child) => ({ ...acc, ...child.context.agentConversationsByState }),
      { ...parentContext.agentConversationsByState },
    );
    const roundDelta = ordered.reduce((sum, child) => sum + Math.max(0, child.context.round - parentContext.round), 0);

    return {
      ...lastWithoutLane,
      artifacts,
      previousOutputHashes,
      agentConversationsByState,
      visitCounts: parentContext.visitCounts,
      reviewHistory: ordered.reduce<readonly string[]>(
        (acc, child) =>
          child.context.reviewHistory.length > parentContext.reviewHistory.length
            ? [...acc, ...child.context.reviewHistory.slice(parentContext.reviewHistory.length)]
            : acc,
        parentContext.reviewHistory,
      ),
      round: parentContext.round + roundDelta,
      totalTokens: instance.tokens.outputTokens,
      humanPrompt: null,
    };
  }

  private withoutLaneContext(context: WorkflowContext): WorkflowContext {
    const copy: WorkflowContext = { ...context };
    delete (copy as { lane?: unknown }).lane;
    return copy;
  }

  private logFanOutJoin(
    instance: WorkflowInstance,
    fanOutState: string,
    workers: number,
    result: FanOutInvokeResult,
    settled: readonly PromiseSettledResult<RoundChildOutcome>[],
  ): void {
    const fulfilled = settled
      .filter((entry): entry is PromiseFulfilledResult<RoundChildOutcome> => entry.status === 'fulfilled')
      .map((entry) => entry.value);
    const duplicateStats =
      result.verdict === 'recorded' ? this.computeFanOutCandidateDuplicateStats(instance, fulfilled) : undefined;

    instance.messageLog.append({
      ...this.logBase(instance),
      type: 'fanout_join',
      fanOutState,
      workers,
      verdict: result.verdict ?? null,
      ...(duplicateStats !== undefined ? duplicateStats : {}),
      children:
        result.children ??
        fulfilled.map((child) => ({
          index: child.index,
          status: child.status,
        })),
    });

    if (duplicateStats !== undefined) {
      instance.tab.write(
        `[fanout] "${fanOutState}" duplicate_rate=${duplicateStats.duplicateRate.toFixed(3)} ` +
          `(${duplicateStats.duplicateCount}/${duplicateStats.candidateCount})`,
      );
    }
  }

  /**
   * Measures effective lane diversity for one recorded batch by content-hashing
   * each lane's candidate source and counting byte-identical collisions.
   *
   * WHY content-hash at fan-in (not assume effective-N = N): distinct sampled
   * parents do NOT guarantee distinct candidates (§7.4). Convergent lanes — the
   * researcher LLM collapsing two different parents into the same edit, or a
   * degenerate sampler handing out overlapping parents — can produce
   * byte-identical candidates, so "N lanes" can have an effective diversity
   * below N. Hashing the recorded `steps/<step>/code` files surfaces that as an
   * observable duplicate rate instead of pretending every lane added a distinct
   * candidate; the operator reads it as a signal to tune the diversity knobs.
   * It is a diagnostic, NOT a gate — duplicates are still recorded as distinct
   * nodes (the engine assigns each its own id, §7.6).
   *
   * Every skip is best-effort, NOT an error: a missing step_name, a candidate
   * file that does not exist yet, or a non-recorded lane is simply omitted from
   * the sample rather than failing the join — a diagnostic must never block a
   * batch that otherwise recorded cleanly. The `undefined` return is the
   * "nothing measurable" contract: when no lane yielded a hashable candidate
   * (every lane skipped), there is no diversity to report and the caller logs no
   * duplicate stats at all (distinct from a measured `duplicateRate: 0`).
   */
  private computeFanOutCandidateDuplicateStats(
    instance: WorkflowInstance,
    children: readonly RoundChildOutcome[],
  ):
    | {
        duplicateRate: number;
        duplicateCount: number;
        uniqueCandidates: number;
        candidateCount: number;
      }
    | undefined {
    const hashes: string[] = [];
    for (const child of children) {
      if (child.status !== 'recorded') continue;
      const stepName = child.context.lastDeterministicResult?.payload?.step_name;
      if (typeof stepName !== 'string' || stepName.length === 0) continue;
      // Path layout owned by the Python bridge — see EVOLVE_STEP_CODE_PATH_SEGMENTS.
      const candidatePath = resolve(
        instance.workspacePath,
        ...EVOLVE_STEP_CODE_PATH_SEGMENTS,
        stepName,
        EVOLVE_STEP_CODE_FILENAME,
      );
      if (!existsSync(candidatePath)) continue;
      hashes.push(createHash('sha256').update(readFileSync(candidatePath)).digest('hex'));
    }

    if (hashes.length === 0) return undefined;
    const uniqueCandidates = new Set(hashes).size;
    const duplicateCount = hashes.length - uniqueCandidates;
    return {
      duplicateRate: duplicateCount / hashes.length,
      duplicateCount,
      uniqueCandidates,
      candidateCount: hashes.length,
    };
  }

  /**
   * The single terminal error channel from {@link runFanOutSegment} to the
   * parent: a `result_file_error` verdict carrying `message`, which the parent
   * `workers` state routes to its `failed` edge.
   */
  private fanOutErrorResult(input: FanOutInvokeInput, message: string): FanOutInvokeResult {
    return {
      passed: false,
      verdict: DETERMINISTIC_RESULT_ERROR_VERDICT,
      errors: message,
      context: input.context,
    };
  }

  // -----------------------------------------------------------------------
  // Deterministic state execution
  // -----------------------------------------------------------------------

  private async executeDeterministicState(
    workflowId: WorkflowId,
    input: DeterministicInvokeInput,
  ): Promise<DeterministicInvokeResult> {
    const preparedResult = input.context.lane?.preparedResults?.[input.stateId];
    if (preparedResult !== undefined) {
      return preparedResult;
    }

    if (!input.container) {
      return this.runDeterministicHost(input.commands);
    }

    const instance = this.workflows.get(workflowId);
    if (!instance) {
      return { passed: false, errors: `workflow ${workflowId} not found` };
    }
    if (!this.shouldUseSharedContainer(instance.definition)) {
      return { passed: false, errors: `State "${input.stateId}" requires shared-container Docker execution.` };
    }

    const scope = input.containerScope ?? DEFAULT_CONTAINER_SCOPE;
    const bundleWasLive = instance.bundlesByScope.has(scope);
    const bundle = await this.ensureBundleForScope(instance, scope);
    const warning = bundleWasLive
      ? undefined
      : `container: true state "${input.stateId}": scope "${scope}" had no live container before this state. ` +
        `On a fresh run this likely means no prior state populated it; on resume this can be expected.`;
    const base = await this.runDeterministicInContainer(bundle, input, warning);
    return this.applyResultFile(instance, input, base);
  }

  private applyResultFile(
    instance: WorkflowInstance,
    input: DeterministicInvokeInput,
    base: DeterministicInvokeResult,
  ): DeterministicInvokeResult {
    if (input.resultFile === undefined) return base;
    if (!base.passed) return base;

    const appendError = (message: string): DeterministicInvokeResult => ({
      ...base,
      passed: false,
      verdict: DETERMINISTIC_RESULT_ERROR_VERDICT,
      errors: base.errors ? `${base.errors}\n${message}` : message,
    });

    if (!isSafeWorkspaceRelativePath(input.resultFile)) {
      return appendError(`result file ${input.resultFile} is not a safe workspace-relative path`);
    }

    const resultPath = resolve(instance.workspacePath, input.resultFile);
    // Symlink-safe containment: a container can plant a symlink inside the shared
    // workspace, and this read happens host-side — so resolve both sides to their
    // canonical real paths before comparing (same posture as the policy engine,
    // see resolveRealPath / CLAUDE.md). A lexical resolve()/relative() check would
    // follow such a symlink and read off-workspace on the host.
    if (!isWithinDirectory(resultPath, instance.workspacePath)) {
      return appendError(`result file ${input.resultFile} escapes the workspace`);
    }

    if (!existsSync(resultPath)) {
      return appendError(`result file ${input.resultFile} not found`);
    }

    // Split read vs parse so a read failure (EISDIR/EPERM/...) is not mislabeled
    // as a JSON syntax error.
    let raw: string;
    try {
      raw = readFileSync(resultPath, 'utf8');
    } catch (err) {
      return appendError(`result file ${input.resultFile} could not be read: ${errorMessage(err)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return appendError(`result file ${input.resultFile} is not valid JSON`);
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return appendError(`result file ${input.resultFile} is not a JSON object`);
    }

    const resultObject = parsed as Record<string, unknown>;
    if (typeof resultObject.verdict !== 'string' || resultObject.verdict.length === 0) {
      return appendError(`result file ${input.resultFile} missing verdict`);
    }

    const payload =
      typeof resultObject.payload === 'object' && resultObject.payload !== null && !Array.isArray(resultObject.payload)
        ? (resultObject.payload as Record<string, unknown>)
        : undefined;

    return {
      ...base,
      verdict: resultObject.verdict,
      passed: typeof resultObject.passed === 'boolean' ? resultObject.passed : base.passed,
      ...(payload !== undefined ? { payload } : {}),
    };
  }

  /**
   * Shared reduction for both deterministic execution paths: skip empty command
   * arrays, mine the `N tests pass` heuristic from stdout, accumulate per-command
   * failures, and shape the `{ passed, testCount, errors }` result. Host vs.
   * container execution differ only in `runCommand` — keep that the only fork so
   * the pass/fail and test-count semantics cannot drift between the two paths.
   */
  private async reduceDeterministicCommands(
    commands: readonly (readonly string[])[],
    runCommand: (cmd: readonly string[]) => Promise<{ stdout: string; error?: string }>,
  ): Promise<DeterministicInvokeResult> {
    let totalTestCount = 0;
    const allErrors: string[] = [];

    for (const cmdArray of commands) {
      if (cmdArray.length === 0) continue;
      const { stdout, error } = await runCommand(cmdArray);
      if (error !== undefined) {
        allErrors.push(error);
        continue;
      }
      // Try to extract test count from stdout (simple heuristic)
      const testMatch = /(\d+)\s+(?:tests?|specs?)\s+pass/i.exec(stdout);
      if (testMatch) {
        totalTestCount += parseInt(testMatch[1], 10);
      }
    }

    return {
      passed: allErrors.length === 0,
      testCount: totalTestCount > 0 ? totalTestCount : undefined,
      errors: allErrors.length > 0 ? allErrors.join('\n') : undefined,
    };
  }

  private async runDeterministicHost(commands: readonly (readonly string[])[]): Promise<DeterministicInvokeResult> {
    return this.reduceDeterministicCommands(commands, async (cmdArray) => {
      const [binary, ...args] = cmdArray;
      try {
        const { stdout } = await execFileAsync(binary, args);
        return { stdout };
      } catch (err) {
        const execErr = err as { code?: number; stderr?: string; stdout?: string };
        return { stdout: '', error: execErr.stderr ?? execErr.stdout ?? String(err) };
      }
    });
  }

  private async runDeterministicInContainer(
    bundle: DockerInfrastructure,
    input: DeterministicInvokeInput,
    warning?: string,
  ): Promise<DeterministicInvokeResult> {
    if (warning) writeStderr(`[workflow] ${warning}`);

    return this.reduceDeterministicCommands(input.commands, async (cmdArray) => {
      // Prepend the workflow venv / node bins to the container's live $PATH so
      // bare `node` / `python` helpers resolve regardless of base-image arch
      // (the image's own PATH is preserved — see buildWorkflowExecCommand).
      const result = await bundle.docker.exec(
        bundle.containerId,
        buildWorkflowExecCommand(bundle, cmdArray),
        input.timeoutMs,
        'codespace',
        CONTAINER_WORKSPACE_DIR,
      );
      if (result.exitCode !== 0) {
        return { stdout: '', error: result.stderr || result.stdout || `exit ${result.exitCode}` };
      }
      return { stdout: result.stdout };
    });
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
    for (const artifactRef of stateDef.present ?? []) {
      if (instance) {
        const { name } = parseArtifactRef(artifactRef);
        const dir = resolve(instance.artifactDir, name);
        if (existsSync(dir)) {
          presentedArtifacts.set(name, dir);
        }
      }
    }

    // Surface error context in the gate summary so callers know whether this
    // gate was reached normally, via an invoke error, or via a deterministic
    // verdict such as evaluator_blocked.
    const snapshot = instance?.actor.getSnapshot() as { context?: WorkflowContext } | undefined;
    const context = snapshot?.context;
    const previousState =
      context?.previousStateName && instance ? instance.definition.states[context.previousStateName] : undefined;
    const previousDeterministicVerdict =
      previousState?.type === 'deterministic' ? context?.lastDeterministicResult?.verdict : undefined;
    const previousOutputSummary =
      context?.previousAgentOutput !== undefined && context.previousAgentOutput !== null
        ? // Collapse the multi-line aggregated fan-out reason to a single line so it
          // surfaces inline in the one-line gate banner instead of wrapping mid-summary.
          (truncateForTransition(context.previousAgentOutput) ?? '').replace(/\s+/g, ' ').trim()
        : undefined;
    const errorContext = context?.lastError
      ? ` (error: ${context.lastError})`
      : previousDeterministicVerdict
        ? ` (verdict: ${previousDeterministicVerdict}${previousOutputSummary ? `; ${previousOutputSummary}` : ''})`
        : '';

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

  private async handleWorkflowComplete(workflowId: WorkflowId, context: WorkflowContext): Promise<void> {
    const instance = this.workflows.get(workflowId);
    if (!instance) return;

    // Guard against XState emitting a terminal transition multiple times.
    // `finalStatus` being set is the canonical "already completed" signal;
    // if it's set, skip re-entering terminal handling so we don't call
    // destroyWorkflowInfrastructure twice (the teardown itself is idempotent,
    // but duplicate tab.close() / checkpoint.remove() / lifecycle events
    // are noisy).
    if (instance.finalStatus) return;

    // Check if this is a normal completion or an aborted terminal.
    // Quota exhaustion takes precedence: the error target may have
    // resolved to any terminal (including `done`-like ones), but a run
    // that died on upstream quota MUST be treated as aborted so the
    // checkpoint is preserved and the user can resume once the provider
    // window reopens. (M4 will upgrade this to a dedicated `paused`
    // phase; for now `aborted` gives us the same checkpoint retention.)
    const stateValue = instance.currentState;
    if (instance.quotaExhausted) {
      const resetHint = instance.quotaExhausted.resetAt
        ? ` (resets at ${instance.quotaExhausted.resetAt.toISOString()})`
        : '';
      instance.finalStatus = {
        phase: 'aborted',
        reason: `Upstream quota exhausted${resetHint}`,
      };
    } else if (instance.transientFailure) {
      // Mirror the quota branch: a transient upstream failure must force
      // an abort-preserving terminal regardless of which state
      // `findErrorTarget` resolved to. Without this, a workflow whose
      // only terminal is `done` would land on `done` and
      // `handleWorkflowComplete` would mark the run `completed`, breaking
      // resume.
      const excerpt = instance.transientFailure.rawMessage.slice(0, 200);
      instance.finalStatus = {
        phase: 'aborted',
        reason:
          `Transient upstream failure: ${describeTransientFailureKind(instance.transientFailure.kind)} ` +
          `(resumable — run "ironcurtain workflow resume <baseDir>" once upstream is healthy)\n${excerpt}`,
      };
    } else if (stateValue === 'aborted' || stateValue.includes('abort')) {
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

    let existing: WorkflowCheckpoint | undefined;
    try {
      existing = this.deps.checkpointStore.load(workflowId);
    } catch (err) {
      writeStderr(`[workflow] Failed to load existing checkpoint for ${workflowId}: ${toErrorMessage(err)}`);
    }

    const containerSnapshots =
      instance.finalStatus.phase === 'aborted' ? await this.snapshotResumableScopes(instance) : undefined;

    // Persist finalStatus so isCheckpointResumable can later distinguish
    // completed (excluded) from aborted/failed (still resumable). Preserve
    // the existing on-disk machineState/context (which points at the last
    // non-terminal state) so resume-after-abort can re-enter that state
    // instead of immediately re-completing on a terminal snapshot. The
    // fallback path covers the unusual case where no prior checkpoint
    // exists (e.g. a workflow that transitioned straight to terminal
    // without ever passing through a non-terminal save point).
    this.saveTerminalCheckpoint(instance, instance.finalStatus, containerSnapshots, existing);

    instance.tab.write(`[done] ${instance.finalStatus.phase}`);
    instance.tab.close();

    // Release the token-stream bus subscription. Done eagerly (before the
    // async destroyWorkflowInfrastructure) because it's a synchronous
    // callback — idempotent if already cleared by abort().
    this.teardownTokenSubscription(instance);

    const snapshotsToRemove =
      instance.finalStatus.phase === 'completed'
        ? existing?.containerSnapshots
        : this.snapshotsSupersededBy(existing?.containerSnapshots, containerSnapshots);
    const cleanupDocker = snapshotsToRemove ? await this.dockerForSnapshotCleanup(instance) : undefined;

    // Tear down workflow-scoped Docker infrastructure. Runs asynchronously
    // because the actor subscription is sync; destroyWorkflowInfrastructure
    // is error-tolerant so unhandled rejections should not occur, but we
    // still catch defensively for a belt-and-suspenders guarantee. The
    // promise is retained on the instance so `shutdownAll` can await it
    // before the CLI exits (see `teardownPromise`).
    instance.teardownPromise = (async () => {
      await this.destroyWorkflowInfrastructure(instance);
      if (cleanupDocker) {
        await this.removeSnapshotImagesAfterTeardown(cleanupDocker, snapshotsToRemove);
      }
    })().catch((err: unknown) => {
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
 * Hashes file metadata (path + size + mtime) — never contents. This bounds cost
 * regardless of artifact size (fuzz logs, captured stderr, etc. can be many GiB
 * and would otherwise trip Node's 2 GiB `readFile` ceiling). Any agent rewrite
 * via fs ops bumps mtime, and same-mtime-same-size collisions in a single ms
 * window are not a concern for workflow change detection.
 */
export function computeOutputHash(outputNames: readonly string[], artifactDir: string, workspacePath: string): string {
  const hash = createHash('sha256');

  if (outputNames.length > 0) {
    for (const output of outputNames) {
      const dir = resolve(artifactDir, output);
      const files = collectFilesRecursive(dir);
      for (const file of files) {
        const { size, mtimeMs } = statSync(file.fullPath);
        hash.update(`${file.relativePath}:${size}:${mtimeMs}`);
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
