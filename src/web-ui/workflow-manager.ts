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
import type { WebEventBus } from './web-event-bus.js';
import { type HumanGateRequestDto, toHumanGateRequestDto } from './web-ui-types.js';
import { getIronCurtainHome } from '../config/paths.js';
import type { WorkflowId } from '../workflow/types.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface WorkflowManagerOptions {
  readonly eventBus: WebEventBus;
}

// ---------------------------------------------------------------------------
// WorkflowManager
// ---------------------------------------------------------------------------

export class WorkflowManager {
  private orchestrator: WorkflowOrchestrator | null = null;
  private readonly eventBus: WebEventBus;

  constructor(options: WorkflowManagerOptions) {
    this.eventBus = options.eventBus;
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

  /** Returns the stable base directory for workflow data. */
  getBaseDir(): string {
    const baseDir = resolve(getIronCurtainHome(), 'workflow-runs');
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
          sessionId: event.sessionId,
        });
        break;
      case 'agent_completed':
        this.eventBus.emit('workflow.agent_completed', {
          workflowId: event.workflowId,
          stateId: event.state,
          verdict: event.verdict,
          notes: event.notes,
        });
        break;
      case 'agent_session_ended':
        this.eventBus.emit('workflow.agent_session_ended', {
          workflowId: event.workflowId,
          stateId: event.state,
          persona: event.persona,
          sessionId: event.sessionId,
        });
        break;
    }
  }
}
