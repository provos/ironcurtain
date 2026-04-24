/**
 * WorkflowManager -- owns WorkflowOrchestrator instances for the web UI.
 *
 * Analogous to SessionManager: the daemon creates one WorkflowManager
 * at startup and passes it into the dispatch context. Lifecycle events
 * from the orchestrator are forwarded to the WebEventBus.
 */

import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  WorkflowOrchestrator,
  type WorkflowOrchestratorDeps,
  type WorkflowTabHandle,
  type WorkflowLifecycleEvent,
  type WorkflowController,
} from '../workflow/orchestrator.js';
import { FileCheckpointStore } from '../workflow/checkpoint.js';
import { createWorkflowSessionFactory } from '../workflow/cli-support.js';
import { parseDefinitionFile } from '../workflow/discovery.js';
import { validateDefinition, WorkflowValidationError } from '../workflow/validate.js';
import type { WebEventBus } from './web-event-bus.js';
import { type HumanGateRequestDto, toHumanGateRequestDto } from './web-ui-types.js';
import { getIronCurtainHome } from '../config/paths.js';
import type { WorkflowId, WorkflowCheckpoint, WorkflowDefinition } from '../workflow/types.js';

// ---------------------------------------------------------------------------
// loadPastRun result types
// ---------------------------------------------------------------------------

/** Successful past-run load: domain objects only, no DTO mapping. */
export interface PastRunLoadSuccess {
  readonly checkpoint: WorkflowCheckpoint;
  readonly definition: WorkflowDefinition;
  /** True iff `workflowId` is present in `controller.listActive()` at call time. */
  readonly isLive: boolean;
}

/** Failed past-run load. `not_found` = no checkpoint on disk; `corrupted` = parse/schema failure. */
export interface PastRunLoadError {
  readonly error: 'not_found' | 'corrupted';
  readonly message?: string;
}

export type PastRunLoadResult = PastRunLoadSuccess | PastRunLoadError;

/** Renders an unknown thrown value as a short human-readable string. */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface WorkflowManagerOptions {
  readonly eventBus: WebEventBus;
  /**
   * Optional override for the base directory under which workflow runs are
   * stored. Defaults to `{getIronCurtainHome()}/workflow-runs`. The CLI
   * `workflow inspect` subcommand uses this to inspect arbitrary user-supplied
   * directories without mutating `IRONCURTAIN_HOME`.
   */
  readonly baseDirOverride?: string;
}

// ---------------------------------------------------------------------------
// WorkflowManager
// ---------------------------------------------------------------------------

export class WorkflowManager {
  private orchestrator: WorkflowOrchestrator | null = null;
  private readonly eventBus: WebEventBus;
  private readonly baseDirOverride: string | undefined;

  constructor(options: WorkflowManagerOptions) {
    this.eventBus = options.eventBus;
    this.baseDirOverride = options.baseDirOverride;
  }

  /** Lazily creates the orchestrator on first use. */
  getOrchestrator(): WorkflowController {
    if (!this.orchestrator) {
      this.orchestrator = this.createOrchestrator();
    }
    return this.orchestrator;
  }

  /** Clean shutdown of all workflows. */
  async shutdown(): Promise<void> {
    if (this.orchestrator) {
      await this.orchestrator.shutdownAll();
      this.orchestrator = null;
    }
  }

  /**
   * Imports a checkpoint from an external directory into the daemon's own store.
   *
   * When `workflowId` is omitted, picks the most recent checkpoint in the external dir.
   * Copies both the checkpoint and `definition.json` so that `resume()` can find them.
   *
   * @returns The workflow ID that was imported.
   */
  importExternalCheckpoint(externalBaseDir: string, workflowId?: string): WorkflowId {
    const externalStore = new FileCheckpointStore(externalBaseDir);
    let targetId: WorkflowId;

    if (workflowId) {
      targetId = workflowId as WorkflowId;
    } else {
      // Pick the most recent checkpoint
      const allIds = externalStore.listAll();
      if (allIds.length === 0) {
        throw new Error(`No checkpoints found in ${externalBaseDir}`);
      }
      let latestId: WorkflowId | undefined;
      let latestTimestamp = '';
      for (const id of allIds) {
        const cp = externalStore.load(id);
        if (cp && cp.timestamp > latestTimestamp) {
          latestId = id;
          latestTimestamp = cp.timestamp;
        }
      }
      if (!latestId) {
        throw new Error(`No valid checkpoints found in ${externalBaseDir}`);
      }
      targetId = latestId;
    }

    const checkpoint = externalStore.load(targetId);
    if (!checkpoint) {
      throw new Error(`No checkpoint found for workflow ${targetId} in ${externalBaseDir}`);
    }

    // Save into daemon's own store
    const localStore = this.getCheckpointStore();
    localStore.save(targetId, checkpoint);

    // Copy definition.json if it exists in the external dir
    const externalDefPath = resolve(externalBaseDir, targetId, 'definition.json');
    const localMetaDir = resolve(this.getBaseDir(), targetId);
    mkdirSync(localMetaDir, { recursive: true });
    if (existsSync(externalDefPath)) {
      copyFileSync(externalDefPath, resolve(localMetaDir, 'definition.json'));
    }

    return targetId;
  }

  /**
   * Loads a past workflow run from disk: the raw checkpoint plus the parsed
   * `WorkflowDefinition` that was active when it was checkpointed.
   *
   * Returns domain objects only — no DTO mapping (per design decision D2: the
   * orchestrator/manager layer must not depend on web-UI DTO types). Callers
   * in the dispatch layer assemble DTOs.
   *
   * Synchronous because `FileCheckpointStore.load()` is synchronous.
   *
   * Behavior:
   * - `not_found`: no `checkpoint.json` exists for `workflowId` on disk.
   * - `corrupted`: checkpoint or definition file is present but fails to
   *   parse (JSON syntax error, schema validation failure, missing fields).
   *   Never throws on a corrupted file — always returns the error object.
   * - On success, `isLive` is true iff `workflowId` is in
   *   `controller.listActive()`. The dispatch layer uses this to synthesize
   *   the `interrupted` phase (D1).
   */
  loadPastRun(workflowId: WorkflowId): PastRunLoadResult {
    // Use the existing per-manager checkpoint store. `getCheckpointStore()`
    // ensures the orchestrator (and therefore the store) exists.
    const store = this.getCheckpointStore();

    let checkpoint: WorkflowCheckpoint | undefined;
    try {
      checkpoint = store.load(workflowId);
    } catch (err: unknown) {
      // FileCheckpointStore.load() returns undefined on ENOENT but propagates
      // JSON parse errors. Treat any non-ENOENT throw as corruption.
      return {
        error: 'corrupted',
        message: `Failed to parse checkpoint for ${workflowId}: ${describeError(err)}`,
      };
    }

    if (!checkpoint) {
      return { error: 'not_found' };
    }

    // Resolve the definition. Prefer the JSON copy in baseDir (written by
    // `start()`/`importExternalCheckpoint()`); fall back to the original path
    // recorded on the checkpoint, mirroring the orchestrator's `resume()` logic.
    const definitionResult = this.loadDefinitionForCheckpoint(workflowId, checkpoint);
    if ('error' in definitionResult) {
      return definitionResult;
    }

    const isLive = this.getOrchestrator().listActive().includes(workflowId);
    return { checkpoint, definition: definitionResult.definition, isLive };
  }

  /** Returns the stable base directory for workflow data. */
  getBaseDir(): string {
    const baseDir = this.baseDirOverride ?? resolve(getIronCurtainHome(), 'workflow-runs');
    mkdirSync(baseDir, { recursive: true });
    return baseDir;
  }

  /** Returns the checkpoint store for the current orchestrator (creates orchestrator if needed). */
  getCheckpointStore(): FileCheckpointStore {
    // Ensure orchestrator is created so checkpoint store exists
    this.getOrchestrator();
    if (!this._checkpointStore) {
      throw new Error('Checkpoint store not initialized -- orchestrator creation failed');
    }
    return this._checkpointStore;
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private _checkpointStore: FileCheckpointStore | null = null;

  /**
   * Resolves and parses the WorkflowDefinition associated with a checkpoint.
   * Prefers the JSON copy at `{baseDir}/{workflowId}/definition.json` written
   * at workflow-start; falls back to the original `checkpoint.definitionPath`.
   * On any parse/validation failure, returns a `corrupted` error.
   */
  private loadDefinitionForCheckpoint(
    workflowId: WorkflowId,
    checkpoint: WorkflowCheckpoint,
  ): { definition: WorkflowDefinition } | PastRunLoadError {
    const definitionCopyPath = resolve(this.getBaseDir(), workflowId, 'definition.json');
    const usingCopy = existsSync(definitionCopyPath);
    const definitionPath = usingCopy ? definitionCopyPath : checkpoint.definitionPath;

    // If neither location holds a file, the definition is missing. This is
    // distinct from a malformed file but the dispatch layer treats both as
    // unrecoverable — surface as `corrupted` so the user gets a useful message.
    if (!existsSync(definitionPath)) {
      return {
        error: 'corrupted',
        message: `Definition file missing for ${workflowId} (looked in ${definitionCopyPath} and ${checkpoint.definitionPath})`,
      };
    }

    let raw: unknown;
    try {
      raw = parseDefinitionFile(definitionPath);
    } catch (err: unknown) {
      return {
        error: 'corrupted',
        message: `Failed to parse definition at ${definitionPath}: ${describeError(err)}`,
      };
    }

    try {
      const definition = validateDefinition(raw);
      return { definition };
    } catch (err: unknown) {
      const detail = err instanceof WorkflowValidationError ? err.issues.join('; ') : describeError(err);
      return {
        error: 'corrupted',
        message: `Invalid workflow definition at ${definitionPath}: ${detail}`,
      };
    }
  }

  private createOrchestrator(): WorkflowOrchestrator {
    const baseDir = this.getBaseDir();
    const checkpointStore = new FileCheckpointStore(baseDir);
    this._checkpointStore = checkpointStore;
    const sessionFactory = createWorkflowSessionFactory();

    const deps: WorkflowOrchestratorDeps = {
      createSession: sessionFactory,
      createWorkflowTab: () => this.createNoOpTab(),
      raiseGate: (gate) => {
        const dto: HumanGateRequestDto = toHumanGateRequestDto(gate);
        this.eventBus.emit('workflow.gate_raised', {
          workflowId: gate.workflowId,
          gate: dto,
        });
      },
      dismissGate: (workflowId, gateId) => {
        this.eventBus.emit('workflow.gate_dismissed', { workflowId, gateId });
      },
      baseDir,
      checkpointStore,
    };

    const orchestrator = new WorkflowOrchestrator(deps);
    orchestrator.onEvent((event) => this.forwardLifecycleEvent(event));
    return orchestrator;
  }

  private createNoOpTab(): WorkflowTabHandle {
    return {
      write() {},
      setLabel() {},
      close() {},
    };
  }

  /** Maps WorkflowLifecycleEvent to WebEventBus events. */
  private forwardLifecycleEvent(event: WorkflowLifecycleEvent): void {
    switch (event.kind) {
      case 'started':
        this.eventBus.emit('workflow.started', {
          workflowId: event.workflowId,
          name: event.name,
          taskDescription: event.taskDescription,
        });
        break;
      case 'state_entered':
        this.eventBus.emit('workflow.state_entered', {
          workflowId: event.workflowId,
          state: event.state,
        });
        break;
      case 'completed':
        this.eventBus.emit('workflow.completed', {
          workflowId: event.workflowId,
        });
        break;
      case 'failed':
        this.eventBus.emit('workflow.failed', {
          workflowId: event.workflowId,
          error: event.error,
        });
        break;
      case 'gate_raised':
        // Already emitted via raiseGate callback
        break;
      case 'gate_dismissed':
        // Already emitted via dismissGate callback
        break;
      case 'agent_started':
        this.eventBus.emit('workflow.agent_started', {
          workflowId: event.workflowId,
          stateId: event.state,
          persona: event.persona,
        });
        break;
      case 'agent_completed':
        this.eventBus.emit('workflow.agent_completed', {
          workflowId: event.workflowId,
          stateId: event.state,
          verdict: event.verdict,
        });
        break;
    }
  }
}
