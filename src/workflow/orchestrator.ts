import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { MessageLog } from './message-log.js';
import { createHash, type Hash } from 'node:crypto';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
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
import { getPersonaDefinitionPath } from '../persona/resolve.js';
import { createPersonaName } from '../persona/types.js';
import type { Session, SessionOptions, SessionMode } from '../session/types.js';
import type { AgentId } from '../docker/agent-adapter.js';
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
    }
  | {
      readonly kind: 'agent_completed';
      readonly workflowId: WorkflowId;
      readonly state: string;
      readonly persona: string;
      readonly verdict: string;
      readonly notes: string;
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
  // WorkflowController implementation
  // -----------------------------------------------------------------------

  start(definitionPath: string, taskDescription: string, workspacePath?: string): Promise<WorkflowId> {
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
    };

    this.workflows.set(workflowId, instance);
    this.emitLifecycleEvent({ kind: 'started', workflowId, name: definition.name, taskDescription });
    this.subscribeToActor(instance);
    actor.start();
    return Promise.resolve(workflowId);
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
    };

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
    await Promise.allSettled(ids.map((id) => this.abort(id)));
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

    // Create session with resumeSessionId for same-role continuity.
    // sessionsByState is keyed by stateId (set by updateContextFromAgentResult).
    // workspacePath ensures the agent writes to the artifact directory,
    // so files created by the agent are visible to the orchestrator.
    const previousSessionId = stateConfig.freshSession === false ? context.sessionsByState[stateId] : undefined;
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
      await session.close().catch((closeErr: unknown) => {
        console.error(`[workflow] session.close() failed for "${stateId}": ${toErrorMessage(closeErr)}`);
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
