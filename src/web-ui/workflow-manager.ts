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
import { createWorkflowSessionFactory, isCheckpointResumable } from '../workflow/cli-support.js';
import { parseDefinitionFile } from '../workflow/discovery.js';
import { discoverWorkflowRuns } from '../workflow/workflow-discovery.js';
import { validateDefinition, WorkflowValidationError } from '../workflow/validate.js';
import type { WebEventBus } from './web-event-bus.js';
import { type HumanGateRequestDto, toHumanGateRequestDto } from './web-ui-types.js';
import { getIronCurtainHome } from '../config/paths.js';
import type { WorkflowId, WorkflowCheckpoint, WorkflowDefinition } from '../workflow/types.js';

// ---------------------------------------------------------------------------
// loadPastRun result types
// ---------------------------------------------------------------------------

/**
 * Successful past-run load: domain objects only, no DTO mapping.
 *
 * `checkpoint` is optional because a directory may hold a `definition.json`
 * (and optionally a `messages.jsonl`) without a `checkpoint.json` -- this
 * happens for runs that completed before checkpoint retention was introduced
 * and for runs where the checkpoint is missing for any other reason. The
 * dispatch layer synthesizes missing fields from the message log or the
 * definition when `checkpoint` is `undefined`.
 *
 * `messageLogPath` is always returned (never checked for existence here);
 * callers read it via `MessageLog.readAll()`, which returns `[]` when the
 * file does not yet exist.
 */
export interface PastRunLoadSuccess {
  readonly checkpoint: WorkflowCheckpoint | undefined;
  readonly definition: WorkflowDefinition;
  /** Absolute path to the per-run `messages.jsonl`. Not guaranteed to exist on disk. */
  readonly messageLogPath: string;
  /** True iff `workflowId` is present in `controller.listActive()` at call time. */
  readonly isLive: boolean;
}

/**
 * Failed past-run load.
 * - `not_found`: directory doesn't exist OR has no loadable definition (so
 *   there's nothing to render).
 * - `corrupted`: a present file (checkpoint or definition) failed to parse
 *   or validate.
 */
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
      // Pick the most recent resumable checkpoint. Enumeration goes through
      // the shared `discoverWorkflowRuns` utility so every directory-scan
      // site in the codebase uses the same definition of "exists"; and the
      // `isCheckpointResumable` predicate filters out completed runs — a
      // finished workflow cannot meaningfully be "resumed."
      const runs = discoverWorkflowRuns(externalBaseDir);
      const candidateIds = runs.filter((r) => r.hasCheckpoint).map((r) => r.workflowId);
      if (candidateIds.length === 0) {
        throw new Error(`No checkpoints found in ${externalBaseDir}`);
      }
      let latestId: WorkflowId | undefined;
      let latestTimestamp = '';
      for (const id of candidateIds) {
        const cp = externalStore.load(id);
        if (cp && isCheckpointResumable(cp) && cp.timestamp > latestTimestamp) {
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
   * Loads a past workflow run from disk: the raw checkpoint (if present) plus
   * the parsed `WorkflowDefinition` that was active when it ran.
   *
   * Returns domain objects only — no DTO mapping (per design decision D2: the
   * orchestrator/manager layer must not depend on web-UI DTO types). Callers
   * in the dispatch layer assemble DTOs.
   *
   * Synchronous because `FileCheckpointStore.load()` is synchronous.
   *
   * Behavior:
   * - `not_found`: the workflow directory has neither a loadable checkpoint
   *   nor a loadable definition — nothing worth rendering.
   * - `corrupted`: checkpoint or definition file is present on disk but fails
   *   to parse (JSON syntax error, schema validation failure, missing
   *   fields). Never throws on a corrupted file — always returns the error
   *   object.
   * - On success, `checkpoint` may be `undefined` (completed pre-retention
   *   runs and other checkpoint-less directories), `definition` is always
   *   defined, `messageLogPath` is always returned (unchecked for existence),
   *   and `isLive` is true iff `workflowId` is in `controller.listActive()`.
   */
  loadPastRun(workflowId: WorkflowId): PastRunLoadResult {
    // Use the existing per-manager checkpoint store. `getCheckpointStore()`
    // ensures the orchestrator (and therefore the store) exists.
    const store = this.getCheckpointStore();

    // Always computed — cheap (single path.resolve) and consumers handle
    // "no log" via MessageLog.readAll() returning [].
    const messageLogPath = resolve(this.getBaseDir(), workflowId, 'messages.jsonl');

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

    // `checkpoint === undefined` is no longer a terminal error — the
    // directory may still carry a definition and/or message log that the
    // dispatch layer can render.
    const definitionResult = this.loadDefinitionForCheckpoint(workflowId, checkpoint);
    if ('error' in definitionResult) {
      return definitionResult;
    }

    const isLive = this.getOrchestrator().listActive().includes(workflowId);
    return { checkpoint, definition: definitionResult.definition, messageLogPath, isLive };
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
   * Resolves and parses the WorkflowDefinition associated with a workflow run.
   *
   * Preference order:
   *  1. Local JSON copy at `{baseDir}/{workflowId}/definition.json` (written
   *     at workflow-start / import). Tried regardless of whether a checkpoint
   *     is available.
   *  2. The original `checkpoint.definitionPath`, iff `checkpoint` is defined.
   *
   * When `checkpoint` is `undefined` we have nothing beyond the local copy to
   * try — a directory with no checkpoint and no `definition.json` has no
   * content worth surfacing and is reported as `not_found` (distinct from
   * `corrupted`, which is reserved for present-but-malformed files).
   *
   * Any parse or schema-validation failure of a present file is surfaced as
   * `corrupted`.
   */
  private loadDefinitionForCheckpoint(
    workflowId: WorkflowId,
    checkpoint: WorkflowCheckpoint | undefined,
  ): { definition: WorkflowDefinition } | PastRunLoadError {
    const definitionCopyPath = resolve(this.getBaseDir(), workflowId, 'definition.json');
    const hasCopy = existsSync(definitionCopyPath);

    let definitionPath: string | undefined;
    if (hasCopy) {
      definitionPath = definitionCopyPath;
    } else if (checkpoint && existsSync(checkpoint.definitionPath)) {
      definitionPath = checkpoint.definitionPath;
    }

    if (!definitionPath) {
      // Nothing to load: no local copy, and either no checkpoint at all or
      // the checkpoint's original `definitionPath` is gone. The directory
      // has no renderable content — report `not_found` rather than
      // `corrupted` (corrupted is reserved for present-but-malformed files).
      const fallbackDetail = checkpoint ? ` and ${checkpoint.definitionPath}` : '';
      return {
        error: 'not_found',
        message: `Definition file missing for ${workflowId} (looked in ${definitionCopyPath}${fallbackDetail})`,
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
