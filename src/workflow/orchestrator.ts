import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
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
} from './types.js';
import { createWorkflowId } from './types.js';
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
import { parseAgentStatus, buildStatusBlockReprompt } from './status-parser.js';
import { buildAgentCommand, buildArtifactReprompt } from './prompt-builder.js';
import { collectFilesRecursive, hasAnyFiles } from './artifacts.js';
import { validateDefinition } from './validate.js';

const execFileAsync = promisify(execFileCb);

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
  readonly dismissGate: (gateId: string) => void;

  /** Base directory for workflow artifacts and checkpoints. */
  readonly baseDir: string;

  /** Persistent checkpoint store for workflow resume. */
  readonly checkpointStore: CheckpointStore;
}

/** Lifecycle events emitted by the orchestrator. */
export type WorkflowLifecycleEvent =
  | { readonly kind: 'state_entered'; readonly workflowId: WorkflowId; readonly state: string }
  | { readonly kind: 'completed'; readonly workflowId: WorkflowId }
  | { readonly kind: 'failed'; readonly workflowId: WorkflowId; readonly error: string }
  | { readonly kind: 'gate_raised'; readonly workflowId: WorkflowId; readonly gate: HumanGateRequest }
  | { readonly kind: 'gate_dismissed'; readonly workflowId: WorkflowId; readonly gateId: string };

/** The narrow controller interface exposed to the mux. */
export interface WorkflowController {
  start(definitionPath: string, taskDescription: string): Promise<WorkflowId>;
  resume(workflowId: WorkflowId): Promise<void>;
  listResumable(): WorkflowId[];
  getStatus(id: WorkflowId): WorkflowStatus | undefined;
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
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class WorkflowOrchestrator implements WorkflowController {
  private readonly workflows = new Map<WorkflowId, WorkflowInstance>();
  private readonly lifecycleCallbacks: Array<(e: WorkflowLifecycleEvent) => void> = [];

  constructor(private readonly deps: WorkflowOrchestratorDeps) {}

  // -----------------------------------------------------------------------
  // WorkflowController implementation
  // -----------------------------------------------------------------------

  start(definitionPath: string, taskDescription: string): Promise<WorkflowId> {
    const raw = JSON.parse(readFileSync(definitionPath, 'utf-8')) as unknown;
    const definition = validateDefinition(raw);
    const workflowId = createWorkflowId();

    // Create artifact directory and write task description
    const artifactDir = resolve(this.deps.baseDir, workflowId, 'artifacts');
    mkdirSync(artifactDir, { recursive: true });
    const taskDir = resolve(artifactDir, 'task');
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(resolve(taskDir, 'description.md'), taskDescription);

    // Build XState machine
    const { machine, gateStateNames, terminalStateNames } = buildWorkflowMachine(definition, taskDescription);

    // Provide concrete service implementations
    const providedMachine = this.provideActors(machine, workflowId, definition);
    const actor = createActor(providedMachine);

    // Create the workflow tab
    const tab = this.deps.createWorkflowTab(definition.name, workflowId);

    const instance: WorkflowInstance = {
      id: workflowId,
      definition,
      definitionPath,
      actor,
      gateStateNames,
      terminalStateNames,
      activeSessions: new Set(),
      artifactDir,
      tab,
      transitionHistory: [],
      currentState: definition.initial,
      stateEnteredAt: Date.now(),
    };

    this.workflows.set(workflowId, instance);
    this.subscribeToActor(instance);
    actor.start();
    return Promise.resolve(workflowId);
  }

  async resume(workflowId: WorkflowId): Promise<void> {
    const checkpoint = await Promise.resolve(this.deps.checkpointStore.load(workflowId));
    if (!checkpoint) {
      throw new Error(`No checkpoint found for workflow ${workflowId}`);
    }

    // Read the definition from the checkpointed path
    const raw = JSON.parse(readFileSync(checkpoint.definitionPath, 'utf-8')) as unknown;
    const definition = validateDefinition(raw);

    // Rebuild the machine with the original task description from context
    const { machine, gateStateNames, terminalStateNames } = buildWorkflowMachine(
      definition,
      checkpoint.context.taskDescription,
    );

    const providedMachine = this.provideActors(machine, workflowId, definition);

    // Restore actor from checkpoint snapshot
    const restoredSnapshot = providedMachine.resolveState({
      value: checkpoint.machineState as string,
      context: checkpoint.context,
    });
    const actor = createActor(providedMachine, { snapshot: restoredSnapshot as Snapshot<unknown> });

    // Reuse the existing artifact directory
    const artifactDir = resolve(this.deps.baseDir, workflowId, 'artifacts');
    const tab = this.deps.createWorkflowTab(definition.name, workflowId);

    const instance: WorkflowInstance = {
      id: workflowId,
      definition,
      definitionPath: checkpoint.definitionPath,
      actor,
      gateStateNames,
      terminalStateNames,
      activeSessions: new Set(),
      artifactDir,
      tab,
      transitionHistory: [...checkpoint.transitionHistory],
      currentState: String(checkpoint.machineState),
      stateEnteredAt: Date.now(),
    };

    this.workflows.set(workflowId, instance);
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

    // Check if waiting at a gate
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

  listActive(): readonly WorkflowId[] {
    return [...this.workflows.keys()].filter((id) => {
      const instance = this.workflows.get(id);
      return instance && !instance.finalStatus;
    });
  }

  resolveGate(id: WorkflowId, event: HumanGateEvent): void {
    const instance = this.workflows.get(id);
    if (!instance) return;

    const gateId = instance.activeGateId;
    if (gateId) {
      this.deps.dismissGate(gateId);
      instance.activeGateId = undefined;
    }

    // Map human gate event to XState event name
    const xstateEventName = `HUMAN_${event.type}` as const;
    instance.actor.send({
      type: xstateEventName,
      prompt: event.prompt,
    });
  }

  async abort(id: WorkflowId): Promise<void> {
    const instance = this.workflows.get(id);
    if (!instance) return;

    // No-op if workflow already reached a terminal state
    if (
      instance.finalStatus?.phase === 'completed' ||
      instance.finalStatus?.phase === 'aborted' ||
      instance.finalStatus?.phase === 'failed'
    ) {
      return;
    }

    // Close all active sessions
    const closePromises: Promise<void>[] = [];
    for (const session of instance.activeSessions) {
      closePromises.push(session.close().catch(() => {}));
    }
    await Promise.allSettled(closePromises);
    instance.activeSessions.clear();

    // Stop XState actor
    instance.actor.stop();

    // Set final status
    instance.finalStatus = {
      phase: 'aborted',
      reason: 'Workflow aborted by user',
    };

    // Remove checkpoint on abort
    try {
      this.deps.checkpointStore.remove(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeStderr(`[workflow] Failed to remove checkpoint on abort for ${id}: ${msg}`);
    }

    // Clean up tab
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
            const msg = err instanceof Error ? err.message : String(err);
            writeStderr(`[workflow] agentService invoke rejected for "${input.stateId}": ${msg}`);
            throw err;
          }
        }),
        deterministicService: fromPromise<DeterministicInvokeResult, DeterministicInvokeInput>(async ({ input }) => {
          try {
            return await this.executeDeterministicState(input);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            writeStderr(`[workflow] deterministicService invoke rejected for "${input.stateId}": ${msg}`);
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

      // Record transition if state actually changed
      if (stateValue !== previousState) {
        const duration = instance.stateEnteredAt ? now - instance.stateEnteredAt : 0;
        instance.transitionHistory.push({
          from: previousState,
          to: stateValue,
          event: 'transition',
          timestamp: new Date(now).toISOString(),
          duration_ms: duration,
        });
        instance.stateEnteredAt = now;
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

      // Check if we entered a gate state
      for (const gateName of gateStateNames) {
        if (snapshot.matches(gateName)) {
          const stateDef = definition.states[gateName];
          if (stateDef.type === 'human_gate') {
            this.handleGateEntry(workflowId, gateName, stateDef);
          }
          break;
        }
      }

      // Emit lifecycle event
      this.emitLifecycleEvent({
        kind: 'state_entered',
        workflowId,
        state: stateValue,
      });

      // Save checkpoint on every state change
      this.saveCheckpoint(instance, snapshot);

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
    };
    try {
      this.deps.checkpointStore.save(instance.id, checkpoint);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeStderr(`[workflow] Failed to save checkpoint for ${instance.id}: ${msg}`);
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

    instance.tab.write(`[agent] Starting "${stateId}" (persona: ${stateConfig.persona})`);

    // Build command from artifacts + context
    const command = buildAgentCommand(stateConfig, context, instance.artifactDir);

    // Construct SessionMode from definition settings
    const mode: SessionMode =
      settings.mode === 'builtin'
        ? { kind: 'builtin' }
        : { kind: 'docker', agent: (settings.dockerAgent ?? 'claude-code') as AgentId };

    // Create session with resumeSessionId for same-role continuity.
    // sessionsByRole is keyed by stateId (set by updateContextFromAgentResult).
    // workspacePath ensures the agent writes to the artifact directory,
    // so files created by the agent are visible to the orchestrator.
    const previousSessionId = context.sessionsByRole[stateId];
    let session: Session;
    try {
      session = await this.deps.createSession({
        persona: stateConfig.persona,
        mode,
        resumeSessionId: previousSessionId,
        workspacePath: instance.artifactDir,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeStderr(`[workflow] Session creation failed for "${stateId}": ${msg}`);
      instance.tab.write(`[error] Session creation failed for "${stateId}": ${msg}`);
      throw err;
    }

    instance.activeSessions.add(session);

    try {
      instance.tab.write(`[agent] Sending command to "${stateId}"...`);

      // Send command and get response
      let responseText = await session.sendMessage(command);

      // Parse agent_status with retry
      let agentOutput = parseAgentStatus(responseText);
      if (!agentOutput) {
        responseText = await session.sendMessage(buildStatusBlockReprompt());
        agentOutput = parseAgentStatus(responseText);
        if (!agentOutput) {
          throw new Error('Agent failed to provide agent_status block after retry');
        }
      }

      // Verify expected artifacts with retry
      const missingArtifacts = this.findMissingArtifacts(stateConfig, instance.artifactDir);
      if (missingArtifacts.length > 0) {
        const retryResponse = await session.sendMessage(buildArtifactReprompt(missingArtifacts));
        // Re-parse status from retry response
        const retryOutput = parseAgentStatus(retryResponse);
        if (retryOutput) {
          agentOutput = retryOutput;
        }
        const stillMissing = this.findMissingArtifacts(stateConfig, instance.artifactDir);
        if (stillMissing.length > 0) {
          throw new Error(`Missing artifacts after retry: ${stillMissing.join(', ')}`);
        }
      }

      // Compute output hash for stall detection
      const outputHash = computeOutputHash(stateConfig.outputs, instance.artifactDir);

      // Collect artifact paths
      const artifacts = collectArtifactPaths(stateConfig.outputs, instance.artifactDir);

      instance.tab.write(
        `[agent] "${stateId}" completed: verdict=${agentOutput.verdict}, artifacts=${Object.keys(artifacts).join(',') || 'none'}`,
      );

      return {
        output: agentOutput,
        sessionId: previousSessionId || session.getInfo().id,
        artifacts,
        outputHash,
      };
    } finally {
      instance.activeSessions.delete(session);
      await session.close().catch((closeErr: unknown) => {
        const closeMsg = closeErr instanceof Error ? closeErr.message : String(closeErr);
        console.error(`[workflow] session.close() failed for "${stateId}": ${closeMsg}`);
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

    // Remove checkpoint on terminal completion
    try {
      this.deps.checkpointStore.remove(workflowId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeStderr(`[workflow] Failed to remove checkpoint for ${workflowId}: ${msg}`);
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

/**
 * Computes a SHA-256 hash of all files in the output artifact directories.
 * Recursively walks subdirectories. Deterministic: files are sorted by relative path.
 */
export function computeOutputHash(outputNames: readonly string[], artifactDir: string): string {
  const hash = createHash('sha256');
  for (const output of outputNames) {
    const dir = resolve(artifactDir, output);
    const files = collectFilesRecursive(dir);
    for (const file of files) {
      hash.update(file.relativePath);
      hash.update(readFileSync(file.fullPath));
    }
  }
  return hash.digest('hex');
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
